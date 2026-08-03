"""Tests for app/services/gemini_statement.py's fund-code normalization."""
from app.services.gemini_statement import _clean_code


def test_clean_code_strips_combined_code_and_name():
    raw = "4143 ML Fidelity Bond Plus Inst b1*"
    assert _clean_code(raw, "ML Fidelity Bond Plus Inst b1*") == "4143"


def test_clean_code_leaves_bare_code_untouched():
    assert _clean_code("4143", "ML Fidelity Bond Plus Inst b1*") == "4143"
    assert _clean_code("AAPL", "Apple Inc") == "AAPL"


def test_clean_code_none_passthrough():
    assert _clean_code(None, "Some Fund") is None


def test_clean_code_falls_back_to_none_for_unrecognizable_multiword_code():
    # A genuinely multi-word "code" that isn't just "code + name" (name doesn't
    # start with it, and the leading token isn't alphanumeric) should not be
    # trusted — better a name-based ticker key than a wrong one.
    assert _clean_code("N/A special series", "Totally Different Fund") is None
