"""
Market price service.
Fetches current prices from Yahoo Finance and caches them in the market_prices table.

Ticker resolution strategy:
  1. If the security has a known successful fetch ticker (stored in market_prices.fetch_ticker),
     use that.
  2. Otherwise, derive candidates from the ticker + exchange:
       - TSX exchange → ticker + ".TO"  (e.g. ENB.TO)
       - NYSE/NASDAQ   → ticker as-is   (e.g. AAPL)
       - Unknown       → try bare ticker first, then ticker + ".TO"
  3. Options and non-equity asset classes are skipped.
"""
from __future__ import annotations

import logging
import re as _re
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
from math import gcd

import httpx as _httpx
import yfinance as yf
from sqlalchemy.orm import Session

from app.models.master import Security
from app.models.prices import MarketPrice
from app.services.fx_service import get_rate

logger = logging.getLogger(__name__)

# Exchange code → Yahoo Finance ticker suffix
EXCHANGE_SUFFIX: dict[str, str] = {
    "TSX": ".TO",
    "TSX-V": ".V",
    "TSXV": ".V",
    "TSX.V": ".V",
    "CVE": ".V",          # Canadian Venture Exchange
}

# Map Yahoo Finance exchange codes to our standard exchange codes
YAHOO_EXCHANGE_MAP: dict[str, str] = {
    "NYQ": "NYSE", "NYS": "NYSE",
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NasdaqGS": "NASDAQ",
    "NasdaqGM": "NASDAQ", "NasdaqCM": "NASDAQ",
    "TSX": "TSX", "TOR": "TSX",
    "PCX": "ARCA",
    "ASE": "AMEX",
    "BTS": "TSX-V", "CVE": "TSX-V", "VAN": "TSX-V",
}

# Asset classes we never price (options use complex symbology; FX is priced differently;
# structured notes and savings accounts are OTC/proprietary with no public feed)
SKIP_ASSET_CLASSES = {"OPTION", "CURRENCY", "STRUCTURED_NOTE", "SAVINGS_ACCOUNT"}

_OPTION_RE = _re.compile(
    r"^(CALL|PUT)\s+\.?([\w\-]+)\s+(\d{2}/\d{2}/\d{2})\s+([\d\.]+)\s*$",
    _re.IGNORECASE,
)

# IB/OCC format: "CRWD 260717C00400000"  (underlying YYMMDD C/P 8-digit-strike*1000)
_IB_OPTION_RE = _re.compile(
    r"^([\w\-\.]+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$",
    _re.IGNORECASE,
)


def parse_option_ticker(ticker: str, security: Optional["Security"] = None) -> Optional[dict]:
    """Parse option ticker into components. Handles two formats:
    - Legacy: 'CALL AMD 09/19/25 125' or 'CALL .BNS 12/19/25 97'
    - IB/OCC: 'CRWD 260717C00400000' or 'WCP 260417C00014500'
    """
    t = ticker.strip()
    m = _OPTION_RE.match(t)
    if m:
        mo, dy, yr = m.group(3).split("/")
        return {
            "option_type": m.group(1).upper(),
            "underlying": m.group(2),
            "expiry": date(2000 + int(yr), int(mo), int(dy)),
            "strike": float(m.group(4)),
            "is_canadian": "." in t.split()[1] if len(t.split()) > 1 else False,
        }
    m = _IB_OPTION_RE.match(t)
    if m:
        underlying = m.group(1)
        expiry_date = date(2000 + int(m.group(2)), int(m.group(3)), int(m.group(4)))
        option_type = "CALL" if m.group(5).upper() == "C" else "PUT"
        strike = int(m.group(6)) / 1000.0
        # Determine Canadian from security record if available, else False
        if security is not None:
            is_canadian = (
                (security.currency or "").upper() == "CAD"
                or (security.exchange or "").upper() in ("TSX", "TSX-V", "TSXV")
            )
        else:
            is_canadian = False
        return {
            "option_type": option_type,
            "underlying": underlying,
            "expiry": expiry_date,
            "strike": strike,
            "is_canadian": is_canadian,
        }
    return None


# Montreal Exchange option chain URL (HTML page with data-row JSON attributes)
_MX_BASE_URL = "https://www.m-x.ca/en/trading/data/quotes"
_MX_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.m-x.ca/",
}

# TMX Money GraphQL API — covers TSX/TSXV equities, ETFs, and Canadian mutual funds.
# Securities on this source use "tmx:<SYMBOL>" as their fetch_ticker_override.
# Mutual funds (exchangeCode "CMF") that aren't available on Yahoo Finance — in
# particular institutional share classes like PGF550 (Series F) or PGF2050 (Series I)
# that Yahoo tracks under a different retail-class ticker — should use this source.
_TMX_MONEY_URL = "https://app-money.tmx.com/graphql"
_TMX_MONEY_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://money.tmx.com/",
}
_TMX_QUOTE_QUERY = """
{ getQuoteBySymbol(symbol: %s, locale: "en") {
    symbol name price priceChange percentChange prevClose dayHigh dayLow exchangeCode
} }
"""
_TMX_HISTORY_QUERY = """
{ getCompanyPriceHistory(symbol: %s, start: %s, end: %s) {
    datetime closePrice volume
} }
"""


def fetch_mx_option_price(
    underlying: str,
    expiry_date: date,
    option_type: str,
    strike: float,
) -> Optional[Decimal]:
    """
    Fetch Canadian option price from the Montreal Exchange (m-x.ca).
    Parses the option chain HTML page — each row has a data-row JSON attribute
    containing both call and put data with fields: expiry_date, strike_price,
    bid_price, ask_price, last_price, volume, open_interest.
    Returns bid/ask midpoint in CAD, or None if unavailable.
    `underlying` should be the bare TSX ticker, e.g. "WCP" (no .TO suffix).
    """
    import html as _html
    import json as _json
    import re as _re2

    expiry_str = expiry_date.strftime("%Y-%m-%d")
    url = f"{_MX_BASE_URL}?symbol={underlying.upper()}*"
    try:
        resp = _httpx.get(url, headers=_MX_HEADERS, timeout=8, follow_redirects=True)
        if resp.status_code != 200:
            logger.warning("MX HTML HTTP %d for %s", resp.status_code, underlying)
            return None

        html_text = resp.text
        type_key = "call" if option_type.upper() == "CALL" else "put"

        # Each <tr data-row='...HTML-encoded JSON...'> holds one strike's data
        best_match = None
        best_strike_diff = float("inf")

        for m in _re2.finditer(r"data-row='([^']*)'", html_text):
            raw = _html.unescape(m.group(1))
            try:
                row_data = _json.loads(raw)
            except Exception:
                continue

            opt = row_data.get(type_key)
            if not opt:
                continue
            if opt.get("expiry_date") != expiry_str:
                continue

            sp = float(opt.get("strike_price") or 0)
            if sp == 0:
                continue
            diff = abs(sp - strike) / max(strike, 1)
            if diff < 0.02 and diff < best_strike_diff:
                best_strike_diff = diff
                best_match = opt

        if best_match is None:
            logger.debug("MX: no matching %s row for %s strike=%.2f expiry=%s",
                         option_type, underlying, strike, expiry_str)
            return None

        bid = float(best_match.get("bid_price") or 0)
        ask = float(best_match.get("ask_price") or 0)
        last = float(best_match.get("last_price") or 0)

        if bid > 0 and ask > 0:
            mid = (bid + ask) / 2
        elif last > 0:
            mid = last
        else:
            logger.debug("MX: bid/ask/last all zero for %s %s strike=%.2f expiry=%s",
                         underlying, option_type, strike, expiry_str)
            return None

        logger.info("MX option price for %s %s %s strike=%.2f → %.4f CAD",
                    underlying, option_type, expiry_str, strike, mid)
        return Decimal(str(round(mid, 6)))

    except Exception as exc:
        logger.debug("MX option fetch exception for %s: %s", underlying, exc)
        return None


