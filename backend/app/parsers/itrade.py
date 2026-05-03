"""
Scotia iTrade CSV parser.
CSV columns: Description,Symbol,Transaction date,Settlement date,Account Currency,
             Activity,Quantity,Currency of Price,Price,Settlement amount
"""
import re
import csv
import io
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Optional
import logging

logger = logging.getLogger(__name__)

ITRADE_ACTIVITY_MAP = {
    "BUY": "BUY",
    "Buy": "BUY",           # some iTrade RESP/RRSP exports use mixed case
    "SELL": "SELL",
    "Sell": "SELL",         # some iTrade RESP/RRSP exports use mixed case
    "Stock dividend": "DIVIDEND",
    "CASH DIV": "DIVIDEND", # older iTrade RRSP exports use "CASH DIV" in Type column
    "DRIP": "DRIP",
    "Expired": "OPTION_EXPIRY",
    "Assigned": "OPTION_ASSIGNMENT",
    "Reverse": "REVERSE_SPLIT",
    "Exchange adjustment": "SPLIT",
    "Transfer": "JOURNAL",
    "TRANSFER": "JOURNAL",
    "Redeemed": "SELL",
    "Fee": "FEE",
    "Return of Capital": "RETURN_OF_CAPITAL",
    "RTC": "RETURN_OF_CAPITAL",  # iTrade abbreviation for Return of Capital
    "Interest": "INTEREST",
    "Withholding Tax": "WITHHOLDING_TAX",
    "Deposit": "DEPOSIT",
    "DEPOSIT": "DEPOSIT",
    "Withdrawal": "WITHDRAWAL",
    "WITHDRAWAL": "WITHDRAWAL",
    "EWD": "WITHDRAWAL",    # RESP Educational Withdrawal (EAP/PSE)
    "CASHINLIEU": "DIVIDEND",  # Cash in lieu of fractional shares / dividend
    # REI = internal Scotia bookkeeping entries emitted in pairs (+/−) around
    # DRIP/DPP cycles.  They carry no quantity and net to zero — skip them.
    "REI": "SKIP",
}

# Extract per-share price from reinvestment descriptions: "@ 3.89", "@ $9.5608"
_PRICE_RE = re.compile(r"@\s*\$?([\d]+\.[\d]+)")

OPTION_PATTERN = re.compile(
    r"(CALL|PUT)\s+([\w\.]+)\s+(\d{2}/\d{2}/\d{2})\s+([\d\.]+)",
    re.IGNORECASE,
)

# Matches DRIP/DPP/REINVEST reinvestment purchases in the Description field.
# Examples:
#   "DECISIVE DIVIDEND CORP COM REINVEST @3.8900 05/15/19 DRIP-DIVD REINVESTMENT"
#   "ENBRIDGE INC DPP-Divd Pur Plan REINV @ 50.02659C$ 06/03/19"
#   "REINVEST 11/29/24 @ $9.5608 PLUS FRACTIONS OF 0.635 BOOK VALUE $120.80"
_DRIP_DESC_RE = re.compile(r"\b(DRIP|DPP|REINVEST|REINV)\b", re.IGNORECASE)


def parse_option_symbol_itrade(symbol: str) -> Optional[dict]:
    """Parse iTrade option text like 'CALL AMD    02/20/26   230'"""
    m = OPTION_PATTERN.match(symbol.strip())
    if not m:
        return None
    option_type, underlying, expiry_str, strike_str = m.groups()
    # expiry_str = MM/DD/YY
    mo, day, yr = expiry_str.split("/")
    year = 2000 + int(yr)
    expiry = date(year, int(mo), int(day))
    return {
        "option_type": option_type.upper(),
        "underlying": underlying.upper(),
        "expiry": expiry,
        "strike": Decimal(strike_str),
    }


def _parse_decimal(val: str) -> Optional[Decimal]:
    if val is None:
        return None
    cleaned = str(val).replace(",", "").strip()
    if cleaned in ("", "-", "N/A"):
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _parse_date(val: str) -> Optional[date]:
    if not val or not val.strip():
        return None
    val = val.strip()
    # Try MM/DD/YYYY or MM/DD/YY
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            from datetime import datetime
            return datetime.strptime(val, fmt).date()
        except ValueError:
            continue
    logger.warning("Could not parse date: %s", val)
    return None


