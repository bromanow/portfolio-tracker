"""
Interactive Brokers price service via ib_insync.

Requires TWS (port 7497) or IB Gateway (port 4001) to be running on the same
machine and configured to accept API connections (File → Global Config → API →
Settings → Enable ActiveX and Socket Clients).

No credentials are stored here — authentication happens inside TWS/Gateway.
This service simply connects over a local socket.
"""
from __future__ import annotations

import glob
import json
import logging
import os
import subprocess
import threading
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Optional import guard ──────────────────────────────────────────────────────
try:
    from ib_insync import IB, Stock, Contract
    _IB_AVAILABLE = True
except ImportError:
    _IB_AVAILABLE = False
    logger.warning("ib_insync not installed — IBKR integration disabled. "
                   "Run: pip install ib_insync")

# ── Persisted settings ────────────────────────────────────────────────────────
_SETTINGS_FILE = Path(__file__).parent.parent.parent / "ibkr_settings.json"
_DEFAULT_SETTINGS = {"host": "127.0.0.1", "port": 7497, "client_id": 10,
                     "last_connected_at": None}

# Each concurrent operation uses a different client_id offset so IB Gateway
# doesn't reject a second simultaneous connection with "already connected".
# Base: client_id (price fetch)   +1: managed accounts   +2: transaction sync
_CID_PRICES = 0   # offset: base client_id
_CID_MGMT   = 1   # offset: base + 1
_CID_TXN    = 2   # offset: base + 2

def _load_settings() -> dict:
    try:
        if _SETTINGS_FILE.exists():
            return {**_DEFAULT_SETTINGS, **json.loads(_SETTINGS_FILE.read_text())}
    except Exception:
        pass
    return dict(_DEFAULT_SETTINGS)

def _save_settings(s: dict) -> None:
    try:
        _SETTINGS_FILE.write_text(json.dumps(s, indent=2))
    except Exception as e:
        logger.warning("Could not save IBKR settings: %s", e)

_settings: dict = _load_settings()

# ── Runtime state ─────────────────────────────────────────────────────────────
_state_lock = threading.Lock()
# Seed from persisted settings so state survives server restarts
_last_connected_at: Optional[datetime] = (
    datetime.fromisoformat(_settings["last_connected_at"])
    if _settings.get("last_connected_at") else None
)
_last_refresh_at: Optional[datetime] = None
_last_refresh_result: Optional[dict] = None


# ── Public helpers ─────────────────────────────────────────────────────────────

def is_available() -> bool:
    """True if ib_insync is installed."""
    return _IB_AVAILABLE


def get_settings() -> dict:
    return dict(_settings)


def save_settings(host: str, port: int, client_id: int, last_connected_at: Optional[str] = None) -> None:
    global _settings
    _settings = {"host": host, "port": port, "client_id": client_id,
                 "last_connected_at": last_connected_at or _settings.get("last_connected_at")}
    _save_settings(_settings)


def get_status() -> dict:
    """Return a plain dict suitable for the /status endpoint."""
    return {
        "available": _IB_AVAILABLE,
        "host": _settings["host"],
        "port": _settings["port"],
        "client_id": _settings["client_id"],
        "last_connected_at": _last_connected_at.isoformat() if _last_connected_at else None,
        "last_refresh_at": _last_refresh_at.isoformat() if _last_refresh_at else None,
        "last_refresh_result": _last_refresh_result,
        "gateway_running": is_gateway_running(),
        "gateway_app_path": find_gateway_app(),
    }


# ── Gateway launch helpers ────────────────────────────────────────────────────

