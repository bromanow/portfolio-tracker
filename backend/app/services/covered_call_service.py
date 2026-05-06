"""
Covered-call opportunity scanner.

Score methodology
-----------------
Base: annualised premium yield = (mid / price) × (365 / DTE) × 100

Multipliers:
  Delta / OTM  – prefer delta 0.20–0.30 (IBKR) or OTM 4–12% (yfinance proxy).
  IV richness  – IV / HV_30. High ratio = selling overpriced options (good).
  DTE quality  – prefer 28–40 DTE for theta decay sweet spot.
  Liquidity    – open interest as a proxy for ease of fill.
  Spread       – tight bid/ask spread scores higher (IBKR data only).

Higher score = better risk-adjusted covered-call income opportunity.
"""

import math
import logging
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

import yfinance as yf
import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


# ── Scan parameters (user-configurable, passed from the router) ───────────────

RATING_ORDER = {"Best": 0, "Good": 1, "Fair": 2, "Avoid": 3}

@dataclass
class ScanParams:
    min_avg_stock_vol: int   = 250_000
    min_option_oi:     int   = 50
    min_option_vol:    int   = 3
    min_dte:           int   = 14
    max_dte:           int   = 60
    min_otm_pct:       float = 0.5
    max_otm_pct:       float = 25.0
    min_div_yield:     float = 0.0    # minimum company annual dividend yield %
    min_rating:        str   = "Avoid"  # minimum rating to save: Best/Good/Fair/Avoid


# ── Helpers ───────────────────────────────────────────────────────────────────

def _norm_cdf(x: float) -> float:
    """Standard normal CDF via math.erfc (no scipy needed)."""
    return 0.5 * math.erfc(-x / math.sqrt(2))


def _bs_greeks(price: float, strike: float, iv_pct: float, dte: int, rfr: float = 0.045) -> tuple[Optional[float], Optional[float]]:
    """
    Black-Scholes call delta and theta (daily $).
    Used for yfinance path where live Greeks are unavailable.
    iv_pct in percent (e.g. 25.0 means 25%).
    Returns (delta, theta_per_day) or (None, None) on bad inputs.
    """
    if not (iv_pct and iv_pct > 0 and dte > 0 and price > 0 and strike > 0):
        return None, None
    try:
        sigma = iv_pct / 100.0
        T = dte / 365.0
        sqrt_T = math.sqrt(T)
        d1 = (math.log(price / strike) + (rfr + 0.5 * sigma ** 2) * T) / (sigma * sqrt_T)
        d2 = d1 - sigma * sqrt_T
        pdf_d1 = math.exp(-0.5 * d1 ** 2) / math.sqrt(2 * math.pi)
        delta = round(_norm_cdf(d1), 4)
        # Theta in $/year, convert to $/day (negative = decay)
        theta_annual = (
            -(price * sigma * pdf_d1) / (2 * sqrt_T)
            - rfr * strike * math.exp(-rfr * T) * _norm_cdf(d2)
        )
        theta_daily = round(theta_annual / 365, 4)
        return delta, theta_daily
    except Exception:
        return None, None


def _annualised_hv(prices: list[float], trading_days: int = 252) -> Optional[float]:
    """Annualised historical volatility from a sequence of closing prices (as %)."""
    if len(prices) < 10:
        return None
    log_rets = [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices)) if prices[i - 1] > 0]
    if len(log_rets) < 5:
        return None
    n = len(log_rets)
    mean = sum(log_rets) / n
    variance = sum((r - mean) ** 2 for r in log_rets) / max(n - 1, 1)
    return math.sqrt(variance) * math.sqrt(trading_days) * 100


def _hv_from_db(ticker: str, db: Session, window: int = 30) -> Optional[float]:
    rows = db.execute(text("""
        SELECT hp.close_price_cad, hp.close_price, hp.currency
        FROM   historical_prices hp
        JOIN   securities s ON s.id = hp.security_id
        WHERE  s.ticker = :ticker
          AND  s.is_option = false
          AND  hp.close_price > 0
        ORDER  BY hp.price_date DESC
        LIMIT  :lim
    """), {"ticker": ticker, "lim": window + 10}).fetchall()

    if len(rows) < 10:
        return None

    prices = []
    for r in rows:
        p = float(r[0]) if r[0] is not None else (float(r[1]) if r[1] is not None else None)
        if p and p > 0:
            prices.append(p)

    prices.reverse()
    return _annualised_hv(prices[-window:])