def fetch_tmx_money_quote(symbol: str) -> Optional[dict]:
    """
    Fetch a current quote from the TMX Money GraphQL API.

    Returns a dict with keys:
        price, prev_close, day_change, day_change_pct, day_high, day_low
    All values are in CAD (TMX Money quotes CAD-listed securities in CAD).
    Returns None if the symbol is not found or the request fails.

    Usage: set fetch_ticker_override = "tmx:<SYMBOL>" on the Security row.
    """
    import json as _json
    query = _TMX_QUOTE_QUERY % (f'"{symbol}"',)
    try:
        resp = _httpx.post(
            _TMX_MONEY_URL,
            headers=_TMX_MONEY_HEADERS,
            content=_json.dumps({"query": query}).encode(),
            timeout=10,
        )
        if resp.status_code != 200:
            logger.warning("TMX Money HTTP %d for %s", resp.status_code, symbol)
            return None
        body = resp.json()
        q = (body.get("data") or {}).get("getQuoteBySymbol")
        if not q or q.get("price") is None:
            logger.debug("TMX Money: no quote data for %s", symbol)
            return None
        price = Decimal(str(q["price"]))
        prev  = Decimal(str(q["prevClose"])) if q.get("prevClose") is not None else None
        chg   = (price - prev) if prev is not None else None
        chg_pct = (chg / abs(prev) * 100).quantize(Decimal("0.01")) if (chg is not None and prev and prev != 0) else None
        logger.info("TMX Money quote %s → %.4f CAD", symbol, float(price))
        return {
            "price":         price,
            "prev_close":    prev,
            "day_change":    chg,
            "day_change_pct": chg_pct,
            "day_high":      Decimal(str(q["dayHigh"])) if q.get("dayHigh") is not None else None,
            "day_low":       Decimal(str(q["dayLow"]))  if q.get("dayLow")  is not None else None,
        }
    except Exception as exc:
        logger.debug("TMX Money quote exception for %s: %s", symbol, exc)
        return None


def fetch_tmx_money_history(
    symbol: str,
    start_date: date,
    end_date: date,
) -> list[dict]:
    """
    Fetch daily close-price history from the TMX Money GraphQL API.

    Returns a list of dicts: [{"price_date": date, "close_price": Decimal}, ...]
    sorted ascending by date.  All prices are in CAD.
    Returns [] on any error.
    """
    import json as _json
    query = _TMX_HISTORY_QUERY % (
        f'"{symbol}"',
        f'"{start_date.isoformat()}"',
        f'"{end_date.isoformat()}"',
    )
    try:
        resp = _httpx.post(
            _TMX_MONEY_URL,
            headers=_TMX_MONEY_HEADERS,
            content=_json.dumps({"query": query}).encode(),
            timeout=20,
        )
        if resp.status_code != 200:
            logger.warning("TMX Money history HTTP %d for %s", resp.status_code, symbol)
            return []
        body = resp.json()
        rows = (body.get("data") or {}).get("getCompanyPriceHistory") or []
        result = []
        for r in rows:
            dt_str = r.get("datetime")
            cp = r.get("closePrice")
            if not dt_str or cp is None:
                continue
            try:
                from datetime import datetime as _dt
                d = _dt.strptime(dt_str, "%Y-%m-%d").date()
                result.append({"price_date": d, "close_price": Decimal(str(cp))})
            except Exception:
                continue
        result.sort(key=lambda x: x["price_date"])
        logger.info("TMX Money history %s: %d rows (%s → %s)", symbol, len(result),
                    result[0]["price_date"] if result else "—",
                    result[-1]["price_date"] if result else "—")
        return result
    except Exception as exc:
        logger.debug("TMX Money history exception for %s: %s", symbol, exc)
        return []


