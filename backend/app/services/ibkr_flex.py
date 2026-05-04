"""
IBKR Flex Query service.

Fetches activity reports from IBKR's cloud Flex Query API, parses the XML,
and imports transactions into the portfolio tracker.

Flow:
  1. POST SendRequest → get ReferenceCode
  2. Poll GetStatement with ReferenceCode until data is ready
  3. Parse XML → Trades + CashTransactions
  4. Deduplicate via transactions.external_ref
  5. Insert new transactions using the same normalizer as CSV imports
"""
from __future__ import annotations

import hashlib
import logging
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

FLEX_SEND_URL = (
    "https://gdcdyn.interactivebrokers.com"
    "/Universal/servlet/FlexStatementService.SendRequest"
)
FLEX_GET_URL = (
    "https://gdcdyn.interactivebrokers.com"
    "/Universal/servlet/FlexStatementService.GetStatement"
)

# ── Type mapping ──────────────────────────────────────────────────────────────

# Cash transaction type → our transaction_type
# None means derive from amount sign
CASH_TYPE_MAP: dict[str, Optional[str]] = {
    "Dividends":                        "DIVIDEND",
    "Payment In Lieu Of Dividends":     "DIVIDEND",
    "Withholding Tax":                  "WITHHOLDING",
    "Interest":                         "INTEREST",
    "Broker Interest Paid":             "INTEREST",
    "Broker Interest Received":         "INTEREST",
    "Deposits/Withdrawals":             None,       # sign determines type
    "Electronic Fund Transfer":         None,
    "Other Fees":                       "FEE",
    "Commission Adjustments":           "FEE",
    "DRIP (Dividend Reinvestment)":     "DRIP",
}

# Cash types to silently skip
SKIP_CASH_TYPES = {
    "Transfers",
    "Internal Transfers",
    "Bill Payment",
    "Bonds",
    "Guaranteed Investment Certificates",
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _d(v: Optional[str]) -> Optional[Decimal]:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v))
    except Exception:
        return None


def _parse_ibkr_date(s: str) -> Optional[date]:
    """Parse IBKR date YYYYMMDD (ignores time portion after ;)."""
    if not s:
        return None
    try:
        return datetime.strptime(s[:8], "%Y%m%d").date()
    except ValueError:
        return None


def _ext_ref_trade(trade_id: str) -> str:
    return f"ibkr-trade-{trade_id}"


def _ext_ref_cash(account_id: str, dt: str, txn_type: str, symbol: str, amount: str) -> str:
    key = f"{account_id}|{dt[:8]}|{txn_type}|{symbol}|{amount}"
    h = hashlib.sha1(key.encode()).hexdigest()[:12]
    return f"ibkr-cash-{h}"


# ── Flex Query API ────────────────────────────────────────────────────────────

def fetch_flex_report(token: str, query_id: str) -> str:
    """
    Call the IBKR Flex Query API synchronously (for use in background threads).
    Returns the raw XML string of the report.
    """
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        # Step 1 — submit request
        resp = client.get(FLEX_SEND_URL, params={"t": token, "q": query_id, "v": "3"})
        resp.raise_for_status()

        try:
            xml1 = ET.fromstring(resp.text)
        except ET.ParseError as exc:
            raise RuntimeError(f"Unexpected Flex API response: {resp.text[:200]}") from exc

        status = xml1.findtext("Status")
        if status != "Success":
            err = xml1.findtext("ErrorMessage") or resp.text[:300]
            raise RuntimeError(f"Flex Query submit failed: {err}")

        ref_code = xml1.findtext("ReferenceCode")
        url = xml1.findtext("Url") or FLEX_GET_URL
        if not ref_code:
            raise RuntimeError("No ReferenceCode in Flex API response")

        logger.info("Flex Query submitted, reference=%s", ref_code)

        # Step 2 — poll until ready (max ~50 s)
        for attempt in range(10):
            time.sleep(3 if attempt == 0 else 5)
            resp2 = client.get(url, params={"q": ref_code, "t": token, "v": "3"})
            resp2.raise_for_status()

            # Still generating?
            if (
                "Statement generation" in resp2.text
                or "<Status>Warn" in resp2.text
                or "<ErrorCode>1019</ErrorCode>" in resp2.text  # "Try again"
            ):
                logger.debug("Flex Query still generating (attempt %d)", attempt + 1)
                continue

            logger.info("Flex Query ready after %d polls", attempt + 1)
            return resp2.text

        raise RuntimeError("Flex Query timed out after 10 polling attempts (~50 s)")


# ── XML parsing ───────────────────────────────────────────────────────────────

