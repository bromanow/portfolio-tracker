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


# ── Statement import (PDF → holdings snapshot) ───────────────────────────────
@router.post("/statement")
async def import_statement(
    file: UploadFile = File(...),
    owner: str = Form("Michelle"),
    account_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """Upload, parse, import and store an investment statement PDF."""
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a statement PDF.")
    pdf = await file.read()
    return process_statement_bytes(db, pdf, owner, account_id, file.filename or "statement.pdf")


def process_statement_bytes(db, pdf: bytes, owner: str, account_id: Optional[int],
                            original_filename: str, store: bool = True) -> dict:
    """Parse a statement PDF and import it. Value-only statements (no share counts, e.g.
    Principal) are tracked cash-neutrally; unit-bearing statements (Manulife) use true
    BUY/SELL/DEPOSIT. Shared by the upload endpoint and reprocess-from-storage. `store`
    saves the PDF + a StatementFile row (off when reprocessing an already-stored file)."""
    from decimal import Decimal
    from sqlalchemy import text as _sql
    from app.services import gemini_statement, statement_store
    from app.models.master import Brokerage, Account, Security
    from app.models.transactions import Transaction
    from app.models.prices import MarketPrice, HistoricalPrice
    from app.models.imports import StatementFile

    try:
        if gemini_statement.is_configured():
            parsed = gemini_statement.parse_statement(pdf)
        else:
            from app.parsers.manulife_statement import parse_manulife_pdf
            parsed = parse_manulife_pdf(pdf)
    except Exception as e:
        msg = str(e)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
            import re as _re
            secs_m = _re.search(r"(?:retry[_ ]?delay\D{0,15}|retry in\s*)(\d+(?:\.\d+)?)\s*s", msg, _re.I)
            secs = round(float(secs_m.group(1))) if secs_m else None
            if "PerDay" in msg or "per day" in msg.lower():
                detail = ("Gemini DAILY quota reached — the free tier allows only ~20 requests/day "
                          "per model and resets at midnight Pacific. Point GEMINI_API_KEY at a "
                          "billed project for much higher limits, or retry after the reset.")
            else:
                wait = f"~{secs}s" if secs else "about a minute"
                detail = (f"Gemini per-minute rate limit hit — wait {wait} and retry. The free tier "
                          "allows only a few requests per minute; enable billing to remove the throttle.")
            raise HTTPException(429, detail)
        hint = "" if gemini_statement.is_configured() else (
            " — No GEMINI_API_KEY is set, so only the no-key fallback ran (it reads just the "
            "newest Manulife layout). Set GEMINI_API_KEY in the backend to parse any statement format.")
        raise HTTPException(422, f"Could not parse statement: {e}{hint}")

    as_of = parsed["as_of"]
    ccy = (parsed.get("currency") or "CAD").upper()
    institution = parsed["institution"]
    inst_slug = "".join(c for c in institution.upper() if c.isalnum())[:14] or "STMT"
    acct_type = (parsed.get("account_type") or "NON_REG").upper().replace("(", "").replace(")", "").replace("-", "_")

    def _fx(d):
        if ccy == "CAD":
            return Decimal("1")
        try:
            from app.services.fx_service import get_rate
            r = get_rate(db, d, ccy, "CAD")
            return Decimal(str(r)) if r else Decimal("1")
        except Exception:
            return Decimal("1")
    fx = _fx(as_of)

    # Resolve the target account.
    if account_id is not None:
        # Explicit target: write straight into this account regardless of parsed
        # institution/type/owner. Lets statements that changed format (e.g. a plan
        # provider's internal account move) all land in ONE continuous account.
        acct = db.query(Account).filter(Account.id == account_id).first()
        if not acct:
            raise HTTPException(404, f"Account {account_id} not found.")
        brk = db.query(Brokerage).filter(Brokerage.id == acct.brokerage_id).first()
        # Derive a stable security-ticker prefix from the account's brokerage, so funds
        # stay on the same synthetic ticker across differently-formatted statements.
        _src = (brk.code.replace("STMT_", "", 1) if brk and brk.code else (brk.name if brk else institution))
        inst_slug = "".join(c for c in (_src or "STMT").upper() if c.isalnum())[:14] or "STMT"
        institution = (brk.name if brk else institution)
    else:
        # Auto: match/create by institution (→brokerage) + account_type + owner.
        brk = db.query(Brokerage).filter(Brokerage.code == f"STMT_{inst_slug}").first()
        if not brk:
            brk = Brokerage(name=institution[:100], code=f"STMT_{inst_slug}", active=True)
            db.add(brk); db.flush()
        acct = (db.query(Account)
                .filter(Account.brokerage_id == brk.id, Account.owner == owner,
                        Account.account_type == acct_type).first())
        if not acct:
            acct = Account(brokerage_id=brk.id, name=f"{institution} {acct_type} — {owner}"[:100],
                           account_type=acct_type, base_currency=ccy, owner=owner, active=True)
            db.add(acct); db.flush()

    iso = as_of.isoformat()
    Q2 = Decimal("0.01")
    pos_ref = lambda code: f"stmt-pos-{acct.id}-{code}-{iso}"
    dep_ref = f"stmt-dep-{acct.id}-{iso}"
    wd_ref = f"stmt-wd-{acct.id}-{iso}"

    # Idempotent re-upload: drop only THIS statement's rows (positions + cash flows for as_of).
    # Also clears rows from the older OPENING_BALANCE/PLAN_CONTRIBUTION model (stmt-flow-).
    db.execute(_sql("DELETE FROM transactions WHERE account_id = :aid AND ("
                    "external_ref LIKE :pos OR external_ref IN (:dep, :wd, :oldflow))"),
               {"aid": acct.id, "pos": f"stmt-pos-{acct.id}-%-{iso}",
                "dep": dep_ref, "wd": wd_ref, "oldflow": f"stmt-flow-{acct.id}-{iso}"})

    # Net statement position per security from EARLIER statements (engine-consistent:
    # BUY/OPENING_BALANCE add, SELL subtracts). Empty → this is the FIRST statement.
    prior_rows = db.execute(_sql(
        "SELECT security_id, COALESCE(SUM(CASE "
        "WHEN transaction_type IN ('BUY','OPENING_BALANCE') THEN quantity "
        "WHEN transaction_type = 'SELL' THEN -ABS(quantity) ELSE 0 END), 0) AS q "
        "FROM transactions WHERE account_id = :aid AND external_ref LIKE :pat "
        "AND transaction_date < :asof GROUP BY security_id"),
        {"aid": acct.id, "pat": f"stmt-pos-{acct.id}-%", "asof": as_of}).fetchall()
    prior = {r[0]: Decimal(str(r[1])) for r in prior_rows if Decimal(str(r[1])) != 0}
    is_first = len(prior) == 0
    seen_sids: set[int] = set()

    def _set_price(sec, price):
        price_cad = (price * fx).quantize(Decimal("0.0001"))
        mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
        if not mp:
            mp = MarketPrice(security_id=sec.id, price=price, currency=ccy); db.add(mp)
        if mp.price_date is None or as_of >= mp.price_date:   # don't regress live price w/ an old statement
            mp.price = price; mp.currency = ccy; mp.price_cad = price_cad; mp.price_date = as_of; mp.source = "statement"
        hp = (db.query(HistoricalPrice)
              .filter(HistoricalPrice.security_id == sec.id, HistoricalPrice.price_date == as_of).first())
        if not hp:
            hp = HistoricalPrice(security_id=sec.id, price_date=as_of, currency=ccy, source="statement"); db.add(hp)
        hp.close_price = price; hp.close_price_cad = price_cad; hp.currency = ccy

    def _pos(sec, code, ttype, qty, price, native_amt, label):
        # quantity always positive; native_amt signed by cash direction (BUY −, SELL +).
        db.add(Transaction(
            account_id=acct.id, security_id=sec.id, transaction_date=as_of,
            transaction_type=ttype, quantity=qty, price=price, transaction_currency=ccy,
            transaction_amount=native_amt.quantize(Q2), cad_amount=(native_amt * fx).quantize(Q2),
            raw_description=f"{institution} statement {iso}: {label}"[:500], external_ref=pos_ref(code),
        ))

    # A statement is "value-only" when it reports dollar values but no share counts (e.g.
    # Principal 401k). Real BUY/SELL/DEPOSIT can't be reconstructed from that — recording them
    # produces unfunded buys + phantom cash — so we track value CASH-NEUTRALLY instead.
    # Unit-bearing statements (Manulife) keep the true trade model.
    value_only = not any((h.get("units") or Decimal("0")) for h in parsed["holdings"])

    def _code_for(h, i):
        c = (h.get("code") or "").strip()
        if c:
            return c
        # No code → normalize the name to a stable key so the same fund matches across
        # quarters despite minor wording drift from the LLM (kills phantom ghost holdings).
        return "".join(ch for ch in (h.get("name") or "").upper() if ch.isalnum())[:24] or f"H{i}"

    # ── Resolve securities + gather per-fund data ──
    items = []   # (sec, code, name, units, nav, delta, value, contrib)
    for i, h in enumerate(parsed["holdings"]):
        code = _code_for(h, i)
        units = h.get("units") or Decimal("0")
        value = h["value"]
        nav = h.get("unit_price")
        if units == 0:                       # value-only line → 1 unit @ value (price = value)
            units, nav = Decimal("1"), value
        elif nav is None:
            nav = (value / units) if units else value

        ticker = f"{inst_slug}:{code}"
        sec = db.query(Security).filter(Security.ticker == ticker).first()
        if not sec:
            sec = Security(ticker=ticker, name=h["name"], asset_class="FUND", currency=ccy)
            db.add(sec); db.flush()
        elif h["name"] and not sec.name:
            sec.name = h["name"]
        seen_sids.add(sec.id)
        if not value_only:                   # value-only sets price = value/cost in its branch
            _set_price(sec, nav)
        items.append((sec, code, h["name"], units, nav, units - prior.get(sec.id, Decimal("0")),
                      value, h.get("contributions")))

    # Funds held per earlier statements but absent now (with their last price for a sell).
    dropped = []   # (sec, code, name, qty, nav)
    for sid, qty in prior.items():
        if sid in seen_sids or qty <= 0:
            continue
        sec = db.query(Security).filter(Security.id == sid).first()
        if not sec:
            continue
        _mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
        nav = (_mp.price if _mp and _mp.price is not None else Decimal("0"))
        dropped.append((sec, sec.ticker.split(":", 1)[-1], sec.name or sec.ticker, qty, nav))

    flows = parsed.get("flows") or {}
    period_start = parsed.get("period_start")
    flow_date = as_of
    if period_start and period_start < as_of:
        flow_date = period_start + (as_of - period_start) // 2   # midpoint ≈ evenly-paced flows

    def _flow(ttype, native_amt, ext, label):
        db.add(Transaction(
            account_id=acct.id, security_id=None, transaction_date=flow_date,
            transaction_type=ttype, quantity=None, price=None, transaction_currency=ccy,
            transaction_amount=native_amt.quantize(Q2), cad_amount=(native_amt * fx).quantize(Q2),
            raw_description=f"{institution} {iso}: {label}"[:500], external_ref=ext,
        ))

    deposit_recorded = None
    if value_only:
        # COST-BASIS model: quantity = cumulative dollars contributed, price = value ÷ cost so
        # gain/loss rides in the price (the price table). Contributions → DEPOSIT + BUY (cash-neutral
        # pair); a fund's first appearance opens at its value as the cost baseline. No phantom cash.
        # Fund switches (e.g. 2035→2040 target date) are recorded separately as cash/gain-neutral
        # JOURNALs via the manual switch tool — a drop here just zeroes a vanished fund's value.
        acct_contrib = flows.get("contributions") or Decimal("0")
        total_value = sum((v for (*_x, v, _ch) in items), Decimal("0"))
        total_dep = Decimal("0")
        for sec, code, name, _u, _nav, _d, value, c_h in items:
            prior_cb = prior.get(sec.id, Decimal("0"))
            if prior_cb <= 0:                # first appearance → cost baseline = current value
                _pos(sec, code, "OPENING_BALANCE", value, Decimal("1"), value, f"{name} (opening cost)")
                _set_price(sec, Decimal("1"))
                continue
            c_fund = c_h if c_h is not None else (
                (acct_contrib * value / total_value) if (acct_contrib > 0 and total_value > 0) else Decimal("0"))
            c_fund = (c_fund or Decimal("0")).quantize(Q2)
            cb = prior_cb
            if c_fund > 0:                   # contribution → BUY $c @ $1 (funded by the DEPOSIT below)
                _pos(sec, code, "BUY", c_fund, Decimal("1"), -c_fund, f"{name} (contribution)")
                total_dep += c_fund
                cb = prior_cb + c_fund
            _set_price(sec, (value / cb) if cb > 0 else Decimal("1"))   # gain/loss → price
        if total_dep > 0:
            _flow("DEPOSIT", total_dep, dep_ref, "plan contributions")
            deposit_recorded = str((total_dep * fx).quantize(Q2))
        for sec, code, name, _qty, _nav in dropped:
            _set_price(sec, Decimal("0"))    # vanished fund → value 0 (no cash; switches use JOURNAL)
    elif is_first:
        # First unit-bearing statement → opening balances at NAV (cash-neutral; cost = units × NAV).
        for sec, code, name, units, nav, _delta, _v, _ch in items:
            if units > 0:
                _pos(sec, code, "OPENING_BALANCE", units, nav, units * nav, f"{name} (opening balance)")
    else:
        # Subsequent unit-bearing statements → real BUY/SELL for the unit change + DEPOSIT/
        # WITHDRAWAL for external cash. transfers_in are INTERNAL (ignored) per account continuity.
        for sec, code, name, qty, nav in dropped:
            items.append((sec, code, name, Decimal("0"), nav, -qty, Decimal("0"), None))
        C = flows.get("contributions") or Decimal("0")
        W = flows.get("withdrawals") or Decimal("0")
        buys  = [(s, c, n, d, nav) for (s, c, n, u, nav, d, _v, _ch) in items if d > 0]
        sells = [(s, c, n, -d, nav) for (s, c, n, u, nav, d, _v, _ch) in items if d < 0]
        S_nav = sum((q * nav for (_, _, _, q, nav) in sells), Decimal("0"))
        B_nav = sum((q * nav for (_, _, _, q, nav) in buys), Decimal("0"))
        # Deploy net external cash (contributions − withdrawals + sale proceeds) into the buys, so
        # the account's cash nets to $0. Cost basis = cash paid; market value still comes from NAV.
        funding = C - W + S_nav
        scale = (funding / B_nav) if (B_nav > 0 and funding > 0) else Decimal("1")

        for s, c, n, q, nav in sells:                       # cash IN (+)
            _pos(s, c, "SELL", q, nav, q * nav, f"{n} (sell)")
        for s, c, n, q, nav in buys:                        # cash OUT (−)
            cost = (q * nav * scale)
            buy_price = (cost / q) if q != 0 else nav
            _pos(s, c, "BUY", q, buy_price, -cost, f"{n} (buy)")

        if C > 0:
            _flow("DEPOSIT", C, dep_ref, "plan contribution")
            deposit_recorded = str((C * fx).quantize(Q2))
        if W > 0:
            _flow("WITHDRAWAL", -W, wd_ref, "withdrawal")

    db.commit()

    # Rebuild this account's snapshots so the Performance chart reflects the new point/flow.
    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db, account_ids=[acct.id])
    except Exception as e:
        logger.warning("statement import: snapshot recompute failed for acct %s: %s", acct.id, e)

    # Store the source PDF on disk + a metadata row (replaces a prior file for same acct+date).
    # Skipped when reprocessing an already-stored file (store=False).
    if store:
        try:
            for old in db.query(StatementFile).filter(
                    StatementFile.account_id == acct.id, StatementFile.as_of == as_of).all():
                statement_store.remove(old.stored_filename)
                db.delete(old)
            stored = statement_store.stored_name(original_filename)
            statement_store.save(stored, pdf)
            db.add(StatementFile(
                account_id=acct.id, institution=institution[:120], owner=owner, as_of=as_of,
                stored_filename=stored, original_filename=original_filename[:255],
                content_type="application/pdf", byte_size=len(pdf),
                engine=("gemini" if gemini_statement.is_configured() else "regex"),
            ))
            db.commit()
        except Exception as e:
            db.rollback()
            logger.warning("statement import: storing PDF failed for acct %s: %s", acct.id, e)

    total = sum((h["value"] for h in parsed["holdings"]), Decimal("0"))
    return {
        "institution": institution, "account": acct.name, "as_of": iso,
        "currency": ccy, "holdings": len(parsed["holdings"]),
        "total": str((total * fx).quantize(Decimal("0.01"))),
        "contribution": deposit_recorded,
        "engine": "gemini" if gemini_statement.is_configured() else "regex",
    }


