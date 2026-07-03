"""
Market price API.
Provides endpoints to refresh and query cached market prices.
"""
import threading
import time as _time
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import background_jobs
from app.database import get_db
from app.models.master import Security
from app.models.prices import MarketPrice, HistoricalPrice
from app.services import price_service
from app.services.fx_service import get_rate

router = APIRouter(prefix="/api/prices", tags=["prices"])

_INDICATORS_CACHE: dict = {}
_INDICATORS_TTL = 300  # 5 minutes


# "country" tags which ones show in the Dashboard ticker bar for that market (mirrors
# Yahoo Finance's Canada/US Markets toggle); country=None means "not shown in the ticker
# bar" — kept around only because _COMPARISON_INDICES (Performance chart overlay) needs
# their labels. Symbols verified live against Yahoo (^SPTTFS/^SPTTEN match the TSX capped
# financial/energy sub-indices; CADUSD=X kept in both bars — this app's base currency is
# CAD, so showing CAD/USD consistently is more useful here than flipping direction by market.
_INDICATOR_DEFS = [
    {"symbol": "^GSPTSE", "label": "S&P/TSX",                   "currency": "CAD", "country": "CA"},
    {"symbol": "^SPTTFS", "label": "S&P/TSX Capped Financials", "currency": "CAD", "country": "CA"},
    {"symbol": "^SPTTEN", "label": "S&P/TSX Capped Energy",     "currency": "CAD", "country": "CA"},
    {"symbol": "CADUSD=X","label": "CAD/USD",                   "currency": "",    "country": "CA"},
    {"symbol": "BTC-CAD", "label": "Bitcoin CAD",               "currency": "CAD", "country": "CA"},
    {"symbol": "CL=F",    "label": "Crude Oil",                 "currency": "USD", "country": "CA"},

    {"symbol": "^GSPC",   "label": "S&P 500",   "currency": "USD", "country": "US"},
    {"symbol": "^DJI",    "label": "Dow Jones", "currency": "USD", "country": "US"},
    {"symbol": "^IXIC",   "label": "NASDAQ",    "currency": "USD", "country": "US"},
    {"symbol": "CADUSD=X","label": "CAD/USD",   "currency": "",    "country": "US"},
    {"symbol": "BTC-USD", "label": "Bitcoin USD","currency": "USD","country": "US"},
    {"symbol": "CL=F",    "label": "Crude Oil", "currency": "USD", "country": "US"},

    # Not shown in the ticker bar — kept for the Performance chart's comparison-index overlay.
    {"symbol": "^RUT", "label": "Russell 2K", "currency": "USD", "country": None},
    {"symbol": "^VIX", "label": "VIX",        "currency": "USD", "country": None},
    {"symbol": "GC=F", "label": "Gold",       "currency": "USD", "country": None},
]


@router.get("/market-indicators")
def get_market_indicators(country: str = Query("CA", pattern="^(CA|US)$")):
    """Return live price + day change for major market indices for one market
    (Canada or US, mirroring Yahoo Finance's country toggle). Cached 5 min per country."""
    global _INDICATORS_CACHE
    now = _time.time()
    cached = _INDICATORS_CACHE.get(country)
    if cached and (now - cached["_ts"]) < _INDICATORS_TTL:
        return cached["data"]

    from app.services.price_service import _fetch_one
    defs = [d for d in _INDICATOR_DEFS if d.get("country") == country]
    results = []
    for ind in defs:
        data = _fetch_one(ind["symbol"])
        results.append({
            "symbol": ind["symbol"],
            "label": ind["label"],
            "currency": ind["currency"],
            "price": float(data["price"]) if data and data.get("price") else None,
            "day_change": float(data["day_change"]) if data and data.get("day_change") else None,
            "day_change_pct": float(data["day_change_pct"]) if data and data.get("day_change_pct") else None,
        })
    _INDICATORS_CACHE[country] = {"data": results, "_ts": now}
    return results