def fetch_option_chain_price(db: Session, security: Security, usd_to_cad: Optional[Decimal] = None) -> Optional[MarketPrice]:
    """Fetch current price for an option using Yahoo Finance option chains."""
    parsed = parse_option_ticker(security.ticker, security=security)
    if not parsed:
        logger.debug("Cannot parse option ticker: %s", security.ticker)
        return None

    underlying = parsed["underlying"]
    expiry: date = parsed["expiry"]
    strike = parsed["strike"]
    option_type = parsed["option_type"]
    is_canadian = parsed["is_canadian"]

    # Resolve is_canadian with three fallback levels:
    # 1. Option security's own currency / exchange
    # 2. OptionContract → underlying security's currency / exchange
    # 3. Ambiguous → try US (no .TO) first, then CA (.TO) — whichever has the chain
    ambiguous = False
    if security.currency is None and (security.exchange or "").upper() not in (
        "TSX", "TSX-V", "TSXV", "NYSE", "NASDAQ", "AMEX", "ARCA", "CBOE"
    ):
        from app.models.options import OptionContract
        contract = db.query(OptionContract).filter(OptionContract.security_id == security.id).first()
        if contract and contract.underlying_security:
            us = contract.underlying_security
            if (us.currency or "").upper() == "CAD" or (us.exchange or "").upper() in ("TSX", "TSX-V", "TSXV"):
                is_canadian = True
            elif (us.currency or "").upper() == "USD" or (us.exchange or "").upper() in ("NYSE", "NASDAQ", "AMEX", "ARCA"):
                is_canadian = False
            else:
                ambiguous = True  # Neither option nor underlying has definitive currency info
        else:
            ambiguous = True

    expiry_str = expiry.strftime("%Y-%m-%d")

    # Build candidate list
    # Canadian options: try TMX Money first (authoritative for TSX), then Yahoo as fallback
    # US options: Yahoo Finance only
    # Ambiguous: try US Yahoo first (more common), then CA via TMX
    if ambiguous:
        candidates = [("yahoo", underlying, "USD"), ("mx", underlying, "CAD")]
    elif is_canadian:
        candidates = [("mx", underlying, "CAD"), ("yahoo", underlying + ".TO", "CAD")]
    else:
        candidates = [("yahoo", underlying, "USD")]

    price_val: Optional[Decimal] = None
    currency = "USD"
    fetch_ticker_used: Optional[str] = None
    option_source: str = "yahoo_chain"

    for source_type, sym, ccy in candidates:
        try:
            if source_type == "mx":
                # Montreal Exchange — native CAD option data for TSX underlyings
                mx_price = fetch_mx_option_price(sym, expiry, option_type, strike)
                if mx_price is None:
                    continue
                price_val = mx_price
                currency = "CAD"
                fetch_ticker_used = f"mx:{sym}/{expiry_str}/{option_type}/{strike}"
                option_source = "mx_chain"
                logger.info("Priced %s via MX: %.4f CAD", security.ticker, float(price_val))
            else:
                # Yahoo Finance — US options (and Canadian as fallback)
                yahoo_underlying = sym
                t = yf.Ticker(yahoo_underlying)
                available = t.options or []
                if expiry_str not in available:
                    logger.debug("Option expiry %s not in Yahoo chain for %s", expiry_str, yahoo_underlying)
                    continue

                chain = t.option_chain(expiry_str)
                df = chain.calls if option_type == "CALL" else chain.puts
                if df is None or df.empty:
                    continue

                row = df[df["strike"] == float(strike)]
                if row.empty:
                    closest_idx = (df["strike"] - strike).abs().idxmin()
                    closest_strike = df.loc[closest_idx, "strike"]
                    if abs(closest_strike - strike) / max(strike, 1) > 0.02:
                        continue
                    row = df.loc[[closest_idx]]

                if row.empty:
                    continue

                r = row.iloc[0]
                bid = float(r.get("bid", 0) or 0)
                ask = float(r.get("ask", 0) or 0)
                last = float(r.get("lastPrice", 0) or 0)

                if bid > 0 and ask > 0:
                    mid = (bid + ask) / 2
                elif last > 0:
                    mid = last
                else:
                    continue

                price_val = Decimal(str(round(mid, 6)))
                currency = ccy
                fetch_ticker_used = f"{yahoo_underlying}/{expiry_str}/{option_type}/{strike}"
                logger.info("Priced %s via Yahoo %s: %.4f %s", security.ticker, yahoo_underlying, float(price_val), ccy)

            # Persist resolved currency onto security record for future fast-path
            if not security.currency:
                security.currency = currency
                db.flush()
            break

        except Exception as exc:
            logger.debug("Option chain fetch failed for %s via %s: %s", security.ticker, sym, exc)
            continue

    if price_val is None:
        return None

    # CAD conversion
    if currency == "CAD":
        price_cad = price_val
    elif currency == "USD":
        if usd_to_cad is None:
            usd_to_cad = get_rate(db, date.today(), "USD", "CAD")
        price_cad = (price_val * usd_to_cad).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP) if usd_to_cad else None
    else:
        price_cad = None

    today = date.today()
    data = {
        "price": price_val,
        "currency": currency,
        "price_cad": price_cad,
        "prev_close": None,
        "day_high": None,
        "day_low": None,
        "day_change": None,
        "day_change_pct": None,
        "price_date": today,
        "fetched_at": datetime.now(timezone.utc).replace(tzinfo=None),
        "fetch_ticker": fetch_ticker_used,
        "source": option_source,
    }
    mp = _upsert_price(db, security.id, data)
    db.flush()

    # Also record in historical_prices so option price history is tracked
    from app.models.prices import HistoricalPrice
    hist = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == security.id,
        HistoricalPrice.price_date == today,
    ).first()
    if hist:
        hist.close_price = price_val
        hist.currency = currency
        hist.close_price_cad = price_cad
        hist.source = option_source
        hist.fetch_ticker = fetch_ticker_used
    else:
        db.add(HistoricalPrice(
            security_id=security.id,
            price_date=today,
            close_price=price_val,
            currency=currency,
            close_price_cad=price_cad,
            source=option_source,
            fetch_ticker=fetch_ticker_used,
        ))
    db.flush()
    logger.info("Fetched option price for %s: %s %s", security.ticker, price_val, currency)
    return mp


def _d(v) -> Optional[Decimal]:
    """Safely convert a float/int/None to Decimal."""
    if v is None:
        return None
    try:
        f = float(v)
        if f != f:  # NaN check
            return None
        return Decimal(str(f))
    except (TypeError, ValueError):
        return None


def _yahoo_candidates(security: Security, cached_fetch_ticker: Optional[str] = None) -> list[str]:
    """
    Return list of Yahoo Finance ticker symbols to try, in priority order.
    Returns empty list for options and currencies.
    TSX note: Yahoo Finance uses dashes for dot-suffixed tickers: DIR.UN → DIR-UN.TO
    """
    if security.is_option or security.asset_class in SKIP_ASSET_CLASSES:
        return []

    # Manual override always wins
    if security.fetch_ticker_override:
        return [security.fetch_ticker_override.strip()]

    raw = security.ticker.strip()
    exchange = (security.exchange or "").upper().strip()
    native_ccy = (security.currency or "").upper().strip()

    # When exchange is explicitly set, derive deterministically — ignore any cached ticker
    # (the cached ticker may have been fetched before the exchange was corrected)
    suffix = EXCHANGE_SUFFIX.get(exchange)
    if suffix:
        normalized = raw.replace(".", "-")
        return [normalized + suffix]

    if exchange in ("NYSE", "NASDAQ", "AMEX", "ARCA"):
        return [raw]

    # No explicit exchange — use cached successful ticker as a shortcut
    if cached_fetch_ticker:
        return [cached_fetch_ticker]

    # Unknown exchange — use currency as hint
    normalized = raw.replace(".", "-")
    if native_ccy == "CAD":
        # Likely Canadian — try .TO forms first, then bare as last resort
        if normalized != raw:
            return [normalized + ".TO", raw + ".TO", raw]
        return [normalized + ".TO", raw]
    elif native_ccy == "USD":
        # Likely US — bare ticker only
        return [raw]
    else:
        # No hint — try bare first (NYSE/NASDAQ), then .TO (TSX)
        if normalized != raw:
            return [raw, normalized + ".TO", raw + ".TO"]
        return [raw, raw + ".TO"]


