from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from sqlalchemy import String, Integer, Boolean, Numeric, Date, DateTime, ForeignKey, UniqueConstraint, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base





class Brokerage(Base):
    __tablename__ = "brokerages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    advisor: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    accounts: Mapped[list["Account"]] = relationship("Account", back_populates="brokerage")
    type_mappings: Mapped[list["BrokerageTypeMapping"]] = relationship("BrokerageTypeMapping", back_populates="brokerage")


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    brokerage_id: Mapped[int] = mapped_column(Integer, ForeignKey("brokerages.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    account_number: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    account_type: Mapped[str] = mapped_column(String(20), nullable=False)  # RRSP/TFSA/RESP/NON_REG
    base_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    owner: Mapped[str] = mapped_column(String(50), nullable=False)
    client_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("clients.id"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    ibkr_alias: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # IB account alias from CSV
    returns_start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)  # user-set start date for return calculations

    brokerage: Mapped["Brokerage"] = relationship("Brokerage", back_populates="accounts")
    transactions: Mapped[list["Transaction"]] = relationship("Transaction", back_populates="account")  # type: ignore


class Security(Base):
    __tablename__ = "securities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String(200), nullable=False)
    exchange: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    asset_class: Mapped[str] = mapped_column(String(20), nullable=False, default="EQUITY")
    sector_gics: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    industry_gics: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    country: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)
    is_option: Mapped[bool] = mapped_column(Boolean, default=False)
    fetch_ticker_override: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    in_screener_universe: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (UniqueConstraint("ticker", "exchange", name="uq_security_ticker_exchange"),)

    option_contract: Mapped[Optional["OptionContract"]] = relationship("OptionContract", back_populates="security", foreign_keys="OptionContract.security_id", uselist=False)
    transactions: Mapped[list["Transaction"]] = relationship("Transaction", back_populates="security")  # type: ignore
    market_price: Mapped[Optional["MarketPrice"]] = relationship("MarketPrice", back_populates="security", uselist=False)  # type: ignore


class Currency(Base):
    __tablename__ = "currencies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(3), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(50), nullable=False)


class FXRate(Base):
    __tablename__ = "fx_rates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    rate_date: Mapped[date] = mapped_column(Date, nullable=False)
    from_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    to_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    source: Mapped[str] = mapped_column(String(50), default="BOC")

    __table_args__ = (UniqueConstraint("rate_date", "from_currency", "to_currency", name="uq_fx_rate"),)


class BrokerageTypeMapping(Base):
    __tablename__ = "brokerage_type_mappings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    brokerage_id: Mapped[int] = mapped_column(Integer, ForeignKey("brokerages.id"), nullable=False)
    raw_type: Mapped[str] = mapped_column(String(100), nullable=False)
    canonical_type: Mapped[str] = mapped_column(String(50), nullable=False)

    brokerage: Mapped["Brokerage"] = relationship("Brokerage", back_populates="type_mappings")

    __table_args__ = (UniqueConstraint("brokerage_id", "raw_type", name="uq_type_mapping"),)


class SecurityAccountTypeOverride(Base):
    """Per-(security, account) transaction-type reclassification, applied at import time.

    Unlike BrokerageTypeMapping (raw import string -> canonical type, whole-brokerage), this
    is for cases where the SAME canonical type means different things for a specific fund in a
    specific account — e.g. a Scotia Wealth Pender fund whose passive reinvestment sometimes
    imports as plain DIVIDEND instead of DRIP. Applied by a before_flush guard (see
    app/database.py) on every newly-inserted Transaction, so it covers every import path
    (CSV, IBKR Flex, Plaid, statements) without touching each parser. Forward-looking only —
    does not rewrite already-persisted rows; use the transaction edit UI for those.
    """
    __tablename__ = "security_account_type_overrides"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    security_id: Mapped[int] = mapped_column(Integer, ForeignKey("securities.id"), nullable=False)
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"), nullable=False)
    from_type: Mapped[str] = mapped_column(String(30), nullable=False)
    to_type: Mapped[str] = mapped_column(String(30), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("security_id", "account_id", "from_type", name="uq_sec_acct_type_override"),
    )


class PortfolioSnapshot(Base):
    """
    Pre-computed daily portfolio value per account.
    Populated by the compute-snapshots background job.
    One row per (snapshot_date, account_id).
    """
    __tablename__ = "portfolio_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    account_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    # Sum of (net_quantity × historical_close_price_cad) for all holdings
    market_value_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 2), nullable=True)
    # Cumulative net invested capital: +buys, −sells, +drip (in CAD)
    invested_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 2), nullable=True)
    # Cumulative income received: INTEREST + DIVIDEND + OPTION_SELL premiums + RETURN_OF_CAPITAL − FEE
    income_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 2), nullable=True)
    # Cash balance: sum of all cash-affecting transactions up to this date (in CAD)
    cash_balance_cad: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 2), nullable=True)
    # Data quality: fraction of position value that had a price on this date (0–1)
    priced_fraction: Mapped[Optional[float]] = mapped_column(Numeric(5, 4), nullable=True)

    __table_args__ = (
        UniqueConstraint("snapshot_date", "account_id", name="uq_portfolio_snapshot"),
    )


