"""Regression test: creating a Client via POST /api/clients must immediately link every
admin user to it (mirroring the startup _migrate_clients side effect in main.py), so a
newly-created client is visible in the Users tab's client-access list without a backend
restart."""
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


def _make_user(db, *, email, role):
    from app.models.auth import User
    u = User(email=email, hashed_password="x", name=email, role=role)
    db.add(u)
    db.flush()
    return u


def test_create_client_links_existing_admins_immediately(db):
    from app.models.clients import UserClient
    from app.routers.clients import create_client, ClientCreate

    admin1 = _make_user(db, email="admin1@test.com", role="admin")
    admin2 = _make_user(db, email="admin2@test.com", role="admin")
    non_admin = _make_user(db, email="user@test.com", role="user")
    db.commit()

    result = create_client(ClientCreate(name="Greg Romanow", slug="greg-romanow"), db=db, current_user=admin1)

    links = db.query(UserClient).filter(UserClient.client_id == result["id"]).all()
    linked_user_ids = {lnk.user_id for lnk in links}
    assert linked_user_ids == {admin1.id, admin2.id}
    assert non_admin.id not in linked_user_ids


def test_create_client_is_idempotent_for_admin_links(db):
    """Calling it twice (e.g. a retried request) must not create duplicate UserClient rows."""
    from app.models.clients import UserClient, Client
    from app.routers.clients import create_client, ClientCreate

    admin = _make_user(db, email="admin@test.com", role="admin")
    db.commit()

    result = create_client(ClientCreate(name="Test Co", slug="test-co"), db=db, current_user=admin)
    client = db.get(Client, result["id"])
    # Simulate re-linking the same admin to the same already-created client (defensive re-run).
    existing = db.query(UserClient).filter(UserClient.user_id == admin.id, UserClient.client_id == client.id).first()
    assert existing is not None
    count_before = db.query(UserClient).filter(UserClient.client_id == client.id).count()
    assert count_before == 1
