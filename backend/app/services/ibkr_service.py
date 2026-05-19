"""
Interactive Brokers service.

Two modes — the service picks the right one automatically:

1. IBeam / Client Portal REST API  (cloud / Render)
   IBeam runs as a private Docker service alongside the backend.
   Set IBEAM_BASE_URL=https://ibeam:5000 in the environment.
   No local software needed — IBeam handles Gateway auth automatically.

2. ib_insync / TWS socket  (local development)
   Requires IB Gateway or TWS running on localhost.
   Credentials handled by the desktop app.
"""
from __future__ import annotations

import glob
import json
import logging
import math
import os
import subprocess
import threading
import time
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


# ── IBeam / Client Portal REST API ───────────────────────────────────────────
#
# When IBEAM_BASE_URL is set (e.g. https://ibeam:5000) the scanner uses the
# IBKR Client Portal REST API instead of the ib_insync socket path.
# IBeam proxies all /v1/api/* calls to IBKR after handling authentication.
#
# Option chain flow (4 steps, all REST):
#   1. GET /iserver/secdef/search?symbol=X     → underlying conId + expiry months
#   2. GET /iserver/secdef/strikes?conid=…     → call strike prices for each month
#   3. GET /iserver/secdef/info?conid=…&strike=… → option conId for each strike
#   4. GET /iserver/marketdata/snapshot?conids=… → bid/ask/Greeks for all options
#
# Greek field IDs (from Client Portal API v1 docs):
#   84=Bid  86=Ask  7635=Mark  7308=Delta  7309=Gamma  7310=Theta  7311=Vega
#   7633=IV%  31=Last  87=Ask Size  85=Bid Size

_IBEAM_BASE = os.environ.get("IBEAM_BASE_URL", "").rstrip("/")
_CP_FIELDS   = "84,86,7635,31,7308,7309,7310,7311,7633"   # snapshot fields we care about
_CP_TIMEOUT  = 30    # seconds per REST call
_CP_RATE_DELAY = 0.12  # 120 ms between calls → stays under 10 req/s IBKR limit


def _f(d: dict, key, default=None):
    """Safely parse a numeric field from a Client Portal snapshot dict."""
    v = d.get(str(key))
    if v is None:
        return default
    try:
        f = float(str(v).replace(",", ""))
        return None if math.isnan(f) else f
    except Exception:
        return default


def is_ibeam_available() -> bool:
    """True if IBEAM_BASE_URL is configured and IBeam reports authenticated."""
    if not _IBEAM_BASE:
        return False
    try:
        import httpx
        r = httpx.get(
            f"{_IBEAM_BASE}/v1/api/iserver/auth/status",
            verify=False, timeout=5,
        )
        return bool(r.json().get("authenticated"))
    except Exception:
        return False