def _hv_from_yfinance(ticker: str, window: int = 30) -> Optional[float]:
    try:
        hist = yf.Ticker(ticker).history(period="3mo", auto_adjust=True)
        if hist.empty or len(hist) < 10:
            return None
        prices = hist["Close"].dropna().tolist()[-window:]
        return _annualised_hv(prices)
    except Exception as exc:
        logger.debug("yfinance HV fetch failed for %s: %s", ticker, exc)
        return None


def _score(
    annual_yield: float,
    iv_pct: Optional[float],
    hv_30: Optional[float],
    otm_pct: float,
    dte: int,
    open_interest: int,
    delta: Optional[float] = None,
    bid_ask_spread_pct: Optional[float] = None,
) -> tuple[float, str]:
    """
    Composite covered-call quality score + recommendation label.
    When delta is provided (IBKR or BS estimate), it replaces the OTM% proxy.
    Returns (score, recommendation) where recommendation is Best/Good/Fair/Avoid.
    """
    s = annual_yield

    # ── Strike quality ────────────────────────────────────────────────────────
    if delta is not None:
        if 0.20 <= delta <= 0.30:
            s *= 1.15; delta_tier = "best"
        elif (0.15 <= delta < 0.20) or (0.30 < delta <= 0.35):
            s *= 1.05; delta_tier = "good"
        elif (0.10 <= delta < 0.15) or (0.35 < delta <= 0.45):
            s *= 0.90; delta_tier = "fair"
        elif delta > 0.45:
            s *= 0.70; delta_tier = "avoid"
        else:
            s *= 0.65; delta_tier = "fair"
    else:
        delta_tier = "good"
        if otm_pct < 2:
            s *= 0.70; delta_tier = "avoid"
        elif otm_pct < 4:
            s *= 0.88; delta_tier = "fair"
        elif otm_pct <= 12:
            s *= 1.00
        elif otm_pct <= 18:
            s *= 0.92; delta_tier = "fair"
        else:
            s *= 0.80; delta_tier = "fair"

    # ── IV richness ───────────────────────────────────────────────────────────
    if iv_pct and hv_30 and hv_30 > 0:
        ratio = iv_pct / hv_30
        if ratio >= 1.5:   s *= 1.30
        elif ratio >= 1.25: s *= 1.20
        elif ratio >= 1.10: s *= 1.10
        elif ratio < 0.85:  s *= 0.80

    # ── DTE quality ───────────────────────────────────────────────────────────
    if 28 <= dte <= 40:       s *= 1.00
    elif 21 <= dte < 28 or 40 < dte <= 48: s *= 0.95
    else:                     s *= 0.88

    # ── Liquidity ─────────────────────────────────────────────────────────────
    if open_interest >= 2000:  s *= 1.15
    elif open_interest >= 500: s *= 1.08
    elif open_interest >= 100: s *= 1.00
    else:                      s *= 0.85

    # ── Bid/ask spread ────────────────────────────────────────────────────────
    if bid_ask_spread_pct is not None:
        if bid_ask_spread_pct < 5:   s *= 1.10
        elif bid_ask_spread_pct < 10: s *= 1.05
        elif bid_ask_spread_pct > 25: s *= 0.80

    score = round(s, 4)

    if score >= 18 and delta_tier in ("best", "good"):
        rec = "Best"
    elif score >= 10 and delta_tier in ("best", "good", "fair"):
        rec = "Good"
    elif score >= 5 and delta_tier != "avoid":
        rec = "Fair"
    else:
        rec = "Avoid"

    return score, rec


# ── Per-ticker scanning (yfinance path) ───────────────────────────────────────

