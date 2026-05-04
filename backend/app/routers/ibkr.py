"""
IBKR Flex Query endpoints.

Any authenticated user:
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
    }
    if include_user and cfg.user:
        d["user_name"]  = cfg.user.name
        d["user_email"] = cfg.user.email
    return d


# ── Reuse background job store ─────────────────────────────────────────────────

from app.routers.prices import background_jobs  # noqa: E402


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


# ── Any user — own config ─────────────────────────────────────────────────────

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


@router.post("/flex/sync")
def sync_my_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Trigger a manual Flex sync for the current user's accounts."""
    cfg = db.query(IBKRFlexConfig).filter_by(user_id=current_user.id).first()
    if not cfg:
        raise HTTPException(404, "No Flex Query config found. Add one in Admin → IBKR Flex first.")
    if not cfg.enabled:
        raise HTTPException(400, "Flex config is disabled.")
    return _spawn_sync(f"ibkr-flex-sync-{current_user.id}", [current_user.id])


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
