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
from apscheduler.triggers.interval import IntervalTrigger

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


# Tracks whether we've already emailed about the current outage, so a multi-day IBeam
# outage sends one alert (not a fresh email every day) — reset on backend restart, which
# means a redeploy landing mid-outage can send at most one extra duplicate, which is fine.
_ibeam_down_alerted = False


def _ibeam_gateway_alive() -> Optional[bool]:
    """Best-effort probe of the IBeam gateway process itself (not just the Docker container).
    Catches the 'zombie' state where Docker says the container is running but IBeam's internal
    auth process has silently died. Returns True (reachable), False (process dead / connection
    refused), or None (can't tell — no base URL configured, or an auth-level response we
    shouldn't act on). We deliberately treat an unauthenticated-but-responding gateway as
    "alive" (None-ish → not a restart trigger): that needs a human 2FA, and restart-looping
    on it would just thrash."""
    import os
    base = os.environ.get("IBEAM_BASE_URL", "").rstrip("/")
    if not base:
        return None
    try:
        import requests, urllib3
        urllib3.disable_warnings()
        r = requests.get(f"{base}/v1/api/tickle", verify=False, timeout=8)
        # Any HTTP response (even 401/500) means the gateway process is up and listening.
        return True
    except Exception:
        # Connection refused / timeout / DNS → the gateway process is not answering.
        return False


def _run_ibeam_watchdog() -> str:
    """Watchdog: keep the IBeam container alive and auto-recover it.

    IBeam dies in a few ways — the docker 'restart: unless-stopped' policy only covers a
    hard crash, not these:
      • container stopped (was stopped between sessions) → gets pruned overnight if left
        stopped, so we START it back immediately;
      • container 'running' but the internal auth process is dead (zombie) → we RESTART it;
      • container pruned entirely / gateway up but not authenticated → can't fix without a
        redeploy or a human 2FA, so we escalate ONE email (deduped) and clear it on recovery.
    Runs every few minutes so a stopped container is revived long before the nightly
    docker-prune can delete it.
    """
    global _ibeam_down_alerted
    from app.services import ibeam_control, email_service

    if not ibeam_control.is_configured():
        return "skipped — ibeam-control not configured"

    status = ibeam_control.get_status()
    reachable = status is not None and "error" not in status
    cstatus = (status or {}).get("status") if reachable else None

    action = None
    if reachable and cstatus == "running":
        # Container is up — check the gateway process isn't a zombie.
        if _ibeam_gateway_alive() is False:
            ibeam_control.restart()
            action = "restarted zombie (container up, gateway dead)"
    elif reachable and cstatus in ("exited", "created", "paused", "dead", "restarting"):
        # Container exists but isn't serving — bring it back before the prune sweeps it.
        # 'dead'/'restarting' need a full stop+start; a plain start() is a no-op there.
        if cstatus in ("dead", "restarting"):
            ibeam_control.restart(); action = f"restarted (was {cstatus})"
        else:
            ibeam_control.start();   action = f"started (was {cstatus})"

    # Re-evaluate after any recovery attempt.
    if action:
        status = ibeam_control.get_status()
        reachable = status is not None and "error" not in status
        cstatus = (status or {}).get("status") if reachable else None

    healthy = reachable and cstatus == "running" and _ibeam_gateway_alive() is not False

    if healthy:
        if _ibeam_down_alerted:
            _ibeam_down_alerted = False
            email_service.send_admin_alert(
                "IBeam recovered",
                f"portfolio-ibeam is healthy again. status: {status}"
                + (f"\n\nWatchdog action: {action}" if action else ""),
            )
            return f"recovered{f' ({action})' if action else ''} — alert cleared"
        return f"ok — running{f' ({action})' if action else ''}"

    # Couldn't recover automatically.
    if not _ibeam_down_alerted:
        email_service.send_admin_alert(
            "IBeam is down and the watchdog could not auto-recover it",
            f"ibeam-control status: {status}\nWatchdog action attempted: {action or 'none'}\n\n"
            "If the container was pruned entirely, it needs a redeploy in Coolify "
            "(Portfolio project → portfolio-ibeam → Deploy). If the gateway is up but not "
            "authenticated, it needs a fresh IBKR login + 2FA on your phone — neither of "
            "which the watchdog can do unattended.\n\n"
            "One more email will follow when it's healthy again; no repeats meanwhile.",
        )
        _ibeam_down_alerted = True
        return f"ALERT emailed — unrecoverable (status={status}, action={action})"
    return f"still down (status={status}, action={action})"


