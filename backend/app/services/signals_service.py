"""
Technical signals computed from historical_prices.

All computations use the close_price_cad column so everything is
comparable across USD and CAD securities.

Signal definitions
──────────────────
RSI-14      Wilder's smoothed RSI over 14 periods.
            Seeded with a 28-day simple-average warmup.
            >70 = overbought, <30 = oversold.

Return-Nm   Total return over the last N months, expressed as a %.
            Trading-day approximations: 1m≈21d, 3m≈63d, 6m≈126d, 12m≈252d.

Momentum    12-month return minus 1-month return (Jegadeesh-Titman factor).
            Positive = medium-term uptrend; negative = reversal risk.

MA-50/200   Simple moving averages of the last 50 / 200 trading days.
            price_vs_50d / price_vs_200d = % above (+) or below (−).
            golden_cross = MA-50 > MA-200 (bullish regime signal).

Vol-20d/60d Realised annualised volatility = σ(log returns) × √252.
            20-day = short-term; 60-day = medium-term.
"""

from __future__ import annotations

import math
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Trading-day counts for each return window
_WINDOW = {"1m": 21, "3m": 63, "6m": 126, "12m": 252}


# ─── helpers ──────────────────────────────────────────────────────────────────

def _safe(v: float | None) -> Optional[float]:
    """Return None for NaN/Inf, otherwise round to 4dp."""
    if v is None:
        return None
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(f, 4)
    except (TypeError, ValueError):
        return None


def _rsi(prices: list[float], period: int = 14) -> Optional[float]:
    """
    Wilder's smoothed RSI.  Requires at least 2*period data points for a
    reliable seed; returns None if prices list is too short.
    """
    if len(prices) < period + 1:
        return None

    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, len(prices)):
        delta = prices[i] - prices[i - 1]
        gains.append(max(0.0, delta))
        losses.append(max(0.0, -delta))

    # Seed with simple average of the first `period` changes
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    # Wilder smoothing for the remainder
    for g, l in zip(gains[period:], losses[period:]):
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + l) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100.0 - 100.0 / (1.0 + rs), 4)


def _volatility(prices: list[float], window: int) -> Optional[float]:
    """Annualised realised volatility from log-returns over the last `window` days."""
    if len(prices) < window + 1:
        return None
    tail = prices[-(window + 1):]
    log_rets = [math.log(tail[i] / tail[i - 1]) for i in range(1, len(tail)) if tail[i - 1] > 0]
    if len(log_rets) < 2:
        return None
    n = len(log_rets)
    mean = sum(log_rets) / n
    variance = sum((r - mean) ** 2 for r in log_rets) / (n - 1)
    return round(math.sqrt(variance) * math.sqrt(252) * 100, 4)  # as %


# ─── main entry point ─────────────────────────────────────────────────────────

