"""
APScheduler — nightly IBKR Flex Query sync.

Runs once at 00:15 ET each night (05:15 UTC) so IBKR's Flex reports
are available for the previous trading day.
"""
from __future__ import annotations

import logging
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

_scheduler: Optional[AsyncIOScheduler] = None

# In-memory log of recent scheduled-job runs (most recent first), surfaced in Admin → System
# so the nightly jobs (IBKR Flex, Plaid, BOC FX, snapshot recompute/refresh) are visible
# without tailing container logs. Resets on restart.
_RUN_LOG: list[dict] = []
_RUN_LOG_MAX = 60


def _record(name: str, status: str, detail: str = "") -> None:
    from datetime import datetime, timezone
    _RUN_LOG.insert(0, {
        "name": name, "status": status, "detail": str(detail)[:300],
        "at": datetime.now(timezone.utc).isoformat(),
    })
    del _RUN_LOG[_RUN_LOG_MAX:]


def get_run_log() -> list[dict]:
    """Recent scheduled-job runs (most recent first)."""
    return list(_RUN_LOG)


def _logged(name: str, fn):
    """Wrap a job so its outcome (summary string or error) lands in the run log."""
    def wrapped():
        import time as _t
        t0 = _t.time()
        try:
            summary = fn()
            _record(name, "ok", f"{summary or 'done'} ({_t.time() - t0:.0f}s)")
        except Exception as exc:   # noqa: BLE001
            logger.exception("%s crashed", name)
            _record(name, "error", str(exc))
    return wrapped


def _run_nightly_ibkr_sync() -> str:
    """Sync all enabled IBKR Flex configs. Runs in the scheduler thread."""
    from app.database import SessionLocal
    from app.services.ibkr_flex import sync_all_configs

    db = SessionLocal()
    try:
        results = sync_all_configs(db)
        total = sum(r.get("imported", 0) for r in results)
        errors = [r for r in results if r.get("error")]
        for e in errors:
            logger.warning("  IBKR account_id=%s: %s", e["account_id"], e["error"])
        return f"{len(results)} account(s), {total} txn(s) imported, {len(errors)} error(s)"
    finally:
        db.close()


def _run_plaid_sync() -> str:
    """Re-sync every connected Plaid Item's holdings. Runs in the scheduler thread."""
    from app.database import SessionLocal
    from app.services import plaid_service as plaid
    from app.models.plaid import PlaidItem

    if not plaid.is_configured():
        return "skipped — Plaid not configured"
    db = SessionLocal()
    try:
        items = db.query(PlaidItem).all()
        ok = err = 0
        for item in items:
            try:
                plaid.sync_item(db, item)
                ok += 1
            except Exception as e:
                err += 1
                logger.warning("Plaid sync failed (item=%s): %s", item.item_id, e)
        return f"{ok} item(s) ok, {err} error(s)"
    finally:
        db.close()


def _run_nightly_fx_refresh() -> str:
    """Refresh Bank of Canada USD/CAD FX rates so valuation/conversions use current rates.
    fetch_boc_rates is async; run it on a fresh event loop in this scheduler thread."""
    import asyncio
    from app.database import SessionLocal
    from app.services import fx_service

    db = SessionLocal()
    try:
        added = asyncio.run(fx_service.fetch_boc_rates(db))
        return f"{added} BOC FX rate(s) added/updated"
    finally:
        db.close()


def _run_nightly_snapshot_recompute() -> str:
    """Rebuild the portfolio_snapshots table for ALL accounts so the Performance chart
    and returns reflect the latest transactions/prices without anyone clicking the manual
    Recompute button. Runs after the IBKR sync (new transactions) and before the view
    refresh (which aggregates this table)."""
    from app.database import SessionLocal
    from app.services.portfolio_history_service import compute_portfolio_snapshots

    db = SessionLocal()
    try:
        result = compute_portfolio_snapshots(db)
        return str(result)
    finally:
        db.close()


