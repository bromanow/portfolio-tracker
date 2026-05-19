"""
Portfolio service: calculates current positions from transactions.
"""
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
import logging
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.models.transactions import Transaction
from app.models.master import Account, Security
from app.models.prices import MarketPrice
from app.services.acb_service import get_all_positions_acb

logger = logging.getLogger(__name__)
ZERO = Decimal("0")


def _enrich_with_price(pos: dict, mp: Optional[MarketPrice], multiplier: int = 1) -> None:
    """
    Add current price, market value, and unrealized P&L fields to a position dict.
    All values are in CAD. Modifies pos in place.
    multiplier: 100 for options (1 contract = 100 shares), 1 for everything else.
    """
    if mp is None or mp.price is None:
        pos.update({
            "current_price": None,
            "current_price_cad": None,
            "price_currency": None,
            "price_source": None,
            "market_value_cad": None,
            "unrealized_pnl_cad": None,
            "unrealized_pnl_pct": None,
            "day_change_pct": None,
            "day_change": None,
            "day_change_cad": None,
            "day_gain_cad": None,
            "price_date": None,
            "fetched_at": None,
            "fetch_ticker": None,
        })
        return

    qty = pos["quantity"]  # Decimal
    total_acb = pos["total_acb_cad"]  # Decimal

    price_cad = mp.price_cad
    if price_cad is not None and qty != ZERO:
        market_value_cad = (price_cad * qty * Decimal(str(multiplier))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        unrealized_pnl_cad = market_value_cad - total_acb
        if total_acb != ZERO:
            unrealized_pnl_pct = (unrealized_pnl_cad / abs(total_acb) * Decimal("100")).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            )
        else:
            unrealized_pnl_pct = None
    else:
        market_value_cad = None
        unrealized_pnl_cad = None
        unrealized_pnl_pct = None

    if mp.day_change is not None and mp.price and mp.price > 0 and mp.price_cad:
        fx = mp.price_cad / mp.price
        day_change_cad_val = (mp.day_change * fx).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        day_gain_cad_val = (day_change_cad_val * qty * Decimal(str(multiplier))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    else:
        day_change_cad_val = None
        day_gain_cad_val = None

    pos.update({
        "current_price": str(mp.price),
        "current_price_cad": str(price_cad) if price_cad is not None else None,
        "price_currency": mp.currency,
        "price_source": mp.source,
        "market_value_cad": str(market_value_cad) if market_value_cad is not None else None,
        "unrealized_pnl_cad": str(unrealized_pnl_cad) if unrealized_pnl_cad is not None else None,
        "unrealized_pnl_pct": str(unrealized_pnl_pct) if unrealized_pnl_pct is not None else None,
        "day_change_pct": str(mp.day_change_pct) if mp.day_change_pct is not None else None,
        "day_change": str(mp.day_change) if mp.day_change is not None else None,
        "day_change_cad": str(day_change_cad_val) if day_change_cad_val is not None else None,
        "day_gain_cad": str(day_gain_cad_val) if day_gain_cad_val is not None else None,
        "price_date": mp.price_date.isoformat() if mp.price_date else None,
        "fetched_at": mp.fetched_at.isoformat() if mp.fetched_at else None,
        "fetch_ticker": mp.fetch_ticker,
    })


def _enrich_with_historical_price(pos: dict, price_info: Optional[dict], price_date: Optional[date] = None, multiplier: int = 1) -> None:
    """Enrich a position dict with historical price data.

    price_info is a dict with keys: close_price_cad, close_price, currency, price_date
    (as returned by get_historical_price_map_rich).
    """
    actual_price_date = (price_info or {}).get("price_date") or price_date
    date_str = actual_price_date.isoformat() if actual_price_date else None

    if price_info is None:
        pos.update({
            "current_price": None, "current_price_cad": None, "price_currency": None,
            "market_value_cad": None, "unrealized_pnl_cad": None, "unrealized_pnl_pct": None,
            "day_change_pct": None, "price_date": date_str,
            "fetched_at": None, "fetch_ticker": None,
        })
        return

    price_cad = price_info.get("close_price_cad")
    price_native = price_info.get("close_price")
    currency = price_info.get("currency") or "CAD"

    if price_cad is None:
        # Native price exists but no CAD conversion — can't compute market value
        pos.update({
            "current_price": str(price_native) if price_native is not None else None,
            "current_price_cad": None, "price_currency": currency,
            "market_value_cad": None, "unrealized_pnl_cad": None, "unrealized_pnl_pct": None,
            "day_change_pct": None, "price_date": date_str,
            "fetched_at": None, "fetch_ticker": None,
        })
        return

    qty = Decimal(str(pos["quantity"]))
    acb = Decimal(str(pos["total_acb_cad"]))
    mkt = (price_cad * qty * Decimal(str(multiplier))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    pnl = mkt - acb
    pnl_pct = ((pnl / abs(acb)) * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if acb != ZERO else None

    # Use native price for display when available (e.g. USD for US securities);
    # fall back to CAD price for CAD securities or when native is absent.
    display_price = price_native if (price_native is not None and currency != "CAD") else price_cad

    pos.update({
        "current_price": str(display_price),
        "current_price_cad": str(price_cad),
        "price_currency": currency,
        "market_value_cad": str(mkt), "unrealized_pnl_cad": str(pnl),
        "unrealized_pnl_pct": str(pnl_pct) if pnl_pct is not None else None,
        "day_change_pct": None,
        "price_date": date_str,
        "fetched_at": None, "fetch_ticker": None,
    })


def get_positions(
    db: Session,
    account_id: Optional[int] = None,
    as_of: Optional[date] = None,
    include_expired_options: bool = False,
) -> list[dict]:
    """
    Calculate current positions (holdings) from transactions.
    Returns list of position dicts per (account, security), including price data.
    When as_of is a past date, uses HistoricalPrice instead of current MarketPrice.

    include_expired_options: when False (default) options whose expiry date has
    already passed are excluded — they have no market value and should not appear
    as holdings. Set True in get_options_report() so the 30-day grace window for
    missing expiry transactions still works.
    """
    from app.services.price_service import get_historical_price_map_rich, parse_option_ticker

    acb_data = get_all_positions_acb(db, account_id, as_of)
    use_historical = as_of is not None  # historical_prices now includes intraday via refresh
    today_date = date.today()
    # When viewing historical positions use as_of as the reference so options
    # that had not yet expired on that date are included.
    expiry_reference = as_of if use_historical else today_date

    # Batch-load Security and Account records upfront to avoid N+1 queries.
    non_zero_acbs = [a for a in acb_data if a["quantity"] != ZERO]
    all_sec_ids = {a["security_id"] for a in non_zero_acbs}
    all_acct_ids = {a["account_id"] for a in non_zero_acbs}
    sec_map: dict[int, Security] = (
        {s.id: s for s in db.query(Security).filter(Security.id.in_(all_sec_ids)).all()}
        if all_sec_ids else {}
    )
    acct_map: dict[int, Account] = (
        {a.id: a for a in db.query(Account).filter(Account.id.in_(all_acct_ids)).all()}
        if all_acct_ids else {}
    )

    positions = []
    for acb in acb_data:
        if acb["quantity"] == ZERO:
            continue

        sec = sec_map.get(acb["security_id"])
        acct = acct_map.get(acb["account_id"])
        if not sec or not acct:
            continue

        # Skip expired options unless the caller explicitly wants them
        if not include_expired_options and sec.is_option:
            parsed_opt = parse_option_ticker(sec.ticker, security=sec)
            if parsed_opt and parsed_opt["expiry"] < expiry_reference:
                continue

        pos = {
            "account_id": acb["account_id"],
            "account_name": acct.name,
            "account_type": acct.account_type,
            "security_id": acb["security_id"],
            "ticker": sec.ticker,
            "security_name": sec.name,
            "asset_class": sec.asset_class,
            "exchange": sec.exchange,
            "quantity": acb["quantity"],
            "acb_per_share_cad": acb["acb_per_share_cad"],
            "total_acb_cad": acb["total_acb_cad"],
            "currency": sec.currency or acct.base_currency,
        }
        positions.append(pos)

    # Always load the live price map — needed for day-gain even in historical mode
    price_map: dict[int, MarketPrice] = {mp.security_id: mp for mp in db.query(MarketPrice).all()}

    if use_historical:
        # Bulk-fetch historical prices for all positions at once
        hist_map = get_historical_price_map_rich(db, list({p["security_id"] for p in positions}), as_of)
        for pos in positions:
            sec = sec_map.get(pos["security_id"])
            multiplier = 100 if (sec and sec.is_option) else 1
            _enrich_with_historical_price(pos, hist_map.get(pos["security_id"]), as_of, multiplier=multiplier)
            # Correct currency: options imported via CAD accounts get sec.currency=NULL,
            # falling back to account base currency (CAD) even for US options like CRWD.
            # Use the historical close_price currency as the authoritative trading currency.
            if sec and sec.is_option and not sec.currency:
                actual_ccy = pos.get("price_currency")
                if actual_ccy:
                    pos["currency"] = actual_ccy
            # Overlay day-gain from live prices (always a real-time metric)
            mp = price_map.get(pos["security_id"])
            qty = pos["quantity"]
            if mp and mp.day_change is not None and mp.price and mp.price > 0 and mp.price_cad:
                fx = mp.price_cad / mp.price
                day_change_cad_val = (mp.day_change * fx).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
                day_gain_cad_val = (day_change_cad_val * qty * Decimal(str(multiplier))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                pos["day_change"] = str(mp.day_change)
                pos["day_change_pct"] = str(mp.day_change_pct) if mp.day_change_pct is not None else None
                pos["day_change_cad"] = str(day_change_cad_val)
                pos["day_gain_cad"] = str(day_gain_cad_val)
    else:
        # Use live cached prices (price_map already loaded above)
        for pos in positions:
            sec = sec_map.get(pos["security_id"])
            multiplier = 100 if (sec and sec.is_option) else 1
            _enrich_with_price(pos, price_map.get(pos["security_id"]), multiplier=multiplier)
            # Correct currency: options imported via CAD accounts get sec.currency=NULL,
            # falling back to account base currency (CAD) even for US options like CRWD.
            # Use the MarketPrice currency as the authoritative trading currency.
            if sec and sec.is_option and not sec.currency:
                actual_ccy = pos.get("price_currency")
                if actual_ccy:
                    pos["currency"] = actual_ccy

    return positions


def get_portfolio_summary(db: Session, as_of: Optional[date] = None) -> dict:
    """
    Summary of portfolio by account.
    """
    positions = get_positions(db, as_of=as_of)

    by_account: dict[int, dict] = {}
    total_cost_cad = ZERO

    for pos in positions:
        acct_id = pos["account_id"]
        if acct_id not in by_account:
            by_account[acct_id] = {
                "account_id": acct_id,
                "account_name": pos["account_name"],
                "account_type": pos["account_type"],
                "total_cost_cad": ZERO,
                "position_count": 0,
            }
        by_account[acct_id]["total_cost_cad"] += pos["total_acb_cad"]
        by_account[acct_id]["position_count"] += 1
        total_cost_cad += pos["total_acb_cad"]

    return {
        "total_cost_cad": total_cost_cad,
        "accounts": list(by_account.values()),
        "position_count": len(positions),
        "as_of": as_of or date.today(),
    }


def get_realized_pnl(
    db: Session,
    account_id: Optional[int] = None,
    year: Optional[int] = None,
    brokerage_name: Optional[str] = None,
) -> list[dict]:
    """
    Retrieve realized P&L from ACB calculations.
    Each row includes account_name and brokerage_name for display and filtering.
    """
    from app.models.master import Account as _Account
    acb_data = get_all_positions_acb(db, account_id)

    # Cache account lookups to avoid N+1 queries
    acct_cache: dict = {}

    def _get_acct(aid):
        if aid not in acct_cache:
            acct_cache[aid] = db.get(_Account, aid)
        return acct_cache[aid]

    pnl_rows = []

    for acb in acb_data:
        acct = _get_acct(acb["account_id"])
        acct_name = acct.name if acct else ""
        # brokerage name is on the related Brokerage object, not on Account directly
        brokerage = (acct.brokerage.name if acct and acct.brokerage else "") if acct else ""

        # Server-side brokerage filter
        if brokerage_name and brokerage != brokerage_name:
            continue

        for gain in acb.get("realized_gains", []):
            if year and gain["date"].year != year:
                continue
            pnl_rows.append({
                "security_id": acb["security_id"],
                "ticker": acb["ticker"],
                "account_id": acb["account_id"],
                "account_name": acct_name,
                "brokerage_name": brokerage,
                "date": gain["date"],
                "quantity": gain["quantity"],
                "proceeds_cad": gain["proceeds_cad"],
                "acb_cad": gain["acb_cad"],
                "gain_cad": gain["gain_cad"],
                "transaction_id": gain["transaction_id"],
            })

    return sorted(pnl_rows, key=lambda x: x["date"])


def get_recent_transactions(db: Session, limit: int = 20) -> list[Transaction]:
    return (
        db.query(Transaction)
        .order_by(Transaction.transaction_date.desc(), Transaction.id.desc())
        .limit(limit)
        .all()
    )


def get_asset_allocation(db: Session, as_of: Optional[date] = None) -> list[dict]:
    """Group positions by asset class."""
    positions = get_positions(db, as_of=as_of)
    by_class: dict[str, Decimal] = {}

    for pos in positions:
        cls = pos["asset_class"]
        by_class[cls] = by_class.get(cls, ZERO) + pos["total_acb_cad"]

    total = sum(by_class.values()) or Decimal("1")
    return [
        {"asset_class": k, "total_cad": v, "pct": float(v / total * 100)}
        for k, v in sorted(by_class.items(), key=lambda x: -x[1])
    ]


# Transaction types that have NO cash impact (pure quantity adjustments)
# DRIP = dividend reinvestment: shares acquired with no actual cash movement.
# JOURNAL = in-kind security transfer between accounts (book value entry, no cash changes hands).
#   e.g. DLR journalled from USD account to CAD account for Norbert's Gambit; the BUY in the
#   source account is the real cash outflow — the JOURNAL leg is purely a book entry.
# Exclude all of these from cash balance calculations.
CASH_NEUTRAL_TYPES = {"OPENING_BALANCE", "REVERSE_SPLIT", "FORWARD_SPLIT", "STOCK_DIVIDEND", "DRIP", "JOURNAL"}


def get_cash_balances(
    db: Session,
    account_id: Optional[int] = None,
    as_of: Optional[date] = None,
) -> list[dict]:
    """
    Calculate current cash balance per account, per currency.

    Returns one entry per (account, currency). For CASH_OPENING transactions the
    native transaction_currency/transaction_amount is used so that a USD opening
    balance is tracked in USD and later converted to CAD. All other transactions use
    account_currency_amount which the parsers already store in the account's base
    currency (FX-converted at trade time).
    """
    from app.models.master import Account as AcctModel
    from app.services.fx_service import get_rate
    accts_q = db.query(AcctModel)
    if account_id:
        accts_q = accts_q.filter(AcctModel.id == account_id)
    accounts = accts_q.all()

    today = date.today()
    # Use as_of date for FX conversion so balance_cad is consistent with the
    # exchange rate the caller will use to convert back to native currency.
    rate_date = as_of if as_of else today
    result = []
    for acct in accounts:
        # Two DRIP formats exist across brokerages:
        #   Scotia Wealth DRIP: amount is POSITIVE (dividend income reinvested in-place;
        #     no separate DIVIDEND row; net cash = $0 → correctly cash-neutral).
        #   iTrade DRIP: amount is NEGATIVE (actual share purchase; a separate DIVIDEND
        #     row already credited the income → the purchase debit must reduce cash).
        # We include DRIPs only when their account_currency_amount is negative (iTrade style).
        # Note: IBKR-imported transactions leave account_currency_amount NULL (they populate
        # transaction_amount and cad_amount instead).  The filter below does NOT gate on
        # account_currency_amount so that IBKR transactions are included; the balance
        # accumulation loop uses transaction_amount / cad_amount as fallbacks.
        from sqlalchemy import or_, and_ as sqland_
        txn_q = (
            db.query(Transaction)
            .filter(
                Transaction.account_id == acct.id,
                or_(
                    Transaction.transaction_type.notin_(CASH_NEUTRAL_TYPES),
                    # DRIP inclusion rules (three formats across brokerages):
                    #   amount < 0              → iTrade DRIP purchase (real cash outflow)
                    #   amount > 0, quantity = 0 → iTrade DRP income (dividend paid in cash,
                    #                              separate BUY row handles the share purchase)
                    #   amount > 0, quantity > 0 → Scotia Wealth reinvestment (dividend never
                    #                              hit cash — stay excluded / cash-neutral)
                    #   amount IS NULL          → IBKR DRIP (cash-neutral reinvestment; stays
                    #                              excluded because neither condition is met)
                    sqland_(
                        Transaction.transaction_type == "DRIP",
                        or_(
                            Transaction.account_currency_amount < 0,
                            sqland_(
                                Transaction.account_currency_amount > 0,
                                or_(Transaction.quantity == 0, Transaction.quantity.is_(None)),
                            ),
                        ),
                    ),
                ),
            )
        )
        if as_of:
            txn_q = txn_q.filter(Transaction.transaction_date <= as_of)

        # Two buckets:
        #   base_ccy  – running total in account's base currency (all regular trades)
        #   foreign   – {ccy: native_amount} for CASH_OPENING in foreign currency
        base_ccy = acct.base_currency
        base_balance = ZERO
        foreign: dict[str, Decimal] = {}

        for txn in txn_q.all():
            if txn.transaction_type == "CASH_OPENING":
                ccy = (txn.transaction_currency or base_ccy).upper()
                amount = txn.transaction_amount or ZERO
                if ccy == base_ccy:
                    base_balance += amount
                else:
                    foreign[ccy] = foreign.get(ccy, ZERO) + amount
            else:
                # Currency-routing (mirrors _sub_account_impact / cash-statement logic):
                # - Same currency as account → transaction_amount is the reliable native figure
                #   (account_currency_amount may hold a CAD-converted value for USD accounts
                #   due to legacy import behaviour — transaction_amount is always native)
                # - Cross-currency transaction → prefer account_currency_amount (FX-converted
                #   to account base currency by the import parser); fall back to cad_amount
                #   for IBKR-imported rows where account_currency_amount is NULL.
                tx_ccy = (txn.transaction_currency or base_ccy).upper()
                if tx_ccy == base_ccy.upper():
                    amount = txn.transaction_amount if txn.transaction_amount is not None else (txn.account_currency_amount or ZERO)
                else:
                    if txn.account_currency_amount is not None:
                        amount = txn.account_currency_amount
                    elif txn.cad_amount is not None:
                        amount = txn.cad_amount   # IBKR: already converted to CAD at import time
                    else:
                        amount = ZERO
                base_balance += amount

        # Emit base-currency entry
        if base_balance != ZERO:
            result.append({
                "account_id": acct.id,
                "account_name": acct.name,
                "account_type": acct.account_type,
                "currency": base_ccy,
                "balance": str(base_balance),
                "balance_cad": str(
                    base_balance if base_ccy == "CAD"
                    else (base_balance * (get_rate(db, rate_date, base_ccy, "CAD") or ZERO))
                ),
            })

        # Emit foreign-currency entries (e.g. USD cash in a CAD account)
        for ccy, balance in foreign.items():
            if balance == ZERO:
                continue
            fx = get_rate(db, rate_date, ccy, "CAD") or ZERO
            balance_cad = (balance * fx).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if fx else None
            result.append({
                "account_id": acct.id,
                "account_name": acct.name,
                "account_type": acct.account_type,
                "currency": ccy,
                "balance": str(balance),
                "balance_cad": str(balance_cad) if balance_cad is not None else None,
            })

    return result


def get_investment_income(
    db: Session,
    account_id: Optional[int] = None,
    year: Optional[int] = None,
    brokerage_name: Optional[str] = None,
) -> list[dict]:
    """Return dividend, interest, and other income transactions."""
    INCOME_TYPES = {"DIVIDEND", "INTEREST", "DRIP", "RETURN_OF_CAPITAL", "REINVESTMENT"}
    q = db.query(Transaction).filter(Transaction.transaction_type.in_(INCOME_TYPES))
    if account_id:
        q = q.filter(Transaction.account_id == account_id)
    if year:
        from sqlalchemy import extract
        q = q.filter(extract('year', Transaction.transaction_date) == year)
    if brokerage_name:
        from app.models.master import Brokerage as _Brokerage
        q = (q.join(Account, Transaction.account_id == Account.id)
              .join(_Brokerage, Account.brokerage_id == _Brokerage.id)
              .filter(_Brokerage.name == brokerage_name))
    q = q.order_by(Transaction.transaction_date)

    acct_cache: dict = {}

    def _get_acct(aid):
        if aid not in acct_cache:
            acct_cache[aid] = db.get(Account, aid)
        return acct_cache[aid]

    rows = []
    for txn in q.all():
        sec = db.get(Security, txn.security_id) if txn.security_id else None
        acct = _get_acct(txn.account_id)
        amount_cad = txn.cad_amount if txn.cad_amount is not None else txn.account_currency_amount
        # Two DRIP formats exist across brokerages:
        #   Scotia Wealth DRIP: amount is POSITIVE — dividend reinvested in-place with no
        #     separate DIVIDEND row.  This IS the income event; include it.
        #   iTrade DRIP: amount is NEGATIVE — this is the share *purchase*, not the income.
        #     Income is already captured by a separate DIVIDEND transaction; skip the DRIP
        #     here to avoid double-counting.
        if txn.transaction_type == "DRIP" and amount_cad is not None:
            if amount_cad < 0:
                continue   # iTrade purchase DRIP — income is in the separate DIVIDEND row
        rows.append({
            "date": txn.transaction_date.isoformat(),
            "year": txn.transaction_date.year,
            "account_id": txn.account_id,
            "account_name": acct.name if acct else "",
            "brokerage_name": (acct.brokerage.name if acct and acct.brokerage else ""),
            "ticker": sec.ticker if sec else "",
            "transaction_type": txn.transaction_type,
            "amount_cad": str(amount_cad) if amount_cad is not None else "0",
            "currency": txn.transaction_currency or "",
            "amount_native": str(txn.transaction_amount or txn.account_currency_amount or 0),
        })
    return rows


def get_options_report(db: Session, account_id: Optional[int] = None) -> dict:
    """
    Return a comprehensive options report:
    - open_positions: current option holdings enriched with parsed fields + underlying price
    - income: realized gains from option transactions (expiry, assignment, close)
    """
    from app.services.price_service import parse_option_ticker
    from app.models.prices import MarketPrice as _MP

    # Open positions (filter to options only).
    # include_expired_options=True so the 30-day grace window for missing expiry
    # transactions is visible on the Options page; the DTE < -30 filter below
    # handles trimming anything older than that.
    all_positions = get_positions(db, account_id=account_id, include_expired_options=True)
    open_options = [p for p in all_positions if p.get("asset_class") == "OPTION"]

    today = date.today()
    enriched_options = []
    for p in open_options:
        sec = db.get(Security, p["security_id"])
        parsed = parse_option_ticker(p["ticker"], security=sec)
        if parsed:
            dte = (parsed["expiry"] - today).days
            # Skip options that expired more than 30 days ago — those are stale
            # records that almost certainly pre-date this system. Options that
            # expired within the last 30 days are surfaced so the user can record
            # the missing OPTION_EXPIRY transaction (IB often omits these).
            if dte < -30:
                continue
            p["underlying_ticker"] = parsed["underlying"]
            p["option_type"] = parsed["option_type"]
            p["strike"] = parsed["strike"]
            p["expiry_date"] = parsed["expiry"].isoformat()
            p["days_to_expiry"] = dte
            p["is_canadian"] = parsed["is_canadian"]
        else:
            p["underlying_ticker"] = None
            p["option_type"] = None
            p["strike"] = None
            p["expiry_date"] = None
            p["days_to_expiry"] = None
            p["is_canadian"] = False
        enriched_options.append(p)
    open_options = enriched_options

    # Bulk-fetch underlying security prices for all open options
    underlying_tickers = {
        p["underlying_ticker"] for p in open_options if p.get("underlying_ticker")
    }
    if underlying_tickers:
        underlying_secs = (
            db.query(Security)
            .filter(Security.ticker.in_(underlying_tickers), Security.is_option == False)
            .all()
        )
        underlying_id_map = {s.ticker: s.id for s in underlying_secs}
        underlying_prices = {
            mp.security_id: mp
            for mp in db.query(_MP).filter(
                _MP.security_id.in_(list(underlying_id_map.values()))
            ).all()
        }
        # Build ticker → price dict
        underlying_price_map: dict[str, dict] = {}
        for ticker, sec_id in underlying_id_map.items():
            mp = underlying_prices.get(sec_id)
            if mp and mp.price is not None:
                underlying_price_map[ticker] = {
                    "price": str(mp.price),
                    "price_cad": str(mp.price_cad) if mp.price_cad else None,
                    "currency": mp.currency,
                }
    else:
        underlying_price_map = {}

    # Build map of (account_id, ticker) -> position for underlying equity lookup
    # We need positions filtered by account to match covered calls correctly
    all_non_option_positions = [p for p in all_positions if p.get("asset_class") != "OPTION"]
    underlying_pos_map: dict[tuple, dict] = {}
    for p in all_non_option_positions:
        key = (p["account_id"], p["ticker"])
        underlying_pos_map[key] = p

    # Attach underlying price, ITM/OTM, and same-account underlying position to each open option
    for p in open_options:
        ut = p.get("underlying_ticker")
        up = underlying_price_map.get(ut) if ut else None
        if up:
            p["underlying_price"] = up["price"]
            p["underlying_price_cad"] = up["price_cad"]
            p["underlying_price_currency"] = up["currency"]
            # ITM/OTM calculation
            try:
                upr = float(up["price"])
                strike = float(p["strike"])
                opt_type = p.get("option_type", "")
                if opt_type == "CALL":
                    p["itm"] = upr > strike
                    p["moneyness"] = round(upr - strike, 4)
                else:
                    p["itm"] = upr < strike
                    p["moneyness"] = round(strike - upr, 4)
            except (TypeError, ValueError):
                p["itm"] = None
                p["moneyness"] = None
        else:
            p["underlying_price"] = None
            p["underlying_price_cad"] = None
            p["underlying_price_currency"] = None
            p["itm"] = None
            p["moneyness"] = None

        # Attach same-account underlying equity position (for covered call detection)
        acct_id = p.get("account_id")
        underlying_pos = underlying_pos_map.get((acct_id, ut)) if (acct_id and ut) else None
        if underlying_pos:
            p["underlying_position_qty"] = str(underlying_pos["quantity"])
            p["underlying_position_acb_cad"] = str(underlying_pos["total_acb_cad"])
        else:
            p["underlying_position_qty"] = None
            p["underlying_position_acb_cad"] = None

    # Option income: realized gains from option securities
    realized = get_realized_pnl(db, account_id=account_id)
    option_income = []
    for r in realized:
        ticker = r.get("ticker", "")
        sec = db.query(Security).filter(Security.ticker == ticker).first()
        parsed = parse_option_ticker(ticker, security=sec)
        if parsed is None:
            continue  # not an option
        txn = db.get(Transaction, r["transaction_id"]) if r.get("transaction_id") else None

        # Determine direction from the closing transaction type and proceeds/acb sign.
        # acb_cad sign alone is unreliable: for short expiry acb_cad=0 (no cost),
        # and for buy-to-close acb_cad is the buy cost (positive), both would be
        # misidentified as LONG under the old sign check.
        close_type = txn.transaction_type if txn else None
        try:
            proceeds_val = float(r["proceeds_cad"])
            acb_val = float(r["acb_cad"])
        except (TypeError, ValueError):
            proceeds_val, acb_val = 0.0, 0.0

        if close_type == "OPTION_BUY":
            # Buy-to-close always closes a short position
            direction = "SHORT"
        elif close_type == "OPTION_SELL":
            # Sell-to-close always closes a long position
            direction = "LONG"
        elif close_type in ("OPTION_EXPIRY", "OPTION_ASSIGNMENT", "OPTION_EXERCISE"):
            # For expiry/assignment: if the closing event generated proceeds (premium
            # received) the position was short; if it generated a cost basis loss it was long.
            direction = "SHORT" if proceeds_val > 0 else "LONG"
        else:
            # Fallback for legacy/unexpected close types
            direction = "SHORT" if acb_val < 0 else "LONG"

        option_income.append({
            "date": r["date"].isoformat() if hasattr(r["date"], "isoformat") else str(r["date"]),
            "ticker": ticker,
            "underlying_ticker": parsed["underlying"],
            "option_type": parsed["option_type"],
            "strike": parsed["strike"],
            "expiry_date": parsed["expiry"].isoformat(),
            "account_id": r["account_id"],
            "quantity": str(r["quantity"]),
            "proceeds_cad": str(r["proceeds_cad"]),
            "acb_cad": str(r["acb_cad"]),
            "gain_cad": str(r["gain_cad"]),
            "close_type": txn.transaction_type if txn else None,
            "currency": sec.currency if sec else None,
            "direction": direction,
        })

    # Summary metrics
    total_exposure = sum(float(p.get("market_value_cad") or 0) for p in open_options)
    total_unrealized = sum(float(p.get("unrealized_pnl_cad") or 0) for p in open_options)
    total_income = sum(float(r["gain_cad"]) for r in option_income)

    return {
        "open_positions": open_options,
        "income": option_income,
        "summary": {
            "open_contracts": len(open_options),
            "total_exposure_cad": str(round(total_exposure, 2)),
            "unrealized_pnl_cad": str(round(total_unrealized, 2)),
            "total_income_cad": str(round(total_income, 2)),
        },
    }


def get_portfolio_history(
    db: Session,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    interval: str = "monthly",
    account_id: Optional[int] = None,
    account_ids: Optional[list[int]] = None,
) -> list[dict]:
    """
    Return portfolio value snapshots over a date range.
    Each point includes: date, book_value_cad, market_value_cad, cash_cad, total_value_cad.

    Requires historical prices to have been fetched first via fetch_historical_prices().
    Points where no prices are available will have market_value_cad = None.
    """
    from datetime import timedelta
    import calendar
    from app.services.price_service import get_historical_price_map

    # Determine date bounds from transactions if not supplied
    if to_date is None:
        to_date = date.today()
    if from_date is None:
        earliest = db.query(func.min(Transaction.transaction_date)).scalar()
        from_date = earliest.date() if earliest and hasattr(earliest, 'date') else (
            earliest if earliest else date(to_date.year - 5, to_date.month, to_date.day)
        )

    # Generate sample dates
    sample_dates: list[date] = []
    if interval == "daily":
        d = from_date
        while d <= to_date:
            sample_dates.append(d)
            d += timedelta(days=1)
    elif interval == "weekly":
        # Mondays
        d = from_date
        # advance to next Monday
        if d.weekday() != 0:
            d += timedelta(days=(7 - d.weekday()))
        while d <= to_date:
            sample_dates.append(d)
            d += timedelta(weeks=1)
    else:  # monthly — last day of each month
        y, m = from_date.year, from_date.month
        while True:
            last_day = calendar.monthrange(y, m)[1]
            d = date(y, m, last_day)
            if d > to_date:
                # Include to_date itself as the final point
                if not sample_dates or sample_dates[-1] != to_date:
                    sample_dates.append(to_date)
                break
            sample_dates.append(d)
            m += 1
            if m > 12:
                m = 1
                y += 1

    results = []
    for sample_date in sample_dates:
        # Positions as of this date (quantity + ACB)
        # Use account_ids filter: get all then filter, or pass single account_id
        _acct_id = account_id if not account_ids else None
        positions = get_all_positions_acb(db, account_id=_acct_id, as_of=sample_date)
        if account_ids:
            acct_id_set = set(account_ids)
            positions = [p for p in positions if p["account_id"] in acct_id_set]
        active = [p for p in positions if Decimal(str(p["quantity"])) > ZERO]

        if not active:
            results.append({
                "date": sample_date.isoformat(),
                "book_value_cad": "0",
                "market_value_cad": None,
                "cash_cad": "0",
                "total_value_cad": None,
            })
            continue

        book_value = sum(Decimal(str(p["total_acb_cad"])) for p in active)

        # Historical prices for all held securities
        security_ids = list({p["security_id"] for p in active})
        price_map = get_historical_price_map(db, security_ids, sample_date)

        market_value: Optional[Decimal] = None
        has_prices = any(price_map.get(p["security_id"]) is not None for p in active)
        if has_prices:
            market_value = ZERO
            for p in active:
                price_cad = price_map.get(p["security_id"])
                if price_cad is not None:
                    market_value += Decimal(str(p["quantity"])) * price_cad
                else:
                    # Fall back to ACB for unpriced positions so total is still meaningful
                    market_value += Decimal(str(p["total_acb_cad"]))

        # Cash as of this date
        cash_rows = get_cash_balances(db, account_id=_acct_id, as_of=sample_date)
        if account_ids:
            cash_rows = [r for r in cash_rows if r["account_id"] in acct_id_set]
        cash_cad = sum(Decimal(str(r["balance_cad"] or 0)) for r in cash_rows)

        total_value = (market_value + cash_cad) if market_value is not None else None

        results.append({
            "date": sample_date.isoformat(),
            "book_value_cad": str(book_value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "market_value_cad": str(market_value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if market_value is not None else None,
            "cash_cad": str(cash_cad.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "total_value_cad": str(total_value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if total_value is not None else None,
        })

    return results


def get_portfolio_continuity(
    db: Session,
    from_date: date,
    to_date: date,
    account_ids: Optional[list[int]] = None,
) -> dict:
    """
    Compute a continuity/waterfall report for a date range:
      Opening Balance
      + Contributions (DEPOSIT)
      + Withdrawals   (WITHDRAWAL)
      ± Transfers     (JOURNAL)
      + Dividends & Interest (DIVIDEND, DRIP, INTEREST, RETURN_OF_CAPITAL, REINVESTMENT)
      + Realized Gains (from ACB engine)
      + Fees          (FEE, WITHHOLDING_TAX)
      ± Unrealized Gains Change
      = Closing Balance

    Opening = portfolio value (mkt or book + cash) as of (from_date - 1 day).
    Closing = portfolio value as of to_date.
    """
    from datetime import timedelta
    from app.services.acb_service import get_all_positions_acb
    from app.services.price_service import get_historical_price_map

    acct_id_set: Optional[set] = set(account_ids) if account_ids else None
    opening_date = from_date - timedelta(days=1)

    def _portfolio_value_at(as_of: date) -> tuple:
        """Returns (total_value, unrealized_pnl, has_market_prices).

        For today or future dates, uses live MarketPrice so the closing balance
        matches the dashboard.  For historical dates, uses HistoricalPrice.
        """
        today = date.today()
        use_live = as_of >= today

        # ACB: pass as_of=None (current) for live, or the specific date for historical
        acb_as_of = None if use_live else as_of
        all_pos = get_all_positions_acb(db, account_id=None, as_of=acb_as_of)
        if acct_id_set:
            all_pos = [p for p in all_pos if p["account_id"] in acct_id_set]
        active = [p for p in all_pos if Decimal(str(p["quantity"])) != ZERO]

        book_value = sum(Decimal(str(p["total_acb_cad"])) for p in active)

        market_value: Optional[Decimal] = None
        if use_live:
            # Live prices from MarketPrice table (same source as the dashboard summary bar)
            live_prices = {mp.security_id: mp for mp in db.query(MarketPrice).all()}
            mkt_vals = []
            for p in active:
                mp = live_prices.get(p["security_id"])
                if mp and mp.price_cad:
                    sec = db.get(Security, p["security_id"])
                    mult = 100 if (sec and sec.is_option) else 1
                    mkt_vals.append(mp.price_cad * Decimal(str(p["quantity"])) * Decimal(mult))
            if mkt_vals:
                market_value = sum(mkt_vals)
        else:
            # Historical prices (with split correction)
            sec_ids = list({p["security_id"] for p in active})
            price_map = get_historical_price_map(db, sec_ids, as_of) if sec_ids else {}

            if any(price_map.get(p["security_id"]) is not None for p in active):
                market_value = ZERO
                for p in active:
                    price_cad = price_map.get(p["security_id"])
                    if price_cad is not None:
                        market_value += Decimal(str(p["quantity"])) * price_cad
                    else:
                        # Fall back to ACB for any security without a historical price
                        market_value += Decimal(str(p["total_acb_cad"]))

        # Cash: no as_of for live (current balance), or historical as_of
        cash_rows = get_cash_balances(db, account_id=None, as_of=acb_as_of)
        if acct_id_set:
            cash_rows = [r for r in cash_rows if r["account_id"] in acct_id_set]
        cash_cad = sum(Decimal(str(r.get("balance_cad") or 0)) for r in cash_rows)

        sec_value = market_value if market_value is not None else book_value
        total = sec_value + cash_cad
        unrealized = (market_value - book_value) if market_value is not None else ZERO
        return total, unrealized, market_value is not None

    open_val, open_unrealized, open_has_prices = _portfolio_value_at(opening_date)
    close_val, close_unrealized, close_has_prices = _portfolio_value_at(to_date)

    # Transaction category sums
    CATS: dict[str, set] = {
        "contributions":      {"DEPOSIT"},
        "withdrawals":        {"WITHDRAWAL"},
        "transfers":          {"JOURNAL"},
        "dividends_interest": {"DIVIDEND", "DRIP", "INTEREST", "RETURN_OF_CAPITAL", "REINVESTMENT"},
        "fees":               {"FEE", "WITHHOLDING_TAX"},
    }
    totals: dict[str, Decimal] = {k: ZERO for k in CATS}

    q = db.query(Transaction).filter(
        Transaction.transaction_date >= from_date,
        Transaction.transaction_date <= to_date,
    )
    if acct_id_set:
        q = q.filter(Transaction.account_id.in_(list(acct_id_set)))

    for txn in q.all():
        amt = txn.cad_amount if txn.cad_amount is not None else txn.account_currency_amount
        if amt is None:
            continue
        for cat, types in CATS.items():
            if txn.transaction_type in types:
                totals[cat] += amt
                break

    # Realized gains in period from ACB engine
    all_realized = get_realized_pnl(db)
    realized = ZERO
    for r in all_realized:
        if acct_id_set and r["account_id"] not in acct_id_set:
            continue
        gain_date = r["date"]
        if isinstance(gain_date, str):
            gain_date = date.fromisoformat(gain_date)
        if from_date <= gain_date <= to_date:
            realized += Decimal(str(r["gain_cad"]))

    # Unrealized gains change
    unrealized_change = close_unrealized - open_unrealized

    def _fmt(v: Decimal) -> str:
        return str(v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

    return {
        "period_start": from_date.isoformat(),
        "period_end": to_date.isoformat(),
        "opening_balance": _fmt(open_val),
        "contributions": _fmt(totals["contributions"]),
        "withdrawals": _fmt(totals["withdrawals"]),
        "transfers": _fmt(totals["transfers"]),
        "dividends_interest": _fmt(totals["dividends_interest"]),
        "realized_gains": _fmt(realized),
        "fees": _fmt(totals["fees"]),
        "unrealized_gains_change": _fmt(unrealized_change),
        "closing_balance": _fmt(close_val),
        "has_market_prices": open_has_prices or close_has_prices,
    }
