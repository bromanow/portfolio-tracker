"""Tests for backfill_prices_from_statement_transactions (app/services/price_service.py).

Some brokerage holdings (Scotia Wealth private pools like "SHORT-MID GOVT BD POOL SR K
(6400)", ticker PIN6400) have no public exchange or fund-quote feed at all, so the regular
Yahoo/TMX refresh can never price them — yet the broker discloses a per-unit price right in
each REINVEST transaction's raw_description. This recovers that price into
historical_prices/market_prices instead of leaving the holding silently unpriced.
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


def _make_account(db):
    from app.models.master import Brokerage, Account
    brokerage = Brokerage(name="Scotia Wealth", code="SCOTIAW")
    db.add(brokerage)
    db.flush()
    acct = Account(brokerage_id=brokerage.id, name="Greg - TFSA", account_type="TFSA",
                    base_currency="CAD", owner="Greg Romanow")
    db.add(acct)
    db.flush()
    return acct


def _make_security(db, ticker, currency="CAD"):
    from app.models.master import Security
    sec = Security(ticker=ticker, asset_class="EQUITY", currency=currency)
    db.add(sec)
    db.flush()
    return sec


def test_parse_reinvest_date_prefers_embedded_date_over_transaction_date():
    from app.services.price_service import _parse_reinvest_date
    d = _parse_reinvest_date(
        "SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400) REINVEST 08/31/26 @ $9.1019 "
        "PLUS FRACTIONS OF 0.404 BOOK VALUE $3.68"
    )
    assert d == date(2026, 8, 31)


def test_parse_reinvest_date_none_when_absent():
    from app.services.price_service import _parse_reinvest_date
    assert _parse_reinvest_date("SELL 150 SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400)") is None
    assert _parse_reinvest_date(None) is None


def test_backfill_prices_an_unpriced_private_pool(db):
    from app.models.transactions import Transaction
    from app.models.prices import MarketPrice, HistoricalPrice
    from app.services.price_service import backfill_prices_from_statement_transactions

    acct = _make_account(db)
    sec = _make_security(db, "PIN6400")
    db.add_all([
        Transaction(
            account_id=acct.id, security_id=sec.id, transaction_date=date(2026, 7, 2),
            transaction_type="OTHER", quantity=D("0.455"), price=D("9.2375"),
            raw_description="SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400) REINVEST 06/30/26 "
                             "@ $9.2375 PLUS FRACTIONS OF 0.455 BOOK VALUE $4.20",
        ),
        Transaction(
            account_id=acct.id, security_id=sec.id, transaction_date=date(2026, 8, 4),
            transaction_type="OTHER", quantity=D("0.345"), price=D("9.1293"),
            raw_description="SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400) REINVEST 07/31/26 "
                             "@ $9.1293 PLUS FRACTIONS OF 0.345 BOOK VALUE $3.15",
        ),
        Transaction(
            account_id=acct.id, security_id=sec.id, transaction_date=date(2026, 9, 1),
            transaction_type="OTHER", quantity=D("0.404"), price=D("9.1019"),
            raw_description="SCOTIA WEALTH SHORT-MID GOVT BD POOL SR K (6400) REINVEST 08/31/26 "
                             "@ $9.1019 PLUS FRACTIONS OF 0.404 BOOK VALUE $3.68",
        ),
        # A BUY row with no disclosed price — must be ignored, not treated as a $0/None price.
        Transaction(
            account_id=acct.id, security_id=sec.id, transaction_date=date(2026, 7, 31),
            transaction_type="BUY", quantity=D("33"), price=None,
        ),
    ])
    db.commit()

    result = backfill_prices_from_statement_transactions(db)
    assert result["count"] == 1
    assert result["updated"][0]["ticker"] == "PIN6400"

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
    assert mp is not None
    assert mp.price == D("9.1019")            # the LATEST disclosed price
    assert mp.price_date == date(2026, 8, 31)  # the REINVEST date, not the posting date
    assert mp.source == "statement"

    hist_dates = {h.price_date for h in db.query(HistoricalPrice).filter(HistoricalPrice.security_id == sec.id).all()}
    assert hist_dates == {date(2026, 6, 30), date(2026, 7, 31), date(2026, 8, 31)}


def test_backfill_never_touches_an_already_priced_security(db):
    from datetime import datetime as dt
    from app.models.transactions import Transaction
    from app.models.prices import MarketPrice
    from app.services.price_service import backfill_prices_from_statement_transactions

    acct = _make_account(db)
    sec = _make_security(db, "PIN6800")
    db.add(Transaction(
        account_id=acct.id, security_id=sec.id, transaction_date=date(2026, 9, 1),
        transaction_type="OTHER", quantity=D("1"), price=D("9.50"),
        raw_description="REINVEST 08/31/26 @ $9.50",
    ))
    # Already has a real market price (e.g. from a manual entry) — must be left alone.
    db.add(MarketPrice(security_id=sec.id, price=D("11.00"), currency="CAD", price_cad=D("11.00"),
                       source="manual", fetched_at=dt.utcnow()))
    db.commit()

    result = backfill_prices_from_statement_transactions(db)
    assert result["count"] == 0

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
    assert mp.price == D("11.00")
    assert mp.source == "manual"


def test_backfill_skips_option_securities(db):
    from app.models.master import Security
    from app.models.transactions import Transaction
    from app.services.price_service import backfill_prices_from_statement_transactions

    acct = _make_account(db)
    sec = Security(ticker="AAPL 260117C00200000", asset_class="OPTION", currency="USD", is_option=True)
    db.add(sec)
    db.flush()
    db.add(Transaction(
        account_id=acct.id, security_id=sec.id, transaction_date=date(2026, 9, 1),
        transaction_type="OTHER", quantity=D("1"), price=D("5.00"),
    ))
    db.commit()

    result = backfill_prices_from_statement_transactions(db)
    assert result["count"] == 0
