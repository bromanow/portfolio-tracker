import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import engine, Base
# Import all models to ensure they are registered with SQLAlchemy
import app.models.master  # noqa
import app.models.transactions  # noqa
import app.models.options  # noqa
import app.models.imports  # noqa
import app.models.prices  # noqa

from app.routers import imports, transactions, accounts, securities, portfolio, admin
from app.routers import prices as prices_router
from app.routers import system as system_router
from app.routers import ibkr as ibkr_router

app = FastAPI(
    title="Portfolio Tracker API",
    description="Investment portfolio tracker for Scotia iTrade and Interactive Brokers",
    version="1.0.0",
)

# Build CORS origin list: always include local dev servers, plus any extra origins
# supplied via ALLOWED_ORIGINS (comma-separated) for the deployed frontend.
_extra_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
_cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"] + _extra_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _run_migrations(eng):
    """
    Apply any missing column additions that SQLAlchemy's create_all won't handle
    (create_all only creates missing *tables*, not missing *columns* on existing tables).
    Safe to run on every startup — each ALTER is skipped if the column already exists.
    """
    import logging
    from sqlalchemy import inspect, text
    log = logging.getLogger(__name__)
    inspector = inspect(eng)

    pending: list[tuple[str, str, str]] = [
        # (table, column, sql_type)
        ("securities", "fetch_ticker_override", "VARCHAR(50)"),
        ("securities", "description", "TEXT"),
        ("brokerages", "advisor", "VARCHAR(100)"),
        ("accounts", "ibkr_alias", "VARCHAR(100)"),
        ("market_prices", "beta", "REAL"),
        ("market_prices", "dividend_yield", "REAL"),
        ("market_prices", "market_cap", "REAL"),
    ]

    with eng.connect() as conn:
        for table, col, col_type in pending:
            existing = [c["name"] for c in inspector.get_columns(table)]
            if col not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
                conn.commit()
                log.info("Migration applied: added %s.%s", table, col)


# Create tables on startup + run lightweight migrations + auto-refresh stale BOC FX rates
@app.on_event("startup")
async def startup():
    Base.metadata.create_all(bind=engine)
    _run_migrations(engine)
    # Auto-refresh BOC FX rates if last rate is stale (> 3 days old)
    try:
        from datetime import date as _date, timedelta
        from app.database import SessionLocal
        from app.models.master import FXRate
        from app.services.fx_service import fetch_boc_rates
        db = SessionLocal()
        try:
            latest = db.query(FXRate).order_by(FXRate.rate_date.desc()).first()
            if latest is None or (_date.today() - latest.rate_date) > timedelta(days=3):
                import logging
                logging.getLogger(__name__).info("BOC FX rates are stale — auto-refreshing on startup")
                await fetch_boc_rates(db)
        finally:
            db.close()
    except Exception as _e:
        import logging
        logging.getLogger(__name__).warning("BOC FX auto-refresh failed: %s", _e)

app.include_router(imports.router)
app.include_router(transactions.router)
app.include_router(accounts.router)
app.include_router(securities.router)
app.include_router(portfolio.router)
app.include_router(admin.router)
app.include_router(prices_router.router)
app.include_router(system_router.router)
app.include_router(ibkr_router.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "portfolio-tracker"}
