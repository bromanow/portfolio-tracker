"""
Covered-call scanner endpoints.

GET    /api/scanner/results          – latest scan results (filterable)
GET    /api/scanner/meta             – last scan timestamp + summary stats
POST   /api/scanner/run              – trigger a background scan
GET    /api/scanner/watchlist        – list watchlist tickers
POST   /api/scanner/watchlist        – add a ticker
DELETE /api/scanner/watchlist/{ticker} – remove a ticker
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import background_jobs
from app.database import get_db

router = APIRouter(prefix="/api/scanner", tags=["scanner"])
logger = logging.getLogger(__name__)


# ── Pydantic models ────────────────────────────────────────────────────────────

class WatchlistAdd(BaseModel):
    ticker: str
    notes: Optional[str] = None


class ScanRequest(BaseModel):
    """Scan parameters sent from the frontend filter bar."""
    min_avg_stock_vol: int   = 250_000
    min_option_oi:     int   = 50
    min_option_vol:    int   = 3
    min_dte:           int   = 14
    max_dte:           int   = 60
    min_otm_pct:       float = 0.5
    max_otm_pct:       float = 25.0
    min_div_yield:     float = 0.0
    min_rating:        str   = "Avoid"   # Best/Good/Fair/Avoid


# ── Job helper ─────────────────────────────────────────────────────────────────

def _spawn_scan(scan_req: ScanRequest) -> dict:
    name = "covered_call_scan"
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(name)

    import threading

    def _run():
        try:
            from app.database import SessionLocal
            from app.services.covered_call_service import run_covered_call_scan, ScanParams
            p = ScanParams(
                min_avg_stock_vol=scan_req.min_avg_stock_vol,
                min_option_oi=scan_req.min_option_oi,
                min_option_vol=scan_req.min_option_vol,
                min_dte=scan_req.min_dte,
                max_dte=scan_req.max_dte,
                min_otm_pct=scan_req.min_otm_pct,
                max_otm_pct=scan_req.max_otm_pct,
                min_div_yield=scan_req.min_div_yield,
                min_rating=scan_req.min_rating,
            )
            with SessionLocal() as db:
                result = run_covered_call_scan(db, p)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("Covered-call scan job failed")
            background_jobs.fail_job(job_id, str(exc))

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/run")
def trigger_scan(body: ScanRequest = None):
    """Start a covered-call scan in the background. Returns a job_id to poll."""
    return _spawn_scan(body or ScanRequest())


@router.get("/meta")
def get_scan_meta(db: Session = Depends(get_db)):
    """Return last scan timestamp, stats, and current Gateway status."""
    row = db.execute(text("""
        SELECT scan_run_id, scanned_at, COUNT(*) AS total,
               COUNT(DISTINCT ticker) AS tickers
        FROM   scanner_results
        GROUP  BY scan_run_id, scanned_at
        ORDER  BY scanned_at DESC
        LIMIT  1
    """)).fetchone()

    ibkr_available = False
    ibkr_connected = False
    gateway_running = False
    try:
        from app.services import ibkr_service
        ibkr_available = ibkr_service.is_available()
        status = ibkr_service.get_status()
        gateway_running = bool(status.get("gateway_running"))
        ibkr_connected = bool(
            ibkr_available
            and gateway_running
            and status.get("last_connected_at")
        )
    except Exception:
        pass

    base = {
        "ibkr_available":  ibkr_available,
        "ibkr_connected":  ibkr_connected,
        "gateway_running": gateway_running,
    }

    if row is None:
        return {"available": False, **base}
    return {
        "available":   True,
        "scan_run_id": row[0],
        "scanned_at":  row[1],
        "total_rows":  row[2],
        "tickers":     row[3],
        **base,
    }


@router.get("/results")
def get_scan_results(
    db: Session = Depends(get_db),
    min_yield:     float         = Query(0.0,  description="Minimum annualised CC yield %"),
    max_otm:       float         = Query(25.0, description="Maximum OTM %"),
    min_oi:        int           = Query(0,    description="Minimum open interest"),
    min_dte:       int           = Query(0,    description="Minimum DTE"),
    max_dte:       int           = Query(999,  description="Maximum DTE"),
    min_div_yield:  float         = Query(0.0,  description="Minimum dividend yield %"),
    min_score:      float         = Query(0.0,  description="Minimum score"),
    recommendation: Optional[str] = Query(None, description="Comma-separated ratings e.g. Best,Good"),
    in_portfolio:   Optional[bool] = Query(None, description="Filter to portfolio tickers only"),
    limit:          int           = Query(500, ge=1, le=2000),
):
    """Return the latest scan results, with optional filters."""
    from app.models.scanner import ScannerResult

    latest = db.execute(text(
        "SELECT scan_run_id FROM scanner_results ORDER BY scanned_at DESC LIMIT 1"
    )).scalar()
    if latest is None:
        return []

    q = db.query(ScannerResult).filter(ScannerResult.scan_run_id == latest)

    if min_yield > 0:
        q = q.filter(ScannerResult.annual_yield_pct >= min_yield)
    if max_otm < 25:
        q = q.filter(ScannerResult.otm_pct <= max_otm)
    if min_oi > 0:
        q = q.filter(ScannerResult.open_interest >= min_oi)
    if min_dte > 0:
        q = q.filter(ScannerResult.dte >= min_dte)
    if max_dte < 999:
        q = q.filter(ScannerResult.dte <= max_dte)
    if min_div_yield > 0:
        q = q.filter(ScannerResult.dividend_yield >= min_div_yield)
    if in_portfolio is True:
        q = q.filter(ScannerResult.in_portfolio == True)
    if min_score > 0:
        q = q.filter(ScannerResult.score >= min_score)
    if recommendation:
        ratings = [r.strip() for r in recommendation.split(",")]
        q = q.filter(ScannerResult.recommendation.in_(ratings))

    rows = q.order_by(ScannerResult.score.desc()).limit(limit).all()

    def _f(v): return float(v) if v is not None else None
    return [
        {
            "id":                  r.id,
            "ticker":              r.ticker,
            "company_name":        r.company_name,
            "current_price":       _f(r.current_price),
            "avg_stock_volume":    r.avg_stock_volume,
            "currency":            r.currency,
            "dividend_yield":      _f(r.dividend_yield),
            "strike":              float(r.strike),
            "expiry_date":         r.expiry_date.isoformat() if r.expiry_date else None,
            "dte":                 r.dte,
            "bid":                 _f(r.bid),
            "ask":                 _f(r.ask),
            "mid":                 _f(r.mid),
            "volume":              r.volume,
            "open_interest":       r.open_interest,
            "iv_pct":              _f(r.iv_pct),
            "hv_30_pct":           _f(r.hv_30_pct),
            "iv_hv_ratio":         _f(r.iv_hv_ratio),
            "otm_pct":             _f(r.otm_pct),
            "annual_yield_pct":    _f(r.annual_yield_pct),
            "max_return_pct":      _f(r.max_return_pct),
            "breakeven":           _f(r.breakeven),
            "score":               _f(r.score),
            "delta":               _f(r.delta),
            "gamma":               _f(r.gamma),
            "theta":               _f(r.theta),
            "vega":                _f(r.vega),
            "bid_ask_spread_pct":  _f(r.bid_ask_spread_pct),
            "data_source":         r.data_source,
            "recommendation":      r.recommendation,
            "in_portfolio":        r.in_portfolio,
            "portfolio_qty":       r.portfolio_qty,
            "portfolio_contracts": r.portfolio_contracts,
        }
        for r in rows
    ]


# ── Watchlist ──────────────────────────────────────────────────────────────────

@router.get("/watchlist")
def get_watchlist(db: Session = Depends(get_db)):
    from app.models.scanner import ScannerWatchlist
    rows = db.query(ScannerWatchlist).order_by(ScannerWatchlist.ticker).all()
    return [
        {
            "id":           r.id,
            "ticker":       r.ticker,
            "company_name": r.company_name,
            "notes":        r.notes,
            "added_at":     r.added_at.isoformat() if r.added_at else None,
        }
        for r in rows
    ]


@router.post("/watchlist", status_code=201)
def add_watchlist(body: WatchlistAdd, db: Session = Depends(get_db)):
    from app.models.scanner import ScannerWatchlist
    ticker = body.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker required")

    existing = db.query(ScannerWatchlist).filter(ScannerWatchlist.ticker == ticker).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"{ticker} already in watchlist")

    company_name = None
    try:
        import yfinance as yf
        info = yf.Ticker(ticker).info
        company_name = info.get("longName") or info.get("shortName")
    except Exception:
        pass

    row = ScannerWatchlist(ticker=ticker, company_name=company_name, notes=body.notes)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id":           row.id,
        "ticker":       row.ticker,
        "company_name": row.company_name,
        "notes":        row.notes,
        "added_at":     row.added_at.isoformat() if row.added_at else None,
    }


@router.delete("/watchlist/{ticker}")
def remove_watchlist(ticker: str, db: Session = Depends(get_db)):
    from app.models.scanner import ScannerWatchlist
    ticker = ticker.strip().upper()
    row = db.query(ScannerWatchlist).filter(ScannerWatchlist.ticker == ticker).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"{ticker} not in watchlist")
    db.delete(row)
    db.commit()
    return {"deleted": True, "ticker": ticker}
