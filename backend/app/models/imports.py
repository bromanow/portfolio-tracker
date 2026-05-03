from datetime import date, datetime
from typing import Optional
from sqlalchemy import String, Integer, Boolean, Date, DateTime, ForeignKey, JSON, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    brokerage_id: Mapped[int] = mapped_column(Integer, ForeignKey("brokerages.id"), nullable=False)
    account_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("accounts.id"), nullable=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    import_date: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    imported_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="PENDING")  # PENDING/COMMITTED/REJECTED

    brokerage: Mapped["Brokerage"] = relationship("Brokerage")  # type: ignore
    account: Mapped[Optional["Account"]] = relationship("Account")  # type: ignore
    raw_transactions: Mapped[list["RawTransaction"]] = relationship("RawTransaction", back_populates="import_batch")


class RawTransaction(Base):
    __tablename__ = "raw_transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    import_batch_id: Mapped[int] = mapped_column(Integer, ForeignKey("import_batches.id"), nullable=False)
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_data: Mapped[dict] = mapped_column(JSON, nullable=False)
    parsed_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="PENDING")  # PENDING/IMPORTED/ERROR/SKIPPED
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    transaction_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("transactions.id"), nullable=True)

    import_batch: Mapped["ImportBatch"] = relationship("ImportBatch", back_populates="raw_transactions")
    transaction: Mapped[Optional["Transaction"]] = relationship("Transaction", back_populates="raw_import", foreign_keys=[transaction_id])  # type: ignore


from app.models.master import Brokerage, Account  # noqa: E402
from app.models.transactions import Transaction  # noqa: E402
