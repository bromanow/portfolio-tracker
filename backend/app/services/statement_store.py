"""On-disk storage for uploaded statement PDFs — mirrors the CRE app's brokerage
report storage (local files on a persistent volume; metadata lives in the DB).

In production the directory MUST be a Coolify persistent volume, otherwise files are
lost on every redeploy (the container filesystem is ephemeral). Override the location
with the STATEMENT_DIR env var; default is <backend>/uploads/statements.
"""
from __future__ import annotations

import os
import re
import time

_BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
STATEMENT_DIR = os.environ.get("STATEMENT_DIR") or os.path.join(_BASE, "uploads", "statements")
os.makedirs(STATEMENT_DIR, exist_ok=True)


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name or "statement.pdf")


def stored_name(original_filename: str) -> str:
    """Collision-safe on-disk name: <epoch-ms>-<sanitized original>."""
    return f"{int(time.time() * 1000)}-{_sanitize(original_filename)}"


def path_for(stored_filename: str) -> str:
    return os.path.join(STATEMENT_DIR, stored_filename)


def save(stored_filename: str, data: bytes) -> None:
    with open(path_for(stored_filename), "wb") as f:
        f.write(data)


def remove(stored_filename: str) -> None:
    try:
        os.remove(path_for(stored_filename))
    except OSError:
        pass
