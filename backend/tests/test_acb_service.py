"""
Tests for the ACB (adjusted cost base) engine — app/services/acb_service.py.

Every transaction type _apply_txn() handles is exercised via in-memory transaction
lists (the _txns param), so these tests never touch a database.
"""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

import pytest

from app.services.acb_service import calculate_acb_for_security, ZERO


@dataclass
class FakeTxn:
    id: int
    transaction_date: date
    transaction_type: str
    quantity: Optional[Decimal] = None
    cad_amount: Optional[Decimal] = None
    account_id: int = 1
    security_id: int = 1
    raw_description: Optional[str] = None


def calc(txns, **kwargs):
    return calculate_acb_for_security(
        db=None, security_id=1, account_id=1, _txns=txns, **kwargs
    )


def D(v):
    return Decimal(str(v))


class FakeDB:
    """Stub that answers the one db.query(Transaction).filter(...).first() call inside
    acb_service's cross-security SPLIT reorg branch. Ignores the actual filter predicates
    and just returns whatever txn was configured — fine for a narrow test with only one
    candidate row."""

    def __init__(self, answer):
        self._answer = answer

    def query(self, model):
        return self

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._answer


# ── BUY / OPENING_BALANCE ─────────────────────────────────────────────────────

def test_buy_opens_a_position():
    txns = [FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000))]
    result = calc(txns)
    assert result["quantity"] == D(100)
    assert result["total_acb_cad"] == D(1000)
    assert result["acb_per_share_cad"] == D(10)


def test_opening_balance_seeds_cost_basis():
    txns = [FakeTxn(1, date(2024, 1, 1), "OPENING_BALANCE", quantity=D(50), cad_amount=D(500))]
    result = calc(txns)
    assert result["quantity"] == D(50)
    assert result["total_acb_cad"] == D(500)


def test_two_buys_average_the_acb_per_share():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 2, 1), "BUY", quantity=D(100), cad_amount=D(-1400)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(200)
    assert result["total_acb_cad"] == D(2400)
    assert result["acb_per_share_cad"] == D(12)


def test_negative_quantity_buy_cancels_a_prior_buy():
    """Some brokers (e.g. iTrade) report a cancelled trade as a same-day-ish BUY row
    with negative quantity and a positive cad_amount refund, e.g. raw_description
    'AS OF ... to cxl buy'. It must fully reverse the buy it cancels, not be ignored."""
    txns = [
        FakeTxn(1, date(2024, 11, 15), "BUY", quantity=D(6), cad_amount=D(-6737.97)),
        FakeTxn(2, date(2024, 11, 19), "BUY", quantity=D(-6), cad_amount=D(6737.97)),
        FakeTxn(3, date(2024, 11, 20), "BUY", quantity=D(2), cad_amount=D(-2020.77)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(2)
    assert result["total_acb_cad"] == D(2020.77)


def test_negative_quantity_buy_cannot_take_position_negative():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(2), cad_amount=D(-200)),
        FakeTxn(2, date(2024, 1, 2), "BUY", quantity=D(-6), cad_amount=D(600)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    assert result["total_acb_cad"] == ZERO


# ── SELL ───────────────────────────────────────────────────────────────────────

def test_positive_quantity_sell_cancels_a_prior_sell():
    """Mirror of the BUY-cancel case: a SELL row with positive quantity (iTrade's
    'AS OF ... to cxl sell') reverses the sell immediately before it. It must restore
    both quantity and ACB, and remove the realized gain the original sell recorded."""
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 11, 15), "SELL", quantity=D(-19), cad_amount=D(11397.96)),
        FakeTxn(3, date(2024, 11, 19), "SELL", quantity=D(19), cad_amount=D(-11397.96)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(100)
    assert result["total_acb_cad"] == D(1000)
    assert result["realized_gains"] == []


def test_sell_realizes_gain_at_pooled_acb():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 3, 1), "SELL", quantity=D(-40), cad_amount=D(600)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(60)
    assert result["total_acb_cad"] == D(600)  # 60 remaining @ $10/share
    assert len(result["realized_gains"]) == 1
    gain = result["realized_gains"][0]
    assert gain["proceeds_cad"] == D(600)
    assert gain["acb_cad"] == D(400)  # 40 sold @ $10/share
    assert gain["gain_cad"] == D(200)


