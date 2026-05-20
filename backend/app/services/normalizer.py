"""
Normalizer: Maps parsed rows → Transaction records.
Handles FX enrichment, security creation, option contract creation.
"""
from datetime import date
from decimal import Decimal
from typing import Optional
import logging
from sqlalchemy.orm import Session

from app.models.master import Account, Security, BrokerageTypeMapping
from app.models.transactions import Transaction
from app.models.options import OptionContract
from app.services import fx_service

logger = logging.getLogger(__name__)


def get_or_create_security(db: Session, ticker: str, is_option: bool = False,
                             currency: Optional[str] = None, exchange: Optional[str] = None) -> Security:
    """Find or create a security record."""
    # Normalize ticker
    ticker = ticker.upper().strip() if ticker else "UNKNOWN"

    # Try to find by ticker (and exchange if provided)
    query = db.query(Security).filter(Security.ticker == ticker)
    if exchange:
        query = query.filter(Security.exchange == exchange)
    existing = query.first()

    if existing:
        return existing

    # Create new
    asset_class = "OPTION" if is_option else "EQUITY"
    sec = Security(
        ticker=ticker,
        exchange=exchange,
        asset_class=asset_class,
        currency=currency,
        is_option=is_option,
    )
    db.add(sec)
    db.flush()
    return sec


def get_or_create_option_contract(
    db: Session,
    option_symbol: str,
    underlying_ticker: str,
    option_type: str,
    strike: Decimal,
    expiry: date,
    currency: Optional[str] = None,
) -> tuple[Security, OptionContract]:
    """Find or create option security + contract."""
    # Option security uses full OCC or iTrade symbol as ticker
    opt_sec = get_or_create_security(db, option_symbol, is_option=True, currency=currency)
    # Backfill currency on existing record if missing
    if currency and not opt_sec.currency:
        opt_sec.currency = currency
        db.flush()

    # Underlying security — pass currency so price history uses the right currency
    underlying_sec = get_or_create_security(db, underlying_ticker, is_option=False, currency=currency)
    # Backfill currency on existing record if it was created without one
    if currency and not underlying_sec.currency:
        underlying_sec.currency = currency
        db.flush()

    # Option contract
    contract = db.query(OptionContract).filter(
        OptionContract.security_id == opt_sec.id
    ).first()

    if not contract:
        contract = OptionContract(
            security_id=opt_sec.id,
            underlying_security_id=underlying_sec.id,
            option_type=option_type.upper(),
            strike=strike,
            expiry_date=expiry,
            multiplier=100,
        )
        db.add(contract)
        db.flush()

    return opt_sec, contract


def compute_currency_amounts(
    db: Session,
    transaction_date: date,
    transaction_currency: str,
    account_currency: str,
    settlement_amount: Optional[Decimal],
    gross_amount: Optional[Decimal] = None,
    commission: Optional[Decimal] = None,
    fx_rate_override: Optional[Decimal] = None,
) -> dict:
    """
    Compute all 3 currency amounts:
    - transaction_amount (in transaction_currency)
    - account_currency_amount (in account base currency)
    - cad_amount (always in CAD)

    Returns dict with amounts and rates.
    """
    # Use settlement amount as the primary amount (net of commissions)
    amount = settlement_amount
    if amount is None and gross_amount is not None:
        amount = gross_amount
        if commission is not None:
            amount = gross_amount - abs(commission) if gross_amount > 0 else gross_amount + abs(commission)

    if amount is None:
        amount = Decimal("0")

    transaction_amount = amount

    # FX: transaction_currency → account_currency
    if transaction_currency == account_currency:
        fx_rate_to_account = Decimal("1")
        account_currency_amount = transaction_amount
    else:
        fx_rate_to_account = fx_rate_override
        if fx_rate_to_account is None:
            fx_rate_to_account = fx_service.get_rate(db, transaction_date, transaction_currency, account_currency)
        if fx_rate_to_account is None:
            fx_rate_to_account = Decimal("1")
            logger.warning("Using FX rate 1.0 for %s→%s on %s", transaction_currency, account_currency, transaction_date)
        account_currency_amount = transaction_amount * fx_rate_to_account

    # FX: account_currency → CAD
    if account_currency == "CAD":
        fx_rate_to_cad = Decimal("1")
        cad_amount = account_currency_amount
    elif account_currency == "USD":
        fx_rate_to_cad = fx_service.get_rate(db, transaction_date, "USD", "CAD")
        if fx_rate_to_cad is None:
            fx_rate_to_cad = Decimal("1.35")
            logger.warning("Using fallback FX rate 1.35 for USD→CAD on %s", transaction_date)
        cad_amount = account_currency_amount * fx_rate_to_cad
    else:
        fx_rate_to_cad = Decimal("1")
        cad_amount = account_currency_amount

    return {
        "transaction_amount": transaction_amount,
        "account_currency_amount": account_currency_amount,
        "cad_amount": cad_amount,
        "fx_rate_to_account": fx_rate_to_account,
        "fx_rate_to_cad": fx_rate_to_cad,
    }


