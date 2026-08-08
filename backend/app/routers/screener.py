"""Fundamental Screener — filter/sort a curated stock universe by valuation, growth, and
quality metrics. Reuses the existing per-security fundamentals pipeline (security_fundamentals,
refresh_fundamentals_for_security/refresh_fundamentals_all) rather than a parallel data store;
this router only adds the "which securities count as the universe" layer on top
(Security.in_screener_universe) plus a filtered/sorted listing endpoint.
"""
from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User
from app.models.master import Security, SecurityFundamentals
from app.data.screener_universe import SP500, TSX60
from app import background_jobs

router = APIRouter(prefix="/api/screener", tags=["screener"])


# ── Composite score ────────────────────────────────────────────────────────────
# Percentile-ranked (not raw-value) so P/E, ROE, etc. combine on a common 0-100
# scale regardless of their native units. Ranked across the WHOLE universe (not
# just the current filtered/paged result set) so a security's score doesn't
# shift depending on what filters are applied — filtering only narrows which
# rows are shown, it never changes how they're scored.
_SCORE_WEIGHTS: dict[str, tuple[str, bool]] = {
    # metric: (SecurityFundamentals attr, higher_is_better)
    "pe_ratio":          ("pe_ratio", False),
    "debt_to_equity":    ("debt_to_equity", False),
    "return_on_equity":  ("return_on_equity", True),
    "revenue_growth":    ("revenue_growth", True),
    "dividend_yield":    ("dividend_yield", True),
}
_SCORE_WEIGHT_VALUES = {"pe_ratio": 25, "debt_to_equity": 20, "return_on_equity": 25,
                         "revenue_growth": 20, "dividend_yield": 10}


def _percentile_ranks(values: list[Optional[float]]) -> list[Optional[float]]:
    """Rank each non-None value by its percentile (0-100) among the others.
    None values pass through as None (metric excluded for that security)."""
    present = [(i, v) for i, v in enumerate(values) if v is not None]
    if not present:
        return [None] * len(values)
    ordered = sorted(present, key=lambda iv: iv[1])
    n = len(ordered)
    ranks: dict[int, float] = {}
    for rank, (i, _v) in enumerate(ordered):
        ranks[i] = 100.0 * rank / (n - 1) if n > 1 else 100.0
    return [ranks.get(i) for i in range(len(values))]


def _composite_scores(fundamentals_rows: list[SecurityFundamentals]) -> dict[int, Optional[float]]:
    """security_id -> composite_score (0-100) or None if no scorable metrics present."""
    metric_percentiles: dict[str, list[Optional[float]]] = {}
    for metric, (attr, higher_is_better) in _SCORE_WEIGHTS.items():
        raw = [float(getattr(f, attr)) if getattr(f, attr) is not None else None for f in fundamentals_rows]
        pctl = _percentile_ranks(raw)
        if not higher_is_better:
            pctl = [100.0 - p if p is not None else None for p in pctl]
        metric_percentiles[metric] = pctl

    scores: dict[int, Optional[float]] = {}
    for idx, f in enumerate(fundamentals_rows):
        weighted_sum = 0.0
        weight_total = 0.0
        for metric, weight in _SCORE_WEIGHT_VALUES.items():
            p = metric_percentiles[metric][idx]
            if p is not None:
                weighted_sum += p * weight
                weight_total += weight
        scores[f.security_id] = round(weighted_sum / weight_total, 1) if weight_total > 0 else None
    return scores


@router.get("/status")
def get_status(db: Session = Depends(get_db)):
    total = db.query(Security).filter(Security.in_screener_universe == True).count()  # noqa: E712
    with_data = (
        db.query(Security)
        .join(SecurityFundamentals, SecurityFundamentals.security_id == Security.id)
        .filter(Security.in_screener_universe == True)  # noqa: E712
        .count()
    )
    last_fetched = (
        db.query(SecurityFundamentals.fetched_at)
        .join(Security, Security.id == SecurityFundamentals.security_id)
        .filter(Security.in_screener_universe == True)  # noqa: E712
        .order_by(SecurityFundamentals.fetched_at.desc())
        .first()
    )
    running = background_jobs.is_running("screener_refresh") or background_jobs.is_running("screener_seed_metadata")
    return {
        "universe_size": total,
        "with_fundamentals": with_data,
        "last_fetched_at": last_fetched[0].isoformat() if last_fetched and last_fetched[0] else None,
        "refreshing": running,
    }