# ── Historical index series (for the Performance chart comparison overlay) ──────
_INDEX_HISTORY_CACHE: dict = {}
_INDEX_HISTORY_TTL = 3600  # 1 hour — historical closes change at most once/day

# Indices offered as comparison overlays on the Performance chart.
# Subset of _INDICATOR_DEFS that make sense as a portfolio benchmark.
_COMPARISON_INDICES = ["^GSPTSE", "^GSPC", "^DJI", "^IXIC", "^RUT"]


@router.get("/index-history")
def get_index_history(
    symbols: str = Query(..., description="Comma-separated index symbols, e.g. ^GSPC,^DJI"),
    from_date: date = Query(...),
    to_date: Optional[date] = Query(None),
):
    """
    Return daily closing values for one or more market indices over a date range.
    Used by the Performance page to overlay benchmark indices on the portfolio
    value chart. Only the whitelisted comparison indices are allowed.

    Response: [{symbol, label, points: [{date, close}]}]
    """
    import pandas as pd
    from datetime import timedelta
    from app.services.price_service import _yf_download

    label_by_sym = {d["symbol"]: d["label"] for d in _INDICATOR_DEFS}
    requested = [
        s.strip() for s in symbols.split(",")
        if s.strip() in _COMPARISON_INDICES
    ]
    end = to_date or date.today()
    out: list[dict] = []

    for sym in requested:
        cache_key = (sym, from_date.isoformat(), end.isoformat())
        cached = _INDEX_HISTORY_CACHE.get(cache_key)
        if cached and (_time.time() - cached["_ts"]) < _INDEX_HISTORY_TTL:
            out.append(cached["data"])
            continue

        points: list[dict] = []
        try:
            df = _yf_download(
                sym, start=from_date.isoformat(),
                end=(end + timedelta(days=1)).isoformat(),
                auto_adjust=False, progress=False,
            )
            if df is not None and not df.empty:
                # Flatten multi-level columns (yfinance ≥ 0.2 returns (metric, ticker) tuples)
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [col[0] for col in df.columns]
                for ts, row in df.iterrows():
                    close = row.get("Close")
                    if close is None or pd.isna(close):
                        continue
                    d = ts.date() if hasattr(ts, "date") else ts
                    points.append({"date": d.isoformat(), "close": float(close)})
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("index-history fetch failed for %s: %s", sym, exc)

        data = {"symbol": sym, "label": label_by_sym.get(sym, sym), "points": points}
        _INDEX_HISTORY_CACHE[cache_key] = {"data": data, "_ts": _time.time()}
        out.append(data)

    return out


def _spawn_job(name: str, fn) -> dict:
    """Run fn(db) in a background thread. Returns {job_id, status, already_running}."""
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(name)

    def _worker():
        # Background threads have no event loop; create one so that libraries
        # like ib_insync (which use asyncio) work correctly in this thread.
        import asyncio
        asyncio.set_event_loop(asyncio.new_event_loop())

        from app.database import SessionLocal
        db2 = SessionLocal()
        try:
            result = fn(db2)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception("Background job %s (%s) failed", job_id, name)
            background_jobs.fail_job(job_id, str(exc))
        finally:
            db2.close()

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


def _mp_to_dict(mp: MarketPrice, ticker: str = "") -> dict:
    def _s(v):
        if v is None:
            return None
        if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
            return str(v)
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return v

    return {
        "security_id": mp.security_id,
        "ticker": ticker,
        "price": _s(mp.price),
        "currency": mp.currency,
        "price_cad": _s(mp.price_cad),
        "prev_close": _s(mp.prev_close),
        "day_high": _s(mp.day_high),
        "day_low": _s(mp.day_low),
        "day_change": _s(mp.day_change),
        "day_change_pct": _s(mp.day_change_pct),
        "price_date": _s(mp.price_date),
        "fetched_at": _s(mp.fetched_at),
        "fetch_ticker": mp.fetch_ticker,
        "source": mp.source,
    }