def compute_signals_for_security(db: Session, security_id: int) -> Optional[dict]:
    """
    Compute technical signals for one security and upsert into security_signals.
    Returns the signals dict (same shape as SecuritySignals columns), or None if
    there is insufficient price history.
    """
    from app.models.prices import HistoricalPrice
    from app.models.master import SecuritySignals

    # Load up to 260 trading days of history (enough for 200-day MA + buffer)
    cutoff = date.today() - timedelta(days=380)
    rows = (
        db.query(HistoricalPrice)
        .filter(
            HistoricalPrice.security_id == security_id,
            HistoricalPrice.price_date >= cutoff,
            HistoricalPrice.close_price_cad.isnot(None),
        )
        .order_by(HistoricalPrice.price_date)
        .all()
    )

    if len(rows) < 2:
        logger.debug("signals: insufficient history for security_id=%d (%d rows)", security_id, len(rows))
        return None

    prices = [float(r.close_price_cad) for r in rows]
    as_of = rows[-1].price_date
    current = prices[-1]

    # ── Moving averages ───────────────────────────────────────────────────────
    def _ma(n: int) -> Optional[float]:
        if len(prices) < n:
            return None
        return sum(prices[-n:]) / n

    ma50  = _ma(50)
    ma200 = _ma(200)

    price_vs_50  = _safe((current / ma50  - 1) * 100) if ma50  else None
    price_vs_200 = _safe((current / ma200 - 1) * 100) if ma200 else None
    golden_cross = bool(ma50 > ma200) if (ma50 and ma200) else None

    # ── Returns ───────────────────────────────────────────────────────────────
    def _ret(days: int) -> Optional[float]:
        if len(prices) < days + 1:
            return None
        past = prices[-(days + 1)]
        if past <= 0:
            return None
        return _safe((current / past - 1) * 100)

    r1m  = _ret(_WINDOW["1m"])
    r3m  = _ret(_WINDOW["3m"])
    r6m  = _ret(_WINDOW["6m"])
    r12m = _ret(_WINDOW["12m"])
    mom  = _safe((r12m or 0) - (r1m or 0)) if (r12m is not None and r1m is not None) else None

    # ── RSI ───────────────────────────────────────────────────────────────────
    # Use at most 60 days for the RSI calculation (28 warmup + 32 smoothed)
    rsi_prices = prices[-60:] if len(prices) > 60 else prices
    rsi = _rsi(rsi_prices, period=14)

    # ── Volatility ────────────────────────────────────────────────────────────
    vol20 = _volatility(prices, 20)
    vol60 = _volatility(prices, 60)

    signals = {
        "as_of_date":     as_of,
        "ma_50d":         _safe(ma50),
        "ma_200d":        _safe(ma200),
        "price_vs_50d":   price_vs_50,
        "price_vs_200d":  price_vs_200,
        "golden_cross":   golden_cross,
        "return_1m":      r1m,
        "return_3m":      r3m,
        "return_6m":      r6m,
        "return_12m":     r12m,
        "momentum_12_1":  mom,
        "rsi_14":         _safe(rsi),
        "volatility_20d": vol20,
        "volatility_60d": vol60,
        "computed_at":    datetime.utcnow(),
    }

    # Upsert
    existing = (
        db.query(SecuritySignals)
        .filter(SecuritySignals.security_id == security_id)
        .first()
    )
    if existing is None:
        existing = SecuritySignals(security_id=security_id)
        db.add(existing)

    for k, v in signals.items():
        setattr(existing, k, v)

    db.flush()
    logger.info(
        "signals computed for security_id=%d: RSI=%.1f ret1m=%s ret12m=%s vol20d=%s",
        security_id,
        rsi or 0,
        f"{r1m:.1f}%" if r1m is not None else "—",
        f"{r12m:.1f}%" if r12m is not None else "—",
        f"{vol20:.1f}%" if vol20 is not None else "—",
    )
    return signals


def compute_signals_all(db: Session, security_ids: Optional[list[int]] = None) -> dict:
    """
    Compute and store signals for all (or a subset of) non-option securities
    that have historical price data.
    """
    from app.models.master import Security
    from app.models.prices import HistoricalPrice
    from sqlalchemy import func as sqlfunc

    # Which security ids have any historical data?
    ids_with_history = {
        r[0] for r in db.query(HistoricalPrice.security_id).distinct().all()
    }

    q = db.query(Security).filter(Security.is_option == False)  # noqa: E712
    if security_ids:
        q = q.filter(Security.id.in_(security_ids))
    securities = q.all()

    computed = skipped = failed = 0
    for sec in securities:
        if sec.id not in ids_with_history:
            skipped += 1
            continue
        try:
            result = compute_signals_for_security(db, sec.id)
            if result is None:
                skipped += 1
            else:
                computed += 1
        except Exception as exc:
            logger.warning("signals: failed for %s: %s", sec.ticker, exc)
            failed += 1

    db.commit()
    return {"computed": computed, "skipped": skipped, "failed": failed, "total": len(securities)}