def _apply_type_mapping(db: Session, account: Account, raw_activity: str, transaction_type: str) -> str:
    """Override transaction_type from the user-configured BrokerageTypeMapping table."""
    if not raw_activity or not account.brokerage_id:
        return transaction_type
    mapping = db.query(BrokerageTypeMapping).filter(
        BrokerageTypeMapping.brokerage_id == account.brokerage_id,
        BrokerageTypeMapping.raw_type == raw_activity,
    ).first()
    return mapping.canonical_type if mapping else transaction_type


def normalize_itrade_row(db: Session, row: dict, account: Account) -> Optional[dict]:
    """Convert a parsed iTrade / Scotia Wealth row to a Transaction-ready dict."""
    if not row.get("transaction_date"):
        return None

    transaction_type = row["transaction_type"]
    # Apply user-configured brokerage type mapping overrides
    transaction_type = _apply_type_mapping(db, account, row.get("raw_activity", ""), transaction_type)

    is_option = row.get("is_option", False)
    option_info = row.get("option_info")
    ticker = row.get("ticker", "")
    raw_symbol = row.get("raw_symbol", ticker)

    # Get/create security
    if is_option and option_info:
        opt_sec, _ = get_or_create_option_contract(
            db,
            raw_symbol,
            option_info["underlying"],
            option_info["option_type"],
            option_info["strike"],
            option_info["expiry"],
            currency=row.get("transaction_currency", account.base_currency),
        )
        security = opt_sec
    elif ticker:
        security = get_or_create_security(
            db, ticker,
            currency=row.get("transaction_currency", account.base_currency)
        )
    else:
        security = None

    # Compute currency amounts
    # ── Important iTrade/ScotiaMacleod FX note ──────────────────────────────
    # iTrade has two sub-accounts: CAD and USD.  The "Account Currency" CSV
    # column tells us which sub-account the row belongs to.
    #
    # CAD sub-account (row account_currency == "CAD"):
    #   Settlement amount is ALWAYS in CAD, even for USD securities.
    #   iTrade pre-converts at trade time, so we must NOT re-apply FX.
    #   e.g. BUY AMD: settlement = −928.64 CAD, transaction_currency = USD
    #
    # USD sub-account (row account_currency == "USD"):
    #   Settlement amount is in USD — needs FX conversion to CAD.
    #   e.g. BUY AMD: settlement = −22,587 USD, transaction_currency = USD
    # ────────────────────────────────────────────────────────────────────────
    settlement_amount = row.get("settlement_amount")
    transaction_currency = row.get("transaction_currency", account.base_currency)
    row_account_currency = row.get("account_currency", account.base_currency)  # from CSV column
    account_currency = account.base_currency
    fx_rate_override = row.get("fx_rate_in_desc")

    # The "already in CAD" shortcut applies only when the CSV sub-account
    # is the account's base currency (CAD).  USD sub-account rows need FX.
    settlement_pre_converted = (
        transaction_currency != account_currency
        and settlement_amount is not None
        and row_account_currency == account_currency
    )

    if settlement_pre_converted:
        # settlement_amount is already in CAD — avoid double-FX
        fx = fx_rate_override
        if fx is None:
            fx = fx_service.get_rate(db, row["transaction_date"], transaction_currency, account_currency)
        if not fx:
            fx = Decimal("1")
            logger.warning("Using FX rate 1.0 for %s→%s on %s", transaction_currency, account_currency, row["transaction_date"])
        amounts = {
            "transaction_amount": (settlement_amount / fx).quantize(Decimal("0.000001")),  # native currency (e.g. USD)
            "account_currency_amount": settlement_amount,  # CAD
            "cad_amount": settlement_amount,               # account is CAD for iTrade
            "fx_rate_to_account": fx,
            "fx_rate_to_cad": Decimal("1"),
        }
    else:
        # USD sub-account rows: settlement_amount is in transaction_currency (USD),
        # compute_currency_amounts will convert USD → CAD via FX lookup.
        amounts = compute_currency_amounts(
            db,
            row["transaction_date"],
            transaction_currency,
            account_currency,
            settlement_amount,
            fx_rate_override=fx_rate_override,
        )

    quantity = row.get("quantity")
    price = row.get("price")

    return {
        "account_id": account.id,
        "security_id": security.id if security else None,
        "transaction_date": row["transaction_date"],
        "settlement_date": row.get("settlement_date"),
        "transaction_type": transaction_type,
        "quantity": quantity,
        "price": price,
        "commission": None,  # iTrade includes commission in settlement amount
        "transaction_currency": transaction_currency,
        "transaction_amount": amounts["transaction_amount"],
        "account_currency_amount": amounts["account_currency_amount"],
        "cad_amount": amounts["cad_amount"],
        "fx_rate_to_account": amounts["fx_rate_to_account"],
        "fx_rate_to_cad": amounts["fx_rate_to_cad"],
        "raw_description": row.get("raw_description", ""),
        "notes": None,
        "tags": [],
    }


