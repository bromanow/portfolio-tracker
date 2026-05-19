from datetime import date, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.dependencies import get_current_user, parse_account_ids, get_user_account_ids
from app.models.auth import User
from app.services import portfolio as portfolio_svc
from app.services.acb_service import get_all_positions_acb
from app import background_jobs

router = APIRouter(
    prefix="/api/portfolio",
    tags=["portfolio"],
    dependencies=[Depends(get_current_user)],  # all routes require auth
)


@router.get("/positions")
def get_positions(
    account_id: Optional[int] = Query(None),
    as_of: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if account_id is not None:
        allowed = get_user_account_ids(current_user, db)
        if allowed is not None and account_id not in allowed:
            raise HTTPException(status_code=403, detail="Access denied to this account")
    positions = portfolio_svc.get_positions(db, account_id=account_id, as_of=as_of)
    # Serialize Decimal and date fields (price fields are already str/None from _enrich_with_price)
    result = []
    for pos in positions:
        serialized = {}
        for k, v in pos.items():
            if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                serialized[k] = str(v)
            elif hasattr(v, "isoformat") and not isinstance(v, str):
                serialized[k] = v.isoformat()
            else:
                serialized[k] = v
        result.append(serialized)
    return result


@router.get("/summary")
def get_summary(
    as_of: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    summary = portfolio_svc.get_portfolio_summary(db, as_of=as_of)
    # Serialize
    summary["total_cost_cad"] = str(summary["total_cost_cad"])
    summary["as_of"] = summary["as_of"].isoformat() if hasattr(summary["as_of"], "isoformat") else str(summary["as_of"])
    for acct in summary["accounts"]:
        acct["total_cost_cad"] = str(acct["total_cost_cad"])
    return summary


@router.get("/pnl")
def get_pnl(
    account_id: Optional[int] = Query(None),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    year: Optional[int] = Query(None),
    brokerage_name: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = portfolio_svc.get_realized_pnl(
        db, account_id=account_id, year=year, brokerage_name=brokerage_name
    )
    authorized_ids = parse_account_ids(account_ids, current_user, db)
    if authorized_ids is not None:
        id_set = set(authorized_ids)
        rows = [r for r in rows if r.get("account_id") in id_set]
    for row in rows:
        row["date"] = row["date"].isoformat()
        row["proceeds_cad"] = str(row["proceeds_cad"])
        row["acb_cad"] = str(row["acb_cad"])
        row["gain_cad"] = str(row["gain_cad"])
        row["quantity"] = str(row["quantity"])
    return rows


@router.get("/acb")
def get_acb(
    account_id: Optional[int] = Query(None),
    as_of: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if account_id is not None:
        allowed = get_user_account_ids(current_user, db)
        if allowed is not None and account_id not in allowed:
            raise HTTPException(status_code=403, detail="Access denied to this account")
    acb_data = get_all_positions_acb(db, account_id=account_id, as_of=as_of)
    result = []
    for item in acb_data:
        serialized = {
            "security_id": item["security_id"],
            "account_id": item["account_id"],
            "ticker": item.get("ticker", ""),
            "asset_class": item.get("asset_class", ""),
            "quantity": str(item["quantity"]),
            "total_acb_cad": str(item["total_acb_cad"]),
            "acb_per_share_cad": str(item["acb_per_share_cad"]),
            "realized_gain_count": len(item.get("realized_gains", [])),
        }
        result.append(serialized)
    return result


@router.get("/allocation")
def get_allocation(
    as_of: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return portfolio_svc.get_asset_allocation(db, as_of=as_of)


@router.get("/positions/consolidated")
def get_consolidated_positions(
    as_of: Optional[date] = Query(None),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs to filter"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return positions grouped by ticker across all accounts combined, with live price data."""
    from decimal import Decimal, ROUND_HALF_UP
    from collections import defaultdict
    from app.models.prices import MarketPrice
    from app.models.master import Security

    authorized_ids = parse_account_ids(account_ids, current_user, db)

    positions = portfolio_svc.get_positions(db, account_id=None, as_of=as_of)
    if authorized_ids is not None:
        id_set = set(authorized_ids)
        positions = [p for p in positions if p.get("account_id") in id_set]

    use_historical = as_of is not None  # historical_prices now includes intraday via refresh

    # Always load the live price map — needed for day-gain even in historical mode
    price_map: dict[int, MarketPrice] = {}
    for mp in db.query(MarketPrice).all():
        price_map[mp.security_id] = mp

    # Aggregate by ticker
    grouped: dict = defaultdict(lambda: {
        "ticker": "", "security_name": None, "asset_class": "EQUITY", "currency": "",
        "exchange": None,
        "total_quantity": Decimal("0"), "total_acb_cad": Decimal("0"),
        "security_id": None,
        "accounts": [],
        # historical price accumulators
        "hist_market_value": Decimal("0"),
        "hist_has_price": False,
        "hist_price_native": None,
        "hist_price_cad": None,
        "hist_price_currency": None,
        "hist_price_date": None,
    })
    for pos in positions:
        ticker = pos["ticker"]
        qty = Decimal(str(pos["quantity"]))
        acb = Decimal(str(pos["total_acb_cad"]))
        if not grouped[ticker]["security_id"]:
            grouped[ticker]["security_id"] = pos["security_id"]
        grouped[ticker]["ticker"] = ticker
        grouped[ticker]["security_name"] = pos.get("security_name")
        grouped[ticker]["asset_class"] = pos.get("asset_class", "EQUITY")
        grouped[ticker]["currency"] = pos.get("currency", "CAD")
        grouped[ticker]["exchange"] = pos.get("exchange")
        grouped[ticker]["total_quantity"] += qty
        grouped[ticker]["total_acb_cad"] += acb
        grouped[ticker]["accounts"].append({
            "account_id": pos["account_id"],
            "account_name": pos["account_name"],
            "account_type": pos["account_type"],
            "quantity": str(qty),
            "total_acb_cad": str(acb),
        })
        # Accumulate historical price data already enriched by get_positions
        if use_historical and pos.get("market_value_cad") is not None:
            grouped[ticker]["hist_market_value"] += Decimal(str(pos["market_value_cad"]))
            grouped[ticker]["hist_has_price"] = True
        if use_historical and grouped[ticker]["hist_price_cad"] is None and pos.get("current_price_cad"):
            grouped[ticker]["hist_price_native"] = pos.get("current_price")
            grouped[ticker]["hist_price_cad"] = pos["current_price_cad"]
            grouped[ticker]["hist_price_currency"] = pos.get("price_currency")
            grouped[ticker]["hist_price_date"] = pos.get("price_date")

    def _s(v):
        if v is None:
            return None
        if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
            return str(v)
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return v

    result = []
    for ticker, data in sorted(grouped.items()):
        total_qty = data["total_quantity"]
        total_acb = data["total_acb_cad"]
        # Options: market price is quoted per share; ACB is tracked per contract (100 shares).
        # Divide acb_per_share by 100 so it's on the same per-share basis as the price column.
        is_option = data["asset_class"] == "OPTION"
        acb_divisor = total_qty * (Decimal("100") if is_option else Decimal("1"))
        acb_per_share = (total_acb / acb_divisor) if acb_divisor != 0 else Decimal("0")

        if use_historical:
            # Use the historical prices already computed by get_positions
            if data["hist_has_price"]:
                market_value_cad = data["hist_market_value"]
                unrealized_pnl_cad = market_value_cad - total_acb
                unrealized_pnl_pct = (
                    (unrealized_pnl_cad / abs(total_acb) * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    if total_acb != 0 else None
                )
            else:
                market_value_cad = None
                unrealized_pnl_cad = None
                unrealized_pnl_pct = None

            # Day gain always comes from live prices regardless of historical mode
            sec_h = db.get(Security, data["security_id"])
            multiplier_h = Decimal("100") if (sec_h and sec_h.is_option) else Decimal("1")
            mp_h = price_map.get(data["security_id"])
            if mp_h and mp_h.day_change and mp_h.price and mp_h.price > 0 and mp_h.price_cad:
                fx_h = mp_h.price_cad / mp_h.price
                day_change_cad_h = (mp_h.day_change * fx_h).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
                day_gain_cad_h = (day_change_cad_h * total_qty * multiplier_h).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            else:
                day_change_cad_h = None
                day_gain_cad_h = None

            result.append({
                "security_id": data["security_id"],
                "ticker": ticker,
                "security_name": data["security_name"],
                "asset_class": data["asset_class"],
                "currency": data["currency"],
                "exchange": data["exchange"],
                "total_quantity": str(total_qty),
                "total_acb_cad": str(total_acb),
                "acb_per_share_cad": str(acb_per_share),
                "account_count": len(data["accounts"]),
                "accounts": data["accounts"],
                "current_price": data["hist_price_native"] if data["hist_price_native"] is not None else data["hist_price_cad"],
                "current_price_cad": data["hist_price_cad"],
                "price_currency": data["hist_price_currency"],
                "market_value_cad": str(market_value_cad) if market_value_cad is not None else None,
                "unrealized_pnl_cad": str(unrealized_pnl_cad) if unrealized_pnl_cad is not None else None,
                "unrealized_pnl_pct": str(unrealized_pnl_pct) if unrealized_pnl_pct is not None else None,
                "day_change_pct": _s(mp_h.day_change_pct) if mp_h else None,
                "day_change": _s(mp_h.day_change) if mp_h else None,
                "day_change_cad": _s(day_change_cad_h),
                "day_gain_cad": _s(day_gain_cad_h),
                "price_date": data["hist_price_date"],
                "fetched_at": _s(mp_h.fetched_at) if mp_h else None,
                "fetch_ticker": mp_h.fetch_ticker if mp_h else None,
            })
        else:
            # Live price data from MarketPrice table
            sec = db.get(Security, data["security_id"])
            multiplier = Decimal("100") if (sec and sec.is_option) else Decimal("1")
            mp = price_map.get(data["security_id"])
            if mp and mp.price_cad and total_qty != 0:
                market_value_cad = (mp.price_cad * total_qty * multiplier).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                unrealized_pnl_cad = market_value_cad - total_acb
                unrealized_pnl_pct = (
                    (unrealized_pnl_cad / abs(total_acb) * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    if total_acb != 0 else None
                )
            else:
                market_value_cad = None
                unrealized_pnl_cad = None
                unrealized_pnl_pct = None

            if mp and mp.day_change and mp.price and mp.price > 0 and mp.price_cad:
                fx = mp.price_cad / mp.price
                day_change_cad_val = (mp.day_change * fx).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
                day_gain_cad_val = (day_change_cad_val * total_qty * multiplier).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            else:
                day_change_cad_val = None
                day_gain_cad_val = None

            result.append({
                "security_id": data["security_id"],
                "ticker": ticker,
                "security_name": data["security_name"],
                "asset_class": data["asset_class"],
                "currency": data["currency"],
                "exchange": data["exchange"],
                "total_quantity": str(total_qty),
                "total_acb_cad": str(total_acb),
                "acb_per_share_cad": str(acb_per_share),
                "account_count": len(data["accounts"]),
                "accounts": data["accounts"],
                "current_price": _s(mp.price) if mp else None,
                "current_price_cad": _s(mp.price_cad) if mp else None,
                "price_currency": mp.currency if mp else None,
                "market_value_cad": str(market_value_cad) if market_value_cad is not None else None,
                "unrealized_pnl_cad": str(unrealized_pnl_cad) if unrealized_pnl_cad is not None else None,
                "unrealized_pnl_pct": str(unrealized_pnl_pct) if unrealized_pnl_pct is not None else None,
                "day_change_pct": _s(mp.day_change_pct) if mp else None,
                "day_change": _s(mp.day_change) if mp else None,
                "day_change_cad": _s(day_change_cad_val),
                "day_gain_cad": _s(day_gain_cad_val),
                "price_date": _s(mp.price_date) if mp else None,
                "fetched_at": _s(mp.fetched_at) if mp else None,
                "fetch_ticker": mp.fetch_ticker if mp else None,
            })
    return result


@router.get("/summary-metrics")
def get_summary_metrics(
    account_ids: Optional[str] = Query(None),
    as_of: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from datetime import date as date_cls, timedelta
    from decimal import Decimal as D
    from app.models.master import Account as _Account

    today = date_cls.today()
    # When the user has a date filter, treat that date as "now" so YTD and
    # 1Y are computed relative to the selected date, not the real today.
    ref_date = date_cls.fromisoformat(as_of) if as_of else today
    jan1 = date_cls(ref_date.year, 1, 1)
    one_year_ago = ref_date - timedelta(days=365)

    authorized_list = parse_account_ids(account_ids, current_user, db)
    parsed_ids = set(authorized_list) if authorized_list is not None else None

    def get_total_at(target_date: date_cls) -> D:
        """
        Compute total portfolio value using the same pipeline as the dashboard:
        positions (ACB + historical prices, with book-value fallback for unpriced)
        + cash (from transaction history).

        Snapshots are NOT used here because the snapshot service skips unpriced
        positions (treats them as $0) while the dashboard falls back to ACB.
        Using the same pipeline guarantees 1Y/YTD P&L is always consistent with
        the Total Value the dashboard displays.
        """
        positions = portfolio_svc.get_positions(db, account_id=None, as_of=target_date)
        securities_total = D(0)
        for pos in positions:
            if parsed_ids is not None and pos.get("account_id") not in parsed_ids:
                continue
            if pos.get("market_value_cad") is not None:
                securities_total += D(str(pos["market_value_cad"]))
            else:
                securities_total += D(str(pos.get("total_acb_cad") or 0))

        cash_rows = portfolio_svc.get_cash_balances(db, account_id=None, as_of=target_date)
        cash_total = D(0)
        for row in cash_rows:
            if parsed_ids is not None and row.get("account_id") not in parsed_ids:
                continue
            cash_total += D(str(row.get("balance_cad") or 0))

        return securities_total + cash_total

    current = get_total_at(ref_date)
    ytd_start = get_total_at(jan1)
    yr1_start = get_total_at(one_year_ago)

    def pct(gain, base):
        if not base or base == 0:
            return None
        return float(gain / base * 100)

    ytd_gain = current - ytd_start
    yr1_gain = current - yr1_start

    return {
        "current_value": float(current),
        "ytd_start_value": float(ytd_start),
        "ytd_gain_cad": float(ytd_gain),
        "ytd_gain_pct": pct(ytd_gain, ytd_start),
        "one_year_start_value": float(yr1_start),
        "one_year_gain_cad": float(yr1_gain),
        "one_year_gain_pct": pct(yr1_gain, yr1_start),
    }


@router.get("/recent-transactions")
def get_recent_transactions(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.routers.transactions import txn_to_dict
    allowed = get_user_account_ids(current_user, db)
    txns = portfolio_svc.get_recent_transactions(db, limit=limit)
    if allowed is not None:
        txns = [t for t in txns if t.account_id in set(allowed)]
    return [txn_to_dict(t) for t in txns]


@router.get("/cash-balances")
def get_cash_balances(
    account_id: Optional[int] = Query(None),
    as_of: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return calculated cash balance per account."""
    if account_id is not None:
        allowed = get_user_account_ids(current_user, db)
        if allowed is not None and account_id not in allowed:
            raise HTTPException(status_code=403, detail="Access denied to this account")
    rows = portfolio_svc.get_cash_balances(db, account_id=account_id, as_of=as_of)
    return [
        {**r, "balance": str(r["balance"])}
        for r in rows
    ]


def _sub_account_impact(txn, ccy: str, base_ccy: str):
    """
    Return the cash impact of *txn* on this account in the account's base currency.

    Routing logic:
    - When the transaction currency matches the account's base currency (e.g. a USD
      option sell in a USD account), use transaction_amount directly.  This avoids
      the problem where older transactions (imported before the CAD/USD account split)
      have account_currency_amount stored as a CAD-converted value even for USD accounts.
    - When the transaction currency differs from the account's base currency (e.g. a
      USD-listed stock bought in a CAD account), use account_currency_amount, which
      the import parsers store in the account's base currency after FX conversion.
    """
    from decimal import Decimal
    tx_ccy = (txn.transaction_currency or base_ccy).upper()
    if tx_ccy == base_ccy.upper():
        # Same currency as account — transaction_amount is the reliable native amount
        if txn.transaction_amount is not None:
            return txn.transaction_amount
        return txn.account_currency_amount if txn.account_currency_amount is not None else Decimal("0")
    # Cross-currency — account_currency_amount is FX-converted to account base currency
    return txn.account_currency_amount if txn.account_currency_amount is not None else Decimal("0")


@router.get("/cash-statement")
def get_cash_statement(
    account_id: Optional[int] = Query(None),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs for multi-account view"),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Running cash balance statement. Single account_id → running balance view.
    Multiple account_ids → flat combined view sorted by date (no single running balance)."""
    from decimal import Decimal
    from app.models.transactions import Transaction
    from app.models.master import Account
    from fastapi import HTTPException

    # Resolve and authorize list of account IDs
    if account_ids:
        authorized_ids = parse_account_ids(account_ids, current_user, db)
        id_list = authorized_ids if authorized_ids is not None else []
    elif account_id:
        allowed = get_user_account_ids(current_user, db)
        if allowed is not None and account_id not in allowed:
            raise HTTPException(status_code=403, detail="Access denied to this account")
        id_list = [account_id]
    else:
        raise HTTPException(status_code=400, detail="account_id or account_ids is required")

    # Multi-account: flat combined view
    if len(id_list) > 1:
        accounts = {a.id: a for a in db.query(Account).filter(Account.id.in_(id_list)).all()}
        # DRIP with positive amount = Scotia Wealth reinvestment (no cash movement; skip).
        # DRIP with negative amount = iTrade purchase (cash outflow; include).
        from sqlalchemy import or_, and_ as sqland_
        # JOURNAL = in-kind security transfer (book value only, no cash); exclude everywhere.
        SKIP_TYPES = {"OPENING_BALANCE", "REVERSE_SPLIT", "FORWARD_SPLIT", "STOCK_DIVIDEND", "DRIP", "JOURNAL"}
        txns = (
            db.query(Transaction)
            .filter(
                Transaction.account_id.in_(id_list),
                or_(
                    Transaction.transaction_type.notin_(SKIP_TYPES),
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
            .order_by(Transaction.transaction_date, Transaction.id)
            .all()
        )
        if from_date:
            txns = [t for t in txns if t.transaction_date >= from_date]
        if to_date:
            txns = [t for t in txns if t.transaction_date <= to_date]
        rows = []
        for txn in txns:
            acct = accounts.get(txn.account_id)
            if not acct:
                continue
            base_ccy = acct.base_currency.upper()
            impact = _sub_account_impact(txn, base_ccy, base_ccy)
            if impact is None:
                continue
            rows.append({
                "id": txn.id,
                "account_id": acct.id,
                "account_name": acct.name,
                "date": txn.transaction_date.isoformat(),
                "settlement_date": txn.settlement_date.isoformat() if txn.settlement_date else None,
                "transaction_type": txn.transaction_type,
                "ticker": txn.security.ticker if txn.security else None,
                "description": txn.notes or txn.raw_description or txn.transaction_type,
                "impact": str(impact),
                "balance": None,  # no combined running balance
                "currency": base_ccy,
            })
        return {
            "account_id": None,
            "account_name": f"{len(id_list)} accounts",
            "base_currency": "mixed",
            "currency": "mixed",
            "closing_balance": "0",
            "rows": rows,
        }

    # Single account: running balance view (original behaviour)
    account_id = id_list[0]
    acct = db.get(Account, account_id)
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    base_ccy = acct.base_currency.upper()
    ccy = base_ccy

    # Two DRIP formats exist across brokerages:
    #   Scotia Wealth DRIP: amount POSITIVE — dividend reinvested in-place, no net cash
    #     movement → exclude (cash-neutral, same as before).
    #   iTrade DRIP: amount NEGATIVE — actual share purchase; a separate DIVIDEND row
    #     already credited the income → include so the cash outflow is visible.
    from sqlalchemy import or_, and_ as sqland_
    # JOURNAL = in-kind security transfer (book value only, no cash); exclude everywhere.
    SKIP_TYPES = {"OPENING_BALANCE", "REVERSE_SPLIT", "FORWARD_SPLIT", "STOCK_DIVIDEND", "DRIP", "JOURNAL"}

    # Base query — all transactions for this account, ordered chronologically
    base_q = (
        db.query(Transaction)
        .filter(
            Transaction.account_id == account_id,
            or_(
                Transaction.transaction_type.notin_(SKIP_TYPES),
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

    # Pre-period opening balance (used when from_date is supplied)
    opening_balance = Decimal("0")
    if from_date:
        pre_txns = (
            base_q
            .filter(Transaction.transaction_date < from_date)
            .order_by(Transaction.transaction_date, Transaction.id)
            .all()
        )
        for txn in pre_txns:
            impact = _sub_account_impact(txn, ccy, base_ccy)
            if impact is not None:
                opening_balance += impact

    # Visible range
    txns_q = base_q.order_by(Transaction.transaction_date, Transaction.id)
    if from_date:
        txns_q = txns_q.filter(Transaction.transaction_date >= from_date)
    if to_date:
        txns_q = txns_q.filter(Transaction.transaction_date <= to_date)
    txns = txns_q.all()

    rows = []
    running = opening_balance

    # Synthetic opening row when a date range is active
    if from_date:
        rows.append({
            "id":               0,
            "account_id":       acct.id,
            "account_name":     acct.name,
            "currency":         ccy,
            "date":             from_date.isoformat(),
            "settlement_date":  None,
            "transaction_type": "CASH_OPENING",
            "ticker":           None,
            "description":      f"Opening balance as of {from_date.isoformat()}",
            "impact":           str(opening_balance),
            "balance":          str(opening_balance),
        })

    for txn in txns:
        impact = _sub_account_impact(txn, ccy, base_ccy)
        if impact is None:
            continue

        running += impact
        rows.append({
            "id":               txn.id,
            "account_id":       acct.id,
            "account_name":     acct.name,
            "currency":         ccy,
            "date":             txn.transaction_date.isoformat(),
            "settlement_date":  txn.settlement_date.isoformat() if txn.settlement_date else None,
            "transaction_type": txn.transaction_type,
            "ticker":           txn.security.ticker if txn.security else None,
            "description":      txn.notes or txn.raw_description or txn.transaction_type,
            "impact":           str(impact),
            "balance":          str(running),
        })

    return {
        "account_id":      acct.id,
        "account_name":    acct.name,
        "base_currency":   base_ccy,
        "currency":        ccy,
        "closing_balance": str(running),
        "rows":            rows,
    }


@router.get("/income")
def get_investment_income(
    account_id: Optional[int] = Query(None),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    year: Optional[int] = Query(None),
    brokerage_name: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return dividend/interest income transactions."""
    rows = portfolio_svc.get_investment_income(
        db, account_id=account_id, year=year, brokerage_name=brokerage_name
    )
    authorized_ids = parse_account_ids(account_ids, current_user, db)
    if authorized_ids is not None:
        id_set = set(authorized_ids)
        rows = [r for r in rows if r.get("account_id") in id_set]
    return rows


@router.get("/options")
def get_options_report(
    account_id: Optional[int] = Query(None),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return options report: open positions + income history + summary."""
    authorized_ids = parse_account_ids(account_ids, current_user, db)
    # If single account_id provided (legacy), merge into authorized_ids
    if account_id is not None:
        if authorized_ids is None:
            authorized_ids = [account_id]
        elif account_id not in authorized_ids:
            authorized_ids = authorized_ids + [account_id]
    filter_ids: Optional[set] = set(authorized_ids) if authorized_ids is not None else None

    report = portfolio_svc.get_options_report(db, account_id=None)
    # Filter results by account if filter_ids specified
    if filter_ids:
        report["open_positions"] = [p for p in report["open_positions"] if p.get("account_id") in filter_ids]
        report["income"] = [r for r in report["income"] if r.get("account_id") in filter_ids]
        # Recompute summary from filtered data
        open_pos = report["open_positions"]
        income = report["income"]
        report["summary"] = {
            "open_contracts": sum(abs(float(p.get("quantity", 0))) for p in open_pos),
            "total_market_value_cad": sum(float(p.get("market_value_cad") or 0) for p in open_pos),
            "total_acb_cad": sum(float(p.get("total_acb_cad") or 0) for p in open_pos),
            "total_pnl_cad": sum(float(p.get("unrealized_pnl_cad") or 0) for p in open_pos),
            "total_income_cad": sum(float(r.get("gain_cad", 0)) for r in income),
        }
    # Serialize Decimal/date fields in open_positions
    serialized_positions = []
    for pos in report["open_positions"]:
        sp = {}
        for k, v in pos.items():
            if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                sp[k] = str(v)
            elif hasattr(v, "isoformat") and not isinstance(v, str):
                sp[k] = v.isoformat()
            else:
                sp[k] = v
        serialized_positions.append(sp)
    report["open_positions"] = serialized_positions
    return report


@router.get("/continuity")
def get_portfolio_continuity(
    from_date: date = Query(..., description="Start of period (inclusive)"),
    to_date: date = Query(..., description="End of period (inclusive)"),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return a continuity/waterfall report for a period."""
    parsed_ids = parse_account_ids(account_ids, current_user, db)
    return portfolio_svc.get_portfolio_continuity(
        db,
        from_date=from_date,
        to_date=to_date,
        account_ids=parsed_ids,
    )


@router.get("/analytics")
def get_portfolio_analytics(
    as_of: Optional[date] = Query(None),
    account_ids: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return portfolio breakdown by sector, country, currency, asset class, and top holdings."""
    from decimal import Decimal
    from collections import defaultdict
    from app.models.master import Security
    from app.models.prices import MarketPrice

    authorized_ids = parse_account_ids(account_ids, current_user, db)

    positions = portfolio_svc.get_positions(db, account_id=None, as_of=as_of)
    if authorized_ids is not None:
        id_set = set(authorized_ids)
        positions = [p for p in positions if p.get("account_id") in id_set]

    sec_ids = {p["security_id"] for p in positions if p.get("security_id")}
    sec_map: dict = {}
    if sec_ids:
        sec_map = {s.id: s for s in db.query(Security).filter(Security.id.in_(sec_ids)).all()}

    use_historical = as_of is not None  # historical_prices now includes intraday via refresh
    price_map: dict = {}
    if not use_historical and sec_ids:
        for mp in db.query(MarketPrice).filter(MarketPrice.security_id.in_(sec_ids)).all():
            price_map[mp.security_id] = mp

    def _val(pos) -> Decimal:
        sec_id = pos.get("security_id")
        qty = Decimal(str(pos["quantity"]))
        if use_historical:
            mv = pos.get("market_value_cad")
            if mv is not None:
                return Decimal(str(mv))
        else:
            mp = price_map.get(sec_id)
            if mp and mp.price_cad and qty != 0:
                sec = sec_map.get(sec_id)
                mult = Decimal("100") if (sec and sec.is_option) else Decimal("1")
                return mp.price_cad * qty * mult
        return pos["total_acb_cad"]

    def _sec_field(pos, field):
        sec = sec_map.get(pos.get("security_id"))
        return getattr(sec, field, None) if sec else None

    def _group(key_fn) -> list:
        by_key: dict[str, Decimal] = defaultdict(Decimal)
        for pos in positions:
            key = key_fn(pos) or "Unknown"
            by_key[key] += _val(pos)
        total = sum(by_key.values()) or Decimal("1")
        return sorted(
            [{"label": k, "total_cad": float(v), "pct": float(v / total * 100)}
             for k, v in by_key.items()],
            key=lambda x: -x["total_cad"],
        )

    by_ticker: dict[str, Decimal] = defaultdict(Decimal)
    ticker_meta: dict[str, dict] = {}
    for pos in positions:
        t = pos["ticker"]
        by_ticker[t] += _val(pos)
        if t not in ticker_meta:
            ticker_meta[t] = {"name": pos.get("security_name"), "asset_class": pos.get("asset_class")}
    total_port = sum(by_ticker.values()) or Decimal("1")
    top_holdings = sorted(
        [{"ticker": t, "name": ticker_meta[t]["name"], "asset_class": ticker_meta[t]["asset_class"],
          "total_cad": float(v), "pct": float(v / total_port * 100)}
         for t, v in by_ticker.items()],
        key=lambda x: -x["total_cad"],
    )[:10]

    return {
        "sector": _group(lambda p: _sec_field(p, "sector_gics")),
        "country": _group(lambda p: _sec_field(p, "country")),
        "currency": _group(lambda p: p["currency"]),
        "asset_class": _group(lambda p: p["asset_class"]),
        "top_holdings": top_holdings,
    }


@router.get("/risk")
def get_portfolio_risk(
    account_ids: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return pre-computed risk metrics for the portfolio (uses stored fundamentals + historical prices)."""
    from decimal import Decimal
    from datetime import date, timedelta
    from math import sqrt, log
    from collections import defaultdict
    from app.models.master import Security
    from app.models.prices import MarketPrice, HistoricalPrice

    authorized_ids = parse_account_ids(account_ids, current_user, db)

    positions = portfolio_svc.get_positions(db, account_id=None, as_of=None)
    if authorized_ids is not None:
        id_set = set(authorized_ids)
        positions = [p for p in positions if p.get("account_id") in id_set]

    sec_ids = {p["security_id"] for p in positions if p.get("security_id")}
    if not sec_ids:
        return {"available": False, "reason": "No positions found"}

    sec_map  = {s.id: s for s in db.query(Security).filter(Security.id.in_(sec_ids)).all()}
    mp_map   = {mp.security_id: mp for mp in db.query(MarketPrice).filter(MarketPrice.security_id.in_(sec_ids)).all()}

    def _mval(pos) -> Decimal:
        sec_id = pos.get("security_id")
        mp = mp_map.get(sec_id)
        qty = Decimal(str(pos["quantity"]))
        if mp and mp.price_cad and qty != 0:
            sec = sec_map.get(sec_id)
            mult = Decimal("100") if (sec and sec.is_option) else Decimal("1")
            return mp.price_cad * qty * mult
        return pos["total_acb_cad"]

    # Aggregate by ticker (consolidate across accounts)
    by_ticker: dict[str, Decimal] = defaultdict(Decimal)
    ticker_sec_id: dict[str, int] = {}
    for pos in positions:
        t = pos["ticker"]
        by_ticker[t] += _mval(pos)
        if t not in ticker_sec_id and pos.get("security_id"):
            ticker_sec_id[t] = pos["security_id"]

    total_val = sum(by_ticker.values()) or Decimal("1")

    # ── Portfolio beta (market-value weighted) ────────────────────────────────
    beta_weighted = Decimal("0")
    beta_covered  = Decimal("0")
    for ticker, val in by_ticker.items():
        sec_id = ticker_sec_id.get(ticker)
        mp = mp_map.get(sec_id) if sec_id else None
        if mp and mp.beta is not None:
            w = val / total_val
            beta_weighted += w * Decimal(str(mp.beta))
            beta_covered  += val

    beta_coverage_pct = float(beta_covered / total_val * 100) if total_val else 0

    # ── Weighted dividend yield ───────────────────────────────────────────────
    # dividend_yield is stored as a percentage already (e.g. 5.36 = 5.36%).
    # Weight against covered-position value only so the result is the true
    # weighted-average yield for positions we have data for, not a diluted
    # portfolio-wide number that shrinks with unpriced/option positions.
    div_yield_sum = Decimal("0")   # Σ(val × yield_pct)
    div_covered   = Decimal("0")   # Σ(val) for covered positions

    for ticker, val in by_ticker.items():
        sec_id = ticker_sec_id.get(ticker)
        mp = mp_map.get(sec_id) if sec_id else None
        if mp and mp.dividend_yield is not None:
            div_yield_sum += val * Decimal(str(mp.dividend_yield))
            div_covered   += val

    # Weighted-average yield among covered positions (already in %)
    div_weighted     = div_yield_sum / div_covered if div_covered else Decimal("0")
    div_coverage_pct = float(div_covered / total_val * 100) if total_val else 0

    # ── Volatility (annualised daily log-returns std dev) ─────────────────────
    def _vol(sec_id: int, days: int) -> Optional[float]:
        cutoff = date.today() - timedelta(days=days)
        rows = (
            db.query(HistoricalPrice.close_price_cad)
            .filter(
                HistoricalPrice.security_id == sec_id,
                HistoricalPrice.price_date >= cutoff,
                HistoricalPrice.close_price_cad.isnot(None),
            )
            .order_by(HistoricalPrice.price_date)
            .all()
        )
        prices = [float(r[0]) for r in rows if r[0] and float(r[0]) > 0]
        if len(prices) < 5:
            return None
        returns = [log(prices[i] / prices[i - 1]) for i in range(1, len(prices))]
        n = len(returns)
        mean = sum(returns) / n
        variance = sum((r - mean) ** 2 for r in returns) / (n - 1)
        return sqrt(variance) * sqrt(252) * 100  # annualised %

    # Compute portfolio-level volatility as weighted average of individual vols
    vol30_w = Decimal("0");  vol30_cov = Decimal("0")
    vol90_w = Decimal("0");  vol90_cov = Decimal("0")
    for ticker, val in by_ticker.items():
        sec_id = ticker_sec_id.get(ticker)
        if not sec_id:
            continue
        sec = sec_map.get(sec_id)
        if sec and sec.is_option:
            continue
        w = val / total_val
        v30 = _vol(sec_id, 45)
        v90 = _vol(sec_id, 120)
        if v30 is not None:
            vol30_w   += w * Decimal(str(v30))
            vol30_cov += val
        if v90 is not None:
            vol90_w   += w * Decimal(str(v90))
            vol90_cov += val

    # ── Concentration ─────────────────────────────────────────────────────────
    weights = {t: float(v / total_val) for t, v in by_ticker.items()}
    hhi = sum(w ** 2 for w in weights.values()) * 100  # 0-100 scale
    top = sorted(by_ticker.items(), key=lambda x: -x[1])
    top5_pct = float(sum(v for _, v in top[:5]) / total_val * 100) if top else 0
    largest_pct = float(top[0][1] / total_val * 100) if top else 0
    largest_ticker = top[0][0] if top else None

    # ── Currency exposure ─────────────────────────────────────────────────────
    by_currency: dict[str, Decimal] = defaultdict(Decimal)
    for pos in positions:
        ccy = pos.get("currency") or "CAD"
        sec = sec_map.get(pos.get("security_id"))
        if sec and sec.is_option:
            continue
        by_currency[ccy] += _mval(pos)
    cur_total = sum(by_currency.values()) or Decimal("1")
    currency_exposure = sorted(
        [{"currency": k, "pct": float(v / cur_total * 100), "total_cad": float(v)}
         for k, v in by_currency.items()],
        key=lambda x: -x["pct"],
    )

    # ── Sector concentration ──────────────────────────────────────────────────
    by_sector: dict[str, Decimal] = defaultdict(Decimal)
    for ticker, val in by_ticker.items():
        sec_id = ticker_sec_id.get(ticker)
        sec = sec_map.get(sec_id) if sec_id else None
        key = (sec.sector_gics if sec else None) or "Unknown"
        by_sector[key] += val
    sec_total = sum(by_sector.values()) or Decimal("1")
    top_sector = max(by_sector.items(), key=lambda x: x[1])
    top_sector_pct = float(top_sector[1] / sec_total * 100) if top_sector else 0

    return {
        "available": True,
        "total_value_cad": float(total_val),
        "portfolio_beta": round(float(beta_weighted), 3) if beta_covered > 0 else None,
        "beta_coverage_pct": round(beta_coverage_pct, 1),
        "dividend_yield_pct": round(float(div_weighted), 2) if div_covered > 0 else None,
        "dividend_coverage_pct": round(div_coverage_pct, 1),
        "volatility_30d_pct": round(float(vol30_w), 1) if vol30_cov > 0 else None,
        "volatility_90d_pct": round(float(vol90_w), 1) if vol90_cov > 0 else None,
        "hhi": round(hhi, 1),
        "largest_position_pct": round(largest_pct, 1),
        "largest_position_ticker": largest_ticker,
        "top5_concentration_pct": round(top5_pct, 1),
        "top_sector": top_sector[0] if top_sector else None,
        "top_sector_pct": round(top_sector_pct, 1),
        "currency_exposure": currency_exposure,
        "position_count": len(by_ticker),
    }


@router.get("/history")
def get_portfolio_history(
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    interval: str = Query("monthly", regex="^(daily|weekly|monthly)$"),
    account_id: Optional[int] = Query(None),
    account_ids: Optional[str] = Query(None),  # comma-separated list of account IDs
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return portfolio value snapshots over time.
    account_ids: comma-separated account IDs for multi-account filtering (e.g. "1,2,3").
    Requires historical prices to be loaded first via POST /api/prices/fetch-history.
    """
    parsed_ids = parse_account_ids(account_ids, current_user, db)

    return portfolio_svc.get_portfolio_history(
        db,
        from_date=from_date,
        to_date=to_date,
        interval=interval,
        account_id=account_id,
        account_ids=parsed_ids,
    )


# ─── Snapshot-based performance helpers ──────────────────────────────────────

def _query_snapshot_rows(db: Session, parsed_ids: "Optional[set[int]]"):
    """
    Return snapshot rows for the given account IDs.

    Tries mv_snapshot_monthly first (one row per account per month —
    ~30× fewer rows than the raw daily table).  Falls back to
    portfolio_snapshots if the view is unavailable or empty.

    Returned rows expose: .account_id  .snapshot_date  .market_value_cad
                          .income_cad  .invested_cad
    (compatible with both SQLAlchemy ORM rows and Core result rows)
    """
    from sqlalchemy import text as _text

    # ── Try the materialized / regular view ───────────────────────────────────
    try:
        id_clause = ""
        if parsed_ids:
            id_list = ",".join(str(i) for i in parsed_ids)
            id_clause = f"WHERE account_id IN ({id_list})"

        rows = db.execute(_text(
            f"SELECT account_id, actual_snapshot_date AS snapshot_date, "
            f"market_value_cad, income_cad, invested_cad "
            f"FROM mv_snapshot_monthly {id_clause} "
            f"ORDER BY actual_snapshot_date"
        )).fetchall()

        if rows:                          # view exists and has data → use it
            return rows, "view"
    except Exception:
        pass                              # view missing — fall through

    # ── Fall back to raw portfolio_snapshots ──────────────────────────────────
    from app.models.master import PortfolioSnapshot
    q = db.query(
        PortfolioSnapshot.account_id,
        PortfolioSnapshot.snapshot_date,
        PortfolioSnapshot.market_value_cad,
        PortfolioSnapshot.income_cad,
        PortfolioSnapshot.invested_cad,
    )
    if parsed_ids:
        q = q.filter(PortfolioSnapshot.account_id.in_(parsed_ids))
    rows = q.order_by(PortfolioSnapshot.snapshot_date).all()
    return rows, "table"


def _snap_at_date(date_map: dict, target) -> "tuple | None":
    """Return the snapshot tuple (mv, inc, inv) at the closest date ≤ target."""
    best = None
    for d in sorted(date_map.keys()):
        if d <= target:
            best = d
        else:
            break
    return date_map[best] if best is not None else None


def _modified_dietz(
    date_map: dict,
    start_target,
    end_target,
) -> "tuple[float, float] | None":
    """
    Modified Dietz return for the period [start_target, end_target].

    Correctly handles mid-period capital flows (contributions / withdrawals)
    by weighting each ΔInvested by the fraction of the period remaining after
    that snapshot date.

    Formula:
        R  =  (V1 − V0 − F + I)  /  (V0 + W)

    where
        V0  = start market value
        V1  = end market value
        F   = net capital flows  = e_inv − s_inv   (+ = net money in, − = net money out)
        I   = period income      = e_inc − s_inc
        W   = Σ  weight_i × ΔInv_i      (weight_i = days remaining / total days)

    Returns (return_pct, denominator) or None when start MV is zero or denominator ≤ 0.
    """
    from decimal import Decimal as D

    s = _snap_at_date(date_map, start_target)
    e = _snap_at_date(date_map, end_target)
    if s is None or e is None:
        return None

    s_mv, s_inc, s_inv = s
    e_mv, e_inc, e_inv = e
    if s_mv == 0:
        return None

    total_days = (end_target - start_target).days
    if total_days <= 0:
        return None

    # Walk every snapshot in the period to accumulate weighted flows
    # (ΔInv between consecutive snapshots = net cash deployed on that date)
    prev_inv       = s_inv
    weighted_flows = D(0)

    for d in sorted(date_map.keys()):
        if d <= start_target:
            prev_inv = date_map[d][2]   # keep advancing to closest pre-period snapshot
            continue
        if d > end_target:
            break
        curr_inv  = date_map[d][2]
        delta_inv = curr_inv - prev_inv
        if delta_inv != 0:
            days_remaining = (end_target - d).days
            weight          = D(str(days_remaining)) / D(str(total_days))
            weighted_flows += weight * delta_inv
        prev_inv = curr_inv

    net_flows     = e_inv - s_inv
    period_income = e_inc - s_inc
    numerator     = (e_mv - s_mv) - net_flows + period_income
    denominator   = s_mv + weighted_flows

    if denominator <= 0:
        return None

    return float(numerator / denominator * 100), float(denominator)


def _modified_dietz_return(
    date_map: dict,
    start_target,
    end_target,
) -> "float | None":
    """Convenience wrapper — returns only the return % (no denominator)."""
    result = _modified_dietz(date_map, start_target, end_target)
    return result[0] if result is not None else None


# ─── Snapshot-based performance endpoints ────────────────────────────────────

def _spawn_portfolio_job(name: str, fn):
    """Run fn(db) in a background thread and return job metadata."""
    from app.database import SessionLocal
    import threading
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}
    job_id = background_jobs.start_job(name)
    def _run():
        db = SessionLocal()
        try:
            result = fn(db)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception("Portfolio job %s failed", name)
            background_jobs.fail_job(job_id, str(exc))
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.post("/compute-snapshots")
def compute_snapshots(
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs; omit for all"),
    from_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Pre-compute daily portfolio value snapshots for all (or selected) accounts.
    Reads transaction history + historical prices and writes to portfolio_snapshots.
    Run this after importing transactions or downloading price history.
    Returns a job_id — poll GET /api/portfolio/jobs/{job_id} for status.
    """
    from app.services.portfolio_history_service import compute_portfolio_snapshots
    parsed_ids = parse_account_ids(account_ids, current_user, db)
    return _spawn_portfolio_job(
        "compute_snapshots",
        lambda db: compute_portfolio_snapshots(db, account_ids=parsed_ids, from_date=from_date),
    )


@router.delete("/purge-snapshots")
def purge_snapshots(
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs; omit for all"),
    from_date: Optional[date] = Query(None, description="Delete snapshots on or after this date"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Delete stored portfolio snapshots so they can be cleanly regenerated.
    Use this after fixing transaction data or when phantom positions are suspected.
    After purging, call POST /api/portfolio/compute-snapshots to rebuild.
    """
    from app.models.master import PortfolioSnapshot
    parsed_ids = parse_account_ids(account_ids, current_user, db)
    q = db.query(PortfolioSnapshot)
    if parsed_ids:
        q = q.filter(PortfolioSnapshot.account_id.in_(parsed_ids))
    if from_date:
        q = q.filter(PortfolioSnapshot.snapshot_date >= from_date)
    deleted = q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted, "account_ids": parsed_ids, "from_date": str(from_date) if from_date else None}


@router.post("/refresh-snapshot-views")
def refresh_snapshot_views_endpoint(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Refresh mv_snapshot_monthly (PostgreSQL MATERIALIZED VIEW).
    On SQLite (dev) this is a no-op — the view is always live.
    Call this after compute-snapshots finishes to make monthly-returns
    and returns-detail reflect the new data immediately.
    """
    from app.services.snapshot_view_service import refresh_snapshot_views, view_row_count
    result = refresh_snapshot_views(db)
    result["total_rows"] = view_row_count(db)
    return result


@router.get("/snapshot-views/status")
def snapshot_views_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return row count and last-refresh info for mv_snapshot_monthly."""
    from app.services.snapshot_view_service import view_row_count
    from sqlalchemy import text as _text

    rows = view_row_count(db)
    last_refresh = None
    try:
        # PostgreSQL only: pull last refresh time from pg_stat_user_tables
        r = db.execute(_text(
            "SELECT last_analyze FROM pg_stat_user_tables "
            "WHERE relname = 'mv_snapshot_monthly'"
        )).fetchone()
        if r and r[0]:
            last_refresh = str(r[0])
    except Exception:
        pass
    return {"rows": rows, "last_refresh": last_refresh, "view_name": "mv_snapshot_monthly"}


@router.get("/performance/timeline")
def get_performance_timeline(
    group_by: str = Query("account", regex="^(total|brokerage|account_type|account)$"),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    account_ids: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return pre-computed portfolio value timeline from portfolio_snapshots.
    group_by: total | brokerage | account_type | account
    Returns [{date, series: {label: value_cad}}] suitable for a multi-line chart.
    """
    from app.models.master import PortfolioSnapshot, Account, Brokerage
    from sqlalchemy import func as sqlfunc
    from decimal import Decimal as D

    authorized_ids = parse_account_ids(account_ids, current_user, db)
    parsed_ids: Optional[set[int]] = set(authorized_ids) if authorized_ids is not None else None

    # Load account metadata for grouping
    accounts = {a.id: a for a in db.query(Account).all()}
    brokerages = {b.id: b.name for b in db.query(Brokerage).all()}

    def _group_label(acct: Account) -> str:
        if group_by == "total":
            return "Total"
        if group_by == "brokerage":
            return brokerages.get(acct.brokerage_id, "Unknown")
        if group_by == "account_type":
            return acct.account_type
        # individual account: strip " (USD)" so CAD+USD sub-accounts merge into one line
        return acct.name.replace(" (USD)", "").strip()

    # Query snapshots
    q = db.query(PortfolioSnapshot)
    if parsed_ids:
        q = q.filter(PortfolioSnapshot.account_id.in_(parsed_ids))
    if from_date:
        q = q.filter(PortfolioSnapshot.snapshot_date >= from_date)
    if to_date:
        q = q.filter(PortfolioSnapshot.snapshot_date <= to_date)
    q = q.order_by(PortfolioSnapshot.snapshot_date, PortfolioSnapshot.account_id)
    rows = q.all()

    if not rows:
        return {"series_labels": [], "points": []}

    # Aggregate by (date, group_label)
    from collections import defaultdict
    agg: dict[date, dict[str, D]] = defaultdict(lambda: defaultdict(D))
    inv_agg: dict[date, dict[str, D]] = defaultdict(lambda: defaultdict(D))
    all_labels: set[str] = set()

    for row in rows:
        acct = accounts.get(row.account_id)
        if acct is None:
            continue
        if parsed_ids and row.account_id not in parsed_ids:
            continue
        label = _group_label(acct)
        all_labels.add(label)
        # Accumulate raw (signed) totals — clamp happens after aggregation so that
        # offsetting negatives across CAD/USD sub-accounts cancel before the floor.
        securities_mv = D(str(row.market_value_cad or 0))
        cash_mv       = D(str(row.cash_balance_cad or 0))
        mv = securities_mv + cash_mv
        iv = D(str(row.invested_cad or 0))
        agg[row.snapshot_date][label] += mv
        inv_agg[row.snapshot_date][label] += iv

    labels_sorted = sorted(all_labels)
    points = []
    for snap_date in sorted(agg.keys()):
        point: dict = {"date": snap_date.isoformat(), "values": {}, "invested": {}}
        for label in labels_sorted:
            # Clamp the aggregated group total to zero — after CAD+USD sub-accounts
            # have been summed, any remaining negative is a genuine data artifact.
            mv = max(agg[snap_date].get(label, D(0)), D(0))
            iv = inv_agg[snap_date].get(label, D(0))
            point["values"][label] = float(mv)
            point["invested"][label] = float(iv)
        points.append(point)

    # ── Contribution / withdrawal events ─────────────────────────────────────
    # Query DEPOSIT and WITHDRAWAL transactions in scope; attach group_label so
    # the frontend can place the dot on the correct chart series.
    from app.models.transactions import Transaction as Txn
    from datetime import datetime as _dt
    flow_q = (
        db.query(Txn)
        .filter(
            Txn.transaction_type.in_(('DEPOSIT', 'WITHDRAWAL')),
            Txn.cad_amount.isnot(None),
        )
    )
    if parsed_ids:
        flow_q = flow_q.filter(Txn.account_id.in_(parsed_ids))
    else:
        flow_q = flow_q.filter(Txn.account_id.in_(accounts.keys()))
    if from_date:
        flow_q = flow_q.filter(Txn.transaction_date >= from_date)
    if to_date:
        flow_q = flow_q.filter(Txn.transaction_date <= to_date)

    events_by_date: dict = defaultdict(list)
    for t in flow_q.order_by(Txn.transaction_date).all():
        acct = accounts.get(t.account_id)
        if acct is None:
            continue
        ev_date = t.transaction_date
        if isinstance(ev_date, _dt):
            ev_date = ev_date.date()
        events_by_date[ev_date].append({
            "type":        t.transaction_type,
            "amount_cad":  float(D(str(t.cad_amount or 0))),
            "account":     acct.name,
            "group_label": _group_label(acct),
        })

    events = [
        {
            "date":    d.isoformat(),
            "net_cad": sum(i["amount_cad"] for i in items),
            "items":   items,
        }
        for d, items in sorted(events_by_date.items())
    ]

    return {"series_labels": labels_sorted, "points": points, "events": events}


@router.get("/performance/returns")
def get_performance_returns(
    account_ids: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return period returns for each logical account from the snapshot table.
    CAD and USD sub-accounts with the same base name are combined into one row.
    Periods: 1M, 3M, 6M, YTD, 1Y, 3Y, inception.
    """
    from app.models.master import PortfolioSnapshot, Account, Brokerage
    from decimal import Decimal as D

    authorized_ids = parse_account_ids(account_ids, current_user, db)
    parsed_ids: Optional[set[int]] = set(authorized_ids) if authorized_ids is not None else None

    accounts = {a.id: a for a in db.query(Account).all()}
    brokerages = {b.id: b.name for b in db.query(Brokerage).all()}

    q = db.query(PortfolioSnapshot)
    if parsed_ids:
        q = q.filter(PortfolioSnapshot.account_id.in_(parsed_ids))
    rows = q.order_by(PortfolioSnapshot.snapshot_date).all()

    if not rows:
        return []

    today = date.today()
    period_starts = {
        "1M":  today - timedelta(days=30),
        "3M":  today - timedelta(days=91),
        "6M":  today - timedelta(days=182),
        "YTD": date(today.year, 1, 1),
        "1Y":  today - timedelta(days=365),
        "3Y":  today - timedelta(days=1095),
    }

    def _logical_name(acct: Account) -> str:
        """Strip ' (USD)' suffix so CAD/USD sub-accounts share the same key."""
        return acct.name.replace(" (USD)", "").strip()

    def _group_key(acct: Account) -> tuple:
        return (_logical_name(acct), acct.brokerage_id, acct.account_type)

    # Map each account_id → group key
    acct_to_group: dict[int, tuple] = {}
    group_meta: dict[tuple, dict] = {}
    for acct in accounts.values():
        if parsed_ids and acct.id not in parsed_ids:
            continue
        key = _group_key(acct)
        acct_to_group[acct.id] = key
        if key not in group_meta:
            group_meta[key] = {
                "account_name": _logical_name(acct),
                "account_type": acct.account_type,
                "brokerage":    brokerages.get(acct.brokerage_id, ""),
                "account_ids":  [],
            }
        group_meta[key]["account_ids"].append(acct.id)

    # Group snapshots: sum market_value_cad, income_cad, invested_cad per (date, group_key)
    from collections import defaultdict
    # by_group[group_key][snap_date] = (market_value, income, invested)
    by_group: dict[tuple, dict[date, tuple[D, D, D]]] = defaultdict(
        lambda: defaultdict(lambda: (D(0), D(0), D(0)))
    )

    for row in rows:
        key = acct_to_group.get(row.account_id)
        if key is None:
            continue
        # Accumulate raw signed total — clamp applied after sub-accounts are summed.
        securities_mv = D(str(row.market_value_cad or 0))
        cash_mv       = D(str(row.cash_balance_cad or 0))
        mv  = securities_mv + cash_mv
        inc = D(str(row.income_cad or 0))
        inv = D(str(row.invested_cad or 0))
        ex  = by_group[key][row.snapshot_date]
        by_group[key][row.snapshot_date] = (ex[0] + mv, ex[1] + inc, ex[2] + inv)

    # Clamp aggregated group totals to zero (after CAD+USD sub-accounts summed).
    for key in by_group:
        for d in by_group[key]:
            mv, inc, inv = by_group[key][d]
            by_group[key][d] = (max(mv, D(0)), inc, inv)

    def _closest(date_map: dict[date, tuple[D, D, D]], target: date) -> Optional[tuple[D, D, D]]:
        """Return (market_value, income, invested) for the snapshot closest to (but not after) target."""
        best_date = None
        for d in sorted(date_map.keys()):
            if d <= target:
                best_date = d
            else:
                break
        return date_map[best_date] if best_date is not None else None

    def _total_return_pct(
        end_mv: D, end_inc: D, end_inv: D,
        start_mv: D, start_inc: D, start_inv: D,
    ) -> Optional[float]:
        """
        Total return for a period including income and returned capital:

          Total gain = (end_mv - start_mv)          ← price appreciation
                     + (end_inc - start_inc)         ← income earned (interest/dividends/premiums)
                     + max(0, start_inv - end_inv)   ← capital returned to investor (principal
                                                        repayments, net position reductions)

          Total Return % = Total gain / start_mv × 100

        The "capital returned" term correctly handles fixed-income principal repayments:
        when a mortgage borrower repays $33K of principal, invested_cad drops by $33K and
        market_value drops by $33K — without this term those would cancel to a spurious loss.
        For equity accounts where sell proceeds are reinvested, invested_cad stays roughly
        flat so this term is near zero.
        """
        if start_mv == 0:
            return None
        period_income    = end_inc - start_inc
        capital_returned = max(D(0), start_inv - end_inv)
        total_gain       = (end_mv - start_mv) + period_income + capital_returned
        return float(total_gain / abs(start_mv) * 100)

    def _effective_inception(date_map: dict[date, tuple[D, D, D]], current_mv: D) -> tuple[date, tuple[D, D, D]]:
        """
        Find the first date where the account had at least 50% of its current
        (or peak) market value — meaningful inception after large transfers.
        """
        peak = max(mv for mv, _, __ in date_map.values()) if date_map else current_mv
        threshold = min(current_mv, peak) * D("0.50")
        for d in sorted(date_map.keys()):
            if date_map[d][0] >= threshold:
                return d, date_map[d]
        sorted_dates = sorted(date_map.keys())
        return sorted_dates[0], date_map[sorted_dates[0]]

    # Load returns_start_date for every account (keyed by account_id)
    user_start_dates: dict[int, date] = {}
    for acct in accounts.values():
        if acct.returns_start_date:
            user_start_dates[acct.id] = acct.returns_start_date

    results = []
    for key, date_map in by_group.items():
        meta = group_meta.get(key)
        if meta is None:
            continue
        sorted_dates = sorted(date_map.keys())
        end_mv, end_inc, end_inv = date_map[sorted_dates[-1]]

        # User-set date overrides auto effective inception
        group_user_dates = [user_start_dates[aid] for aid in meta["account_ids"] if aid in user_start_dates]
        if group_user_dates:
            custom_start = min(group_user_dates)
            snap_start   = next((d for d in sorted_dates if d >= custom_start), sorted_dates[0])
            eff_date     = snap_start
            eff_snap     = date_map[snap_start]
            date_custom  = True
        else:
            eff_date, eff_snap = _effective_inception(date_map, end_mv)
            date_custom = False

        row_result = {
            "account_ids":           meta["account_ids"],
            "account_name":          meta["account_name"],
            "account_type":          meta["account_type"],
            "brokerage":             meta["brokerage"],
            "current_value":         float(end_mv),
            "inception_date":        eff_date.isoformat(),
            "inception_date_custom": date_custom,
            "returns": {},
        }
        for label, start_date in period_starts.items():
            if eff_date > start_date:
                row_result["returns"][label] = None
            else:
                snap = _closest(date_map, start_date)
                if snap is None:
                    row_result["returns"][label] = None
                else:
                    s_mv, s_inc, s_inv = snap
                    row_result["returns"][label] = _total_return_pct(
                        end_mv, end_inc, end_inv, s_mv, s_inc, s_inv
                    )
        eff_mv, eff_inc, eff_inv = eff_snap
        row_result["returns"]["inception"] = _total_return_pct(
            end_mv, end_inc, end_inv, eff_mv, eff_inc, eff_inv
        )
        results.append(row_result)

    return sorted(results, key=lambda r: r["account_name"])


@router.get("/jobs/{job_id}")
def get_portfolio_job(job_id: str):
    """Poll status of a portfolio background job."""
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/performance/returns-detail")
def get_returns_detail(
    from_date: Optional[date] = Query(None, description="Period start (YYYY-MM-DD)"),
    to_date:   Optional[date] = Query(None, description="Period end (YYYY-MM-DD); defaults to today"),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs to include"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return the full numerator/denominator breakdown for total return over an
    arbitrary period for every logical account group.

    Response per row:
      account_name, account_type, brokerage,
      from_date, to_date,
      start_market_value, end_market_value, price_change,
      period_income, capital_returned,
      total_gain, start_value (denominator), return_pct
    """
    from app.models.master import Account, Brokerage
    from decimal import Decimal as D
    from collections import defaultdict

    if to_date is None:
        to_date = date.today()

    authorized_ids = parse_account_ids(account_ids, current_user, db)
    parsed_ids: Optional[set[int]] = set(authorized_ids) if authorized_ids is not None else None

    accounts   = {a.id: a for a in db.query(Account).all()}
    brokerages = {b.id: b.name for b in db.query(Brokerage).all()}

    # ── Logical group helpers ─────────────────────────────────────────────────
    def _logical_name(a: Account) -> str:
        return a.name.replace(" (USD)", "").strip()

    def _group_key(a: Account) -> tuple:
        return (_logical_name(a), a.brokerage_id, a.account_type)

    acct_to_group: dict[int, tuple] = {}
    group_meta: dict[tuple, dict]   = {}
    for acct in accounts.values():
        if parsed_ids and acct.id not in parsed_ids:
            continue
        key = _group_key(acct)
        acct_to_group[acct.id] = key
        if key not in group_meta:
            group_meta[key] = {
                "account_name": _logical_name(acct),
                "account_type": acct.account_type,
                "brokerage":    brokerages.get(acct.brokerage_id, ""),
                "account_ids":  [],
            }
        group_meta[key]["account_ids"].append(acct.id)

    # ── Load snapshots (view when available, raw table as fallback) ───────────
    snap_rows, _src = _query_snapshot_rows(db, parsed_ids)

    # by_group[key][snap_date] = (mv, inc, inv)
    by_group: dict[tuple, dict[date, tuple[D, D, D]]] = defaultdict(
        lambda: defaultdict(lambda: (D(0), D(0), D(0)))
    )
    for row in snap_rows:
        key = acct_to_group.get(row.account_id)
        if key is None:
            continue
        snap_date = row.snapshot_date
        if isinstance(snap_date, str):
            from datetime import datetime as _dt
            snap_date = _dt.strptime(snap_date, "%Y-%m-%d").date()
        mv  = D(str(row.market_value_cad or 0))
        inc = D(str(row.income_cad or 0))
        inv = D(str(row.invested_cad or 0))
        ex  = by_group[key][snap_date]
        by_group[key][snap_date] = (ex[0]+mv, ex[1]+inc, ex[2]+inv)

    # ── Last transaction date per group (skip dormant/closed accounts) ────────
    from app.models.transactions import Transaction
    from sqlalchemy import func as sqlfunc
    _last_txn_q = (
        db.query(Transaction.account_id, sqlfunc.max(Transaction.transaction_date))
        .group_by(Transaction.account_id)
    )
    if parsed_ids:
        _last_txn_q = _last_txn_q.filter(Transaction.account_id.in_(parsed_ids))
    _group_last_txn: dict[tuple, date] = {}
    for acct_id, last_dt in _last_txn_q.all():
        key = acct_to_group.get(acct_id)
        if key and last_dt:
            dt = last_dt if isinstance(last_dt, date) else last_dt.date()
            prev = _group_last_txn.get(key)
            _group_last_txn[key] = max(dt, prev) if prev else dt

    _TWO_YEARS = timedelta(days=730)

    results = []
    for key, date_map in by_group.items():
        meta = group_meta.get(key)
        if meta is None:
            continue

        sorted_dates = sorted(date_map.keys())

        # Determine period start date
        effective_start = from_date if from_date else sorted_dates[0]

        # Skip accounts whose last transaction is more than 2 years before the
        # period start — these are closed/dormant accounts where snapshot data
        # represents stale carry-forward positions, not real holdings.
        last_txn = _group_last_txn.get(key)
        if last_txn and (effective_start - last_txn) > _TWO_YEARS:
            continue

        md_result = _modified_dietz(date_map, effective_start, to_date)
        if md_result is None:
            continue
        return_pct, md_denominator = md_result

        # Collect raw components for transparency display
        s = _snap_at_date(date_map, effective_start)
        e = _snap_at_date(date_map, to_date)
        if s is None or e is None:
            continue
        s_mv, s_inc, s_inv = s
        e_mv, e_inc, e_inv = e

        net_flows     = float(e_inv - s_inv)    # total net capital change (+ = contributions, − = withdrawals)
        period_income = float(e_inc - s_inc)    # cumulative income received
        # Modified Dietz numerator: value change minus flows plus income
        numerator     = float((e_mv - s_mv) - (e_inv - s_inv) + (e_inc - s_inc))

        results.append({
            "account_ids":         meta["account_ids"],
            "account_name":        meta["account_name"],
            "account_type":        meta["account_type"],
            "brokerage":           meta["brokerage"],
            "from_date":           effective_start.isoformat(),
            "to_date":             to_date.isoformat(),
            "start_market_value":  float(s_mv),
            "end_market_value":    float(e_mv),
            "net_flows":           net_flows,       # net capital change (+ = contributions, - = withdrawals)
            "period_income":       period_income,
            "total_gain":          numerator,       # Modified Dietz numerator
            "return_pct":          return_pct,
            "md_denominator":      md_denominator,  # V0 + weighted flows; use for correct aggregate return
        })

    return sorted(results, key=lambda r: r["account_name"])


@router.get("/performance/monthly-returns")
def get_monthly_returns(
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    year_from:   Optional[int]  = Query(None),
    year_to:     Optional[int]  = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return a month-by-month total return matrix for every logical account group.

    Response:
      months: ["2023-01", "2023-02", ...]   (all months in range)
      rows: [{account_name, account_type, brokerage, account_ids,
              monthly: {"2023-01": pct|null, ...},
              annual:  {"2023": pct|null, ...}}]
    """
    from app.models.master import Account, Brokerage
    from decimal import Decimal as D
    from collections import defaultdict
    import calendar

    authorized_ids = parse_account_ids(account_ids, current_user, db)
    parsed_ids: Optional[set[int]] = set(authorized_ids) if authorized_ids is not None else None

    accounts   = {a.id: a for a in db.query(Account).all()}
    brokerages = {b.id: b.name for b in db.query(Brokerage).all()}

    def _logical_name(a: Account) -> str:
        return a.name.replace(" (USD)", "").strip()

    def _group_key(a: Account) -> tuple:
        return (_logical_name(a), a.brokerage_id, a.account_type)

    acct_to_group: dict[int, tuple] = {}
    group_meta: dict[tuple, dict]   = {}
    for acct in accounts.values():
        if parsed_ids and acct.id not in parsed_ids:
            continue
        key = _group_key(acct)
        acct_to_group[acct.id] = key
        if key not in group_meta:
            group_meta[key] = {
                "account_name": _logical_name(acct),
                "account_type": acct.account_type,
                "brokerage":    brokerages.get(acct.brokerage_id, ""),
                "account_ids":  [],
            }
        group_meta[key]["account_ids"].append(acct.id)

    # ── Load snapshots (view when available, raw table as fallback) ───────────
    snap_rows, _src = _query_snapshot_rows(db, parsed_ids)

    by_group: dict[tuple, dict[date, tuple[D, D, D]]] = defaultdict(
        lambda: defaultdict(lambda: (D(0), D(0), D(0)))
    )
    for row in snap_rows:
        key = acct_to_group.get(row.account_id)
        if key is None:
            continue
        snap_date = row.snapshot_date
        if isinstance(snap_date, str):
            from datetime import datetime as _dt
            snap_date = _dt.strptime(snap_date, "%Y-%m-%d").date()
        mv  = D(str(row.market_value_cad or 0))
        inc = D(str(row.income_cad or 0))
        inv = D(str(row.invested_cad or 0))
        ex  = by_group[key][snap_date]
        by_group[key][snap_date] = (ex[0]+mv, ex[1]+inc, ex[2]+inv)

    # ── Last transaction date per group (skip dormant/closed accounts) ────────
    from app.models.transactions import Transaction
    from sqlalchemy import func as sqlfunc
    _ltq = (
        db.query(Transaction.account_id, sqlfunc.max(Transaction.transaction_date))
        .group_by(Transaction.account_id)
    )
    if parsed_ids:
        _ltq = _ltq.filter(Transaction.account_id.in_(parsed_ids))
    _group_last_txn: dict[tuple, date] = {}
    for acct_id, last_dt in _ltq.all():
        key = acct_to_group.get(acct_id)
        if key and last_dt:
            dt = last_dt if isinstance(last_dt, date) else last_dt.date()
            prev = _group_last_txn.get(key)
            _group_last_txn[key] = max(dt, prev) if prev else dt

    _TWO_YEARS = timedelta(days=730)

    def _eom(y: int, m: int) -> date:
        return date(y, m, calendar.monthrange(y, m)[1])

    # Determine year range from data
    all_dates = [d for dm in by_group.values() for d in dm.keys()]
    if not all_dates:
        return {"months": [], "rows": []}

    data_year_from = min(d.year for d in all_dates)
    data_year_to   = max(d.year for d in all_dates)
    y_from = max(year_from or data_year_from, data_year_from)
    y_to   = min(year_to   or data_year_to,   data_year_to)

    # Build ordered list of months and years
    month_keys = []
    year_keys  = []
    for y in range(y_from, y_to + 1):
        year_keys.append(str(y))
        for m in range(1, 13):
            if date(y, m, 1) <= date.today():
                month_keys.append(f"{y}-{m:02d}")

    rows = []
    for key, date_map in by_group.items():
        meta = group_meta.get(key)
        if meta is None:
            continue

        monthly: dict[str, Optional[float]] = {}
        for mk in month_keys:
            y, m = int(mk[:4]), int(mk[5:])
            prev_eom = _eom(y, m-1) if m > 1 else _eom(y-1, 12)
            this_eom = _eom(y, m)
            monthly[mk] = _modified_dietz_return(date_map, prev_eom, this_eom)

        annual: dict[str, Optional[float]] = {}
        for yk in year_keys:
            y = int(yk)
            dec31_prev = date(y - 1, 12, 31)
            dec31_this = min(date(y, 12, 31), date.today())
            annual[yk] = _modified_dietz_return(date_map, dec31_prev, dec31_this)

        # Skip accounts whose last transaction is more than 2 years before the
        # start of the requested year range — closed/dormant accounts with stale
        # snapshot data that would produce phantom returns.
        _period_start = date(y_from, 1, 1)
        last_txn = _group_last_txn.get(key)
        if last_txn and (_period_start - last_txn) > _TWO_YEARS:
            continue

        # Skip accounts with no meaningful data in range
        if all(v is None for v in monthly.values()):
            continue

        rows.append({
            "account_ids":  meta["account_ids"],
            "account_name": meta["account_name"],
            "account_type": meta["account_type"],
            "brokerage":    meta["brokerage"],
            "monthly":      monthly,
            "annual":       annual,
        })

    return {
        "months":      month_keys,
        "years":       year_keys,
        "rows":        sorted(rows, key=lambda r: r["account_name"]),
    }