@router.get("/statements")
def list_statements(db: Session = Depends(get_db)):
    """Stored statement PDFs, newest first (for the Statements import panel)."""
    from app.models.imports import StatementFile
    from app.models.master import Account
    rows = (db.query(StatementFile)
            .order_by(StatementFile.uploaded_at.desc(), StatementFile.id.desc()).all())
    acct_names = {a.id: a.name for a in db.query(Account).all()}
    return [{
        "id": r.id,
        "account_id": r.account_id,
        "account": acct_names.get(r.account_id),
        "institution": r.institution,
        "owner": r.owner,
        "as_of": r.as_of.isoformat() if r.as_of else None,
        "original_filename": r.original_filename,
        "byte_size": r.byte_size,
        "engine": r.engine,
        "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
    } for r in rows]


@router.get("/statements/{statement_id}/file")
def view_statement_file(statement_id: int, db: Session = Depends(get_db)):
    """Stream a stored statement PDF inline (frontend fetches as a blob and opens it)."""
    import os
    from fastapi.responses import FileResponse
    from app.models.imports import StatementFile
    from app.services import statement_store
    r = db.query(StatementFile).filter(StatementFile.id == statement_id).first()
    if not r:
        raise HTTPException(404, "Statement not found.")
    fp = statement_store.path_for(r.stored_filename)
    if not os.path.exists(fp):
        raise HTTPException(404, "File missing on disk (was the storage volume reset?).")
    return FileResponse(
        fp, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{r.original_filename or "statement.pdf"}"'},
    )


