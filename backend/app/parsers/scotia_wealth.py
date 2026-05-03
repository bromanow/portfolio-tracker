"""
Scotia Wealth Management (ScotiaMacleod) CSV parser.

Same columns as iTrade but with different Activity names and FX semantics:
  Description, Symbol, Transaction date, Settlement date, Account Currency,
  Activity, Quantity, Currency of Price, Price, Settlement amount

Key differences from iTrade:
- Activity uses mixed case:  Buy / Redeemed / Stock dividend / Fee / GST / Exchange adjustment
- Settlement amount is ALWAYS in the account base currency (CAD).
  The "FX XXXX" in the Description is the USD→CAD rate used by Scotia to convert
  the trade price — it does NOT mean this is a currency-exchange transaction.
- Price column is always 0; the native per-share price is embedded in Description
  as "@ 0072.428".
"""
import re
import csv
import io
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional
import logging

logger = logging.getLogger(__name__)


# Maps ScotiaMacleod Activity column values → canonical transaction types.
# Extend this list as new activity strings are discovered.
SM_ACTIVITY_MAP: dict[str, str] = {
    "Buy":                  "BUY",
    "BUY":                  "BUY",   # some ScotiaMacleod files use uppercase
    "Sell":                 "SELL",
    "SELL":                 "SELL",  # some ScotiaMacleod files use uppercase
    "Redeemed":             "SELL",
    "Short Sell":           "SHORT_SELL",
    "Buy Cover":            "BUY",
    "Stock dividend":       "DIVIDEND",
    "Dividend":             "DIVIDEND",
    "Cash Dividend":        "DIVIDEND",
    "DRIP":                 "DRIP",
    "Fee":                  "FEE",
    "GST":                  "FEE",
    "HST":                  "FEE",
    "QST":                  "FEE",
    "Commission":           "FEE",
    "Transfer":             "TRANSFER_IN",   # cash transfer between accounts; direction refined by amount sign
    "Exchange adjustment":  "FORWARD_SPLIT",
    "Convert":              "FX_CONVERSION",
    "CONVERT":              "FX_CONVERSION",
    "Reverse split":        "REVERSE_SPLIT",
    "Interest":             "INTEREST",
    "Return of Capital":    "RETURN_OF_CAPITAL",
    "RTC":                  "RETURN_OF_CAPITAL",  # ScotiaMacleod abbreviation for Return of Capital
    "Withholding Tax":      "WITHHOLDING_TAX",
    "Non-Res Tax":          "WITHHOLDING_TAX",
    "Deposit":              "DEPOSIT",
    "Withdrawal":           "WITHDRAWAL",
    "EWD":                  "WITHDRAWAL",         # RESP Educational Withdrawal (EAP/PSE)
    "Expired":              "OPTION_EXPIRY",
    "Assigned":             "OPTION_ASSIGNMENT",
    # REI = internal Scotia bookkeeping entries emitted in pairs (+/−) around
    # DRIP/DPP cycles.  They carry no quantity and net to zero — skip them.
    "REI":                  "SKIP",
}

# "CISCO SYSTEMS INC @ 0072.428 TD 11/05/25 FX 0001.41189 ..."
# "REINVEST 11/29/24 @ $9.5608 PLUS FRACTIONS ..."  (dollar sign before price)
_PRICE_RE = re.compile(r"@\s*\$?([\d]+\.[\d]+)")
_FX_RE    = re.compile(r"\bFX\s+([\d]+\.[\d]+)")

# Matches DRIP/DPP/REINVEST reinvestment purchases in the Description field.
# Examples:
#   "DECISIVE DIVIDEND CORP COM REINVEST @3.8900 05/15/19 DRIP-DIVD REINVESTMENT"
#   "ENBRIDGE INC DPP-Divd Pur Plan REINV @ 50.02659C$ 06/03/19"
#   "REINVEST 11/29/24 @ $9.5608 PLUS FRACTIONS OF 0.635 BOOK VALUE $120.80"
_DRIP_DESC_RE = re.compile(r"\b(DRIP|DPP|REINVEST|REINV)\b", re.IGNORECASE)


