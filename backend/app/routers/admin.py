from decimal import Decimal
from typing import Optional
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.master import Brokerage, BrokerageTypeMapping, Currency, FXRate, Security, Account
from app.models.transactions import Transaction
from app.services import fx_service

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ─── Brokerages ────────────────────────────────────────────────────────────

def _brokerage_dict(b):
    return {"id": b.id, "name": b.name, "code": b.code, "active": b.active, "advisor": b.advisor}


@router.get("/brokerages")
def list_brokerages(db: Session = Depends(get_db)):
    return [_brokerage_dict(b) for b in db.query(Brokerage).all()]


class BrokerageCreate(BaseModel):
    name: str
    code: str
    active: bool = True
    advisor: Optional[str] = None


@router.post("/brokerages", status_code=201)
def create_brokerage(data: BrokerageCreate, db: Session = Depends(get_db)):
    existing = db.query(Brokerage).filter(Brokerage.code == data.code).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Brokerage code '{data.code}' already exists")
    b = Brokerage(**data.model_dump())
    db.add(b)
    db.commit()
    db.refresh(b)
    return _brokerage_dict(b)


@router.put("/brokerages/{brokerage_id}")
def update_brokerage(brokerage_id: int, data: BrokerageCreate, db: Session = Depends(get_db)):
    b = db.get(Brokerage, brokerage_id)
    if not b:
        raise HTTPException(status_code=404, detail="Brokerage not found")
    # Check code uniqueness (excluding self)
    dup = db.query(Brokerage).filter(Brokerage.code == data.code, Brokerage.id != brokerage_id).first()
    if dup:
        raise HTTPException(status_code=400, detail=f"Brokerage code '{data.code}' already in use")
    b.name = data.name
    b.code = data.code
    b.active = data.active
    b.advisor = data.advisor
    db.commit()
    return _brokerage_dict(b)


@router.delete("/brokerages/{brokerage_id}")
def delete_brokerage(brokerage_id: int, db: Session = Depends(get_db)):
    b = db.get(Brokerage, brokerage_id)
    if not b:
        raise HTTPException(status_code=404, detail="Brokerage not found")
    acct_count = db.query(Account).filter(Account.brokerage_id == brokerage_id).count()
    if acct_count > 0:
        raise HTTPException(status_code=400, detail=f"Brokerage has {acct_count} accounts. Delete accounts first.")
    db.delete(b)
    db.commit()
    return {"deleted": brokerage_id}


# ─── Securities ────────────────────────────────────────────────────────────

def _sec_to_dict(s: Security) -> dict:
    return {
        "id": s.id, "ticker": s.ticker, "exchange": s.exchange,
        "name": s.name, "asset_class": s.asset_class, "sector_gics": s.sector_gics,
        "industry_gics": s.industry_gics, "country": s.country, "currency": s.currency,
        "is_option": s.is_option,
    }


class SecurityUpdate(BaseModel):
    ticker: Optional[str] = None
    name: Optional[str] = None
    asset_class: Optional[str] = None
    sector_gics: Optional[str] = None
    industry_gics: Optional[str] = None
    country: Optional[str] = None
    currency: Optional[str] = None
    exchange: Optional[str] = None


