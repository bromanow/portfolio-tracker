"""
Minimal SMTP email sender for operational alerts (e.g. the IBeam container going missing).

Entirely optional, matching the ibeam_control.py pattern: if SMTP_HOST or ADMIN_EMAIL aren't
set, send_admin_alert() is a safe no-op that just logs — nothing breaks, alerts are simply
disabled until configured.
"""
from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)

_SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
_SMTP_PORT = int(os.environ.get("SMTP_PORT", "587") or 587)
_SMTP_USER = os.environ.get("SMTP_USER", "").strip()
_SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "").strip()
_SMTP_FROM = os.environ.get("SMTP_FROM", "").strip() or _SMTP_USER
# Reuses the same ADMIN_EMAIL the app already seeds the admin login with — no extra env var.
_ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip()


def is_configured() -> bool:
    return bool(_SMTP_HOST and _SMTP_FROM and _ADMIN_EMAIL)


def send_alert(subject: str, body: str, to_email: str | None = None) -> bool:
    """Best-effort — logs and returns False on any failure, never raises into callers.
    Generic entry point (any subject/recipient); send_admin_alert below is a thin wrapper
    kept for existing callers. This app is single-user in practice, so to_email defaults
    to the same ADMIN_EMAIL rather than needing a full per-user mailing list."""
    recipient = to_email or _ADMIN_EMAIL
    if not (_SMTP_HOST and _SMTP_FROM and recipient):
        logger.warning("Email alert skipped (SMTP not configured): %s", subject)
        return False
    msg = EmailMessage()
    msg["Subject"] = f"[Portfolio Tracker] {subject}"
    msg["From"] = _SMTP_FROM
    msg["To"] = recipient
    msg.set_content(body)
    try:
        with smtplib.SMTP(_SMTP_HOST, _SMTP_PORT, timeout=15) as s:
            s.starttls()
            if _SMTP_USER:
                s.login(_SMTP_USER, _SMTP_PASSWORD)
            s.send_message(msg)
        logger.info("Email alert sent: %s", subject)
        return True
    except Exception as exc:   # noqa: BLE001 — alerting must never crash a caller
        logger.warning("Email alert failed (%s): %s", subject, exc)
        return False


def send_admin_alert(subject: str, body: str) -> bool:
    """Kept for existing callers (e.g. the IBeam-down check) — sends to ADMIN_EMAIL."""
    return send_alert(subject, body)
