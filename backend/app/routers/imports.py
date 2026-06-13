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
    db: Session = Depends(get_db),
):
    """Parse an investment statement PDF into a holdings time series.

    Each statement is recorded AS OF its period-end date, as the per-fund unit
    *delta* since the prior statement (cash-neutral OPENING_BALANCE rows), so the
    account's value history is preserved across successive statements (the chart
    shows the real value at each statement date, not just the latest). The period's
    net contribution is recorded as a PLAN_CONTRIBUTION flow — an external inflow for
    the Modified-Dietz return calc, but cash-neutral in valuation (its value is
    already inside the holdings). Re-uploading the same statement is idempotent.

    Uses Gemini for institution-agnostic extraction; falls back to the Manulife
    regex parser when no GEMINI_API_KEY is set."""
    from decimal import Decimal
    from sqlalchemy import text as _sql
    from app.services import gemini_statement
    from app.models.master import Brokerage, Account, Security
    from app.models.transactions import Transaction
    from app.models.prices import MarketPrice, HistoricalPrice

    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a statement PDF.")
    pdf = await file.read()
    try:
        if gemini_statement.is_configured():
            parsed = gemini_statement.parse_statement(pdf)
        else:
            from app.parsers.manulife_statement import parse_manulife_pdf
            parsed = parse_manulife_pdf(pdf)
    except Exception as e:
        raise HTTPException(422, f"Could not parse statement: {e}")

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

    # Brokerage + account (one per institution + owner + account_type)
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
    pos_ref = lambda code: f"stmt-pos-{acct.id}-{code}-{iso}"
    flow_ref = f"stmt-flow-{acct.id}-{iso}"

    # Idempotent re-upload: drop only THIS statement's rows (positions + flow for as_of).
    db.execute(_sql("DELETE FROM transactions WHERE account_id = :aid "
                    "AND (external_ref LIKE :pos OR external_ref = :flow)"),
               {"aid": acct.id, "pos": f"stmt-pos-{acct.id}-%-{iso}", "flow": flow_ref})

    # Cumulative units per security from EARLIER statements (running position just before as_of).
    prior_rows = db.execute(_sql(
        "SELECT security_id, COALESCE(SUM(quantity), 0) AS q FROM transactions "
        "WHERE account_id = :aid AND transaction_type = 'OPENING_BALANCE' "
        "AND external_ref LIKE :pat AND transaction_date < :asof GROUP BY security_id"),
        {"aid": acct.id, "pat": f"stmt-pos-{acct.id}-%", "asof": as_of}).fetchall()
    prior = {r[0]: Decimal(str(r[1])) for r in prior_rows}
    seen_sids: set[int] = set()

    def _set_price(sec, price, price_cad):
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

    def _add_delta(sec, code, delta_units, price, name):
        if delta_units == 0:
            return
        price_cad = (price * fx).quantize(Decimal("0.0001"))
        amt_cad = (delta_units * price * fx).quantize(Decimal("0.01"))
        db.add(Transaction(
            account_id=acct.id, security_id=sec.id, transaction_date=as_of,
            transaction_type="OPENING_BALANCE", quantity=delta_units, price=price,
            transaction_currency=ccy, transaction_amount=amt_cad, cad_amount=amt_cad,
            raw_description=f"{institution} statement {iso}: {name} (Δ units)"[:500],
            external_ref=pos_ref(code),
        ))

    for i, h in enumerate(parsed["holdings"]):
        code = (h.get("code") or "").strip() or "".join(c for c in h["name"].upper() if c.isalnum())[:12] or f"H{i}"
        units = h.get("units") or Decimal("0")
        value = h["value"]
        price = h.get("unit_price")
        if units == 0:                       # value-only line → treat as 1 unit @ value
            units, price = Decimal("1"), value
        elif price is None:
            price = (value / units) if units else value
        price_cad = (price * fx).quantize(Decimal("0.0001"))

        ticker = f"{inst_slug}:{code}"
        sec = db.query(Security).filter(Security.ticker == ticker).first()
        if not sec:
            sec = Security(ticker=ticker, name=h["name"], asset_class="FUND", currency=ccy)
            db.add(sec); db.flush()
        elif h["name"] and not sec.name:
            sec.name = h["name"]
        seen_sids.add(sec.id)

        _set_price(sec, price, price_cad)
        _add_delta(sec, code, units - prior.get(sec.id, Decimal("0")), price, h["name"])

    # Funds held per earlier statements but absent now → unwind to zero as of this date.
    for sid, qty in prior.items():
        if sid in seen_sids or qty == 0:
            continue
        sec = db.query(Security).filter(Security.id == sid).first()
        if not sec:
            continue
        code = sec.ticker.split(":", 1)[-1]
        _mp = db.query(MarketPrice).filter(MarketPrice.security_id == sec.id).first()
        last_px = (_mp.price if _mp and _mp.price is not None else Decimal("0"))  # position →0 anyway
        _add_delta(sec, code, -qty, last_px, sec.name or code)

    # ── Period contribution → cash-neutral external flow (for Modified-Dietz returns) ──
    flows = parsed.get("flows") or {}
    net_c = ((flows.get("contributions") or Decimal("0"))
             + (flows.get("transfers_in") or Decimal("0"))
             - (flows.get("withdrawals") or Decimal("0")))
    contribution_recorded = None
    if net_c != 0:
        period_start = parsed.get("period_start")
        flow_date = as_of
        if period_start and period_start < as_of:
            flow_date = period_start + (as_of - period_start) // 2   # midpoint ≈ evenly-paced contributions
        net_c_cad = (net_c * fx).quantize(Decimal("0.01"))
        db.add(Transaction(
            account_id=acct.id, security_id=None, transaction_date=flow_date,
            transaction_type="PLAN_CONTRIBUTION", quantity=None, price=None,
            transaction_currency=ccy, transaction_amount=net_c.quantize(Decimal("0.01")), cad_amount=net_c_cad,
            raw_description=f"{institution} {iso}: net contribution for period"[:500],
            external_ref=flow_ref,
        ))
        contribution_recorded = str(net_c_cad)

    db.commit()

    # Rebuild this account's snapshots so the Performance chart reflects the new point/flow.
    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db, account_ids=[acct.id])
    except Exception as e:
        logger.warning("statement import: snapshot recompute failed for acct %s: %s", acct.id, e)

    total = sum((h["value"] for h in parsed["holdings"]), Decimal("0"))
    return {
        "institution": institution, "account": acct.name, "as_of": iso,
        "currency": ccy, "holdings": len(parsed["holdings"]),
        "total": str((total * fx).quantize(Decimal("0.01"))),
        "contribution": contribution_recorded,
        "engine": "gemini" if gemini_statement.is_configured() else "regex",
    }
