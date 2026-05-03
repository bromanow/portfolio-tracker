"""
Import router: handles CSV file uploads, preview, and commit.
"""
from typing import Optional
from datetime import datetime
import logging
import threading

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.imports import ImportBatch, RawTransaction
from app.models.master import Account, Brokerage, BrokerageTypeMapping
from app.models.transactions import Transaction
from app.parsers.itrade import parse_itrade_csv, detect_itrade_format
from app.parsers.ibkr_history import parse_ibkr_history_csv, detect_ibkr_history_format
from app.parsers.ibkr_trades import parse_ibkr_trades_csv, detect_ibkr_trades_format
from app.parsers.scotia_wealth import parse_scotia_wealth_csv, detect_scotia_wealth_format
from app.parsers.olympia import parse_olympia_csv, detect_olympia_format
from app.services.normalizer import normalize_itrade_row, normalize_ibkr_row, check_duplicate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/imports", tags=["imports"])


# ── Shared helpers ────────────────────────────────────────────────────────────

def _cast_row_types(row: dict) -> dict:
    """Re-parse date strings and decimal strings back to typed values for normalization."""
    from datetime import date as date_type
    from decimal import Decimal

    def maybe_date(v):
        if isinstance(v, str) and len(v) == 10 and "-" in v:
            try:
                return date_type.fromisoformat(v)
            except Exception:
                pass
        return v

    def maybe_decimal(v):
        if isinstance(v, str) and v not in ("", "None", "null"):
            try:
                return Decimal(v)
            except Exception:
                pass
        return None

    typed = dict(row)
    typed["transaction_date"] = maybe_date(row.get("transaction_date"))
    typed["settlement_date"] = maybe_date(row.get("settlement_date"))
    for field in ("quantity", "price", "settlement_amount", "net_amount", "gross_amount", "commission", "fx_rate_in_desc"):
        val = row.get(field)
        typed[field] = maybe_decimal(str(val)) if val is not None else None
    if isinstance(row.get("option_info"), dict):
        oi = dict(row["option_info"])
        if "expiry" in oi and isinstance(oi["expiry"], str):
            oi["expiry"] = maybe_date(oi["expiry"])
        if "strike" in oi and oi["strike"] is not None:
            oi["strike"] = maybe_decimal(str(oi["strike"]))
        typed["option_info"] = oi
    return typed


def _find_account(db, row: dict, batch, brokerage) -> Optional["Account"]:
    """
    Resolve the account for a raw row. Priority:
      1. Explicit account_id on the row (manual override)
      2. Batch-level account_id (then sibling-currency check)
      3. Name match by account_name: checks ibkr_alias (exact) then name (ilike contains)

    After resolving the primary account, if the row carries an "account_currency"
    field (iTrade / Scotia Wealth CSV column) that differs from the account's
    base_currency, we look for a sibling account with the same brokerage, owner,
    and account_type but the row's currency.  This lets a single upload of an
    iTrade CSV automatically route CAD rows to the CAD account and USD rows to
    the USD account without requiring the user to split the file.
    """
    if row.get("account_id"):
        return db.get(Account, int(row["account_id"]))

    account = None
    if batch.account_id:
        account = db.get(Account, batch.account_id)
    elif row.get("account_name") and brokerage:
        alias = row["account_name"]
        account = db.query(Account).filter(
            Account.brokerage_id == brokerage.id,
            or_(
                Account.ibkr_alias == alias,
                Account.name.ilike(f"%{alias}%"),
            ),
        ).first()

    if not account:
        return None

    # ── CAD/USD sibling routing ───────────────────────────────────────────────
    # iTrade (and Scotia Wealth) export files contain rows for both the CAD and
    # USD sides of an account in a single CSV.  The "Account Currency" column
    # identifies which side each row belongs to.  When it doesn't match the
    # selected account's base_currency, look for a sibling account that does.
    row_currency = row.get("account_currency")
    if row_currency and row_currency != account.base_currency:
        sibling = db.query(Account).filter(
            Account.brokerage_id == account.brokerage_id,
            Account.account_type == account.account_type,
            Account.owner == account.owner,
            Account.base_currency == row_currency,
            Account.active == True,
        ).first()
        if sibling:
            logger.debug(
                "Routing row (account_currency=%s) to sibling account %r (id=%d)",
                row_currency, sibling.name, sibling.id,
            )
            return sibling

    return account