def normalize_ibkr_row(db: Session, row: dict, account: Account) -> Optional[dict]:
    """Convert a parsed IBKR history row to a Transaction-ready dict."""
    if not row.get("transaction_date"):
        return None

    transaction_type = row["transaction_type"]
    transaction_type = _apply_type_mapping(db, account, row.get("raw_activity", ""), transaction_type)
    is_option = row.get("is_option", False)
    option_info = row.get("option_info")
    ticker = row.get("ticker", "")
    raw_symbol = row.get("raw_symbol", ticker)

    # Get/create security
    if is_option and option_info:
        opt_sec, _ = get_or_create_option_contract(
            db,
            raw_symbol,
            option_info["underlying"],
            option_info["option_type"],
            option_info["strike"],
            option_info["expiry"],
            currency=row.get("transaction_currency", "USD"),
        )
        security = opt_sec
    elif ticker and transaction_type not in ("FX_ADJUSTMENT", "ADJUSTMENT"):
        security = get_or_create_security(
            db, ticker,
            currency=row.get("transaction_currency", "USD")
        )
    else:
        security = None

    # Compute currency amounts
    net_amount = row.get("net_amount")
    gross_amount = row.get("gross_amount")
    commission = row.get("commission")
    transaction_currency = row.get("transaction_currency", "USD")
    account_currency = account.base_currency

    # ── Important IBKR FX note ──────────────────────────────────────────────
    # IBKR's Transaction History CSV reports gross/net amounts in the account's
    # base currency (e.g. CAD for a CAD TFSA/RRSP), even when the security is
    # priced in USD.  The FX conversion has already been applied by IB.
    # So for a USD-priced trade in a CAD account:
    #   net_amount = −1211.74 CAD   (already converted by IB at their rate)
    #   transaction_currency = USD  (the price currency on the exchange)
    # We must NOT re-multiply by the FX rate (that would double-convert).
    # Instead: account_currency_amount = net_amount (CAD)
    #          transaction_amount       = net_amount / fx_rate  (USD)
    # This mirrors the same guard in normalize_itrade_row.
    # ────────────────────────────────────────────────────────────────────────
    if transaction_currency != account_currency and net_amount is not None:
        fx = fx_service.get_rate(db, row["transaction_date"], transaction_currency, account_currency)
        if not fx:
            fx = Decimal("1")
            logger.warning("Using FX rate 1.0 for %s→%s on %s", transaction_currency, account_currency, row["transaction_date"])
        amounts = {
            "transaction_amount": (net_amount / fx).quantize(Decimal("0.000001")),  # native currency (e.g. USD)
            "account_currency_amount": net_amount,   # already in account base currency (e.g. CAD)
            "cad_amount": net_amount,                # account is CAD for IBKR CAD accounts
            "fx_rate_to_account": fx,
            "fx_rate_to_cad": Decimal("1"),
        }
    else:
        amounts = compute_currency_amounts(
            db,
            row["transaction_date"],
            transaction_currency,
            account_currency,
            net_amount,
            gross_amount=gross_amount,
            commission=commission,
        )

    return {
        "account_id": account.id,
        "security_id": security.id if security else None,
        "transaction_date": row["transaction_date"],
        "settlement_date": row.get("settlement_date"),
        "transaction_type": transaction_type,
        "quantity": row.get("quantity"),
        "price": row.get("price"),
        "commission": commission,
        "transaction_currency": transaction_currency,
        "transaction_amount": amounts["transaction_amount"],
        "account_currency_amount": amounts["account_currency_amount"],
        "cad_amount": amounts["cad_amount"],
        "fx_rate_to_account": amounts["fx_rate_to_account"],
        "fx_rate_to_cad": amounts["fx_rate_to_cad"],
        "raw_description": row.get("raw_description", ""),
        "notes": None,
        "tags": [],
    }


