"""Fix mis-typed reinvestment transactions.

Some ScotiaMacleod private-pool/fund reinvestments (e.g. Scotia Wealth's "SHORT-MID GOVT BD
POOL SR K (6400)", ticker PIN6400) land as transaction_type=OTHER (unrecognized activity
code, e.g. "DVF") or DIVIDEND (Activity mapped to "Stock dividend"/"Dividend") even though
the description clearly signals a reinvestment purchase — "REINVEST 08/31/26 @ $9.1019 PLUS
FRACTIONS OF 0.404 BOOK VALUE $3.68". Neither OTHER nor DIVIDEND has an ACB-engine handler
that adds quantity (OTHER isn't handled at all; DIVIDEND is cash-only by design), so these
silently contribute ZERO to quantity/ACB — a real (and sometimes sign-flipped) position
quietly goes missing. This affects every Scotia private pool that pays monthly/annual
distributions this way (PIN6200/6300/6400/6600/6800/6900, DYN6004, ...), across whichever
accounts hold them.

Also, for the OTHER-typed rows specifically, the raw Quantity/Settlement columns are "0"
(the true fractional amount lives only in the description text), so cad_amount ends up $0
too, understating cost basis even after the type is fixed. DIVIDEND-typed rows already carry
a correct cad_amount and are left untouched by the cost backfill.

Retyping to DRIP for rows whose description matches the reinvestment pattern fixes the
quantity; backfilling cad_amount from the disclosed "BOOK VALUE $x.xx" (OTHER-sourced rows
only) fixes the cost. Idempotent + auditable via distinct note markers per original type
(revertible, each back to its own original type).

The forward-looking fix for new imports is in app/parsers/scotia_wealth.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User

router = APIRouter(prefix="/api/portfolio/reinvest-retype", tags=["reinvest-retype"])

_DRIP_DESC = r"(DRIP|DPP|REINVEST|REINV)"
_REINVEST_FILTER = f"transaction_type IN ('OTHER','DIVIDEND') AND raw_description ~* '{_DRIP_DESC}'"
# Postgres POSIX-ERE extraction of the dollar figure after "BOOK VALUE" (verified against
# real statement text, e.g. "... BOOK VALUE $3.68" -> "3.68"). No \s/\$ PCRE escapes — Postgres
# regex functions use POSIX ERE, which doesn't support \s; a plain negated class sidesteps it.
_BOOK_VALUE_EXTRACT = "substring(raw_description from 'BOOK VALUE[^0-9]*([0-9]+\\.[0-9]+)')"
_MARKER_OTHER = "[retyped-from-OTHER-reinvest]"
_MARKER_DIVIDEND = "[retyped-from-DIVIDEND-reinvest]"


@router.get("/preview")
def preview(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    total = int(db.execute(text(f"SELECT COUNT(*) FROM transactions WHERE {_REINVEST_FILTER}")).scalar() or 0)

    by_account = [
        {"brokerage": r[0] or "—", "account": r[1], "from_type": r[2], "count": int(r[3])}
        for r in db.execute(text(
            f"SELECT b.name, a.name, t.transaction_type, COUNT(*) FROM transactions t "
            f"JOIN accounts a ON a.id=t.account_id LEFT JOIN brokerages b ON b.id=a.brokerage_id "
            f"WHERE {_REINVEST_FILTER} GROUP BY b.name, a.name, t.transaction_type ORDER BY COUNT(*) DESC"
        )).fetchall()
    ]

    sample = [
        {
            "date": str(r[0]), "ticker": r[1], "from_type": r[2], "quantity": str(r[3]),
            "cad_amount": str(r[4]) if r[4] is not None else None,
            "book_value": r[5], "account": r[6],
        }
        for r in db.execute(text(
            f"SELECT t.transaction_date, s.ticker, t.transaction_type, t.quantity, t.cad_amount, "
            f"{_BOOK_VALUE_EXTRACT}, a.name "
            f"FROM transactions t JOIN securities s ON s.id=t.security_id JOIN accounts a ON a.id=t.account_id "
            f"WHERE {_REINVEST_FILTER} ORDER BY t.transaction_date DESC LIMIT 15"
        )).fetchall()
    ]

    return {"total": total, "by_account": by_account, "sample": sample}


class ApplyBody(BaseModel):
    confirm: bool = False


@router.post("/apply")
def apply(body: ApplyBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if not body.confirm:
        return {"applied": False, "message": "confirm=true required."}

    retyped_other = db.execute(text(
        f"UPDATE transactions SET transaction_type='DRIP', "
        f"notes = COALESCE(notes || ' ', '') || '{_MARKER_OTHER}' "
        f"WHERE transaction_type='OTHER' AND raw_description ~* '{_DRIP_DESC}' "
        f"AND (notes IS NULL OR notes NOT LIKE '%{_MARKER_OTHER}%')"
    )).rowcount
    retyped_dividend = db.execute(text(
        f"UPDATE transactions SET transaction_type='DRIP', "
        f"notes = COALESCE(notes || ' ', '') || '{_MARKER_DIVIDEND}' "
        f"WHERE transaction_type='DIVIDEND' AND raw_description ~* '{_DRIP_DESC}' "
        f"AND (notes IS NULL OR notes NOT LIKE '%{_MARKER_DIVIDEND}%')"
    )).rowcount

    # Backfill cad_amount/transaction_amount/account_currency_amount from the disclosed
    # BOOK VALUE figure — only for the OTHER-sourced rows (their amount was genuinely $0);
    # DIVIDEND-sourced rows already carry a correct amount and are left untouched.
    backfilled = db.execute(text(
        f"UPDATE transactions SET "
        f"cad_amount = {_BOOK_VALUE_EXTRACT}::numeric, "
        f"transaction_amount = {_BOOK_VALUE_EXTRACT}::numeric, "
        f"account_currency_amount = {_BOOK_VALUE_EXTRACT}::numeric "
        f"WHERE transaction_type='DRIP' AND notes LIKE '%{_MARKER_OTHER}%' "
        f"AND (cad_amount IS NULL OR cad_amount = 0) "
        f"AND {_BOOK_VALUE_EXTRACT} IS NOT NULL"
    )).rowcount

    db.commit()

    # Recompute every account's snapshots — positions/cost basis changed broadly.
    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db)
    except Exception:
        pass

    return {
        "applied": True,
        "retyped_from_other": int(retyped_other),
        "retyped_from_dividend": int(retyped_dividend),
        "retyped": int(retyped_other) + int(retyped_dividend),
        "cost_backfilled": int(backfilled),
    }


@router.post("/revert")
def revert(body: ApplyBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Undo the retype (and, for OTHER-sourced rows, the cost backfill) using the note
    markers — each row reverts to its own original type, not a shared one."""
    if not body.confirm:
        return {"reverted": False, "message": "confirm=true required."}

    reverted_other = db.execute(text(
        f"UPDATE transactions SET transaction_type='OTHER', "
        f"notes = REPLACE(notes, ' {_MARKER_OTHER}', ''), "
        f"cad_amount = 0, transaction_amount = 0, account_currency_amount = 0 "
        f"WHERE transaction_type='DRIP' AND notes LIKE '%{_MARKER_OTHER}%'"
    )).rowcount
    reverted_dividend = db.execute(text(
        f"UPDATE transactions SET transaction_type='DIVIDEND', "
        f"notes = REPLACE(notes, ' {_MARKER_DIVIDEND}', '') "
        f"WHERE transaction_type='DRIP' AND notes LIKE '%{_MARKER_DIVIDEND}%'"
    )).rowcount

    db.commit()
    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db)
    except Exception:
        pass
    return {
        "reverted": True,
        "from_other": int(reverted_other),
        "from_dividend": int(reverted_dividend),
        "count": int(reverted_other) + int(reverted_dividend),
    }