@router.delete("/statements/{statement_id}")
def delete_statement_file(statement_id: int, db: Session = Depends(get_db)):
    """Remove a stored statement PDF (does not touch the imported holdings/flows)."""
    from app.models.imports import StatementFile
    from app.services import statement_store
    r = db.query(StatementFile).filter(StatementFile.id == statement_id).first()
    if not r:
        raise HTTPException(404, "Statement not found.")
    statement_store.remove(r.stored_filename)
    db.delete(r); db.commit()
    return {"deleted": statement_id}


def _reprocess_one(db, sf) -> dict:
    import os
    from app.services import statement_store
    fp = statement_store.path_for(sf.stored_filename)
    if not os.path.exists(fp):
        raise HTTPException(404, "File missing on disk (was the storage volume reset?).")
    with open(fp, "rb") as f:
        pdf = f.read()
    return process_statement_bytes(db, pdf, sf.owner or "", sf.account_id,
                                   sf.original_filename or "statement.pdf", store=False)


@router.post("/statements/{statement_id}/reprocess")
def reprocess_statement(statement_id: int, db: Session = Depends(get_db)):
    """Re-run the import on an already-stored statement PDF, into its same account — e.g.
    after a parser/model change, with no re-upload needed."""
    from app.models.imports import StatementFile
    sf = db.query(StatementFile).filter(StatementFile.id == statement_id).first()
    if not sf:
        raise HTTPException(404, "Statement not found.")
    return _reprocess_one(db, sf)