def _scan_ticker(
    ticker: str,
    db: Session,
    portfolio_map: dict[str, int],
    hv_cache: dict[str, Optional[float]],
    params: ScanParams,
) -> list[dict]:
    try:
        yf_ticker = yf.Ticker(ticker)
        info = yf_ticker.info or {}
    except Exception as exc:
        logger.warning("yfinance info failed for %s: %s", ticker, exc)
        return []

    avg_vol = info.get("averageVolume") or info.get("averageDailyVolume10Day") or 0
    try:
        avg_vol = int(avg_vol)
    except (TypeError, ValueError):
        avg_vol = 0

    if avg_vol < params.min_avg_stock_vol:
        logger.debug("Skipping %s: avg vol %d < %d", ticker, avg_vol, params.min_avg_stock_vol)
        return []

    # Dividend yield (as %). yfinance returns a decimal (0.035 = 3.5%); some
    # versions or ETFs return it already as a percent — detect by magnitude.
    raw_div = info.get("dividendYield")
    div_yield = None
    try:
        if raw_div:
            v = float(raw_div)
            if not math.isnan(v) and v > 0:
                div_yield = round(v * 100 if v < 1.0 else v, 2)
    except Exception:
        pass

    if params.min_div_yield > 0 and (div_yield is None or div_yield < params.min_div_yield):
        logger.debug("Skipping %s: div yield %.1f%% < min %.1f%%", ticker, div_yield or 0, params.min_div_yield)
        return []

    current_price = (
        info.get("currentPrice")
        or info.get("regularMarketPrice")
        or info.get("previousClose")
    )
    if not current_price or current_price <= 0:
        logger.debug("Skipping %s: no price", ticker)
        return []

    currency = info.get("currency", "USD")
    company_name = info.get("longName") or info.get("shortName") or ticker

    if ticker not in hv_cache:
        hv_cache[ticker] = _hv_from_db(ticker, db) or _hv_from_yfinance(ticker)
    hv_30 = hv_cache[ticker]

    try:
        expirations = yf_ticker.options
    except Exception as exc:
        logger.warning("yfinance options failed for %s: %s", ticker, exc)
        return []

    today = date.today()
    target_exps = []
    for exp in expirations:
        try:
            exp_date = date.fromisoformat(exp)
            dte = (exp_date - today).days
            if params.min_dte <= dte <= params.max_dte:
                target_exps.append((exp, exp_date, dte))
        except ValueError:
            continue

    if not target_exps:
        return []

    opportunities: list[dict] = []
    portfolio_qty = portfolio_map.get(ticker, 0)

    for exp_str, exp_date, dte in target_exps:
        try:
            chain = yf_ticker.option_chain(exp_str)
            calls: pd.DataFrame = chain.calls
        except Exception as exc:
            logger.debug("option_chain failed for %s %s: %s", ticker, exp_str, exc)
            continue

        if calls.empty:
            continue

        for _, row in calls.iterrows():
            strike = float(row.get("strike", 0))
            if strike <= 0:
                continue

            def _f(v, default=0.0):
                try:
                    f = float(v) if v is not None else default
                    return default if math.isnan(f) else f
                except (TypeError, ValueError):
                    return default

            bid    = _f(row.get("bid"))
            ask    = _f(row.get("ask"))
            volume = int(_f(row.get("volume")))
            oi     = int(_f(row.get("openInterest")))
            iv_raw = row.get("impliedVolatility")
            iv_pct = round(float(iv_raw) * 100, 2) if iv_raw and not math.isnan(float(iv_raw)) else None

            otm_pct = (strike / current_price - 1) * 100
            if otm_pct < params.min_otm_pct or otm_pct > params.max_otm_pct:
                continue

            if bid <= 0 or oi < params.min_option_oi or volume < params.min_option_vol:
                continue

            mid = round((bid + ask) / 2, 4)
            annual_yield = round((mid / current_price) * (365 / dte) * 100, 2)
            max_return = round(((strike - current_price + mid) / current_price) * 100, 2)
            breakeven = round(current_price - mid, 4)
            iv_hv = round(iv_pct / hv_30, 3) if (iv_pct and hv_30 and hv_30 > 0) else None

            # Approximate delta + theta via Black-Scholes (no live Greeks on yfinance path)
            delta, theta = _bs_greeks(current_price, strike, iv_pct, dte) if iv_pct else (None, None)

            score, rec = _score(
                annual_yield=annual_yield,
                iv_pct=iv_pct,
                hv_30=hv_30,
                otm_pct=otm_pct,
                dte=dte,
                open_interest=oi,
                delta=delta,
            )

            if RATING_ORDER.get(rec, 3) > RATING_ORDER.get(params.min_rating, 3):
                continue

            opportunities.append({
                "ticker":             ticker,
                "company_name":       company_name,
                "current_price":      round(current_price, 4),
                "avg_stock_volume":   avg_vol,
                "currency":           currency,
                "dividend_yield":     div_yield,
                "strike":             strike,
                "expiry_date":        exp_date,
                "dte":                dte,
                "bid":                round(bid, 4),
                "ask":                round(ask, 4),
                "mid":                mid,
                "volume":             volume,
                "open_interest":      oi,
                "iv_pct":             iv_pct,
                "hv_30_pct":          round(hv_30, 2) if hv_30 else None,
                "iv_hv_ratio":        iv_hv,
                "otm_pct":            round(otm_pct, 2),
                "annual_yield_pct":   annual_yield,
                "max_return_pct":     max_return,
                "breakeven":          breakeven,
                "score":              score,
                "recommendation":     rec,
                "data_source":        "yfinance",
                "delta":              delta,
                "gamma":              None,
                "theta":              theta,
                "vega":               None,
                "bid_ask_spread_pct": None,
                "in_portfolio":       portfolio_qty > 0,
                "portfolio_qty":      portfolio_qty,
                "portfolio_contracts": portfolio_qty // 100,
            })

    return opportunities