def _fetch_one(yahoo_sym: str) -> Optional[dict]:
    """
    Fetch latest price data for a single Yahoo Finance symbol.
    Returns a dict with price fields, or None if unavailable.
    """
    try:
        t = yf.Ticker(yahoo_sym)
        fi = t.fast_info
        price_val = fi.last_price
        if price_val is None or price_val != price_val or price_val <= 0:
            return None

        price = _d(price_val)
        if price is None:
            return None

        currency = (getattr(fi, "currency", None) or "CAD").upper()
        prev_close = _d(getattr(fi, "previous_close", None))
        day_high = _d(getattr(fi, "day_high", None))
        day_low = _d(getattr(fi, "day_low", None))

        day_change: Optional[Decimal] = None
        day_change_pct: Optional[Decimal] = None
        if prev_close and prev_close > 0:
            day_change = price - prev_close
            day_change_pct = (day_change / prev_close * Decimal("100")).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            )

        return {
            "price": price,
            "currency": currency,
            "prev_close": prev_close,
            "day_high": day_high,
            "day_low": day_low,
            "day_change": day_change,
            "day_change_pct": day_change_pct,
            "fetch_ticker": yahoo_sym,
            "source": "yahoo",
            "fetched_at": datetime.now(timezone.utc).replace(tzinfo=None),  # store as naive UTC
            "price_date": date.today(),
        }
    except Exception as exc:
        logger.debug("yfinance fetch failed for %s: %s", yahoo_sym, exc)
        return None


def _upsert_historical_price(
    db: Session,
    security_id: int,
    price_date: "date",
    close_price: "Optional[Decimal]",
    currency: str,
    close_price_cad: "Optional[Decimal]",
    fetch_ticker: "Optional[str]",
    source: str,
) -> None:
    """
    Upsert one row into historical_prices for the given security and date.

    Called from the intraday price refresh so that historical_prices stays the
    single source of truth for all pricing:
      - today's row  → intraday price (overwritten on each refresh)
      - yesterday's row → prev_close from the same API response (official prior close)

    Manual prices (source='manual') in market_prices are never touched here;
    they remain the fallback for private securities with no exchange feed.
    """
    from app.models.prices import HistoricalPrice
    if close_price is None or close_price <= 0:
        return
    hp = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == security_id,
        HistoricalPrice.price_date == price_date,
    ).first()
    if hp is None:
        hp = HistoricalPrice(security_id=security_id, price_date=price_date)
        db.add(hp)
    # Always overwrite: intraday > derived, official close > intraday
    hp.close_price     = close_price
    hp.currency        = currency
    hp.close_price_cad = close_price_cad
    hp.fetch_ticker    = fetch_ticker
    hp.source          = source


def _upsert_price(db: Session, security_id: int, data: dict) -> MarketPrice:
    """Insert or update the market price row for a security.
    Manual prices (source='manual') are never overwritten by auto-fetch."""
    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    if mp is None:
        mp = MarketPrice(security_id=security_id)
        db.add(mp)
    elif getattr(mp, "source", None) == "manual":
        return mp  # preserve manual price

    mp.price = data["price"]
    mp.currency = data["currency"]
    mp.price_cad = data.get("price_cad")
    mp.prev_close = data.get("prev_close")
    mp.day_high = data.get("day_high")
    mp.day_low = data.get("day_low")
    mp.day_change = data.get("day_change")
    mp.day_change_pct = data.get("day_change_pct")
    mp.price_date = data.get("price_date")
    mp.fetched_at = data.get("fetched_at")
    mp.fetch_ticker = data.get("fetch_ticker")
    mp.source = data.get("source", "yahoo")
    return mp


def _infer_currency(sec: Security, fetch_ticker: str) -> str:
    """Infer security currency from metadata when Yahoo doesn't provide it (batch download)."""
    if sec.currency:
        return sec.currency.upper()
    exch = (sec.exchange or "").upper()
    if exch in ("TSX", "TSX-V", "TSXV"):
        return "CAD"
    if exch in ("NYSE", "NASDAQ", "AMEX", "ARCA", "CBOE"):
        return "USD"
    if fetch_ticker.endswith(".TO") or fetch_ticker.endswith(".V"):
        return "CAD"
    return "USD"


def _yf_download(sym: str, start: str, end: str, **kwargs):
    """yf.download with a 45-second per-security timeout. Returns empty DataFrame on timeout/error."""
    import pandas as pd
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FTimeout
    with ThreadPoolExecutor(max_workers=1) as _pool:
        _fut = _pool.submit(yf.download, sym, start=start, end=end, **kwargs)
        try:
            return _fut.result(timeout=45)
        except _FTimeout:
            logger.warning("yf.download timeout (45s) for %s", sym)
            return pd.DataFrame()
        except Exception as exc:
            logger.debug("yf.download error for %s: %s", sym, exc)
            return pd.DataFrame()


def fetch_price_for_security(
    db: Session,
    security: Security,
    usd_to_cad: Optional[Decimal] = None,
    cached_mp: Optional[MarketPrice] = None,
) -> Optional[MarketPrice]:
    """
    Fetch current price for one security and upsert into market_prices.
    Returns the updated MarketPrice row or None if price unavailable.
    Pass cached_mp to avoid an extra DB query when called from a batch loop.

    Source routing:
    - fetch_ticker_override = "tmx:<SYMBOL>"  → TMX Money GraphQL API (CAD; mutual funds, TSX)
    - fetch_ticker_override = <other>          → Yahoo Finance
    - no override                              → Yahoo Finance (ticker derived from exchange)
    """
    # ── TMX Money source ────────────────────────────────────────────────────────
    override = (security.fetch_ticker_override or "").strip()
    if override.lower().startswith("tmx:"):
        tmx_symbol = override[4:].strip()
        quote = fetch_tmx_money_quote(tmx_symbol)
        if quote is None:
            logger.warning("TMX Money: no price for %s (%s)", security.ticker, tmx_symbol)
            return None
        today = date.today()
        data = {
            "price":          quote["price"],
            "currency":       "CAD",
            "price_cad":      quote["price"],
            "prev_close":     quote.get("prev_close"),
            "day_high":       quote.get("day_high"),
            "day_low":        quote.get("day_low"),
            "day_change":     quote.get("day_change"),
            "day_change_pct": quote.get("day_change_pct"),
            "price_date":     today,
            "fetched_at":     __import__("datetime").datetime.now(__import__("datetime").timezone.utc).replace(tzinfo=None),
            "fetch_ticker":   override,
            "source":         "tmx",
        }
        mp = _upsert_price(db, security.id, data)
        db.flush()

        # Mirror into historical_prices — today (intraday) and yesterday (prev_close)
        _upsert_historical_price(
            db, security.id, today,
            quote["price"], "CAD", quote["price"],
            override, "intraday",
        )
        prev = quote.get("prev_close")
        if prev and prev > 0:
            from datetime import timedelta as _td
            _upsert_historical_price(
                db, security.id, today - _td(days=1),
                prev, "CAD", prev,
                override, "tmx",
            )
        db.flush()

        logger.info("Fetched price for %s via TMX Money (%s): %.4f CAD",
                    security.ticker, tmx_symbol, float(quote["price"]))
        return mp

    # ── Yahoo Finance source ─────────────────────────────────────────────────────
    cached_fetch_ticker = cached_mp.fetch_ticker if cached_mp else None
    if cached_mp is None:
        row = db.query(MarketPrice).filter(MarketPrice.security_id == security.id).first()
        cached_fetch_ticker = row.fetch_ticker if row else None

    candidates = _yahoo_candidates(security, cached_fetch_ticker)
    if not candidates:
        logger.debug("Skipping price fetch for %s (option or currency)", security.ticker)
        return None

    for yahoo_sym in candidates:
        data = _fetch_one(yahoo_sym)
        if data is None:
            continue

        currency = data["currency"]
        if currency == "CAD":
            data["price_cad"] = data["price"]
        elif currency == "USD":
            if usd_to_cad is None:
                usd_to_cad = get_rate(db, date.today(), "USD", "CAD")
            if usd_to_cad:
                data["price_cad"] = (data["price"] * usd_to_cad).quantize(
                    Decimal("0.000001"), rounding=ROUND_HALF_UP
                )
            else:
                data["price_cad"] = None
        else:
            data["price_cad"] = None

        mp = _upsert_price(db, security.id, data)
        db.flush()
        logger.info("Fetched price for %s via %s: %s %s", security.ticker, yahoo_sym, data["price"], currency)
        return mp

    logger.warning("Could not fetch price for %s (tried: %s)", security.ticker, candidates)
    return None


