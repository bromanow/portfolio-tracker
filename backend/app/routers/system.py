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

    Idempotent: uses commission_applied flag to prevent double-application.
    Records without the flag that have commission != 0 will be updated and
    flagged; already-flagged records are skipped.
    """
    amt_result = db.execute(text("""
        UPDATE transactions
        SET transaction_amount = transaction_amount - commission,
            notes = COALESCE(notes || ' ', '') || '[commission_applied]'
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND commission IS NOT NULL AND commission != 0
          AND transaction_amount IS NOT NULL
          AND (notes IS NULL OR notes NOT LIKE '%[commission_applied]%')
    """))
    cad_result = db.execute(text("""
        UPDATE transactions
        SET cad_amount = cad_amount - commission
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND commission IS NOT NULL AND commission != 0
          AND cad_amount IS NOT NULL
          AND transaction_currency = 'CAD'
          AND (notes IS NULL OR notes NOT LIKE '%[commission_applied]%')
    """))
    db.commit()
    return {
        "transaction_amount_rows_fixed": amt_result.rowcount,
        "cad_amount_rows_fixed": cad_result.rowcount,
        "message": "Commission subtracted from Flex trade amounts (idempotent via notes flag).",
    }


@router.post("/undo-ibkr-commission-double")
def undo_ibkr_commission_double(db: Session = Depends(get_db)):
    """
    Emergency fix: if fix-ibkr-commission-amounts was run twice (before the
    idempotency flag was introduced), this adds back one commission to undo
    the extra subtraction, then marks all Flex records as [commission_applied]
    so the fix endpoint won't subtract again.

    Use when: balance dropped unexpectedly after running commission fix twice.

    Assumes all Flex records with commission != 0 had the commission subtracted
    exactly 2 times (once in each of two separate fix-ibkr-commission-amounts calls).
    Adding back 1× commission returns them to correct netCash.
    Do NOT run fix-ibkr-commission-amounts after this.
    """
    amt_result = db.execute(text("""
        UPDATE transactions
        SET transaction_amount = transaction_amount + commission,
            notes = TRIM(COALESCE(notes, '') || ' [commission_applied]')
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND commission IS NOT NULL AND commission != 0
          AND transaction_amount IS NOT NULL
    """))
    cad_result = db.execute(text("""
        UPDATE transactions
        SET cad_amount = cad_amount + commission
        WHERE external_ref LIKE 'ibkr-trade-%'
          AND commission IS NOT NULL AND commission != 0
          AND cad_amount IS NOT NULL
          AND transaction_currency = 'CAD'
    """))
    db.commit()
    return {
        "transaction_amount_rows_reverted": amt_result.rowcount,
        "cad_amount_rows_reverted": cad_result.rowcount,
        "message": "One commission subtraction reversed and records flagged. Do NOT run fix-ibkr-commission-amounts again.",
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


@router.post("/fix-ibkr-csv-forex-rows")
def fix_ibkr_csv_forex_rows(db: Session = Depends(get_db)):
    """
    Remove transactions that were incorrectly imported from IBKR Transaction History
    CSV files due to a CSV parsing bug: when a 'Forex Trade Component' row had a
    thousands-separator comma in the description (e.g. "Net Amount in Base from
    Forex Trade: 8,372.65 USD.CAD"), the naive split(",") broke the field boundaries,
    shifting all columns. The row was imported as type OTHER with the ticker set to
    'FOREX TRADE COMPONENT' (or 'USD.CAD') instead of being skipped.

    Idempotent — only deletes CSV-imported rows (external_ref IS NULL) whose
    security ticker matches the broken pattern. The parser is now fixed so
    re-importing the CSV will correctly skip these rows.
    """
    result = db.execute(text("""
        DELETE FROM transactions
        WHERE external_ref IS NULL
          AND transaction_type = 'OTHER'
          AND id IN (
            SELECT t.id FROM transactions t
            JOIN securities s ON s.id = t.security_id
            WHERE UPPER(s.ticker) IN ('FOREX TRADE COMPONENT', 'USD.CAD', 'CAD.USD')
               OR UPPER(s.ticker) LIKE '%FOREX%TRADE%'
          )
    """))
    db.commit()
    return {
        "bad_forex_rows_deleted": result.rowcount,
        "message": (
            "Incorrectly-parsed Forex Trade Component rows removed. "
            "Re-import the IBKR Transaction History CSV to get correct data."
        ),
    }