def _run_weekly_fundamentals_refresh() -> str:
    """
    Refresh Yahoo fundamentals (dividend yield, beta, market cap, etc.) for all non-option
    securities, keeping MarketPrice.dividend_yield fresh for the Projected Income report.
    This calls yfinance's heavier ticker.info() per security (unlike the fast_info-based
    price refresh, which has no dividend-yield field at all) — deliberately weekly, not
    nightly, to avoid rate-limiting/slowing down the regular price refresh."""
    from app.database import SessionLocal
    from app.services.signals_service import refresh_fundamentals_all

    db = SessionLocal()
    try:
        result = refresh_fundamentals_all(db)
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


_COVERED_CALL_DTE_WARNING = 7   # matches the calendar UI's red "<7d" band


def _run_covered_call_alert_check() -> str:
    """Daily digest: any open covered-call leg within the DTE warning window or gone
    ITM (assignment risk), emailed to whichever users opted in (User.notify_covered_call_alerts).
    Reuses the exact same data source as the Expiry Calendar (get_open_legs_with_risk) so
    the two views can never disagree about what's "at risk". Sends once per day by nature
    of the cron cadence — no separate dedup flag needed (unlike the IBeam check, an ongoing
    risk is worth a daily reminder, not a one-time alert)."""
    from app.database import SessionLocal
    from app.models.auth import User
    from app.services import email_service
    from app.services.covered_call_portfolio_service import get_open_legs_with_risk

    db = SessionLocal()
    try:
        entries = get_open_legs_with_risk(db)
        flagged = [e for e in entries if e["dte"] <= _COVERED_CALL_DTE_WARNING or e["itm"]]
        if not flagged:
            return f"ok — 0/{len(entries)} legs need attention"

        recipients = db.query(User).filter(User.notify_covered_call_alerts == True).all()  # noqa: E712
        if not recipients:
            return f"{len(flagged)} legs flagged, but no user has notify_covered_call_alerts on"

        lines = []
        for e in sorted(flagged, key=lambda e: e["dte"]):
            risk = " — ITM (assignment risk)" if e["itm"] else ""
            lines.append(f"  {e['ticker']} ${e['strike']} exp {e['expiry_date']} ({e['dte']}d){risk} — {e['portfolio_name']}")
        body = (
            f"{len(flagged)} covered-call leg(s) need attention "
            f"(within {_COVERED_CALL_DTE_WARNING} days of expiry, or already ITM):\n\n"
            + "\n".join(lines)
        )

        sent = 0
        for user in recipients:
            if email_service.send_alert("Covered call alerts", body, to_email=user.email):
                sent += 1
        return f"{len(flagged)} legs flagged, emailed {sent}/{len(recipients)} users"
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

    # IBeam watchdog — every 10 minutes, keeps the container alive and auto-recovers it
    # (start if stopped, restart if the gateway process is a zombie), so a stopped container
    # is revived long before the nightly docker-prune can delete it.
    _scheduler.add_job(
        _logged("IBeam watchdog", _run_ibeam_watchdog),
        IntervalTrigger(minutes=10),
        id="ibeam_health_check",   # same id → replaces the old daily health-check job
        name="IBeam watchdog (auto-recover, every 10 min)",
        replace_existing=True,
        misfire_grace_time=300,
    )

    # Covered-call expiry/assignment-risk digest — after the nightly price refresh so
    # ITM checks use the day's fresh prices.
    _scheduler.add_job(
        _logged("Covered call alerts", _run_covered_call_alert_check),
        CronTrigger(hour=13, minute=30, timezone="UTC"),   # ~9:30am ET
        id="covered_call_alerts",
        name="Daily covered-call expiry/assignment-risk digest",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Fundamentals (dividend yield, beta, market cap) — weekly, not nightly, since it's a
    # much heavier per-security fetch than the regular price refresh (see docstring).
    _scheduler.add_job(
        _logged("Fundamentals refresh", _run_weekly_fundamentals_refresh),
        CronTrigger(day_of_week="sun", hour=5, minute=30, timezone="UTC"),
        id="weekly_fundamentals_refresh",
        name="Weekly fundamentals refresh (dividend yield, beta, market cap)",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    _scheduler.start()
    logger.info(
        "Scheduler started — BOC FX 00:05 ET, Plaid 00:00 ET, IBKR sync 00:15 ET, "
        "snapshot recompute 00:35 ET, view refresh 01:00 ET, IBeam watchdog every 10 min, "
        "fundamentals refresh Sun 01:30 ET (Plaid: %s)",
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