def _scan_ticker_ibkr(
    ib,
    ticker: str,
    db: Session,
    portfolio_map: dict,
    hv_cache: dict,
    params: ScanParams,
) -> list[dict]:
    from app.services.ibkr_service import scan_ticker_live
    import yfinance as yf

    currency = "USD"
    exchange = "SMART"
    if ticker.endswith(".TO"):
        currency = "CAD"
        exchange = "TSX"

    raw = scan_ticker_live(
        ib, ticker, currency=currency, exchange=exchange,
        min_dte=params.min_dte, max_dte=params.max_dte,
        min_otm_pct=params.min_otm_pct, max_otm_pct=params.max_otm_pct,
    )
    if not raw:
        return []

    company_name = ticker
    avg_vol = 0
    div_yield = None
    try:
        info = yf.Ticker(ticker).info or {}
        company_name = info.get("longName") or info.get("shortName") or ticker
        avg_vol = int(info.get("averageVolume") or info.get("averageDailyVolume10Day") or 0)
        raw_div = info.get("dividendYield")
        if raw_div:
            v = float(raw_div)
            if not math.isnan(v) and v > 0:
                div_yield = round(v * 100 if v < 1.0 else v, 2)
    except Exception:
        pass

    if avg_vol < params.min_avg_stock_vol:
        return []

    if params.min_div_yield > 0 and (div_yield is None or div_yield < params.min_div_yield):
        return []

    if ticker not in hv_cache:
        hv_cache[ticker] = _hv_from_db(ticker, db) or _hv_from_yfinance(ticker)
    hv_30 = hv_cache[ticker]

    portfolio_qty = portfolio_map.get(ticker, 0)
    results = []

    for r in raw:
        if r.get("open_interest", 0) < params.min_option_oi:
            continue
        if r.get("volume", 0) < params.min_option_vol:
            continue

        iv_hv = round(r["iv_pct"] / hv_30, 3) if (r.get("iv_pct") and hv_30 and hv_30 > 0) else None
        score, rec = _score(
            annual_yield=r["annual_yield_pct"],
            iv_pct=r.get("iv_pct"),
            hv_30=hv_30,
            otm_pct=r["otm_pct"],
            dte=r["dte"],
            open_interest=r["open_interest"],
            delta=r.get("delta"),
            bid_ask_spread_pct=r.get("bid_ask_spread_pct"),
        )

        if RATING_ORDER.get(rec, 3) > RATING_ORDER.get(params.min_rating, 3):
            continue

        results.append({
            "ticker":             ticker,
            "company_name":       company_name,
            "current_price":      r["current_price"],
            "avg_stock_volume":   avg_vol,
            "currency":           currency,
            "dividend_yield":     div_yield,
            "strike":             r["strike"],
            "expiry_date":        r["expiry_date"],
            "dte":                r["dte"],
            "bid":                r["bid"],
            "ask":                r["ask"],
            "mid":                r["mid"],
            "volume":             r["volume"],
            "open_interest":      r["open_interest"],
            "iv_pct":             r.get("iv_pct"),
            "hv_30_pct":          round(hv_30, 2) if hv_30 else None,
            "iv_hv_ratio":        iv_hv,
            "otm_pct":            r["otm_pct"],
            "annual_yield_pct":   r["annual_yield_pct"],
            "max_return_pct":     r["max_return_pct"],
            "breakeven":          r["breakeven"],
            "delta":              r.get("delta"),
            "gamma":              r.get("gamma"),
            "theta":              r.get("theta"),
            "vega":               r.get("vega"),
            "bid_ask_spread_pct": r.get("bid_ask_spread_pct"),
            "score":              score,
            "recommendation":     rec,
            "data_source":        "ibkr",
            "in_portfolio":       portfolio_qty > 0,
            "portfolio_qty":      portfolio_qty,
            "portfolio_contracts": portfolio_qty // 100,
        })

    return results