def check_duplicate(db: Session, txn_dict: dict) -> bool:
    """Check if a transaction already exists.

    Matches on: account + date + type + amount + quantity (when present).
    Including quantity prevents false duplicate detection for:
    - Partial fills (same day, same security, different lot sizes)
    - Reverse split paired rows (+qty row vs -qty row, both have $0 amount)

    For transactions with no security and no quantity (withdrawals, deposits,
    dividends, fees etc.) the description is also included in the match so that
    two legitimate same-date same-amount transactions to different beneficiaries
    (e.g. two RESP EAP withdrawals on the same day) are not falsely collapsed.

    Also catches the case where the same transaction was previously imported without
    a linked security (security_id=NULL) and is now being imported again with one.
    """
    base = [
        Transaction.account_id == txn_dict["account_id"],
        Transaction.transaction_date == txn_dict["transaction_date"],
        Transaction.transaction_type == txn_dict["transaction_type"],
        Transaction.transaction_amount == txn_dict.get("transaction_amount"),
    ]
    # Include quantity in the match so that partial fills and split paired rows
    # (same date/type/amount but different qty) are not treated as duplicates.
    qty = txn_dict.get("quantity")
    if qty is not None:
        base.append(Transaction.quantity == qty)

    security_id = txn_dict.get("security_id")

    # For transactions with no security and no quantity, also match on description.
    # This prevents two same-day same-amount cash transactions (e.g. two RESP
    # withdrawals to different beneficiaries) from being treated as duplicates.
    if not security_id and qty is None:
        desc = txn_dict.get("raw_description") or ""
        base.append(Transaction.raw_description == desc)

    # Exact match (with security if we have one)
    q = db.query(Transaction).filter(*base)
    if security_id:
        q = q.filter(Transaction.security_id == security_id)
    if q.first():
        return True
    # Also match against an existing record that has NO security linked yet
    # (prevents re-import of the same row after the security was later created)
    if security_id:
        q_null = db.query(Transaction).filter(
            *base,
            Transaction.security_id.is_(None),
        )
        if q_null.first():
            return True

    # Check for an existing IBKR Flex record for the same trade.
    # Flex imports use BUY/SELL even for options; CSV imports use OPTION_BUY/OPTION_SELL.
    # Amounts differ slightly (Flex uses tradeMoney; CSV uses IBKR's pre-converted Net Amount).
    # SELL quantities may be negative in CSV but positive in Flex, so compare ABS values.
    # Security records may differ between CSV and Flex for the same ticker (two different
    # security rows with the same ticker), so join through the securities table on ticker.
    from sqlalchemy import text as sqtext
    txn_type = txn_dict.get("transaction_type", "")
    base_type = txn_type.replace("OPTION_", "")  # OPTION_BUY → BUY, OPTION_SELL → SELL
    if base_type in ("BUY", "SELL") and security_id and qty is not None:
        abs_qty = float(abs(qty))
        # Get the ticker for the incoming security
        from app.models.master import Security
        sec = db.get(Security, security_id)
        if sec:
            row = db.execute(sqtext("""
                SELECT t.id FROM transactions t
                JOIN securities s ON s.id = t.security_id
                WHERE t.account_id = :acct
                  AND t.transaction_date = :dt
                  AND s.ticker = :ticker
                  AND ABS(COALESCE(t.quantity, 0)) BETWEEN :qty_lo AND :qty_hi
                  AND t.external_ref LIKE 'ibkr-trade-%'
                LIMIT 1
            """), {
                "acct": txn_dict["account_id"],
                "dt": txn_dict["transaction_date"],
                "ticker": sec.ticker,
                "qty_lo": abs_qty - 0.01,
                "qty_hi": abs_qty + 0.01,
            }).fetchone()
            if row:
                return True

    return False
