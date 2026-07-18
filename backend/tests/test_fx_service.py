"""
Tests for app/services/fx_service.py's get_rate() — the only pure-ish lookup
in the module (fetch_boc_rates does network I/O, out of scope here). Uses the
fx_db_session fixture (in-memory SQLite, FXRate table only) from conftest.py.
"""
from datetime import date
from decimal import Decimal

from app.models.master import FXRate
from app.services.fx_service import get_rate


def _seed(session, rows):
    for rate_date, rate in rows:
        session.add(FXRate(
            rate_date=rate_date, from_currency="USD", to_currency="CAD",
            rate=Decimal(str(rate)), source="BOC",
        ))
    session.commit()


def test_same_currency_is_always_rate_one(fx_db_session):
    assert get_rate(fx_db_session, date(2024, 1, 1), "CAD", "CAD") == Decimal("1")


def test_exact_date_match(fx_db_session):
    _seed(fx_db_session, [(date(2024, 3, 1), "1.35")])
    rate = get_rate(fx_db_session, date(2024, 3, 1), "USD", "CAD")
    assert rate == Decimal("1.35")


def test_weekend_falls_back_to_prior_business_day(fx_db_session):
    # Friday rate present; Saturday/Sunday missing -> Monday lookup should fall
    # back to Friday's rate (BoC doesn't publish weekend rates).
    _seed(fx_db_session, [(date(2024, 3, 1), "1.35")])  # a Friday
    rate = get_rate(fx_db_session, date(2024, 3, 3), "USD", "CAD")  # the Sunday
    assert rate == Decimal("1.35")


def test_inverts_cad_to_usd(fx_db_session):
    _seed(fx_db_session, [(date(2024, 3, 1), "1.25")])
    rate = get_rate(fx_db_session, date(2024, 3, 1), "CAD", "USD")
    assert rate == Decimal("1") / Decimal("1.25")


def test_unsupported_pair_returns_none(fx_db_session):
    _seed(fx_db_session, [(date(2024, 3, 1), "1.35")])
    assert get_rate(fx_db_session, date(2024, 3, 1), "EUR", "CAD") is None
    assert get_rate(fx_db_session, date(2024, 3, 1), "USD", "EUR") is None


def test_no_rate_within_fallback_window_returns_none(fx_db_session):
    _seed(fx_db_session, [(date(2024, 1, 1), "1.30")])
    # 30 days later, no rate seeded anywhere in the 8-day (i-in-range(8)) lookback window.
    assert get_rate(fx_db_session, date(2024, 2, 1), "USD", "CAD") is None
