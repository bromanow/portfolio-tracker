from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.master import Security
from app.models.transactions import Transaction

router = APIRouter(prefix="/api/securities", tags=["securities"])


class SecurityCreate(BaseModel):
    ticker: str
    exchange: Optional[str] = None
    name: Optional[str] = None
    asset_class: str = "EQUITY"
    sector_gics: Optional[str] = None
    industry_gics: Optional[str] = None
    country: Optional[str] = None
    currency: Optional[str] = None
    is_option: bool = False


class SecurityUpdate(BaseModel):
    ticker: Optional[str] = None
    name: Optional[str] = None
    exchange: Optional[str] = None
    asset_class: Optional[str] = None
    sector_gics: Optional[str] = None
    industry_gics: Optional[str] = None
    country: Optional[str] = None
    currency: Optional[str] = None
    fetch_ticker_override: Optional[str] = None
    description: Optional[str] = None


def security_to_dict(s: Security, transaction_count: int = 0) -> dict:
    return {
        "id": s.id,
        "ticker": s.ticker,
        "exchange": s.exchange,
        "name": s.name,
        "asset_class": s.asset_class,
        "sector_gics": s.sector_gics,
        "industry_gics": s.industry_gics,
        "country": s.country,
        "currency": s.currency,
        "is_option": s.is_option,
        "transaction_count": transaction_count,
        "fetch_ticker_override": s.fetch_ticker_override,
        "description": s.description,
    }