def _d(val: str) -> Optional[Decimal]:
    cleaned = str(val).replace(",", "").strip()
    if cleaned in ("", "-", "N/A", "None"):
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _date(val: str) -> Optional[date]:
    if not val or not val.strip():
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(val.strip(), fmt).date()
        except ValueError:
            continue
    logger.warning("ScotiaMacleod: could not parse date %r", val)
    return None


def parse_scotia_wealth_csv(content: str) -> list[dict]:
    """
    Parse a Scotia Wealth / ScotiaMacleod CSV file.

    Settlement amount is the exact CAD amount (already FX-converted by Scotia).
    We store it as-is; no additional currency conversion is needed.
    The FX rate from the description is preserved for display/reference.
    """
    reader = csv.DictReader(io.StringIO(content))
    rows: list[dict] = []

    for i, raw in enumerate(reader):
        # Strip whitespace and UTF-8 BOM from keys and values.
        # ScotiaMacleod CSVs are often saved with a BOM, making the first
        # column header "\ufeffDescription" instead of "Description".
        row = {k.lstrip('\ufeff').strip(): (v.strip() if v else "") for k, v in raw.items() if k}

        description      = row.get("Description", "").strip()
        symbol           = row.get("Symbol", "").strip()
        activity         = row.get("Activity", "").strip()
        quantity_str     = row.get("Quantity", "")
        settlement_str   = row.get("Settlement amount", "")
        acct_ccy         = (row.get("Account Currency", "CAD") or "CAD").strip()
        trans_date_str   = row.get("Transaction date", "")
        settle_date_str  = row.get("Settlement date", "")

        if not activity and not symbol:
            continue  # blank row

        # ── Skip internal bookkeeping rows ───────────────────────────────────
        # REI rows are Scotia's internal debit/credit pair for DRIP/DPP cash
        # holding; they carry no quantity and net to zero across the cycle.
        if SM_ACTIVITY_MAP.get(activity) == "SKIP":
            continue

        trans_date  = _date(trans_date_str)
        settle_date = _date(settle_date_str)
        quantity    = _d(quantity_str)
        settlement  = _d(settlement_str)

        # ── Transaction type ────────────────────────────────────────────────
        # Use Activity column directly.  Type-mapping overrides (configured in
        # Admin → Type Mappings) are applied later in the normalizer.
        canonical_type = SM_ACTIVITY_MAP.get(activity, "OTHER")

        # ── Distinguish fund mergers from stock splits ───────────────────────
        # Scotia Wealth uses "Exchange adjustment" for both stock splits and
        # cross-security fund mergers (share class conversions).  We detect
        # which case it is from the description:
        #
        #   "STK SPLIT"  / "SPINOFF"  → FORWARD_SPLIT (same-security, one row,
        #                                positive qty = additional shares added)
        #   "FUND MERGER"             → JOURNAL        (cross-security, two rows:
        #                                negative on old security zeroes it out,
        #                                positive on new security adds shares with
        #                                ACB from embedded BOOK VALUE)
        #
        # Defaulting to FORWARD_SPLIT for any unrecognised "Exchange adjustment"
        # preserves existing behaviour for future unknown sub-types.
        if canonical_type == "FORWARD_SPLIT" and "FUND MERGER" in description.upper():
            canonical_type = "JOURNAL"

        # ── Promote to DRIP when description signals a reinvestment ─────────
        # Covers two patterns:
        #   1. Activity="Buy" + description has DRIP/DPP/REINVEST
        #   2. Activity="Stock dividend" + description has REINVEST + shares received
        #      (the dividend was automatically reinvested rather than paid as cash)
        if canonical_type == "BUY" and _DRIP_DESC_RE.search(description):
            canonical_type = "DRIP"
        elif (
            canonical_type == "DIVIDEND"
            and quantity is not None and quantity != 0
            and _DRIP_DESC_RE.search(description)
        ):
            canonical_type = "DRIP"

        # ── Extract native price from description: "@ 0072.428" ──────────────
        price: Optional[Decimal] = None
        pm = _PRICE_RE.search(description)
        if pm:
            price = _d(pm.group(1))

        # ── Extract FX rate from description: "FX 0001.41189" ────────────────
        # This means the trade was executed in USD and Scotia converted it to
        # CAD for the settlement.  The settlement amount is already in CAD.
        # We record the native currency and FX rate for reference only.
        fx_rate: Optional[Decimal] = None
        native_ccy = acct_ccy
        fm = _FX_RE.search(description)
        if fm:
            fx_rate = _d(fm.group(1))
            if fx_rate and fx_rate > 0:
                native_ccy = "USD"  # FX present → trade was in USD

        # ── DRIP sign normalisation ──────────────────────────────────────────
        # BUY transactions carry a negative settlement (cash outflow).  After
        # promoting BUY → DRIP the amount must be positive: DRIP represents
        # dividend income reinvested as shares, not a cash withdrawal.
        if canonical_type == "DRIP" and settlement is not None and settlement < 0:
            settlement = abs(settlement)

        # ── Derive settlement for reinvestment rows (DRIP/DPP) ───────────────
        # When the CSV "Settlement amount" column is 0 (no actual cash transfer —
        # the dividend was automatically reinvested), compute the total dollar
        # value from the per-share price extracted from the description.
        # Use a POSITIVE amount so income reports show the correct reinvestment
        # value.  Cash-balance calculations exclude DRIP via CASH_NEUTRAL_TYPES.
        is_reinvestment_row = (
            canonical_type in ("DRIP", "DIVIDEND")
            or _DRIP_DESC_RE.search(description)
        )
        if (
            is_reinvestment_row
            and quantity is not None and quantity != 0
            and price is not None and price != 0
            and (settlement is None or settlement == Decimal("0"))
        ):
            settlement = (abs(quantity) * price).quantize(Decimal("0.01"))

        # ── Option detection ────────────────────────────────────────────────
        # OPTION_EXPIRY / OPTION_ASSIGNMENT rows often have a blank Symbol
        # column; the option text appears in the Description instead.
        # Also try the Symbol column first for normal option buy/sell rows.
        from app.parsers.itrade import OPTION_PATTERN, parse_option_symbol_itrade
        is_option = False
        option_info = None
        option_symbol = None
        for src in (symbol, description):
            if src and OPTION_PATTERN.match(src.strip()):
                option_info = parse_option_symbol_itrade(src)
                if option_info:
                    is_option = True
                    option_symbol = src.strip()
                    break
        if is_option and canonical_type == "BUY":
            canonical_type = "OPTION_BUY"
        elif is_option and canonical_type == "SELL":
            canonical_type = "OPTION_SELL"

        rows.append({
            "row_number":        i + 1,
            "raw_description":   description,
            "raw_symbol":        option_symbol or symbol,
            "raw_activity":      activity,
            "transaction_date":  trans_date,
            "settlement_date":   settle_date,
            "transaction_type":  canonical_type,
            "ticker":            (option_symbol or symbol) if is_option else symbol,
            "is_option":         is_option,
            "option_info":       option_info,
            "quantity":          quantity,
            "price":             price,        # native per-share price (USD or CAD)
            # Settlement amount is already in account base currency (CAD).
            # transaction_currency = acct_ccy so normalizer treats it as CAD→CAD
            # with no FX conversion needed.
            "settlement_amount":     settlement,
            "transaction_currency":  acct_ccy,   # always CAD for this account type
            "account_currency":      acct_ccy,
            "native_currency":       native_ccy,  # USD or CAD (reference only)
            "fx_rate_in_desc":       fx_rate,     # reference; not used for conversion
            "brokerage":             "SCOTIAWEALTH",
        })

    return rows


def detect_scotia_wealth_format(content: str) -> bool:
    """
    Return True if this looks like a Scotia Wealth / ScotiaMacleod CSV.

    The column headers are identical to iTrade, but Activity values use mixed
    case: "Buy" (not "BUY"), "Stock dividend", "Redeemed", etc.
    We scan the first 25 data rows for these mixed-case markers.
    """
    lines = content.split("\n")
    if not lines:
        return False
    header = lines[0].strip().strip('"')
    if "Settlement amount" not in header or "Activity" not in header:
        return False
    # Mixed-case markers unique to ScotiaMacleod
    markers = (",Buy,", ",Redeemed,", ",Stock dividend,", ",Exchange adjustment,", ",GST,")
    for line in lines[1:25]:
        for marker in markers:
            if marker in line:
                return True
    return False
