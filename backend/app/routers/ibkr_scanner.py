"""
IBKR Market Scanner — a prototype research tool that queries IBKR's live server-side
scanner (the same engine behind TWS's own Scanner tool) via the IBeam Client Portal proxy,
instead of screening a fixed, manually-curated ticker universe like the Fundamental
Screener does. Trades a hard 50-row-per-scan cap and a preset-metric (not arbitrary-filter)
query model for a universe that never needs manual upkeep.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_current_user
from app.models.auth import User

router = APIRouter(prefix="/api/ibkr-scanner", tags=["ibkr-scanner"])


def _require_ibeam():
    from app.services import ibkr_service
    if not ibkr_service.is_ibeam_available():
        raise HTTPException(status_code=503, detail="IBeam is not connected — log in first.")


@router.get("/params")
def scanner_params(current_user: User = Depends(get_current_user)):
    """Every instrument class / scan code / filter field / location this account can scan."""
    _require_ibeam()
    from app.services import ibkr_service
    return ibkr_service.get_scanner_params()


class ScanFilter(BaseModel):
    code: str
    value: float


class ScanRequest(BaseModel):
    instrument: str
    location: str
    scan_code: str
    filters: list[ScanFilter] = []


@router.post("/run")
def scanner_run(req: ScanRequest, current_user: User = Depends(get_current_user)):
    _require_ibeam()
    from app.services import ibkr_service
    try:
        items = ibkr_service.run_scanner(
            req.instrument, req.location, req.scan_code,
            [f.model_dump() for f in req.filters],
        )
    except Exception as exc:   # noqa: BLE001 — surface IBKR's own error text to the UI
        raise HTTPException(status_code=502, detail=f"IBKR scanner request failed: {exc}")
    return {"items": items}
