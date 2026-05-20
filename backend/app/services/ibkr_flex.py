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
    account + date + security + quantity (absolute value).

    Also matches OPTION_BUY/OPTION_SELL CSV rows against BUY/SELL from IBKR,
    since IBKR reports all trades as BUY or SELL regardless of asset category.

    If found, stamp it with the IBKR external_ref so future syncs skip it,
    and return True.
    """
    from sqlalchemy import text
    # Build the set of transaction types to match.  IBKR sends BUY/SELL for
    # options too; CSV imports may have stored them as OPTION_BUY/OPTION_SELL.
    alt_type = "OPTION_" + txn_type if txn_type in ("BUY", "SELL") else txn_type
    row = db.execute(text("""
        SELECT id FROM transactions
        WHERE account_id      = :acct
          AND transaction_date = :dt
          AND transaction_type IN (:type, :alt_type)
          AND security_id      = :sec
          AND ABS(ABS(COALESCE(quantity, 0)) - :qty) < 0.001
          AND external_ref IS NULL
        LIMIT 1
    """), {"acct": account_id, "dt": trade_date, "type": txn_type, "alt_type": alt_type,
           "sec": security_id, "qty": float(abs(quantity or 0))}).fetchone()
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

# IBKR transient errors on the SendRequest step that are safe to retry
_TRANSIENT_SUBMIT_PHRASES = (
    "Statement could not be generated",
    "Please try again",
    "try again shortly",
    "temporarily unavailable",
)


def _normalize_ibkr_url(raw: Optional[str], fallback: str) -> str:
    """
    Normalize a URL returned by the IBKR Flex API.
    Some IBKR environments omit the https:// scheme; add it if missing.
    Falls back to `fallback` when `raw` is None/empty.
    """
    if not raw:
        return fallback
    raw = raw.strip()
    if not raw:
        return fallback
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw
    return raw


def fetch_flex_report(token: str, query_id: str) -> str:
    """
    Call the IBKR Flex Query API (synchronous, for background threads).
    Date range is controlled by the IBKR query configuration (set to
    "Year to Date" in the IBKR portal). Deduplication prevents re-importing.
    Returns raw XML string.

    Retries the submit step up to 5× for:
      - IBKR transient API errors ("Statement could not be generated …")
      - Network / DNS errors (httpx.ConnectError, httpx.TimeoutException)
    Wait schedule: 0 s, 30 s, 60 s, 90 s, 120 s.
    """
    with httpx.Client(timeout=60, follow_redirects=True) as client:

        # Step 1 — submit request
        ref_code: Optional[str] = None
        url: str = FLEX_GET_URL
        last_err: str = ""
        _submit_waits = [0, 30, 60, 90, 120]  # seconds before each attempt

        for submit_attempt, wait in enumerate(_submit_waits):
            if wait:
                logger.info("Flex Query submit retry %d/%d in %ds — %s",
                            submit_attempt, len(_submit_waits) - 1, wait, last_err)
                time.sleep(wait)

            # ── Network / DNS errors are retried just like IBKR transient errors ──
            try:
                resp = client.get(FLEX_SEND_URL, params={"t": token, "q": query_id, "v": "3"})
                resp.raise_for_status()
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_err = f"Network error connecting to IBKR: {exc}"
                logger.warning("Flex Query network error (attempt %d/%d): %s",
                               submit_attempt + 1, len(_submit_waits), exc)
                continue  # retry after back-off

            try:
                xml1 = ET.fromstring(resp.text)
            except ET.ParseError as exc:
                raise RuntimeError(f"Unexpected Flex API response: {resp.text[:200]}") from exc

            status = xml1.findtext("Status")
            if status == "Success":
                ref_code = xml1.findtext("ReferenceCode")
                # Normalize URL: some IBKR envs omit the https:// scheme
                url = _normalize_ibkr_url(xml1.findtext("Url"), FLEX_GET_URL)
                break

            last_err = xml1.findtext("ErrorMessage") or resp.text[:300]
            if any(phrase.lower() in last_err.lower() for phrase in _TRANSIENT_SUBMIT_PHRASES):
                continue   # retry
            # Non-transient error (bad token, invalid query ID, etc.) — fail fast
            raise RuntimeError(f"Flex Query submit failed: {last_err}")

        if not ref_code:
            # Distinguish network failures from IBKR rate-limiting
            if "Network error" in last_err:
                raise RuntimeError(
                    f"Could not reach IBKR servers after {len(_submit_waits)} attempts — "
                    "please check your internet connection and try again. "
                    f"({last_err})"
                )
            raise RuntimeError(
                "IBKR Flex API is rate-limiting this request — please wait a few minutes "
                f"and try again, or use Upload XML to bypass the limit. (IBKR error: {last_err})"
                if last_err else "No ReferenceCode in Flex API response"
            )

        logger.info("Flex Query submitted, reference=%s  poll_url=%s", ref_code, url)

        # Step 2 — poll until ready (up to ~80 s)
        for attempt in range(14):
            time.sleep(3 if attempt == 0 else 6)
            try:
                resp2 = client.get(url, params={"q": ref_code, "t": token, "v": "3"})
                resp2.raise_for_status()
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                logger.warning("Flex Query poll network error (attempt %d): %s", attempt + 1, exc)
                continue  # try the next poll interval

            if (
                "Statement generation" in resp2.text
                or "<Status>Warn" in resp2.text
                or "<ErrorCode>1019</ErrorCode>" in resp2.text
            ):
                logger.debug("Flex Query still generating (attempt %d)", attempt + 1)
                continue

            logger.info("Flex Query ready after %d poll(s)", attempt + 1)
            return resp2.text

        raise RuntimeError("Flex Query timed out after 14 polling attempts (~80 s)")


# ── XML parsing ───────────────────────────────────────────────────────────────

def parse_flex_xml(xml_str: str) -> list[dict]:
    """
    Parse a Flex Query XML response.
    Returns a list of per-account dicts:
      { ibkr_account_id, trades, cash, option_events, corporate_actions }
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
                "net_cash":       el.get("netCash", ""),
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

        # ── Option exercises, assignments, expirations ────────────────────────
        # OptionEAE elements record the option side of the event.
        # IBKR also generates stock Trade elements for exercises/assignments, so
        # we only record the option position closure here.
        option_events = []
        for el in stmt.findall(".//OptionEAE"):
            txn_type = el.get("transactionType", "").strip()
            if txn_type not in ("Expiry", "Exercise", "Assignment"):
                continue
            option_events.append({
                "event_type":  txn_type,            # "Expiry" | "Exercise" | "Assignment"
                "symbol":      el.get("symbol", ""),
                "description": el.get("description", ""),
                "date":        el.get("date", ""),
                "quantity":    el.get("quantity", ""),
                "price":       el.get("tradePrice", ""),  # 0 for expiry
                "proceeds":    el.get("proceeds", ""),
                "currency":    el.get("currency", ""),
            })

        # ── Corporate actions (stock splits) ─────────────────────────────────
        # type="FS" = forward split, "RS" = reverse split.
        # Each split generates two CorporateAction rows: one positive (new shares)
        # and one negative (old shares removed) — both are passed through so the
        # importer can reconcile them.
        corporate_actions = []
        for el in stmt.findall(".//CorporateAction"):
            ca_type = el.get("type", "").strip()
            if ca_type not in ("FS", "RS"):
                continue
            corporate_actions.append({
                "ca_type":     ca_type,             # "FS" | "RS"
                "symbol":      el.get("symbol", ""),
                "description": el.get("description", ""),
                "date":        el.get("dateTime", el.get("reportDate", "")),
                "quantity":    el.get("quantity", ""),
                "currency":    el.get("currency", ""),
            })

        results.append({
            "ibkr_account_id":   ibkr_account_id,
            "trades":            trades,
            "cash":              cash,
            "option_events":     option_events,
            "corporate_actions": corporate_actions,
        })

    return results


