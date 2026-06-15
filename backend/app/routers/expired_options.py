"""Bulk close expired-but-open option positions.

Worthless options often just stop appearing on statements, so no expiry/assignment row is
ever recorded — the short premium (or long cost) is never realized and the position lingers
in the ACB engine. This lists those positions for review and records the missing
OPTION_EXPIRY transactions (dated the expiry), which realizes the premium/loss and closes
the lot. Idempotent via a stable external_ref.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User

router = APIRouter(prefix="/api/portfolio/expired-options", tags=["expired-options"])

ZERO = Decimal("0")


def _ext_ref(account_id: int, security_id: int, expiry: date) -> str:
    return f"auto-expiry-{account_id}-{security_id}-{expiry.isoformat()}"


def _expired_open(db: Session):
    """Yield (acb_row, security, account, expiry) for each expired option with a live qty."""
    from app.services.acb_service import get_all_positions_acb
    from app.services.price_service import parse_option_ticker
    from app.models.master import Security, Account

    secs = {s.id: s for s in db.query(Security).all()}
    accts = {a.id: a for a in db.query(Account).all()}
    today = date.today()
    for a in get_all_positions_acb(db):
        if Decimal(str(a["quantity"])) == 0:
            continue
        sec = secs.get(a["security_id"])
        if not (sec and sec.is_option):
            continue
        try:
            po = parse_option_ticker(sec.ticker, security=sec)
        except Exception:
            po = None
        exp = po.get("expiry") if po else None
        if not (exp and exp < today):
            continue
        yield a, sec, accts.get(a["account_id"]), exp


@router.get("")
def list_expired_options(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    today = date.today()
    existing = {
        t.external_ref for t in _existing_refs(db)
    }
    rows = []
    for a, sec, acct, exp in _expired_open(db):
        qty = Decimal(str(a["quantity"]))
        acb = Decimal(str(a["total_acb_cad"]))
        rows.append({
            "security_id": a["security_id"],
            "account_id": a["account_id"],
            "ticker": sec.ticker,
            "account": acct.name if acct else None,
            "expiry": exp.isoformat(),
            "days_past": (today - exp).days,
            "quantity": str(qty),
            "is_short": qty < 0,
            # Expiry realizes the lot: short → +premium received, long → −cost (loss). Both = −ACB.
            "est_realized_cad": str(-acb),
            "already_recorded": _ext_ref(a["account_id"], a["security_id"], exp) in existing,
        })
    rows.sort(key=lambda r: (r["already_recorded"], r["expiry"]), reverse=False)
    return {"count": len([r for r in rows if not r["already_recorded"]]), "items": rows}


def _existing_refs(db: Session):
    from app.models.transactions import Transaction
    return db.query(Transaction).filter(Transaction.external_ref.like("auto-expiry-%")).all()


class CloseBody(BaseModel):
    # List of [security_id, account_id] pairs to close; omit/empty with all=True to close every one.
    keys: Optional[List[List[int]]] = None
    all: bool = False


@router.post("/close")
def close_expired_options(body: CloseBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from app.models.transactions import Transaction

    want: set[tuple[int, int]] | None = None
    if not body.all:
        want = {(int(k[0]), int(k[1])) for k in (body.keys or []) if len(k) == 2}
        if not want:
            return {"closed": 0, "skipped": 0, "message": "Nothing selected."}

    existing = {t.external_ref for t in _existing_refs(db)}
    closed = 0
    skipped = 0
    touched_accounts: set[int] = set()
    for a, sec, acct, exp in _expired_open(db):
        sid, aid = a["security_id"], a["account_id"]
        if want is not None and (sid, aid) not in want:
            continue
        ref = _ext_ref(aid, sid, exp)
        if ref in existing:
            skipped += 1
            continue
        qty = Decimal(str(a["quantity"]))
        db.add(Transaction(
            account_id=aid,
            security_id=sid,
            transaction_type="OPTION_EXPIRY",
            transaction_date=exp,
            quantity=abs(qty),          # ACB engine closes the whole lot (uses abs)
            transaction_amount=ZERO,    # expiry moves no cash
            cad_amount=ZERO,
            transaction_currency=(sec.currency or "CAD"),
            external_ref=ref,
            notes="Auto-recorded expiry (bulk close expired options)",
        ))
        existing.add(ref)
        touched_accounts.add(aid)
        closed += 1

    db.commit()

    # Recompute snapshots for the affected accounts so the chart/returns reflect the realized
    # premium/loss right away.
    if touched_accounts:
        try:
            from app.services.portfolio_history_service import compute_portfolio_snapshots
            compute_portfolio_snapshots(db, account_ids=list(touched_accounts))
        except Exception:
            pass

    return {"closed": closed, "skipped": skipped, "accounts": len(touched_accounts)}
