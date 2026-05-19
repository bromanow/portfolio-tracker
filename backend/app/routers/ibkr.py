"""
IBKR endpoints — two independent integrations:

TWS / IB Gateway (live socket connection — requires Gateway running locally):
  GET    /api/ibkr/status                  — gateway status + last refresh info
  POST   /api/ibkr/connect                 — test & save host/port/clientId
  POST   /api/ibkr/launch                  — launch IB Gateway app (macOS)
  GET    /api/ibkr/managed-accounts        — list IB account numbers
  POST   /api/ibkr/refresh-prices          — fetch live prices via TWS
  POST   /api/ibkr/sync-transactions       — import today's executions via TWS

Flex Query (pulls historical trade CSVs from IBKR servers — no Gateway needed):
  GET    /api/ibkr/flex/my-config          — get own config
  POST   /api/ibkr/flex/my-config          — create / update own config
  DELETE /api/ibkr/flex/my-config          — remove own config
  POST   /api/ibkr/flex/sync               — sync own accounts now

Admin only:
  GET    /api/ibkr/flex/configs            — list all users' configs
  POST   /api/ibkr/flex/sync-all           — sync every enabled config
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User
from app.models.ibkr import IBKRFlexConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ibkr", tags=["ibkr"])


def _require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(403, "Admin only")
    return current_user


# ── Schemas ───────────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    host:      str = "127.0.0.1"
    port:      int = 7497
    client_id: int = 10


class FlexConfigIn(BaseModel):
    query_id: str
    token:    str
    enabled:  bool = True


class FlexConfigPatch(BaseModel):
    query_id: Optional[str] = None
    token:    Optional[str] = None
    enabled:  Optional[bool] = None


def _config_dict(cfg: IBKRFlexConfig, include_user: bool = False) -> dict:
    d = {
        "id":                 cfg.id,
        "user_id":            cfg.user_id,
        "query_id":           cfg.query_id,
        "token_hint":         f"…{cfg.token[-6:]}",
        "enabled":            cfg.enabled,
        "last_sync_at":       cfg.last_sync_at.isoformat() if cfg.last_sync_at else None,
        "last_sync_status":   cfg.last_sync_status,
        "last_sync_message":  cfg.last_sync_message,
        "last_sync_imported": cfg.last_sync_imported,
        "last_sync_details":  cfg.last_sync_details,
    }
    if include_user and cfg.user:
        d["user_name"]  = cfg.user.name
        d["user_email"] = cfg.user.email
    return d


# ── Reuse background job store ─────────────────────────────────────────────────

from app.routers.prices import background_jobs  # noqa: E402

# Import ibkr_service at module level so ib_insync's eventkit initialises in
# the main thread (it calls asyncio.get_event_loop() at import time, which
# fails inside AnyIO worker threads used by FastAPI).
from app.services import ibkr_service  # noqa: E402

# ── TWS / IB Gateway endpoints ────────────────────────────────────────────────

@router.get("/status")
def get_status():
    """Return current TWS/Gateway connection status."""
    return ibkr_service.get_status()


@router.post("/connect")
def connect(body: ConnectRequest):
    """
    Test connection to TWS/IB Gateway and persist the settings if successful.
    Runs synchronously (may take up to ~10 s).
    """
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(
            ibkr_service.test_connection, body.host, body.port, body.client_id
        ).result(timeout=20)
    if result["ok"]:
        ibkr_service.save_settings(body.host, body.port, body.client_id)
        return {
            "connected":   True,
            "tws_version": result.get("tws_version", ""),
            "message":     f"Connected to {body.host}:{body.port}",
        }
    raise HTTPException(status_code=502, detail=result.get("error", "Connection failed"))


@router.post("/launch")
def launch():
    """Launch IB Gateway (or TWS) using macOS `open`. macOS only."""
    result = ibkr_service.launch_gateway()
    if not result["ok"]:
        raise HTTPException(status_code=500, detail=result.get("error", "Could not launch"))
    return result


@router.get("/managed-accounts")
def managed_accounts():
    """Connect to Gateway briefly and return the list of IB account numbers."""
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(ibkr_service.get_managed_accounts).result(timeout=15)
    return result


@router.post("/refresh-prices")
def refresh_prices_ibkr():
    """
    Fetch live prices for all non-option securities via TWS/Gateway.
    Falls back to yfinance for any that IBKR can't price.
    Returns a job_id — poll GET /api/prices/jobs/{job_id} for status.
    """
    if not ibkr_service.is_available():
        raise HTTPException(status_code=503, detail="ib_insync not installed")
    if not ibkr_service.get_status().get("last_connected_at"):
        raise HTTPException(status_code=400, detail="Not connected — click 'Test & Save' in the IB modal first")

    name = "ibkr_refresh_prices"
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(name)

    def _run():
        try:
            from app.database import SessionLocal
            from app.models.master import Security
            from app.services.price_service import refresh_all_prices
            with SessionLocal() as db:
                result = ibkr_service.fetch_prices(
                    db.query(Security).filter(Security.is_option == False).all(), db
                )
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("IBKR refresh-prices job failed")
            background_jobs.fail_job(job_id, str(exc))

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.post("/sync-transactions")
def sync_transactions():
    """
    Import today's executions from the running IB Gateway session.
    This is separate from Flex Query — it captures same-day trades.
    Returns a job_id — poll GET /api/prices/jobs/{job_id} for status.
    """
    if not ibkr_service.is_available():
        raise HTTPException(status_code=503, detail="ib_insync not installed")
    if not ibkr_service.get_status().get("last_connected_at"):
        raise HTTPException(status_code=400, detail="Not connected — click 'Test & Save' in the IB modal first")

    name = "ibkr_sync_transactions"
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(name)

    def _run():
        try:
            from app.database import SessionLocal
            with SessionLocal() as db:
                result = ibkr_service.sync_transactions(db)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("IBKR sync-transactions job failed")
            background_jobs.fail_job(job_id, str(exc))

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


# ── Flex Query endpoints ───────────────────────────────────────────────────────


def _spawn_sync(job_name: str, user_ids: list[int]) -> dict:
    if background_jobs.is_running(job_name):
        running = [j for j in background_jobs.list_jobs()
                   if j["name"] == job_name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None,
                "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(job_name)

    def _worker():
        from app.database import SessionLocal
        from app.services.ibkr_flex import sync_config
        from datetime import datetime as _dt
        db = SessionLocal()
        try:
            results = []
            for uid in user_ids:
                cfg = db.query(IBKRFlexConfig).filter_by(user_id=uid).first()
                if not cfg:
                    logger.warning("IBKR Flex sync: no config found for user_id=%s", uid)
                    continue
                results.append({"user_id": uid, **sync_config(db, cfg)})
            background_jobs.finish_job(job_id, {"results": results})
        except Exception as exc:
            msg = str(exc) or type(exc).__name__
            logger.exception("IBKR Flex sync job %s failed", job_id)
            background_jobs.fail_job(job_id, msg)
            # Best-effort: mark all configs as errored so the UI shows something
            try:
                for uid in user_ids:
                    cfg = db.query(IBKRFlexConfig).filter_by(user_id=uid).first()
                    if cfg and cfg.last_sync_status in (None, "running"):
                        cfg.last_sync_at      = _dt.utcnow()
                        cfg.last_sync_status  = "error"
                        cfg.last_sync_message = msg[:500]
                db.commit()
            except Exception:
                pass
        finally:
            db.close()

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.get("/flex/my-config")
def get_my_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cfg = db.query(IBKRFlexConfig).filter_by(user_id=current_user.id).first()
    if not cfg:
        return None
    return _config_dict(cfg)


@router.post("/flex/my-config", status_code=201)
def save_my_config(
    body: FlexConfigIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or replace the current user's Flex config."""
    cfg = db.query(IBKRFlexConfig).filter_by(user_id=current_user.id).first()
    if cfg:
        cfg.query_id = body.query_id
        cfg.token    = body.token
        cfg.enabled  = body.enabled
    else:
        cfg = IBKRFlexConfig(
            user_id=current_user.id,
            query_id=body.query_id,
            token=body.token,
            enabled=body.enabled,
        )
        db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return _config_dict(cfg)