def _annotate_split_ratios(rows: list[dict]) -> None:
    """
    For REVERSE_SPLIT (and SPLIT) transactions, find the paired +qty and -qty rows
    on the same date for the same ticker and annotate both with the ratio info.

    iTrade emits two rows per split:
      - one with negative qty (old shares removed)
      - one with positive qty (new shares received)

    The ratio is new_qty / old_qty, e.g. 30000/40000 = 3:4 reverse split.
    """
    # Build index: (date, ticker, split_type) → list of rows
    from collections import defaultdict
    split_groups: dict = defaultdict(list)
    for row in rows:
        t_type = row.get("transaction_type")
        if t_type not in ("REVERSE_SPLIT", "SPLIT"):
            continue
        key = (row.get("transaction_date"), row.get("ticker"), t_type)
        split_groups[key].append(row)

    for (txn_date, ticker, t_type), group in split_groups.items():
        if len(group) < 2:
            continue
        positives = [r for r in group if r.get("quantity") is not None and r["quantity"] > 0]
        negatives = [r for r in group if r.get("quantity") is not None and r["quantity"] < 0]
        if not positives or not negatives:
            continue
        new_qty = positives[0]["quantity"]
        old_qty = abs(negatives[0]["quantity"])
        if old_qty == 0:
            continue
        from math import gcd
        g = gcd(int(new_qty), int(old_qty))
        new_r, old_r = int(new_qty) // g, int(old_qty) // g
        ratio_str = f"{new_r} for {old_r} {t_type.replace('_', ' ').lower()}"
        note = f"{ratio_str} ({int(new_qty):,} new shares for {int(old_qty):,} old shares)"
        for row in group:
            existing = row.get("raw_description", "")
            row["raw_description"] = f"{existing} [{note}]".strip() if existing else f"[{note}]"