def refresh_fundamentals_for_security(db: Session, security_id: int) -> Optional[dict]:
    """
    Fetch Yahoo Finance fundamentals for one security and upsert into
    security_fundamentals.  Returns the stored dict or None if unavailable.
    """
    import math as _math
    import yfinance as yf
    from app.models.master import Security, SecurityFundamentals
    from app.models.prices import MarketPrice
    from app.services.price_service import _yahoo_candidates

    sec = db.get(Security, security_id)
    if not sec or sec.is_option:
        return None

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    candidates = _yahoo_candidates(sec, mp.fetch_ticker if mp else None)
    if not candidates:
        return None

    raw: dict = {}
    for sym in candidates:
        try:
            raw = yf.Ticker(sym).info or {}
            if raw and raw.get("quoteType") != "NONE":
                break
        except Exception:
            continue

    if not raw:
        return None

    def _f(key) -> Optional[float]:
        v = raw.get(key)
        if v is None:
            return None
        try:
            f = float(v)
            return None if (_math.isnan(f) or _math.isinf(f)) else f
        except (TypeError, ValueError):
            return None

    data = {
        "market_cap":             _f("marketCap"),
        "enterprise_value":       _f("enterpriseValue"),
        "pe_ratio":               _f("trailingPE"),
        "forward_pe":             _f("forwardPE"),
        "peg_ratio":              _f("pegRatio"),
        "price_to_book":          _f("priceToBook"),
        "price_to_sales":         _f("priceToSalesTrailing12Months"),
        "ev_to_ebitda":           _f("enterpriseToEbitda"),
        "eps":                    _f("trailingEps"),
        "forward_eps":            _f("forwardEps"),
        "dividend_yield":         _f("dividendYield"),
        "dividend_rate":          _f("dividendRate"),
        "payout_ratio":           _f("payoutRatio"),
        "total_revenue":          _f("totalRevenue"),
        "ebitda":                 _f("ebitda"),
        "net_income":             _f("netIncomeToCommon"),
        "free_cashflow":          _f("freeCashflow"),
        "operating_cashflow":     _f("operatingCashflow"),
        "total_debt":             _f("totalDebt"),
        "total_cash":             _f("totalCash"),
        "profit_margin":          _f("profitMargins"),
        "gross_margin":           _f("grossMargins"),
        "operating_margin":       _f("operatingMargins"),
        "revenue_growth":         _f("revenueGrowth"),
        "earnings_growth":        _f("earningsGrowth"),
        "return_on_equity":       _f("returnOnEquity"),
        "return_on_assets":       _f("returnOnAssets"),
        "debt_to_equity":         _f("debtToEquity"),
        "current_ratio":          _f("currentRatio"),
        "beta":                   _f("beta"),
        "shares_outstanding":     _f("sharesOutstanding"),
        "float_shares":           _f("floatShares"),
        "short_ratio":            _f("shortRatio"),
        "fifty_two_week_high":    _f("fiftyTwoWeekHigh"),
        "fifty_two_week_low":     _f("fiftyTwoWeekLow"),
        "fifty_day_avg":          _f("fiftyDayAverage"),
        "two_hundred_day_avg":    _f("twoHundredDayAverage"),
        "avg_volume":             _f("averageVolume"),
        "analyst_target_price":   _f("targetMeanPrice"),
        "analyst_recommendation": raw.get("recommendationKey"),
        "analyst_count":          int(_f("numberOfAnalystOpinions") or 0) or None,
        "website":                raw.get("website"),
        "employees":              int(_f("fullTimeEmployees") or 0) or None,
        "fetched_at":             datetime.utcnow(),
        "source":                 "yahoo",
    }

    # Also keep MarketPrice.beta / dividend_yield / market_cap in sync
    if mp:
        if data["beta"] is not None:
            mp.beta = data["beta"]
        if data["dividend_yield"] is not None:
            mp.dividend_yield = data["dividend_yield"]
        if data["market_cap"] is not None:
            mp.market_cap = data["market_cap"]

    existing = (
        db.query(SecurityFundamentals)
        .filter(SecurityFundamentals.security_id == security_id)
        .first()
    )
    if existing is None:
        existing = SecurityFundamentals(security_id=security_id)
        db.add(existing)

    for k, v in data.items():
        setattr(existing, k, v)

    db.flush()
    return data


def refresh_fundamentals_all(db: Session, security_ids: Optional[list[int]] = None) -> dict:
    """Refresh Yahoo fundamentals for all (or a subset of) non-option securities."""
    from app.models.master import Security

    q = db.query(Security).filter(Security.is_option == False)  # noqa: E712
    if security_ids:
        q = q.filter(Security.id.in_(security_ids))
    securities = q.all()

    fetched = skipped = failed = 0
    for sec in securities:
        try:
            result = refresh_fundamentals_for_security(db, sec.id)
            if result is None:
                skipped += 1
            else:
                fetched += 1
        except Exception as exc:
            logger.warning("fundamentals: failed for %s: %s", sec.ticker, exc)
            failed += 1
        finally:
            db.commit()

    return {"fetched": fetched, "skipped": skipped, "failed": failed, "total": len(securities)}