# Candidate glob patterns — include one level of subdirectory for versioned installs
# e.g. ~/Applications/IB Gateway 10.45/IB Gateway 10.45.app
_APP_SEARCH_PATTERNS = [
    os.path.expanduser("~/Applications/IB Gateway*.app"),
    os.path.expanduser("~/Applications/IB Gateway*/IB Gateway*.app"),
    os.path.expanduser("~/Applications/Trader Workstation*.app"),
    os.path.expanduser("~/Applications/Trader Workstation*/Trader Workstation*.app"),
    "/Applications/IB Gateway*.app",
    "/Applications/IB Gateway*/IB Gateway*.app",
    "/Applications/Trader Workstation*.app",
    "/Applications/Trader Workstation*/Trader Workstation*.app",
    "/Applications/Interactive Brokers/IB Gateway*.app",
    "/Applications/Interactive Brokers/Trader Workstation*.app",
]

_SKIP_WORDS = ("uninstall", "restarter", "updater")


def find_gateway_app() -> Optional[str]:
    """Return the path to the best available IB Gateway (or TWS) .app bundle, or None."""
    for pattern in _APP_SEARCH_PATTERNS:
        matches = sorted(glob.glob(pattern), reverse=True)  # newest version first
        matches = [m for m in matches if not any(w in m.lower() for w in _SKIP_WORDS)]
        if matches:
            return matches[0]
    return None