def _backfill_screener_metadata(db2, job_id) -> dict:
    """Fetch name/sector/industry/exchange from Yahoo for every universe security missing a
    name. Shared by seed-universe and sync-index: any ticker newly flagged into the universe
    starts as a bare ticker (get_or_create_security stores no name), so without this it shows
    in the screener with a blank name/sector until backfilled."""
    from app.routers.securities import _apply_yahoo_info
    from app.services.price_service import fetch_security_info

    missing = (
        db2.query(Security)
        .filter(Security.in_screener_universe == True, Security.name.is_(None))  # noqa: E712
        .all()
    )
    updated = skipped = 0
    for sec in missing:
        try:
            info = fetch_security_info(sec)
            if info is None:
                skipped += 1
                continue
            _apply_yahoo_info(sec, info, db2)
            updated += 1
        except Exception:
            skipped += 1
        finally:
            db2.commit()
    return {"metadata_updated": updated, "metadata_skipped": skipped}


@router.post("/sync-index")
def sync_index(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Refresh S&P 500 / TSX 60 membership from Wikipedia and reconcile the screener universe
    now, instead of waiting for the quarterly scheduler job. Admin only. Aborts without any DB
    change if a scrape looks broken (see index_universe_service). After reconciling, kicks off a
    background job to backfill name/sector for the newly-added constituents (they arrive as bare
    tickers), so they don't show up blank in the screener."""
    from fastapi import HTTPException
    from app.routers.prices import _spawn_job
    from app.services.index_universe_service import sync_index_universe

    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    try:
        summary = sync_index_universe(db)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Index sync failed: {exc}")

    # Backfill name/sector/exchange for any nameless universe securities (the ones just added).
    job = _spawn_job("screener_seed_metadata", _backfill_screener_metadata)
    return {**summary, **job}


@router.post("/seed-universe", status_code=201)
def seed_universe(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Create (or flag existing) Security rows for every ticker in the static universe list,
    then kick off a background job to backfill name/sector/industry for any of them missing it
    (a one-time metadata fetch, separate from the fundamentals numbers refreshed by /refresh).
    Idempotent — safe to re-run after editing screener_universe.py to add new tickers."""
    from app.routers.prices import _spawn_job
    from app.services.normalizer import get_or_create_security
    from fastapi import HTTPException

    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    added = flagged = 0
    for ticker in SP500:
        sec = get_or_create_security(db, ticker, currency="USD")
        if not sec.in_screener_universe:
            sec.in_screener_universe = True
            flagged += 1
        added += 1
    for ticker in TSX60:
        sec = get_or_create_security(db, ticker, currency="CAD", exchange="TSX")
        if not sec.in_screener_universe:
            sec.in_screener_universe = True
            flagged += 1
        added += 1
    db.commit()

    job = _spawn_job("screener_seed_metadata", _backfill_screener_metadata)
    return {"universe_tickers": added, "newly_flagged": flagged, **job}


@router.post("/refresh")
def refresh_universe():
    """Fetch fundamentals for every universe security (background job).
    Returns a job_id immediately; poll GET /api/prices/jobs/{job_id} for status."""
    from app.routers.prices import _spawn_job
    from app.services.signals_service import refresh_fundamentals_all

    def _fn(db, job_id):
        ids = [
            s.id for s in db.query(Security.id)
            .filter(Security.in_screener_universe == True)  # noqa: E712
            .all()
        ]
        return refresh_fundamentals_all(db, security_ids=ids)

    return _spawn_job("screener_refresh", _fn)


@router.get("/results")
def get_results(
    sector: Optional[str] = Query(None),
    min_pe: Optional[float] = Query(None),
    max_pe: Optional[float] = Query(None),
    min_debt_to_equity: Optional[float] = Query(None),
    max_debt_to_equity: Optional[float] = Query(None),
    min_roe_pct: Optional[float] = Query(None, description="Return on equity, percentage scale (15 = 15%)"),
    max_roe_pct: Optional[float] = Query(None),
    min_revenue_growth_pct: Optional[float] = Query(None, description="YoY revenue growth, percentage scale"),
    max_revenue_growth_pct: Optional[float] = Query(None),
    min_dividend_yield_pct: Optional[float] = Query(None),
    max_dividend_yield_pct: Optional[float] = Query(None),
    min_market_cap: Optional[float] = Query(None),
    sort_by: str = Query("composite_score"),
    sort_dir: str = Query("desc"),
    db: Session = Depends(get_db),
):
    """Filter + sort the fundamental screener universe."""
    # Composite score is ranked across the WHOLE universe, independent of the filters below.
    universe_fundamentals = (
        db.query(SecurityFundamentals)
        .join(Security, Security.id == SecurityFundamentals.security_id)
        .filter(Security.in_screener_universe == True)  # noqa: E712
        .all()
    )
    scores_by_security = _composite_scores(universe_fundamentals)

    q = (
        db.query(Security, SecurityFundamentals)
        .join(SecurityFundamentals, SecurityFundamentals.security_id == Security.id)
        .filter(Security.in_screener_universe == True)  # noqa: E712
    )
    if sector:
        q = q.filter(Security.sector_gics == sector)
    if min_pe is not None:
        q = q.filter(SecurityFundamentals.pe_ratio >= min_pe)
    if max_pe is not None:
        q = q.filter(SecurityFundamentals.pe_ratio <= max_pe)
    if min_debt_to_equity is not None:
        q = q.filter(SecurityFundamentals.debt_to_equity >= min_debt_to_equity)
    if max_debt_to_equity is not None:
        q = q.filter(SecurityFundamentals.debt_to_equity <= max_debt_to_equity)
    if min_roe_pct is not None:
        q = q.filter(SecurityFundamentals.return_on_equity >= min_roe_pct / 100)
    if max_roe_pct is not None:
        q = q.filter(SecurityFundamentals.return_on_equity <= max_roe_pct / 100)
    if min_revenue_growth_pct is not None:
        q = q.filter(SecurityFundamentals.revenue_growth >= min_revenue_growth_pct / 100)
    if max_revenue_growth_pct is not None:
        q = q.filter(SecurityFundamentals.revenue_growth <= max_revenue_growth_pct / 100)
    if min_dividend_yield_pct is not None:
        q = q.filter(SecurityFundamentals.dividend_yield >= min_dividend_yield_pct)
    if max_dividend_yield_pct is not None:
        q = q.filter(SecurityFundamentals.dividend_yield <= max_dividend_yield_pct)
    if min_market_cap is not None:
        q = q.filter(SecurityFundamentals.market_cap >= min_market_cap)

    sort_col_map = {
        "ticker": Security.ticker,
        "market_cap": SecurityFundamentals.market_cap,
        "pe_ratio": SecurityFundamentals.pe_ratio,
        "debt_to_equity": SecurityFundamentals.debt_to_equity,
        "return_on_equity": SecurityFundamentals.return_on_equity,
        "revenue_growth": SecurityFundamentals.revenue_growth,
        "dividend_yield": SecurityFundamentals.dividend_yield,
        "profit_margin": SecurityFundamentals.profit_margin,
    }
    if sort_by == "composite_score":
        all_rows = q.all()
        scored = [row for row in all_rows if scores_by_security.get(row[0].id) is not None]
        unscored = [row for row in all_rows if scores_by_security.get(row[0].id) is None]
        scored.sort(key=lambda row: scores_by_security[row[0].id], reverse=(sort_dir == "desc"))
        rows = (scored + unscored)[:2000]
    else:
        sort_col = sort_col_map.get(sort_by, SecurityFundamentals.market_cap)
        q = q.order_by(sort_col.desc().nullslast() if sort_dir == "desc" else sort_col.asc().nullslast())
        rows = q.limit(2000).all()

    return [
        {
            "security_id": sec.id,
            "ticker": sec.ticker,
            "name": sec.name,
            "exchange": sec.exchange,
            "sector": sec.sector_gics,
            "industry": sec.industry_gics,
            "currency": sec.currency,
            "market_cap": float(f.market_cap) if f.market_cap is not None else None,
            "pe_ratio": float(f.pe_ratio) if f.pe_ratio is not None else None,
            "forward_pe": float(f.forward_pe) if f.forward_pe is not None else None,
            "peg_ratio": float(f.peg_ratio) if f.peg_ratio is not None else None,
            "debt_to_equity": float(f.debt_to_equity) if f.debt_to_equity is not None else None,
            "return_on_equity": float(f.return_on_equity) if f.return_on_equity is not None else None,
            "revenue_growth": float(f.revenue_growth) if f.revenue_growth is not None else None,
            "profit_margin": float(f.profit_margin) if f.profit_margin is not None else None,
            "dividend_yield": float(f.dividend_yield) if f.dividend_yield is not None else None,
            "price_to_book": float(f.price_to_book) if f.price_to_book is not None else None,
            "beta": float(f.beta) if f.beta is not None else None,
            "composite_score": scores_by_security.get(sec.id),
            "fetched_at": f.fetched_at.isoformat() if f.fetched_at else None,
        }
        for sec, f in rows
    ]


@router.get("/sectors")
def get_sectors(db: Session = Depends(get_db)):
    rows = (
        db.query(Security.sector_gics)
        .filter(Security.in_screener_universe == True, Security.sector_gics.isnot(None))  # noqa: E712
        .distinct()
        .order_by(Security.sector_gics)
        .all()
    )
    return [r[0] for r in rows]
