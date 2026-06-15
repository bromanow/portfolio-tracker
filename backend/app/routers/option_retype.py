"""Fix mis-typed option transactions.

Many option trades (esp. iTrade covered calls) were imported with the plain stock types
SELL / BUY instead of OPTION_SELL / OPTION_BUY. The ACB engine only applies option logic
(short premium, buy-to-close, closing a long) to the OPTION_* types, so a written call's
premium was never realized and the buy-to-close opened a phantom long → corrupt option P&L
and a backlog of "expired" phantom-long options.

Retyping SELL→OPTION_SELL and BUY→OPTION_BUY for is_option securities fixes it; the OPTION_*
logic handles writing, buy-to-close, and closing longs, so the conversion is semantically
safe. Idempotent + auditable via a [retyped-from-X] note marker (also enables a revert).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User

router = APIRouter(prefix="/api/portfolio/option-retype", tags=["option-retype"])

_OPT_FILTER = "security_id IN (SELECT id FROM securities WHERE is_option = true)"


@router.get("/preview")
def preview(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    def _n(q: str) -> int:
        return int(db.execute(text(q)).scalar() or 0)

    sell = _n(f"SELECT COUNT(*) FROM transactions WHERE transaction_type='SELL' AND {_OPT_FILTER}")
    buy = _n(f"SELECT COUNT(*) FROM transactions WHERE transaction_type='BUY' AND {_OPT_FILTER}")
    other = _n(f"SELECT COUNT(*) FROM transactions WHERE transaction_type='OTHER' AND {_OPT_FILTER}")

    # Affected by brokerage (so it's clear which import source produced them).
    by_brokerage = [
        {"brokerage": r[0] or "—", "count": int(r[1])}
        for r in db.execute(text(
            "SELECT b.name, COUNT(*) FROM transactions t "
            "JOIN accounts a ON a.id=t.account_id LEFT JOIN brokerages b ON b.id=a.brokerage_id "
            "JOIN securities s ON s.id=t.security_id "
            "WHERE t.transaction_type IN ('SELL','BUY') AND s.is_option=true "
            "GROUP BY b.name ORDER BY COUNT(*) DESC"
        )).fetchall()
    ]

    sample = [
        {"date": str(r[0]), "type": r[1], "ticker": r[2], "quantity": str(r[3]), "cad_amount": str(r[4]) if r[4] is not None else None, "account": r[5]}
        for r in db.execute(text(
            f"SELECT t.transaction_date, t.transaction_type, s.ticker, t.quantity, t.cad_amount, a.name "
            f"FROM transactions t JOIN securities s ON s.id=t.security_id JOIN accounts a ON a.id=t.account_id "
            f"WHERE t.transaction_type IN ('SELL','BUY') AND s.is_option=true "
            f"ORDER BY t.transaction_date DESC LIMIT 12"
        )).fetchall()
    ]

    return {
        "sell": sell, "buy": buy, "total": sell + buy,
        "other": other,
        "by_brokerage": by_brokerage,
        "sample": sample,
    }


class ApplyBody(BaseModel):
    confirm: bool = False


@router.post("/apply")
def apply(body: ApplyBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if not body.confirm:
        return {"applied": False, "message": "confirm=true required."}

    sell = db.execute(text(
        f"UPDATE transactions SET transaction_type='OPTION_SELL', "
        f"notes = COALESCE(notes || ' ', '') || '[retyped-from-SELL]' "
        f"WHERE transaction_type='SELL' AND {_OPT_FILTER} "
        f"AND (notes IS NULL OR notes NOT LIKE '%[retyped-from-SELL]%')"
    )).rowcount
    buy = db.execute(text(
        f"UPDATE transactions SET transaction_type='OPTION_BUY', "
        f"notes = COALESCE(notes || ' ', '') || '[retyped-from-BUY]' "
        f"WHERE transaction_type='BUY' AND {_OPT_FILTER} "
        f"AND (notes IS NULL OR notes NOT LIKE '%[retyped-from-BUY]%')"
    )).rowcount
    db.commit()

    # Recompute every account's snapshots — option P&L/positions changed broadly.
    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db)
    except Exception:
        pass

    return {"applied": True, "sell_retyped": int(sell), "buy_retyped": int(buy)}


@router.post("/revert")
def revert(body: ApplyBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Undo the retype using the note markers (in case the conversion needs reviewing)."""
    if not body.confirm:
        return {"reverted": False, "message": "confirm=true required."}
    sell = db.execute(text(
        "UPDATE transactions SET transaction_type='SELL', "
        "notes = REPLACE(notes, ' [retyped-from-SELL]', '') "
        "WHERE transaction_type='OPTION_SELL' AND notes LIKE '%[retyped-from-SELL]%'"
    )).rowcount
    buy = db.execute(text(
        "UPDATE transactions SET transaction_type='BUY', "
        "notes = REPLACE(notes, ' [retyped-from-BUY]', '') "
        "WHERE transaction_type='OPTION_BUY' AND notes LIKE '%[retyped-from-BUY]%'"
    )).rowcount
    db.commit()
    try:
        from app.services.portfolio_history_service import compute_portfolio_snapshots
        compute_portfolio_snapshots(db)
    except Exception:
        pass
    return {"reverted": True, "sell": int(sell), "buy": int(buy)}
