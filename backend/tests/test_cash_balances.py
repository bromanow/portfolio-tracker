"""Regression test: personal-asset "Other Assets" accounts must never surface a cash balance.

Bug: personal_assets.py's _get_or_create_owner_account creates an account_type="OTHER"
container per owner to hold a manually-entered asset's OPENING_BALANCE transaction (its book
value, e.g. $60,000 for an unheld stock like GCV.V). get_cash_balances iterates every account in
the DB; if that account's opening transaction is ever counted, its book value shows up in the
Securities page's Cash section as if it were real liquid cash. The fix filters account_type
"OTHER" out of get_cash_balances entirely, so this can't happen regardless of the underlying
transaction's type or amount.
"""
from datetime import date
from decimal import Decimal as D

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db():
    import app.models.master        # noqa: F401
    import app.models.transactions  # noqa: F401
    import app.models.options       # noqa: F401
    import app.models.imports       # noqa: F401
    import app.models.prices        # noqa: F401
    import app.models.auth          # noqa: F401
    import app.models.clients       # noqa: F401
    import app.models.ibkr          # noqa: F401
    import app.models.scanner       # noqa: F401
    import app.models.plaid         # noqa: F401
    from app.database import Base

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _make_account(db, *, name, account_type, owner="Test"):
    from app.models.master import Brokerage, Account
    brokerage = db.query(Brokerage).filter(Brokerage.code == "TESTBRK").first()
    if brokerage is None:
        brokerage = Brokerage(name="Test Brokerage", code="TESTBRK")
        db.add(brokerage)
        db.flush()
    acct = Account(brokerage_id=brokerage.id, name=name, account_type=account_type,
                    base_currency="CAD", owner=owner)
    db.add(acct)
    db.flush()
    return acct


def test_other_asset_account_reports_no_cash_balance(db):
    from app.models.master import Security
    from app.models.transactions import Transaction
    from app.services.portfolio import get_cash_balances

    other_acct = _make_account(db, name="Brian Other Assets", account_type="OTHER")
    sec = Security(ticker="PA:gcv-v", name="Golden Star Capital Ventures", asset_class="OTHER_ASSET", currency="CAD")
    db.add(sec)
    db.flush()
    db.add(Transaction(
        account_id=other_acct.id, security_id=sec.id,
        transaction_date=date.today(), transaction_type="OPENING_BALANCE",
        quantity=D("1"), price=D("60000"), transaction_currency="CAD",
        transaction_amount=D("60000"), account_currency_amount=D("60000"), cad_amount=D("60000"),
    ))
    db.commit()

    rows = get_cash_balances(db)
    assert not any(r["account_id"] == other_acct.id for r in rows), \
        "an OTHER-type (personal-asset) account must never appear in cash balances"


def test_other_asset_account_excluded_even_if_transaction_type_were_cash_opening(db):
    """Defense in depth: whatever transaction_type quirk actually caused the leak in
    production (OPENING_BALANCE is correctly cash-neutral; CASH_OPENING is not), the
    account_type="OTHER" filter must exclude the account regardless."""
    from app.models.master import Security
    from app.models.transactions import Transaction
    from app.services.portfolio import get_cash_balances

    other_acct = _make_account(db, name="Michelle Other Assets", account_type="OTHER")
    sec = Security(ticker="PA:gcv-v-2", name="Golden Star Capital Ventures", asset_class="OTHER_ASSET", currency="CAD")
    db.add(sec)
    db.flush()
    db.add(Transaction(
        account_id=other_acct.id, security_id=sec.id,
        transaction_date=date.today(), transaction_type="CASH_OPENING",
        quantity=D("1"), price=D("60000"), transaction_currency="CAD",
        transaction_amount=D("60000"), account_currency_amount=D("60000"), cad_amount=D("60000"),
    ))
    db.commit()

    rows = get_cash_balances(db)
    assert not any(r["account_id"] == other_acct.id for r in rows)


def test_real_brokerage_account_still_reports_cash(db):
    from app.models.transactions import Transaction
    from app.services.portfolio import get_cash_balances

    real_acct = _make_account(db, name="iTrade Brian TFSA", account_type="TFSA")
    db.add(Transaction(
        account_id=real_acct.id, security_id=None,
        transaction_date=date.today(), transaction_type="DEPOSIT",
        quantity=None, price=None, transaction_currency="CAD",
        transaction_amount=D("500"), account_currency_amount=D("500"), cad_amount=D("500"),
    ))
    db.commit()

    rows = get_cash_balances(db)
    matches = [r for r in rows if r["account_id"] == real_acct.id]
    assert len(matches) == 1
    assert D(matches[0]["balance"]) == D("500")