# ── Import helpers ────────────────────────────────────────────────────────────

def _find_account_by_number(db: Session, account_number: str):
    """Look up an Account by its account_number (the IBKR U-number)."""
    from app.models.master import Account
    return db.query(Account).filter(Account.account_number == account_number).first()


def import_trades(db: Session, account_id: int, trades: list[dict]) -> tuple[int, list[dict]]:
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    imported = 0
    details: list[dict] = []
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

        asset_category = t.get("asset_category", "STK")

        # Skip FX conversion trades — IBKR reports currency conversions as CASH trades
        # with symbols like "USD.CAD".  These are not securities to hold.
        if asset_category == "CASH":
            logger.debug("Skipping FX trade %s (assetCategory=CASH)", t["trade_id"])
            continue

        ticker = t["symbol"].upper().strip()
        if not ticker:
            continue

        # Options: IBKR uses assetCategory="OPT".  We must:
        #   1. Mark the security as an option so the correct ACB logic runs.
        #   2. Skip the exchange filter — existing OPTION records were created without
        #      an exchange, but IBKR fills in the exchange on every trade (e.g. "CBOE").
        #      Passing exchange= would create a spurious EQUITY duplicate instead of
        #      finding the existing OPTION record.
        #   3. Map BUY→OPTION_BUY and SELL→OPTION_SELL so the ACB service correctly
        #      handles covered-call short positions (negative lot quantity).
        is_option = (asset_category == "OPT")
        txn_type  = ("OPTION_" + buy_sell) if is_option else buy_sell

        sec = get_or_create_security(
            db, ticker=ticker, currency=t["currency"],
            is_option=is_option,
            exchange=None if is_option else (t["exchange"] or None),
        )

        currency    = t["currency"] or "USD"
        qty         = _d(t["quantity"])
        price       = _d(t["price"])
        commission  = _d(t["commission"])
        trade_money = _d(t["trade_money"])
        net_cash    = _d(t["net_cash"])

        if qty is not None:
            qty = abs(qty)
        if commission is not None:
            commission = abs(commission)   # IBKR reports negative; store positive

        # Use netCash (tradeMoney + ibCommission) as the cash amount so commissions
        # are captured in the cash flow, matching what IBKR's CSV "Net Amount" column
        # reports.  Fall back to tradeMoney if netCash is absent (older Flex templates).
        txn_amount = net_cash if net_cash is not None else trade_money

        # Check for existing CSV-imported trade (no external_ref) — stamp and skip
        if _stamp_existing_trade(db, account_id, trade_date, txn_type, sec.id, qty, ext_ref):
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
            transaction_type=txn_type,
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
        details.append({
            "date": trade_date.isoformat(),
            "type": txn_type,
            "ticker": ticker,
            "qty": str(qty) if qty is not None else "",
            "amount": str(txn_amount) if txn_amount is not None else "",
            "currency": currency,
        })
        imported += 1

    db.commit()   # also persists external_ref stamps on existing rows
    return imported, details