@router.post("/statements/reprocess")
def reprocess_statements(account_id: Optional[int] = None, db: Session = Depends(get_db)):
    """Reprocess all stored statements (optionally only one account), oldest→newest so the
    delta/matching stays consistent. Re-parses each PDF via Gemini, so it consumes quota."""
    from app.models.imports import StatementFile
    q = db.query(StatementFile)
    if account_id:
        q = q.filter(StatementFile.account_id == account_id)
    files = q.order_by(StatementFile.as_of.asc(), StatementFile.id.asc()).all()
    results = []
    for sf in files:
        iso = sf.as_of.isoformat() if sf.as_of else None
        try:
            r = _reprocess_one(db, sf)
            results.append({"id": sf.id, "as_of": r["as_of"], "account": r["account"], "holdings": r["holdings"]})
        except HTTPException as e:
            results.append({"id": sf.id, "as_of": iso, "error": str(e.detail)})
        except Exception as e:
            results.append({"id": sf.id, "as_of": iso, "error": str(e)[:200]})
    return {"reprocessed": sum(1 for r in results if "error" not in r), "total": len(files), "results": results}


@router.get("/status")
def import_status(db: Session = Depends(get_db)):
    """Per-account data-freshness overview for the Import → Status tab: last load + latest
    transaction date per account, grouped by brokerage, with a per-source staleness flag."""
    from datetime import date as _date, datetime as _dt
    from sqlalchemy import text as _sql
    from app.models.master import Account, Brokerage

    def _maxmap(q: str) -> dict:
        return {r[0]: r[1] for r in db.execute(_sql(q)).fetchall() if r[0] is not None}

    latest_txn = _maxmap("SELECT account_id, MAX(transaction_date) FROM transactions GROUP BY account_id")
    csv_load   = _maxmap("SELECT account_id, MAX(import_date) FROM import_batches GROUP BY account_id")
    stmt_load  = _maxmap("SELECT account_id, MAX(uploaded_at) FROM statement_files GROUP BY account_id")
    plaid_load = _maxmap("SELECT pa.account_id, MAX(pi.last_synced_at) FROM plaid_accounts pa "
                         "JOIN plaid_items pi ON pa.plaid_item_id = pi.id GROUP BY pa.account_id")
    stmt_accts = set(_maxmap("SELECT account_id, COUNT(*) FROM transactions "
                             "WHERE external_ref LIKE 'stmt-pos-%' GROUP BY account_id").keys())

    ibkr_row = db.execute(_sql("SELECT MAX(last_sync_at) FROM ibkr_flex_configs WHERE enabled = true")).fetchone()
    ibkr_load = ibkr_row[0] if ibkr_row else None
    st_row = db.execute(_sql("SELECT last_sync_status, last_sync_message FROM ibkr_flex_configs "
                             "WHERE last_sync_at IS NOT NULL ORDER BY last_sync_at DESC LIMIT 1")).fetchone()
    ibkr_status, ibkr_msg = (st_row[0], st_row[1]) if st_row else (None, None)

    # Days-old thresholds before a source is "stale" (None = never auto-flag).
    THRESH = {"Plaid": 3, "IBKR Flex": 4, "Statement": 130, "CSV": 45, "Manual": None}

    def _as_date(v):
        if v is None:
            return None
        return v.date() if isinstance(v, _dt) else v

    today = _date.today()
    brks = {b.id: b for b in db.query(Brokerage).all()}

    # Active accounts only; CAD+USD sub-accounts (iTrade, Scotia Wealth, …) collapse into one
    # logical row by stripping " (USD)" — mirrors the Performance "logical account" grouping.
    merged: dict[tuple, dict] = {}
    for a in db.query(Account).filter(Account.active == True).all():  # noqa: E712
        aid = a.id
        if aid in plaid_load:
            source, loaded = "Plaid", plaid_load.get(aid)
        elif aid in stmt_accts or aid in stmt_load:
            source, loaded = "Statement", stmt_load.get(aid)
        elif a.ibkr_alias:
            source, loaded = "IBKR Flex", ibkr_load
        elif aid in csv_load:
            source, loaded = "CSV", csv_load.get(aid)
        else:
            source, loaded = "Manual", latest_txn.get(aid)

        loaded_d = _as_date(loaded)
        last_d = _as_date(latest_txn.get(aid))
        note = None
        if source == "IBKR Flex" and ibkr_status and ibkr_status != "ok":
            note = (ibkr_msg or ibkr_status)[:160]

        logical = a.name.replace(" (USD)", "").strip()
        is_usd = a.name != logical
        brokerage = brks[a.brokerage_id].name if a.brokerage_id in brks else "—"
        key = (brokerage, a.owner, a.account_type, logical)

        m = merged.get(key)
        if m is None:
            merged[key] = {
                "account_id": aid, "primary_is_usd": is_usd, "brokerage": brokerage,
                "account": logical, "owner": a.owner, "account_type": a.account_type,
                "source": source, "loaded_d": loaded_d, "last_d": last_d, "note": note,
            }
        else:
            if m["primary_is_usd"] and not is_usd:   # prefer the CAD sub as the row's primary
                m["account_id"], m["primary_is_usd"], m["source"] = aid, False, source
            if loaded_d and (m["loaded_d"] is None or loaded_d > m["loaded_d"]):
                m["loaded_d"] = loaded_d
            if last_d and (m["last_d"] is None or last_d > m["last_d"]):
                m["last_d"] = last_d
            if note and not m["note"]:
                m["note"] = note

    rows = []
    for m in merged.values():
        loaded_d, source = m["loaded_d"], m["source"]
        days = (today - loaded_d).days if loaded_d else None
        thr = THRESH.get(source)
        stale = (loaded_d is None) or (thr is not None and days is not None and days > thr)
        rows.append({
            "account_id": m["account_id"], "brokerage": m["brokerage"], "account": m["account"],
            "owner": m["owner"], "account_type": m["account_type"], "source": source,
            "last_loaded": loaded_d.isoformat() if loaded_d else None,
            "latest_txn": m["last_d"].isoformat() if m["last_d"] else None,
            "days_since_load": days, "stale": bool(stale), "note": m["note"],
        })

    rows.sort(key=lambda r: (not r["stale"], r["brokerage"] or "", r["account"] or ""))
    return rows


