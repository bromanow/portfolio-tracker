from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional
from app.database import get_db
from app.models.clients import Client, UserClient
from app.models.auth import User
from app.dependencies import get_current_user

router = APIRouter(prefix="/api/clients", tags=["clients"])


class ClientCreate(BaseModel):
    name: str
    slug: str
    active: bool = True
    is_demo: bool = False


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    slug: Optional[str] = None
    active: Optional[bool] = None
    is_demo: Optional[bool] = None


def client_to_dict(c: Client) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "slug": c.slug,
        "active": c.active,
        "is_demo": c.is_demo,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


@router.get("")
def list_clients(
    include_demo: bool = Query(False, description="Include sample/demo clients (Admin management screens only)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role == "admin":
        q = db.query(Client)
        if not include_demo:
            q = q.filter(Client.is_demo == False)  # noqa: E712
        clients = q.order_by(Client.name).all()
    else:
        links = db.query(UserClient).filter(UserClient.user_id == current_user.id).all()
        client_ids = [lnk.client_id for lnk in links]
        clients = db.query(Client).filter(Client.id.in_(client_ids)).order_by(Client.name).all()
    return [client_to_dict(c) for c in clients]


@router.post("", status_code=201)
def create_client(
    data: ClientCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if db.query(Client).filter(Client.slug == data.slug).first():
        raise HTTPException(status_code=400, detail="Slug already exists")
    client = Client(**data.model_dump())
    db.add(client)
    db.commit()
    db.refresh(client)
    return client_to_dict(client)


@router.get("/{client_id}")
def get_client(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    # Non-admins can only see their own clients
    if current_user.role != "admin":
        link = db.query(UserClient).filter(
            UserClient.user_id == current_user.id,
            UserClient.client_id == client_id,
        ).first()
        if not link:
            raise HTTPException(status_code=403, detail="Access denied")
    return client_to_dict(client)


@router.put("/{client_id}")
def update_client(
    client_id: int,
    data: ClientUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(client, field, value)
    db.commit()
    db.refresh(client)
    return client_to_dict(client)