def is_gateway_running() -> bool:
    """True if an IB Gateway or TWS process is currently running."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", r"IB Gateway|Trader Workstation|ibgateway|tws"],
            capture_output=True,
        )
        return result.returncode == 0
    except Exception:
        return False


def launch_gateway() -> dict:
    """
    Open IB Gateway (or TWS) using macOS `open`.
    Returns {ok, app_path, error}.
    """
    app_path = find_gateway_app()
    if not app_path:
        return {"ok": False, "error": "IB Gateway app not found. Is it installed?"}
    try:
        subprocess.Popen(["open", app_path])
        logger.info("Launched IB Gateway: %s", app_path)
        return {"ok": True, "app_path": app_path}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def test_connection(host: str, port: int, client_id: int) -> dict:
    """
    Attempt a quick connection, return {ok, tws_version, error}.
    Runs synchronously (call from a thread or thread-pool executor).
    """
    if not _IB_AVAILABLE:
        return {"ok": False, "error": "ib_insync not installed"}
    global _last_connected_at
    # ThreadPoolExecutor threads have no event loop by default — create one
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    ib = IB()
    try:
        ib.connect(host, port, clientId=client_id, timeout=8, readonly=True)
        version = getattr(ib, "serverVersion", lambda: "?")()
        ts = datetime.now(timezone.utc).replace(tzinfo=None)
        with _state_lock:
            global _last_connected_at
            _last_connected_at = ts
        # Persist so the server remembers across restarts
        save_settings(host, port, client_id, last_connected_at=ts.isoformat())
        return {"ok": True, "tws_version": str(version)}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        try:
            ib.disconnect()
        except Exception:
            pass


# ── Contract builder ──────────────────────────────────────────────────────────

def _build_contract(security) -> Optional["Contract"]:
    """Map a Security row to an ib_insync Stock contract. Returns None for options."""
    if security.is_option:
        return None

    ticker: str = security.ticker
    exchange: str = (security.exchange or "").upper()
    currency: str = (security.currency or "").upper()

    # Strip Yahoo-style suffixes (.TO, .V)
    clean_ticker = ticker
    for suffix in (".TO", ".V"):
        if clean_ticker.upper().endswith(suffix.upper()):
            clean_ticker = clean_ticker[: -len(suffix)]
            break

    # Map to IB exchange + currency
    # Use SMART routing for US exchanges with primaryExch to avoid ambiguity.
    # TSX/TSXV are routed directly (not on SMART).
    if exchange in ("TSX", "TSX-V", "TSXV") or currency == "CAD":
        ib_exchange, ib_currency, primary = "TSX", "CAD", ""
    elif exchange in ("NYSE", "AMEX"):
        ib_exchange, ib_currency, primary = "SMART", "USD", "NYSE"
    elif exchange == "ARCA":
        ib_exchange, ib_currency, primary = "SMART", "USD", "ARCA"
    elif exchange == "NASDAQ":
        ib_exchange, ib_currency, primary = "SMART", "USD", "NASDAQ"
    elif exchange == "CBOE":
        ib_exchange, ib_currency, primary = "SMART", "USD", "CBOE"
    else:
        # Default to SMART routing for other US-listed equities
        ib_exchange = "SMART"
        ib_currency = currency if currency in ("USD", "CAD") else "USD"
        primary = ""

    contract = Stock(clean_ticker, ib_exchange, ib_currency)
    if primary:
        contract.primaryExch = primary
    return contract


# ── Price fetch ───────────────────────────────────────────────────────────────

_BATCH_SIZE = 45   # IB default concurrency limit is 50; leave a 5-line buffer
_WAIT_SECS  = 4    # seconds to wait per batch for snapshot data to arrive


def fetch_prices(securities, db) -> dict:
    """
    Fetch live snapshot prices for a list of Security objects via TWS/Gateway.
    Upserts into market_prices (and mirrors into historical_prices as intraday).
    Returns {ok, failed, skipped, errors, failed_security_ids}.

    failed_security_ids contains IDs of securities that could not be priced —
    the caller can pass these to yfinance as a fallback.

    Intended to be called from a background thread (blocking).
    """
    if not _IB_AVAILABLE:
        raise RuntimeError("ib_insync is not installed")

    # Background job threads have no event loop — create one for ib_insync
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    from app.services.price_service import _upsert_price, _upsert_historical_price
    from app.services.fx_service import get_rate

    host = _settings["host"]
    port = _settings["port"]
    client_id = _settings["client_id"]

    usd_to_cad = get_rate(db, date.today(), "USD", "CAD")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = date.today()

    # ── Build contract list ───────────────────────────────────────────────────
    pairs: list[tuple] = []   # (Contract, Security)
    skipped_ids: list[int] = []
    for sec in securities:
        contract = _build_contract(sec)
        if contract is None:
            skipped_ids.append(sec.id)
            continue
        pairs.append((contract, sec))

    ok = failed = 0
    errors: list[str] = []
    failed_ids: list[int] = list(skipped_ids)   # start with skipped (options etc.)

    if not pairs:
        return {"ok": 0, "failed": 0, "skipped": len(skipped_ids),
                "errors": errors, "failed_security_ids": failed_ids}

    # ── Decimal helper (nan-safe) ─────────────────────────────────────────────
    def _d(v) -> Optional[Decimal]:
        if v is None or v != v:   # nan check
            return None
        try:
            return Decimal(str(v)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        except Exception:
            return None

    # ── Connect ───────────────────────────────────────────────────────────────
    ib = IB()
    try:
        ib.connect(host, port, clientId=client_id, timeout=10, readonly=True)
        logger.info("IBKR: connected to %s:%d (clientId=%d)", host, port, client_id)
        with _state_lock:
            global _last_connected_at
            _last_connected_at = now
        save_settings(host, port, client_id, last_connected_at=now.isoformat())

        # ── Qualify contracts individually ────────────────────────────────────
        # qualifyContracts raises if any contract in the batch is ambiguous,
        # which would block the entire batch.  Qualifying one at a time means
        # a single bad ticker only skips itself.
        qualified: list[tuple] = []
        for contract, sec in pairs:
            try:
                resolved = ib.qualifyContracts(contract)
                if resolved:
                    qualified.append((contract, sec))
                else:
                    logger.warning("IBKR: could not qualify %s (no match) — falling back to yfinance", sec.ticker)
                    failed_ids.append(sec.id)
                    failed += 1
            except Exception as e:
                logger.warning("IBKR: qualifyContracts failed for %s (%s) — falling back to yfinance", sec.ticker, e)
                failed_ids.append(sec.id)
                failed += 1
        logger.info("IBKR: %d/%d contracts qualified", len(qualified), len(pairs))

        # ── Request snapshot data in batches ──────────────────────────────────
        for batch_start in range(0, len(qualified), _BATCH_SIZE):
            batch = qualified[batch_start: batch_start + _BATCH_SIZE]

            # reqMktData returns the Ticker object directly — store it
            batch_tickers: list[tuple] = []   # (Ticker, Contract, Security)
            for contract, sec in batch:
                ticker = ib.reqMktData(
                    contract, genericTickList="", snapshot=False, regulatorySnapshot=False
                )
                batch_tickers.append((ticker, contract, sec))

            # Let the event loop deliver tick data
            ib.sleep(_WAIT_SECS)

            # Harvest results, then cancel subscriptions
            for ticker_data, contract, sec in batch_tickers:
                ib.cancelMktData(contract)
                try:
                    # Best available price: last trade → marketPrice() midpoint
                    price_val = _d(ticker_data.last)
                    if price_val is None:
                        price_val = _d(ticker_data.marketPrice())
                    if price_val is None or price_val <= 0:
                        logger.warning("IBKR: no price for %s (last=%s close=%s)",
                                       sec.ticker, ticker_data.last, ticker_data.close)
                        errors.append(sec.ticker)
                        failed_ids.append(sec.id)
                        failed += 1
                        continue

                    prev_close = _d(ticker_data.close)   # IB .close = previous session close
                    day_high   = _d(ticker_data.high)
                    day_low    = _d(ticker_data.low)

                    day_change: Optional[Decimal] = None
                    day_change_pct: Optional[Decimal] = None
                    if prev_close and prev_close > 0:
                        day_change = (price_val - prev_close).quantize(
                            Decimal("0.000001"), rounding=ROUND_HALF_UP)
                        day_change_pct = (day_change / prev_close * Decimal("100")).quantize(
                            Decimal("0.0001"), rounding=ROUND_HALF_UP)

                    currency = contract.currency or "USD"
                    if currency == "CAD":
                        price_cad = price_val
                    elif currency == "USD" and usd_to_cad:
                        price_cad = (price_val * usd_to_cad).quantize(
                            Decimal("0.000001"), rounding=ROUND_HALF_UP)
                    else:
                        price_cad = None

                    fetch_ticker = f"ibkr:{contract.symbol}.{contract.exchange}"
                    data = {
                        "price":          price_val,
                        "currency":       currency,
                        "price_cad":      price_cad,
                        "prev_close":     prev_close,
                        "day_high":       day_high,
                        "day_low":        day_low,
                        "day_change":     day_change,
                        "day_change_pct": day_change_pct,
                        "price_date":     today,
                        "fetched_at":     now,
                        "fetch_ticker":   fetch_ticker,
                        "source":         "ibkr",
                    }

                    _upsert_price(db, sec.id, data)

                    if price_cad:
                        _upsert_historical_price(
                            db, sec.id, today,
                            price_val, currency, price_cad,
                            fetch_ticker, "intraday",
                        )

                    ok += 1
                    logger.info("IBKR: %-12s → %s %s (chg %s)",
                                sec.ticker, price_val, currency, day_change)

                except Exception as exc:
                    logger.error("IBKR: error processing %s: %s", sec.ticker, exc)
                    errors.append(sec.ticker)
                    failed_ids.append(sec.id)
                    failed += 1

        db.commit()

    finally:
        try:
            ib.disconnect()
        except Exception:
            pass

    result = {
        "ok": ok,
        "failed": failed,
        "skipped": len(skipped_ids),
        "errors": errors[:20],
        "failed_security_ids": failed_ids,
    }
    with _state_lock:
        global _last_refresh_at, _last_refresh_result
        _last_refresh_at = now
        _last_refresh_result = {k: v for k, v in result.items() if k != "failed_security_ids"}

    logger.info("IBKR refresh complete: %d ok, %d failed, %d skipped", ok, failed, len(skipped_ids))
    return result


# ── Transaction sync ──────────────────────────────────────────────────────────

def sync_transactions(db) -> dict:
    """
    Pull recent trade executions from IB Gateway via reqExecutions() and
    upsert them into the transactions table.

    Scope: executions from the *current* TWS/Gateway session only.
    For complete historical data, use the IB Flex Query CSV export instead.

    Accounts are matched by:
      1. Account.account_number  (exact match on the IB account ID, e.g. U1234567)
      2. Account.ibkr_alias      (fallback — the alias stored during CSV imports)

    Returns {imported, skipped, errors, unmatched_accounts}.
    Intended to run from a background thread (blocking).
    """
    if not _IB_AVAILABLE:
        raise RuntimeError("ib_insync is not installed")

    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    from ib_insync import ExecutionFilter
    from app.models.master import Account
    from app.models.transactions import Transaction
    from app.services.normalizer import get_or_create_security, get_or_create_option_contract
    from app.services.fx_service import get_rate
    from app.parsers.ibkr_history import parse_occ_symbol

    host      = _settings["host"]
    port      = _settings["port"]
    client_id = _settings["client_id"] + _CID_TXN

    imported           = 0
    skipped            = 0
    errors: list[str]  = []
    unmatched: set[str] = set()

    def _d(v) -> Optional[Decimal]:
        """nan-safe Decimal conversion."""
        if v is None or v != v:
            return None
        try:
            return Decimal(str(v)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        except Exception:
            return None

    ib = IB()
    try:
        ib.connect(host, port, clientId=client_id, timeout=10, readonly=True)
        logger.info("IBKR sync-txns: connected to %s:%d", host, port)

        fills = ib.reqExecutions(ExecutionFilter())
        logger.info("IBKR sync-txns: %d executions in current session", len(fills))

        for fill in fills:
            exc      = fill.execution
            contract = fill.contract
            cr       = fill.commissionReport

            # ── Account matching ──────────────────────────────────────────────
            ib_acct = exc.acctNumber
            account = (
                db.query(Account).filter(Account.account_number == ib_acct).first()
                or db.query(Account).filter(Account.ibkr_alias == ib_acct).first()
            )
            if not account:
                unmatched.add(ib_acct)
                logger.warning("IBKR sync-txns: no account matched for IB account %r", ib_acct)
                continue

            # ── Dedup by execId ───────────────────────────────────────────────
            exec_id = exc.execId
            if db.query(Transaction).filter(
                Transaction.raw_description.contains(f"execId:{exec_id}")
            ).first():
                skipped += 1
                continue

            try:
                # ── Parse basics ──────────────────────────────────────────────
                is_option   = (contract.secType == "OPT")
                side        = exc.side          # "BOT" or "SLD"
                shares      = Decimal(str(exc.shares))
                price       = _d(exc.price) or Decimal("0")
                tx_currency = contract.currency or "USD"
                acct_currency = account.base_currency

                quantity = shares if side == "BOT" else -shares
                if is_option:
                    tx_type = "OPTION_BUY" if side == "BOT" else "OPTION_SELL"
                else:
                    tx_type = "BUY" if side == "BOT" else "SELL"

                # ── Date ─────────────────────────────────────────────────────
                # exc.time is like "20260501 14:30:45 US/Eastern"
                tx_date = datetime.strptime(exc.time.split()[0], "%Y%m%d").date()

                # ── Commission ────────────────────────────────────────────────
                commission = _d(cr.commission) if cr else None
                if commission is not None and commission <= 0:
                    commission = None  # IB sometimes emits 0 or negative placeholder

                # ── Net cash amount (transaction_currency) ────────────────────
                gross = (price * shares).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
                if side == "BOT":
                    tx_amount = -(gross + (commission or Decimal("0")))   # outflow
                else:
                    tx_amount = gross - (commission or Decimal("0"))       # inflow

                # ── FX: tx_currency → account_currency → CAD ─────────────────
                if tx_currency == acct_currency:
                    fx_to_acct = Decimal("1")
                    acct_amount = tx_amount
                else:
                    fx_to_acct = get_rate(db, tx_date, tx_currency, acct_currency) or Decimal("1")
                    acct_amount = (tx_amount * fx_to_acct).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

                if acct_currency == "CAD":
                    fx_to_cad = Decimal("1")
                    cad_amount = acct_amount
                else:
                    fx_to_cad = get_rate(db, tx_date, acct_currency, "CAD") or Decimal("1")
                    cad_amount = (acct_amount * fx_to_cad).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

                # ── Security ──────────────────────────────────────────────────
                if is_option:
                    # Build an OCC-style symbol so the option contract can be
                    # looked up / created consistently with IBKR CSV imports.
                    raw_symbol = getattr(contract, "localSymbol", "") or contract.symbol
                    occ = parse_occ_symbol(raw_symbol)
                    if occ:
                        opt_sec, _ = get_or_create_option_contract(
                            db,
                            option_symbol=raw_symbol,
                            underlying_ticker=occ["underlying"],
                            option_type=occ["option_type"],
                            strike=occ["strike"],
                            expiry=occ["expiry"],
                            currency=tx_currency,
                        )
                    else:
                        # Fallback: store as a generic option security
                        from app.services.normalizer import get_or_create_security as _gos
                        opt_sec = _gos(db, raw_symbol or contract.symbol,
                                       is_option=True, currency=tx_currency)
                    security = opt_sec
                else:
                    security = get_or_create_security(
                        db, contract.symbol, currency=tx_currency
                    )

                # ── Description with execId for deduplication ─────────────────
                desc = (
                    f"[IBKR execId:{exec_id}] "
                    f"{side} {shares} {contract.symbol} @ {price} {tx_currency}"
                )

                txn = Transaction(
                    account_id              = account.id,
                    security_id             = security.id if security else None,
                    transaction_date        = tx_date,
                    transaction_type        = tx_type,
                    quantity                = quantity,
                    price                   = price,
                    commission              = commission,
                    transaction_currency    = tx_currency,
                    transaction_amount      = tx_amount,
                    account_currency_amount = acct_amount,
                    cad_amount              = cad_amount,
                    fx_rate_to_account      = fx_to_acct,
                    fx_rate_to_cad          = fx_to_cad,
                    raw_description         = desc,
                    notes                   = None,
                    tags                    = [],
                )
                db.add(txn)
                imported += 1
                logger.info("IBKR sync-txns: imported %s %s %s @ %s", tx_type, shares, contract.symbol, price)

            except Exception as exc_err:
                msg = f"{contract.symbol}: {exc_err}"
                logger.error("IBKR sync-txns: error on execution %s — %s", exec_id, exc_err)
                errors.append(msg)

        db.commit()

    finally:
        try:
            ib.disconnect()
        except Exception:
            pass

    result = {
        "imported":           imported,
        "skipped":            skipped,
        "errors":             errors[:20],
        "unmatched_accounts": sorted(unmatched),
    }
    logger.info(
        "IBKR sync-txns complete: %d imported, %d skipped, %d unmatched accts",
        imported, skipped, len(unmatched),
    )
    return result


def get_managed_accounts() -> dict:
    """
    Connect briefly to IB Gateway and return the list of managed account numbers.
    Useful for mapping IB account IDs to app accounts.
    """
    if not _IB_AVAILABLE:
        return {"ok": False, "error": "ib_insync not installed", "accounts": []}

    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    host      = _settings["host"]
    port      = _settings["port"]
    client_id = _settings["client_id"] + _CID_MGMT

    ib = IB()
    try:
        ib.connect(host, port, clientId=client_id, timeout=8, readonly=True)
        accounts = ib.managedAccounts()
        return {"ok": True, "accounts": list(accounts)}
    except Exception as e:
        return {"ok": False, "error": str(e), "accounts": []}
    finally:
        try:
            ib.disconnect()
        except Exception:
            pass