@router.post("/statements/handoff")
def statement_handoff(payload: dict, db: Session = Depends(get_db)):
    """Freeze an account's statement-sourced positions as of a cutover date so a live
    feed (e.g. Plaid) can take over without double-counting.

    Inserts one cash-neutral TRANSFER_OUT per statement-held security (net position handed
    to the live feed) dated at the cutover, so the statements drive value/returns BEFORE the
    cutover and the live feed drives them after. Idempotent + re-runnable (replaces a prior
    handoff)."""
    from datetime import date as _date, datetime as _dt
    from decimal import Decimal
    from sqlalchemy import text as _sql
    from app.models.master import Account
    from app.models.transactions import Transaction

    account_id = payload.get("account_id")
    if not account_id:
        raise HTTPException(400, "account_id is required.")
    acct = db.query(Account).filter(Account.id == account_id).first()
    if not acct:
        raise HTTPException(404, f"Account {account_id} not found.")

    raw_cut = (payload.get("cutover_date") or "").strip()
    try:
        cutover = _dt.strptime(raw_cut, "%Y-%m-%d").date() if raw_cut else _date.today()
    except Exception:
        cutover = _date.today()

    base_ccy = (acct.base_currency or "CAD").upper()
    # Net statement position per security (engine-consistent: BUY/OPENING_BALANCE add, SELL subtracts).
    rows = db.execute(_sql(
        "SELECT security_id, COALESCE(SUM(CASE "
        "WHEN transaction_type IN ('BUY','OPENING_BALANCE') THEN quantity "
        "WHEN transaction_type = 'SELL' THEN -ABS(quantity) ELSE 0 END), 0) q "
        "FROM transactions WHERE account_id = :aid AND external_ref LIKE :pat "
        "AND transaction_date <= :cut GROUP BY security_id"),
        {"aid": account_id, "pat": f"stmt-pos-{account_id}-%", "cut": cutover}).fetchall()

    # Replace any prior handoff so a new cutover date fully supersedes the old one.
    db.execute(_sql("DELETE FROM transactions WHERE account_id = :aid AND external_ref LIKE :pat"),
               {"aid": account_id, "pat": f"stmt-handoff-{account_id}-%"})

    unwound = 0
    for sid, q in rows:
        q = Decimal(str(q))
        if q <= 0:
            continue
        # TRANSFER_OUT reduces the position (qty positive, _QTY_SUB) with zero cash impact,
        # so the holding leaves statement tracking for the live feed without touching cash.
        db.add(Transaction(
            account_id=account_id, security_id=sid, transaction_date=cutover,
            transaction_type="TRANSFER_OUT", quantity=q, price=None,
            transaction_currency=base_ccy, transaction_amount=Decimal("0"), cad_amount=Decimal("0"),
            raw_description=f"Statement → live-feed handoff as of {cutover.isoformat()}"[:500],
            external_ref=f"stmt-handoff-{account_id}-{sid}",
        ))
        unwound += 1
    db.commit()

    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db, account_ids=[account_id])
    except Exception as e:
        logger.warning("handoff: snapshot recompute failed for acct %s: %s", account_id, e)

    return {"account": acct.name, "cutover_date": cutover.isoformat(), "securities_unwound": unwound}


