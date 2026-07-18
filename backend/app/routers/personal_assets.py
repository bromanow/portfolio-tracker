"""
Multi-asset net worth — real estate, life insurance, other misc assets, and liabilities
(e.g. a mortgage owed), tracked alongside brokerage holdings so the Dashboard's Net Worth
figure covers more than just investments.

Reuses the existing Security/Transaction/MarketPrice pipeline exactly like the
MORTGAGE/STRUCTURED_NOTE/SAVINGS_ACCOUNT precedent already does for private mortgage lending
and structured notes: quantity=1 forever, current value tracked via MarketPrice (negative for
LIABILITY), updated over time through the same manual-price mechanism Admin -> Prices already
uses. PersonalAssetDetails carries the descriptive detail (address, policy number, linked
asset/liability, corporate-ownership flag, PDF attachment) on top of that valuation.
"""
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.master import Brokerage, Account, Security, PersonalAssetDetails, PersonalAssetIncomeEntry
from app.models.transactions import Transaction
from app.services import personal_asset_document_store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/personal-assets", tags=["personal-assets"])

ASSET_CLASSES = {"REAL_ESTATE", "LIFE_INSURANCE", "OTHER_ASSET", "LIABILITY"}
PERSONAL_BROKERAGE_CODE = "PERSONAL"
PERSONAL_BROKERAGE_NAME = "Personal Assets"


def _slugify(name: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in name.strip().upper())
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "ASSET"


def _get_or_create_personal_brokerage(db: Session) -> Brokerage:
    b = db.query(Brokerage).filter(Brokerage.code == PERSONAL_BROKERAGE_CODE).first()
    if b:
        return b
    b = Brokerage(name=PERSONAL_BROKERAGE_NAME, code=PERSONAL_BROKERAGE_CODE, active=True)
    db.add(b)
    db.flush()
    return b


def _get_or_create_owner_account(db: Session, owner: str) -> Account:
    brokerage = _get_or_create_personal_brokerage(db)
    name = f"{owner} Personal Assets"
    acct = db.query(Account).filter(
        Account.brokerage_id == brokerage.id, Account.owner == owner,
    ).first()
    if acct:
        return acct
    acct = Account(
        brokerage_id=brokerage.id, name=name, account_type="OTHER",
        base_currency="CAD", owner=owner, active=True,
    )
    db.add(acct)
    db.flush()
    return acct


class PersonalAssetCreate(BaseModel):
    asset_class: str
    name: str
    owner: str
    value: Decimal   # positive for assets, positive amount owed for LIABILITY (sign flipped internally)
    acquired_date: Optional[date] = None
    interest_rate: Optional[Decimal] = None
    property_type: Optional[str] = None
    property_address: Optional[str] = None
    purchase_date: Optional[date] = None
    purchase_price: Optional[Decimal] = None
    policy_number: Optional[str] = None
    insurer_name: Optional[str] = None
    beneficiary: Optional[str] = None
    death_benefit_cad: Optional[Decimal] = None
    lender_name: Optional[str] = None
    original_principal_cad: Optional[Decimal] = None
    maturity_date: Optional[date] = None
    linked_security_id: Optional[int] = None
    is_corporate: bool = False
    entity_name: Optional[str] = None
    zillow_estimate_cad: Optional[Decimal] = None
    zillow_estimate_date: Optional[date] = None
    notes: Optional[str] = None


class PersonalAssetUpdate(BaseModel):
    value: Optional[Decimal] = None
    interest_rate: Optional[Decimal] = None
    property_type: Optional[str] = None
    property_address: Optional[str] = None
    purchase_date: Optional[date] = None
    purchase_price: Optional[Decimal] = None
    policy_number: Optional[str] = None
    insurer_name: Optional[str] = None
    beneficiary: Optional[str] = None
    death_benefit_cad: Optional[Decimal] = None
    lender_name: Optional[str] = None
    original_principal_cad: Optional[Decimal] = None
    maturity_date: Optional[date] = None
    linked_security_id: Optional[int] = None
    is_corporate: Optional[bool] = None
    entity_name: Optional[str] = None
    zillow_estimate_cad: Optional[Decimal] = None
    zillow_estimate_date: Optional[date] = None
    notes: Optional[str] = None


