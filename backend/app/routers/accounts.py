from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.master import Account, Brokerage
from app.models.clients import Client, UserClient
from app.models.auth import User
from app.dependencies import get_current_user

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class AccountCreate(BaseModel):
    brokerage_id: int
    name: str
    account_number: Optional[str] = None
    account_type: str
    base_currency: str
    owner: str
    client_id: Optional[int] = None
    active: bool = True
    ibkr_alias: Optional[str] = None
    portfolio_manager: Optional[str] = None


class AccountUpdate(BaseModel):
    name: Optional[str] = None
    account_number: Optional[str] = None
    account_type: Optional[str] = None
    base_currency: Optional[str] = None
    owner: Optional[str] = None
    client_id: Optional[int] = None
    active: Optional[bool] = None
    ibkr_alias: Optional[str] = None
    portfolio_manager: Optional[str] = None


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
        "client_id": a.client_id,
        "active": a.active,
        "ibkr_alias": a.ibkr_alias,
        "portfolio_manager": a.portfolio_manager,
        "returns_start_date": a.returns_start_date.isoformat() if a.returns_start_date else None,
    }


def _get_accessible_client_ids(user: User, db: Session) -> Optional[list]:
    """
    Returns the list of client IDs this user may access,
    or None if the user is an admin (unrestricted).
    Admin users always have full access.
    """
    if user.role == "admin":
        return None  # unrestricted

    links = db.query(UserClient).filter(UserClient.user_id == user.id).all()
    return [lnk.client_id for lnk in links]