@router.post("/switch")
def switch_security(payload: dict, db: Session = Depends(get_db)):
    """Record a fund switch (e.g. a target-date roll 2035→2040) as a cash- AND gain/loss-neutral
    in-kind JOURNAL: the from-fund's whole position + cost basis move to the to-fund at book value,
    and the to-fund inherits the from-fund's price so its market value and unrealized gain carry over
    unchanged. Switches can't be detected from value-only statements, so they're recorded here."""
    from datetime import date as _date, datetime as _dt
    from decimal import Decimal
    from sqlalchemy import text as _sql
    from app.models.master import Account, Security
    from app.models.transactions import Transaction
    from app.models.prices import MarketPrice, HistoricalPrice

    account_id = payload.get("account_id")
    from_id = payload.get("from_security_id")
    to_id = payload.get("to_security_id")
    if not (account_id and from_id and to_id):
        raise HTTPException(400, "account_id, from_security_id and to_security_id are required.")
    if from_id == to_id:
        raise HTTPException(400, "The from and to securities must be different.")
    acct = db.query(Account).filter(Account.id == account_id).first()
    from_sec = db.query(Security).filter(Security.id == from_id).first()
    to_sec = db.query(Security).filter(Security.id == to_id).first()
    if not acct or not from_sec or not to_sec:
        raise HTTPException(404, "Account or security not found.")

    raw = (payload.get("switch_date") or "").strip()
    try:
        sdate = _dt.strptime(raw, "%Y-%m-%d").date() if raw else _date.today()
    except Exception:
        sdate = _date.today()

    # from-fund's net position + cost basis (native) in this account, up to the switch date.
    row = db.execute(_sql(
        "SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('BUY','OPENING_BALANCE','JOURNAL') THEN quantity "
        "WHEN transaction_type='SELL' THEN -ABS(quantity) ELSE 0 END),0) qty, "
        "COALESCE(SUM(CASE WHEN transaction_type IN ('BUY','OPENING_BALANCE') THEN ABS(transaction_amount) "
        "WHEN transaction_type='SELL' THEN -ABS(transaction_amount) "
        "WHEN transaction_type='JOURNAL' THEN transaction_amount ELSE 0 END),0) cost "
        "FROM transactions WHERE account_id=:aid AND security_id=:sid AND transaction_date <= :d"),
        {"aid": account_id, "sid": from_id, "d": sdate}).fetchone()
    qty, cost = Decimal(str(row[0])), Decimal(str(row[1]))
    if qty <= 0:
        raise HTTPException(400, f"{from_sec.name or from_sec.ticker} has no position to switch as of {sdate}.")

    Q2 = Decimal("0.01")
    ccy = (from_sec.currency or acct.base_currency or "CAD").upper()
    fx = Decimal("1")
    if ccy != "CAD":
        try:
            from app.services.fx_service import get_rate
            r = get_rate(db, sdate, ccy, "CAD"); fx = Decimal(str(r)) if r else Decimal("1")
        except Exception:
            fx = Decimal("1")
    cost_cad = (cost * fx).quantize(Q2)
    ref = f"stmt-switch-{account_id}-{from_id}-{to_id}-{sdate.isoformat()}"
    db.execute(_sql("DELETE FROM transactions WHERE account_id=:aid AND external_ref LIKE :p"),
               {"aid": account_id, "p": f"stmt-switch-{account_id}-{from_id}-{to_id}-%"})

    # In-kind transfer at book value: JOURNAL out of `from`, JOURNAL in to `to` (cash & gain neutral).
    db.add(Transaction(account_id=account_id, security_id=from_id, transaction_date=sdate,
        transaction_type="JOURNAL", quantity=-qty, price=None, transaction_currency=ccy,
        transaction_amount=(-cost).quantize(Q2), cad_amount=(-cost_cad),
        raw_description=f"Switch → {to_sec.name or to_sec.ticker}"[:500], external_ref=ref + "-out"))
    db.add(Transaction(account_id=account_id, security_id=to_id, transaction_date=sdate,
        transaction_type="JOURNAL", quantity=qty, price=None, transaction_currency=ccy,
        transaction_amount=cost.quantize(Q2), cad_amount=cost_cad,
        raw_description=f"Switch ← {from_sec.name or from_sec.ticker}"[:500], external_ref=ref + "-in"))

    # to-fund inherits from-fund's current price → market value + unrealized gain are preserved.
    from_mp = db.query(MarketPrice).filter(MarketPrice.security_id == from_id).first()
    if from_mp and from_mp.price is not None:
        to_mp = db.query(MarketPrice).filter(MarketPrice.security_id == to_id).first()
        if not to_mp:
            to_mp = MarketPrice(security_id=to_id, price=from_mp.price, currency=ccy); db.add(to_mp)
        to_mp.price = from_mp.price; to_mp.price_cad = from_mp.price_cad
        to_mp.currency = ccy; to_mp.price_date = sdate; to_mp.source = "switch"
        hp = (db.query(HistoricalPrice)
              .filter(HistoricalPrice.security_id == to_id, HistoricalPrice.price_date == sdate).first())
        if not hp:
            hp = HistoricalPrice(security_id=to_id, price_date=sdate, currency=ccy, source="switch"); db.add(hp)
        hp.close_price = from_mp.price; hp.close_price_cad = from_mp.price_cad; hp.currency = ccy
    db.commit()

    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db, account_ids=[account_id])
    except Exception as e:
        logger.warning("switch: snapshot recompute failed for acct %s: %s", account_id, e)

    return {"account": acct.name, "from": from_sec.name or from_sec.ticker,
            "to": to_sec.name or to_sec.ticker, "switch_date": sdate.isoformat(),
            "units_moved": str(qty), "value_moved_cad": str(cost_cad)}
