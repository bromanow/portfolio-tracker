"""IBeam container control — Admin → Connections → IBeam.

Combines the container-lifecycle view (via ibeam_control, the scoped Docker control service)
with the auth-status view (ibkr_service.is_ibeam_available, the existing Client Portal check)
into one status payload, and exposes start/restart/stop.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.dependencies import get_current_user
from app.models.auth import User
from app.services import ibeam_control
from app.services import ibkr_service

router = APIRouter(prefix="/api/ibeam", tags=["ibeam-control"])


@router.get("/status")
def status(current_user: User = Depends(get_current_user)):
    return {
        "configured": ibeam_control.is_configured(),
        "container": ibeam_control.get_status(),
        "authenticated": ibkr_service.is_ibeam_available(),
    }


@router.post("/start")
def start(current_user: User = Depends(get_current_user)):
    return {"result": ibeam_control.start()}


@router.post("/restart")
def restart(current_user: User = Depends(get_current_user)):
    return {"result": ibeam_control.restart()}


@router.post("/stop")
def stop(current_user: User = Depends(get_current_user)):
    return {"result": ibeam_control.stop()}