@router.delete("/flex/my-config", status_code=204)
def delete_my_config(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cfg = db.query(IBKRFlexConfig).filter_by(user_id=current_user.id).first()
    if cfg:
        db.delete(cfg)
        db.commit()


FLEX_MIN_INTERVAL_SECONDS = 600  # IBKR rate-limits the API to ~1 request / 10 min


@router.post("/flex/sync")
def sync_my_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Trigger a manual Flex sync for the current user's accounts."""
    from datetime import datetime as _dt

    cfg = db.query(IBKRFlexConfig).filter_by(user_id=current_user.id).first()
    if not cfg:
        raise HTTPException(404, "No Flex Query config found. Add one in Admin → IBKR Flex first.")
    if not cfg.enabled:
        raise HTTPException(400, "Flex config is disabled.")

    # Guard against IBKR's ~10-minute API rate limit
    if cfg.last_sync_at and cfg.last_sync_status not in ("error",):
        elapsed = (_dt.utcnow() - cfg.last_sync_at).total_seconds()
        if elapsed < FLEX_MIN_INTERVAL_SECONDS:
            wait = int(FLEX_MIN_INTERVAL_SECONDS - elapsed)
            raise HTTPException(
                429,
                f"IBKR limits Flex API requests to once every 10 minutes. "
                f"Please wait {wait // 60}m {wait % 60}s before syncing again.",
            )

    return _spawn_sync(f"ibkr-flex-sync-{current_user.id}", [current_user.id])


@router.post("/flex/upload-xml")
def upload_flex_xml(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Import transactions directly from a Flex Query XML file downloaded from
    the IBKR website. Bypasses the API rate limit — useful when the automatic
    sync returns 'Statement could not be generated at this time.'
    """
    from app.services.ibkr_flex import import_from_xml_str

    if not file.filename or not file.filename.lower().endswith(".xml"):
        raise HTTPException(400, "Please upload a .xml file exported from IBKR Flex Query.")

    content = file.file.read()
    try:
        xml_str = content.decode("utf-8")
    except UnicodeDecodeError:
        xml_str = content.decode("latin-1")

    if len(xml_str) > 50 * 1024 * 1024:  # 50 MB guard
        raise HTTPException(400, "File too large (max 50 MB)")

    try:
        result = import_from_xml_str(db, xml_str)
    except Exception as exc:
        logger.exception("Flex XML upload failed for user_id=%s", current_user.id)
        raise HTTPException(400, f"Failed to parse XML: {exc}") from exc

    if result.get("error"):
        raise HTTPException(400, result["error"])

    return result


# ── Admin — diagnostics ──────────────────────────────────────────────────────

@router.post("/flex/test-connection")
def test_connection(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Hit the IBKR SendRequest endpoint with the user's credentials and return
    the raw XML so problems can be diagnosed without running a full sync.
    """
    import httpx, xml.etree.ElementTree as ET
    from app.services.ibkr_flex import FLEX_SEND_URL

    cfg = db.query(IBKRFlexConfig).filter_by(user_id=current_user.id).first()
    if not cfg:
        raise HTTPException(404, "No Flex config found")

    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.get(FLEX_SEND_URL, params={
                "t": cfg.token, "q": cfg.query_id, "v": "3",
            })
        raw = resp.text[:2000]
        try:
            root = ET.fromstring(resp.text)
            status  = root.findtext("Status")
            err_code = root.findtext("ErrorCode")
            err_msg  = root.findtext("ErrorMessage")
            ref_code = root.findtext("ReferenceCode")
        except Exception:
            status = err_code = err_msg = ref_code = None
        return {
            "http_status": resp.status_code,
            "ibkr_status": status,
            "error_code":  err_code,
            "error_message": err_msg,
            "reference_code": ref_code,
            "raw": raw,
        }
    except Exception as exc:
        return {"error": str(exc)}


# ── Admin — all configs ───────────────────────────────────────────────────────

@router.get("/flex/configs")
def list_all_configs(
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    configs = db.query(IBKRFlexConfig).all()
    return [_config_dict(c, include_user=True) for c in configs]


@router.post("/flex/sync-all")
def sync_all(
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    """Sync all enabled configs (admin)."""
    configs = db.query(IBKRFlexConfig).filter_by(enabled=True).all()
    if not configs:
        return {"message": "No enabled Flex configs", "started": False}
    return _spawn_sync("ibkr-flex-sync-all", [c.user_id for c in configs])
