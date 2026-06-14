"""Plaid endpoints.

  GET    /api/plaid/status              — whether Plaid is configured + the env
  POST   /api/plaid/link-token          — create a Link token for the Connect widget
  POST   /api/plaid/exchange            — exchange public_token → store Item + first sync
  GET    /api/plaid/items               — list connected institutions
  POST   /api/plaid/items/{id}/sync     — re-sync one Item's holdings
  POST   /api/plaid/sync                — re-sync every connected Item
  DELETE /api/plaid/items/{id}          — disconnect an Item
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.plaid import PlaidItem, PlaidAccount
from app.services import plaid_service as plaid

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/plaid", tags=["plaid"])


class ExchangeBody(BaseModel):
    public_token: str
    owner: str = "Unknown"


class LinkTokenBody(BaseModel):
    user_id: str = "portfolio-user"


def _require_configured():
    if not plaid.is_configured():
        raise HTTPException(503, "Plaid is not configured (set PLAID_CLIENT_ID / PLAID_SECRET).")


@router.get("/status")
def status():
    return {"configured": plaid.is_configured(), "env": plaid.PLAID_ENV}


@router.post("/link-token")
def link_token(body: LinkTokenBody):
    _require_configured()
    try:
        return {"link_token": plaid.create_link_token(body.user_id)}
    except plaid.PlaidError as e:
        raise HTTPException(502, f"{e.code}: {e.message}")


@router.post("/exchange")
def exchange(body: ExchangeBody, db: Session = Depends(get_db)):
    _require_configured()
    try:
        access_token, item_id = plaid.exchange_public_token(body.public_token)
    except plaid.PlaidError as e:
        raise HTTPException(502, f"{e.code}: {e.message}")

    item = db.query(PlaidItem).filter(PlaidItem.item_id == item_id).first()
    if not item:
        inst_id, inst_name = plaid.get_institution(access_token)
        item = PlaidItem(item_id=item_id, access_token=plaid.encrypt_token(access_token),
                         institution_id=inst_id, institution_name=inst_name)
        db.add(item)
        db.commit()
        db.refresh(item)
    else:
        item.access_token = plaid.encrypt_token(access_token)
        db.commit()

    try:
        summary = plaid.sync_item(db, item, owner=body.owner)
    except plaid.PlaidError as e:
        raise HTTPException(502, f"{e.code}: {e.message}")
    return {"item_id": item.item_id, "institution": item.institution_name, "synced": summary}


@router.post("/sandbox-create")
def sandbox_create(body: ExchangeBody, db: Session = Depends(get_db)):
    """Sandbox only: create an investments test Item without the Link UI, then sync.
    (Link's returning-user phone flow in Sandbox only offers depository test banks.)"""
    _require_configured()
    try:
        public_token = plaid.create_sandbox_public_token()
        access_token, item_id = plaid.exchange_public_token(public_token)
    except plaid.PlaidError as e:
        raise HTTPException(502, f"{e.code}: {e.message}")

    item = db.query(PlaidItem).filter(PlaidItem.item_id == item_id).first()
    if not item:
        inst_id, inst_name = plaid.get_institution(access_token)
        item = PlaidItem(item_id=item_id, access_token=plaid.encrypt_token(access_token),
                         institution_id=inst_id, institution_name=inst_name or "Sandbox Investments")
        db.add(item)
        db.commit()
        db.refresh(item)
    else:
        item.access_token = plaid.encrypt_token(access_token)
        db.commit()

    try:
        summary = plaid.sync_item(db, item, owner=body.owner)
    except plaid.PlaidError as e:
        raise HTTPException(502, f"{e.code}: {e.message}")
    return {"item_id": item.item_id, "institution": item.institution_name, "synced": summary}


@router.get("/items")
def list_items(db: Session = Depends(get_db)):
    out = []
    for it in db.query(PlaidItem).order_by(PlaidItem.created_at.desc()).all():
        n_accts = db.query(PlaidAccount).filter(PlaidAccount.plaid_item_id == it.id).count()
        out.append({
            "id": it.id,
            "institution": it.institution_name,
            "accounts": n_accts,
            "last_synced_at": it.last_synced_at.isoformat() if it.last_synced_at else None,
        })
    return out


@router.post("/items/{item_id}/sync")
def sync_one(item_id: int, db: Session = Depends(get_db)):
    _require_configured()
    item = db.get(PlaidItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    try:
        return plaid.sync_item(db, item)
    except plaid.PlaidError as e:
        raise HTTPException(502, f"{e.code}: {e.message}")


@router.post("/sync")
def sync_all(db: Session = Depends(get_db)):
    _require_configured()
    results = []
    for item in db.query(PlaidItem).all():
        try:
            results.append({"item_id": item.item_id, **plaid.sync_item(db, item)})
        except plaid.PlaidError as e:
            results.append({"item_id": item.item_id, "error": f"{e.code}: {e.message}"})
        except Exception as e:
            db.rollback()
            logger.exception("Plaid sync crashed for item %s", item.item_id)
            results.append({"item_id": item.item_id, "error": f"{type(e).__name__}: {e}"[:300]})
    return {"items": results}


@router.delete("/items/{item_id}")
def delete_item(item_id: int, db: Session = Depends(get_db)):
    item = db.get(PlaidItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    # Best-effort: tell Plaid to remove the Item too (stops any billing).
    try:
        plaid._post("/item/remove", {"access_token": plaid.decrypt_token(item.access_token)})
    except Exception as e:
        logger.warning("Plaid item remove failed (continuing): %s", e)
    db.query(PlaidAccount).filter(PlaidAccount.plaid_item_id == item.id).delete()
    db.delete(item)
    db.commit()
    return {"deleted": item_id}