def _set_value(db: Session, security: Security, signed_value: Decimal) -> None:
    """Set MarketPrice (+ historical_prices row for today) for this security — CAD only,
    mirrors prices.py's set_manual_price for the single-security case."""
    from app.models.prices import MarketPrice, HistoricalPrice

    today = date.today()
    now = datetime.utcnow()
    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security.id).first()
    if mp:
        mp.price = signed_value
        mp.currency = "CAD"
        mp.price_cad = signed_value
        mp.price_date = today
        mp.fetched_at = now
        mp.source = "manual"
        mp.day_change = None
        mp.day_change_pct = None
    else:
        db.add(MarketPrice(
            security_id=security.id, price=signed_value, currency="CAD",
            price_cad=signed_value, price_date=today, fetched_at=now, source="manual",
        ))

    hist = db.query(HistoricalPrice).filter(
        HistoricalPrice.security_id == security.id, HistoricalPrice.price_date == today,
    ).first()
    if hist:
        hist.close_price = signed_value
        hist.close_price_cad = signed_value
        hist.currency = "CAD"
        hist.source = "manual"
    else:
        db.add(HistoricalPrice(
            security_id=security.id, price_date=today, close_price=signed_value,
            close_price_cad=signed_value, currency="CAD", source="manual",
        ))


def _details_to_dict(row: Optional[PersonalAssetDetails], linked_name: Optional[str] = None) -> dict:
    if row is None:
        return {
            "property_type": None, "property_address": None, "purchase_date": None,
            "purchase_price": None, "policy_number": None, "insurer_name": None,
            "beneficiary": None, "death_benefit_cad": None, "lender_name": None,
            "original_principal_cad": None, "maturity_date": None,
            "linked_security_id": None, "linked_name": None,
            "is_corporate": False, "entity_name": None,
            "zillow_estimate_cad": None, "zillow_estimate_date": None, "notes": None,
            "original_filename": None, "content_type": None, "byte_size": None, "uploaded_at": None,
        }
    return {
        "property_type": row.property_type,
        "property_address": row.property_address,
        "purchase_date": row.purchase_date.isoformat() if row.purchase_date else None,
        "purchase_price": str(row.purchase_price) if row.purchase_price is not None else None,
        "policy_number": row.policy_number,
        "insurer_name": row.insurer_name,
        "beneficiary": row.beneficiary,
        "death_benefit_cad": str(row.death_benefit_cad) if row.death_benefit_cad is not None else None,
        "lender_name": row.lender_name,
        "original_principal_cad": str(row.original_principal_cad) if row.original_principal_cad is not None else None,
        "maturity_date": row.maturity_date.isoformat() if row.maturity_date else None,
        "linked_security_id": row.linked_security_id,
        "linked_name": linked_name,
        "is_corporate": row.is_corporate,
        "entity_name": row.entity_name,
        "zillow_estimate_cad": str(row.zillow_estimate_cad) if row.zillow_estimate_cad is not None else None,
        "zillow_estimate_date": row.zillow_estimate_date.isoformat() if row.zillow_estimate_date else None,
        "notes": row.notes,
        "original_filename": row.original_filename,
        "content_type": row.content_type,
        "byte_size": row.byte_size,
        "uploaded_at": row.uploaded_at.isoformat() if row.uploaded_at else None,
    }


def _find_linked_name(db: Session, security_id: int) -> Optional[str]:
    """Resolve the OTHER side of a linked pair, checking both directions: first this
    security's own linked_security_id, then any other row that points AT this security."""
    own = db.query(PersonalAssetDetails).filter(PersonalAssetDetails.security_id == security_id).first()
    other_id = own.linked_security_id if own else None
    if not other_id:
        other = db.query(PersonalAssetDetails).filter(PersonalAssetDetails.linked_security_id == security_id).first()
        other_id = other.security_id if other else None
    if not other_id:
        return None
    other_sec = db.get(Security, other_id)
    return other_sec.name if other_sec else None