def refresh_all_prices(
    db: Session,
    security_ids: Optional[list[int]] = None,
) -> dict:
    """
    Refresh market prices for actively-tracked securities.

    Fetches all non-option tickers in parallel via a thread pool (8 workers),
    using fast_info.last_price for live intraday prices.
    """
    usd_to_cad = get_rate(db, date.today(), "USD", "CAD")

    # Find securities to price
    if security_ids:
        securities = db.query(Security).filter(Security.id.in_(security_ids)).all()
    else:
        from app.models.transactions import Transaction as _TxnRef
        priced_ids = {mp.security_id for mp in db.query(MarketPrice).all()}
        txn_ids = {
            r[0] for r in db.query(_TxnRef.security_id)
            .filter(_TxnRef.security_id.isnot(None)).distinct().all()
        }
        securities = db.query(Security).filter(Security.id.in_(priced_ids | txn_ids)).all()

    # Pre-load ALL MarketPrice rows in one query (avoids N per-security DB lookups)
    all_mp: dict[int, MarketPrice] = {
        mp.security_id: mp
        for mp in db.query(MarketPrice).filter(
            MarketPrice.security_id.in_([s.id for s in securities])
        ).all()
    }

    non_options = [s for s in securities if not s.is_option and s.asset_class not in SKIP_ASSET_CLASSES]
    skipped = len(securities) - len(non_options)
    fetched = 0
    failed = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = date.today()

    # Build sym → [securities] map (multiple securities may share a fetch ticker)
    sym_to_secs: dict[str, list[Security]] = {}
    for sec in non_options:
        cached_mp = all_mp.get(sec.id)
        candidates = _yahoo_candidates(sec, cached_mp.fetch_ticker if cached_mp else None)
        if not candidates:
            skipped += 1
            continue
        sym_to_secs.setdefault(candidates[0], []).append(sec)

    if sym_to_secs:
        # Fetch all symbols in parallel using a thread pool.
        # _fetch_one uses fast_info.last_price → live intraday price during market hours.
        # 8 workers balances speed vs Yahoo rate limiting.
        from concurrent.futures import ThreadPoolExecutor, as_completed
        syms = list(sym_to_secs.keys())
        sym_results: dict[str, Optional[dict]] = {}
        with ThreadPoolExecutor(max_workers=4) as pool:
            future_to_sym = {pool.submit(_fetch_one, sym): sym for sym in syms}
            for future in as_completed(future_to_sym):
                sym = future_to_sym[future]
                try:
                    sym_results[sym] = future.result()
                except Exception as exc:
                    logger.debug("Thread error for %s: %s", sym, exc)
                    sym_results[sym] = None

        from datetime import timedelta
        yesterday = today - timedelta(days=1)

        for sym, secs in sym_to_secs.items():
            data = sym_results.get(sym)
            if data is None:
                for sec in secs:
                    failed += 1
                continue
            for sec in secs:
                currency = data["currency"]
                if currency == "CAD":
                    data["price_cad"] = data["price"]
                elif currency == "USD" and usd_to_cad:
                    data["price_cad"] = (data["price"] * usd_to_cad).quantize(
                        Decimal("0.000001"), rounding=ROUND_HALF_UP
                    )
                else:
                    data["price_cad"] = None
                _upsert_price(db, sec.id, data)

                # ── Mirror into historical_prices (single source of truth) ──────
                # Today: intraday price (overwritten on each refresh)
                _upsert_historical_price(
                    db, sec.id, today,
                    data["price"], currency, data.get("price_cad"),
                    sym, "intraday",
                )
                # Yesterday: prev_close = official close for prior trading day
                prev = data.get("prev_close")
                if prev and prev > 0:
                    prev_cad = prev if currency == "CAD" else (
                        (prev * usd_to_cad).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
                        if usd_to_cad else None
                    )
                    _upsert_historical_price(
                        db, sec.id, yesterday,
                        prev, currency, prev_cad,
                        sym, "yahoo",
                    )
                # ────────────────────────────────────────────────────────────────

                fetched += 1
                logger.info("Fetched price for %s via %s: %s %s", sec.ticker, sym, data["price"], currency)

    # Options: each needs its own chain lookup (can't be batched).
    # Only fetch options that have NOT yet expired — expired options have no
    # current market price and attempting to fetch them wastes time on timeouts.
    from app.models.transactions import Transaction as _Txn
    option_sec_ids = {r[0] for r in db.query(_Txn.security_id).filter(_Txn.security_id.isnot(None)).distinct().all()}
    option_secs_all = db.query(Security).filter(
        Security.id.in_(option_sec_ids),
        Security.is_option == True,
    ).all()
    option_secs = []
    for sec in option_secs_all:
        parsed = parse_option_ticker(sec.ticker)
        if parsed and parsed["expiry"] < today:
            skipped += 1  # expired — no market price exists
        else:
            option_secs.append(sec)
    for sec in option_secs:
        result = fetch_option_chain_price(db, sec, usd_to_cad=usd_to_cad)
        if result is not None:
            fetched += 1

    db.commit()
    logger.info("Price refresh complete: %d fetched, %d skipped, %d failed", fetched, skipped, failed)

    # Auto-snapshot option prices into historical_prices (1 record per day, upsert)
    from app.models.prices import HistoricalPrice as _HP
    today_snap = date.today()
    # Pre-load today's option snapshot rows in one query
    opt_ids = [s.id for s in option_secs]
    existing_snaps: dict[int, _HP] = {}
    if opt_ids:
        for hp in db.query(_HP).filter(_HP.security_id.in_(opt_ids), _HP.price_date == today_snap).all():
            existing_snaps[hp.security_id] = hp
    # Reload updated MarketPrice rows for options
    opt_mp: dict[int, MarketPrice] = {}
    if opt_ids:
        for mp in db.query(MarketPrice).filter(MarketPrice.security_id.in_(opt_ids)).all():
            opt_mp[mp.security_id] = mp
    for sec in option_secs:
        mp = opt_mp.get(sec.id)
        if mp is None or mp.price is None:
            continue
        hp = existing_snaps.get(sec.id)
        if hp:
            hp.close_price = mp.price
            hp.currency = mp.currency
            hp.close_price_cad = mp.price_cad
            hp.source = mp.source or "snapshot"
            hp.fetch_ticker = mp.fetch_ticker
        else:
            db.add(_HP(
                security_id=sec.id, price_date=today_snap,
                close_price=mp.price, currency=mp.currency,
                close_price_cad=mp.price_cad,
                source=mp.source or "snapshot", fetch_ticker=mp.fetch_ticker,
            ))
    db.commit()

    return {"fetched": fetched, "skipped": skipped, "failed": failed, "total": len(securities)}


