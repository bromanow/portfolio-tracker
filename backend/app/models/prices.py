"""
Market price cache model.
Stores the most recent fetched price per security, plus a historical price table.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from sqlalchemy import Date, DateTime, Integer, Numeric, String, UniqueConstraint, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

__all__ = ["MarketPrice", "HistoricalPrice", "StockSplit"]


class MarketPrice(Base):
    __tablename__ = "market_prices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # One row per security — use UPSERT to keep only the latest price
    security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id", ondelete="CASCADE"), nullable=False)

    # Price in the security's native trading currency (e.g. CAD for TSX, USD for NYSE)
    price: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="CAD")

    # Price converted to CAD (using the BOC rate at fetch time)
    price_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)

    # Intraday / daily metadata
    prev_close: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    day_high: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    day_low: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    week52_high: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    week52_low: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    day_change: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)    # price - prev_close
    day_change_pct: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 4), nullable=True)

    # When and where the price was fetched
    price_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)       # trading date
    fetched_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # UTC timestamp
    fetch_ticker: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)   # e.g. "ENB.TO"
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="yahoo")

    # Fundamental metrics (refreshed separately via /api/prices/refresh-fundamentals)
    beta: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    dividend_yield: Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)  # e.g. 0.035 = 3.5%
    market_cap: Mapped[Optional[float]] = mapped_column(Numeric(20, 2), nullable=True)

    __table_args__ = (
        UniqueConstraint("security_id", name="uq_market_price_security"),
    )

    security: Mapped["Security"] = relationship("Security", back_populates="market_price")  # type: ignore[name-defined]


class HistoricalPrice(Base):
    """Daily closing price history per security."""
    __tablename__ = "historical_prices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id", ondelete="CASCADE"), nullable=False, index=True)
    price_date: Mapped[date] = mapped_column(Date, nullable=False)
    close_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="CAD")
    close_price_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    fetch_ticker: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="yahoo")

    __table_args__ = (
        UniqueConstraint("security_id", "price_date", name="uq_hist_price_sec_date"),
    )

    security: Mapped["Security"] = relationship("Security")  # type: ignore[name-defined]


class StockSplit(Base):
    """Stock split history fetched from Yahoo Finance."""
    __tablename__ = "stock_splits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id", ondelete="CASCADE"), nullable=False, index=True)
    split_date: Mapped[date] = mapped_column(Date, nullable=False)
    split_ratio: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False)  # e.g. 2.0 for 2:1 split
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="yahoo")

    __table_args__ = (
        UniqueConstraint("security_id", "split_date", name="uq_stock_split_sec_date"),
    )
