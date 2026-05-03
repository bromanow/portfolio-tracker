"""
Interactive Brokers Detailed Trades CSV parser (~80 columns).
Aggregates execution splits by IBOrderID.
"""
import csv
import io
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional
import logging

logger = logging.getLogger(__name__)


def _parse_decimal(val) -> Optional[Decimal]:
    if val is None:
        return None
    cleaned = str(val).replace(",", "").strip()
    if cleaned in ("", "-", "N/A", "--", "0"):
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _parse_decimal_zero(val) -> Decimal:
    """Like _parse_decimal but returns 0 for empty."""
    d = _parse_decimal(val)
    return d if d is not None else Decimal("0")


def _parse_date(val: str) -> Optional[date]:
    if not val or not val.strip():
        return None
    val = val.strip()
    # Handle datetime format with time component
    if " " in val:
        val = val.split(" ")[0]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(val, fmt).date()
        except ValueError:
            continue
    return None


def parse_ibkr_trades_csv(content: str) -> list[dict]:
    """
    Parse IB detailed trades CSV.
    Aggregates by IBOrderID.
    Returns list of order-level dicts.
    """
    reader = csv.DictReader(io.StringIO(content))

    # Group by IBOrderID
    orders: dict[str, list[dict]] = {}

    for row in reader:
        row = {k.strip(): (v.strip() if v else "") for k, v in row.items() if k}

        order_id = row.get("IBOrderID", "") or row.get("OrderID", "")
        if not order_id:
            continue

        if order_id not in orders:
            orders[order_id] = []
        orders[order_id].append(row)

    results = []

    for order_id, executions in orders.items():
        if not executions:
            continue

        first = executions[0]

        # Sum quantities (positive for buy, negative for sell)
        total_quantity = sum(_parse_decimal_zero(e.get("Quantity", "0")) for e in executions)

        # Weighted average price
        total_proceeds = sum(_parse_decimal_zero(e.get("Proceeds", "0")) for e in executions)
        total_commission = sum(_parse_decimal_zero(e.get("IBCommission", "0")) for e in executions)
        total_net_cash = sum(_parse_decimal_zero(e.get("NetCash", "0")) for e in executions)

        # Average price
        if total_quantity != 0:
            avg_price = abs(total_proceeds / total_quantity)
        else:
            avg_price = _parse_decimal_zero(first.get("TradePrice", "0"))

        asset_class = first.get("AssetClass", "STK")
        sub_category = first.get("SubCategory", "")
        symbol = first.get("Symbol", "")
        description = first.get("Description", "")
        currency = first.get("CurrencyPrimary", "USD")
        account_id = first.get("ClientAccountID", "")
        account_alias = first.get("AccountAlias", "")
        trade_date = _parse_date(first.get("TradeDate", ""))
        buy_sell = first.get("Buy/Sell", "").upper()

        # FX rate to base currency
        fx_rate = _parse_decimal(first.get("FXRateToBase", "1"))

        # Option fields
        option_info = None
        is_option = asset_class == "OPT" or sub_category in ("OPT", "OPTION")
        if is_option:
            strike = _parse_decimal(first.get("Strike", ""))
            expiry_str = first.get("Expiry", "")
            put_call = first.get("Put/Call", "")
            underlying = first.get("UnderlyingSymbol", symbol)
            expiry = _parse_date(expiry_str)
            if strike and expiry:
                option_info = {
                    "option_type": put_call.upper() if put_call else "CALL",
                    "underlying": underlying,
                    "expiry": expiry,
                    "strike": strike,
                }

        # Determine canonical type
        is_forex = asset_class == "CASH"
        if is_forex:
            canonical_type = "FX_CONVERSION"
        elif is_option:
            canonical_type = "OPTION_BUY" if buy_sell == "BUY" else "OPTION_SELL"
        else:
            canonical_type = "BUY" if buy_sell == "BUY" else "SELL"

        results.append({
            "order_id": order_id,
            "account_id": account_id,
            "account_alias": account_alias,
            "raw_symbol": symbol,
            "raw_description": description,
            "ticker": symbol,
            "asset_class": asset_class,
            "is_option": is_option,
            "option_info": option_info,
            "transaction_type": canonical_type,
            "transaction_date": trade_date,
            "quantity": total_quantity,
            "price": avg_price,
            "transaction_currency": currency,
            "proceeds": total_proceeds,
            "commission": total_commission,
            "net_cash": total_net_cash,
            "fx_rate_to_base": fx_rate,
            "brokerage": "IBKR",
        })

    return results


def detect_ibkr_trades_format(content: str) -> bool:
    """Return True if the file looks like an IB Detailed Trades CSV."""
    first_line = content.split("\n")[0]
    return "IBOrderID" in first_line or ("AssetClass" in first_line and "TradePrice" in first_line)