def fetch_security_info(security: Security) -> Optional[dict]:
    """
    Fetch company metadata from Yahoo Finance for a security.
    Returns a dict of fields to update, or None if unavailable.
    Uses the same ticker resolution logic as price fetching.
    """
    # Build candidate list (same logic as price fetch, but without cached ticker)
    candidates = _yahoo_candidates(security, cached_fetch_ticker=None)
    if not candidates:
        return None

    for yahoo_sym in candidates:
        try:
            t = yf.Ticker(yahoo_sym)
            info = t.info
            if not info or info.get("quoteType") == "NONE":
                continue
            # Map Yahoo exchange code to our code
            yahoo_exch = info.get("exchange") or info.get("fullExchangeName") or ""
            our_exch = YAHOO_EXCHANGE_MAP.get(yahoo_exch, yahoo_exch.upper() if yahoo_exch else None)
            return {
                "fetch_ticker": yahoo_sym,
                "name": info.get("longName") or info.get("shortName"),
                "exchange": our_exch,
                "currency": (info.get("currency") or "").upper() or None,
                "sector": info.get("sector"),
                "industry": info.get("industry"),
                "country": info.get("country"),
                "description": info.get("longBusinessSummary"),
            }
        except Exception as exc:
            logger.debug("fetch_security_info failed for %s: %s", yahoo_sym, exc)
            continue
    return None


def get_price_map(db: Session) -> dict[int, MarketPrice]:
    """Return a dict of security_id → MarketPrice for all cached prices."""
    prices = db.query(MarketPrice).all()
    return {mp.security_id: mp for mp in prices}