# ── Full scan ─────────────────────────────────────────────────────────────────

def run_covered_call_scan(db: Session, params: Optional[ScanParams] = None) -> dict:
    """
    Run a full covered-call scan across all watchlist + portfolio tickers.
    Uses IB Gateway (live Greeks) when connected, falls back to yfinance.
    """
    from app.models.scanner import ScannerWatchlist, ScannerResult

    if params is None:
        params = ScanParams()

    scan_run_id = str(uuid.uuid4())
    started_at  = datetime.utcnow()

    ibkr_available = False
    ibkr_connected = False
    try:
        from app.services import ibkr_service
        ibkr_available = ibkr_service.is_available()
        status = ibkr_service.get_status()
        ibkr_connected = bool(
            ibkr_available
            and status.get("gateway_running")
            and status.get("last_connected_at")
        )
    except Exception:
        pass

    logger.info("Scanner: IB Gateway %s", "connected — using live Greeks" if ibkr_connected else "not connected — using yfinance")
    logger.info("Scanner params: %s", params)

    watchlist = {row.ticker for row in db.query(ScannerWatchlist).all()}

    acb_rows = db.execute(text("""
        SELECT s.ticker, SUM(t.quantity) AS net_qty
        FROM   transactions t
        JOIN   securities s ON s.id = t.security_id
        WHERE  s.is_option = false
          AND  t.transaction_type IN ('BUY','SELL','JOURNAL','TRANSFER')
        GROUP  BY s.ticker
        HAVING SUM(t.quantity) > 0
    """)).fetchall()
    portfolio_map: dict[str, int] = {r[0]: int(r[1]) for r in acb_rows if r[1]}

    all_tickers = sorted(watchlist | set(portfolio_map.keys()))
    logger.info("Scanner: %d tickers (%d watchlist, %d portfolio)", len(all_tickers), len(watchlist), len(portfolio_map))

    hv_cache: dict[str, Optional[float]] = {}
    all_opportunities: list[dict] = []
    errors: list[str] = []

    if ibkr_connected:
        from app.services.ibkr_service import IBKRScannerSession
        try:
            with IBKRScannerSession() as ib:
                for i, ticker in enumerate(all_tickers, 1):
                    logger.info("  [%d/%d] IBKR scanning %s …", i, len(all_tickers), ticker)
                    try:
                        opps = _scan_ticker_ibkr(ib, ticker, db, portfolio_map, hv_cache, params)
                        all_opportunities.extend(opps)
                        logger.info("    → %d opportunities (live)", len(opps))
                    except Exception as exc:
                        logger.exception("Scanner IBKR: error for %s", ticker)
                        errors.append(f"{ticker}: {exc}")
        except Exception as exc:
            logger.warning("IBKR scanner session failed (%s) — falling back to yfinance", exc)
            ibkr_connected = False

    if not ibkr_connected:
        for i, ticker in enumerate(all_tickers, 1):
            logger.info("  [%d/%d] yfinance scanning %s …", i, len(all_tickers), ticker)
            try:
                opps = _scan_ticker(ticker, db, portfolio_map, hv_cache, params)
                all_opportunities.extend(opps)
                logger.info("    → %d opportunities", len(opps))
            except Exception as exc:
                logger.exception("Scanner: unhandled error for %s", ticker)
                errors.append(f"{ticker}: {exc}")

    if all_opportunities:
        db.execute(text("DELETE FROM scanner_results"))
        scanned_at = datetime.utcnow()
        for opp in all_opportunities:
            db.add(ScannerResult(scan_run_id=scan_run_id, scanned_at=scanned_at, **opp))
        db.commit()
    else:
        logger.warning("Scanner found 0 opportunities — keeping previous results")

    return {
        "scan_run_id":     scan_run_id,
        "tickers_scanned": len(all_tickers),
        "opportunities":   len(all_opportunities),
        "errors":          errors,
        "elapsed_seconds": round((datetime.utcnow() - started_at).total_seconds(), 1),
        "data_source":     "ibkr" if ibkr_connected else "yfinance",
        "ibkr_connected":  ibkr_connected,
        "ibkr_available":  ibkr_available,
    }
