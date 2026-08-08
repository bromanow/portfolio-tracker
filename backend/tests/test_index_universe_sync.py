"""Tests for the quarterly index-universe sync (reconcile + normalization).

The network scrape is injected, so these run offline and exercise the reconcile logic that
actually touches the DB: add new constituents, drop departed ones, and — critically — never
touch user-added screener names.
"""
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
    from app.models.master import Security
    from app.database import Base

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine, tables=[Security.__table__])
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _flags(db, ticker):
    from app.models.master import Security
    s = db.query(Security).filter(Security.ticker == ticker).first()
    return None if s is None else (s.index_member, s.in_screener_universe)


def test_normalization():
    from app.services.index_universe_service import _norm_us, _norm_ca
    assert _norm_us("BRK.B") == "BRK-B"      # class share dot → dash
    assert _norm_us(" aapl ") == "AAPL"
    assert _norm_ca("SHOP.TO") == "SHOP"     # TSX suffix stripped
    assert _norm_ca("ry") == "RY"


def test_sync_adds_drops_and_preserves_user_names(db):
    from app.models.master import Security
    from app.services.index_universe_service import sync_index_universe

    # Pre-existing state: OLDCO is a former index member; PLTR is a user-added screener name.
    db.add(Security(ticker="OLDCO", currency="USD", asset_class="EQUITY",
                    index_member=True, in_screener_universe=True))
    db.add(Security(ticker="PLTR", currency="USD", asset_class="EQUITY",
                    index_member=False, in_screener_universe=True))
    db.commit()

    def fake_fetch():
        return {"AAPL", "MSFT"}, {"RY"}   # OLDCO no longer in either index

    summary = sync_index_universe(db, fetch=fake_fetch)

    # New constituents added + flagged
    assert _flags(db, "AAPL") == (True, True)
    assert _flags(db, "RY") == (True, True)
    # Departed constituent dropped from both flags, row kept
    assert _flags(db, "OLDCO") == (False, False)
    # User-added name untouched
    assert _flags(db, "PLTR") == (False, True)

    assert "OLDCO" in summary["dropped"]
    assert set(summary["added"]) == {"AAPL", "MSFT", "RY"}


def test_broken_scrape_aborts_without_db_changes(db):
    from app.models.master import Security
    from app.services.index_universe_service import sync_index_universe, fetch_index_constituents

    db.add(Security(ticker="AAPL", currency="USD", asset_class="EQUITY",
                    index_member=True, in_screener_universe=True))
    db.commit()

    def broken_fetch():
        # Mirror the real fetch's plausibility guard: too few names → raise, no DB writes.
        us, ca = {"AAPL"}, {"RY"}
        raise ValueError("S&P 500 scrape returned only 1 names")

    with pytest.raises(ValueError):
        sync_index_universe(db, fetch=broken_fetch)

    # Universe untouched — AAPL still flagged, nothing dropped.
    assert _flags(db, "AAPL") == (True, True)
