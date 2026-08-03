"""Tests for app/services/normalizer.py's DRIP-fraction parsing."""
from decimal import Decimal

from app.services.normalizer import _apply_fraction


def D(v):
    return Decimal(str(v))


def test_apply_fraction_adds_positive_remainder():
    desc = "PENDER CORPORATE BOND FUND CLASS F (550) REINVEST 06/30/26 @ $12.3741 PLUS FRACTIONS OF 0.466 BOOK VALUE $253.25"
    assert _apply_fraction(D(20), desc) == D("20.466")


def test_apply_fraction_subtracts_for_negative_quantity():
    """Fund-merger 'remove' legs carry a negative quantity — the fraction extends the
    magnitude of the removal, so it must subtract, not add."""
    desc = "PENDER CORPORATE BOND FUND CLASS F (510) PLUS FRACTIONS OF 0.047 AS OF 12/05/25 NON-TAXABLE FUND MERGER BOOK VALUE $43;393.26"
    assert _apply_fraction(D(-3719), desc) == D("-3719.047")


def test_apply_fraction_no_match_leaves_quantity_unchanged():
    assert _apply_fraction(D(100), "ELI LILLY & CO @ 0599.101 TD 09/13/23") == D(100)


def test_apply_fraction_none_quantity_passthrough():
    assert _apply_fraction(None, "PLUS FRACTIONS OF 0.5") is None


def test_apply_fraction_none_description_passthrough():
    assert _apply_fraction(D(5), None) == D(5)