@router.get("")
def list_accounts(
    include_demo: bool = Query(False, description="Include sample/demo client accounts (Admin management screens only)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = db.query(Account).join(Account.brokerage)
    client_ids = _get_accessible_client_ids(current_user, db)
    if client_ids is not None:
        q = q.filter(Account.client_id.in_(client_ids))
    elif not include_demo:
        # Admin (unrestricted) view — still hide sample/demo client accounts by default so
        # they don't clutter the real portfolio's dashboards/filters. Surfaced only when a
        # caller explicitly asks (Admin management screens).
        demo_client_ids = [c.id for c in db.query(Client).filter(Client.is_demo == True).all()]  # noqa: E712
        if demo_client_ids:
            q = q.filter(
                (Account.client_id.is_(None)) | (Account.client_id.notin_(demo_client_ids))
            )
    accounts = q.order_by(Account.owner, Account.name).all()
    return [account_to_dict(a) for a in accounts]


@router.post("", status_code=201)
def create_account(
    data: AccountCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    account = Account(**data.model_dump())
    db.add(account)
    db.commit()
    db.refresh(account)
    return account_to_dict(account)


@router.get("/{account_id}")
def get_account(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    client_ids = _get_accessible_client_ids(current_user, db)
    if client_ids is not None and account.client_id not in client_ids:
        raise HTTPException(status_code=403, detail="Access denied")
    return account_to_dict(account)


@router.put("/{account_id}")
def update_account(
    account_id: int,
    data: AccountUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
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
    current_user: User = Depends(get_current_user),
):
    """Set (or clear) a custom returns start date for one physical account.
    The performance/returns endpoint uses this date instead of the auto-computed effective inception."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    account.returns_start_date = data.returns_start_date
    db.commit()
    db.refresh(account)
    return account_to_dict(account)


@router.post("/{account_id}/merge-into/{target_account_id}")
def merge_account(
    account_id: int,
    target_account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Merge SOURCE account (account_id) into TARGET account (target_account_id).

    For each transaction in SOURCE:
    - If an identical transaction already exists in TARGET
      (same date ± 1 day, same type, same security_id, quantity within 0.01%),
      it is treated as a Plaid-reconnect duplicate and deleted from SOURCE.
    - Otherwise it is re-pointed to TARGET (history preserved).

    After migration the SOURCE account is deleted.
    Admin-only.
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    source = db.get(Account, account_id)
    target = db.get(Account, target_account_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source account not found")
    if not target:
        raise HTTPException(status_code=404, detail="Target account not found")
    if account_id == target_account_id:
        raise HTTPException(status_code=400, detail="Source and target must differ")

    from app.models.transactions import Transaction
    from datetime import timedelta
    from collections import defaultdict
    from sqlalchemy import text

    source_txns = db.query(Transaction).filter(Transaction.account_id == account_id).all()
    target_txns = db.query(Transaction).filter(Transaction.account_id == target_account_id).all()

    # Build a lookup of target transactions for fast duplicate detection.
    # Key: (type, security_id, date-bucket); Value: list of txns to match qty against.
    target_index: dict = defaultdict(list)
    for t in target_txns:
        for delta in (-1, 0, 1):
            d = t.transaction_date + timedelta(days=delta) if t.transaction_date else None
            if d:
                target_index[(t.transaction_type, t.security_id, d)].append(t)

    moved = 0
    dupes_deleted = 0

    for txn in source_txns:
        candidates = target_index.get((txn.transaction_type, txn.security_id, txn.transaction_date), [])
        is_dupe = False
        for cand in candidates:
            src_qty = float(txn.quantity or 0)
            cand_qty = float(cand.quantity or 0)
            if src_qty == 0 and cand_qty == 0:
                is_dupe = True
            elif src_qty != 0 and abs(src_qty - cand_qty) / abs(src_qty) < 0.0001:
                is_dupe = True
            if is_dupe:
                break

        if is_dupe:
            db.delete(txn)
            dupes_deleted += 1
        else:
            txn.account_id = target_account_id
            moved += 1

    db.flush()

    # Migrate or nullify all tables that reference the source account.
    # Uses savepoints so a table/column that doesn't exist in the actual DB (model-only
    # additions that were never migrated) is silently skipped without aborting the transaction.
    for tbl, col, action in [
        ("portfolio_snapshots",             "account_id", "merge_snapshots"),
        ("option_strategies",               "account_id", "migrate"),
        ("import_batches",                  "account_id", "nullify"),
        ("statement_files",                 "account_id", "nullify"),
        ("raw_transactions",                "account_id", "nullify"),
        ("covered_call_holdings",           "account_id", "nullify"),
        ("plaid_accounts",                  "account_id", "delete"),
        ("security_account_type_overrides", "account_id", "migrate"),
    ]:
        sp = db.begin_nested()  # SAVEPOINT — rolls back only this step on failure
        try:
            if action == "merge_snapshots":
                db.execute(
                    text("""
                        DELETE FROM portfolio_snapshots
                        WHERE account_id = :src
                          AND EXISTS (
                              SELECT 1 FROM portfolio_snapshots tgt
                              WHERE tgt.account_id = :target
                                AND tgt.snapshot_date = portfolio_snapshots.snapshot_date
                          )
                    """),
                    {"target": target_account_id, "src": account_id},
                )
                db.execute(
                    text("UPDATE portfolio_snapshots SET account_id = :target WHERE account_id = :src"),
                    {"target": target_account_id, "src": account_id},
                )
            elif action == "migrate":
                db.execute(
                    text(f"UPDATE {tbl} SET {col} = :target WHERE {col} = :src"),
                    {"target": target_account_id, "src": account_id},
                )
            elif action == "nullify":
                db.execute(
                    text(f"UPDATE {tbl} SET {col} = NULL WHERE {col} = :src"),
                    {"src": account_id},
                )
            else:  # delete
                db.execute(
                    text(f"DELETE FROM {tbl} WHERE {col} = :src"),
                    {"src": account_id},
                )
            sp.commit()
        except Exception:
            sp.rollback()  # release savepoint cleanly; outer transaction stays alive

    db.flush()
    db.delete(source)
    db.commit()

    return {
        "merged_from": account_id,
        "merged_into": target_account_id,
        "transactions_moved": moved,
        "duplicates_deleted": dupes_deleted,
    }


@router.delete("/{account_id}")
def delete_account(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
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
def force_delete_account(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete account AND all its transactions."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    from app.models.transactions import Transaction
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    txn_count = db.query(Transaction).filter(Transaction.account_id == account_id).delete()
    db.delete(account)
    db.commit()
    return {"deleted": account_id, "transactions_deleted": txn_count}