def parse_flex_xml(xml_str: str) -> dict:
    """
    Parse a Flex Query XML response.
    Returns {'trades': [...], 'cash': [...], 'positions': [...], 'ibkr_account_id': str}
    """
    root = ET.fromstring(xml_str)

    # FlexQueryResponse > FlexStatements > FlexStatement
    stmt = root.find(".//FlexStatement")
    if stmt is None:
        raise RuntimeError("No FlexStatement element found in XML")

    ibkr_account_id = stmt.get("accountId", "")

    trades = []
    for el in stmt.findall(".//Trade"):
        # Skip cancelled trades
        buy_sell = el.get("buySell", "")
        if "Ca." in buy_sell:
            continue
        asset_cat = el.get("assetCategory", "STK")
        trade_id = el.get("tradeID", "")
        if not trade_id:
            continue

        trades.append({
            "trade_id":      trade_id,
            "buy_sell":      buy_sell.strip(),       # BUY | SELL
            "asset_category": asset_cat,              # STK | OPT | CASH | FUT
            "symbol":        el.get("symbol", ""),
            "description":   el.get("description", ""),
            "trade_date":    el.get("tradeDate", ""),
            "settle_date":   el.get("settleDateTarget", ""),
            "quantity":      el.get("quantity", ""),
            "price":         el.get("tradePrice", ""),
            "trade_money":   el.get("tradeMoney", ""),   # qty × price (no commission)
            "commission":    el.get("ibCommission", ""),
            "comm_currency": el.get("ibCommissionCurrency", ""),
            "currency":      el.get("currency", ""),
            "exchange":      el.get("exchange", ""),
        })

    cash = []
    for el in stmt.findall(".//CashTransaction"):
        txn_type = el.get("type", "")
        if txn_type in SKIP_CASH_TYPES:
            continue
        cash.append({
            "type":     txn_type,
            "symbol":   el.get("symbol", ""),
            "amount":   el.get("amount", ""),
            "currency": el.get("currency", ""),
            "date":     el.get("dateTime", el.get("date", "")),
            "desc":     el.get("description", ""),
        })

    positions = []
    for el in stmt.findall(".//OpenPosition"):
        positions.append({
            "symbol":        el.get("symbol", ""),
            "quantity":      el.get("position", ""),
            "currency":      el.get("currency", ""),
            "mark_price":    el.get("markPrice", ""),
            "cost_price":    el.get("costBasisPrice", ""),
            "position_value": el.get("positionValue", ""),
        })

    return {
        "ibkr_account_id": ibkr_account_id,
        "trades":    trades,
        "cash":      cash,
        "positions": positions,
    }


# ── Import ────────────────────────────────────────────────────────────────────

def _already_imported(db: Session, external_ref: str) -> bool:
    from sqlalchemy import text
    row = db.execute(
        text("SELECT id FROM transactions WHERE external_ref = :ref LIMIT 1"),
        {"ref": external_ref},
    ).fetchone()
    return row is not None


def import_trades(db: Session, account_id: int, trades: list[dict]) -> int:
    """
    Import trade rows into the transactions table.
    Returns count of newly inserted transactions.
    """
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    imported = 0
    for t in trades:
        ext_ref = _ext_ref_trade(t["trade_id"])
        if _already_imported(db, ext_ref):
            continue

        trade_date = _parse_ibkr_date(t["trade_date"])
        if not trade_date:
            logger.warning("Skipping trade %s — unparseable date %s", t["trade_id"], t["trade_date"])
            continue

        buy_sell = t["buy_sell"]
        if buy_sell not in ("BUY", "SELL"):
            logger.debug("Skipping trade %s — unexpected buySell=%s", t["trade_id"], buy_sell)
            continue

        ticker = t["symbol"].upper().strip()
        if not ticker:
            continue

        # Look up / create security
        sec = get_or_create_security(
            db,
            ticker=ticker,
            currency=t["currency"],
            exchange=t["exchange"] or None,
        )

        currency = t["currency"] or "USD"
        qty  = _d(t["quantity"])
        price = _d(t["price"])
        comm  = _d(t["commission"])  # negative in IBKR
        trade_money = _d(t["trade_money"])

        # IBKR quantity is signed (negative for SELL); we store absolute, type captures direction
        if qty is not None:
            qty = abs(qty)

        # Commission is negative in IBKR; store as positive absolute
        if comm is not None:
            comm = abs(comm)

        # transaction_amount = gross proceeds/cost (no commission)
        txn_amount = trade_money
        if txn_amount is not None:
            txn_amount = abs(txn_amount)

        # FX to CAD
        fx_to_cad = None
        cad_amount = None
        if currency != "CAD":
            fx_to_cad = get_rate(db, trade_date, currency, "CAD")
        if fx_to_cad and txn_amount:
            cad_amount = (txn_amount * fx_to_cad).quantize(Decimal("0.01"))

        txn = Transaction(
            account_id=account_id,
            security_id=sec.id,
            transaction_date=trade_date,
            settlement_date=_parse_ibkr_date(t["settle_date"]),
            transaction_type=buy_sell,
            quantity=qty,
            price=price,
            commission=comm,
            transaction_currency=currency,
            transaction_amount=txn_amount,
            fx_rate_to_cad=fx_to_cad,
            cad_amount=cad_amount,
            raw_description=t["description"][:500] if t["description"] else None,
            external_ref=ext_ref,
        )
        db.add(txn)
        imported += 1

    if imported:
        db.commit()
    return imported