class SecurityFundamentals(Base):
    """
    Persisted snapshot of Yahoo Finance fundamental data for a security.
    One row per security (upserted on each refresh).  Staleness is tracked
    via fetched_at so the UI can show when data was last updated.
    """
    __tablename__ = "security_fundamentals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    security_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("securities.id", ondelete="CASCADE"),
        nullable=False, unique=True, index=True,
    )

    # ── Valuation ────────────────────────────────────────────────────────────
    market_cap:        Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    enterprise_value:  Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    pe_ratio:          Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    forward_pe:        Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    peg_ratio:         Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    price_to_book:     Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    price_to_sales:    Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    ev_to_ebitda:      Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)

    # ── Per-share ────────────────────────────────────────────────────────────
    eps:          Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    forward_eps:  Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)

    # ── Income / dividends ───────────────────────────────────────────────────
    dividend_yield:  Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)  # 0.035 = 3.5%
    dividend_rate:   Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)  # $ per share/year
    payout_ratio:    Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)

    # ── Financials ────────────────────────────────────────────────────────────
    total_revenue:       Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    ebitda:              Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    net_income:          Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    free_cashflow:       Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    operating_cashflow:  Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    total_debt:          Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    total_cash:          Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)

    # ── Margins ───────────────────────────────────────────────────────────────
    profit_margin:    Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)
    gross_margin:     Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)
    operating_margin: Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)

    # ── Growth ────────────────────────────────────────────────────────────────
    revenue_growth:   Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)
    earnings_growth:  Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)

    # ── Quality / balance sheet ───────────────────────────────────────────────
    return_on_equity:  Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)
    return_on_assets:  Mapped[Optional[float]] = mapped_column(Numeric(10, 6), nullable=True)
    debt_to_equity:    Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    current_ratio:     Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)

    # ── Risk / share structure ────────────────────────────────────────────────
    beta:               Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    shares_outstanding: Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    float_shares:       Mapped[Optional[float]] = mapped_column(Numeric(24, 2), nullable=True)
    short_ratio:        Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)

    # ── Market / price reference ──────────────────────────────────────────────
    fifty_two_week_high:  Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    fifty_two_week_low:   Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    fifty_day_avg:        Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    two_hundred_day_avg:  Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    avg_volume:           Mapped[Optional[float]] = mapped_column(Numeric(20, 2), nullable=True)

    # ── Analyst consensus ─────────────────────────────────────────────────────
    analyst_target_price:   Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    analyst_recommendation: Mapped[Optional[str]]   = mapped_column(String(30), nullable=True)  # "buy", "hold", etc.
    analyst_count:          Mapped[Optional[int]]   = mapped_column(Integer, nullable=True)

    # ── Company info ──────────────────────────────────────────────────────────
    website:   Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    employees: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Meta ──────────────────────────────────────────────────────────────────
    fetched_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    source:     Mapped[str] = mapped_column(String(20), nullable=False, default="yahoo")


class SecuritySignals(Base):
    """
    Computed technical signals derived from the local historical_prices table.
    One row per security (upserted after each price-history download).
    All price-based values are in CAD.
    """
    __tablename__ = "security_signals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    security_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("securities.id", ondelete="CASCADE"),
        nullable=False, unique=True, index=True,
    )
    as_of_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    # ── Trend ─────────────────────────────────────────────────────────────────
    ma_50d:          Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    ma_200d:         Mapped[Optional[float]] = mapped_column(Numeric(20, 6), nullable=True)
    price_vs_50d:    Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)   # % above (+) / below (-)
    price_vs_200d:   Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    golden_cross:    Mapped[Optional[bool]]  = mapped_column(Boolean, nullable=True)           # True if 50MA > 200MA

    # ── Momentum (total return %) ─────────────────────────────────────────────
    return_1m:       Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    return_3m:       Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    return_6m:       Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    return_12m:      Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    momentum_12_1:   Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)   # 12m minus 1m (factor)

    # ── Oscillators ───────────────────────────────────────────────────────────
    rsi_14:          Mapped[Optional[float]] = mapped_column(Numeric(8, 4), nullable=True)    # 0–100

    # ── Volatility (annualised %) ──────────────────────────────────────────────
    volatility_20d:  Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    volatility_60d:  Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)

    # ── Meta ──────────────────────────────────────────────────────────────────
    computed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


# Avoid circular imports - import Transaction here for relationship
from app.models.transactions import Transaction  # noqa: E402
from app.models.options import OptionContract  # noqa: E402
