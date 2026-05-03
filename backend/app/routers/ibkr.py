"""
IBKR integration endpoints.

GET  /api/ibkr/status          — connection settings + last refresh info
POST /api/ibkr/connect         — save settings and test the connection
POST /api/ibkr/disconnect      — (informational — actual disconnect happens per-refresh)
POST /api/ibkr/refresh-prices  — refresh all non-option prices via TWS/Gateway (async job)
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import ibkr_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ibkr", tags=["ibkr"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    host: str = "127.0.0.1"
    port: int = 7497
    client_id: int = 10


# ── Status ────────────────────────────────────────────────────────────────────

@router.get("/status")
def get_status():
    """Return current IBKR settings and last-refresh metadata. No connection attempt."""
    return ibkr_service.get_status()


# ── Connect / test ────────────────────────────────────────────────────────────

@router.post("/connect")
async def connect(req: ConnectRequest):
    """
    Save connection settings and verify they work by attempting a short-lived
    connection to TWS/IB Gateway.  Saves settings on success.
    """
    if not ibkr_service.is_available():
        raise HTTPException(503, "ib_insync is not installed on the server")

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        ibkr_service.test_connection,
        req.host, req.port, req.client_id,
    )

    if result["ok"]:
        ibkr_service.save_settings(req.host, req.port, req.client_id)
        return {
            "connected": True,
            "tws_version": result.get("tws_version"),
            "message": f"Connected to TWS/Gateway at {req.host}:{req.port}",
        }
    else:
        raise HTTPException(
            502,
            f"Could not connect to TWS/Gateway at {req.host}:{req.port} — {result['error']}. "
            "Make sure TWS or IB Gateway is running and API connections are enabled "
            "(File → Global Config → API → Settings → Enable ActiveX and Socket Clients)."
        )


@router.post("/disconnect")
def disconnect():
    """Clears last-connected state (connections are per-refresh, not persistent)."""
    return {"disconnected": True}


@router.post("/launch")
def launch_gateway():
    """
    Open IB Gateway (or TWS) via the macOS `open` command.
    The app takes ~15–20 seconds to finish loading before API connections work.
    """
    result = ibkr_service.launch_gateway()
    if not result["ok"]:
        raise HTTPException(404, result["error"])
    return result


# ── Price refresh job ─────────────────────────────────────────────────────────

# Reuse the same background_jobs store as the prices router
from app.routers.prices import background_jobs  # noqa: E402


def _spawn_ibkr_refresh() -> dict:
    """Spawn a background job that connects to TWS, fetches all prices, disconnects."""
    job_name = "ibkr-refresh-prices"

    if background_jobs.is_running(job_name):
        running = [j for j in background_jobs.list_jobs()
                   if j["name"] == job_name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None,
                "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(job_name)

    def _worker():
        from app.database import SessionLocal
        from app.models.master import Security
        db = SessionLocal()
        try:
            securities = db.query(Security).filter(Security.is_option == False).all()  # noqa: E712
            result = ibkr_service.fetch_prices(securities, db)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("IBKR refresh job %s failed", job_id)
            background_jobs.fail_job(job_id, str(exc) or type(exc).__name__)
        finally:
            db.close()

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.post("/refresh-prices")
def refresh_prices():
    """
    Trigger a live price refresh for all securities (excl. options) via TWS/Gateway.
    Returns immediately with a job_id; poll GET /api/prices/jobs/{job_id} for progress.
    """
    if not ibkr_service.is_available():
        raise HTTPException(503, "ib_insync is not installed on the server")

    settings = ibkr_service.get_settings()
    if not settings.get("host"):
        raise HTTPException(400, "IBKR connection not configured. Call POST /api/ibkr/connect first.")

    return _spawn_ibkr_refresh()


# ── Transaction sync ──────────────────────────────────────────────────────────

@router.get("/managed-accounts")
def managed_accounts():
    """
    Return the list of IB account numbers visible in TWS/Gateway.
    Use this to populate Account.account_number for proper transaction routing.
    """
    if not ibkr_service.is_available():
        raise HTTPException(503, "ib_insync is not installed on the server")
    return ibkr_service.get_managed_accounts()


@router.post("/sync-transactions")
def sync_transactions_endpoint(db: Session = Depends(get_db)):
    """
    Pull recent executions from IB Gateway and create Transaction records.

    Note: IB's reqExecutions() only returns data from the *current* TWS/Gateway
    session.  For a full history, export an IB Flex Query and use the CSV import.

    Returns immediately with a job_id; poll GET /api/prices/jobs/{job_id}.
    """
    if not ibkr_service.is_available():
        raise HTTPException(503, "ib_insync is not installed on the server")

    status = ibkr_service.get_status()
    if not status.get("last_connected_at"):
        raise HTTPException(400, "IBKR not configured. Call POST /api/ibkr/connect first.")

    job_name = "ibkr-sync-transactions"

    if background_jobs.is_running(job_name):
        running = [j for j in background_jobs.list_jobs()
                   if j["name"] == job_name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None,
                "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(job_name)

    def _worker():
        from app.database import SessionLocal
        db_inner = SessionLocal()
        try:
            result = ibkr_service.sync_transactions(db_inner)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("IBKR sync-transactions job %s failed", job_id)
            err_msg = str(exc) or type(exc).__name__
            background_jobs.fail_job(job_id, err_msg)
        finally:
            db_inner.close()

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}
