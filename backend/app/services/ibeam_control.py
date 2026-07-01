"""
Client for the ibeam-control service — lets the backend start/stop/restart the IBeam
container so it only runs while someone is actually using the app (see ibeam-control/README.md
for the full rationale and deployment steps).

Entirely optional: if IBEAM_CONTROL_URL / IBEAM_CONTROL_TOKEN aren't set, every function here
is a safe no-op / reports "not configured" — IBeam then just runs continuously as it always
has, and none of this module does anything.
"""
from __future__ import annotations

import os
from typing import Optional

import httpx

_CONTROL_URL = os.environ.get("IBEAM_CONTROL_URL", "").rstrip("/")
_CONTROL_TOKEN = os.environ.get("IBEAM_CONTROL_TOKEN", "")
_TIMEOUT = 20


def is_configured() -> bool:
    return bool(_CONTROL_URL and _CONTROL_TOKEN)


def _call(method: str, path: str) -> Optional[dict]:
    if not is_configured():
        return None
    try:
        r = httpx.request(
            method, f"{_CONTROL_URL}{path}",
            headers={"X-Control-Token": _CONTROL_TOKEN},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()
    except Exception as exc:   # noqa: BLE001 — best-effort control plane, never raise into callers
        return {"error": f"{type(exc).__name__}: {exc}"}


def get_status() -> Optional[dict]:
    return _call("GET", "/status")


def start() -> Optional[dict]:
    return _call("POST", "/start")


def restart() -> Optional[dict]:
    """Force a full stop+start — use when the container is 'running' per Docker but IBeam's
    internal auth process has silently died (start() alone is a no-op in that state)."""
    return _call("POST", "/restart")


def stop() -> Optional[dict]:
    return _call("POST", "/stop")