@router.get("")
def list_prices(db: Session = Depends(get_db)):
    """List all cached market prices."""
    prices = (
        db.query(MarketPrice, Security.ticker)
        .join(Security, MarketPrice.security_id == Security.id)
        .order_by(Security.ticker)
        .all()
    )
    return [_mp_to_dict(mp, ticker) for mp, ticker in prices]


@router.get("/report")
def get_price_report(
    asset_class: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    source: Optional[str] = Query(None),   # "auto" | "manual" | "missing"
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Return all securities with their current price info.
    Includes securities with transactions AND manually-created securities without transactions.
    Supports filtering by asset_class, currency, source, and ticker/name search.
    """
    q = db.query(Security)
    if asset_class:
        q = q.filter(Security.asset_class == asset_class.upper())
    if currency:
        q = q.filter(Security.currency == currency.upper())
    if search:
        like = f"%{search}%"
        q = q.filter((Security.ticker.ilike(like)) | (Security.name.ilike(like)))

    securities = q.order_by(Security.ticker).all()

    # Build price map
    price_map: dict[int, MarketPrice] = {
        mp.security_id: mp
        for mp in db.query(MarketPrice).filter(
            MarketPrice.security_id.in_([s.id for s in securities])
        ).all()
    }

    def _s(v):
        if v is None: return None
        if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)): return str(v)
        if hasattr(v, "isoformat"): return v.isoformat()
        return v

    rows = []
    for sec in securities:
        mp = price_map.get(sec.id)
        mp_source = getattr(mp, "source", None) if mp else None
        has_price = mp is not None and mp.price is not None

        # Apply source filter
        if source == "manual" and mp_source != "manual":
            continue
        if source == "auto" and mp_source not in ("yahoo", "yahoo_chain", "mx_chain"):
            continue
        if source == "missing" and has_price:
            continue

        rows.append({
            "security_id": sec.id,
            "ticker": sec.ticker,
            "name": sec.name,
            "asset_class": sec.asset_class,
            "currency": sec.currency,
            "exchange": sec.exchange,
            "is_option": sec.is_option,
            "price": _s(mp.price) if mp else None,
            "price_cad": _s(mp.price_cad) if mp else None,
            "price_currency": mp.currency if mp else None,
            "day_change_pct": _s(mp.day_change_pct) if mp else None,
            "price_date": _s(mp.price_date) if mp else None,
            "fetched_at": _s(mp.fetched_at) if mp else None,
            "fetch_ticker": mp.fetch_ticker if mp else None,
            "source": mp_source,
            "has_price": has_price,
        })
    return rows


@router.get("/{security_id}/history")
def get_price_history(
    security_id: int,
    db: Session = Depends(get_db),
):
    """Return all historical prices for a security, newest first."""
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    rows = (
        db.query(HistoricalPrice)
        .filter(HistoricalPrice.security_id == security_id)
        .order_by(HistoricalPrice.price_date.desc())
        .all()
    )

    def _s(v):
        if v is None: return None
        if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)): return str(v)
        if hasattr(v, "isoformat"): return v.isoformat()
        return v

    return [
        {
            "price_date": _s(r.price_date),
            "close_price": _s(r.close_price),
            "currency": r.currency,
            "close_price_cad": _s(r.close_price_cad),
            "source": r.source,
        }
        for r in rows
    ]


class HistoricalPriceRequest(BaseModel):
    price_date: date
    price: float
    currency: str = "CAD"

@router.post("/{security_id}/history")
def add_historical_price(security_id: int, body: HistoricalPriceRequest, db: Session = Depends(get_db)):
    """Manually add or update a historical price point for a security."""
    from app.models.prices import HistoricalPrice
    from app.services.fx_service import get_rate

    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    price_dec = Decimal(str(body.price))
    currency = body.currency.upper()

    if currency == "CAD":
        price_cad = price_dec
    elif currency == "USD":
        rate = get_rate(db, body.price_date, "USD", "CAD")
        price_cad = (price_dec * rate).quantize(Decimal("0.000001")) if rate else None
    else:
        price_cad = None

    hp = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == security_id,
        HistoricalPrice.price_date == body.price_date,
    ).first()
    if hp:
        hp.close_price = price_dec
        hp.currency = currency
        hp.close_price_cad = price_cad
        hp.source = "manual"
    else:
        db.add(HistoricalPrice(
            security_id=security_id,
            price_date=body.price_date,
            close_price=price_dec,
            currency=currency,
            close_price_cad=price_cad,
            source="manual",
        ))
    db.commit()
    return {"price_date": body.price_date.isoformat(), "price": str(price_dec), "currency": currency, "price_cad": str(price_cad) if price_cad else None}


@router.put("/{security_id}/history/{price_date_str}")
def update_historical_price(security_id: int, price_date_str: str, body: HistoricalPriceRequest, db: Session = Depends(get_db)):
    """Update the price for an existing historical price row."""
    from datetime import datetime as _dt
    try:
        pd = _dt.strptime(price_date_str, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    hp = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == security_id,
        HistoricalPrice.price_date == pd,
    ).first()
    if not hp:
        raise HTTPException(status_code=404, detail="Historical price row not found")

    price_dec = Decimal(str(body.price))
    currency = body.currency.upper()
    if currency == "CAD":
        price_cad = price_dec
    elif currency == "USD":
        rate = get_rate(db, pd, "USD", "CAD")
        price_cad = (price_dec * rate).quantize(Decimal("0.000001")) if rate else None
    else:
        price_cad = None

    hp.close_price = price_dec
    hp.currency = currency
    hp.close_price_cad = price_cad
    hp.source = "manual"
    db.commit()
    return {"price_date": pd.isoformat(), "price": str(price_dec), "currency": currency, "price_cad": str(price_cad) if price_cad else None}


@router.delete("/{security_id}/history/{price_date_str}")
def delete_historical_price(security_id: int, price_date_str: str, db: Session = Depends(get_db)):
    """Delete a single historical price row."""
    from datetime import datetime as _dt
    try:
        pd = _dt.strptime(price_date_str, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    hp = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == security_id,
        HistoricalPrice.price_date == pd,
    ).first()
    if not hp:
        raise HTTPException(status_code=404, detail="Historical price row not found")

    db.delete(hp)
    db.commit()
    return {"deleted": True, "price_date": pd.isoformat()}


@router.delete("/{security_id}/history")
def delete_all_history(security_id: int, db: Session = Depends(get_db)):
    """Delete all historical price rows for a security (use when wrong company was loaded)."""
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")
    deleted = db.query(HistoricalPrice).filter(HistoricalPrice.security_id == security_id).delete()
    db.commit()
    return {"deleted": deleted, "security_id": security_id}


@router.post("/{security_id}/history/import")
def import_history_csv(
    security_id: int,
    file: UploadFile,
    db: Session = Depends(get_db),
):
    """
    Import price history from a CSV file.
    Expected columns: date (YYYY-MM-DD), price, currency (optional, defaults to security currency).
    Rows are upserted — existing entries for the same date are overwritten.
    """
    import csv, io
    from app.services.fx_service import get_rate

    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    default_currency = (sec.currency or "CAD").upper()

    try:
        content = file.file.read().decode("utf-8-sig")  # strip BOM if present
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read file")

    reader = csv.DictReader(io.StringIO(content))
    # Accept flexible column names
    headers = [h.lower().strip() for h in (reader.fieldnames or [])]
    date_col = next((h for h in headers if h in ("date", "price_date", "day")), None)
    price_col = next((h for h in headers if h in ("price", "close", "close_price", "adj close", "adjusted close")), None)
    ccy_col = next((h for h in headers if h in ("currency", "ccy")), None)

    if not date_col or not price_col:
        raise HTTPException(status_code=400, detail=f"CSV must have 'date' and 'price' columns. Found: {headers}")

    imported = 0
    errors = []
    for i, row in enumerate(reader, start=2):
        raw_date = row.get(date_col, "").strip()
        raw_price = row.get(price_col, "").strip()
        currency = (row.get(ccy_col, "") or default_currency).strip().upper() or default_currency

        if not raw_date or not raw_price:
            continue
        try:
            from datetime import datetime as _dt2
            price_dt = _dt2.strptime(raw_date, "%Y-%m-%d").date()
        except ValueError:
            errors.append(f"Row {i}: invalid date '{raw_date}'")
            continue
        try:
            price_dec = Decimal(raw_price.replace(",", ""))
        except Exception:
            errors.append(f"Row {i}: invalid price '{raw_price}'")
            continue

        if currency == "CAD":
            price_cad = price_dec
        elif currency == "USD":
            rate = get_rate(db, price_dt, "USD", "CAD")
            price_cad = (price_dec * rate).quantize(Decimal("0.000001")) if rate else None
        else:
            price_cad = None

        hp = db.query(HistoricalPrice).filter(
            HistoricalPrice.security_id == security_id,
            HistoricalPrice.price_date == price_dt,
        ).first()
        if hp:
            hp.close_price = price_dec
            hp.currency = currency
            hp.close_price_cad = price_cad
            hp.source = "manual"
        else:
            db.add(HistoricalPrice(
                security_id=security_id,
                price_date=price_dt,
                close_price=price_dec,
                currency=currency,
                close_price_cad=price_cad,
                source="manual",
            ))
        imported += 1

    db.commit()
    return {"imported": imported, "errors": errors[:20]}


@router.post("/{security_id}/history/copy-from/{source_security_id}")
def copy_history_from(
    security_id: int,
    source_security_id: int,
    db: Session = Depends(get_db),
):
    """
    Copy historical prices from source_security_id into this security.
    Use this when a company renamed its ticker (e.g. SQ → XYZ): run on the old
    security (SQ) with the new security as source, or set fetch_ticker_override and
    re-download. Existing rows for the same date are overwritten.
    """
    target = db.get(Security, security_id)
    source = db.get(Security, source_security_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target security not found")
    if not source:
        raise HTTPException(status_code=404, detail="Source security not found")

    source_rows = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == source_security_id
    ).all()

    copied = 0
    for src in source_rows:
        hp = db.query(HistoricalPrice).filter(
            HistoricalPrice.security_id == security_id,
            HistoricalPrice.price_date == src.price_date,
        ).first()
        if hp:
            hp.close_price = src.close_price
            hp.currency = src.currency
            hp.close_price_cad = src.close_price_cad
            hp.source = src.source
            hp.fetch_ticker = src.fetch_ticker
        else:
            db.add(HistoricalPrice(
                security_id=security_id,
                price_date=src.price_date,
                close_price=src.close_price,
                currency=src.currency,
                close_price_cad=src.close_price_cad,
                source=src.source,
                fetch_ticker=src.fetch_ticker,
            ))
        copied += 1

    db.commit()
    return {"copied": copied, "from_ticker": source.ticker, "to_ticker": target.ticker}


@router.get("/status")
def get_price_status(db: Session = Depends(get_db)):
    """
    Return the last live-price refresh time and the most recent historical price date.
    Used by the header to show "Prices updated X ago".
    """
    from sqlalchemy import func as sqlfunc
    live_last = db.query(sqlfunc.max(MarketPrice.fetched_at)).scalar()
    hist_last = db.query(sqlfunc.max(HistoricalPrice.price_date)).scalar()
    hist_last_date = hist_last.date() if hist_last and hasattr(hist_last, 'date') else hist_last
    return {
        "live_last_updated": live_last.isoformat() if live_last else None,
        "history_last_date": hist_last_date.isoformat() if hist_last_date else None,
    }


@router.get("/jobs")
def list_jobs():
    """List recent background price jobs."""
    return background_jobs.list_jobs()


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    """Get status of a background price job."""
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/refresh-recent")
def refresh_recent():
    """
    Smart refresh: live prices + incremental history download + today's snapshots (background job).
    Returns a job_id immediately; poll GET /jobs/{job_id} for status.
    """
    def _fn(db):
        from datetime import timedelta
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        live = price_service.refresh_all_prices(db)
        hist = price_service.fetch_historical_prices(db, incremental=True)
        # Rebuild snapshots for the past 14 days to capture any historical prices
        # that the incremental download filled in (not just today).
        snaps = compute_portfolio_snapshots(db, from_date=date.today() - timedelta(days=14))
        return {"live": live, "history": hist, "snapshots": snaps}
    return _spawn_job("refresh_recent", _fn)


@router.post("/refresh")
def refresh_all():
    """
    Smart price refresh: tries IBKR first (if configured), then falls back to
    yfinance/TMX for any securities IBKR couldn't price.
    Also recomputes today's portfolio snapshots.
    Returns a job_id immediately; poll GET /jobs/{job_id} for status.
    """
    def _fn(db):
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        from app.services import ibkr_service
        from app.models.master import Security as _Security

        ibkr_result = None
        fallback_ids = None   # None = refresh all; list = refresh only these

        # ── Try IBKR first if it has been successfully connected ──────────────
        if ibkr_service.is_available() and ibkr_service.get_status().get("last_connected_at"):
            import logging as _log
            try:
                all_non_options = (
                    db.query(_Security)
                    .filter(_Security.is_option == False)  # noqa: E712
                    .all()
                )
                ibkr_result = ibkr_service.fetch_prices(all_non_options, db)
                fallback_ids = ibkr_result.get("failed_security_ids") or []
                _log.getLogger(__name__).info(
                    "IBKR: %d ok — falling back to yfinance for %d securities",
                    ibkr_result["ok"], len(fallback_ids),
                )
            except Exception as exc:
                _log.getLogger(__name__).warning(
                    "IBKR refresh failed (%s) — falling back to yfinance for all", exc
                )
                fallback_ids = None   # full yfinance fallback

        # ── yfinance/TMX for anything IBKR missed ────────────────────────────
        live = price_service.refresh_all_prices(db, security_ids=fallback_ids)
        # Full refresh: rebuild all snapshots from scratch so they cover every
        # account for the complete history (no from_date = earliest transaction).
        snaps = compute_portfolio_snapshots(db)

        return {"ibkr": ibkr_result, "live": live, "snapshots": snaps}

    return _spawn_job("refresh_prices", _fn)


@router.post("/refresh-fundamentals")
def refresh_fundamentals():
    """
    Fetch full Yahoo Finance fundamentals for all non-option securities and
    store them in security_fundamentals (background job).
    Also keeps the MarketPrice.beta / dividend_yield / market_cap fields in sync.
    Calls ticker.info — run weekly rather than on every price refresh.
    Returns a job_id immediately; poll GET /jobs/{job_id} for status.
    """
    from app.services.signals_service import refresh_fundamentals_all
    return _spawn_job("refresh_fundamentals", lambda db: refresh_fundamentals_all(db))


@router.post("/compute-signals")
def compute_signals():
    """
    Compute technical signals (RSI, momentum, trend, volatility) for all securities
    that have historical price data (background job).
    Returns a job_id immediately; poll GET /jobs/{job_id} for status.
    """
    from app.services.signals_service import compute_signals_all
    return _spawn_job("compute_signals", lambda db: compute_signals_all(db))


@router.post("/refresh/{security_id}")
def refresh_one(security_id: int, db: Session = Depends(get_db)):
    """Refresh market price for a single security."""
    from datetime import date
    from app.services.fx_service import get_rate

    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    usd_to_cad = get_rate(db, date.today(), "USD", "CAD")
    if sec.is_option:
        mp = price_service.fetch_option_chain_price(db, sec, usd_to_cad=usd_to_cad)
    else:
        mp = price_service.fetch_price_for_security(db, sec, usd_to_cad=usd_to_cad)
    db.commit()

    if mp is None:
        return {"message": f"Could not fetch price for {sec.ticker}", "fetched": False}

    return {"message": f"Fetched price for {sec.ticker}", "fetched": True, "price": _mp_to_dict(mp, sec.ticker)}


class FetchHistoryRequest(BaseModel):
    security_ids: Optional[List[int]] = None
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    incremental: bool = False


@router.post("/fetch-history")
def fetch_history(body: FetchHistoryRequest = FetchHistoryRequest()):
    """
    Download historical daily close prices (background job).
    Returns a job_id immediately; poll GET /jobs/{job_id} for status.
    """
    # Capture body values before the thread starts (avoid closure over mutable request state)
    sec_ids = body.security_ids
    from_dt = body.from_date
    to_dt = body.to_date
    incremental = body.incremental
    job_name = f"fetch_history_{sec_ids[0]}" if sec_ids and len(sec_ids) == 1 else "fetch_history"

    def _fn(db):
        return price_service.fetch_historical_prices(
            db,
            security_ids=sec_ids,
            from_date=from_dt,
            to_date=to_dt,
            incremental=incremental,
        )
    return _spawn_job(job_name, _fn)


@router.post("/record-option-history")
def record_option_history(db: Session = Depends(get_db)):
    """
    Snapshot today's current option prices (from market_prices) into historical_prices.
    Run this after a price refresh to build up option price history over time.
    Only records options that have a current MarketPrice.
    """
    from datetime import date as _date, datetime, timezone
    from app.models.prices import HistoricalPrice
    from app.models.transactions import Transaction

    today = _date.today()

    # All option securities with transactions
    option_sec_ids = [
        r[0] for r in db.query(Transaction.security_id)
        .join(Security, Transaction.security_id == Security.id)
        .filter(Transaction.security_id.isnot(None), Security.is_option == True)
        .distinct().all()
    ]

    recorded = 0
    skipped = 0
    for sec_id in option_sec_ids:
        mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec_id).first()
        if mp is None or mp.price is None:
            skipped += 1
            continue

        hist = db.query(HistoricalPrice).filter(
            HistoricalPrice.security_id == sec_id,
            HistoricalPrice.price_date == today,
        ).first()
        if hist:
            hist.close_price = mp.price
            hist.currency = mp.currency
            hist.close_price_cad = mp.price_cad
            hist.source = mp.source or "snapshot"
            hist.fetch_ticker = mp.fetch_ticker
        else:
            db.add(HistoricalPrice(
                security_id=sec_id,
                price_date=today,
                close_price=mp.price,
                currency=mp.currency,
                close_price_cad=mp.price_cad,
                source=mp.source or "snapshot",
                fetch_ticker=mp.fetch_ticker,
            ))
        recorded += 1

    db.commit()
    return {
        "message": f"Recorded {recorded} option prices to history",
        "recorded": recorded,
        "skipped": skipped,
    }


class ManualPriceRequest(BaseModel):
    price: float
    currency: str = "CAD"  # native currency of the price entered


@router.put("/{security_id}/manual")
def set_manual_price(security_id: int, body: ManualPriceRequest, db: Session = Depends(get_db)):
    """
    Manually set the market price for a security.
    Applies to ALL securities with the same ticker (cross-account).
    Records the price in historical_prices for tracking over time.
    Sets source='manual' so it won't be overwritten by the next auto-refresh.
    """
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    price_dec = Decimal(str(body.price))
    currency = body.currency.upper()

    if currency == "CAD":
        price_cad = price_dec
    elif currency == "USD":
        rate = get_rate(db, date.today(), "USD", "CAD")
        price_cad = (price_dec * rate).quantize(Decimal("0.000001")) if rate else None
    else:
        price_cad = None

    today = date.today()
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # For option securities, match by contract attributes (underlying + strike + expiry + type)
    # rather than exact ticker string — different import formats (ibkr_history vs ibkr_trades)
    # can produce slightly different ticker strings for the same real contract.
    if sec.is_option:
        from app.models.options import OptionContract
        contract = db.query(OptionContract).filter(OptionContract.security_id == sec.id).first()
        if contract:
            matching_contracts = db.query(OptionContract).filter(
                OptionContract.underlying_security_id == contract.underlying_security_id,
                OptionContract.option_type == contract.option_type,
                OptionContract.strike == contract.strike,
                OptionContract.expiry_date == contract.expiry_date,
            ).all()
            same_ticker_secs = [
                s for s in (db.get(Security, c.security_id) for c in matching_contracts)
                if s is not None
            ]
            if not same_ticker_secs:
                same_ticker_secs = [sec]
        else:
            same_ticker_secs = db.query(Security).filter(Security.ticker == sec.ticker).all()
    else:
        same_ticker_secs = db.query(Security).filter(Security.ticker == sec.ticker).all()
    first_mp = None

    for s in same_ticker_secs:
        mp = db.query(MarketPrice).filter(MarketPrice.security_id == s.id).first()
        if mp:
            mp.price = price_dec
            mp.currency = currency
            mp.price_cad = price_cad
            mp.price_date = today
            mp.fetched_at = now
            mp.source = "manual"
            mp.fetch_ticker = None
            mp.day_change_pct = None
            mp.day_change = None
        else:
            mp = MarketPrice(
                security_id=s.id,
                price=price_dec,
                currency=currency,
                price_cad=price_cad,
                price_date=today,
                fetched_at=now,
                source="manual",
            )
            db.add(mp)

        # Record in historical_prices (upsert by security_id + price_date)
        hist = db.query(HistoricalPrice).filter(
            HistoricalPrice.security_id == s.id,
            HistoricalPrice.price_date == today,
        ).first()
        if hist:
            hist.close_price = price_dec
            hist.currency = currency
            hist.close_price_cad = price_cad
            hist.source = "manual"
        else:
            db.add(HistoricalPrice(
                security_id=s.id,
                price_date=today,
                close_price=price_dec,
                currency=currency,
                close_price_cad=price_cad,
                source="manual",
            ))

        if s.id == security_id:
            first_mp = mp

    db.commit()
    if first_mp:
        db.refresh(first_mp)
    return _mp_to_dict(first_mp or mp, sec.ticker)


@router.get("/test-mx/{symbol}")
def test_mx(
    symbol: str,
    expiry: Optional[str] = Query(None),
    option_type: str = Query("CALL"),
    strike: Optional[float] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Debug endpoint: fetches a Canadian option price from the Montreal Exchange.
    Example: GET /api/prices/test-mx/WCP?expiry=2026-04-17&option_type=CALL&strike=14.5
    If strike is omitted, returns the first 10 rows found for that expiry.
    """
    import html as _html
    import json as _json
    import re as _re
    import httpx as _httpx
    from app.services.price_service import _MX_BASE_URL, _MX_HEADERS

    url = f"{_MX_BASE_URL}?symbol={symbol.upper()}*"
    try:
        resp = _httpx.get(url, headers=_MX_HEADERS, timeout=15, follow_redirects=True)
        rows = []
        for m in _re.finditer(r"data-row='([^']*)'", resp.text):
            raw = _html.unescape(m.group(1))
            try:
                row_data = _json.loads(raw)
                if expiry:
                    # filter to expiry
                    for side in ("call", "put"):
                        opt = row_data.get(side)
                        if opt and opt.get("expiry_date") == expiry:
                            rows.append({side: opt})
                else:
                    rows.append(row_data)
            except Exception:
                continue
        return {
            "status_code": resp.status_code,
            "symbol": symbol.upper(),
            "expiry": expiry,
            "rows_found": len(rows),
            "sample": rows[:10],
        }
    except Exception as e:
        return {"error": str(e), "symbol": symbol.upper()}


@router.delete("/{security_id}")
def delete_price(security_id: int, db: Session = Depends(get_db)):
    """Delete the cached price for a security (e.g. if the fetch ticker is wrong)."""
    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    if not mp:
        raise HTTPException(status_code=404, detail="No cached price for this security")
    db.delete(mp)
    db.commit()
    return {"deleted": security_id}
