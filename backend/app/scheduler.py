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


def _run_plaid_sync():
    """Re-sync every connected Plaid Item's holdings. Runs in the scheduler thread."""
    from app.database import SessionLocal
    from app.services import plaid_service as plaid
    from app.models.plaid import PlaidItem

    if not plaid.is_configured():
        logger.info("Plaid sync skipped — Plaid not configured")
        return
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
        logger.info("Plaid sync complete: %d item(s) ok, %d error(s)", ok, err)
    except Exception:
        logger.exception("Plaid sync crashed")
    finally:
        db.close()


def _run_nightly_snapshot_recompute():
    """Rebuild the portfolio_snapshots table for ALL accounts so the Performance chart
    and returns reflect the latest transactions/prices without anyone clicking the manual
    Recompute button. Runs after the IBKR sync (new transactions) and before the view
    refresh (which aggregates this table)."""
    from app.database import SessionLocal
    from app.services.portfolio_history_service import compute_portfolio_snapshots

    db = SessionLocal()
    try:
        result = compute_portfolio_snapshots(db)
        logger.info("Nightly snapshot recompute: %s", result)
    except Exception:
        logger.exception("Nightly snapshot recompute crashed")
    finally:
        db.close()


def _run_nightly_snapshot_refresh():
    """Refresh mv_snapshot_monthly after the snapshot recompute populates new rows."""
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

    # Rebuild the snapshot table 20 min after the IBKR sync, so the Performance chart picks
    # up the night's new transactions/prices automatically (no manual Recompute needed).
    _scheduler.add_job(
        _run_nightly_snapshot_recompute,
        CronTrigger(hour=5, minute=35, timezone="UTC"),
        id="snapshot_recompute",
        name="Nightly portfolio_snapshots recompute",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Refresh the materialized view after the recompute finishes so report queries
    # (monthly returns, returns-detail) always see the freshly-rebuilt snapshots.
    _scheduler.add_job(
        _run_nightly_snapshot_refresh,
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
            _run_plaid_sync, plaid_trigger,
            id="plaid_sync", name=f"Plaid holdings sync ({freq})",
            replace_existing=True, misfire_grace_time=3600,
        )

    _scheduler.start()
    logger.info(
        "Scheduler started — IBKR sync 00:15 ET, snapshot recompute 00:35 ET, "
        "view refresh 01:00 ET, Plaid sync: %s",
        freq if plaid_trigger is not None else "off (manual only)",
    )


def stop_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
