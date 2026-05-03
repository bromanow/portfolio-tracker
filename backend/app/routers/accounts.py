from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.master import Account, Brokerage

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class AccountCreate(BaseModel):
    brokerage_id: int
    name: str
    account_number: Optional[str] = None
    account_type: str
    base_currency: str
    owner: str
    active: bool = True
    ibkr_alias: Optional[str] = None


class AccountUpdate(BaseModel):
    name: Optional[str] = None
    account_number: Optional[str] = None
    account_type: Optional[str] = None
    base_currency: Optional[str] = None
    owner: Optional[str] = None
    active: Optional[bool] = None
    ibkr_alias: Optional[str] = None


def account_to_dict(a: Account) -> dict:
    return {
        "id": a.id,
        "brokerage_id": a.brokerage_id,
        "brokerage_name": a.brokerage.name if a.brokerage else None,
        "brokerage_code": a.brokerage.code if a.brokerage else None,
        "advisor": a.brokerage.advisor if a.brokerage else None,
        "name": a.name,
        "account_number": a.account_number,
        "account_type": a.account_type,
        "base_currency": a.base_currency,
        "owner": a.owner,
        "active": a.active,
        "ibkr_alias": a.ibkr_alias,
        "returns_start_date": a.returns_start_date.isoformat() if a.returns_start_date else None,
    }


@router.get("")
def list_accounts(db: Session = Depends(get_db)):
    accounts = db.query(Account).join(Account.brokerage).order_by(Account.owner, Account.name).all()
    return [account_to_dict(a) for a in accounts]


@router.post("", status_code=201)
def create_account(data: AccountCreate, db: Session = Depends(get_db)):
    account = Account(**data.model_dump())
    db.add(account)
    db.commit()
    db.refresh(account)
    return account_to_dict(account)


@router.get("/{account_id}")
def get_account(account_id: int, db: Session = Depends(get_db)):
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return account_to_dict(account)


@router.put("/{account_id}")
def update_account(account_id: int, data: AccountUpdate, db: Session = Depends(get_db)):
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(account, field, value)
    db.commit()
    db.refresh(account)
    return account_to_dict(account)


class ReturnsStartDateUpdate(BaseModel):
    returns_start_date: Optional[date] = None  # None clears the custom date (reverts to auto)


@router.patch("/{account_id}/returns-start-date")
def set_returns_start_date(
    account_id: int,
    data: ReturnsStartDateUpdate,
    db: Session = Depends(get_db),
):
    """Set (or clear) a custom returns start date for one physical account.
    The performance/returns endpoint uses this date instead of the auto-computed effective inception."""
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    account.returns_start_date = data.returns_start_date
    db.commit()
    db.refresh(account)
    return account_to_dict(account)


@router.delete("/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db)):
    from app.models.transactions import Transaction
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    txn_count = db.query(Transaction).filter(Transaction.account_id == account_id).count()
    if txn_count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Account has {txn_count} transactions. Use force delete to remove both."
        )
    db.delete(account)
    db.commit()
    return {"deleted": account_id, "transactions_deleted": 0}


@router.delete("/{account_id}/force")
def force_delete_account(account_id: int, db: Session = Depends(get_db)):
    """Delete account AND all its transactions."""
    from app.models.transactions import Transaction
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    txn_count = db.query(Transaction).filter(Transaction.account_id == account_id).delete()
    db.delete(account)
    db.commit()
    return {"deleted": account_id, "transactions_deleted": txn_count}
