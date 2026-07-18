from typing import Optional

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.auth import User
from app.services.auth_service import decode_token, SESSION_COOKIE_NAME


def get_current_user(
    pt_session: Optional[str] = Cookie(None, alias=SESSION_COOKIE_NAME),
    db: Session = Depends(get_db),
) -> User:
    if not pt_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_token(pt_session)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    return user


# ── Account-level authorization ───────────────────────────────────────────────

def get_user_account_ids(user: User, db: Session) -> Optional[list[int]]:
    """
    Return the list of account IDs accessible to *user*, or None for admins
    (unrestricted).  Non-admin users are scoped to their assigned clients'
    accounts via the user_clients join table.
    """
    if user.role == "admin":
        return None  # no restriction

    from app.models.clients import UserClient
    from app.models.master import Account

    client_ids = [
        lnk.client_id
        for lnk in db.query(UserClient).filter(UserClient.user_id == user.id).all()
    ]
    if not client_ids:
        return []   # user has no clients → can see nothing

    accounts = (
        db.query(Account.id)
        .filter(Account.client_id.in_(client_ids))
        .all()
    )
    return [a.id for a in accounts]


def authorize_account_ids(
    requested_ids: list[int],
    user: User,
    db: Session,
) -> list[int]:
    """
    Validate that every ID in *requested_ids* is accessible to *user*.
    Admins pass through unchanged.  For regular users, any ID that doesn't
    belong to them raises HTTP 403.
    Returns the validated list.
    """
    allowed = get_user_account_ids(user, db)
    if allowed is None:
        return requested_ids   # admin — unrestricted

    allowed_set = set(allowed)
    forbidden = [i for i in requested_ids if i not in allowed_set]
    if forbidden:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied to account ID(s): {forbidden}",
        )
    return requested_ids


def parse_account_ids(
    account_ids_str: Optional[str],
    user: User,
    db: Session,
) -> Optional[list[int]]:
    """
    Parse a comma-separated account_ids query string and authorize it.

    * If account_ids_str is None → return the user's full allowed list
      (or None for admins, meaning "no filter / all accounts").
    * If account_ids_str is provided → parse, authorize, return the list.

    Use this in every endpoint that accepts an account_ids query param.
    """
    if account_ids_str:
        ids = [int(x.strip()) for x in account_ids_str.split(",") if x.strip().isdigit()]
        return authorize_account_ids(ids, user, db)

    # No filter supplied — default to the user's own accounts
    return get_user_account_ids(user, db)   # None for admin = unrestricted
