"""Regression tests for build_candidate_universe (data-driven covered-call universe).

The original bug: the query filtered on a non-existent `Security.active` column, so the
screen/propose background job crashed instantly with AttributeError. Building the query
against the real model (below) exercises every column reference and catches that class of
bug before it ships.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def universe_db():
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
    from app.models.master import Security, SecurityFundamentals
    from app.database import Base

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine, tables=[Security.__table__, SecurityFundamentals.__table__])
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session, Security, SecurityFundamentals
    finally:
        session.close()
        engine.dispose()


def _add(session, Security, Fund, ticker, currency, av, beta, dy, in_universe=True):
    s = Security(ticker=ticker, name=ticker, currency=currency,
                 asset_class="EQUITY", in_screener_universe=in_universe)
    session.add(s)
    session.flush()
    session.add(Fund(security_id=s.id, avg_volume=av, beta=beta, dividend_yield=dy))
    return s


def test_build_candidate_universe_ranks_and_splits(universe_db):
    from app.services.covered_call_portfolio_service import build_candidate_universe
    session, Security, Fund = universe_db

    _add(session, Security, Fund, "AAA", "USD", 5_000_000, 1.4, 2.0)
    _add(session, Security, Fund, "BBB", "USD", 3_000_000, 1.1, 1.0)
    _add(session, Security, Fund, "LOWVOL", "USD", 10_000, 1.0, 5.0)   # below liquidity floor → dropped
    _add(session, Security, Fund, "SKIP", "USD", 9_000_000, 1.5, 0.0, in_universe=False)  # not in universe
    _add(session, Security, Fund, "AEM", "CAD", 2_000_000, 1.2, 3.0)

    ca, us = build_candidate_universe(session, us_limit=10, ca_limit=10, min_avg_volume=250_000)

    # This call alone would have raised AttributeError on the old Security.active filter.
    assert "AAA" in us and "BBB" in us
    assert "LOWVOL" not in us          # liquidity floor
    assert "SKIP" not in us            # not in screener universe
    assert us[0] == "AAA"              # highest liquidity/beta → top of the list
    assert ca == ["AEM.TO"]            # CA ticker gets the .TO suffix


def test_build_candidate_universe_fallback_when_empty(universe_db):
    from app.services.covered_call_portfolio_service import build_candidate_universe
    from app.data.covered_call_universe import CA_CANDIDATES, US_CANDIDATES
    session, Security, Fund = universe_db

    ca, us = build_candidate_universe(session)   # no rows → curated static fallback
    assert us == list(US_CANDIDATES)
    assert ca == list(CA_CANDIDATES)