def _run_nightly_snapshot_refresh() -> str:
    """Refresh mv_snapshot_monthly after the snapshot recompute populates new rows."""
    from app.database import SessionLocal
    from app.services.snapshot_view_service import refresh_snapshot_views

    db = SessionLocal()
    try:
        result = refresh_snapshot_views(db)
        return str(result)
    finally:
        db.close()


def start_scheduler():
    global _scheduler
    if _scheduler is not None:
        return  # already started

    _scheduler = AsyncIOScheduler()

    # Bank of Canada USD/CAD FX rates first (05:05 UTC) so downstream valuation/conversion
    # uses fresh rates.
    _scheduler.add_job(
        _logged("BOC FX rate refresh", _run_nightly_fx_refresh),
        CronTrigger(hour=5, minute=5, timezone="UTC"),
        id="boc_fx_refresh",
        name="Nightly Bank of Canada FX refresh",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # 00:15 ET = 05:15 UTC (handles both EST and EDT conservatively)
    _scheduler.add_job(
        _logged("IBKR Flex sync", _run_nightly_ibkr_sync),
        CronTrigger(hour=5, minute=15, timezone="UTC"),
        id="ibkr_nightly_sync",
        name="Nightly IBKR Flex Query sync",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Rebuild the snapshot table 20 min after the IBKR sync, so the Performance chart picks
    # up the night's new transactions/prices automatically (no manual Recompute needed).
    _scheduler.add_job(
        _logged("Snapshot recompute", _run_nightly_snapshot_recompute),
        CronTrigger(hour=5, minute=35, timezone="UTC"),
        id="snapshot_recompute",
        name="Nightly portfolio_snapshots recompute",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Refresh the materialized view after the recompute finishes so report queries
    # (monthly returns, returns-detail) always see the freshly-rebuilt snapshots.
    _scheduler.add_job(
        _logged("Snapshot view refresh", _run_nightly_snapshot_refresh),
        CronTrigger(hour=6, minute=0, timezone="UTC"),
        id="snapshot_view_refresh",
        name="Nightly mv_snapshot_monthly refresh",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Plaid holdings sync — cadence via PLAID_SYNC_FREQUENCY (nightly|weekly|monthly|off).
    import os
    freq = os.environ.get("PLAID_SYNC_FREQUENCY", "nightly").strip().lower()
    plaid_trigger = {
        "nightly": CronTrigger(hour=5, minute=0, timezone="UTC"),              # 00:00 ET nightly
        "weekly":  CronTrigger(day_of_week="mon", hour=6, minute=0, timezone="UTC"),  # Monday
        "monthly": CronTrigger(day=1, hour=6, minute=0, timezone="UTC"),       # 1st of month
    }.get(freq)
    if plaid_trigger is not None:
        _scheduler.add_job(
            _logged("Plaid sync", _run_plaid_sync), plaid_trigger,
            id="plaid_sync", name=f"Plaid holdings sync ({freq})",
            replace_existing=True, misfire_grace_time=3600,
        )

    _scheduler.start()
    logger.info(
        "Scheduler started — BOC FX 00:05 ET, Plaid 00:00 ET, IBKR sync 00:15 ET, "
        "snapshot recompute 00:35 ET, view refresh 01:00 ET (Plaid: %s)",
        freq if plaid_trigger is not None else "off (manual only)",
    )


def get_jobs() -> list[dict]:
    """Configured jobs + their next scheduled run (UTC)."""
    if _scheduler is None:
        return []
    return [
        {"id": j.id, "name": j.name,
         "next_run": j.next_run_time.isoformat() if j.next_run_time else None}
        for j in _scheduler.get_jobs()
    ]


def run_all_now() -> None:
    """Run the full nightly batch now (FX → Plaid → IBKR → snapshot recompute → view
    refresh), recording each to the run log. Intended to be called in a background thread."""
    _logged("BOC FX rate refresh", _run_nightly_fx_refresh)()
    _logged("Plaid sync", _run_plaid_sync)()
    _logged("IBKR Flex sync", _run_nightly_ibkr_sync)()
    _logged("Snapshot recompute", _run_nightly_snapshot_recompute)()
    _logged("Snapshot view refresh", _run_nightly_snapshot_refresh)()


def stop_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
