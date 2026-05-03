from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.database import get_db

router = APIRouter(prefix="/api/system", tags=["system"])

DESIRED_INDEXES = [
    ("ix_transactions_account_id",        "CREATE INDEX IF NOT EXISTS ix_transactions_account_id ON transactions(account_id)"),
    ("ix_transactions_transaction_date",   "CREATE INDEX IF NOT EXISTS ix_transactions_transaction_date ON transactions(transaction_date)"),
    ("ix_transactions_security_id",        "CREATE INDEX IF NOT EXISTS ix_transactions_security_id ON transactions(security_id)"),
    ("ix_transactions_transaction_type",   "CREATE INDEX IF NOT EXISTS ix_transactions_transaction_type ON transactions(transaction_type)"),
    ("ix_transactions_account_date",       "CREATE INDEX IF NOT EXISTS ix_transactions_account_date ON transactions(account_id, transaction_date DESC)"),
    ("ix_raw_transactions_batch_id",       "CREATE INDEX IF NOT EXISTS ix_raw_transactions_batch_id ON raw_transactions(import_batch_id)"),
    ("ix_historical_prices_security_date", "CREATE INDEX IF NOT EXISTS ix_historical_prices_security_date ON historical_prices(security_id, price_date DESC)"),
    ("ix_option_contracts_security_id",    "CREATE INDEX IF NOT EXISTS ix_option_contracts_security_id ON option_contracts(security_id)"),
]


@router.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/db-stats")
def db_stats(db: Session = Depends(get_db)):
    tables = ["transactions", "raw_transactions", "historical_prices", "option_contracts",
              "securities", "accounts", "import_batches"]
    row_counts = {}
    for t in tables:
        try:
            result = db.execute(text(f"SELECT COUNT(*) FROM {t}"))
            row_counts[t] = result.scalar()
        except Exception:
            row_counts[t] = None

    # PostgreSQL index existence
    existing_indexes = {
        row[0] for row in db.execute(text(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
        ))
    }
    index_status = [
        {"name": name, "present": name in existing_indexes, "sql": sql}
        for name, sql in DESIRED_INDEXES
    ]

    # PostgreSQL database size
    size_result = db.execute(text(
        "SELECT pg_database_size(current_database())"
    )).scalar()
    size_mb = round(size_result / 1_048_576, 2) if size_result else None

    return {
        "row_counts":   row_counts,
        "index_status": index_status,
        "db_size_mb":   size_mb,
    }


@router.post("/db-optimize")
def db_optimize(db: Session = Depends(get_db)):
    existing_indexes = {
        row[0] for row in db.execute(text(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
        ))
    }

    created = []
    for name, sql in DESIRED_INDEXES:
        if name not in existing_indexes:
            db.execute(text(sql))
            created.append(name)

    db.execute(text("ANALYZE"))
    db.commit()

    return {
        "indexes_created": created,
        "analyzed": True,
        "message": f"Created {len(created)} index(es) and ran ANALYZE.",
    }


@router.post("/restart")
def restart():
    """No-op on cloud deployments — use the Render dashboard 'Manual Deploy' instead."""
    return {"message": "Restart not supported in cloud deployment. Use the Render dashboard."}