@router.get("")
def list_personal_assets(db: Session = Depends(get_db)):
    from app.models.prices import MarketPrice

    secs = db.query(Security).filter(Security.asset_class.in_(ASSET_CLASSES)).all()
    if not secs:
        return []
    sec_ids = [s.id for s in secs]
    mp_map = {mp.security_id: mp for mp in db.query(MarketPrice).filter(MarketPrice.security_id.in_(sec_ids)).all()}
    details_map = {d.security_id: d for d in db.query(PersonalAssetDetails).filter(PersonalAssetDetails.security_id.in_(sec_ids)).all()}

    # account/owner lookup for display
    txns = db.query(Transaction).filter(
        Transaction.security_id.in_(sec_ids), Transaction.transaction_type == "OPENING_BALANCE",
    ).all()
    acct_by_sec = {t.security_id: t.account for t in txns if t.account}

    out = []
    for sec in secs:
        mp = mp_map.get(sec.id)
        details = details_map.get(sec.id)
        acct = acct_by_sec.get(sec.id)
        out.append({
            "security_id": sec.id,
            "ticker": sec.ticker,
            "name": sec.name,
            "asset_class": sec.asset_class,
            "interest_rate": str(sec.interest_rate) if sec.interest_rate is not None else None,
            "owner": acct.owner if acct else None,
            "current_value_cad": str(mp.price_cad) if mp and mp.price_cad is not None else None,
            "value_updated_at": mp.fetched_at.isoformat() if mp and mp.fetched_at else None,
            **_details_to_dict(details, _find_linked_name(db, sec.id)),
        })
    return out


@router.post("", status_code=201)
def create_personal_asset(data: PersonalAssetCreate, db: Session = Depends(get_db)):
    if data.asset_class not in ASSET_CLASSES:
        raise HTTPException(status_code=400, detail=f"asset_class must be one of {sorted(ASSET_CLASSES)}")

    acct = _get_or_create_owner_account(db, data.owner)

    ticker = f"PA:{_slugify(data.name)}"
    security = db.query(Security).filter(Security.ticker == ticker).first()
    if security:
        raise HTTPException(status_code=400, detail=f"A personal asset named '{data.name}' already exists.")
    security = Security(
        ticker=ticker, name=data.name, asset_class=data.asset_class,
        currency="CAD", interest_rate=data.interest_rate,
    )
    db.add(security)
    db.flush()

    signed_value = data.value if data.asset_class != "LIABILITY" else -abs(data.value)
    acquired = data.acquired_date or date.today()

    db.add(Transaction(
        account_id=acct.id, security_id=security.id,
        transaction_date=acquired, settlement_date=acquired,
        transaction_type="OPENING_BALANCE", quantity=Decimal("1"), price=signed_value,
        commission=Decimal("0"), transaction_currency="CAD",
        transaction_amount=signed_value, account_currency_amount=signed_value,
        cad_amount=signed_value, fx_rate_to_account=Decimal("1"), fx_rate_to_cad=Decimal("1"),
        notes="Personal asset entered manually", tags=["personal_asset"],
        is_manual_override=True, is_verified=True,
    ))

    _set_value(db, security, signed_value)

    details = PersonalAssetDetails(
        security_id=security.id,
        property_type=data.property_type, property_address=data.property_address,
        purchase_date=data.purchase_date, purchase_price=data.purchase_price,
        policy_number=data.policy_number, insurer_name=data.insurer_name,
        beneficiary=data.beneficiary, death_benefit_cad=data.death_benefit_cad,
        lender_name=data.lender_name, original_principal_cad=data.original_principal_cad,
        maturity_date=data.maturity_date, linked_security_id=data.linked_security_id,
        is_corporate=data.is_corporate, entity_name=data.entity_name,
        zillow_estimate_cad=data.zillow_estimate_cad, zillow_estimate_date=data.zillow_estimate_date,
        notes=data.notes,
    )
    db.add(details)
    db.commit()

    return {"security_id": security.id, "ticker": ticker}


@router.put("/{security_id}")
def update_personal_asset(security_id: int, data: PersonalAssetUpdate, db: Session = Depends(get_db)):
    security = db.get(Security, security_id)
    if not security or security.asset_class not in ASSET_CLASSES:
        raise HTTPException(status_code=404, detail="Personal asset not found")

    if data.value is not None:
        signed_value = data.value if security.asset_class != "LIABILITY" else -abs(data.value)
        _set_value(db, security, signed_value)

    if data.interest_rate is not None:
        security.interest_rate = data.interest_rate

    details = db.query(PersonalAssetDetails).filter(PersonalAssetDetails.security_id == security_id).first()
    if details is None:
        details = PersonalAssetDetails(security_id=security_id)
        db.add(details)

    updates = data.model_dump(exclude_unset=True, exclude={"value", "interest_rate"})
    for field, val in updates.items():
        setattr(details, field, val)

    db.commit()
    return {"security_id": security_id}