def import_cash(db: Session, account_id: int, cash_rows: list[dict], ibkr_account_id: str) -> int:
    """
    Import cash transaction rows.
    Returns count of newly inserted transactions.
    """
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    imported = 0
    for row in cash_rows:
        txn_type_raw = row["type"]
        ext_ref = _ext_ref_cash(ibkr_account_id, row["date"], txn_type_raw, row["symbol"], row["amount"])
        if _already_imported(db, ext_ref):
            continue

        txn_date = _parse_ibkr_date(row["date"])
        if not txn_date:
            logger.warning("Skipping cash txn — unparseable date %s", row["date"])
            continue

        amount = _d(row["amount"])
        if amount is None:
            continue

        # Map type
        if txn_type_raw in SKIP_CASH_TYPES:
            continue

        our_type = CASH_TYPE_MAP.get(txn_type_raw)
        if our_type is None:
            # Deposits/Withdrawals — derive from sign
            if txn_type_raw in ("Deposits/Withdrawals", "Electronic Fund Transfer"):
                our_type = "CONTRIBUTION" if amount > 0 else "WITHDRAWAL"
            else:
                logger.debug("Unrecognised cash type %r — skipping", txn_type_raw)
                continue

        currency = row["currency"] or "CAD"
        ticker   = row["symbol"].strip().upper() if row["symbol"] else None

        # Look up security if ticker present (dividends, interest on a holding)
        sec_id = None
        if ticker:
            try:
                sec = get_or_create_security(db, ticker=ticker, currency=currency)
                sec_id = sec.id
            except Exception:
                pass

        # FX to CAD
        abs_amount = abs(amount)
        fx_to_cad  = None
        cad_amount = None
        if currency != "CAD":
            fx_to_cad = get_rate(db, txn_date, currency, "CAD")
        if fx_to_cad:
            cad_amount = (abs_amount * fx_to_cad).quantize(Decimal("0.01"))
        else:
            cad_amount = abs_amount if currency == "CAD" else None

        txn = Transaction(
            account_id=account_id,
            security_id=sec_id,
            transaction_date=txn_date,
            transaction_type=our_type,
            quantity=None,
            price=None,
            commission=None,
            transaction_currency=currency,
            transaction_amount=abs_amount,
            fx_rate_to_cad=fx_to_cad,
            cad_amount=cad_amount,
            raw_description=row["desc"][:500] if row["desc"] else None,
            external_ref=ext_ref,
        )
        db.add(txn)
        imported += 1

    if imported:
        db.commit()
    return imported


# ── High-level sync ───────────────────────────────────────────────────────────

def sync_account(db: Session, config) -> dict:
    """
    Sync one IBKR account using its Flex Query config.
    Updates config.last_sync_* fields.
    Returns {'imported': int, 'error': str|None}.
    """
    from app.models.ibkr import IBKRFlexConfig
    from datetime import date as _date

    config.last_sync_status = "running"
    config.last_sync_message = None
    db.commit()

    try:
        xml_str = fetch_flex_report(config.token, config.query_id)
        parsed  = parse_flex_xml(xml_str)

        trades_imported = import_trades(db, config.account_id, parsed["trades"])
        cash_imported   = import_cash(db, config.account_id, parsed["cash"], parsed["ibkr_account_id"])
        total = trades_imported + cash_imported

        config.last_sync_at       = datetime.utcnow()
        config.last_sync_status   = "ok"
        config.last_sync_imported = total
        config.last_sync_message  = (
            f"{trades_imported} trade(s), {cash_imported} cash transaction(s) imported"
        )
        db.commit()

        logger.info(
            "Flex sync account_id=%s: %d trades + %d cash = %d new",
            config.account_id, trades_imported, cash_imported, total,
        )
        return {"imported": total, "error": None}

    except Exception as exc:
        msg = str(exc) or type(exc).__name__
        logger.exception("Flex sync failed for account_id=%s", config.account_id)
        config.last_sync_at     = datetime.utcnow()
        config.last_sync_status = "error"
        config.last_sync_message = msg[:1000]
        db.commit()
        return {"imported": 0, "error": msg}


def sync_all_accounts(db: Session) -> list[dict]:
    """Sync all enabled IBKR flex configs. Used by nightly scheduler."""
    from app.models.ibkr import IBKRFlexConfig
    configs = db.query(IBKRFlexConfig).filter(IBKRFlexConfig.enabled == True).all()  # noqa: E712
    results = []
    for cfg in configs:
        result = sync_account(db, cfg)
        results.append({"account_id": cfg.account_id, **result})
    return results