def parse_itrade_csv(content: str) -> list[dict]:
    """
    Parse a Scotia iTrade CSV file and return list of normalized row dicts.
    Each dict has normalized field names ready for the normalizer.
    """
    reader = csv.DictReader(io.StringIO(content))
    rows = []

    for i, row in enumerate(reader):
        # Strip whitespace and UTF-8 BOM from keys and values.
        # iTrade CSVs are often saved with a BOM, making the first column
        # header "\ufeffDescription" instead of "Description".
        row = {k.lstrip('\ufeff').strip(): (v.strip() if v else "") for k, v in row.items() if k}

        description = row.get("Description", "")
        symbol = row.get("Symbol", "")
        # Older iTrade RRSP exports use "Type" instead of "Activity"
        activity = row.get("Activity", "") or row.get("Type", "")
        quantity_str = row.get("Quantity", "")
        price_str = row.get("Price", "")
        # Older exports use "Settlement Amount" (capital A) with possible leading space
        settlement_amount_str = row.get("Settlement amount", "") or row.get("Settlement Amount", "")
        account_currency = row.get("Account Currency", "CAD")
        currency_of_price = row.get("Currency of Price", account_currency)
        # Older exports use "Transaction Date" / "Settlement Date" (capital D)
        trans_date_str = row.get("Transaction date", "") or row.get("Transaction Date", "")
        settle_date_str = row.get("Settlement date", "") or row.get("Settlement Date", "")

        if not activity and not symbol:
            continue  # skip empty rows

        # Skip internal bookkeeping rows (e.g. REI = DRIP cash-holding entries)
        if ITRADE_ACTIVITY_MAP.get(activity) == "SKIP":
            continue

        trans_date = _parse_date(trans_date_str)
        settle_date = _parse_date(settle_date_str)

        quantity = _parse_decimal(quantity_str)
        price = _parse_decimal(price_str)
        settlement_amount = _parse_decimal(settlement_amount_str)

        # Detect if this is an option
        option_info = None
        is_option = False
        if symbol and OPTION_PATTERN.match(symbol.strip()):
            option_info = parse_option_symbol_itrade(symbol)
            is_option = True
        elif not is_option and description and OPTION_PATTERN.match(description.strip()):
            # Fallback: for OPTION_EXPIRY / OPTION_ASSIGNMENT rows the Symbol
            # column is often blank — the option text is in the Description column.
            option_info = parse_option_symbol_itrade(description)
            if option_info:
                is_option = True

        # Map activity to canonical type
        canonical_type = ITRADE_ACTIVITY_MAP.get(activity, "OTHER")
        if is_option and canonical_type == "BUY":
            canonical_type = "OPTION_BUY"
        elif is_option and canonical_type == "SELL":
            canonical_type = "OPTION_SELL"

        # Promote to DRIP when description signals a reinvestment.
        # Covers two patterns:
        #   1. Activity="Buy" + description has DRIP/DPP/REINVEST
        #   2. Activity="Stock dividend" + description has REINVEST + shares received
        if canonical_type == "BUY" and _DRIP_DESC_RE.search(description):
            canonical_type = "DRIP"
        elif (
            canonical_type == "DIVIDEND"
            and quantity is not None and quantity != 0
            and _DRIP_DESC_RE.search(description)
        ):
            canonical_type = "DRIP"

        # ── DRIP sign normalisation ──────────────────────────────────────────
        # BUY transactions carry a negative settlement (cash outflow).  After
        # promoting BUY → DRIP the amount must be positive: DRIP represents
        # dividend income reinvested as shares, not a cash withdrawal.
        if canonical_type == "DRIP" and settlement_amount is not None and settlement_amount < 0:
            settlement_amount = abs(settlement_amount)

        # ── Reinvestment price / settlement derivation ───────────────────────
        # For DRIP/DPP rows the CSV "Price" column is often 0; the per-share
        # price is embedded in the Description as "@ 3.8900" or "@ $9.5608".
        # Also, the "Settlement amount" is 0 (no actual cash movement — the
        # dividend was reinvested internally).  Derive both so that income
        # reports and ACB cost-basis receive the correct dollar value.
        is_reinvestment_row = (
            canonical_type in ("DRIP", "DIVIDEND")
            or _DRIP_DESC_RE.search(description)
        )
        if is_reinvestment_row:
            # Fall back to description price when CSV Price column is 0 / missing
            if (price is None or price == Decimal("0")):
                pm = _PRICE_RE.search(description)
                if pm:
                    try:
                        price = Decimal(pm.group(1))
                    except InvalidOperation:
                        pass
            # Derive settlement = qty × price when CSV has 0 (reinvestment rows).
            # Use POSITIVE so income reports show the value correctly.
            # Cash-balance calculations exclude DRIP via CASH_NEUTRAL_TYPES.
            if (
                quantity is not None and quantity != 0
                and price is not None and price != 0
                and (settlement_amount is None or settlement_amount == Decimal("0"))
            ):
                settlement_amount = (abs(quantity) * price).quantize(Decimal("0.01"))

        # Extract FX rate from description if present (e.g. "FX 0001.38401").
        # NOTE: "FX" in the description means the trade price was in a foreign
        # currency and was converted to the account currency for settlement.
        # It does NOT make the transaction an FX_CONVERSION — that type is
        # reserved for pure currency-exchange transactions with no security.
        # Only mark FX_CONVERSION when there is no ticker symbol.
        fx_rate_in_desc = None
        has_fx_in_desc = bool(re.search(r"\bFX\s+[\d\.]+", description, re.IGNORECASE))
        if has_fx_in_desc:
            fx_match = re.search(r"\bFX\s+([\d\.]+)", description, re.IGNORECASE)
            if fx_match:
                try:
                    fx_rate_in_desc = Decimal(fx_match.group(1))
                except InvalidOperation:
                    pass
            # Only override to FX_CONVERSION when no security is involved
            if not symbol.strip() and not is_option:
                canonical_type = "FX_CONVERSION"

        # Normalize ticker
        ticker = symbol.strip() if not is_option else (option_info["underlying"] if option_info else symbol)

        parsed = {
            "row_number": i + 1,
            "raw_description": description,
            "raw_symbol": symbol,
            "raw_activity": activity,
            "transaction_date": trans_date,
            "settlement_date": settle_date,
            "transaction_type": canonical_type,
            "ticker": ticker if not is_option else symbol,
            "is_option": is_option,
            "option_info": option_info,
            "quantity": quantity,
            "price": price,
            "transaction_currency": currency_of_price or account_currency,
            "account_currency": account_currency,
            "settlement_amount": settlement_amount,
            "fx_rate_in_desc": fx_rate_in_desc,
            "brokerage": "ITRADE",
        }
        rows.append(parsed)

    # Annotate split/reverse-split pairs with ratio info
    _annotate_split_ratios(rows)

    return rows


def detect_itrade_format(content: str) -> bool:
    """Return True if the file looks like a Scotia iTrade CSV (not ScotiaMacleod/Wealth).
    Handles two header variants:
      Modern: Activity, Settlement amount  (exact case)
      Older:  Type,     Settlement Amount  (alternate names / capitalisation)
    """
    first_line = content.split("\n")[0].strip().lower()
    has_settlement = "settlement amount" in first_line
    has_activity   = "activity" in first_line or ",type," in first_line or first_line.endswith(",type")
    if not has_settlement or not has_activity:
        return False
    # ScotiaMacleod files have the same columns but use mixed-case activity names.
    # Avoid claiming those files — the scotia_wealth parser handles them.
    lines = content.split("\n")
    sw_markers = (",Buy,", ",Redeemed,", ",Stock dividend,", ",Exchange adjustment,", ",GST,")
    for line in lines[1:25]:
        for marker in sw_markers:
            if marker in line:
                return False
    return True
