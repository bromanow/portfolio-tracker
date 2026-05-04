from datetime import date
from decimal import Decimal
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import asc, desc, nullslast
from sqlalchemy.orm import Session
from app.database import get_db
from app.dependencies import get_current_user, parse_account_ids, get_user_account_ids
from app.models.auth import User
from app.models.transactions import Transaction
from app.models.master import Account, Brokerage

router = APIRouter(
    prefix="/api/transactions",
    tags=["transactions"],
    dependencies=[Depends(get_current_user)],  # all routes require auth
)


class TransactionCreate(BaseModel):
    account_id: int
    security_id: Optional[int] = None
    transaction_date: date
    settlement_date: Optional[date] = None
    transaction_type: str
    quantity: Optional[Decimal] = None
    price: Optional[Decimal] = None
    commission: Optional[Decimal] = None
    transaction_currency: Optional[str] = None
    transaction_amount: Optional[Decimal] = None
    account_currency_amount: Optional[Decimal] = None
    cad_amount: Optional[Decimal] = None
    fx_rate_to_account: Optional[Decimal] = None
    fx_rate_to_cad: Optional[Decimal] = None
    notes: Optional[str] = None
    tags: Optional[list] = None
    raw_description: Optional[str] = None


class TransactionUpdate(BaseModel):
    account_id: Optional[int] = None
    transaction_date: Optional[date] = None
    transaction_type: Optional[str] = None
    security_id: Optional[int] = None
    transaction_currency: Optional[str] = None
    quantity: Optional[Decimal] = None
    price: Optional[Decimal] = None
    commission: Optional[Decimal] = None
    transaction_amount: Optional[Decimal] = None
    account_currency_amount: Optional[Decimal] = None
    cad_amount: Optional[Decimal] = None
    fx_rate_to_cad: Optional[Decimal] = None
    fx_rate_to_account: Optional[Decimal] = None
    notes: Optional[str] = None
    raw_description: Optional[str] = None
    tags: Optional[list] = None
    is_verified: Optional[bool] = None


def _dec(v) -> Optional[str]:
    """Format Decimal to fixed-point string, avoiding scientific notation like 0E-8."""
    if v is None:
        return None
    s = format(v, 'f')           # e.g. "0.00000000" instead of "0E-8"
    if '.' in s:
        s = s.rstrip('0').rstrip('.')  # "0.00000000" → "0", "0.10000000" → "0.1"
    return s


def txn_to_dict(t: Transaction) -> dict:
    return {
        "id": t.id,
        "account_id": t.account_id,
        "security_id": t.security_id,
        "transaction_date": t.transaction_date.isoformat() if t.transaction_date else None,
        "settlement_date": t.settlement_date.isoformat() if t.settlement_date else None,
        "transaction_type": t.transaction_type,
        "quantity": _dec(t.quantity),
        "price": _dec(t.price),
        "commission": _dec(t.commission),
        "transaction_currency": t.transaction_currency,
        "transaction_amount": _dec(t.transaction_amount),
        "account_currency_amount": _dec(t.account_currency_amount),
        "cad_amount": _dec(t.cad_amount),
        "fx_rate_to_account": _dec(t.fx_rate_to_account),
        "fx_rate_to_cad": _dec(t.fx_rate_to_cad),
        "notes": t.notes,
        "tags": t.tags,
        "raw_description": t.raw_description,
        "is_manual_override": t.is_manual_override,
        "is_verified": t.is_verified,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        # Join data
        "security_ticker": t.security.ticker if t.security else None,
        "account_name": t.account.name if t.account else None,
    }


