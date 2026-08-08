"""Tests for the covered-call scan's market-open gate — decides whether IBeam live snapshots
(which lack OI/volume when the market is closed) or yfinance (last-session OI/volume) is used."""
from datetime import datetime

from app.services.covered_call_service import _market_open_now


def test_saturday_is_closed():
    assert _market_open_now(datetime(2026, 8, 8, 12, 0)) is False   # Saturday noon


def test_sunday_is_closed():
    assert _market_open_now(datetime(2026, 8, 9, 12, 0)) is False   # Sunday noon


def test_weekday_midday_is_open():
    assert _market_open_now(datetime(2026, 8, 7, 12, 0)) is True    # Friday noon


def test_weekday_before_open_is_closed():
    assert _market_open_now(datetime(2026, 8, 7, 9, 0)) is False    # 09:00 ET, pre-market


def test_weekday_after_close_is_closed():
    assert _market_open_now(datetime(2026, 8, 7, 16, 30)) is False  # 16:30 ET, after close


def test_open_bell_boundary():
    assert _market_open_now(datetime(2026, 8, 7, 9, 30)) is True    # exactly 09:30 ET
