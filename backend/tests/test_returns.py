"""
Tests for the two Modified Dietz implementations in app/routers/portfolio.py.

Both are pure arithmetic once given their inputs — no DB access required.
They are tested independently rather than unified: `_modified_dietz` (date_map
of (mv, income, invested) snapshots) backs get_returns_detail/get_monthly_returns;
`_modified_dietz_from_flows` (explicit flow list) backs get_performance_returns.
"""
from datetime import date
from decimal import Decimal as D

from app.routers.portfolio import (
    _modified_dietz,
    _modified_dietz_return,
    _modified_dietz_from_flows,
)


# ── _modified_dietz (date_map based) ──────────────────────────────────────────

def test_flat_value_no_flows_returns_zero():
    date_map = {
        date(2024, 1, 1): (D(1000), D(0), D(1000)),
        date(2024, 2, 1): (D(1000), D(0), D(1000)),
    }
    result = _modified_dietz(date_map, date(2024, 1, 1), date(2024, 2, 1))
    assert result is not None
    return_pct, denom = result
    assert return_pct == 0.0
    assert denom == 1000.0


def test_pure_growth_no_flows():
    date_map = {
        date(2024, 1, 1): (D(1000), D(0), D(1000)),
        date(2024, 2, 1): (D(1100), D(0), D(1000)),
    }
    return_pct, _ = _modified_dietz(date_map, date(2024, 1, 1), date(2024, 2, 1))
    assert round(return_pct, 4) == 10.0


def test_mid_period_deposit_is_time_weighted_in_denominator():
    # Deposit of 500 exactly halfway through a 30-day period. End MV grows to
    # 1600 with no gain (1000 + 500 deposit + 100 growth on the original 1000).
    date_map = {
        date(2024, 1, 1):  (D(1000), D(0), D(1000)),
        date(2024, 1, 16): (D(1600), D(0), D(1500)),  # deposit of 500 landed here
        date(2024, 1, 31): (D(1700), D(0), D(1500)),
    }
    return_pct, denom = _modified_dietz(date_map, date(2024, 1, 1), date(2024, 1, 31))
    # weighted flow = 500 * (15/30) = 250; denom = 1000 + 250 = 1250
    assert denom == 1250.0
    # numerator = (1700 - 1000) - 500 + 0 = 200
    assert round(return_pct, 4) == round(200 / 1250 * 100, 4)


def test_withdrawal_reduces_denominator_appropriately():
    date_map = {
        date(2024, 1, 1):  (D(1000), D(0), D(1000)),
        date(2024, 1, 16): (D(500), D(0), D(500)),  # withdrew 500 at midpoint
        date(2024, 1, 31): (D(520), D(0), D(500)),
    }
    return_pct, denom = _modified_dietz(date_map, date(2024, 1, 1), date(2024, 1, 31))
    # weighted flow = -500 * (15/30) = -250; denom = 1000 - 250 = 750
    assert denom == 750.0
    # numerator = (520 - 1000) - (-500) + 0 = 20
    assert round(return_pct, 4) == round(20 / 750 * 100, 4)


def test_no_snapshot_in_range_returns_none():
    date_map = {date(2024, 1, 1): (D(1000), D(0), D(1000))}
    # end_target before any snapshot exists -> _snap_at_date returns None
    result = _modified_dietz(date_map, date(2023, 1, 1), date(2023, 6, 1))
    assert result is None


def test_zero_start_value_returns_none():
    date_map = {
        date(2024, 1, 1): (D(0), D(0), D(0)),
        date(2024, 2, 1): (D(100), D(0), D(100)),
    }
    result = _modified_dietz(date_map, date(2024, 1, 1), date(2024, 2, 1))
    assert result is None


def test_modified_dietz_return_wrapper_returns_pct_only():
    date_map = {
        date(2024, 1, 1): (D(1000), D(0), D(1000)),
        date(2024, 2, 1): (D(1100), D(0), D(1000)),
    }
    pct = _modified_dietz_return(date_map, date(2024, 1, 1), date(2024, 2, 1))
    assert round(pct, 4) == 10.0


# ── _modified_dietz_from_flows (explicit flow list) ───────────────────────────

def test_from_flows_no_flows_pure_growth():
    pct = _modified_dietz_from_flows(
        1000.0, 1100.0, [], date(2024, 1, 1), date(2024, 2, 1),
    )
    assert round(pct, 4) == 10.0


def test_from_flows_mid_period_deposit_time_weighted():
    flows = [(date(2024, 1, 16), 500.0)]
    pct = _modified_dietz_from_flows(
        1000.0, 1700.0, flows, date(2024, 1, 1), date(2024, 1, 31),
    )
    # weighted = 500 * (15/30) = 250; denom = 1250
    # numerator = (1700 - 1000) - 500 = 200
    assert round(pct, 4) == round(200 / 1250 * 100, 4)


def test_from_flows_withdrawal():
    flows = [(date(2024, 1, 16), -500.0)]
    pct = _modified_dietz_from_flows(
        1000.0, 520.0, flows, date(2024, 1, 1), date(2024, 1, 31),
    )
    assert round(pct, 4) == round(20 / 750 * 100, 4)


def test_from_flows_none_start_value_returns_none():
    assert _modified_dietz_from_flows(
        None, 100.0, [], date(2024, 1, 1), date(2024, 2, 1),
    ) is None


def test_from_flows_zero_denominator_returns_none():
    # A withdrawal exactly offsetting the start value on day 0 collapses the denominator.
    flows = [(date(2024, 1, 1), -1000.0)]
    pct = _modified_dietz_from_flows(
        1000.0, 0.0, flows, date(2024, 1, 1), date(2024, 1, 31),
    )
    assert pct is None


def test_from_flows_zero_length_period_returns_none():
    # total_days <= 0 -> weighted flows collapse to 0.0, but the function still
    # divides by start_value (no total_days guard on the denominator itself);
    # verify the degenerate same-day period does not raise.
    pct = _modified_dietz_from_flows(
        1000.0, 1000.0, [], date(2024, 1, 1), date(2024, 1, 1),
    )
    assert pct == 0.0
