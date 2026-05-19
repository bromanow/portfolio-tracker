"""
Materialized view service: mv_snapshot_monthly
===============================================
Pre-aggregates portfolio_snapshots to one row per (account, month) — the last
snapshot within that month — with account name, type and brokerage pre-joined.

On **PostgreSQL** (production): a true MATERIALIZED VIEW backed by a unique
index, refreshed nightly via REFRESH MATERIALIZED VIEW CONCURRENTLY.

On **SQLite** (local dev): a regular VIEW (always live, no refresh needed).

Why this matters
----------------
Monthly-returns and returns-detail used to load *every* daily snapshot for
every account (potentially 30 rows/month × accounts × years) into Python
and then reduce them with _snap_at_date lookups.  The view drops that to one
row per account per month — roughly 30× fewer rows — so the heavy Python-side
grouping/sorting is dramatically cheaper.

Public API
----------
  create_snapshot_views(engine)    -- idempotent; call once at startup
  refresh_snapshot_views(session)  -- REFRESH MATERIALIZED VIEW (PG only)
  view_row_count(session) -> int   -- returns row count; 0 = empty / not built
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.engine import Engine
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

VIEW_NAME = "mv_snapshot_monthly"

# ── PostgreSQL DDL ────────────────────────────────────────────────────────────
# Uses a window function to pick the LAST snapshot date within each
# (account_id, calendar-month) partition, then joins account metadata.
# WITH DATA materialises immediately so it's queryable right away.

_PG_VIEW_DDL = """\
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_snapshot_monthly AS
WITH ranked AS (
    SELECT
        s.account_id,
        date_trunc('month', s.snapshot_date)::date  AS month_start,
        s.market_value_cad,
        s.cash_balance_cad,
        s.invested_cad,
        s.income_cad,
        s.priced_fraction,
        s.snapshot_date                             AS actual_snapshot_date,
        ROW_NUMBER() OVER (
            PARTITION BY s.account_id,
                         date_trunc('month', s.snapshot_date)
            ORDER BY s.snapshot_date DESC
        )                                           AS rn
    FROM portfolio_snapshots s
)
SELECT
    r.month_start,
    r.account_id,
    a.name          AS account_name,
    a.account_type,
    b.name          AS brokerage_name,
    r.market_value_cad,
    r.cash_balance_cad,
    r.invested_cad,
    r.income_cad,
    r.priced_fraction,
    r.actual_snapshot_date
FROM ranked r
JOIN accounts   a ON a.id = r.account_id
JOIN brokerages b ON b.id = a.brokerage_id
WHERE r.rn = 1
WITH DATA
"""

# Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY
_PG_INDEX_DDL = """\
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_snapshot_monthly
    ON mv_snapshot_monthly (month_start, account_id)
"""

# ── SQLite DDL ────────────────────────────────────────────────────────────────
# Regular (non-materialised) view — always reflects the current data.
# Uses a correlated subquery to get the last snapshot per (account, month).

_SQLITE_VIEW_DDL = """\
CREATE VIEW IF NOT EXISTS mv_snapshot_monthly AS
SELECT
    date(s.snapshot_date, 'start of month') AS month_start,
    s.account_id,
    a.name          AS account_name,
    a.account_type,
    b.name          AS brokerage_name,
    s.market_value_cad,
    s.cash_balance_cad,
    s.invested_cad,
    s.income_cad,
    s.priced_fraction,
    s.snapshot_date AS actual_snapshot_date
FROM portfolio_snapshots s
JOIN accounts   a ON a.id = s.account_id
JOIN brokerages b ON b.id = a.brokerage_id
WHERE s.snapshot_date = (
    SELECT MAX(s2.snapshot_date)
    FROM   portfolio_snapshots s2
    WHERE  s2.account_id = s.account_id
      AND  strftime('%Y-%m', s2.snapshot_date)
         = strftime('%Y-%m', s.snapshot_date)
)
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_postgres(engine: "Engine") -> bool:
    return engine.dialect.name == "postgresql"


def _drop_view_if_exists(engine: "Engine") -> None:
    """Drop the view/materialized view so it can be recreated with new DDL."""
    is_pg = _is_postgres(engine)
    drop_sql = (
        "DROP MATERIALIZED VIEW IF EXISTS mv_snapshot_monthly"
        if is_pg
        else "DROP VIEW IF EXISTS mv_snapshot_monthly"
    )
    with engine.connect() as conn:
        conn.execute(text(drop_sql))
        conn.commit()


# ── Public API ────────────────────────────────────────────────────────────────

def create_snapshot_views(engine: "Engine") -> None:
    """
    Create mv_snapshot_monthly if it doesn't exist.
    Idempotent — safe to call on every application startup.
    """
    is_pg = _is_postgres(engine)
    try:
        with engine.connect() as conn:
            if is_pg:
                conn.execute(text(_PG_VIEW_DDL))
                conn.commit()
                conn.execute(text(_PG_INDEX_DDL))
                conn.commit()
                logger.info("mv_snapshot_monthly: PostgreSQL materialized view ready")
            else:
                conn.execute(text(_SQLITE_VIEW_DDL))
                conn.commit()
                logger.info("mv_snapshot_monthly: SQLite view ready")
    except Exception as exc:
        # Non-fatal — views are an optimisation; endpoints fall back to raw table
        logger.warning("Could not create mv_snapshot_monthly: %s", exc)


def refresh_snapshot_views(db: "Session") -> dict:
    """
    Refresh the materialized view with the latest snapshot data.

    PostgreSQL: REFRESH MATERIALIZED VIEW CONCURRENTLY (non-blocking reads).
    SQLite:     no-op — the regular VIEW is always live.

    Returns a status dict suitable for an API response.
    """
    engine = db.get_bind()
    if not _is_postgres(engine):
        return {"status": "skipped", "reason": "SQLite view is always live — no refresh needed"}

    try:
        db.execute(text("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_snapshot_monthly"))
        db.commit()
        row = db.execute(text("SELECT COUNT(*) FROM mv_snapshot_monthly")).scalar()
        logger.info("mv_snapshot_monthly refreshed: %d rows", row or 0)
        return {"status": "ok", "rows": row or 0}
    except Exception as exc:
        logger.error("mv_snapshot_monthly refresh failed: %s", exc)
        db.rollback()
        return {"status": "error", "detail": str(exc)}


def view_row_count(db: "Session") -> int:
    """Return the number of rows in the view; 0 means empty or unavailable."""
    try:
        return db.execute(text("SELECT COUNT(*) FROM mv_snapshot_monthly")).scalar() or 0
    except Exception:
        return 0
