import logging
import os

from dotenv import load_dotenv
load_dotenv()  # loads backend/.env when running locally; no-op in production

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import engine, Base
# Import all models so SQLAlchemy registers them before create_all
import app.models.master       # noqa
import app.models.transactions # noqa
import app.models.options      # noqa
import app.models.imports      # noqa
import app.models.prices       # noqa
import app.models.auth         # noqa
import app.models.clients      # noqa
import app.models.ibkr         # noqa
import app.models.scanner      # noqa
import app.models.plaid        # noqa

from app.dependencies import get_current_user
from app.routers import auth as auth_router
from app.routers import imports, transactions, accounts, securities, portfolio, admin
from app.routers import prices as prices_router
from app.routers import system as system_router
from app.routers import ibkr as ibkr_router
from app.routers import clients as clients_router
from app.routers import scanner as scanner_router
from app.routers import plaid as plaid_router
from app.routers import data_health as data_health_router
from app.routers import expired_options as expired_options_router

log = logging.getLogger(__name__)

app = FastAPI(
    title="Portfolio Tracker API",
    description="Investment portfolio tracker for Scotia iTrade and Interactive Brokers",
    version="1.0.0",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
_extra_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
_cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"] + _extra_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Startup ───────────────────────────────────────────────────────────────────

def _migrate_clients(eng):
    """
    Seed the clients table from distinct accounts.owner values,
    then populate accounts.client_id from the matching client.
    Also links the admin user to all clients via user_clients.
    Idempotent — safe to run on every startup.
    """
    from sqlalchemy import text
    with eng.connect() as conn:
        # 1. Collect distinct owner values from accounts
        rows = conn.execute(text("SELECT DISTINCT owner FROM accounts WHERE owner IS NOT NULL ORDER BY owner")).fetchall()
        owners = [r[0] for r in rows]

        for owner in owners:
            slug = owner.lower().replace(" ", "-")
            # Insert client if not already present
            existing = conn.execute(
                text("SELECT id FROM clients WHERE name = :name"),
                {"name": owner},
            ).fetchone()
            if not existing:
                conn.execute(
                    text("INSERT INTO clients (name, slug, active, created_at) VALUES (:name, :slug, true, CURRENT_TIMESTAMP)"),
                    {"name": owner, "slug": slug},
                )
                conn.commit()
                log.info("Created client: %s (%s)", owner, slug)

        # 2. Set accounts.client_id where still NULL (subquery form works on SQLite + PG)
        conn.execute(text("""
            UPDATE accounts
            SET client_id = (
                SELECT id FROM clients WHERE clients.name = accounts.owner
            )
            WHERE client_id IS NULL
        """))
        conn.commit()

        # 3. Link admin users to all clients via user_clients (if not already linked)
        admin_users = conn.execute(
            text("SELECT id FROM users WHERE role = 'admin'")
        ).fetchall()
        all_clients = conn.execute(text("SELECT id FROM clients")).fetchall()

        for (user_id,) in admin_users:
            for (client_id,) in all_clients:
                existing_link = conn.execute(
                    text("SELECT 1 FROM user_clients WHERE user_id = :u AND client_id = :c"),
                    {"u": user_id, "c": client_id},
                ).fetchone()
                if not existing_link:
                    conn.execute(
                        text("INSERT INTO user_clients (user_id, client_id, role) VALUES (:u, :c, 'admin')"),
                        {"u": user_id, "c": client_id},
                    )
            conn.commit()


def _run_migrations(eng):
    """Apply missing columns that create_all won't add to existing tables."""
    from sqlalchemy import inspect, text
    inspector = inspect(eng)

    # ibkr_flex_configs was initially created with account_id FK; redesigned to
    # user_id FK. Drop and recreate if the old schema is still present.
    existing_tables = inspector.get_table_names()
    if "ibkr_flex_configs" in existing_tables:
        old_cols = [c["name"] for c in inspector.get_columns("ibkr_flex_configs")]
        if "account_id" in old_cols:
            with eng.connect() as conn:
                conn.execute(text("DROP TABLE ibkr_flex_configs"))
                conn.commit()
            log.info("Migration: dropped old ibkr_flex_configs (account_id → user_id redesign)")
            # create_all below will recreate it with the new schema
            from app.database import Base
            from app.models.ibkr import IBKRFlexConfig  # ensure registered
            Base.metadata.tables["ibkr_flex_configs"].create(bind=eng)

    pending = [
        ("securities",       "fetch_ticker_override",  "VARCHAR(50)"),
        ("securities",       "description",             "TEXT"),
        ("brokerages",       "advisor",                 "VARCHAR(100)"),
        ("accounts",         "ibkr_alias",              "VARCHAR(100)"),
        ("market_prices",    "beta",                    "REAL"),
        ("market_prices",    "dividend_yield",          "REAL"),
        ("market_prices",    "market_cap",              "REAL"),
        ("accounts",         "client_id",               "INTEGER REFERENCES clients(id)"),
        ("transactions",     "external_ref",            "VARCHAR(100)"),
        # Phase 2 scanner columns — Greeks from IBKR live data
        ("scanner_results",  "delta",                   "FLOAT"),
        ("scanner_results",  "gamma",                   "FLOAT"),
        ("scanner_results",  "theta",                   "FLOAT"),
        ("scanner_results",  "vega",                    "FLOAT"),
        ("scanner_results",  "bid_ask_spread_pct",      "FLOAT"),
        ("scanner_results",  "data_source",             "VARCHAR(20)"),
        ("scanner_results",  "recommendation",          "VARCHAR(10)"),
        ("scanner_results",  "dividend_yield",           "FLOAT"),
        ("ibkr_flex_configs", "last_sync_details",        "TEXT"),
    ]
    with eng.connect() as conn:
        for table, col, col_type in pending:
            existing = [c["name"] for c in inspector.get_columns(table)]
            if col not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
                conn.commit()
                log.info("Migration applied: added %s.%s", table, col)


def _create_admin_user():
    """Create the initial admin user if the users table is empty."""
    from app.database import SessionLocal
    from app.models.auth import User
    from app.services.auth_service import hash_password

    email    = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    password = os.environ.get("ADMIN_PASSWORD", "").strip()
    name     = os.environ.get("ADMIN_NAME", "Admin").strip()

    if not email or not password:
        log.warning("ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin user creation")
        return

    db = SessionLocal()
    try:
        if db.query(User).count() == 0:
            db.add(User(
                email=email,
                hashed_password=hash_password(password),
                name=name,
                role="admin",
                is_active=True,
            ))
            db.commit()
            log.info("Created initial admin user: %s", email)
    finally:
        db.close()


@app.on_event("startup")
async def startup():
    Base.metadata.create_all(bind=engine)
    _run_migrations(engine)
    _create_admin_user()
    _migrate_clients(engine)  # must run after admin user exists

    # Create mv_snapshot_monthly (materialized view on PG, regular view on SQLite)
    from app.services.snapshot_view_service import create_snapshot_views
    create_snapshot_views(engine)

    # Start nightly IBKR Flex Query scheduler
    from app.scheduler import start_scheduler
    start_scheduler()

    # Auto-refresh BOC FX rates if stale
    try:
        from datetime import date as _date, timedelta
        from app.database import SessionLocal
        from app.models.master import FXRate
        from app.services.fx_service import fetch_boc_rates
        db = SessionLocal()
        try:
            latest = db.query(FXRate).order_by(FXRate.rate_date.desc()).first()
            if latest is None or (_date.today() - latest.rate_date) > timedelta(days=3):
                log.info("BOC FX rates stale — auto-refreshing on startup")
                await fetch_boc_rates(db)
        finally:
            db.close()
    except Exception as exc:
        log.warning("BOC FX auto-refresh failed: %s", exc)


@app.on_event("shutdown")
async def shutdown():
    from app.scheduler import stop_scheduler
    stop_scheduler()


# ── Routes ────────────────────────────────────────────────────────────────────
# Auth routes are public (no token required)
app.include_router(auth_router.router)

# All other routes require a valid JWT
_auth = [Depends(get_current_user)]
app.include_router(imports.router,        dependencies=_auth)
app.include_router(transactions.router,   dependencies=_auth)
app.include_router(accounts.router,       dependencies=_auth)
app.include_router(securities.router,     dependencies=_auth)
app.include_router(portfolio.router,      dependencies=_auth)
app.include_router(admin.router,          dependencies=_auth)
app.include_router(prices_router.router,  dependencies=_auth)
app.include_router(system_router.router,  dependencies=_auth)
app.include_router(ibkr_router.router,    dependencies=_auth)
app.include_router(clients_router.router, dependencies=_auth)
app.include_router(scanner_router.router, dependencies=_auth)
app.include_router(plaid_router.router,   dependencies=_auth)
app.include_router(data_health_router.router, dependencies=_auth)
app.include_router(expired_options_router.router, dependencies=_auth)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "portfolio-tracker"}


