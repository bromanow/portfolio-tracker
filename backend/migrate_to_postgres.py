"""
Migrate all data from SQLite → PostgreSQL.

Run once from the backend directory:
    python migrate_to_postgres.py                          # → local PostgreSQL
    DATABASE_URL="postgresql://..." python migrate_to_postgres.py  # → remote

The script:
  1. Creates all tables in PostgreSQL (via SQLAlchemy models)
  2. Clears existing data in safe FK order
  3. Copies every table row-by-row, handling type coercions
  4. Resets all PostgreSQL sequences so future INSERTs get correct IDs
  5. Prints a summary of rows migrated per table

Works with managed PostgreSQL (no superuser required).
"""

import os
import sys
from decimal import Decimal
from sqlalchemy import create_engine, text, inspect

SQLITE_URL = "sqlite:///./portfolio.db"
PG_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://Mini@localhost/portfolio_tracker",
)

print(f"Source:      {SQLITE_URL}")
print(f"Destination: {PG_URL}")
print()

# ── Connect to both databases ─────────────────────────────────────────────────
sqlite_engine = create_engine(SQLITE_URL, connect_args={"check_same_thread": False})
pg_engine     = create_engine(PG_URL, pool_pre_ping=True)

# ── Create schema in PostgreSQL from SQLAlchemy models ────────────────────────
print("Creating schema in PostgreSQL…")
sys.path.insert(0, os.path.dirname(__file__))

# Set DATABASE_URL so app/database.py points at Postgres when models import it
os.environ["DATABASE_URL"] = PG_URL

from app.database import Base
import app.models.master       # noqa – registers models
import app.models.transactions # noqa
import app.models.options      # noqa
import app.models.imports      # noqa
import app.models.prices       # noqa

Base.metadata.create_all(bind=pg_engine)
print("Schema created.\n")

# ── Table order (insert order — respects foreign keys) ────────────────────────
# raw_transactions and transactions have a circular FK:
#   transactions.raw_import_id  → raw_transactions.id
#   raw_transactions.transaction_id → transactions.id      ← the tricky one
#
# We handle this by:
#   • Inserting raw_transactions with transaction_id = NULL
#   • Inserting transactions normally (raw_import_id already satisfied)
#   • Running a single UPDATE to restore raw_transactions.transaction_id
TABLES = [
    "brokerages",
    "accounts",
    "currencies",
    "fx_rates",
    "brokerage_type_mappings",
    "securities",
    "import_batches",
    "raw_transactions",      # inserted with transaction_id = NULL (see below)
    "portfolio_snapshots",
    "transactions",
    "historical_prices",
    "market_prices",
    "option_contracts",
    "security_fundamentals",
    "security_signals",
    "stock_splits",
    "option_strategies",
    "option_strategy_legs",
]

# Build a map of {table: set_of_bool_column_names} from the PG schema
# so we can coerce SQLite 0/1 integers to Python bool before inserting.
pg_inspector = inspect(pg_engine)
bool_cols: dict[str, set] = {}
for tbl in pg_inspector.get_table_names(schema="public"):
    bool_cols[tbl] = {
        c["name"]
        for c in pg_inspector.get_columns(tbl, schema="public")
        if str(c["type"]).upper() == "BOOLEAN"
    }

def coerce_row(row: dict, table: str) -> dict:
    """Convert SQLite types to PostgreSQL-safe Python types."""
    bools = bool_cols.get(table, set())
    result = {}
    for k, v in row.items():
        if k in bools and isinstance(v, int):
            result[k] = bool(v)
        elif isinstance(v, Decimal):
            result[k] = float(v)
        else:
            result[k] = v
    return result

total_rows = 0

with sqlite_engine.connect() as src, pg_engine.connect() as dst:
    sqlite_inspector = inspect(sqlite_engine)
    existing_tables = sqlite_inspector.get_table_names()

    # ── Clear existing data in reverse FK order ───────────────────────────────
    # raw_transactions.transaction_id → transactions creates a cycle.
    # Break it by nulling that column before we delete transactions.
    print("Clearing existing data…")
    if "raw_transactions" in existing_tables:
        dst.execute(text('UPDATE "raw_transactions" SET "transaction_id" = NULL'))
        dst.commit()

    for table in reversed(TABLES):
        if table not in existing_tables:
            continue
        dst.execute(text(f'DELETE FROM "{table}"'))
        dst.commit()
    print("Done.\n")

    # ── Copy each table ───────────────────────────────────────────────────────
    # raw_transaction_ids: maps raw_transaction.id → original transaction_id
    # so we can restore the circular FK after transactions are loaded.
    raw_txn_id_map: dict = {}  # maps raw_transaction.id → original transaction_id (or None)

    for table in TABLES:
        if table not in existing_tables:
            print(f"  {table}: skipped (not in SQLite)")
            continue

        rows = src.execute(text(f"SELECT * FROM {table}")).mappings().all()
        if not rows:
            print(f"  {table}: 0 rows")
            continue

        BATCH = 500
        cols = list(rows[0].keys())

        if table == "raw_transactions":
            # Save transaction_id values, then insert with NULL to avoid FK violation
            # (transactions don't exist yet).
            for row in rows:
                raw_txn_id_map[row["id"]] = row["transaction_id"]
            insert_cols = [c for c in cols if c != "transaction_id"]
            col_list = ", ".join(f'"{c}"' for c in insert_cols)
            val_list = ", ".join(f":{c}" for c in insert_cols)
        else:
            insert_cols = cols
            col_list = ", ".join(f'"{c}"' for c in cols)
            val_list = ", ".join(f":{c}" for c in cols)

        insert_sql = text(f'INSERT INTO "{table}" ({col_list}) VALUES ({val_list})')

        for i in range(0, len(rows), BATCH):
            batch = [coerce_row(dict(row), table) for row in rows[i:i+BATCH]]
            if table == "raw_transactions":
                # Strip transaction_id from each row dict
                batch = [{k: v for k, v in r.items() if k != "transaction_id"} for r in batch]
            dst.execute(insert_sql, batch)
            dst.commit()

        print(f"  {table}: {len(rows):,} rows migrated")
        total_rows += len(rows)

    # ── Restore raw_transactions.transaction_id ───────────────────────────────
    linked = {k: v for k, v in raw_txn_id_map.items() if v is not None}
    if linked:
        print(f"\nRestoring {len(linked):,} raw_transaction → transaction links…")
        for raw_id, txn_id in linked.items():
            dst.execute(
                text('UPDATE "raw_transactions" SET "transaction_id" = :txn_id WHERE "id" = :raw_id'),
                {"txn_id": txn_id, "raw_id": raw_id},
            )
        dst.commit()
        print("Done.")

    # ── Reset all sequences so INSERT after migration gets correct next ID ────
    print("\nResetting PostgreSQL sequences…")
    seq_sql = text("""
        SELECT table_name, column_name, pg_get_serial_sequence(table_name, column_name) AS seq
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_default LIKE 'nextval%'
    """)
    for row in dst.execute(seq_sql).mappings():
        if row["seq"]:
            seq = row["seq"]
            col = row["column_name"]
            tbl = row["table_name"]
            dst.execute(text(
                f'SELECT setval(\'{seq}\', COALESCE((SELECT MAX("{col}") FROM "{tbl}"), 0) + 1, false)'
            ))
    dst.commit()
    print("Sequences reset.\n")

print(f"Migration complete — {total_rows:,} total rows copied.")
