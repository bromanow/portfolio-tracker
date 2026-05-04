import logging
import os

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

from app.dependencies import get_current_user
from app.routers import auth as auth_router
from app.routers import imports, transactions, accounts, securities, portfolio, admin
from app.routers import prices as prices_router
from app.routers import system as system_router
from app.routers import ibkr as ibkr_router
from app.routers import clients as clients_router

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
    pending = [
        ("securities",    "fetch_ticker_override", "VARCHAR(50)"),
        ("securities",    "description",           "TEXT"),
        ("brokerages",    "advisor",               "VARCHAR(100)"),
        ("accounts",      "ibkr_alias",            "VARCHAR(100)"),
        ("market_prices", "beta",                  "REAL"),
        ("market_prices", "dividend_yield",        "REAL"),
        ("market_prices", "market_cap",            "REAL"),
        ("accounts",      "client_id",             "INTEGER REFERENCES clients(id)"),
        ("transactions",  "external_ref",           "VARCHAR(100)"),
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


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "portfolio-tracker"}