def fetch_historical_prices(
    db: Session,
    security_ids: Optional[list[int]] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    incremental: bool = False,
) -> dict:
    """
    Download daily closing price history from Yahoo Finance and upsert into historical_prices.
    For each security, only fetches from its earliest transaction date (not a global cutoff),
    so there's no wasted data for recently-added securities.

    When incremental=True, each security starts from the day after its most-recent
    historical_prices entry (skipping securities already up-to-date), rather than
    going all the way back to the first transaction date.
    """
    import pandas as pd
    from datetime import timedelta
    from app.models.transactions import Transaction
    from app.models.prices import HistoricalPrice

    if to_date is None:
        to_date = date.today()
    # from_date is a floor (don't go earlier than this) rather than a forced start.
    # If not supplied, there's no floor and each security uses its own earliest transaction.
    global_floor: Optional[date] = from_date

    # Securities to fetch
    if security_ids:
        securities = db.query(Security).filter(Security.id.in_(security_ids)).all()
    else:
        ids = {r[0] for r in db.query(Transaction.security_id)
               .filter(Transaction.security_id.isnot(None)).distinct().all()}
        # Also include option underlyings — they have no direct transactions but
        # we still want their price history for the Security Detail Panel chart.
        from app.models.options import OptionContract as _OC
        underlying_ids = {r[0] for r in db.query(_OC.underlying_security_id)
                          .filter(_OC.underlying_security_id.isnot(None)).distinct().all()}
        ids.update(underlying_ids)
        securities = db.query(Security).filter(Security.id.in_(ids)).all()

    # Build per-security earliest transaction date map
    from sqlalchemy import func as sqlfunc
    earliest_rows = (
        db.query(Transaction.security_id, sqlfunc.min(Transaction.transaction_date))
        .filter(Transaction.security_id.isnot(None))
        .group_by(Transaction.security_id)
        .all()
    )
    earliest_by_sec: dict[int, date] = {}
    for sid, earliest in earliest_rows:
        if earliest:
            d = earliest.date() if hasattr(earliest, 'date') else earliest
            earliest_by_sec[sid] = d

    # For incremental mode: per-security latest historical price date
    latest_hist_by_sec: dict[int, date] = {}
    if incremental:
        latest_rows = (
            db.query(HistoricalPrice.security_id, sqlfunc.max(HistoricalPrice.price_date))
            .group_by(HistoricalPrice.security_id)
            .all()
        )
        for sid, latest in latest_rows:
            if latest:
                d = latest.date() if hasattr(latest, 'date') else latest
                latest_hist_by_sec[sid] = d

    # FX history needs to span the full range of all securities combined
    overall_from = min(earliest_by_sec.values()) if earliest_by_sec else (
        global_floor or date(to_date.year - 10, to_date.month, to_date.day)
    )
    if global_floor:
        overall_from = max(overall_from, global_floor)

    # USD→CAD FX history: download CADUSD=X from Yahoo and build a date→rate map
    try:
        fx_hist = _yf_download("CADUSD=X", start=str(overall_from),
                               end=str(to_date + timedelta(days=1)),
                               auto_adjust=False, progress=False)
        # Flatten multi-level columns (yfinance ≥ 0.2 returns (metric, ticker) tuples)
        if isinstance(fx_hist.columns, pd.MultiIndex):
            fx_hist.columns = [col[0] for col in fx_hist.columns]
        usd_cad_series: dict[date, Decimal] = {}
        for ts, row in fx_hist.iterrows():
            close = float(row["Close"]) if not pd.isna(row["Close"]) else None
            if close and close > 0:
                # CADUSD=X gives USD per CAD; invert to get CAD per USD
                usd_cad_series[ts.date() if hasattr(ts, "date") else ts] = Decimal(str(round(1.0 / close, 6)))
    except Exception as exc:
        logger.warning("Could not fetch FX history: %s", exc)
        usd_cad_series = {}

    def _nearest_fx(d: date) -> Optional[Decimal]:
        """Find the most recent USD→CAD rate on or before date d.
        Tries Yahoo FX history first; falls back to stored BOC rates."""
        for delta in range(5):
            r = usd_cad_series.get(d - timedelta(days=delta))
            if r:
                return r
        # Yahoo FX series missing this date — fall back to stored BOC rate
        from app.services.fx_service import get_rate as _get_rate
        return _get_rate(db, d, "USD", "CAD")

    fetched = 0
    skipped = 0
    failed = 0

    for sec in securities:
        if sec.is_option or sec.asset_class in SKIP_ASSET_CLASSES:
            skipped += 1
            continue

        # ── TMX Money path ───────────────────────────────────────────────────
        # Securities with fetch_ticker_override = "tmx:<SYMBOL>" are fetched
        # from the TMX Money GraphQL API instead of Yahoo Finance.
        override = (sec.fetch_ticker_override or "").strip()
        if override.lower().startswith("tmx:"):
            tmx_symbol = override[4:].strip()

            # Determine the date range for this security
            if incremental:
                last_hist = latest_hist_by_sec.get(sec.id)
                if last_hist:
                    sec_from = last_hist + timedelta(days=1)
                    if sec_from > to_date:
                        skipped += 1
                        continue  # already up-to-date
                else:
                    sec_from = earliest_by_sec.get(sec.id, overall_from)
            else:
                sec_from = earliest_by_sec.get(sec.id, overall_from)
                if global_floor:
                    sec_from = max(sec_from, global_floor)

            tmx_rows = fetch_tmx_money_history(tmx_symbol, sec_from, to_date)
            if not tmx_rows:
                logger.warning("No TMX Money history for %s (%s)", sec.ticker, tmx_symbol)
                failed += 1
                continue

            # Pre-load existing HistoricalPrice rows for upsert
            existing_hp_map: dict[date, HistoricalPrice] = {
                hp.price_date: hp
                for hp in db.query(HistoricalPrice).filter(
                    HistoricalPrice.security_id == sec.id,
                    HistoricalPrice.price_date >= sec_from,
                    HistoricalPrice.price_date <= to_date,
                ).all()
            }

            rows_added = 0
            for r in tmx_rows:
                price_dt: date = r["price_date"]
                close: Decimal = r["close_price"]
                if close <= 0:
                    continue
                # TMX Money always returns CAD prices
                hp = existing_hp_map.get(price_dt)
                if hp is None:
                    hp = HistoricalPrice(security_id=sec.id, price_date=price_dt)
                    db.add(hp)
                    existing_hp_map[price_dt] = hp
                hp.close_price = close
                hp.currency = "CAD"
                hp.close_price_cad = close
                hp.fetch_ticker = tmx_symbol
                hp.source = "tmx"
                rows_added += 1

            db.flush()
            db.commit()
            logger.info("Stored %d TMX Money history rows for %s", rows_added, sec.ticker)
            fetched += 1
            continue  # done with this security — skip the Yahoo path below

        # ── Yahoo Finance path ───────────────────────────────────────────────
        # Use the same ticker resolution as spot prices
        cached_mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
        candidates = _yahoo_candidates(sec, cached_mp.fetch_ticker if cached_mp else None)
        if not candidates:
            skipped += 1
            continue

        # Start from the right date:
        # - incremental: day after the last known price entry for this security
        # - full: security's earliest transaction date (or global floor if set)
        if incremental:
            last_hist = latest_hist_by_sec.get(sec.id)
            if last_hist:
                sec_from = last_hist + timedelta(days=1)
                if sec_from > to_date:
                    skipped += 1
                    continue  # already up-to-date
            else:
                sec_from = earliest_by_sec.get(sec.id, overall_from)
        else:
            sec_from = earliest_by_sec.get(sec.id, overall_from)
            if global_floor:
                sec_from = max(sec_from, global_floor)

        hist = None
        used_sym = None
        for sym in candidates:
            try:
                df = _yf_download(sym, start=str(sec_from),
                                  end=str(to_date + timedelta(days=1)),
                                  auto_adjust=False, progress=False)
                # Flatten multi-level columns (yfinance ≥ 0.2 returns (metric, ticker) tuples)
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [col[0] for col in df.columns]
                if not df.empty:
                    hist = df
                    used_sym = sym
                    break
            except Exception as exc:
                logger.debug("History fetch failed for %s: %s", sym, exc)

        if hist is None or hist.empty:
            logger.warning("No history for %s", sec.ticker)
            failed += 1
            continue

        # Detect currency from spot price cache, security record, or ticker suffix
        currency = "CAD"
        if cached_mp:
            currency = cached_mp.currency or "CAD"
        elif sec.currency:
            currency = sec.currency.upper()
        elif used_sym:
            # Infer from ticker: .TO / .V = CAD, bare = USD
            currency = "CAD" if (used_sym.endswith(".TO") or used_sym.endswith(".V")) else "USD"

        # Build cumulative split-correction factors for this security.
        # Yahoo returns split-adjusted ("forward-adjusted") Close prices: all
        # historical prices are divided by the cumulative split ratio so the
        # series looks continuous at the current price.  To recover the actual
        # traded price for each date we multiply back by the product of all
        # split ratios for splits that occurred AFTER that date.
        from app.models.prices import StockSplit as _StockSplit
        sec_splits = sorted(
            db.query(_StockSplit).filter(_StockSplit.security_id == sec.id).all(),
            key=lambda s: s.split_date,
        )
        # Precompute suffix-products: for each index i, suffix_factor[i] is the
        # product of split_ratio for splits[i], splits[i+1], ...
        # Then for a given price_dt, we need the product of all splits with split_date > price_dt.
        suffix_factors: list[tuple] = []  # (split_date, factor_from_here_onward)
        cumulative = Decimal("1")
        for sp in reversed(sec_splits):
            cumulative = (cumulative * sp.split_ratio).quantize(
                Decimal("0.000001"), rounding=ROUND_HALF_UP
            )
            suffix_factors.append((sp.split_date, cumulative))
        suffix_factors.reverse()  # now sorted oldest→newest split date

        def _split_correction(price_dt: date) -> Decimal:
            """Product of split ratios for all splits that occurred after price_dt."""
            for split_date, factor in suffix_factors:
                if split_date > price_dt:
                    return factor
            return Decimal("1")

        # Pre-load all existing HistoricalPrice rows for this security in the
        # date window — one query instead of one per trading day (avoids N*M queries)
        existing_hp_map: dict[date, HistoricalPrice] = {
            hp.price_date: hp
            for hp in db.query(HistoricalPrice).filter(
                HistoricalPrice.security_id == sec.id,
                HistoricalPrice.price_date >= sec_from,
                HistoricalPrice.price_date <= to_date,
            ).all()
        }

        rows_added = 0
        for ts, row in hist.iterrows():
            close_val = row["Close"]
            if pd.isna(close_val) or close_val <= 0:
                continue
            close = Decimal(str(round(float(close_val), 6)))
            price_dt = ts.date() if hasattr(ts, "date") else ts

            correction = _split_correction(price_dt)
            if correction != Decimal("1"):
                close = (close * correction).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)

            if currency == "CAD":
                close_cad = close
            elif currency == "USD":
                fx = _nearest_fx(price_dt)
                close_cad = (close * fx).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP) if fx else None
            else:
                close_cad = None

            # In-memory lookup instead of per-row DB query
            hp = existing_hp_map.get(price_dt)
            if hp is None:
                hp = HistoricalPrice(security_id=sec.id, price_date=price_dt)
                db.add(hp)
                existing_hp_map[price_dt] = hp
            hp.close_price = close
            hp.currency = currency
            hp.close_price_cad = close_cad
            hp.fetch_ticker = used_sym
            hp.source = "yahoo"
            rows_added += 1

        db.flush()
        logger.info("Stored %d price history rows for %s", rows_added, sec.ticker)

        # Fetch and store split history for this security
        try:
            t = yf.Ticker(used_sym)
            splits = t.splits  # pandas Series: index=date, value=ratio
            if splits is not None and not splits.empty:
                from app.models.prices import StockSplit
                for split_ts, ratio in splits.items():
                    if ratio <= 0 or ratio == 1.0:
                        continue
                    split_dt = split_ts.date() if hasattr(split_ts, 'date') else split_ts
                    existing = db.query(StockSplit).filter(
                        StockSplit.security_id == sec.id,
                        StockSplit.split_date == split_dt,
                    ).first()
                    if existing is None:
                        db.add(StockSplit(
                            security_id=sec.id,
                            split_date=split_dt,
                            split_ratio=Decimal(str(round(float(ratio), 6))),
                        ))
                    else:
                        existing.split_ratio = Decimal(str(round(float(ratio), 6)))
                db.flush()
        except Exception as exc:
            logger.debug("Could not fetch splits for %s: %s", used_sym, exc)

        # Commit after each security so progress is preserved if the operation is interrupted
        db.commit()
        fetched += 1

    return {"fetched": fetched, "skipped": skipped, "failed": failed, "total": len(securities)}