def import_cash(db: Session, account_id: int, cash_rows: list[dict], ibkr_account_id: str) -> tuple[int, list[dict]]:
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    imported = 0
    details: list[dict] = []
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
        details.append({
            "date": txn_date.isoformat(),
            "type": our_type,
            "ticker": ticker or "",
            "qty": "",
            "amount": str(abs_amount),
            "currency": currency,
        })
        imported += 1

    db.commit()   # also persists external_ref stamps on existing rows
    return imported, details


def _ext_ref_option_event(symbol: str, dt: str, event_type: str) -> str:
    h = hashlib.md5(f"{symbol}|{dt}|{event_type}".encode()).hexdigest()[:12]
    return f"ibkr-optevent-{h}"


def _ext_ref_split(symbol: str, dt: str, qty: str) -> str:
    h = hashlib.md5(f"{symbol}|{dt}|{qty}".encode()).hexdigest()[:12]
    return f"ibkr-split-{h}"


def import_option_events(db: Session, account_id: int, events: list[dict]) -> tuple[int, list[dict]]:
    """
    Import option exercise / assignment / expiration events.

    Each event closes an option position:
      Expiry     → OPTION_EXPIRY   (option expired worthless, qty = contracts)
      Exercise   → OPTION_EXERCISE (holder exercised; stock delivery via Trade)
      Assignment → OPTION_ASSIGNMENT (writer assigned; stock delivery via Trade)

    The corresponding stock-side transaction (share delivery) is already
    captured by import_trades() from the Trade elements IBKR also generates.
    """
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    EVENT_TYPE_MAP = {
        "Expiry":     "OPTION_EXPIRY",
        "Exercise":   "OPTION_EXERCISE",
        "Assignment": "OPTION_ASSIGNMENT",
    }

    imported = 0
    details: list[dict] = []
    for ev in events:
        our_type = EVENT_TYPE_MAP.get(ev["event_type"])
        if not our_type:
            continue

        ticker = ev["symbol"].upper().strip()
        if not ticker:
            continue

        dt_str   = ev["date"][:8] if ev["date"] else ""   # YYYYMMDD
        ext_ref  = _ext_ref_option_event(ticker, dt_str, ev["event_type"])
        if _already_imported(db, ext_ref):
            continue

        event_date = _parse_ibkr_date(dt_str)
        if not event_date:
            logger.warning("Skipping option event %s %s — bad date", ticker, ev["event_type"])
            continue

        sec = get_or_create_security(db, ticker=ticker, currency=ev["currency"], is_option=True, exchange=None)
        qty = _d(ev["quantity"])
        if qty is not None:
            qty = abs(qty)

        price    = _d(ev["price"])     # 0.0 for expiry; exercise/assignment price otherwise
        proceeds = _d(ev["proceeds"])
        amount   = abs(proceeds) if proceeds is not None else (
            (qty * price) if (qty and price) else None
        )

        currency   = ev["currency"] or "USD"
        fx_to_cad  = get_rate(db, event_date, currency, "CAD") if currency != "CAD" else None
        cad_amount = (amount * fx_to_cad).quantize(Decimal("0.01")) if (fx_to_cad and amount) else (
            amount if currency == "CAD" else None
        )

        db.add(Transaction(
            account_id=account_id,
            security_id=sec.id,
            transaction_date=event_date,
            transaction_type=our_type,
            quantity=qty,
            price=price,
            transaction_currency=currency,
            transaction_amount=amount or Decimal("0"),
            fx_rate_to_cad=fx_to_cad,
            cad_amount=cad_amount,
            raw_description=(ev["description"] or "")[:500] or None,
            external_ref=ext_ref,
        ))
        details.append({
            "date": event_date.isoformat(),
            "type": our_type,
            "ticker": ticker,
            "qty": str(qty) if qty is not None else "",
            "amount": str(amount or "0"),
            "currency": currency,
        })
        imported += 1
        logger.info("Option event: %s %s %s qty=%s", our_type, ticker, event_date, qty)

    db.commit()
    return imported, details


