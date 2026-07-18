"""Tests for the Fundamental Screener's composite score — app/routers/screener.py.
Pure functions operating on plain fixture objects, no DB required."""
from dataclasses import dataclass
from typing import Optional

from app.routers.screener import _percentile_ranks, _composite_scores


@dataclass
class FakeFundamentals:
    security_id: int
    pe_ratio: Optional[float] = None
    debt_to_equity: Optional[float] = None
    return_on_equity: Optional[float] = None
    revenue_growth: Optional[float] = None
    dividend_yield: Optional[float] = None


def test_percentile_ranks_orders_ascending_0_to_100():
    assert _percentile_ranks([10, 20, 30]) == [0.0, 50.0, 100.0]


def test_percentile_ranks_single_value_is_100():
    assert _percentile_ranks([42]) == [100.0]


def test_percentile_ranks_preserves_none_positions():
    result = _percentile_ranks([10, None, 30])
    assert result[1] is None
    assert result[0] == 0.0
    assert result[2] == 100.0


def test_composite_score_best_across_all_metrics_scores_100():
    rows = [
        FakeFundamentals(1, pe_ratio=50, debt_to_equity=2.0, return_on_equity=0.02, revenue_growth=-0.1, dividend_yield=0.0),
        FakeFundamentals(2, pe_ratio=10, debt_to_equity=0.1, return_on_equity=0.30, revenue_growth=0.25, dividend_yield=5.0),
    ]
    scores = _composite_scores(rows)
    # Security 2 has the best value on every metric (low PE/D-E is good, high ROE/growth/yield is good)
    assert scores[2] == 100.0
    assert scores[1] == 0.0


def test_composite_score_missing_metrics_renormalizes_weights():
    # Only return_on_equity present for both -> should still produce a score, not None.
    rows = [
        FakeFundamentals(1, return_on_equity=0.05),
        FakeFundamentals(2, return_on_equity=0.20),
    ]
    scores = _composite_scores(rows)
    assert scores[1] == 0.0
    assert scores[2] == 100.0


def test_composite_score_all_metrics_missing_is_none():
    rows = [FakeFundamentals(1)]
    scores = _composite_scores(rows)
    assert scores[1] is None