def test_sell_more_than_held_clamps_to_zero_not_negative():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(10), cad_amount=D(-100)),
        FakeTxn(2, date(2024, 2, 1), "SELL", quantity=D(-15), cad_amount=D(200)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    assert result["total_acb_cad"] == ZERO


def test_sell_with_no_position_records_full_proceeds_as_gain():
    """lot.sell() on an empty lot returns (0, 0) — a SELL with no matching position
    still records a realized-gain row, with zero cost basis (proceeds = full gain).
    This documents current behavior (a data-quality issue upstream, not a bug here)."""
    txns = [FakeTxn(1, date(2024, 1, 1), "SELL", quantity=D(-10), cad_amount=D(100))]
    result = calc(txns)
    assert result["quantity"] == ZERO
    assert result["total_acb_cad"] == ZERO
    assert len(result["realized_gains"]) == 1
    assert result["realized_gains"][0]["acb_cad"] == ZERO
    assert result["realized_gains"][0]["gain_cad"] == D(100)


# ── OPTION_BUY / OPTION_SELL (short options) ──────────────────────────────────

def test_writing_a_call_opens_a_short_position():
    txns = [FakeTxn(1, date(2024, 1, 1), "OPTION_SELL", quantity=D(-1), cad_amount=D(150))]
    result = calc(txns)
    assert result["quantity"] == D(-1)
    assert result["total_acb_cad"] == D(-150)


def test_buying_to_close_a_short_option_realizes_gain():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "OPTION_SELL", quantity=D(-1), cad_amount=D(150)),
        FakeTxn(2, date(2024, 1, 15), "OPTION_BUY", quantity=D(1), cad_amount=D(-50)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    assert result["total_acb_cad"] == ZERO
    gain = result["realized_gains"][0]
    assert gain["proceeds_cad"] == D(150)  # premium received
    assert gain["acb_cad"] == D(50)        # cost to close
    assert gain["gain_cad"] == D(100)


def test_option_expiry_short_profits_full_premium():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "OPTION_SELL", quantity=D(-1), cad_amount=D(150)),
        FakeTxn(2, date(2024, 2, 1), "OPTION_EXPIRY", quantity=D(0)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    assert result["total_acb_cad"] == ZERO
    gain = result["realized_gains"][0]
    assert gain["proceeds_cad"] == D(150)
    assert gain["gain_cad"] == D(150)


def test_option_expiry_long_loses_full_premium():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "OPTION_BUY", quantity=D(1), cad_amount=D(-150)),
        FakeTxn(2, date(2024, 2, 1), "OPTION_EXPIRY", quantity=D(0)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    gain = result["realized_gains"][0]
    assert gain["proceeds_cad"] == ZERO
    assert gain["gain_cad"] == D(-150)


def test_option_assignment_on_short_realizes_premium():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "OPTION_SELL", quantity=D(-1), cad_amount=D(150)),
        FakeTxn(2, date(2024, 2, 1), "OPTION_ASSIGNMENT", quantity=D(0)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    gain = result["realized_gains"][0]
    assert gain["gain_cad"] == D(150)


# ── DRIP ───────────────────────────────────────────────────────────────────────

def test_drip_buys_shares_at_reinvestment_cost():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 4, 1), "DRIP", quantity=D(5), cad_amount=D(-55)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(105)
    assert result["total_acb_cad"] == D(1055)


# ── TRANSFER_IN / TRANSFER_OUT ─────────────────────────────────────────────────

def test_transfer_in_adds_cost_basis():
    txns = [FakeTxn(1, date(2024, 1, 1), "TRANSFER_IN", quantity=D(20), cad_amount=D(200))]
    result = calc(txns)
    assert result["quantity"] == D(20)
    assert result["total_acb_cad"] == D(200)


def test_transfer_out_realizes_a_gain_like_a_sale():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 3, 1), "TRANSFER_OUT", quantity=D(-100), cad_amount=D(1200)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    gain = result["realized_gains"][0]
    assert gain["gain_cad"] == D(200)


# ── JOURNAL ────────────────────────────────────────────────────────────────────

def test_journal_in_uses_cad_amount_when_present():
    txns = [FakeTxn(1, date(2024, 1, 1), "JOURNAL", quantity=D(10), cad_amount=D(500))]
    result = calc(txns)
    assert result["quantity"] == D(10)
    assert result["total_acb_cad"] == D(500)