def import_corporate_actions(db: Session, account_id: int, actions: list[dict]) -> tuple[int, list[dict]]:
    """
    Import stock split / reverse split corporate actions.

    IBKR reports each split as two CorporateAction rows:
      - Negative quantity: old shares removed  → SPLIT (qty < 0)
      - Positive quantity: new shares added    → SPLIT (qty > 0)

    The ACB service handles SPLIT by adjusting the cost pool proportionally.
    """
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security
    from app.services.fx_service import get_rate

    imported = 0
    details: list[dict] = []
    for ca in actions:
        ticker = ca["symbol"].upper().strip()
        if not ticker:
            continue

        dt_str  = ca["date"][:8] if ca["date"] else ""
        qty_str = ca["quantity"]
        ext_ref = _ext_ref_split(ticker, dt_str, qty_str)
        if _already_imported(db, ext_ref):
            continue

        ca_date = _parse_ibkr_date(dt_str)
        if not ca_date:
            logger.warning("Skipping corporate action %s — bad date", ticker)
            continue

        qty = _d(qty_str)
        if qty is None:
            continue

        # Map to our transaction types — both legs use SPLIT; ACB service
        # handles positive (new shares) and negative (old shares removed)
        txn_type = "SPLIT"
        currency = ca["currency"] or "CAD"
        sec = get_or_create_security(db, ticker=ticker, currency=currency, exchange=None)

        db.add(Transaction(
            account_id=account_id,
            security_id=sec.id,
            transaction_date=ca_date,
            transaction_type=txn_type,
            quantity=abs(qty),
            price=Decimal("0"),
            transaction_currency=currency,
            transaction_amount=Decimal("0"),
            raw_description=(ca["description"] or "")[:500] or None,
            external_ref=ext_ref,
        ))
        details.append({
            "date": ca_date.isoformat(),
            "type": txn_type,
            "ticker": ticker,
            "qty": str(abs(qty)),
            "amount": "0",
            "currency": currency,
        })
        imported += 1
        logger.info("Corporate action: %s %s %s qty=%s", txn_type, ticker, ca_date, qty)

    db.commit()
    return imported, details


