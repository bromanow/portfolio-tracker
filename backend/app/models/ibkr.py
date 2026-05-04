from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, Text, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class IBKRFlexConfig(Base):
    """Stores one Flex Query config per IBKR account."""
    __tablename__ = "ibkr_flex_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"), unique=True, nullable=False)
    query_id: Mapped[str] = mapped_column(String(50), nullable=False)
    token: Mapped[str] = mapped_column(String(128), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Last sync metadata
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_sync_status: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)   # ok | error | running
    last_sync_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    last_sync_imported: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    account: Mapped["Account"] = relationship("Account")  # type: ignore


from app.models.master import Account  # noqa: E402
