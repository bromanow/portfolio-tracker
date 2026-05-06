from datetime import date, datetime
from typing import Optional
from sqlalchemy import String, Integer, Boolean, Numeric, Date, DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class ScannerWatchlist(Base):
    """User-managed list of tickers to include in the covered-call scanner."""
    __tablename__ = "scanner_watchlist"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    company_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ScannerResult(Base):
    """One row per covered-call opportunity found in a scan run."""
    __tablename__ = "scanner_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Which scan produced this row
    scan_run_id: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    scanned_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # Underlying
    ticker: Mapped[str] = mapped_column(String(20), nullable=False)
    company_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    current_price: Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    avg_stock_volume: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)

    # Option contract
    strike: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    dte: Mapped[int] = mapped_column(Integer, nullable=False)
    bid: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    ask: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    mid: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    volume: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    open_interest: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Analytics
    iv_pct: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)      # annualised IV %
    hv_30_pct: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)   # 30d HV %
    iv_hv_ratio: Mapped[Optional[float]] = mapped_column(Numeric(6, 3), nullable=True)
    otm_pct: Mapped[Optional[float]] = mapped_column(Numeric(7, 2), nullable=True)     # (strike/price - 1) × 100
    annual_yield_pct: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    max_return_pct: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    breakeven: Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    score: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)

    # Greeks (Phase 2 — populated from IBKR live data)
    delta: Mapped[Optional[float]] = mapped_column(Numeric(6, 4), nullable=True)       # call delta 0–1
    gamma: Mapped[Optional[float]] = mapped_column(Numeric(8, 6), nullable=True)
    theta: Mapped[Optional[float]] = mapped_column(Numeric(8, 4), nullable=True)       # daily decay $
    vega: Mapped[Optional[float]] = mapped_column(Numeric(8, 4), nullable=True)
    bid_ask_spread_pct: Mapped[Optional[float]] = mapped_column(Numeric(6, 1), nullable=True)  # (ask-bid)/ask %
    data_source: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)      # 'ibkr_live' | 'yfinance'
    recommendation: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)   # Best/Good/Fair/Avoid

    # Underlying fundamentals
    dividend_yield: Mapped[Optional[float]] = mapped_column(Numeric(6, 2), nullable=True)  # annual div yield %

    # Portfolio context
    in_portfolio: Mapped[bool] = mapped_column(Boolean, default=False)
    portfolio_qty: Mapped[int] = mapped_column(Integer, default=0)
    portfolio_contracts: Mapped[int] = mapped_column(Integer, default=0)  # floor(qty / 100)
