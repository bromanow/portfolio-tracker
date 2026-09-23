"""Regression tests: Scotia Wealth private-pool reinvestments (e.g. "SHORT-MID GOVT BD POOL
SR K (6400)", ticker PIN6400) use an Activity code the parser doesn't recognize (e.g. "DVF"),
so they landed as transaction_type=OTHER even though the description clearly signals a
reinvestment purchase. The ACB engine has no OTHER handler at all, so these silently
contributed ZERO to quantity/ACB -- a real position quietly went missing (Greg's account
showed no PIN6400 holding despite a real ~4.5-unit remaining position).
"""
from decimal import Decimal as D

from app.parsers.scotia_wealth import parse_scotia_wealth_csv

_HEADER = "Description,Symbol,Transaction date,Settlement date,Account Currency,Activity,Quantity,Currency of Price,Price,Settlement amount"


def _csv(row: str) -> str:
    return _HEADER + "\n" + row


def test_unrecognized_activity_code_promotes_to_drip_when_description_signals_reinvestment():
    # Raw Activity "DVF" isn't in SM_ACTIVITY_MAP -> would default to OTHER, but the
    # description clearly signals a reinvestment purchase.
    row = (
        'SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400) REINVEST 08/31/26 @ $9.1019 '
        'PLUS FRACTIONS OF 0.404 BOOK VALUE $3.68,PIN6400,2026-09-01,2026-09-01,CAD,DVF,0,CAD,0,0'
    )
    rows = parse_scotia_wealth_csv(_csv(row))
    assert len(rows) == 1
    r = rows[0]
    assert r["transaction_type"] == "DRIP"


def test_reinvest_settlement_derived_from_disclosed_book_value_not_zero_quantity():
    # Quantity and Settlement amount are both "0" in the raw file (the true fractional
    # quantity lives only in "PLUS FRACTIONS OF 0.404", applied later by
    # normalizer._apply_fraction) -- qty x price can't give a real dollar figure here, so the
    # disclosed "BOOK VALUE $3.68" must be used instead.
    row = (
        'SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400) REINVEST 08/31/26 @ $9.1019 '
        'PLUS FRACTIONS OF 0.404 BOOK VALUE $3.68,PIN6400,2026-09-01,2026-09-01,CAD,DVF,0,CAD,0,0'
    )
    r = parse_scotia_wealth_csv(_csv(row))[0]
    assert r["settlement_amount"] == D("3.68")
    assert r["price"] == D("9.1019")


def test_unrelated_other_activity_without_reinvest_wording_is_left_alone():
    row = 'SOME UNRELATED FEE ADJUSTMENT,ABC,2026-09-01,2026-09-01,CAD,ZZZ,0,CAD,0,-12.50'
    r = parse_scotia_wealth_csv(_csv(row))[0]
    assert r["transaction_type"] == "OTHER"


def test_dividend_activity_promotes_to_drip_even_with_zero_raw_quantity():
    # Real production case: Activity maps to "Dividend"/"Stock dividend" (canonical_type=
    # DIVIDEND) for a Scotia private-pool year-end reinvestment, but the raw Quantity column
    # is still "0" (fraction lives only in the description) -- so the old promotion condition
    # (which required quantity != 0) never fired, and DIVIDEND has no ACB quantity effect.
    # This affected 46 real transactions across PIN6300/6600/6800/6900/6400.
    row = (
        'SCOTIA WEALTH US DIVIDEND POOL SR K (6800) REINVEST 12/27/24 @ $26.7324 '
        'PLUS FRACTIONS OF 0.312 BOOK VALUE $302.41,PIN6800,2024-12-30,2024-12-30,CAD,Dividend,0,CAD,0,302.41'
    )
    r = parse_scotia_wealth_csv(_csv(row))[0]
    assert r["transaction_type"] == "DRIP"
    # Settlement amount was already correctly reported by Scotia for this activity code, so
    # it should be left as-is rather than overwritten by the BOOK VALUE fallback.
    assert r["settlement_amount"] == D("302.41")


def test_dividend_activity_with_real_quantity_and_no_reinvest_wording_stays_dividend():
    # A genuine cash dividend (no reinvestment) must not be swept into DRIP.
    row = 'ENBRIDGE INC CASH DIV,ENB,2024-12-30,2024-12-30,CAD,Dividend,0,CAD,0,45.00'
    r = parse_scotia_wealth_csv(_csv(row))[0]
    assert r["transaction_type"] == "DIVIDEND"


def test_plain_buy_reinvest_still_promotes_as_before():
    # Regression guard: the original Activity="Buy" + REINVEST-in-description promotion path
    # (pre-existing behavior) must still work.
    row = 'DECISIVE DIVIDEND CORP COM REINVEST @3.8900 05/15/19 DRIP-DIVD REINVESTMENT,DDV,2019-05-15,2019-05-15,CAD,Buy,10,CAD,3.89,-38.90'
    r = parse_scotia_wealth_csv(_csv(row))[0]
    assert r["transaction_type"] == "DRIP"
    assert r["settlement_amount"] == D("38.90")  # sign-normalized positive, from qty*price fallback