def get_historical_price_map_rich(
    db: Session,
    security_ids: list[int],
    price_date: date,
) -> dict[int, Optional[dict]]:
    """
    Return a map of security_id → {close_price_cad, close_price, currency, price_date}
    for the given date (most recent price on or before price_date).

    Unlike get_historical_price_map this also returns the native (non-CAD) close price
    and the currency, so callers can display the price in its native currency (e.g. USD).

    Fallback for manually-priced securities: when no HistoricalPrice entry exists for a
    security that has a MarketPrice with source='manual' (e.g. mortgages priced at $1/unit,
    structured notes at par, savings accounts), use that manual price as the historical
    price.  These values are intentionally stable and do not change over time, so the
    current manual price is always the correct historical price.
    """
    from app.models.prices import HistoricalPrice
    from sqlalchemy import func as sqlfunc

    if not security_ids:
        return {}

    subq = (
        db.query(
            HistoricalPrice.security_id,
            sqlfunc.max(HistoricalPrice.price_date).label("latest_date"),
        )
        .filter(
            HistoricalPrice.security_id.in_(security_ids),
            HistoricalPrice.price_date <= price_date,
            HistoricalPrice.close_price.isnot(None),
        )
        .group_by(HistoricalPrice.security_id)
        .subquery()
    )
    rows = (
        db.query(HistoricalPrice)
        .join(
            subq,
            (HistoricalPrice.security_id == subq.c.security_id)
            & (HistoricalPrice.price_date == subq.c.latest_date),
        )
        .all()
    )
    result: dict[int, Optional[dict]] = {sid: None for sid in security_ids}
    for hp in rows:
        result[hp.security_id] = {
            "close_price_cad": hp.close_price_cad,
            "close_price": hp.close_price,
            "currency": hp.currency or "CAD",
            "price_date": hp.price_date,
        }

    # ── Fallback: use MarketPrice for manually-priced securities with no history ──
    # Manually-maintained prices (source='manual') represent stable values such as
    # mortgage principal ($1/unit), structured-note par (100), or savings-account NAV (1).
    # Since these values do not fluctuate, the current manual price is a valid
    # approximation for any historical date.
    missing_ids = [sid for sid in security_ids if result[sid] is None]
    if missing_ids:
        manual_prices = (
            db.query(MarketPrice)
            .filter(
                MarketPrice.security_id.in_(missing_ids),
                MarketPrice.source == "manual",
                MarketPrice.price.isnot(None),
            )
            .all()
        )
        for mp in manual_prices:
            result[mp.security_id] = {
                "close_price_cad": mp.price_cad,
                "close_price": mp.price,
                "currency": mp.currency or "CAD",
                "price_date": mp.price_date,  # note: this is the manual entry date, not price_date
            }

    return result


def get_historical_price_map(
    db: Session,
    security_ids: list[int],
    price_date: date,
) -> dict[int, Optional[Decimal]]:
    """
    Return a map of security_id → CAD close price for the given date.

    Uses the most recent price on or before price_date (no fixed lookback
    window), so thinly-traded stocks with infrequent price entries are
    handled correctly.

    Prices are stored unadjusted (yfinance auto_adjust=False returns the
    actual traded close price). No split correction is applied here — the
    stored values already reflect the true market price at the time.
    """
    from app.models.prices import HistoricalPrice
    from sqlalchemy import func as sqlfunc

    if not security_ids:
        return {}

    # Single bulk query: for each security, the most recent price_date ≤ price_date
    subq = (
        db.query(
            HistoricalPrice.security_id,
            sqlfunc.max(HistoricalPrice.price_date).label("latest_date"),
        )
        .filter(
            HistoricalPrice.security_id.in_(security_ids),
            HistoricalPrice.price_date <= price_date,
            HistoricalPrice.close_price_cad.isnot(None),
        )
        .group_by(HistoricalPrice.security_id)
        .subquery()
    )
    rows = (
        db.query(HistoricalPrice)
        .join(
            subq,
            (HistoricalPrice.security_id == subq.c.security_id)
            & (HistoricalPrice.price_date == subq.c.latest_date),
        )
        .all()
    )
    result: dict[int, Optional[Decimal]] = {sid: None for sid in security_ids}
    for hp in rows:
        result[hp.security_id] = hp.close_price_cad

    # Fallback: manually-priced securities with no historical entry use their
    # stable MarketPrice value (par, $1/unit, etc.) as the historical price.
    missing_ids = [sid for sid in security_ids if result[sid] is None]
    if missing_ids:
        manual_prices = (
            db.query(MarketPrice)
            .filter(
                MarketPrice.security_id.in_(missing_ids),
                MarketPrice.source == "manual",
                MarketPrice.price_cad.isnot(None),
            )
            .all()
        )
        for mp in manual_prices:
            result[mp.security_id] = mp.price_cad

    return result
