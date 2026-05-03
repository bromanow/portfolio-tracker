from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from sqlalchemy import String, Integer, Boolean, Numeric, Date, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class OptionContract(Base):
    __tablename__ = "option_contracts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id"), nullable=False)
    underlying_security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id"), nullable=False)
    option_type: Mapped[str] = mapped_column(String(4), nullable=False)  # CALL/PUT
    strike: Mapped[Decimal] = mapped_column(Numeric(20, 4), nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    multiplier: Mapped[int] = mapped_column(Integer, default=100)

    security: Mapped["Security"] = relationship("Security", foreign_keys=[security_id], back_populates="option_contract")  # type: ignore
    underlying_security: Mapped["Security"] = relationship("Security", foreign_keys=[underlying_security_id])  # type: ignore


class OptionStrategy(Base):
    __tablename__ = "option_strategies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    strategy_type: Mapped[str] = mapped_column(String(30), nullable=False)
    underlying_security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id"), nullable=False)
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"), nullable=False)
    opened_date: Mapped[date] = mapped_column(Date, nullable=False)
    closed_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="OPEN")  # OPEN/CLOSED/EXPIRED/ASSIGNED
    total_premium: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    underlying_security: Mapped["Security"] = relationship("Security", foreign_keys=[underlying_security_id])  # type: ignore
    account: Mapped["Account"] = relationship("Account")  # type: ignore
    legs: Mapped[list["OptionStrategyLeg"]] = relationship("OptionStrategyLeg", back_populates="strategy")


class OptionStrategyLeg(Base):
    __tablename__ = "option_strategy_legs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    strategy_id: Mapped[int] = mapped_column(Integer, ForeignKey("option_strategies.id"), nullable=False)
    transaction_id: Mapped[int] = mapped_column(Integer, ForeignKey("transactions.id"), nullable=False)

    strategy: Mapped["OptionStrategy"] = relationship("OptionStrategy", back_populates="legs")
    transaction: Mapped["Transaction"] = relationship("Transaction", back_populates="option_legs")  # type: ignore


from app.models.master import Security, Account  # noqa: E402
from app.models.transactions import Transaction  # noqa: E402
