import logging
import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

logger = logging.getLogger(__name__)

# Connection string can be overridden via environment variable.
# Locally defaults to the portfolio_tracker database on the local PostgreSQL server.
# On a cloud host, set DATABASE_URL to the managed PostgreSQL connection string.
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://Mini@localhost/portfolio_tracker",
)

engine = create_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,   # drops stale connections automatically
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# ── Guard: never persist a price dated in the future ─────────────────────────
# A bad upstream fetch once wrote a historical_prices row dated weeks ahead (an expired
# option), which pinned the snapshot freshness check to "stale" forever (snapshots only
# build up to today, so they can never catch a future-dated price). This drops any pending
# price-table row whose price_date is after today — across every ORM write path — and logs
# it, rather than aborting the whole batch. Matched by table name to avoid importing the
# price models here (circular import). Core inserts that bypass the ORM are guarded inline.
_PRICE_TABLES = {"historical_prices", "market_prices"}


@event.listens_for(SessionLocal, "before_flush")
def _drop_future_dated_prices(session, flush_context, instances):
    from datetime import date as _date, datetime as _dt
    today = _date.today()
    for obj in list(session.new):
        if getattr(obj, "__tablename__", None) not in _PRICE_TABLES:
            continue
        pd = getattr(obj, "price_date", None)
        if pd is None:
            continue
        if isinstance(pd, _dt):
            pd = pd.date()
        if pd > today:
            logger.warning(
                "Skipping future-dated price row (%s) security_id=%s date=%s",
                obj.__tablename__, getattr(obj, "security_id", "?"), pd,
            )
            session.expunge(obj)


# ── Guard: apply per-(security, account) transaction-type overrides on import ─
# See SecurityAccountTypeOverride (app/models/master.py) for the full rationale. Runs on
# every newly-inserted Transaction across ALL import paths (CSV, IBKR Flex, Plaid,
# statements, manual create) — forward-looking only, does not touch already-persisted rows
# (session.dirty), so it never fights a manual edit made after the fact.
@event.listens_for(SessionLocal, "before_flush")
def _apply_type_overrides(session, flush_context, instances):
    txns = [
        o for o in session.new
        if getattr(o, "__tablename__", None) == "transactions"
        and getattr(o, "security_id", None) and getattr(o, "account_id", None)
    ]
    if not txns:
        return
    from app.models.master import SecurityAccountTypeOverride
    sec_ids = {t.security_id for t in txns}
    acct_ids = {t.account_id for t in txns}
    rules = (
        session.query(SecurityAccountTypeOverride)
        .filter(
            SecurityAccountTypeOverride.security_id.in_(sec_ids),
            SecurityAccountTypeOverride.account_id.in_(acct_ids),
        )
        .all()
    )
    if not rules:
        return
    rule_map = {(r.security_id, r.account_id, r.from_type): r.to_type for r in rules}
    for t in txns:
        new_type = rule_map.get((t.security_id, t.account_id, t.transaction_type))
        if new_type:
            t.transaction_type = new_type


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
