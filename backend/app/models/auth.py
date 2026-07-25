from datetime import datetime
from typing import Optional
from sqlalchemy import String, Integer, Boolean, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(200), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="admin")  # admin | viewer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Per-account preference (was previously a per-browser localStorage-only setting, which
    # silently reset/desynced across devices and browser profiles with no visible warning).
    refresh_prices_on_login: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Daily email digest when a covered-call leg is within the DTE warning window or has
    # gone ITM (assignment risk) — see app/scheduler.py's covered-call check job.
    notify_covered_call_alerts: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