@app.get("/api/ibeam-debug")
def ibeam_debug():
    """Public debug endpoint — shows IBeam connectivity details."""
    import os, httpx, time as _time

    def _parse(r):
        """Return JSON body if possible, otherwise raw text — never crashes."""
        try:
            return r.json()
        except Exception:
            return r.text[:500] or "(empty response)"

    base = os.environ.get("IBEAM_BASE_URL", "")
    if not base:
        return {"error": "IBEAM_BASE_URL not set", "base": ""}
    results = {"base": base}
    try:
        # 1. Check auth status
        r = httpx.get(f"{base}/v1/api/iserver/auth/status", verify=False, timeout=15)
        results["auth_status"] = {"status_code": r.status_code, "body": _parse(r)}

        # 2. SSO validate
        r2 = httpx.get(f"{base}/v1/api/sso/validate", verify=False, timeout=15)
        results["sso_validate"] = {"status_code": r2.status_code, "body": _parse(r2)}

        # 3. Reauthenticate
        r3 = httpx.post(f"{base}/v1/api/iserver/reauthenticate", verify=False, timeout=15)
        results["reauthenticate"] = {"status_code": r3.status_code, "body": _parse(r3)}

        # 4. Auth status after reauth
        _time.sleep(3)
        r4 = httpx.get(f"{base}/v1/api/iserver/auth/status", verify=False, timeout=15)
        results["auth_status_after_reauth"] = {"status_code": r4.status_code, "body": _parse(r4)}

    except Exception as exc:
        results["error"] = str(exc)
        results["error_type"] = type(exc).__name__
    return results
