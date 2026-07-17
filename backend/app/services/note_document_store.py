"""On-disk storage for uploaded structured-note info-sheet PDFs — mirrors
statement_store.py's pattern (local files on a persistent volume; metadata in the DB).

The whole backend/uploads/ tree is already a Coolify persistent volume in production (same
volume statement_store.py relies on), so this subfolder inherits persistence automatically —
no separate volume configuration needed. Override the location with the SECURITY_DOC_DIR env
var; default is <backend>/uploads/security_docs.
"""
from __future__ import annotations

import os
import re
import time

_BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
SECURITY_DOC_DIR = os.environ.get("SECURITY_DOC_DIR") or os.path.join(_BASE, "uploads", "security_docs")
os.makedirs(SECURITY_DOC_DIR, exist_ok=True)


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name or "note.pdf")


def stored_name(original_filename: str) -> str:
    """Collision-safe on-disk name: <epoch-ms>-<sanitized original>."""
    return f"{int(time.time() * 1000)}-{_sanitize(original_filename)}"


def path_for(stored_filename: str) -> str:
    return os.path.join(SECURITY_DOC_DIR, stored_filename)


def save(stored_filename: str, data: bytes) -> None:
    with open(path_for(stored_filename), "wb") as f:
        f.write(data)


def remove(stored_filename: str) -> None:
    try:
        os.remove(path_for(stored_filename))
    except OSError:
        pass