# ── High-level sync ───────────────────────────────────────────────────────────

def import_from_xml_str(db: Session, xml_str: str) -> dict:
    """
    Parse a Flex Query XML string and import all transactions into the DB.
    Matches each FlexStatement's accountId to an Account by account_number.
    Deduplication via external_ref prevents double-importing.
    Returns {"imported": int, "error": str|None, "message": str, "details": list[dict]}.
    """
    import json as _json

    statements = parse_flex_xml(xml_str)

    total_trades            = 0
    total_cash              = 0
    total_option_events     = 0
    total_corporate_actions = 0
    unmatched               = []
    all_details: list[dict] = []

    for stmt in statements:
        ibkr_id = stmt["ibkr_account_id"]
        account = _find_account_by_number(db, ibkr_id)

        if account is None:
            logger.warning("No account with account_number=%r — skipping", ibkr_id)
            unmatched.append(ibkr_id)
            continue

        t,  t_rows  = import_trades(db, account.id, stmt["trades"])
        c,  c_rows  = import_cash(db, account.id, stmt["cash"], ibkr_id)
        oe, oe_rows = import_option_events(db, account.id, stmt.get("option_events", []))
        ca, ca_rows = import_corporate_actions(db, account.id, stmt.get("corporate_actions", []))
        logger.info("  %s (%s): %d trades + %d cash + %d option events + %d corp actions",
                    ibkr_id, account.name, t, c, oe, ca)

        acct_name = account.name
        for row in (t_rows + c_rows + oe_rows + ca_rows):
            all_details.append({**row, "account": acct_name})

        total_trades            += t
        total_cash              += c
        total_option_events     += oe
        total_corporate_actions += ca

    # Sort by date desc so newest show first
    all_details.sort(key=lambda r: r.get("date", ""), reverse=True)

    total = total_trades + total_cash + total_option_events + total_corporate_actions
    parts = [f"{total_trades} trade(s)", f"{total_cash} cash transaction(s)"]
    if total_option_events:
        parts.append(f"{total_option_events} option event(s)")
    if total_corporate_actions:
        parts.append(f"{total_corporate_actions} corporate action(s)")
    msg = f"{' + '.join(parts)} imported across {len(statements) - len(unmatched)} account(s)"
    if unmatched:
        msg += f" — {len(unmatched)} IBKR account(s) not matched: {', '.join(unmatched)}"

    logger.info("Flex import complete: %s", msg)
    return {
        "imported": total,
        "error": None,
        "message": msg,
        "details": all_details,
        "details_json": _json.dumps(all_details),
    }


def sync_config(db: Session, config) -> dict:
    """
    Sync one user's Flex Query config via the IBKR API.
    Date range is set in IBKR portal (use "Year to Date").
    Deduplication via external_ref prevents double-importing existing data.
    """
    logger.info("Flex sync starting for user_id=%s", config.user_id)
    config.last_sync_status  = "running"
    config.last_sync_message = None
    db.commit()

    try:
        xml_str = fetch_flex_report(config.token, config.query_id)
        result  = import_from_xml_str(db, xml_str)

        config.last_sync_at       = datetime.utcnow()
        config.last_sync_status   = "ok"
        config.last_sync_imported = result["imported"]
        config.last_sync_message  = result["message"]
        config.last_sync_details  = result.get("details_json")
        db.commit()

        logger.info("Flex sync user_id=%s: %s", config.user_id, result["message"])
        return result

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
