"""Regression tests: personal_assets.py (Real Estate, Life Insurance, Other Assets,
Liabilities) had NO auth or client-scoping at all — any logged-in user, including a
non-admin scoped to one client, could list/read/write every other owner's personal
assets. Fixed via get_user_account_ids() scoping on reads and an owner/client check
on create; these tests cover a non-admin's view being correctly restricted and an
admin's being unrestricted.
"""
from datetime import date
from decimal import Decimal as D

import pytest
from fastapi import HTTPException
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


def _make_client_and_link(db, *, name, user=None):
    from app.models.clients import Client, UserClient
    client = Client(name=name, slug=name.lower().replace(" ", "-"))
    db.add(client)
    db.flush()
    if user is not None:
        db.add(UserClient(user_id=user.id, client_id=client.id, role="user"))
        db.flush()
    return client


def _create_personal_asset(db, *, owner, name, value, current_user):
    from app.routers.personal_assets import create_personal_asset, PersonalAssetCreate
    return create_personal_asset(
        PersonalAssetCreate(asset_class="OTHER_ASSET", name=name, owner=owner, value=D(value)),
        db=db, current_user=current_user,
    )


def test_non_admin_only_sees_own_client_assets(db):
    from app.routers.personal_assets import list_personal_assets
    from app.models.master import Account

    admin = _make_user(db, email="admin@test.com", role="admin")
    greg_client = _make_client_and_link(db, name="Greg Romanow")
    brian_client = _make_client_and_link(db, name="Brian Romanow")
    greg_user = _make_user(db, email="greg@test.com", role="user")
    db.add_all([])
    from app.models.clients import UserClient
    db.add(UserClient(user_id=greg_user.id, client_id=greg_client.id, role="user"))
    db.commit()

    _create_personal_asset(db, owner="Greg Romanow", name="Greg's GCV.V", value="60000", current_user=admin)
    _create_personal_asset(db, owner="Brian Romanow", name="Brian's cottage", value="500000", current_user=admin)

    # link the two owner accounts to their clients (mirrors _migrate_clients backfill)
    db.query(Account).filter(Account.owner == "Greg Romanow").update({"client_id": greg_client.id})
    db.query(Account).filter(Account.owner == "Brian Romanow").update({"client_id": brian_client.id})
    db.commit()

    greg_view = list_personal_assets(db=db, current_user=greg_user)
    assert {a["owner"] for a in greg_view} == {"Greg Romanow"}

    admin_view = list_personal_assets(db=db, current_user=admin)
    assert {a["owner"] for a in admin_view} == {"Greg Romanow", "Brian Romanow"}


def test_non_admin_cannot_create_asset_for_another_owner(db):
    from app.routers.personal_assets import create_personal_asset, PersonalAssetCreate

    greg_client = None
    greg_user = _make_user(db, email="greg@test.com", role="user")
    _make_client_and_link(db, name="Greg Romanow", user=greg_user)
    _make_client_and_link(db, name="Brian Romanow")
    db.commit()

    with pytest.raises(HTTPException) as exc:
        create_personal_asset(
            PersonalAssetCreate(asset_class="OTHER_ASSET", name="x", owner="Brian Romanow", value=D("1000")),
            db=db, current_user=greg_user,
        )
    assert exc.value.status_code == 403


def test_non_admin_can_create_asset_for_own_client(db):
    from app.routers.personal_assets import create_personal_asset, PersonalAssetCreate

    greg_user = _make_user(db, email="greg@test.com", role="user")
    _make_client_and_link(db, name="Greg Romanow", user=greg_user)
    db.commit()

    result = create_personal_asset(
        PersonalAssetCreate(asset_class="OTHER_ASSET", name="x", owner="Greg Romanow", value=D("1000")),
        db=db, current_user=greg_user,
    )
    assert result["security_id"] is not None


def test_non_admin_cannot_update_or_delete_another_owners_asset(db):
    from app.routers.personal_assets import (
        update_personal_asset, delete_personal_asset, PersonalAssetUpdate,
    )
    from app.models.master import Account

    admin = _make_user(db, email="admin@test.com", role="admin")
    greg_user = _make_user(db, email="greg@test.com", role="user")
    greg_client = _make_client_and_link(db, name="Greg Romanow", user=greg_user)
    brian_client = _make_client_and_link(db, name="Brian Romanow")
    db.commit()

    brian_asset = _create_personal_asset(db, owner="Brian Romanow", name="Brian's cottage", value="500000", current_user=admin)
    db.query(Account).filter(Account.owner == "Brian Romanow").update({"client_id": brian_client.id})
    db.query(Account).filter(Account.owner == "Greg Romanow").update({"client_id": greg_client.id})
    db.commit()

    with pytest.raises(HTTPException) as exc:
        update_personal_asset(brian_asset["security_id"], PersonalAssetUpdate(name="renamed"), db=db, current_user=greg_user)
    assert exc.value.status_code == 403

    with pytest.raises(HTTPException) as exc:
        delete_personal_asset(brian_asset["security_id"], db=db, current_user=greg_user)
    assert exc.value.status_code == 403