@router.get("")
def list_securities(
    search: Optional[str] = Query(None),
    asset_class: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    # Sub-query: count transactions per security
    txn_counts = (
        db.query(Transaction.security_id, func.count(Transaction.id).label("cnt"))
        .group_by(Transaction.security_id)
        .subquery()
    )
    query = (
        db.query(Security, func.coalesce(txn_counts.c.cnt, 0).label("txn_count"))
        .outerjoin(txn_counts, Security.id == txn_counts.c.security_id)
    )
    if search:
        query = query.filter(Security.ticker.ilike(f"%{search}%"))
    if asset_class:
        query = query.filter(Security.asset_class == asset_class)
    rows = query.order_by(Security.ticker).all()
    return [security_to_dict(s, int(cnt)) for s, cnt in rows]


@router.post("", status_code=201)
def create_security(data: SecurityCreate, db: Session = Depends(get_db)):
    sec = Security(**data.model_dump())
    db.add(sec)
    db.commit()
    db.refresh(sec)
    return security_to_dict(sec)


class FetchYahooOptions(BaseModel):
    yahoo_symbol: Optional[str] = None


# Currency inferred from canonical exchange name (avoids per-ticker API calls in search)
_EXCHANGE_CURRENCY: dict[str, str] = {
    "NYSE": "USD", "NASDAQ": "USD", "AMEX": "USD", "ARCA": "USD", "CBOE": "USD",
    "TSX": "CAD", "TSX-V": "CAD",
    "LSE": "GBP",
    "GER": "EUR", "XETRA": "EUR",
}


@router.get("/yahoo-search")
def yahoo_search_securities(q: str = Query(..., min_length=1)):
    """Search Yahoo Finance for securities matching a query (ticker or name).

    Returns up to 10 candidates with symbol, name, exchange, currency, and quote_type.
    Used to power the Yahoo security picker in the Admin UI.
    """
    import yfinance as yf
    from app.services.price_service import YAHOO_EXCHANGE_MAP

    try:
        s = yf.Search(q, max_results=10)
        quotes = s.quotes or []
    except Exception:
        return []

    results = []
    for quote in quotes:
        symbol = quote.get("symbol", "")
        name = quote.get("shortname") or quote.get("longname") or ""
        yexch = quote.get("exchange", "")
        qt = (quote.get("quoteType") or "EQUITY").upper()
        exch = YAHOO_EXCHANGE_MAP.get(yexch, yexch.upper() if yexch else "")
        ccy = _EXCHANGE_CURRENCY.get(exch, "USD")
        results.append({
            "symbol": symbol,
            "name": name,
            "exchange": exch,
            "currency": ccy,
            "quote_type": qt,
        })
    return results


@router.get("/{security_id}")
def get_security(security_id: int, db: Session = Depends(get_db)):
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")
    return security_to_dict(sec)


@router.put("/{security_id}")
def update_security(security_id: int, data: SecurityUpdate, db: Session = Depends(get_db)):
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(sec, field, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        detail = str(exc.orig) if exc.orig else str(exc)
        if "uq_security_ticker_exchange" in detail or "UNIQUE" in detail.upper():
            raise HTTPException(
                status_code=409,
                detail=f"A security with that ticker/exchange combination already exists.",
            )
        raise HTTPException(status_code=409, detail=f"Database constraint violation: {detail}")
    db.refresh(sec)
    return security_to_dict(sec)


def _apply_yahoo_info(sec, info: dict, db) -> dict:
    """Apply a Yahoo info dict to a Security record and return a dict of what changed."""
    from app.models.prices import MarketPrice
    updated = {}
    if info.get("name"):
        sec.name = info["name"]; updated["name"] = info["name"]
    exchange_changed = info.get("exchange") and info["exchange"] != sec.exchange
    if info.get("exchange"):
        sec.exchange = info["exchange"]; updated["exchange"] = info["exchange"]
    if info.get("currency"):
        sec.currency = info["currency"]; updated["currency"] = info["currency"]
    if info.get("sector"):
        sec.sector_gics = info["sector"]; updated["sector"] = info["sector"]
    if info.get("industry"):
        sec.industry_gics = info["industry"]; updated["industry"] = info["industry"]
    if info.get("country"):
        sec.country = info["country"]; updated["country"] = info["country"]
    if info.get("description"):
        sec.description = info["description"]; updated["description"] = "✓ (long text)"
    # Persist fetch_ticker to an existing MarketPrice row only — never create a
    # new row here because price is NOT NULL and we don't have a price yet.
    # The fetch_ticker will be written when the next price refresh runs.
    if info.get("fetch_ticker"):
        mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
        if mp is not None:
            mp.fetch_ticker = info["fetch_ticker"]
            updated["fetch_ticker"] = info["fetch_ticker"]
    elif exchange_changed:
        # Exchange changed but no explicit fetch_ticker — clear the cached one
        mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
        if mp:
            mp.fetch_ticker = None
            updated["cache_cleared"] = "✓"
    return updated


@router.post("/{security_id}/fetch-yahoo-info")
def fetch_security_yahoo_info(
    security_id: int,
    opts: Optional[FetchYahooOptions] = None,
    db: Session = Depends(get_db),
):
    """Fetch company metadata from Yahoo Finance and update the security record.

    If opts.yahoo_symbol is provided, that exact Yahoo ticker is used (e.g. user
    picked a specific result from the search popup).  Otherwise the normal
    ticker-resolution heuristics are applied.
    """
    import yfinance as yf
    from app.services.price_service import fetch_security_info, YAHOO_EXCHANGE_MAP
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    yahoo_symbol = (opts.yahoo_symbol.strip() if opts and opts.yahoo_symbol else None)

    if yahoo_symbol:
        # User selected a specific ticker from the search popup — fetch directly
        try:
            t = yf.Ticker(yahoo_symbol)
            raw = t.info or {}
        except Exception as exc:
            return {"success": False, "message": f"Yahoo Finance error for {yahoo_symbol}: {exc}"}
        if not raw or raw.get("quoteType") == "NONE":
            return {"success": False, "message": f"No data found for {yahoo_symbol} on Yahoo Finance"}
        yahoo_exch = raw.get("exchange") or raw.get("fullExchangeName") or ""
        exch = YAHOO_EXCHANGE_MAP.get(yahoo_exch, yahoo_exch.upper() if yahoo_exch else None)
        info = {
            "fetch_ticker": yahoo_symbol,
            "name": raw.get("longName") or raw.get("shortName"),
            "exchange": exch,
            "currency": (raw.get("currency") or "").upper() or None,
            "sector": raw.get("sector"),
            "industry": raw.get("industry"),
            "country": raw.get("country"),
            "description": raw.get("longBusinessSummary"),
        }
    else:
        info = fetch_security_info(sec)
        if info is None:
            return {"success": False, "message": f"Could not fetch info for {sec.ticker} from Yahoo Finance"}

    updated = _apply_yahoo_info(sec, info, db)
    db.commit()
    db.refresh(sec)
    return {"success": True, "fetch_ticker": info.get("fetch_ticker"), "updated": updated, "security": security_to_dict(sec)}


@router.get("/{security_id}/yahoo-detail")
def get_security_yahoo_detail(security_id: int, db: Session = Depends(get_db)):
    """Fetch live company and market data from Yahoo Finance for a security."""
    import math
    import yfinance as yf
    from app.services.price_service import _yahoo_candidates
    from app.models.prices import MarketPrice

    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    candidates = _yahoo_candidates(sec, mp.fetch_ticker if mp else None)
    if not candidates:
        return {"available": False, "reason": "No Yahoo ticker available"}

    sym = candidates[0]
    try:
        info = yf.Ticker(sym).info or {}
        if not info or info.get("quoteType") == "NONE":
            return {"available": False, "reason": f"No data found for {sym}"}
    except Exception as exc:
        return {"available": False, "reason": str(exc)}

    def _v(key):
        v = info.get(key)
        if v is None:
            return None
        try:
            f = float(v)
            if math.isnan(f) or math.isinf(f):
                return None
            return f if f != int(f) else int(f)
        except (TypeError, ValueError):
            return v

    return {
        "available": True,
        "symbol": sym,
        "market_cap": _v("marketCap"),
        "enterprise_value": _v("enterpriseValue"),
        "shares_outstanding": _v("sharesOutstanding"),
        "float_shares": _v("floatShares"),
        "beta": _v("beta"),
        "fifty_two_week_high": _v("fiftyTwoWeekHigh"),
        "fifty_two_week_low": _v("fiftyTwoWeekLow"),
        "fifty_day_avg": _v("fiftyDayAverage"),
        "two_hundred_day_avg": _v("twoHundredDayAverage"),
        "volume": _v("volume"),
        "avg_volume": _v("averageVolume"),
        "pe_ratio": _v("trailingPE"),
        "forward_pe": _v("forwardPE"),
        "peg_ratio": _v("pegRatio"),
        "price_to_book": _v("priceToBook"),
        "price_to_sales": _v("priceToSalesTrailing12Months"),
        "ev_to_ebitda": _v("enterpriseToEbitda"),
        "eps": _v("trailingEps"),
        "forward_eps": _v("forwardEps"),
        "dividend_yield": _v("dividendYield"),
        "dividend_rate": _v("dividendRate"),
        "payout_ratio": _v("payoutRatio"),
        "total_revenue": _v("totalRevenue"),
        "ebitda": _v("ebitda"),
        "net_income": _v("netIncomeToCommon"),
        "free_cashflow": _v("freeCashflow"),
        "operating_cashflow": _v("operatingCashflow"),
        "total_debt": _v("totalDebt"),
        "total_cash": _v("totalCash"),
        "profit_margins": _v("profitMargins"),
        "gross_margins": _v("grossMargins"),
        "operating_margins": _v("operatingMargins"),
        "revenue_growth": _v("revenueGrowth"),
        "earnings_growth": _v("earningsGrowth"),
        "return_on_equity": _v("returnOnEquity"),
        "return_on_assets": _v("returnOnAssets"),
        "debt_to_equity": _v("debtToEquity"),
        "current_ratio": _v("currentRatio"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "country": info.get("country"),
        "website": info.get("website"),
        "employees": _v("fullTimeEmployees"),
        "description": info.get("longBusinessSummary"),
        "currency": info.get("currency"),
    }


def _yahoo_thumbnail(content: dict) -> Optional[str]:
    thumb = content.get("thumbnail") or {}
    resolutions = thumb.get("resolutions") or []
    # Prefer a small non-original resolution (keeps the security card light); fall back to
    # the original image, else None (some stories — esp. wire-service text — have no image).
    small = [r for r in resolutions if r.get("tag") != "original" and r.get("url")]
    if small:
        return min(small, key=lambda r: r.get("width") or 9999).get("url")
    return thumb.get("originalUrl")


@router.get("/{security_id}/news")
def get_security_news(security_id: int, db: Session = Depends(get_db)):
    """Recent news for a security via Yahoo Finance (yfinance Ticker.news).
    Gracefully returns an empty list for securities Yahoo doesn't cover (options, some
    Canadian mutual funds/structured notes) rather than erroring."""
    import yfinance as yf
    from app.services.price_service import _yahoo_candidates
    from app.models.prices import MarketPrice

    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    candidates = _yahoo_candidates(sec, mp.fetch_ticker if mp else None)
    if not candidates:
        return {"symbol": None, "items": []}

    sym = candidates[0]
    try:
        raw = yf.Ticker(sym).news or []
    except Exception:
        return {"symbol": sym, "items": []}

    items = []
    for entry in raw:
        content = entry.get("content") or {}
        if not content.get("title"):
            continue
        url = (content.get("clickThroughUrl") or {}).get("url") or (content.get("canonicalUrl") or {}).get("url")
        if not url:
            continue
        items.append({
            "id": entry.get("id") or content.get("id"),
            "title": content.get("title"),
            "summary": content.get("summary") or content.get("description") or None,
            "published_at": content.get("pubDate") or content.get("displayTime"),
            "publisher": (content.get("provider") or {}).get("displayName"),
            "url": url,
            "thumbnail_url": _yahoo_thumbnail(content),
        })
    return {"symbol": sym, "items": items}


@router.get("/{security_id}/price-history")
def get_security_price_history(
    security_id: int,
    period: str = Query("1y"),
    db: Session = Depends(get_db),
):
    """Return historical daily close prices from the local database."""
    from datetime import timedelta
    from app.models.prices import HistoricalPrice

    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")

    period_days = {"1m": 30, "3m": 90, "6m": 180, "1y": 365, "3y": 1095}
    today = date.today()

    query = db.query(HistoricalPrice).filter(HistoricalPrice.security_id == security_id)
    if period in period_days:
        query = query.filter(HistoricalPrice.price_date >= today - timedelta(days=period_days[period]))

    rows = query.order_by(HistoricalPrice.price_date).all()
    return [
        {
            "date": hp.price_date.isoformat() if hasattr(hp.price_date, "isoformat") else str(hp.price_date),
            "close": float(hp.close_price) if hp.close_price is not None else None,
            "close_cad": float(hp.close_price_cad) if hp.close_price_cad is not None else None,
            "currency": hp.currency,
        }
        for hp in rows
        if hp.close_price is not None
    ]


def _fundamentals_to_dict(f) -> dict:
    """Serialise a SecurityFundamentals ORM row to a plain dict."""
    return {
        "market_cap":             float(f.market_cap) if f.market_cap is not None else None,
        "enterprise_value":       float(f.enterprise_value) if f.enterprise_value is not None else None,
        "pe_ratio":               float(f.pe_ratio) if f.pe_ratio is not None else None,
        "forward_pe":             float(f.forward_pe) if f.forward_pe is not None else None,
        "peg_ratio":              float(f.peg_ratio) if f.peg_ratio is not None else None,
        "price_to_book":          float(f.price_to_book) if f.price_to_book is not None else None,
        "price_to_sales":         float(f.price_to_sales) if f.price_to_sales is not None else None,
        "ev_to_ebitda":           float(f.ev_to_ebitda) if f.ev_to_ebitda is not None else None,
        "eps":                    float(f.eps) if f.eps is not None else None,
        "forward_eps":            float(f.forward_eps) if f.forward_eps is not None else None,
        "dividend_yield":         float(f.dividend_yield) if f.dividend_yield is not None else None,
        "dividend_rate":          float(f.dividend_rate) if f.dividend_rate is not None else None,
        "payout_ratio":           float(f.payout_ratio) if f.payout_ratio is not None else None,
        "total_revenue":          float(f.total_revenue) if f.total_revenue is not None else None,
        "ebitda":                 float(f.ebitda) if f.ebitda is not None else None,
        "net_income":             float(f.net_income) if f.net_income is not None else None,
        "free_cashflow":          float(f.free_cashflow) if f.free_cashflow is not None else None,
        "operating_cashflow":     float(f.operating_cashflow) if f.operating_cashflow is not None else None,
        "total_debt":             float(f.total_debt) if f.total_debt is not None else None,
        "total_cash":             float(f.total_cash) if f.total_cash is not None else None,
        "profit_margin":          float(f.profit_margin) if f.profit_margin is not None else None,
        "gross_margin":           float(f.gross_margin) if f.gross_margin is not None else None,
        "operating_margin":       float(f.operating_margin) if f.operating_margin is not None else None,
        "revenue_growth":         float(f.revenue_growth) if f.revenue_growth is not None else None,
        "earnings_growth":        float(f.earnings_growth) if f.earnings_growth is not None else None,
        "return_on_equity":       float(f.return_on_equity) if f.return_on_equity is not None else None,
        "return_on_assets":       float(f.return_on_assets) if f.return_on_assets is not None else None,
        "debt_to_equity":         float(f.debt_to_equity) if f.debt_to_equity is not None else None,
        "current_ratio":          float(f.current_ratio) if f.current_ratio is not None else None,
        "beta":                   float(f.beta) if f.beta is not None else None,
        "shares_outstanding":     float(f.shares_outstanding) if f.shares_outstanding is not None else None,
        "float_shares":           float(f.float_shares) if f.float_shares is not None else None,
        "short_ratio":            float(f.short_ratio) if f.short_ratio is not None else None,
        "fifty_two_week_high":    float(f.fifty_two_week_high) if f.fifty_two_week_high is not None else None,
        "fifty_two_week_low":     float(f.fifty_two_week_low) if f.fifty_two_week_low is not None else None,
        "fifty_day_avg":          float(f.fifty_day_avg) if f.fifty_day_avg is not None else None,
        "two_hundred_day_avg":    float(f.two_hundred_day_avg) if f.two_hundred_day_avg is not None else None,
        "avg_volume":             float(f.avg_volume) if f.avg_volume is not None else None,
        "analyst_target_price":   float(f.analyst_target_price) if f.analyst_target_price is not None else None,
        "analyst_recommendation": f.analyst_recommendation,
        "analyst_count":          f.analyst_count,
        "website":                f.website,
        "employees":              f.employees,
        "fetched_at":             f.fetched_at.isoformat() if f.fetched_at else None,
        "source":                 f.source,
    }


def _signals_to_dict(s) -> dict:
    """Serialise a SecuritySignals ORM row to a plain dict."""
    return {
        "as_of_date":     s.as_of_date.isoformat() if s.as_of_date else None,
        "ma_50d":         float(s.ma_50d) if s.ma_50d is not None else None,
        "ma_200d":        float(s.ma_200d) if s.ma_200d is not None else None,
        "price_vs_50d":   float(s.price_vs_50d) if s.price_vs_50d is not None else None,
        "price_vs_200d":  float(s.price_vs_200d) if s.price_vs_200d is not None else None,
        "golden_cross":   s.golden_cross,
        "return_1m":      float(s.return_1m) if s.return_1m is not None else None,
        "return_3m":      float(s.return_3m) if s.return_3m is not None else None,
        "return_6m":      float(s.return_6m) if s.return_6m is not None else None,
        "return_12m":     float(s.return_12m) if s.return_12m is not None else None,
        "momentum_12_1":  float(s.momentum_12_1) if s.momentum_12_1 is not None else None,
        "rsi_14":         float(s.rsi_14) if s.rsi_14 is not None else None,
        "volatility_20d": float(s.volatility_20d) if s.volatility_20d is not None else None,
        "volatility_60d": float(s.volatility_60d) if s.volatility_60d is not None else None,
        "computed_at":    s.computed_at.isoformat() if s.computed_at else None,
    }


@router.get("/{security_id}/fundamentals")
def get_security_fundamentals(security_id: int, db: Session = Depends(get_db)):
    """Return the stored fundamental data for a security (from security_fundamentals table)."""
    from app.models.master import SecurityFundamentals
    f = db.query(SecurityFundamentals).filter(SecurityFundamentals.security_id == security_id).first()
    if f is None:
        return {"available": False, "reason": "No stored fundamentals — run a refresh first."}
    return {"available": True, **_fundamentals_to_dict(f)}


@router.post("/{security_id}/refresh-fundamentals")
def refresh_security_fundamentals(security_id: int, db: Session = Depends(get_db)):
    """Fetch and store Yahoo fundamentals for a single security."""
    from app.services.signals_service import refresh_fundamentals_for_security
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")
    result = refresh_fundamentals_for_security(db, security_id)
    db.commit()
    if result is None:
        return {"success": False, "message": "Could not fetch fundamentals (no Yahoo ticker or no data)."}
    return {"success": True, "fetched_at": result.get("fetched_at", "").isoformat() if result.get("fetched_at") else None}


@router.get("/{security_id}/signals")
def get_security_signals(security_id: int, db: Session = Depends(get_db)):
    """Return computed technical signals for a security (from security_signals table)."""
    from app.models.master import SecuritySignals
    s = db.query(SecuritySignals).filter(SecuritySignals.security_id == security_id).first()
    if s is None:
        return {"available": False, "reason": "No signals computed yet."}
    return {"available": True, **_signals_to_dict(s)}


@router.post("/{security_id}/compute-signals")
def compute_security_signals_endpoint(security_id: int, db: Session = Depends(get_db)):
    """Compute and store technical signals for a single security from its price history."""
    from app.services.signals_service import compute_signals_for_security
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")
    result = compute_signals_for_security(db, security_id)
    db.commit()
    if result is None:
        return {"success": False, "message": "Insufficient price history to compute signals."}
    return {"success": True, "as_of_date": result.get("as_of_date", "").isoformat() if result.get("as_of_date") else None}


@router.get("/bulk/fundamentals-signals")
def get_bulk_fundamentals_signals(
    security_ids: str = Query(..., description="Comma-separated security IDs"),
    db: Session = Depends(get_db),
):
    """
    Return stored fundamentals and signals for multiple securities in one request.
    Used by the Holdings Fundamentals and Signals tabs to populate the comparison table.
    Response: { security_id: { fundamentals: {...} | null, signals: {...} | null } }
    """
    from app.models.master import SecurityFundamentals, SecuritySignals

    ids = [int(x.strip()) for x in security_ids.split(",") if x.strip().isdigit()]
    if not ids:
        return {}

    fund_map = {
        f.security_id: _fundamentals_to_dict(f)
        for f in db.query(SecurityFundamentals).filter(SecurityFundamentals.security_id.in_(ids)).all()
    }
    sig_map = {
        s.security_id: _signals_to_dict(s)
        for s in db.query(SecuritySignals).filter(SecuritySignals.security_id.in_(ids)).all()
    }

    return {
        str(sec_id): {
            "fundamentals": fund_map.get(sec_id),
            "signals":      sig_map.get(sec_id),
        }
        for sec_id in ids
    }


# ─── Per-(security, account) transaction-type overrides ──────────────────────
# See SecurityAccountTypeOverride (app/models/master.py) and the before_flush guard in
# app/database.py for the full rationale — forward-looking reclassification (e.g. a fund's
# passive reinvestment importing as DIVIDEND when it should be DRIP for one specific account).

class TypeOverrideCreate(BaseModel):
    account_id: int
    from_type: str
    to_type: str


@router.get("/{security_id}/type-overrides")
def list_type_overrides(security_id: int, db: Session = Depends(get_db)):
    from app.models.master import SecurityAccountTypeOverride, Account
    rows = (
        db.query(SecurityAccountTypeOverride, Account.name)
        .join(Account, Account.id == SecurityAccountTypeOverride.account_id)
        .filter(SecurityAccountTypeOverride.security_id == security_id)
        .order_by(Account.name)
        .all()
    )
    return [
        {
            "id": r.id, "security_id": r.security_id, "account_id": r.account_id,
            "account_name": name, "from_type": r.from_type, "to_type": r.to_type,
        }
        for r, name in rows
    ]


@router.post("/{security_id}/type-overrides", status_code=201)
def create_type_override(security_id: int, body: TypeOverrideCreate, db: Session = Depends(get_db)):
    from app.models.master import SecurityAccountTypeOverride
    sec = db.get(Security, security_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Security not found")
    if body.from_type == body.to_type:
        raise HTTPException(status_code=400, detail="from_type and to_type must differ")
    existing = (
        db.query(SecurityAccountTypeOverride)
        .filter(
            SecurityAccountTypeOverride.security_id == security_id,
            SecurityAccountTypeOverride.account_id == body.account_id,
            SecurityAccountTypeOverride.from_type == body.from_type,
        )
        .first()
    )
    if existing:
        existing.to_type = body.to_type
        db.commit()
        return {"id": existing.id, "updated": True}
    row = SecurityAccountTypeOverride(
        security_id=security_id, account_id=body.account_id,
        from_type=body.from_type, to_type=body.to_type,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": row.id, "updated": False}


@router.delete("/type-overrides/{override_id}")
def delete_type_override(override_id: int, db: Session = Depends(get_db)):
    from app.models.master import SecurityAccountTypeOverride
    row = db.get(SecurityAccountTypeOverride, override_id)
    if not row:
        raise HTTPException(status_code=404, detail="Override not found")
    db.delete(row)
    db.commit()
    return {"deleted": override_id}
