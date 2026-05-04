"""
IBKR Flex Query endpoints.

GET    /api/ibkr/flex/configs                  — list all Flex configs (admin)
POST   /api/ibkr/flex/configs                  — create / upsert config (admin)
PUT    /api/ibkr/flex/configs/{id}             — update config (admin)
DELETE /api/ibkr/flex/configs/{id}             — remove config (admin)
POST   /api/ibkr/flex/sync/{account_id}        — manual sync for one account (admin)
POST   /api/ibkr/flex/sync-all                 — sync all enabled accounts (admin)
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
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

class FlexConfigIn(BaseModel):
    account_id: int
    query_id:   str
    token:      str
    enabled:    bool = True


class FlexConfigUpdate(BaseModel):
    query_id: Optional[str] = None
    token:    Optional[str] = None
    enabled:  Optional[bool] = None


def _config_dict(cfg: IBKRFlexConfig) -> dict:
    return {
        "id":                cfg.id,
        "account_id":        cfg.account_id,
        "account_name":      cfg.account.name if cfg.account else None,
        "query_id":          cfg.query_id,
        # Never expose the full token — show last 6 chars only
        "token_hint":        f"…{cfg.token[-6:]}",
        "enabled":           cfg.enabled,
        "last_sync_at":      cfg.last_sync_at.isoformat() if cfg.last_sync_at else None,
        "last_sync_status":  cfg.last_sync_status,
        "last_sync_message": cfg.last_sync_message,
        "last_sync_imported": cfg.last_sync_imported,
    }


# ── Config CRUD ───────────────────────────────────────────────────────────────

@router.get("/flex/configs")
def list_configs(
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    configs = db.query(IBKRFlexConfig).all()
    return [_config_dict(c) for c in configs]


@router.post("/flex/configs", status_code=201)
def create_config(
    body: FlexConfigIn,
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    # Upsert by account_id
    existing = db.query(IBKRFlexConfig).filter_by(account_id=body.account_id).first()
    if existing:
        existing.query_id = body.query_id
        existing.token    = body.token
        existing.enabled  = body.enabled
        db.commit()
        return _config_dict(existing)

    cfg = IBKRFlexConfig(
        account_id=body.account_id,
        query_id=body.query_id,
        token=body.token,
        enabled=body.enabled,
    )
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return _config_dict(cfg)


@router.put("/flex/configs/{config_id}")
def update_config(
    config_id: int,
    body: FlexConfigUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    cfg = db.get(IBKRFlexConfig, config_id)
    if not cfg:
        raise HTTPException(404, "Config not found")
    if body.query_id is not None:
        cfg.query_id = body.query_id
    if body.token is not None:
        cfg.token = body.token
    if body.enabled is not None:
        cfg.enabled = body.enabled
    db.commit()
    return _config_dict(cfg)


@router.delete("/flex/configs/{config_id}", status_code=204)
def delete_config(
    config_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    cfg = db.get(IBKRFlexConfig, config_id)
    if not cfg:
        raise HTTPException(404, "Config not found")
    db.delete(cfg)
    db.commit()


# ── Sync ──────────────────────────────────────────────────────────────────────

# Reuse the background_jobs store from the prices router
from app.routers.prices import background_jobs  # noqa: E402


def _spawn_sync(job_name: str, account_ids: list[int]) -> dict:
    """Spawn a background sync job and return job metadata."""
    if background_jobs.is_running(job_name):
        running = [j for j in background_jobs.list_jobs()
                   if j["name"] == job_name and j["status"] == "running"]
        return {
            "job_id": running[0]["id"] if running else None,
            "status": "already_running",
            "already_running": True,
        }

    job_id = background_jobs.start_job(job_name)

    def _worker():
        from app.database import SessionLocal
        from app.services.ibkr_flex import sync_account
        db = SessionLocal()
        try:
            results = []
            for acct_id in account_ids:
                cfg = db.query(IBKRFlexConfig).filter_by(account_id=acct_id).first()
                if not cfg:
                    continue
                res = sync_account(db, cfg)
                results.append({"account_id": acct_id, **res})
            background_jobs.finish_job(job_id, {"results": results})
        except Exception as exc:
            logger.exception("IBKR Flex sync job %s failed", job_id)
            background_jobs.fail_job(job_id, str(exc) or type(exc).__name__)
        finally:
            db.close()

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.post("/flex/sync/{account_id}")
def sync_one(
    account_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    """
    Trigger a manual Flex Query sync for a single IBKR account.
    Returns immediately; poll GET /api/prices/jobs/{job_id} for status.
    """
    cfg = db.query(IBKRFlexConfig).filter_by(account_id=account_id).first()
    if not cfg:
        raise HTTPException(404, "No Flex Query config found for this account")
    return _spawn_sync(f"ibkr-flex-sync-{account_id}", [account_id])


@router.post("/flex/sync-all")
def sync_all(
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin),
):
    """Sync all enabled IBKR accounts at once."""
    configs = db.query(IBKRFlexConfig).filter_by(enabled=True).all()
    if not configs:
        return {"message": "No enabled IBKR Flex configs found", "started": False}
    ids = [c.account_id for c in configs]
    return _spawn_sync("ibkr-flex-sync-all", ids)
