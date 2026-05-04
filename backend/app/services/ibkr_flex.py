"""
IBKR Flex Query service.

One Flex Query per user covers all their IBKR accounts.
Each FlexStatement in the XML has accountId (e.g. "U21463905") which is
matched to accounts.account_number to route transactions to the right account.

Flow:
  1. SendRequest  → ReferenceCode
  2. Poll GetStatement until XML is ready
  3. Parse XML → one FlexStatement per IBKR account
  4. For each statement: look up Account by account_number = accountId
  5. Import Trades + CashTransactions with deduplication via external_ref
"""
from __future__ import annotations

import hashlib
import logging
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
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

# ── Transaction type mapping ──────────────────────────────────────────────────

# IBKR cash transaction type → our transaction_type
# None = derive from amount sign
CASH_TYPE_MAP: dict[str, Optional[str]] = {
    "Dividends":                        "DIVIDEND",
    "Payment In Lieu Of Dividends":     "DIVIDEND",
    "Withholding Tax":                  "WITHHOLDING",
    "Interest":                         "INTEREST",
    "Broker Interest Paid":             "INTEREST",
    "Broker Interest Received":         "INTEREST",
    "Deposits/Withdrawals":             None,   # sign → CONTRIBUTION / WITHDRAWAL
    "Electronic Fund Transfer":         None,
    "Other Fees":                       "FEE",
    "Commission Adjustments":           "FEE",
    "DRIP (Dividend Reinvestment)":     "DRIP",
}

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
    """Parse YYYYMMDD (ignores time portion after semicolon)."""
    if not s:
        return None
    try:
        return datetime.strptime(s[:8], "%Y%m%d").date()
    except ValueError:
        return None


def _ext_ref_trade(trade_id: str) -> str:
    return f"ibkr-trade-{trade_id}"


def _ext_ref_cash(ibkr_account_id: str, dt: str, txn_type: str, symbol: str, amount: str) -> str:
    key = f"{ibkr_account_id}|{dt[:8]}|{txn_type}|{symbol}|{amount}"
    h = hashlib.sha1(key.encode()).hexdigest()[:12]
    return f"ibkr-cash-{h}"


def _already_imported(db: Session, external_ref: str) -> bool:
    from sqlalchemy import text
    row = db.execute(
        text("SELECT id FROM transactions WHERE external_ref = :ref LIMIT 1"),
        {"ref": external_ref},
    ).fetchone()
    return row is not None


def _stamp_existing_trade(
    db: Session, account_id: int, trade_date, txn_type: str,
    security_id: int, quantity, external_ref: str,
) -> bool:
    """
    Look for a CSV-imported trade (external_ref IS NULL) that matches by
    account + date + type + security + quantity.  If found, stamp it with
    the IBKR external_ref so future syncs skip it, and return True.
    """
    from sqlalchemy import text
    row = db.execute(text("""
        SELECT id FROM transactions
        WHERE account_id      = :acct
          AND transaction_date = :dt
          AND transaction_type = :type
          AND security_id      = :sec
          AND ABS(COALESCE(quantity, 0) - :qty) < 0.001
          AND external_ref IS NULL
        LIMIT 1
    """), {"acct": account_id, "dt": trade_date, "type": txn_type,
           "sec": security_id, "qty": float(quantity or 0)}).fetchone()
    if row:
        db.execute(
            text("UPDATE transactions SET external_ref = :ref WHERE id = :id"),
            {"ref": external_ref, "id": row[0]},
        )
        logger.info("Stamped existing trade id=%s with %s", row[0], external_ref)
        return True
    return False


def _stamp_existing_cash(
    db: Session, account_id: int, txn_date, txn_type: str,
    amount, security_id, external_ref: str,
) -> bool:
    """
    Look for a CSV-imported cash transaction (external_ref IS NULL) that
    matches by account + date + type + amount (± 0.01) + security.
    If found, stamp it with the IBKR external_ref and return True.
    """
    from sqlalchemy import text
    row = db.execute(text("""
        SELECT id FROM transactions
        WHERE account_id      = :acct
          AND transaction_date = :dt
          AND transaction_type = :type
          AND ABS(COALESCE(transaction_amount, 0) - :amt) < 0.01
          AND COALESCE(security_id, 0) = COALESCE(:sec, 0)
          AND external_ref IS NULL
        LIMIT 1
    """), {"acct": account_id, "dt": txn_date, "type": txn_type,
           "amt": float(amount or 0), "sec": security_id}).fetchone()
    if row:
        db.execute(
            text("UPDATE transactions SET external_ref = :ref WHERE id = :id"),
            {"ref": external_ref, "id": row[0]},
        )
        logger.info("Stamped existing cash txn id=%s with %s", row[0], external_ref)
        return True
    return False


# ── Flex Query API ────────────────────────────────────────────────────────────

