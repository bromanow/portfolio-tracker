from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from sqlalchemy import String, Integer, Boolean, Numeric, Date, DateTime, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"), nullable=False)
    security_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("securities.id"), nullable=True)

    transaction_date: Mapped[date] = mapped_column(Date, nullable=False)
    settlement_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    transaction_type: Mapped[str] = mapped_column(String(30), nullable=False)

    quantity: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    price: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    commission: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)

    transaction_currency: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    transaction_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    account_currency_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    cad_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)

    fx_rate_to_account: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    fx_rate_to_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)

    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    tags: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    raw_import_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("raw_transactions.id"), nullable=True)
    raw_description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # External reference for deduplication (e.g. IBKR trade ID)
    external_ref: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, index=True)

    is_manual_override: Mapped[bool] = mapped_column(Boolean, default=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    account: Mapped["Account"] = relationship("Account", back_populates="transactions")  # type: ignore
    security: Mapped[Optional["Security"]] = relationship("Security", back_populates="transactions")  # type: ignore
    raw_import: Mapped[Optional["RawTransaction"]] = relationship("RawTransaction", back_populates="transaction", foreign_keys="[RawTransaction.transaction_id]")  # type: ignore
    option_legs: Mapped[list["OptionStrategyLeg"]] = relationship("OptionStrategyLeg", back_populates="transaction")  # type: ignore


from app.models.imports import RawTransaction  # noqa: E402
from app.models.options import OptionStrategyLeg  # noqa: E402
from app.models.master import Account, Security  # noqa: E402
