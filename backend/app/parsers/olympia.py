"""
Olympia Trust CSV parser.

Export columns: Date, Client Name, Transaction Type, Description,
                Account Number, Account Type, Credit, Debit, Balance, Currency

All amounts are in CAD. Mortgage positions are tracked as a pseudo-security
where 1 unit = $1 of outstanding principal.
"""
import csv
import io
import logging
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Activity → transaction_type mapping
#
# Olympia transaction types can be exact strings or start-with prefixes.
# The classifier below checks from most-specific to least-specific.
# ---------------------------------------------------------------------------

def _classify(tx_type: str) -> tuple[str, bool]:
    """
    Returns (canonical_transaction_type, is_mortgage_security).
    is_mortgage_security=True means the row should be linked to the
    borrower security (BUY for principal out, SELL for principal returned).
    """
    t = tx_type.strip()

    # Exact matches first
    exact = {
        "Transfer-In":                    ("TRANSFER_IN",        False),
        "Partial Transfer-Out":           ("TRANSFER_OUT",       False),
        "Mortgage Purchase":              ("BUY",                True),
        "Mortgage Paydown (Principal)":   ("SELL",               True),
        "Lender Fee":                     ("INTEREST",           False),
        "Fees Paid by EFT":               ("DEPOSIT",            False),
        "Fees Paid Refund":               ("ADJUSTMENT",         False),
    }
    if t in exact:
        return exact[t]

    # Prefix / substring matches (order matters — specific before generic)
    prefixes = [
        ("NSF Payment",                   ("FEE",                False)),
        ("Mortgage Purchase (Interest",   ("INTEREST",           False)),
        ("Mortgage Purchase (Fee)",       ("FEE",                False)),
        ("GST on Mortgage Purchase",      ("FEE",                False)),
        ("Partial Transfer-Out (Fee)",    ("FEE",                False)),
        ("GST on Partial Transfer-Out",   ("FEE",                False)),
        ("Payment (Interest)",            ("INTEREST",           False)),
        ("GST on Annual Administration",  ("FEE",                False)),
        ("Annual Administration Fee",     ("FEE",                False)),
        ("GST on Administration Fee",     ("FEE",                False)),
        ("Administration Fee",            ("FEE",                False)),
        ("GST on Fee",                    ("FEE",                False)),
        ("Fee (Returned Item)",           ("FEE",                False)),
        ("GST on Fee (Returned Item)",    ("FEE",                False)),
        ("Fee (",                         ("FEE",                False)),
        ("Fee",                           ("FEE",                False)),
    ]
    for prefix, result in prefixes:
        if t.startswith(prefix):
            return result

    logger.warning("Olympia: unknown transaction type %r", t)
    return ("OTHER", False)


def _parse_amount(s: str) -> Optional[Decimal]:
    s = s.strip()
    if not s:
        return None
    try:
        return Decimal(s.replace(",", ""))
    except InvalidOperation:
        return None


def _parse_date(s: str) -> Optional[date]:
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def detect_olympia_format(content: str) -> bool:
    """Return True if the CSV looks like an Olympia Trust export."""
    first = content.split("\n")[0].strip().lower()
    return (
        "client name" in first
        and "transaction type" in first
        and "credit" in first
        and "debit" in first
        and "balance" in first
    )


def parse_olympia_csv(content: str) -> list[dict]:
    """
    Parse an Olympia Trust CSV export into normalizer-ready rows.

    Mortgage principal BUY/SELL rows are linked to a specific security ticker
    based on the purchase date of each mortgage.  Lenders typically have one
    or two mortgages active at a time; the mapping below covers the two
    Goreham mortgages currently on record:

        GOREHAM 1  – first mortgage  (purchased 2024-11-29, $100 000)
        GOREHAM 2  – second mortgage (purchased 2025-05-06, $200 000)

    If a new mortgage is added in a future statement, add another entry to
    MORTGAGE_PURCHASES keyed by the purchase date.
    """
    # Maps the transaction date of a "Mortgage Purchase" row to the security
    # ticker that should be used for all principal rows tied to that mortgage.
    MORTGAGE_PURCHASES: dict[date, str] = {
        date(2024, 11, 29): "GOREHAM 1",
        date(2025, 5, 6):   "GOREHAM 2",
    }

    reader = csv.DictReader(io.StringIO(content))
    raw_rows = []
    for i, raw in enumerate(reader):
        raw = {k: (v or "").strip() for k, v in raw.items()}
        tx_date = _parse_date(raw.get("Date", ""))
        if tx_date:
            raw_rows.append((tx_date, i, raw))  # keep original index for stable sort

    # Sort oldest-first; use original file index as tiebreaker within same date
    raw_rows.sort(key=lambda x: (x[0], x[1]))

    # Track which ticker is "active" — updated each time we see a Mortgage Purchase.
    # The active mortgage is the most recently purchased one.
    active_ticker: str = list(MORTGAGE_PURCHASES.values())[0]

    # Count occurrences of identical (date, type, amount, description) tuples within
    # this batch so we can suffix duplicates and prevent false duplicate detection.
    from collections import Counter
    seen: Counter = Counter()

    rows = []
    for tx_date, _idx, raw in raw_rows:
        tx_type_raw  = raw.get("Transaction Type", "")
        description  = raw.get("Description", "")
        credit       = _parse_amount(raw.get("Credit", ""))
        debit        = _parse_amount(raw.get("Debit", ""))
        currency     = raw.get("Currency", "CAD").upper() or "CAD"

        if credit is not None:
            settlement_amount = credit
        elif debit is not None:
            settlement_amount = -debit
        else:
            settlement_amount = Decimal("0")

        canonical_type, is_mortgage_security = _classify(tx_type_raw)

        # Update active mortgage ticker when we hit a purchase
        if canonical_type == "BUY" and is_mortgage_security:
            active_ticker = MORTGAGE_PURCHASES.get(tx_date, active_ticker)

        if is_mortgage_security:
            ticker   = active_ticker
            quantity = abs(settlement_amount)
            price    = Decimal("1.00")
        else:
            ticker   = ""
            quantity = Decimal("0")
            price    = Decimal("0")

        base_desc = f"{tx_type_raw} – {description}".strip(" –")

        # For cash rows (no security, no quantity), the duplicate detector matches
        # on description.  Two identical fees on the same date (one per mortgage)
        # would be falsely collapsed without a distinguishing suffix.
        dup_key = (tx_date, canonical_type, settlement_amount, base_desc, ticker)
        seen[dup_key] += 1
        if seen[dup_key] > 1:
            final_desc = f"{base_desc} [{seen[dup_key]}]"
        else:
            final_desc = base_desc

        row = {
            "brokerage":            "OLYMPIA",
            "transaction_date":     tx_date,
            "settlement_date":      tx_date,
            "account_currency":     currency,
            "transaction_currency": currency,
            "raw_activity":         tx_type_raw,
            "transaction_type":     canonical_type,
            "ticker":               ticker,
            "raw_symbol":           ticker,
            "is_option":            False,
            "option_info":          None,
            "quantity":             quantity,
            "price":                price,
            "settlement_amount":    settlement_amount,
            "net_amount":           settlement_amount,
            "gross_amount":         settlement_amount,
            "commission":           Decimal("0"),
            "fx_rate_in_desc":      None,
            "description":          final_desc,
        }
        rows.append(row)

    return rows
