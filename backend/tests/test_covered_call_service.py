"""Tests for the covered-call scanner's explain_score() — the human-readable
"why this score" breakdown surfaced in the Scanner UI. Pure function, no DB."""
from app.services.covered_call_service import explain_score


def test_explain_score_ideal_setup_mentions_all_positive_factors():
    text = explain_score(
        annual_yield=18.5, delta=0.25, otm_pct=5.2, iv_pct=30, hv_30_pct=20,
        iv_hv_ratio=1.5, dte=34, open_interest=2500, bid_ask_spread_pct=3,
    )
    assert "18.5% annualized yield" in text
    assert "delta 0.25 (ideal strike distance)" in text
    assert "theta sweet spot" in text
    assert "deep liquidity" in text
    assert "tight spread" in text


def test_explain_score_poor_setup_flags_negative_factors():
    text = explain_score(
        annual_yield=5.0, delta=None, otm_pct=1.5, iv_pct=None, hv_30_pct=None,
        iv_hv_ratio=None, dte=60, open_interest=50, bid_ask_spread_pct=None,
    )
    assert "too close to the money" in text
    assert "off the sweet spot" in text
    assert "thin liquidity" in text


def test_explain_score_falls_back_to_otm_when_no_delta():
    text = explain_score(
        annual_yield=10.0, delta=None, otm_pct=8.0, iv_pct=None, hv_30_pct=None,
        iv_hv_ratio=None, dte=None, open_interest=None, bid_ask_spread_pct=None,
    )
    assert "8.0% OTM (ideal strike distance)" in text


def test_explain_score_all_none_returns_fallback_message():
    text = explain_score(
        annual_yield=None, delta=None, otm_pct=None, iv_pct=None, hv_30_pct=None,
        iv_hv_ratio=None, dte=None, open_interest=None, bid_ask_spread_pct=None,
    )
    assert text == "Insufficient data for a detailed breakdown."
