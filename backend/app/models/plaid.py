"""Plaid integration models.

A PlaidItem is one connected institution login (Plaid "Item"); it holds the
long-lived access_token. A PlaidAccount maps a Plaid investment account to one
of our Account rows so syncs are idempotent.

NOTE: access_token is a production secret. In Sandbox it's harmless, but before
going live it should be encrypted at rest (e.g. Fernet with a key from env).
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import String, Integer, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PlaidItem(Base):
    __tablename__ = "plaid_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    item_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    access_token: Mapped[str] = mapped_column(String(255), nullable=False)
    institution_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    institution_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PlaidAccount(Base):
    __tablename__ = "plaid_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    plaid_item_id: Mapped[int] = mapped_column(Integer, ForeignKey("plaid_items.id", ondelete="CASCADE"), nullable=False)
    plaid_account_id: Mapped[str] = mapped_column(String(100), nullable=False)
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"), nullable=False)

    __table_args__ = (UniqueConstraint("plaid_account_id", name="uq_plaid_account"),)


class PlaidSecurity(Base):
    """Maps Plaid's immutable security_id to our Security so the sync keeps matching
    even after a user renames the ticker/name of a synced fund."""
    __tablename__ = "plaid_securities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    plaid_security_id: Mapped[str] = mapped_column(String(100), nullable=False)
    security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (UniqueConstraint("plaid_security_id", name="uq_plaid_security"),)
