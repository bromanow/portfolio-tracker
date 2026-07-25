"""
Scanner endpoints.

The standalone Covered Call Scanner UI/scan-run/results have been retired in favour of the
Covered Call Portfolio Builder (app/routers/covered_call_portfolio.py), which reuses the same
underlying scoring engine (app/services/covered_call_service.py's scan_tickers/_score) against
a curated candidate universe instead of an ad-hoc watchlist. What's left here:

GET    /api/scanner/meta             – IBeam connection status (also read by Header.tsx)
GET    /api/scanner/watchlist        – list of extra user-added candidate tickers
POST   /api/scanner/watchlist        – add a ticker
DELETE /api/scanner/watchlist/{ticker} – remove a ticker
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db

router = APIRouter(prefix="/api/scanner", tags=["scanner"])
logger = logging.getLogger(__name__)


# ── Pydantic models ────────────────────────────────────────────────────────────

class WatchlistAdd(BaseModel):
    ticker: str
    notes: Optional[str] = None


@router.get("/ibeam-debug")
def ibeam_debug():
    """Debug endpoint — shows IBeam connectivity details without auth."""
    import os, httpx
    base = os.environ.get("IBEAM_BASE_URL", "")
    if not base:
        return {"error": "IBEAM_BASE_URL not set", "base": base}
    try:
        r = httpx.get(f"{base}/v1/api/iserver/auth/status", verify=False, timeout=10)
        return {"base": base, "status_code": r.status_code, "body": r.json()}
    except Exception as exc:
        return {"base": base, "error": str(exc), "error_type": type(exc).__name__}


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

    ibeam_available = False
    try:
        from app.services import ibkr_service
        ibeam_available = ibkr_service.is_ibeam_available()
    except Exception:
        pass

    base = {"ibeam_available": ibeam_available}

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