class ImportBatchResponse(BaseModel):
    id: int
    brokerage_id: int
    account_id: Optional[int]
    filename: str
    import_date: datetime
    row_count: int
    imported_count: int
    error_count: int
    status: str

    class Config:
        from_attributes = True


class RawTransactionResponse(BaseModel):
    id: int
    row_number: int
    raw_data: dict
    parsed_date: Optional[str]
    status: str
    error_message: Optional[str]
    transaction_id: Optional[int]

    class Config:
        from_attributes = True


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    account_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """Upload a CSV file and parse it into raw_transactions."""
    content = (await file.read()).decode("utf-8-sig", errors="replace")
    filename = file.filename or "unknown.csv"

    # ── Resolve account + brokerage from account_id (if provided) ───────────
    brokerage_code = None
    parsed_rows = []
    errors = []

    logger.info("UPLOAD: file=%r account_id=%r", filename, account_id)
    acct_brokerage: Optional[Brokerage] = None
    if account_id:
        _acct = db.get(Account, account_id)
        if _acct and _acct.brokerage_id:
            acct_brokerage = db.get(Brokerage, _acct.brokerage_id)
            brokerage_code = acct_brokerage.code if acct_brokerage else None
        logger.info("UPLOAD: account=%r brokerage=%r", _acct.name if _acct else None, brokerage_code)

    # ── Column-format detection helper ───────────────────────────────────────
    # iTrade and Scotia Wealth share identical column headers; distinguish them
    # by the account's brokerage rather than fragile content-pattern matching.
    first_line = content.split("\n")[0].strip()
    first_line_lower = first_line.lower()
    # Match both modern ("Activity", "Settlement amount") and older RRSP variant
    # ("Activity"/"Type", "Settlement Amount" with capital A / leading space)
    is_itrade_columns = (
        "settlement amount" in first_line_lower
        and ("activity" in first_line_lower or ",type," in first_line_lower
             or first_line_lower.endswith(",type"))
    )

    if is_itrade_columns:
        # Key rule: if an account is selected and its brokerage is NOT "ITRADE",
        # treat the file as Scotia Wealth (same columns, different Activity names).
        is_scotia = (acct_brokerage is not None and acct_brokerage.code != "ITRADE")
        logger.info("UPLOAD: itrade-columns=True is_scotia=%r acct_brokerage=%r",
                    is_scotia, acct_brokerage.code if acct_brokerage else None)
        if is_scotia:
            if not brokerage_code:
                raise HTTPException(status_code=400, detail="Could not determine brokerage from selected account.")
            try:
                parsed_rows = parse_scotia_wealth_csv(content)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Scotia Wealth parse error: {e}")
        else:
            # Default: iTrade (or no account selected)
            brokerage_code = brokerage_code or "ITRADE"
            try:
                parsed_rows = parse_itrade_csv(content)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"iTrade parse error: {e}")
    elif detect_ibkr_history_format(content):
        brokerage_code = "IBKR"
        try:
            parsed_rows = parse_ibkr_history_csv(content)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"IBKR history parse error: {e}")
    elif detect_ibkr_trades_format(content):
        brokerage_code = "IBKR"
        try:
            parsed_rows = parse_ibkr_trades_csv(content)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"IBKR trades parse error: {e}")
    elif detect_olympia_format(content):
        brokerage_code = "OLYMPIA"
        try:
            parsed_rows = parse_olympia_csv(content)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Olympia parse error: {e}")
    else:
        raise HTTPException(status_code=400, detail="Unrecognized CSV format")

    # Get brokerage
    brokerage = db.query(Brokerage).filter(Brokerage.code == brokerage_code).first()
    if not brokerage:
        raise HTTPException(status_code=400, detail=f"Brokerage {brokerage_code} not found")

    # ── Apply brokerage type mappings at upload time ──────────────────────────
    # This ensures the preview shows the correct canonical transaction_type
    # immediately (e.g. "Buy"→BUY, "GST"→FEE) rather than showing OTHER and
    # relying on a silent fix at commit time.
    type_map: dict[str, str] = {
        m.raw_type: m.canonical_type
        for m in db.query(BrokerageTypeMapping)
            .filter(BrokerageTypeMapping.brokerage_id == brokerage.id)
            .all()
    }
    if type_map:
        for row in parsed_rows:
            raw_act = row.get("raw_activity", "")
            if raw_act and raw_act in type_map:
                row["transaction_type"] = type_map[raw_act]

    # For IBKR multi-account files, account_id may be None
    batch = ImportBatch(
        brokerage_id=brokerage.id,
        account_id=account_id,
        filename=filename,
        row_count=len(parsed_rows),
        status="PENDING",
    )
    db.add(batch)
    db.flush()

    def make_serializable(obj):
        """Recursively convert date/Decimal/etc to JSON-safe types."""
        if obj is None:
            return None
        elif isinstance(obj, bool):
            return obj
        elif hasattr(obj, "isoformat"):
            return obj.isoformat()
        elif hasattr(obj, "__float__") and not isinstance(obj, (int, float)):
            return str(obj)
        elif isinstance(obj, dict):
            return {k: make_serializable(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [make_serializable(i) for i in obj]
        else:
            return obj

    # Store raw transactions
    for row in parsed_rows:
        serializable = {k: make_serializable(v) for k, v in row.items()}

        # parsed_date must be a Python date object for the Date column
        txn_date = row.get("transaction_date")

        raw = RawTransaction(
            import_batch_id=batch.id,
            row_number=row.get("row_number", 0),
            raw_data=serializable,
            parsed_date=txn_date if hasattr(txn_date, "isoformat") else None,
            status="PENDING",
        )
        db.add(raw)

    db.commit()
    db.refresh(batch)

    return {
        "batch_id": batch.id,
        "brokerage": brokerage_code,
        "filename": filename,
        "row_count": len(parsed_rows),
        "message": "File uploaded and parsed successfully",
    }


@router.get("", response_model=list[ImportBatchResponse])
def list_imports(db: Session = Depends(get_db)):
    batches = db.query(ImportBatch).order_by(ImportBatch.import_date.desc()).all()
    return batches


@router.get("/{batch_id}/preview")
def preview_import(batch_id: int, db: Session = Depends(get_db)):
    """Preview parsed rows for a batch before committing."""
    batch = db.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found")

    raw_txns = db.query(RawTransaction).filter(
        RawTransaction.import_batch_id == batch_id
    ).order_by(RawTransaction.row_number).all()

    brokerage = db.get(Brokerage, batch.brokerage_id)

    rows = []
    for rt in raw_txns:
        # Resolve which account this row will land in (for display in the preview).
        resolved_account = _find_account(db, rt.raw_data, batch, brokerage)
        rows.append({
            "id": rt.id,
            "row_number": rt.row_number,
            "raw_data": rt.raw_data,
            "parsed_date": rt.parsed_date.isoformat() if rt.parsed_date else None,
            "status": rt.status,
            "error_message": rt.error_message,
            "transaction_id": rt.transaction_id,
            "resolved_account_id": resolved_account.id if resolved_account else None,
            "resolved_account_name": resolved_account.name if resolved_account else None,
        })

    return {
        "batch_id": batch_id,
        "filename": batch.filename,
        "status": batch.status,
        "row_count": batch.row_count,
        "rows": rows,
    }


@router.post("/{batch_id}/commit")
def commit_import(batch_id: int, db: Session = Depends(get_db)):
    """Commit all PENDING rows in a batch to the transactions table."""
    batch = db.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found")

    if batch.status == "COMMITTED":
        raise HTTPException(status_code=400, detail="Batch already committed")

    brokerage = db.get(Brokerage, batch.brokerage_id)
    raw_txns = db.query(RawTransaction).filter(
        RawTransaction.import_batch_id == batch_id,
        RawTransaction.status == "PENDING",
    ).all()

    imported = 0
    errors = 0
    skipped = 0

    # For IBKR multi-account batches (no fixed account_id), unmatched aliases are SKIPPED
    # rather than ERROR — the file may contain master-level rows that have no matching account.
    is_multi_account = not batch.account_id

    for rt in raw_txns:
        try:
            row = rt.raw_data
            typed_row = _cast_row_types(row)

            # Determine account
            account = _find_account(db, row, batch, brokerage)
            if not account:
                alias = row.get("account_name", "")
                if is_multi_account:
                    rt.status = "SKIPPED"
                    rt.error_message = f"No account matched for: {alias}"
                    skipped += 1
                else:
                    rt.status = "ERROR"
                    rt.error_message = "Account not found"
                    errors += 1
                continue

            # Normalize based on parser format or brokerage code.
            # Scotia Wealth rows are tagged with brokerage="SCOTIAWEALTH" by the parser;
            # they share the same normalizer as iTrade (row structure is identical).
            row_format = typed_row.get("brokerage", "")
            if row_format in ("SCOTIAWEALTH", "OLYMPIA") or (brokerage and brokerage.code == "ITRADE"):
                txn_dict = normalize_itrade_row(db, typed_row, account)
            else:
                txn_dict = normalize_ibkr_row(db, typed_row, account)

            if not txn_dict:
                rt.status = "SKIPPED"
                rt.error_message = "Could not normalize row"
                skipped += 1
                continue

            # Check for duplicates — skip unless force_import flag is set on the row
            if check_duplicate(db, txn_dict) and not row.get("force_import"):
                rt.status = "SKIPPED"
                rt.error_message = "Duplicate transaction"
                skipped += 1
                continue

            # Create transaction
            txn = Transaction(**txn_dict, raw_import_id=rt.id)
            db.add(txn)
            db.flush()

            rt.transaction_id = txn.id
            rt.status = "IMPORTED"
            rt.error_message = None  # Clear any previous warnings (e.g. duplicate pre-check)
            imported += 1

        except Exception as e:
            logger.exception("Error importing row %d: %s", rt.row_number, e)
            rt.status = "ERROR"
            rt.error_message = str(e)
            errors += 1

    batch.imported_count = imported
    batch.error_count = errors
    batch.status = "COMMITTED"
    db.commit()

    # Rebuild portfolio snapshots from the earliest imported date so that the
    # history chart, YTD P&L, and 1Y P&L metrics stay consistent automatically.
    if imported > 0:
        # Collect the affected account IDs and earliest transaction date
        imported_txns = db.query(Transaction).filter(
            Transaction.raw_import_id.in_([rt.id for rt in raw_txns if rt.status == "IMPORTED"])
        ).all()
        affected_account_ids = list({t.account_id for t in imported_txns if t.account_id})
        dates = [t.transaction_date for t in imported_txns if t.transaction_date]
        earliest = min(dates) if dates else None

        def _rebuild_snapshots():
            from app.database import SessionLocal
            from app.services.portfolio_history_service import compute_portfolio_snapshots
            _db = SessionLocal()
            try:
                compute_portfolio_snapshots(
                    _db,
                    account_ids=affected_account_ids if affected_account_ids else None,
                    from_date=earliest,
                )
            except Exception:
                logger.exception("Snapshot rebuild after import failed")
            finally:
                _db.close()

        threading.Thread(target=_rebuild_snapshots, daemon=True).start()

    return {
        "batch_id": batch_id,
        "imported": imported,
        "errors": errors,
        "skipped": skipped,
        "status": "COMMITTED",
    }


@router.post("/{batch_id}/check-duplicates")
def check_duplicates_preview(batch_id: int, db: Session = Depends(get_db)):
    """
    Pre-check all PENDING rows for duplicates without committing.
    Rows that would be skipped as duplicates get error_message='Duplicate transaction'
    but remain PENDING so the user can review and force-import them individually.
    """
    batch = db.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found")
    if batch.status == "COMMITTED":
        raise HTTPException(status_code=400, detail="Batch already committed")

    brokerage = db.get(Brokerage, batch.brokerage_id)
    raw_txns = db.query(RawTransaction).filter(
        RawTransaction.import_batch_id == batch_id,
        RawTransaction.status == "PENDING",
    ).all()

    checked = 0
    duplicates_found = 0

    for rt in raw_txns:
        try:
            row = rt.raw_data
            typed_row = _cast_row_types(row)
            account = _find_account(db, row, batch, brokerage)
            checked += 1

            if not account:
                continue

            row_format = typed_row.get("brokerage", "")
            if row_format in ("SCOTIAWEALTH", "OLYMPIA") or (brokerage and brokerage.code == "ITRADE"):
                txn_dict = normalize_itrade_row(db, typed_row, account)
            else:
                txn_dict = normalize_ibkr_row(db, typed_row, account)

            if not txn_dict:
                continue

            if check_duplicate(db, txn_dict):
                duplicates_found += 1
                rt.error_message = "Duplicate transaction"
            else:
                # Clear stale duplicate warning if row is no longer a duplicate
                if rt.error_message == "Duplicate transaction":
                    rt.error_message = None

        except Exception as e:
            logger.exception("Error checking duplicate for row %d: %s", rt.row_number, e)

    db.commit()
    return {"checked": checked, "duplicates_found": duplicates_found}


@router.post("/{batch_id}/remap-types")
def remap_types(batch_id: int, db: Session = Depends(get_db)):
    """
    Re-apply brokerage type mappings to all PENDING rows in a batch.
    Useful for batches uploaded before type mappings were configured, or before
    the Scotia Wealth parser was available (rows tagged brokerage=ITRADE).
    """
    batch = db.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found")
    if batch.status == "COMMITTED":
        raise HTTPException(status_code=400, detail="Cannot remap a committed batch")

    # Build type map for this batch's brokerage
    type_map: dict[str, str] = {
        m.raw_type: m.canonical_type
        for m in db.query(BrokerageTypeMapping)
            .filter(BrokerageTypeMapping.brokerage_id == batch.brokerage_id)
            .all()
    }
    if not type_map:
        return {"remapped": 0, "message": "No type mappings configured for this brokerage"}

    raw_txns = db.query(RawTransaction).filter(
        RawTransaction.import_batch_id == batch_id,
        RawTransaction.status == "PENDING",
    ).all()

    remapped = 0
    for rt in raw_txns:
        raw_act = (rt.raw_data or {}).get("raw_activity", "")
        if raw_act and raw_act in type_map:
            new_type = type_map[raw_act]
            if rt.raw_data.get("transaction_type") != new_type:
                # raw_data is a JSON column; replace the dict to trigger change detection
                updated = dict(rt.raw_data)
                updated["transaction_type"] = new_type
                rt.raw_data = updated
                remapped += 1

    db.commit()
    return {"remapped": remapped, "total_pending": len(raw_txns)}


@router.post("/{batch_id}/reject")
def reject_import(batch_id: int, db: Session = Depends(get_db)):
    """Mark batch as rejected (soft delete - keeps record for audit trail)."""
    batch = db.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found")
    batch.status = "REJECTED"
    db.commit()
    return {"batch_id": batch_id, "status": "REJECTED"}


@router.delete("/{batch_id}")
def delete_import(batch_id: int, db: Session = Depends(get_db)):
    """Permanently delete an import batch and all its raw rows."""
    batch = db.get(ImportBatch, batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Import batch not found")
    if batch.status == "COMMITTED":
        raise HTTPException(
            status_code=400,
            detail="Cannot delete a committed import — transactions have already been created. Delete the transactions instead."
        )
    raw_count = db.query(RawTransaction).filter(RawTransaction.import_batch_id == batch_id).delete()
    db.delete(batch)
    db.commit()
    return {"deleted_batch_id": batch_id, "raw_rows_deleted": raw_count}


@router.put("/{batch_id}/row/{row_id}")
def update_raw_row(
    batch_id: int,
    row_id: int,
    updates: dict,
    db: Session = Depends(get_db),
):
    rt = db.get(RawTransaction, row_id)
    if not rt or rt.import_batch_id != batch_id:
        raise HTTPException(status_code=404, detail="Row not found")
    # _status is a control field — don't store in raw_data
    new_status = updates.pop("_status", "PENDING")
    if updates:
        rt.raw_data = {**rt.raw_data, **updates}
    rt.status = new_status
    rt.error_message = None if new_status != "ERROR" else rt.error_message
    db.commit()
    return {"id": rt.id, "status": rt.status, "raw_data": rt.raw_data}
