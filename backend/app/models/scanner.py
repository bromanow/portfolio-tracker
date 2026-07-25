from datetime import datetime
from typing import Optional
from sqlalchemy import String, Text, DateTime, Integer
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class ScannerWatchlist(Base):
    """Extra user-added candidate tickers, folded into the Covered Call Portfolio Builder's
    candidate universe (app/data/covered_call_universe.py) alongside the curated CA/US lists.
    The scan-and-persist "ScannerResult" table/feature this used to feed has been retired in
    favour of the Portfolio Builder (app/services/covered_call_portfolio_service.py), which
    reuses the same scoring engine (covered_call_service.py's scan_tickers/_score) directly."""
    __tablename__ = "scanner_watchlist"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)
    company_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