@router.get("")
def list_transactions(
    account_id: Optional[int] = Query(None),
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    brokerage_name: Optional[str] = Query(None),
    security_id: Optional[int] = Query(None),
    transaction_type: Optional[str] = Query(None),  # single type or comma-separated list
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    ticker: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    sort_by: str = Query("transaction_date"),
    sort_dir: str = Query("desc"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.models.master import Security, Account
    query = db.query(Transaction).join(Transaction.account, isouter=True).join(Transaction.security, isouter=True)

    if account_id:
        query = query.filter(Transaction.account_id == account_id)
    elif account_ids:
        authorized_ids = parse_account_ids(account_ids, current_user, db)
        if authorized_ids is not None:
            query = query.filter(Transaction.account_id.in_(authorized_ids))
    else:
        # No account filter specified — scope to user's own accounts
        allowed = get_user_account_ids(current_user, db)
        if allowed is not None:
            query = query.filter(Transaction.account_id.in_(allowed))
    if brokerage_name:
        query = query.join(Brokerage, Account.brokerage_id == Brokerage.id).filter(Brokerage.name == brokerage_name)
    if security_id:
        query = query.filter(Transaction.security_id == security_id)
    if transaction_type:
        types = [t.strip() for t in transaction_type.split(',') if t.strip()]
        if len(types) == 1:
            query = query.filter(Transaction.transaction_type == types[0])
        elif types:
            query = query.filter(Transaction.transaction_type.in_(types))
    if date_from:
        query = query.filter(Transaction.transaction_date >= date_from)
    if date_to:
        query = query.filter(Transaction.transaction_date <= date_to)
    if ticker:
        # Use inner filter that keeps null-security rows when no ticker filter
        query = query.filter(Security.ticker.ilike(f"%{ticker}%"))

    total = query.count()

    # Sort column mapping
    sort_cols = {
        "transaction_date": Transaction.transaction_date,
        "transaction_type": Transaction.transaction_type,
        "security_ticker": Security.ticker,
        "account_name": Account.name,
        "quantity": Transaction.quantity,
        "price": Transaction.price,
        "transaction_amount": Transaction.transaction_amount,
        "cad_amount": Transaction.cad_amount,
    }
    col = sort_cols.get(sort_by, Transaction.transaction_date)
    dir_fn = desc if sort_dir == "desc" else asc
    # Secondary sort always by id for stable ordering
    transactions = (
        query.order_by(nullslast(dir_fn(col)), Transaction.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [txn_to_dict(t) for t in transactions],
    }


class TransferPairCreate(BaseModel):
    """Create both legs of a share/security transfer in one atomic request."""
    from_account_id: int
    to_account_id: int
    transaction_date: date
    settlement_date: Optional[date] = None
    transfer_type: str = "JOURNAL"   # "JOURNAL" or "TRANSFER"
    security_id: Optional[int] = None
    quantity: Optional[Decimal] = None   # positive; source leg is auto-negated
    price: Optional[Decimal] = None
    cad_amount: Optional[Decimal] = None  # book value (used as ACB cost on the receiving leg)
    notes: Optional[str] = None
    raw_description: Optional[str] = None


@router.post("/transfer-pair", status_code=201)
def create_transfer_pair(data: TransferPairCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Atomically create both legs of a security transfer between accounts.

    JOURNAL transfer (iTrade style):
      source → JOURNAL  qty = −quantity
      dest   → JOURNAL  qty = +quantity

    TRANSFER style:
      source → TRANSFER_OUT  qty = −quantity
      dest   → TRANSFER_IN   qty = +quantity

    cad_amount is set on both legs; for JOURNAL it serves as the ACB book value
    consumed by the ACB engine on the +qty (receiving) leg.
    """
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None:
        if data.from_account_id not in allowed:
            raise HTTPException(status_code=403, detail="Access denied to this account")
        if data.to_account_id not in allowed:
            raise HTTPException(status_code=403, detail="Access denied to this account")
    from_acct = db.get(Account, data.from_account_id)
    to_acct   = db.get(Account, data.to_account_id)
    if not from_acct:
        raise HTTPException(status_code=400, detail="Source account not found")
    if not to_acct:
        raise HTTPException(status_code=400, detail="Destination account not found")

    is_journal = data.transfer_type.upper() == "JOURNAL"
    source_type = "JOURNAL"      if is_journal else "TRANSFER_OUT"
    dest_type   = "JOURNAL"      if is_journal else "TRANSFER_IN"

    qty = data.quantity
    source_qty = -qty if qty is not None else None
    dest_qty   =  qty

    source_desc = data.raw_description or f"Transfer to {to_acct.name}"
    dest_desc   = data.raw_description or f"Transfer from {from_acct.name}"

    source_txn = Transaction(
        account_id=data.from_account_id,
        security_id=data.security_id,
        transaction_date=data.transaction_date,
        settlement_date=data.settlement_date,
        transaction_type=source_type,
        quantity=source_qty,
        price=data.price,
        cad_amount=data.cad_amount,
        notes=data.notes,
        raw_description=source_desc,
        is_manual_override=True,
    )
    dest_txn = Transaction(
        account_id=data.to_account_id,
        security_id=data.security_id,
        transaction_date=data.transaction_date,
        settlement_date=data.settlement_date,
        transaction_type=dest_type,
        quantity=dest_qty,
        price=data.price,
        cad_amount=data.cad_amount,
        notes=data.notes,
        raw_description=dest_desc,
        is_manual_override=True,
    )

    db.add(source_txn)
    db.add(dest_txn)
    db.commit()
    db.refresh(source_txn)
    db.refresh(dest_txn)
    return {"source": txn_to_dict(source_txn), "dest": txn_to_dict(dest_txn)}


class BulkUpdateRequest(BaseModel):
    ids: list[int]
    transaction_type: str


@router.post("/bulk-update")
def bulk_update_transactions(data: BulkUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Change the transaction_type for a batch of transactions by ID."""
    if not data.ids:
        raise HTTPException(status_code=400, detail="No IDs provided")
    if len(data.ids) > 5000:
        raise HTTPException(status_code=400, detail="Too many IDs (max 5000 per request)")
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None:
        allowed_set = set(allowed)
        bad = (
            db.query(Transaction.id)
            .filter(Transaction.id.in_(data.ids), Transaction.account_id.notin_(allowed_set))
            .first()
        )
        if bad:
            raise HTTPException(status_code=403, detail="Access denied to one or more transactions")
    count = (
        db.query(Transaction)
        .filter(Transaction.id.in_(data.ids))
        .update(
            {"transaction_type": data.transaction_type, "is_manual_override": True},
            synchronize_session=False,
        )
    )
    db.commit()
    return {"updated": count}


@router.post("", status_code=201)
def create_transaction(data: TransactionCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None and data.account_id not in allowed:
        raise HTTPException(status_code=403, detail="Access denied to this account")

    fields = data.model_dump()

    # Auto-populate cad_amount and account_currency_amount when not explicitly provided.
    tx_ccy = (fields.get("transaction_currency") or "CAD").upper()
    account = db.get(Account, fields["account_id"]) if fields.get("account_id") else None
    acct_ccy = (account.base_currency if account else "CAD").upper()

    if fields.get("transaction_amount") is not None:
        # CAD transaction → cad_amount equals transaction_amount
        if tx_ccy == "CAD" and fields.get("cad_amount") is None:
            fields["cad_amount"] = fields["transaction_amount"]

        if fields.get("account_currency_amount") is None:
            if tx_ccy == acct_ccy:
                fields["account_currency_amount"] = fields["transaction_amount"]
            elif fields.get("cad_amount") is not None and acct_ccy == "CAD":
                fields["account_currency_amount"] = fields["cad_amount"]

    txn = Transaction(**fields, is_manual_override=True)
    db.add(txn)
    db.commit()
    db.refresh(txn)
    return txn_to_dict(txn)


@router.get("/{txn_id}")
def get_transaction(txn_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    txn = db.get(Transaction, txn_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None and txn.account_id not in allowed:
        raise HTTPException(status_code=403, detail="Access denied")
    return txn_to_dict(txn)


@router.put("/{txn_id}")
def update_transaction(txn_id: int, data: TransactionUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    txn = db.get(Transaction, txn_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None and txn.account_id not in allowed:
        raise HTTPException(status_code=403, detail="Access denied to this account")

    updates = data.model_dump(exclude_none=True)

    # Derive effective transaction currency (updated value or existing)
    prev_ccy = (txn.transaction_currency or "CAD").upper()
    tx_ccy = (updates.get("transaction_currency") or prev_ccy).upper()
    tx_amt = updates.get("transaction_amount") or txn.transaction_amount

    if tx_ccy == "CAD" and tx_amt is not None:
        # Recalculate cad_amount when:
        #   (a) currency is being explicitly switched to CAD from another currency, OR
        #   (b) currency is already CAD and FX rate is being set to 1 (user correcting a
        #       previously mis-converted amount), OR
        #   (c) currency is CAD and no explicit cad_amount was supplied at all
        switching_to_cad = "transaction_currency" in updates and prev_ccy != "CAD"
        resetting_fx     = tx_ccy == "CAD" and updates.get("fx_rate_to_cad") == Decimal("1")
        if switching_to_cad or resetting_fx or "cad_amount" not in updates:
            updates["cad_amount"] = tx_amt
            updates["account_currency_amount"] = tx_amt
            if switching_to_cad or resetting_fx:
                updates.setdefault("fx_rate_to_cad", Decimal("1"))
                updates.setdefault("fx_rate_to_account", Decimal("1"))

    for field, value in updates.items():
        setattr(txn, field, value)
    txn.is_manual_override = True
    db.commit()
    db.refresh(txn)
    return txn_to_dict(txn)


class ExpireOptionRequest(BaseModel):
    account_id: int
    security_id: int
    expiry_date: Optional[date] = None


@router.post("/expire-option", status_code=201)
def expire_option(data: ExpireOptionRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None and data.account_id not in allowed:
        raise HTTPException(status_code=403, detail="Access denied to this account")

    from app.models.master import Security
    from app.models.prices import MarketPrice
    from decimal import Decimal
    from datetime import date as date_cls

    sec = db.get(Security, data.security_id)
    if not sec or not sec.is_option:
        raise HTTPException(status_code=400, detail="Security is not a valid option")

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == data.security_id).first()
    currency = (mp.currency if mp else None) or sec.currency or "CAD"

    txn_date = data.expiry_date or date_cls.today()

    txn = Transaction(
        account_id=data.account_id,
        security_id=data.security_id,
        transaction_date=txn_date,
        transaction_type="OPTION_EXPIRY",
        quantity=None,
        price=Decimal("0"),
        commission=None,
        transaction_currency=currency,
        transaction_amount=Decimal("0"),
        account_currency_amount=Decimal("0"),
        cad_amount=Decimal("0"),
        notes="Expired worthless — manual entry (IB did not provide expiry transaction)",
        is_manual_override=True,
        is_verified=False,
    )
    db.add(txn)
    db.commit()
    db.refresh(txn)
    return txn_to_dict(txn)


@router.delete("/{txn_id}")
def delete_transaction(txn_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    txn = db.get(Transaction, txn_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    allowed = get_user_account_ids(current_user, db)
    if allowed is not None and txn.account_id not in allowed:
        raise HTTPException(status_code=403, detail="Access denied to this account")
    db.delete(txn)
    db.commit()
    return {"deleted": txn_id}