def fetch_flex_report(token: str, query_id: str) -> str:
    """
    Call the IBKR Flex Query API (synchronous, for background threads).
    Date range is controlled by the IBKR query configuration (set to
    "Year to Date" in the IBKR portal). Deduplication prevents re-importing.
    Returns raw XML string.
    """
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        # Step 1 — submit request
        resp = client.get(FLEX_SEND_URL, params={
            "t": token,
            "q": query_id,
            "v": "3",
        })
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

        # Step 2 — poll until ready (up to ~50 s)
        for attempt in range(10):
            time.sleep(3 if attempt == 0 else 5)
            resp2 = client.get(url, params={"q": ref_code, "t": token, "v": "3"})
            resp2.raise_for_status()

            if (
                "Statement generation" in resp2.text
                or "<Status>Warn" in resp2.text
                or "<ErrorCode>1019</ErrorCode>" in resp2.text
            ):
                logger.debug("Flex Query still generating (attempt %d)", attempt + 1)
                continue

            logger.info("Flex Query ready after %d poll(s)", attempt + 1)
            return resp2.text

        raise RuntimeError("Flex Query timed out after 10 polling attempts (~50 s)")


# ── XML parsing ───────────────────────────────────────────────────────────────

def parse_flex_xml(xml_str: str) -> list[dict]:
    """
    Parse a Flex Query XML response.
    Returns a list of per-account dicts:
      { ibkr_account_id, trades: [...], cash: [...] }
    One entry per FlexStatement (= one per IBKR account in the query).
    """
    root = ET.fromstring(xml_str)
    statements = root.findall(".//FlexStatement")
    if not statements:
        raise RuntimeError("No FlexStatement elements found in XML")

    results = []
    for stmt in statements:
        ibkr_account_id = stmt.get("accountId", "")

        trades = []
        for el in stmt.findall(".//Trade"):
            buy_sell = el.get("buySell", "")
            if "Ca." in buy_sell:   # cancelled trade
                continue
            trade_id = el.get("tradeID", "")
            if not trade_id:
                continue
            trades.append({
                "trade_id":       trade_id,
                "buy_sell":       buy_sell.strip(),
                "asset_category": el.get("assetCategory", "STK"),
                "symbol":         el.get("symbol", ""),
                "description":    el.get("description", ""),
                "trade_date":     el.get("tradeDate", ""),
                "settle_date":    el.get("settleDateTarget", ""),
                "quantity":       el.get("quantity", ""),
                "price":          el.get("tradePrice", ""),
                "trade_money":    el.get("tradeMoney", ""),
                "commission":     el.get("ibCommission", ""),
                "comm_currency":  el.get("ibCommissionCurrency", ""),
                "currency":       el.get("currency", ""),
                "exchange":       el.get("exchange", ""),
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

        results.append({
            "ibkr_account_id": ibkr_account_id,
            "trades":          trades,
            "cash":            cash,
        })

    return results


# ── Import helpers ────────────────────────────────────────────────────────────

def _find_account_by_number(db: Session, account_number: str):
    """Look up an Account by its account_number (the IBKR U-number)."""
    from app.models.master import Account
    return db.query(Account).filter(Account.account_number == account_number).first()


def import_trades(db: Session, account_id: int, trades: list[dict]) -> int:
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
            logger.warning("Skipping trade %s — bad date %s", t["trade_id"], t["trade_date"])
            continue

        buy_sell = t["buy_sell"]
        if buy_sell not in ("BUY", "SELL"):
            logger.debug("Skipping trade %s — unrecognised buySell=%s", t["trade_id"], buy_sell)
            continue

        ticker = t["symbol"].upper().strip()
        if not ticker:
            continue

        sec = get_or_create_security(db, ticker=ticker, currency=t["currency"],
                                     exchange=t["exchange"] or None)

        currency    = t["currency"] or "USD"
        qty         = _d(t["quantity"])
        price       = _d(t["price"])
        commission  = _d(t["commission"])
        trade_money = _d(t["trade_money"])

        if qty is not None:
            qty = abs(qty)
        if commission is not None:
            commission = abs(commission)   # IBKR reports negative; store positive
        txn_amount = abs(trade_money) if trade_money is not None else None

        # Check for existing CSV-imported trade (no external_ref) — stamp and skip
        if _stamp_existing_trade(db, account_id, trade_date, buy_sell, sec.id, qty, ext_ref):
            continue

        fx_to_cad = None
        cad_amount = None
        if currency != "CAD":
            fx_to_cad = get_rate(db, trade_date, currency, "CAD")
        if fx_to_cad and txn_amount:
            cad_amount = (txn_amount * fx_to_cad).quantize(Decimal("0.01"))

        db.add(Transaction(
            account_id=account_id,
            security_id=sec.id,
            transaction_date=trade_date,
            settlement_date=_parse_ibkr_date(t["settle_date"]),
            transaction_type=buy_sell,
            quantity=qty,
            price=price,
            commission=commission,
            transaction_currency=currency,
            transaction_amount=txn_amount,
            fx_rate_to_cad=fx_to_cad,
            cad_amount=cad_amount,
            raw_description=(t["description"] or "")[:500] or None,
            external_ref=ext_ref,
        ))
        imported += 1

    db.commit()   # also persists external_ref stamps on existing rows
    return imported


def import_cash(db: Session, account_id: int, cash_rows: list[dict], ibkr_account_id: str) -> int:
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    imported = 0
    for row in cash_rows:
        txn_type_raw = row["type"]
        if txn_type_raw in SKIP_CASH_TYPES:
            continue

        ext_ref = _ext_ref_cash(ibkr_account_id, row["date"], txn_type_raw,
                                 row["symbol"], row["amount"])
        if _already_imported(db, ext_ref):
            continue

        txn_date = _parse_ibkr_date(row["date"])
        if not txn_date:
            continue

        amount = _d(row["amount"])
        if amount is None:
            continue

        our_type = CASH_TYPE_MAP.get(txn_type_raw)
        if our_type is None:
            if txn_type_raw in ("Deposits/Withdrawals", "Electronic Fund Transfer"):
                our_type = "CONTRIBUTION" if amount >= 0 else "WITHDRAWAL"
            else:
                logger.debug("Unrecognised cash type %r — skipping", txn_type_raw)
                continue

        currency = row["currency"] or "CAD"
        ticker   = row["symbol"].strip().upper() if row["symbol"] else None

        sec_id = None
        if ticker:
            try:
                sec = get_or_create_security(db, ticker=ticker, currency=currency)
                sec_id = sec.id
            except Exception:
                pass

        abs_amount = abs(amount)

        # Check for existing CSV-imported cash txn (no external_ref) — stamp and skip
        if _stamp_existing_cash(db, account_id, txn_date, our_type, abs_amount, sec_id, ext_ref):
            continue

        fx_to_cad  = None
        cad_amount = None
        if currency != "CAD":
            fx_to_cad = get_rate(db, txn_date, currency, "CAD")
        cad_amount = (abs_amount * fx_to_cad).quantize(Decimal("0.01")) if fx_to_cad else (
            abs_amount if currency == "CAD" else None
        )

        db.add(Transaction(
            account_id=account_id,
            security_id=sec_id,
            transaction_date=txn_date,
            transaction_type=our_type,
            transaction_currency=currency,
            transaction_amount=abs_amount,
            fx_rate_to_cad=fx_to_cad,
            cad_amount=cad_amount,
            raw_description=(row["desc"] or "")[:500] or None,
            external_ref=ext_ref,
        ))
        imported += 1

    db.commit()   # also persists external_ref stamps on existing rows
    return imported


# ── High-level sync ───────────────────────────────────────────────────────────

def sync_config(db: Session, config) -> dict:
    """
    Sync one user's Flex Query config.
    Date range is set in IBKR portal (use "Year to Date").
    Deduplication via external_ref prevents double-importing existing data.
    """
    logger.info("Flex sync starting for user_id=%s", config.user_id)
    config.last_sync_status  = "running"
    config.last_sync_message = None
    db.commit()

    try:
        xml_str = fetch_flex_report(config.token, config.query_id)
        statements = parse_flex_xml(xml_str)

        total_trades = 0
        total_cash   = 0
        unmatched    = []

        for stmt in statements:
            ibkr_id = stmt["ibkr_account_id"]
            account = _find_account_by_number(db, ibkr_id)

            if account is None:
                logger.warning("No account with account_number=%r — skipping", ibkr_id)
                unmatched.append(ibkr_id)
                continue

            t = import_trades(db, account.id, stmt["trades"])
            c = import_cash(db, account.id, stmt["cash"], ibkr_id)
            logger.info("  %s (%s): %d trades + %d cash", ibkr_id, account.name, t, c)
            total_trades += t
            total_cash   += c

        total = total_trades + total_cash
        parts = [f"{total_trades} trade(s)", f"{total_cash} cash transaction(s)"]
        msg   = f"{' + '.join(parts)} imported across {len(statements) - len(unmatched)} account(s)"
        if unmatched:
            msg += f" — {len(unmatched)} IBKR account(s) not matched: {', '.join(unmatched)}"

        config.last_sync_at       = datetime.utcnow()
        config.last_sync_status   = "ok"
        config.last_sync_imported = total
        config.last_sync_message  = msg
        db.commit()

        logger.info("Flex sync user_id=%s: %s", config.user_id, msg)
        return {"imported": total, "error": None, "message": msg}

    except Exception as exc:
        msg = str(exc) or type(exc).__name__
        logger.exception("Flex sync failed for user_id=%s", config.user_id)
        config.last_sync_at      = datetime.utcnow()
        config.last_sync_status  = "error"
        config.last_sync_message = msg[:1000]
        db.commit()
        return {"imported": 0, "error": msg}


def sync_all_configs(db: Session) -> list[dict]:
    """Sync all enabled configs. Called by nightly scheduler."""
    from app.models.ibkr import IBKRFlexConfig
    configs = db.query(IBKRFlexConfig).filter(IBKRFlexConfig.enabled == True).all()  # noqa: E712
    return [{"user_id": cfg.user_id, **sync_config(db, cfg)} for cfg in configs]
