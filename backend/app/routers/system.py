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


@router.post("/fix-ibkr-fx-trades")
def fix_ibkr_fx_trades(db: Session = Depends(get_db)):
    """
    Remove Flex-imported FX conversion trade records (e.g. USD.CAD) that were
    incorrectly stored as cash transactions.  These represent IBKR's internal
    currency settlement and are already captured in the net CAD amount of the
    underlying trade.  Idempotent.
    """
    result = db.execute(text("""
        DELETE FROM transactions
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND id IN (
            SELECT t.id FROM transactions t
            JOIN securities s ON s.id = t.security_id
            WHERE s.ticker ~ '^[A-Z]{3}\\.[A-Z]{3}$'
          )
    """))
    db.commit()
    return {
        "fx_trades_deleted": result.rowcount,
        "message": "FX conversion trade records removed.",
    }


@router.post("/fix-ibkr-commission-amounts")
def fix_ibkr_commission_amounts(db: Session = Depends(get_db)):
    """
    One-time migration: Flex-imported trades stored commission separately but
    transaction_amount only captured tradeMoney (gross, pre-commission).
    This subtracts the stored commission so transaction_amount reflects the
    true net cash flow, matching what the CSV 'Net Amount' column reports.
    Safe to run multiple times — only affects rows where commission != 0.
    """
    amt_result = db.execute(text("""
        UPDATE transactions
        SET transaction_amount = transaction_amount - commission
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND commission IS NOT NULL AND commission != 0
          AND transaction_amount IS NOT NULL
    """))
    cad_result = db.execute(text("""
        UPDATE transactions
        SET cad_amount = cad_amount - commission
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND commission IS NOT NULL AND commission != 0
          AND cad_amount IS NOT NULL
          AND transaction_currency = 'CAD'
    """))
    db.commit()
    return {
        "transaction_amount_rows_fixed": amt_result.rowcount,
        "cad_amount_rows_fixed": cad_result.rowcount,
        "message": "Commission subtracted from Flex trade amounts.",
    }


@router.post("/fix-ibkr-flex-duplicates")
def fix_ibkr_flex_duplicates(db: Session = Depends(get_db)):
    """
    Remove Flex-imported trade records that duplicate an earlier CSV import of the same trade.

    Matches on: account + date + security ticker + abs(quantity).
    The same trade can appear in both CSV and Flex because:
      1. CSV uses OPTION_BUY/OPTION_SELL; Flex uses BUY/SELL
      2. Security records may differ (different security_id rows for the same ticker)
      3. check_duplicate() couldn't catch them before this fix

    Safe to run multiple times — only deletes Flex records (external_ref LIKE 'ibkr-trade-%')
    that have a CSV counterpart (external_ref IS NULL) for the same account/date/ticker/qty.
    """
    result = db.execute(text("""
        DELETE FROM transactions
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND id IN (
            SELECT flex.id
            FROM transactions flex
            JOIN securities sf ON sf.id = flex.security_id
            JOIN transactions csv ON csv.account_id = flex.account_id
                AND csv.transaction_date = flex.transaction_date
                AND csv.external_ref IS NULL
            JOIN securities sc ON sc.id = csv.security_id AND sc.ticker = sf.ticker
            WHERE ABS(ABS(COALESCE(csv.quantity, 0)) - ABS(COALESCE(flex.quantity, 0))) < 0.01
          )
    """))
    db.commit()
    return {
        "flex_duplicates_deleted": result.rowcount,
        "message": "Flex duplicate trade records removed.",
    }


@router.post("/fix-ibkr-buy-signs")
def fix_ibkr_buy_signs(db: Session = Depends(get_db)):
    """
    One-time migration: IBKR-imported BUY/OPTION_BUY transactions were stored with
    positive transaction_amount and cad_amount due to abs() being applied.  This endpoint
    negates those values so cash outflows are correctly represented as negative amounts.
    Safe to run multiple times — only affects rows where the amount is still positive.
    """
    amt_result = db.execute(text("""
        UPDATE transactions
        SET transaction_amount = -transaction_amount
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND transaction_type IN ('BUY', 'OPTION_BUY')
          AND transaction_amount > 0
    """))
    cad_result = db.execute(text("""
        UPDATE transactions
        SET cad_amount = -cad_amount
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND transaction_type IN ('BUY', 'OPTION_BUY')
          AND cad_amount > 0
    """))
    db.commit()
    return {
        "transaction_amount_rows_fixed": amt_result.rowcount,
        "cad_amount_rows_fixed": cad_result.rowcount,
        "message": "IBKR BUY/OPTION_BUY sign fix applied.",
    }