def test_journal_in_falls_back_to_book_value_in_raw_description():
    txns = [FakeTxn(
        1, date(2024, 1, 1), "JOURNAL", quantity=D(10), cad_amount=D(0),
        raw_description="BOOK VALUE $1;234.56",
    )]
    result = calc(txns)
    assert result["quantity"] == D(10)
    assert result["total_acb_cad"] == D("1234.56")


def test_journal_in_with_no_cost_data_adds_at_zero_cost():
    txns = [FakeTxn(1, date(2024, 1, 1), "JOURNAL", quantity=D(10), cad_amount=D(0))]
    result = calc(txns)
    assert result["quantity"] == D(10)
    assert result["total_acb_cad"] == ZERO


def test_journal_out_removes_shares_without_realizing_gain():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 3, 1), "JOURNAL", quantity=D(-100)),
    ]
    result = calc(txns)
    assert result["quantity"] == ZERO
    assert result["total_acb_cad"] == ZERO
    assert result["realized_gains"] == []  # internal move, not a disposal


# ── RETURN_OF_CAPITAL ──────────────────────────────────────────────────────────

def test_return_of_capital_reduces_acb_without_changing_quantity():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        FakeTxn(2, date(2024, 6, 1), "RETURN_OF_CAPITAL", cad_amount=D(-50)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(100)
    assert result["total_acb_cad"] == D(950)


def test_return_of_capital_cannot_take_acb_negative():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(10), cad_amount=D(-50)),
        FakeTxn(2, date(2024, 6, 1), "RETURN_OF_CAPITAL", cad_amount=D(-500)),
    ]
    result = calc(txns)
    assert result["total_acb_cad"] == ZERO


# ── SPLIT (same-security, two-row iTrade format) ──────────────────────────────

def test_same_security_split_adjusts_quantity_and_preserves_total_acb():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000)),
        # 2-for-1 split: new total = 200
        FakeTxn(2, date(2024, 6, 1), "SPLIT", quantity=D(200)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(200)
    assert result["total_acb_cad"] == D(1000)
    assert result["acb_per_share_cad"] == D(5)


# ── FORWARD_SPLIT (Scotia Wealth single-row format) ───────────────────────────

def test_forward_split_adds_delta_shares_and_preserves_total_acb():
    txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(50), cad_amount=D(-500)),
        # 3-for-2 split on 50 shares -> 25 new shares added
        FakeTxn(2, date(2024, 6, 1), "FORWARD_SPLIT", quantity=D(25)),
    ]
    result = calc(txns)
    assert result["quantity"] == D(75)
    assert result["total_acb_cad"] == D(500)


# ── Cross-security SPLIT reorg via _txn_pool ──────────────────────────────────

def test_cross_security_split_reorg_inherits_acb_via_txn_pool():
    """Old security (id=1) retires with a negative-qty SPLIT; new security (id=2)
    opens with a positive-qty SPLIT on the same date/account and should inherit
    the old security's ACB, per the _txn_pool cross-lookup path."""
    old_txns = [
        FakeTxn(1, date(2024, 1, 1), "BUY", quantity=D(100), cad_amount=D(-1000), security_id=1),
        FakeTxn(2, date(2024, 6, 1), "SPLIT", quantity=D(-100), security_id=1),
    ]
    new_txns = [
        FakeTxn(3, date(2024, 6, 1), "SPLIT", quantity=D(50), security_id=2),
    ]
    txn_pool = {(1, 1): old_txns, (2, 1): new_txns}
    fake_db = FakeDB(old_txns[1])  # the old security's SPLIT(-100) row

    result = calculate_acb_for_security(
        db=fake_db, security_id=2, account_id=1, _txns=new_txns, _txn_pool=txn_pool,
    )
    assert result["quantity"] == D(50)
    assert result["total_acb_cad"] == D(1000)

    # The retiring security should close out at zero without a realized gain.
    old_result = calculate_acb_for_security(
        db=None, security_id=1, account_id=1, _txns=old_txns, _txn_pool=txn_pool,
    )
    assert old_result["quantity"] == ZERO
    assert old_result["total_acb_cad"] == ZERO
    assert old_result["realized_gains"] == []
