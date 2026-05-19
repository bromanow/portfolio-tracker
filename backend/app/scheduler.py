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


def _run_nightly_ibkr_sync():
    """Sync all enabled IBKR Flex configs. Runs in the scheduler thread."""
    from app.database import SessionLocal
    from app.services.ibkr_flex import sync_all_configs

    db = SessionLocal()
    try:
        results = sync_all_configs(db)
        total = sum(r.get("imported", 0) for r in results)
        errors = [r for r in results if r.get("error")]
        logger.info(
            "Nightly IBKR sync complete: %d account(s), %d transaction(s) imported, %d error(s)",
            len(results), total, len(errors),
        )
        if errors:
            for e in errors:
                logger.warning("  account_id=%s: %s", e["account_id"], e["error"])
    except Exception:
        logger.exception("Nightly IBKR sync crashed")
    finally:
        db.close()


def _run_nightly_snapshot_refresh():
    """Refresh mv_snapshot_monthly after the IBKR sync populates new transactions."""
    from app.database import SessionLocal
    from app.services.snapshot_view_service import refresh_snapshot_views

    db = SessionLocal()
    try:
        result = refresh_snapshot_views(db)
        logger.info("Nightly snapshot view refresh: %s", result)
    except Exception:
        logger.exception("Nightly snapshot view refresh crashed")
    finally:
        db.close()


def start_scheduler():
    global _scheduler
    if _scheduler is not None:
        return  # already started

    _scheduler = AsyncIOScheduler()

    # 00:15 ET = 05:15 UTC (handles both EST and EDT conservatively)
    _scheduler.add_job(
        _run_nightly_ibkr_sync,
        CronTrigger(hour=5, minute=15, timezone="UTC"),
        id="ibkr_nightly_sync",
        name="Nightly IBKR Flex Query sync",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Refresh the materialized view 30 min after the IBKR sync finishes
    # so report queries always see current data.
    _scheduler.add_job(
        _run_nightly_snapshot_refresh,
        CronTrigger(hour=5, minute=45, timezone="UTC"),
        id="snapshot_view_refresh",
        name="Nightly mv_snapshot_monthly refresh",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    _scheduler.start()
    logger.info(
        "Scheduler started — IBKR sync at 00:15 ET, snapshot view refresh at 00:45 ET"
    )


def stop_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