def _cp_get(path: str, params: Optional[dict] = None) -> list | dict:
    """GET one Client Portal API endpoint via the IBeam proxy."""
    import httpx
    url = f"{_IBEAM_BASE}/v1/api{path}"
    r = httpx.get(url, params=params or {}, verify=False, timeout=_CP_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _cp_snapshot(conids: list[int], retries: int = 2) -> dict[str, dict]:
    """
    Fetch a market-data snapshot for a batch of conIds (max 100).
    Returns a dict keyed by conId string.

    The Client Portal API requires a "pre-flight" call before data arrives —
    the first response may contain empty/partial data.  We retry up to
    `retries` times with a 1-second pause between attempts.
    """
    conids_str = ",".join(str(c) for c in conids)
    result: dict[str, dict] = {}

    for attempt in range(retries + 1):
        try:
            data = _cp_get(
                "/iserver/marketdata/snapshot",
                {"conids": conids_str, "fields": _CP_FIELDS},
            )
        except Exception as exc:
            logger.debug("snapshot attempt %d failed: %s", attempt + 1, exc)
            time.sleep(1)
            continue

        for item in (data if isinstance(data, list) else []):
            cid = str(item.get("conid", item.get("conidEx", "")))
            if cid:
                result[cid] = item

        # If we got useful data (at least bid or ask for any item) return now
        if any("84" in v or "86" in v for v in result.values()):
            break

        if attempt < retries:
            time.sleep(1)   # wait for stream to warm up, then retry

    return result


def scan_ticker_ibeam(
    ticker: str,
    currency: str = "USD",
    exchange: str = "SMART",
    min_dte: int = 14,
    max_dte: int = 60,
    min_otm_pct: float = 0.5,
    max_otm_pct: float = 25.0,
    min_oi: int = 50,
    min_vol: int = 3,
) -> list[dict]:
    """
    Fetch covered-call option chain for one ticker via Client Portal REST API.
    Returns the same raw dict format as scan_ticker_live() so _scan_ticker_ibkr
    can process either source identically.
    """
    from datetime import datetime as dt
    import calendar

    today = date.today()
    is_canadian = ticker.upper().endswith(".TO") or ticker.upper().endswith(".V")
    clean = ticker.split(".")[0]   # strip .TO / .V

    # ── Step 1: Search for underlying to get conId + option months ────────────
    # NOTE: /search MUST be called before /strikes even if conId is known.
    try:
        search_results = _cp_get("/iserver/secdef/search", {"symbol": clean})
        time.sleep(_CP_RATE_DELAY)
    except Exception as exc:
        logger.debug("IBeam search failed for %s: %s", ticker, exc)
        return []

    if not search_results:
        return []

    # Pick the right underlying: prefer TSX listing for Canadian, SMART/US otherwise
    underlying = None
    for item in (search_results if isinstance(search_results, list) else []):
        desc = (item.get("description") or "").upper()
        has_options = any(
            s.get("secType") == "OPT"
            for s in item.get("sections", [])
        )
        if not has_options:
            continue
        if is_canadian and ("TSX" in desc or "TORONTO" in desc):
            underlying = item
            break
        if not is_canadian and underlying is None:
            underlying = item   # take first match with options

    if underlying is None:
        logger.debug("IBeam: no optionable underlying found for %s", ticker)
        return []

    under_conid = underlying["conid"]

    # Get available option expiry months
    opt_section = next(
        (s for s in underlying.get("sections", []) if s.get("secType") == "OPT"),
        None,
    )
    if not opt_section:
        return []

    months_str = opt_section.get("months", "")
    all_months = [m.strip() for m in months_str.split(";") if m.strip()]

    # Filter to months that overlap with our DTE window (rough check)
    target_months = []
    for month in all_months:
        try:
            # IBeam months look like "JAN25", "FEB25" etc.
            month_dt = dt.strptime(month, "%b%y").date()
            last_day = calendar.monthrange(month_dt.year, month_dt.month)[1]
            # 3rd Friday is typically the expiry — estimate as day 21 of the month
            third_friday = month_dt.replace(day=21)
            dte_approx = (third_friday - today).days
            if min_dte - 7 <= dte_approx <= max_dte + 14:   # generous window
                target_months.append(month)
        except ValueError:
            continue

    if not target_months:
        return []

    # ── Get underlying price for OTM filtering ────────────────────────────────
    snap = _cp_snapshot([under_conid])
    time.sleep(_CP_RATE_DELAY)
    under_data = snap.get(str(under_conid), {})

    current_price = _f(under_data, 31) or _f(under_data, 84) or _f(under_data, 86)
    if not current_price or current_price <= 0:
        logger.debug("IBeam: no price for underlying %s (conid=%s)", ticker, under_conid)
        return []

    lo_strike = current_price * (1 + min_otm_pct / 100)
    hi_strike = current_price * (1 + max_otm_pct / 100)

    # ── Steps 2 + 3: strikes → option conIds ─────────────────────────────────
    option_meta: list[tuple[int, float, str]] = []   # (conid, strike, maturityDate YYYYMMDD)

    opt_exchange = "MX" if is_canadian else exchange   # Canadian options trade on MX

    for month in target_months:
        try:
            strikes_params = {
                "conid": under_conid,
                "sectype": "OPT",
                "month": month,
            }
            if is_canadian:
                strikes_params["exchange"] = opt_exchange

            strikes_resp = _cp_get("/iserver/secdef/strikes", strikes_params)
            time.sleep(_CP_RATE_DELAY)
        except Exception as exc:
            logger.debug("IBeam strikes failed for %s %s: %s", ticker, month, exc)
            continue

        call_strikes = strikes_resp.get("call", []) if isinstance(strikes_resp, dict) else []
        # Filter to OTM range before making per-strike /info calls
        otm_strikes = [s for s in call_strikes if lo_strike <= float(s) <= hi_strike]

        for strike in otm_strikes:
            try:
                info_params = {
                    "conid": under_conid,
                    "secType": "OPT",
                    "month": month,
                    "strike": strike,
                    "right": "C",
                }
                if is_canadian:
                    info_params["exchange"] = opt_exchange

                info_resp = _cp_get("/iserver/secdef/info", info_params)
                time.sleep(_CP_RATE_DELAY)

                for opt in (info_resp if isinstance(info_resp, list) else []):
                    opt_conid = opt.get("conid")
                    maturity  = opt.get("maturityDate", "")   # YYYYMMDD
                    if opt_conid and maturity:
                        option_meta.append((int(opt_conid), float(strike), maturity))
            except Exception as exc:
                logger.debug("IBeam info failed for %s %s strike=%s: %s", ticker, month, strike, exc)
                continue

    if not option_meta:
        return []

    # ── Step 4: Market data snapshot for all option conIds ────────────────────
    all_results: list[dict] = []
    BATCH = 100

    for batch_start in range(0, len(option_meta), BATCH):
        batch = option_meta[batch_start: batch_start + BATCH]
        conids = [c for c, _, _ in batch]

        snap = _cp_snapshot(conids)
        time.sleep(_CP_RATE_DELAY)

        for opt_conid, strike, maturity in batch:
            item = snap.get(str(opt_conid), {})

            # Parse expiry and DTE
            try:
                exp_date = dt.strptime(maturity, "%Y%m%d").date()
                dte = (exp_date - today).days
                if not (min_dte <= dte <= max_dte):
                    continue
            except Exception:
                continue

            bid   = _f(item, 84, 0.0) or 0.0
            ask   = _f(item, 86)
            mark  = _f(item, 7635)
            delta = _f(item, 7308)
            gamma = _f(item, 7309)
            theta = _f(item, 7310)
            vega  = _f(item, 7311)
            iv_pct = _f(item, 7633)   # already in % (e.g. 25.0 = 25%)

            if bid <= 0:
                continue

            # OI and volume aren't in the standard snapshot fields —
            # use 0 and rely on post-scan filters (we already filtered by OTM)
            oi  = int(_f(item, 7084, 0) or 0)
            vol = int(_f(item, 7762, 0) or 0)

            if oi < min_oi or vol < min_vol:
                # Skip only if we actually got non-zero data; 0 may mean field
                # not subscribed — don't discard good opportunities silently
                if oi > 0 or vol > 0:
                    continue

            mid        = mark if mark else round((bid + (ask or bid)) / 2, 4)
            spread_pct = round((ask - bid) / ask * 100, 1) if (ask and ask > 0) else None
            otm_pct    = round((strike / current_price - 1) * 100, 2)
            annual_yield = round((mid / current_price) * (365 / dte) * 100, 2)
            max_return = round(((strike - current_price + mid) / current_price) * 100, 2)
            breakeven  = round(current_price - mid, 4)

            all_results.append({
                "strike":             strike,
                "expiry_date":        exp_date,
                "dte":                dte,
                "bid":                round(bid, 4),
                "ask":                round(ask, 4) if ask else None,
                "mid":                round(mid, 4),
                "volume":             vol,
                "open_interest":      oi,
                "iv_pct":             iv_pct,
                "delta":              round(abs(delta), 4) if delta is not None else None,
                "gamma":              round(gamma, 6) if gamma is not None else None,
                "theta":              round(theta, 4) if theta is not None else None,
                "vega":               round(vega, 4) if vega is not None else None,
                "otm_pct":            otm_pct,
                "annual_yield_pct":   annual_yield,
                "max_return_pct":     max_return,
                "breakeven":          breakeven,
                "bid_ask_spread_pct": spread_pct,
                "current_price":      round(current_price, 4),
            })

    logger.info("IBeam: %s → %d option rows", ticker, len(all_results))
    return all_results


def fetch_option_price_ibeam(
    underlying: str,
    expiry: "date",
    strike: float,
    option_type: str,
    is_canadian: bool = False,
) -> Optional[dict]:
    """
    Fetch live bid/ask/mid for a specific option position via IBeam.

    Used by price_service to price portfolio option positions before falling
    back to Yahoo Finance / Montreal Exchange.

    Args:
        underlying:   Root ticker, e.g. "AAPL" or "RY" (no .TO suffix)
        expiry:       Option expiry date
        strike:       Strike price as float
        option_type:  "CALL" or "PUT"
        is_canadian:  True → search for TSX listing and use MX exchange

    Returns dict with keys (price, bid, ask, currency) or None if unavailable.
    """
    if not _IBEAM_BASE:
        return None

    clean = underlying.split(".")[0]
    opt_exchange = "MX" if is_canadian else "SMART"
    right = "C" if option_type.upper() == "CALL" else "P"
    month = expiry.strftime("%b%y").upper()   # e.g. "JAN25"

    try:
        # Step 1: resolve underlying conId
        search_results = _cp_get("/iserver/secdef/search", {"symbol": clean})
        time.sleep(_CP_RATE_DELAY)

        underlying_item = None
        for item in (search_results if isinstance(search_results, list) else []):
            has_options = any(s.get("secType") == "OPT" for s in item.get("sections", []))
            if not has_options:
                continue
            desc = (item.get("description") or "").upper()
            if is_canadian and ("TSX" in desc or "TORONTO" in desc):
                underlying_item = item
                break
            if not is_canadian and underlying_item is None:
                underlying_item = item

        if underlying_item is None:
            logger.debug("IBeam price: no optionable underlying for %s", underlying)
            return None

        under_conid = underlying_item["conid"]

        # Step 2: get option conId for this exact strike/expiry/right
        info_params: dict = {
            "conid":   under_conid,
            "secType": "OPT",
            "month":   month,
            "strike":  strike,
            "right":   right,
        }
        if is_canadian:
            info_params["exchange"] = opt_exchange

        info_resp = _cp_get("/iserver/secdef/info", info_params)
        time.sleep(_CP_RATE_DELAY)

        opt_conids = [
            int(opt["conid"])
            for opt in (info_resp if isinstance(info_resp, list) else [])
            if opt.get("conid")
        ]
        if not opt_conids:
            logger.debug("IBeam price: no conId for %s %s %s %s", underlying, expiry, strike, right)
            return None

        # Step 3: snapshot for bid/ask/mark
        snap = _cp_snapshot([opt_conids[0]])
        item = snap.get(str(opt_conids[0]), {})

        bid  = _f(item, 84, 0.0) or 0.0
        ask  = _f(item, 86)
        mark = _f(item, 7635)

        if bid <= 0 and not mark:
            logger.debug("IBeam price: no market data for conId %s (%s)", opt_conids[0], underlying)
            return None

        mid      = mark if mark else round((bid + (ask or bid)) / 2, 4)
        currency = "CAD" if is_canadian else "USD"

        logger.info(
            "IBeam priced %s %s %s %s: bid=%.4f ask=%s mid=%.4f %s",
            underlying, expiry, option_type, strike,
            bid, f"{ask:.4f}" if ask else "N/A", mid, currency,
        )
        return {"price": mid, "bid": bid, "ask": ask, "currency": currency}

    except Exception as exc:
        logger.debug("IBeam option price failed for %s %s/%s/%s: %s", underlying, expiry, strike, option_type, exc)
        return None


# ── Scanner session ───────────────────────────────────────────────────────────

# Scanner uses client_id + 5 to avoid conflicting with other operations
_CID_SCAN = 5

class IBKRScannerSession:
    """
    Context manager that opens a dedicated read-only IB connection for scanning.
    Usage:
        with IBKRScannerSession() as ib:
            opps = scan_ticker_live(ib, 'AAPL', ...)
    """
    def __init__(self):
        self._ib = None

    def __enter__(self):
        if not _IB_AVAILABLE:
            raise RuntimeError("ib_insync not installed")
        import asyncio
        from ib_insync import IB
        try:
            asyncio.get_event_loop()
        except RuntimeError:
            asyncio.set_event_loop(asyncio.new_event_loop())

        s = get_settings()
        self._ib = IB()
        self._ib.connect(
            s.get("host", "127.0.0.1"),
            s.get("port", 4001),
            clientId=s.get("client_id", 10) + _CID_SCAN,
            timeout=20,
            readonly=True,
        )
        # Live data (type 1). Falls back to frozen (type 2) automatically when
        # the market is closed for equity options on most exchanges.
        self._ib.reqMarketDataType(1)
        logger.info("IBKRScannerSession: connected (clientId=%d)", s.get("client_id", 10) + _CID_SCAN)
        return self._ib

    def __exit__(self, *_):
        try:
            if self._ib and self._ib.isConnected():
                self._ib.disconnect()
                logger.info("IBKRScannerSession: disconnected")
        except Exception:
            pass


def scan_ticker_live(
    ib,
    ticker: str,
    currency: str = "USD",
    exchange: str = "SMART",
    min_dte: int = 14,
    max_dte: int = 60,
    min_otm_pct: float = 0.5,
    max_otm_pct: float = 25.0,
    min_oi: int = 50,
    min_vol: int = 3,
) -> list[dict]:
    """
    Fetch covered-call option chain with live Greeks for one ticker.
    `ib` must be an already-connected ib_insync.IB instance.
    Returns a list of raw opportunity dicts (no portfolio context yet).
    """
    import asyncio, math
    from datetime import date, datetime as dt
    from ib_insync import Stock, Option

    # ── Qualify underlying ────────────────────────────────────────────────────
    stock = Stock(ticker, exchange, currency)
    try:
        qualified = ib.qualifyContracts(stock)
    except Exception as e:
        logger.debug("qualifyContracts failed for %s: %s", ticker, e)
        return []
    if not qualified:
        return []
    stock = qualified[0]

    # ── Get underlying price via snapshot ─────────────────────────────────────
    try:
        [snap] = ib.reqTickers(stock)
        price = snap.marketPrice()
        if not price or (isinstance(price, float) and math.isnan(price)) or price <= 0:
            price = snap.close
        if not price or (isinstance(price, float) and math.isnan(price)) or price <= 0:
            logger.debug("No price for %s", ticker)
            return []
    except Exception as e:
        logger.debug("reqTickers (underlying) failed for %s: %s", ticker, e)
        return []

    # ── Option chain parameters ───────────────────────────────────────────────
    try:
        chains = ib.reqSecDefOptParams(stock.symbol, "", stock.secType, stock.conId)
    except Exception as e:
        logger.debug("reqSecDefOptParams failed for %s: %s", ticker, e)
        return []

    smart = next((c for c in chains if c.exchange == "SMART"), None) or (chains[0] if chains else None)
    if not smart:
        return []

    today = date.today()
    all_options: list = []

    for exp_str in sorted(smart.expirations):
        # Parse expiry — IB uses YYYYMMDD
        try:
            exp_date = dt.strptime(exp_str, "%Y%m%d").date()
        except ValueError:
            try:
                exp_date = date.fromisoformat(exp_str)
            except ValueError:
                continue

        dte = (exp_date - today).days
        if not (min_dte <= dte <= max_dte):
            continue

        lo = price * (1 + min_otm_pct / 100)
        hi = price * (1 + max_otm_pct / 100)
        strikes = sorted(s for s in smart.strikes if lo <= s <= hi)
        if not strikes:
            continue

        for s in strikes:
            all_options.append((Option(ticker, exp_str, s, "C", "SMART"), exp_date, dte, s))

    if not all_options:
        return []

    # ── Qualify all option contracts in one batch ─────────────────────────────
    try:
        raw_contracts = [o[0] for o in all_options]
        qualified_opts = ib.qualifyContracts(*raw_contracts)
    except Exception as e:
        logger.debug("qualifyContracts (options) failed for %s: %s", ticker, e)
        return []

    # Build map: conId → (exp_date, dte, strike) for qualified contracts
    qual_map = {c.conId: c for c in qualified_opts}
    meta_map = {}
    for opt, exp_date, dte, strike in all_options:
        # Match by strike+expiry since conId not yet known pre-qualify
        for qc in qualified_opts:
            if abs(qc.strike - strike) < 0.01 and qc.lastTradeDateOrContractMonth == opt.lastTradeDateOrContractMonth:
                meta_map[qc.conId] = (exp_date, dte)
                break

    if not qualified_opts:
        return []

    # ── Snapshot market data — Greeks come with option data ───────────────────
    try:
        tickers = ib.reqTickers(*qualified_opts)
    except Exception as e:
        logger.debug("reqTickers (options) failed for %s: %s", ticker, e)
        return []

    results = []
    for t in tickers:
        try:
            cid = t.contract.conId
            exp_meta = meta_map.get(cid)
            if not exp_meta:
                continue
            exp_date, dte = exp_meta

            bid = t.bid if t.bid and not math.isnan(t.bid) and t.bid > 0 else 0.0
            ask = t.ask if t.ask and not math.isnan(t.ask) and t.ask > 0 else 0.0
            if bid <= 0:
                continue

            greeks = t.modelGreeks
            if not greeks or greeks.delta is None or math.isnan(greeks.delta):
                continue

            delta     = abs(greeks.delta)
            iv_raw    = greeks.impliedVol
            iv_pct    = round(iv_raw * 100, 2) if iv_raw and not math.isnan(iv_raw) else None
            gamma     = round(greeks.gamma, 6)  if greeks.gamma and not math.isnan(greeks.gamma)  else None
            theta     = round(greeks.theta, 4)  if greeks.theta and not math.isnan(greeks.theta)  else None
            vega      = round(greeks.vega,  4)  if greeks.vega  and not math.isnan(greeks.vega)   else None

            strike = float(t.contract.strike)
            oi     = int(t.callOpenInterest or 0) or int(t.openInterest or 0)
            vol    = int(t.callVolume or 0)    or int(t.volume or 0)

            if oi < min_oi or vol < min_vol:
                continue

            mid            = round((bid + ask) / 2, 4)
            spread_pct     = round((ask - bid) / ask * 100, 1) if ask > 0 else None
            otm_pct        = round((strike / price - 1) * 100, 2)
            annual_yield   = round((mid / price) * (365 / dte) * 100, 2)
            max_return     = round(((strike - price + mid) / price) * 100, 2)
            breakeven      = round(price - mid, 4)
            iv_hv          = None  # hv_30 injected by caller

            results.append({
                "strike":            strike,
                "expiry_date":       exp_date,
                "dte":               dte,
                "bid":               round(bid, 4),
                "ask":               round(ask, 4),
                "mid":               mid,
                "volume":            vol,
                "open_interest":     oi,
                "iv_pct":            iv_pct,
                "delta":             round(delta, 4),
                "gamma":             gamma,
                "theta":             theta,
                "vega":              vega,
                "otm_pct":           otm_pct,
                "annual_yield_pct":  annual_yield,
                "max_return_pct":    max_return,
                "breakeven":         breakeven,
                "bid_ask_spread_pct": spread_pct,
                "current_price":     round(price, 4),
            })
        except Exception as e:
            logger.debug("Option row parse error for %s: %s", ticker, e)
            continue

    # Cancel market data lines we opened
    try:
        ib.cancelMktData(stock)
        for qc in qualified_opts:
            ib.cancelMktData(qc)
    except Exception:
        pass

    return results


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
