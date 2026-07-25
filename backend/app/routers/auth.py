from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User
from app.models.clients import Client, UserClient
from app.services.auth_service import (
    verify_password, hash_password, create_access_token,
    SESSION_COOKIE_NAME, COOKIE_SECURE, ACCESS_TOKEN_EXPIRE_HOURS,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: str
    refresh_prices_on_login: bool = False
    notify_covered_call_alerts: bool = False

class PreferencesUpdate(BaseModel):
    refresh_prices_on_login: Optional[bool] = None
    notify_covered_call_alerts: Optional[bool] = None

class UserCreate(BaseModel):
    email: str
    name: str
    password: str
    role: str = "user"
    client_ids: List[int] = []

class UserUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    client_ids: Optional[List[int]] = None

class ResetPasswordRequest(BaseModel):
    new_password: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login")
def login(req: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.strip().lower()).first()
    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is disabled")

    user.last_login = datetime.utcnow()
    db.commit()

    # Best-effort: bring IBeam up so it's ready by the time anyone opens Options/Scanner.
    # A no-op if ibeam-control isn't deployed (IBEAM_CONTROL_URL unset) — see
    # app/services/ibeam_control.py. Backgrounded so login isn't slowed by container start.
    import threading
    from app.services import ibeam_control
    threading.Thread(target=ibeam_control.start, daemon=True).start()

    token = create_access_token(user.id, user.email)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return {
        "user": UserOut(
            id=user.id, email=user.email, name=user.name, role=user.role,
            refresh_prices_on_login=user.refresh_prices_on_login,
            notify_covered_call_alerts=user.notify_covered_call_alerts,
        ),
    }


@router.post("/logout")
def logout(response: Response, current_user: User = Depends(get_current_user)):
    """Clears the session cookie. JWTs are otherwise stateless (nothing to invalidate
    server-side) — this endpoint also gives the frontend a signal to stop IBeam on,
    matching 'only connect while logged in'. IBeam stop is best-effort and backgrounded;
    a no-op if ibeam-control isn't deployed."""
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
    import threading
    from app.services import ibeam_control
    threading.Thread(target=ibeam_control.stop, daemon=True).start()
    return {"message": "logged out"}


@router.get("/me", response_model=UserOut)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/me/preferences", response_model=UserOut)
def update_my_preferences(
    req: PreferencesUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Self-service preference update — tied to the account, not per-browser localStorage,
    so it stays consistent across devices/browsers (a purely local setting was silently
    resetting/desyncing with no visible warning)."""
    if req.refresh_prices_on_login is not None:
        current_user.refresh_prices_on_login = req.refresh_prices_on_login
    if req.notify_covered_call_alerts is not None:
        current_user.notify_covered_call_alerts = req.notify_covered_call_alerts
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(req.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    current_user.hashed_password = hash_password(req.new_password)
    db.commit()
    return {"message": "Password changed successfully"}


# ── User Management (admin only) ──────────────────────────────────────────────

def _user_to_dict(user: User, db: Session) -> dict:
    links = db.query(UserClient).filter(UserClient.user_id == user.id).all()
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_login": user.last_login.isoformat() if user.last_login else None,
        "client_ids": [lnk.client_id for lnk in links],
    }


def _set_user_clients(user_id: int, client_ids: List[int], db: Session):
    """Replace all client links for a user."""
    db.query(UserClient).filter(UserClient.user_id == user_id).delete()
    for cid in client_ids:
        db.add(UserClient(user_id=user_id, client_id=cid, role="user"))
    db.flush()


@router.get("/users")
def list_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    users = db.query(User).order_by(User.name).all()
    return [_user_to_dict(u, db) for u in users]


@router.post("/users", status_code=201)
def create_user(
    req: UserCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    email = req.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=400, detail="Email already in use")
    user = User(
        email=email,
        name=req.name.strip(),
        hashed_password=hash_password(req.password),
        role=req.role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    if req.role != "admin":
        _set_user_clients(user.id, req.client_ids, db)
    else:
        # Admin users get access to all clients automatically
        all_clients = db.query(Client).all()
        _set_user_clients(user.id, [c.id for c in all_clients], db)
    db.commit()
    db.refresh(user)
    return _user_to_dict(user, db)


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    req: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if req.name is not None:
        user.name = req.name.strip()
    if req.email is not None:
        user.email = req.email.strip().lower()
    if req.role is not None:
        user.role = req.role
    if req.is_active is not None:
        user.is_active = req.is_active
    if req.client_ids is not None:
        if user.role == "admin":
            # Admin users always have access to all clients
            all_clients = db.query(Client).all()
            _set_user_clients(user.id, [c.id for c in all_clients], db)
        else:
            _set_user_clients(user.id, req.client_ids, db)
    db.commit()
    db.refresh(user)
    return _user_to_dict(user, db)


@router.post("/users/{user_id}/reset-password")
def reset_user_password(
    user_id: int,
    req: ResetPasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.hashed_password = hash_password(req.new_password)
    db.commit()
    return {"message": f"Password reset for {user.email}"}
