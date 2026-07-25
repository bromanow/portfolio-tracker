"""
Covered-call portfolio builder & manager.

Two modes, one schema:
  SIMULATED — fully self-contained paper book. Shares/cost-basis/trades are all stored
              here and valued off the security's own MarketPrice. Never touches
              accounts/transactions, so it never needs excluding from Net Worth/Performance —
              there's nothing there to exclude.
  REAL      — the user actually trades the picks at their broker. These rows hold only
              strategy metadata (which picks were proposed, roll-chain grouping); the
              real share count / premium numbers are read from the linked account_id's
              real Transaction rows, not duplicated here.
"""
from datetime import date, datetime
from typing import Optional
from sqlalchemy import String, Integer, Numeric, Date, DateTime, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class CoveredCallPortfolio(Base):
    __tablename__ = "covered_call_portfolios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    mode: Mapped[str] = mapped_column(String(10), nullable=False)          # SIMULATED | REAL
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="PROPOSED")  # PROPOSED | ACTIVE | ARCHIVED

    # The target parameters used to generate the proposal (ScanParams-like), stored as JSON text
    # so the proposal is reproducible/inspectable later without a dedicated schema per field.
    target_params_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # REAL mode only — which real account these positions live/will-live in, so real Transaction
    # rows can be looked up by (account_id, security_id) rather than duplicating values here.
    account_id: Mapped[Optional[int]] = mapped_column(ForeignKey("accounts.id"), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CoveredCallHolding(Base):
    __tablename__ = "covered_call_holdings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    portfolio_id: Mapped[int] = mapped_column(ForeignKey("covered_call_portfolios.id"), nullable=False, index=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.id"), nullable=False)

    # SIMULATED: authoritative. REAL: left null; the real share count is derived live from
    # transactions (account_id, security_id) at read time instead.
    shares: Mapped[Optional[float]] = mapped_column(Numeric(14, 4), nullable=True)
    cost_basis_per_share: Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)

    status: Mapped[str] = mapped_column(String(10), nullable=False, default="ACTIVE")  # ACTIVE | CLOSED
    opened_at: Mapped[date] = mapped_column(Date, default=date.today)
    closed_at: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    # Score/why snapshot from the proposal that picked this name, so the rationale stays
    # visible even after prices/IV have since moved on.
    proposal_score: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    proposal_why: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class CoveredCallTrade(Base):
    __tablename__ = "covered_call_trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    holding_id: Mapped[int] = mapped_column(ForeignKey("covered_call_holdings.id"), nullable=False, index=True)

    trade_type: Mapped[str] = mapped_column(String(20), nullable=False)
    # SELL_TO_OPEN | BUY_TO_CLOSE | ASSIGNED | EXPIRED_WORTHLESS

    strike: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    contracts: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    premium_per_contract: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)

    trade_date: Mapped[date] = mapped_column(Date, default=date.today)

    # Links a closed leg to the leg that replaced it, so a series of rolls reads as one
    # continuous position rather than disconnected trades.
    roll_chain_id: Mapped[Optional[str]] = mapped_column(String(40), nullable=True, index=True)

    # REAL mode: once the real option transaction is imported, link it here instead of
    # re-entering the trade — strike/expiry/premium then read from the real Transaction row.
    real_transaction_id: Mapped[Optional[int]] = mapped_column(ForeignKey("transactions.id"), nullable=True)

    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