@router.put("/securities/{security_id}")
def update_security(security_id: int, data: SecurityUpdate, db: Session = Depends(get_db)):
    s = db.get(Security, security_id)
    if not s:
        raise HTTPException(status_code=404, detail="Security not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(s, field, value)
    db.commit()
    db.refresh(s)
    return _sec_to_dict(s)


@router.delete("/securities/{security_id}")
def delete_security(security_id: int, db: Session = Depends(get_db)):
    s = db.get(Security, security_id)
    if not s:
        raise HTTPException(status_code=404, detail="Security not found")
    txn_count = db.query(Transaction).filter(Transaction.security_id == security_id).count()
    if txn_count > 0:
        raise HTTPException(status_code=400, detail=f"Security has {txn_count} transactions. Delete transactions first.")
    db.delete(s)
    db.commit()
    return {"deleted": security_id}


# ─── Type Mappings ─────────────────────────────────────────────────────────

@router.get("/type-mappings")
def list_type_mappings(db: Session = Depends(get_db)):
    mappings = db.query(BrokerageTypeMapping).join(BrokerageTypeMapping.brokerage).all()
    return [
        {
            "id": m.id,
            "brokerage_id": m.brokerage_id,
            "brokerage_name": m.brokerage.name if m.brokerage else None,
            "raw_type": m.raw_type,
            "canonical_type": m.canonical_type,
        }
        for m in mappings
    ]


class TypeMappingCreate(BaseModel):
    brokerage_id: int
    raw_type: str
    canonical_type: str


@router.post("/type-mappings", status_code=201)
def create_type_mapping(data: TypeMappingCreate, db: Session = Depends(get_db)):
    existing = db.query(BrokerageTypeMapping).filter(
        BrokerageTypeMapping.brokerage_id == data.brokerage_id,
        BrokerageTypeMapping.raw_type == data.raw_type,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Mapping already exists")
    m = BrokerageTypeMapping(**data.model_dump())
    db.add(m)
    db.commit()
    db.refresh(m)
    return {"id": m.id, "brokerage_id": m.brokerage_id, "raw_type": m.raw_type, "canonical_type": m.canonical_type}


@router.put("/type-mappings/{mapping_id}")
def update_type_mapping(mapping_id: int, data: TypeMappingCreate, db: Session = Depends(get_db)):
    m = db.get(BrokerageTypeMapping, mapping_id)
    if not m:
        raise HTTPException(status_code=404, detail="Mapping not found")
    m.raw_type = data.raw_type
    m.canonical_type = data.canonical_type
    db.commit()
    return {"id": m.id, "raw_type": m.raw_type, "canonical_type": m.canonical_type}


@router.delete("/type-mappings/{mapping_id}")
def delete_type_mapping(mapping_id: int, db: Session = Depends(get_db)):
    m = db.get(BrokerageTypeMapping, mapping_id)
    if not m:
        raise HTTPException(status_code=404, detail="Mapping not found")
    db.delete(m)
    db.commit()
    return {"deleted": mapping_id}


# ─── FX Rates ──────────────────────────────────────────────────────────────

@router.get("/fx-rates")
def list_fx_rates(limit: int = 100, db: Session = Depends(get_db)):
    rates = db.query(FXRate).order_by(FXRate.rate_date.desc()).limit(limit).all()
    return [
        {
            "id": r.id, "rate_date": r.rate_date.isoformat(),
            "from_currency": r.from_currency, "to_currency": r.to_currency,
            "rate": str(r.rate), "source": r.source,
        }
        for r in rates
    ]


@router.get("/fx-rates/lookup")
def lookup_fx_rate(
    rate_date: date = Query(..., alias="date"),
    from_currency: str = Query("USD"),
    to_currency: str = Query("CAD"),
    db: Session = Depends(get_db),
):
    """Return the system FX rate for a given date and currency pair."""
    rate = fx_service.get_rate(db, rate_date, from_currency.upper(), to_currency.upper())
    if rate is None:
        raise HTTPException(status_code=404, detail=f"No rate found for {from_currency}/{to_currency} on {rate_date}")
    return {
        "date": rate_date.isoformat(),
        "from_currency": from_currency.upper(),
        "to_currency": to_currency.upper(),
        "rate": str(rate),
    }


@router.post("/fx-rates/refresh")
async def refresh_fx_rates(db: Session = Depends(get_db)):
    added = await fx_service.fetch_boc_rates(db)
    total = db.query(FXRate).count()
    return {"added": added, "total": total, "message": f"Added {added} new rates"}


# ─── Currencies ────────────────────────────────────────────────────────────

@router.get("/currencies")
def list_currencies(db: Session = Depends(get_db)):
    currencies = db.query(Currency).all()
    return [{"id": c.id, "code": c.code, "name": c.name} for c in currencies]


# ─── Opening Balances ───────────────────────────────────────────────────────

class OpeningBalanceCreate(BaseModel):
    account_id: int
    balance_date: date
    ticker: str
    quantity: Decimal
    acb_per_share_cad: Decimal
    currency: str = "CAD"
    notes: Optional[str] = None


@router.get("/opening-balances")
def list_opening_balances(db: Session = Depends(get_db)):
    txns = (
        db.query(Transaction)
        .filter(Transaction.transaction_type == "OPENING_BALANCE")
        .order_by(Transaction.transaction_date.desc())
        .all()
    )
    return [
        {
            "id": t.id,
            "account_id": t.account_id,
            "account_name": t.account.name if t.account else None,
            "balance_date": t.transaction_date.isoformat() if t.transaction_date else None,
            "ticker": t.security.ticker if t.security else None,
            "security_id": t.security_id,
            "quantity": str(t.quantity) if t.quantity is not None else None,
            "acb_per_share_cad": str(t.price) if t.price is not None else None,
            "total_acb_cad": str(t.cad_amount) if t.cad_amount is not None else None,
            "currency": t.transaction_currency,
            "notes": t.notes,
        }
        for t in txns
    ]


@router.post("/opening-balances", status_code=201)
def create_opening_balance(data: OpeningBalanceCreate, db: Session = Depends(get_db)):
    from sqlalchemy import func

    security = db.query(Security).filter(
        func.upper(Security.ticker) == data.ticker.upper()
    ).first()
    if not security:
        security = Security(
            ticker=data.ticker.upper(),
            asset_class="EQUITY",
            currency=data.currency,
        )
        db.add(security)
        db.flush()

    total_acb = data.quantity * data.acb_per_share_cad

    txn = Transaction(
        account_id=data.account_id,
        security_id=security.id,
        transaction_date=data.balance_date,
        settlement_date=data.balance_date,
        transaction_type="OPENING_BALANCE",
        quantity=data.quantity,
        price=data.acb_per_share_cad,
        commission=Decimal("0"),
        transaction_currency=data.currency,
        transaction_amount=total_acb,
        account_currency_amount=total_acb,
        cad_amount=total_acb,
        fx_rate_to_account=Decimal("1"),
        fx_rate_to_cad=Decimal("1"),
        notes=data.notes or "Opening balance entered manually",
        tags=["opening_balance"],
        is_manual_override=True,
        is_verified=True,
    )
    db.add(txn)
    db.commit()
    db.refresh(txn)

    return {
        "id": txn.id,
        "account_id": txn.account_id,
        "ticker": security.ticker,
        "balance_date": txn.transaction_date.isoformat(),
        "quantity": str(txn.quantity),
        "acb_per_share_cad": str(txn.price),
        "total_acb_cad": str(txn.cad_amount),
    }


@router.put("/opening-balances/{txn_id}")
def update_opening_balance(txn_id: int, data: OpeningBalanceCreate, db: Session = Depends(get_db)):
    from sqlalchemy import func
    txn = db.get(Transaction, txn_id)
    if not txn or txn.transaction_type != "OPENING_BALANCE":
        raise HTTPException(status_code=404, detail="Opening balance not found")

    # Look up or create the security by ticker
    security = db.query(Security).filter(
        func.upper(Security.ticker) == data.ticker.upper()
    ).first()
    if not security:
        security = Security(ticker=data.ticker.upper(), asset_class="EQUITY", currency=data.currency)
        db.add(security)
        db.flush()

    total_acb = data.quantity * data.acb_per_share_cad

    txn.security_id = security.id
    txn.transaction_date = data.balance_date
    txn.settlement_date = data.balance_date
    txn.quantity = data.quantity
    txn.price = data.acb_per_share_cad
    txn.transaction_currency = data.currency
    txn.transaction_amount = total_acb
    txn.account_currency_amount = total_acb
    txn.cad_amount = total_acb
    txn.notes = data.notes or "Opening balance entered manually"

    db.commit()
    db.refresh(txn)
    return {
        "id": txn.id,
        "account_id": txn.account_id,
        "ticker": security.ticker,
        "balance_date": txn.transaction_date.isoformat(),
        "quantity": str(txn.quantity),
        "acb_per_share_cad": str(txn.price),
        "total_acb_cad": str(txn.cad_amount),
    }


@router.delete("/opening-balances/{txn_id}")
def delete_opening_balance(txn_id: int, db: Session = Depends(get_db)):
    txn = db.get(Transaction, txn_id)
    if not txn or txn.transaction_type != "OPENING_BALANCE":
        raise HTTPException(status_code=404, detail="Opening balance not found")
    db.delete(txn)
    db.commit()
    return {"deleted": txn_id}


# ─── Cash Opening Balances ─────────────────────────────────────────────────

class CashOpeningCreate(BaseModel):
    account_id: int
    balance_date: date
    amount: Decimal
    currency: str = "CAD"
    notes: Optional[str] = None


@router.get("/cash-openings")
def list_cash_openings(db: Session = Depends(get_db)):
    txns = (
        db.query(Transaction)
        .filter(Transaction.transaction_type == "CASH_OPENING")
        .order_by(Transaction.transaction_date.desc())
        .all()
    )
    return [
        {
            "id": t.id,
            "account_id": t.account_id,
            "account_name": t.account.name if t.account else None,
            "balance_date": t.transaction_date.isoformat(),
            "amount": str(t.account_currency_amount),
            "currency": t.transaction_currency,
            "notes": t.notes,
        }
        for t in txns
    ]


@router.post("/cash-openings", status_code=201)
def create_cash_opening(data: CashOpeningCreate, db: Session = Depends(get_db)):
    txn = Transaction(
        account_id=data.account_id,
        security_id=None,
        transaction_date=data.balance_date,
        settlement_date=data.balance_date,
        transaction_type="CASH_OPENING",
        quantity=None,
        price=None,
        commission=Decimal("0"),
        transaction_currency=data.currency,
        transaction_amount=data.amount,
        account_currency_amount=data.amount,
        cad_amount=data.amount,
        fx_rate_to_account=Decimal("1"),
        fx_rate_to_cad=Decimal("1"),
        notes=data.notes or "Opening cash balance",
        tags=["cash_opening"],
        is_manual_override=True,
        is_verified=True,
    )
    db.add(txn)
    db.commit()
    db.refresh(txn)
    return {
        "id": txn.id,
        "account_id": txn.account_id,
        "balance_date": txn.transaction_date.isoformat(),
        "amount": str(txn.account_currency_amount),
        "currency": txn.transaction_currency,
    }


@router.delete("/cash-openings/{txn_id}")
def delete_cash_opening(txn_id: int, db: Session = Depends(get_db)):
    txn = db.get(Transaction, txn_id)
    if not txn or txn.transaction_type != "CASH_OPENING":
        raise HTTPException(status_code=404, detail="Cash opening not found")
    db.delete(txn)
    db.commit()
    return {"deleted": txn_id}


# ─── Bulk Deletes ──────────────────────────────────────────────────────────

@router.delete("/bulk/transactions")
def delete_all_transactions(account_id: Optional[int] = None, db: Session = Depends(get_db)):
    """Delete all transactions, optionally scoped to one account."""
    q = db.query(Transaction)
    if account_id:
        q = q.filter(Transaction.account_id == account_id)
    count = q.count()
    q.delete()
    db.commit()
    return {"deleted_count": count, "message": f"Deleted {count} transactions"}


@router.delete("/bulk/imports")
def delete_all_imports(db: Session = Depends(get_db)):
    """Delete all import batches and raw transaction rows."""
    from app.models.imports import ImportBatch, RawTransaction
    raw_count = db.query(RawTransaction).delete()
    batch_count = db.query(ImportBatch).delete()
    db.commit()
    return {"batches_deleted": batch_count, "rows_deleted": raw_count}


@router.delete("/bulk/securities")
def delete_unused_securities(db: Session = Depends(get_db)):
    """Delete securities that have no transactions."""
    from app.models.options import OptionContract, OptionStrategy
    used_ids = {r[0] for r in db.query(Transaction.security_id).distinct().all() if r[0]}
    deleted = 0
    for s in db.query(Security).all():
        if s.id not in used_ids:
            # Remove option_contracts and strategies that reference this security
            db.query(OptionContract).filter(
                (OptionContract.security_id == s.id) | (OptionContract.underlying_security_id == s.id)
            ).delete(synchronize_session=False)
            db.query(OptionStrategy).filter(
                OptionStrategy.underlying_security_id == s.id
            ).delete(synchronize_session=False)
            db.delete(s)
            deleted += 1
    db.commit()
    return {"deleted_count": deleted}


# ─── Currency sub-account migration ───────────────────────────────────────────

class SplitCurrencyRequest(BaseModel):
    to_account_id: int
    currency: str           # e.g. "USD" — transactions with this transaction_currency get moved
    from_date: Optional[date] = None   # inclusive lower bound (no limit if omitted)
    to_date:   Optional[date] = None   # inclusive upper bound (no limit if omitted)


@router.post("/accounts/{account_id}/split-currency")
def split_currency_transactions(
    account_id: int,
    body: SplitCurrencyRequest,
    db: Session = Depends(get_db),
):
    """
    Move transactions whose transaction_currency matches *currency* from
    *account_id* to *to_account_id*, optionally restricted to a date range.

    FX_CONVERSION rows are already stored as one row per currency leg by the
    parsers, so they split cleanly: the CAD leg stays, the USD leg moves.
    """
    src = db.get(Account, account_id)
    if not src:
        raise HTTPException(status_code=404, detail="Source account not found")

    dst = db.get(Account, body.to_account_id)
    if not dst:
        raise HTTPException(status_code=404, detail="Target account not found")

    ccy = body.currency.upper()
    if dst.base_currency.upper() != ccy:
        raise HTTPException(
            status_code=400,
            detail=f"Target account base_currency ({dst.base_currency}) must match the currency being split ({ccy})",
        )

    q = db.query(Transaction).filter(
        Transaction.account_id == account_id,
        Transaction.transaction_currency == ccy,
    )
    if body.from_date:
        q = q.filter(Transaction.transaction_date >= body.from_date)
    if body.to_date:
        q = q.filter(Transaction.transaction_date <= body.to_date)

    txns = q.all()
    for txn in txns:
        txn.account_id = body.to_account_id

    db.commit()
    return {
        "moved": len(txns),
        "from_account": src.name,
        "to_account": dst.name,
        "currency": ccy,
        "from_date": body.from_date.isoformat() if body.from_date else None,
        "to_date":   body.to_date.isoformat()   if body.to_date   else None,
    }


@router.get("/accounts/{account_id}/currency-summary")
def account_currency_summary(account_id: int, db: Session = Depends(get_db)):
    """
    Return a breakdown of transaction counts and date ranges by transaction_currency
    for an account.  Use this to preview what a split-currency migration would move.
    """
    from sqlalchemy import func
    acct = db.get(Account, account_id)
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    rows = (
        db.query(
            Transaction.transaction_currency,
            func.count(Transaction.id).label("count"),
            func.min(Transaction.transaction_date).label("earliest"),
            func.max(Transaction.transaction_date).label("latest"),
        )
        .filter(Transaction.account_id == account_id)
        .group_by(Transaction.transaction_currency)
        .all()
    )

    return {
        "account_id": account_id,
        "account_name": acct.name,
        "base_currency": acct.base_currency,
        "by_currency": [
            {
                "currency": r.transaction_currency or acct.base_currency,
                "count": r.count,
                "earliest": r.earliest.isoformat() if r.earliest else None,
                "latest": r.latest.isoformat() if r.latest else None,
            }
            for r in rows
        ],
    }