# ── PDF attachment ─────────────────────────────────────────────────────────────

@router.post("/{security_id}/file")
async def upload_personal_asset_file(security_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    security = db.get(Security, security_id)
    if not security or security.asset_class not in ASSET_CLASSES:
        raise HTTPException(status_code=404, detail="Personal asset not found")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF.")

    data = await file.read()
    row = db.query(PersonalAssetDetails).filter(PersonalAssetDetails.security_id == security_id).first()
    if row is None:
        row = PersonalAssetDetails(security_id=security_id)
        db.add(row)
    elif row.stored_filename:
        personal_asset_document_store.remove(row.stored_filename)

    stored = personal_asset_document_store.stored_name(file.filename or "document.pdf")
    personal_asset_document_store.save(stored, data)
    row.stored_filename = stored
    row.original_filename = file.filename
    row.content_type = file.content_type or "application/pdf"
    row.byte_size = len(data)
    row.uploaded_at = datetime.utcnow()
    db.commit()
    return {"original_filename": row.original_filename, "byte_size": row.byte_size}


@router.get("/{security_id}/file")
def view_personal_asset_file(security_id: int, db: Session = Depends(get_db)):
    import os
    row = db.query(PersonalAssetDetails).filter(PersonalAssetDetails.security_id == security_id).first()
    if not row or not row.stored_filename:
        raise HTTPException(status_code=404, detail="No document on file for this asset.")
    fp = personal_asset_document_store.path_for(row.stored_filename)
    if not os.path.exists(fp):
        raise HTTPException(status_code=404, detail="File missing on disk (was the storage volume reset?).")
    return FileResponse(
        fp, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{row.original_filename or "document.pdf"}"'},
    )


@router.delete("/{security_id}/file")
def delete_personal_asset_file(security_id: int, db: Session = Depends(get_db)):
    row = db.query(PersonalAssetDetails).filter(PersonalAssetDetails.security_id == security_id).first()
    if row and row.stored_filename:
        personal_asset_document_store.remove(row.stored_filename)
        row.stored_filename = None
        row.original_filename = None
        row.content_type = None
        row.byte_size = None
        row.uploaded_at = None
        db.commit()
    return {"message": "Document removed"}


# ── Rental income/expense ledger ────────────────────────────────────────────────

class IncomeEntryCreate(BaseModel):
    entry_date: date
    category: str  # RENT / EXPENSE / OTHER_INCOME
    amount_cad: Decimal
    description: Optional[str] = None


@router.get("/{security_id}/income-entries")
def list_income_entries(security_id: int, db: Session = Depends(get_db)):
    rows = (
        db.query(PersonalAssetIncomeEntry)
        .filter(PersonalAssetIncomeEntry.security_id == security_id)
        .order_by(PersonalAssetIncomeEntry.entry_date.desc())
        .all()
    )
    return [
        {
            "id": r.id, "entry_date": r.entry_date.isoformat(), "category": r.category,
            "amount_cad": str(r.amount_cad), "description": r.description,
        }
        for r in rows
    ]


@router.post("/{security_id}/income-entries", status_code=201)
def create_income_entry(security_id: int, data: IncomeEntryCreate, db: Session = Depends(get_db)):
    security = db.get(Security, security_id)
    if not security or security.asset_class != "REAL_ESTATE":
        raise HTTPException(status_code=404, detail="Real estate asset not found")
    if data.category not in ("RENT", "EXPENSE", "OTHER_INCOME"):
        raise HTTPException(status_code=400, detail="category must be RENT, EXPENSE, or OTHER_INCOME")

    entry = PersonalAssetIncomeEntry(
        security_id=security_id, entry_date=data.entry_date,
        category=data.category, amount_cad=data.amount_cad, description=data.description,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id}


@router.delete("/{security_id}/income-entries/{entry_id}")
def delete_income_entry(security_id: int, entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(PersonalAssetIncomeEntry).filter(
        PersonalAssetIncomeEntry.id == entry_id, PersonalAssetIncomeEntry.security_id == security_id,
    ).first()
    if entry:
        db.delete(entry)
        db.commit()
    return {"message": "Entry removed"}
