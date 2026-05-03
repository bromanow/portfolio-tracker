"""
Interactive Brokers Multi-Account Transaction History parser.
File format:
  Statement,Header,...
  Statement,Data,...
  Summary,Header,...
  Summary,Data,...
  Transaction History,Header,Date,Account,Description,Transaction Type,Symbol,...
  Transaction History,Data,2026-04-02,Brian TFSA,...
"""
import re
import io
import csv
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional
import logging

logger = logging.getLogger(__name__)

IBKR_ACTIVITY_MAP = {
    "Buy": "BUY",
    "Sell": "SELL",
    "Dividend": "DIVIDEND",
    "Expired": "OPTION_EXPIRY",
    "Assigned": "OPTION_ASSIGNMENT",
    "Forex Trade Component": "FX_ADJUSTMENT",
    "Deposit": "DEPOSIT",
    "Credit Interest": "INTEREST",
    "Other Fee": "FEE",
    "Sales Tax": "FEE",
    "Adjustment": "ADJUSTMENT",
    "Exercise": "OPTION_EXERCISE",
    "Transfer": "TRANSFER_IN",
    "Withdrawal": "WITHDRAWAL",
    "Withholding Tax": "WITHHOLDING_TAX",
}

# OCC option symbol: e.g. CRWD  260717C00400000 or AMD   251219C00220000
OCC_PATTERN = re.compile(r"^(\w+)\s+(\d{6})(C|P)(\d{8})$")


def parse_occ_symbol(symbol: str) -> Optional[dict]:
    """Parse OCC option symbol like 'AMD   251219C00220000'"""
    m = OCC_PATTERN.match(symbol.strip())
    if not m:
        return None
    underlying, expiry_str, cp, strike_str = m.groups()
    # expiry_str = YYMMDD
    yr = 2000 + int(expiry_str[:2])
    mo = int(expiry_str[2:4])
    day = int(expiry_str[4:6])
    expiry = date(yr, mo, day)
    strike = Decimal(strike_str) / Decimal("1000")
    return {
        "option_type": "CALL" if cp == "C" else "PUT",
        "underlying": underlying.upper(),
        "expiry": expiry,
        "strike": strike,
        "occ_symbol": symbol.strip(),
    }


def _parse_decimal(val: str) -> Optional[Decimal]:
    if val is None:
        return None
    cleaned = str(val).replace(",", "").strip()
    if cleaned in ("", "-", "N/A", "--"):
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _parse_date(val: str) -> Optional[date]:
    if not val or not val.strip():
        return None
    val = val.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(val, fmt).date()
        except ValueError:
            continue
    logger.warning("Could not parse date: %s", val)
    return None


def parse_ibkr_history_csv(content: str) -> list[dict]:
    """
    Parse IB multi-account transaction history CSV.
    Skips Statement/Summary header rows.
    Only processes 'Transaction History,Data,...' rows.
    """
    lines = content.splitlines()

    # Find the Transaction History header line
    header_cols = None
    data_rows_raw = []

    for line in lines:
        if line.startswith("Transaction History,Header,"):
            # Extract columns after the prefix
            parts = line.split(",")
            # Skip "Transaction History" and "Header"
            header_cols = parts[2:]
            header_cols = [h.strip() for h in header_cols]
        elif line.startswith("Transaction History,Data,"):
            parts = line.split(",", 2 + len(header_cols) - 1) if header_cols else line.split(",")
            # Remove first two prefix fields
            if len(parts) > 2:
                data_rows_raw.append(parts[2:])

    if not header_cols:
        logger.error("No Transaction History header found in file")
        return []

    rows = []
    pending_forex_components: list[dict] = []

    for i, raw_fields in enumerate(data_rows_raw):
        # Pad or trim to match header length
        while len(raw_fields) < len(header_cols):
            raw_fields.append("")
        row_dict = {header_cols[j]: raw_fields[j].strip() for j in range(len(header_cols))}

        trans_type = row_dict.get("Transaction Type", "").strip()
        account = row_dict.get("Account", "").strip()
        symbol = row_dict.get("Symbol", "").strip()
        description = row_dict.get("Description", "").strip()
        quantity_str = row_dict.get("Quantity", "")
        price_str = row_dict.get("Price", "")
        price_currency = row_dict.get("Price Currency", "USD")
        gross_str = row_dict.get("Gross Amount", "")
        commission_str = row_dict.get("Commission", "")
        net_str = row_dict.get("Net Amount", "")
        date_str = row_dict.get("Date", "")

        if not trans_type or not date_str:
            continue

        trans_date = _parse_date(date_str)
        quantity = _parse_decimal(quantity_str)
        price = _parse_decimal(price_str)
        gross_amount = _parse_decimal(gross_str)
        commission = _parse_decimal(commission_str)
        net_amount = _parse_decimal(net_str)

        # Detect option
        option_info = parse_occ_symbol(symbol) if symbol else None
        is_option = option_info is not None

        canonical_type = IBKR_ACTIVITY_MAP.get(trans_type, "OTHER")
        if is_option and canonical_type == "BUY":
            canonical_type = "OPTION_BUY"
        elif is_option and canonical_type == "SELL":
            canonical_type = "OPTION_SELL"

        # Handle Forex Trade Component rows: link to parent, skip standalone
        if trans_type == "Forex Trade Component":
            # Store and link to previous row
            fx_row = {
                "account": account,
                "date": trans_date,
                "symbol": symbol,
                "description": description,
                "net_amount": net_amount,
                "price_currency": price_currency,
            }
            pending_forex_components.append(fx_row)
            continue

        parsed = {
            "row_number": i + 1,
            "raw_description": description,
            "raw_symbol": symbol,
            "raw_activity": trans_type,
            "transaction_date": trans_date,
            "settlement_date": None,
            "transaction_type": canonical_type,
            "account_name": account,
            "ticker": symbol if not is_option else (option_info["underlying"] if option_info else symbol),
            "is_option": is_option,
            "option_info": option_info,
            "quantity": quantity,
            "price": price,
            "transaction_currency": price_currency,
            "gross_amount": gross_amount,
            "commission": commission,
            "net_amount": net_amount,
            "forex_components": [],  # Will be populated below
            "brokerage": "IBKR",
        }

        # Attach any pending forex components for same account+date
        attached = []
        remaining = []
        for fx in pending_forex_components:
            if fx["account"] == account and fx["date"] == trans_date:
                attached.append(fx)
            else:
                remaining.append(fx)
        parsed["forex_components"] = attached
        pending_forex_components = remaining

        rows.append(parsed)

    return rows


def detect_ibkr_history_format(content: str) -> bool:
    """Return True if the file looks like an IB Transaction History CSV."""
    return "Transaction History,Header," in content or "Transaction History,Data," in content
