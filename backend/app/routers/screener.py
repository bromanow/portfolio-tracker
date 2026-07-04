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

    def _backfill(db2):
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

    job = _spawn_job("screener_seed_metadata", _backfill)
    return {"universe_tickers": added, "newly_flagged": flagged, **job}


@router.post("/refresh")
def refresh_universe():
    """Fetch fundamentals for every universe security (background job).
    Returns a job_id immediately; poll GET /api/prices/jobs/{job_id} for status."""
    from app.routers.prices import _spawn_job
    from app.services.signals_service import refresh_fundamentals_all

    def _fn(db):
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
    sort_by: str = Query("market_cap"),
    sort_dir: str = Query("desc"),
    db: Session = Depends(get_db),
):
    """Filter + sort the fundamental screener universe."""
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
