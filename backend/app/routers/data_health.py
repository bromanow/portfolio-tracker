"""Data-health checks — surface portfolio data-quality issues that quietly corrupt the
analysis (unpriced tickers, expired-but-open options, stale prices/accounts, $0-cost lots).

One endpoint runs every check and returns them grouped, each with a severity and the
specific affected items so the UI can offer a one-click fix.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User

router = APIRouter(prefix="/api/portfolio/data-health", tags=["data-health"])

ZERO = Decimal("0")
STALE_PRICE_DAYS = 5   # held equity priced longer ago than this → flagged


def _d(v) -> Decimal:
    return Decimal(str(v)) if v is not None else ZERO


@router.get("")
def data_health(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from app.services import portfolio as P
    from app.services.acb_service import get_all_positions_acb
    from app.services.price_service import parse_option_ticker
    from app.models.master import Security, Account
    from app.models.prices import MarketPrice
    from app.routers.imports import import_status

    today = date.today()
    secs = {s.id: s for s in db.query(Security).all()}
    accts = {a.id: a for a in db.query(Account).all()}
    mp = {m.security_id: m for m in db.query(MarketPrice).all()}

    def _opt_expiry(sec):
        if not (sec and sec.is_option):
            return None
        try:
            po = parse_option_ticker(sec.ticker, security=sec)
        except Exception:
            po = None
        return po.get("expiry") if po else None

    # get_positions excludes expired options and prices at market; market_value None = unpriced.
    positions = P.get_positions(db)
    acb_rows = get_all_positions_acb(db)

    # ── 1. Unpriced & bad-metadata holdings ──────────────────────────────────
    unpriced = []
    for p in positions:
        if p.get("market_value_cad") is not None or _d(p["quantity"]) <= 0:
            continue
        sec = secs.get(p["security_id"])
        reasons = []
        if sec and not (sec.exchange or "").strip():
            reasons.append("no exchange set")
        if sec and not (sec.name or "").strip():
            reasons.append("no name")
        reasons.append("no market price")
        unpriced.append({
            "security_id": p["security_id"],
            "ticker": p["ticker"],
            "name": sec.name if sec else None,
            "currency": sec.currency if sec else None,
            "exchange": sec.exchange if sec else None,
            "account": accts[p["account_id"]].name if p["account_id"] in accts else None,
            "quantity": str(p["quantity"]),
            "cost_cad": str(p.get("total_acb_cad") or 0),
            "reason": ", ".join(reasons),
        })

    # ── 2. Expired options still open (excluded from get_positions, so use ACB) ─
    # Only the RECENT window is actionable — an option that expired last week may still
    # need its expiry/assignment recorded. Older ones are a settled backlog (worthless
    # options that simply stopped appearing on statements); they don't affect current
    # value (expired options are excluded from valuation everywhere) so we surface their
    # COUNT in the hint rather than flooding the list with hundreds of ancient rows.
    EXPIRED_WINDOW_DAYS = 60
    expired_options = []
    expired_backlog = 0
    for a in acb_rows:
        if _d(a["quantity"]) == 0:
            continue
        sec = secs.get(a["security_id"])
        exp = _opt_expiry(sec)
        if not (exp and exp < today):
            continue
        days_past = (today - exp).days
        if days_past > EXPIRED_WINDOW_DAYS:
            expired_backlog += 1
            continue
        expired_options.append({
            "security_id": a["security_id"],
            "ticker": sec.ticker if sec else None,
            "account": accts[a["account_id"]].name if a["account_id"] in accts else None,
            "expiry": exp.isoformat(),
            "days_past": days_past,
            "quantity": str(a["quantity"]),
        })

    # ── 3. Stale prices (held equities whose MarketPrice hasn't refreshed) ─────
    stale_prices = []
    seen_sp: set[int] = set()
    for p in positions:
        sid = p["security_id"]
        if sid in seen_sp or p.get("market_value_cad") is None:
            continue
        sec = secs.get(sid)
        if sec and sec.is_option:
            continue   # options expire/settle separately; don't nag on price age
        m = mp.get(sid)
        if not m or (m.source or "") == "manual":
            continue   # manual prices (mortgages, notes) are intentionally static
        fetched = m.fetched_at.date() if isinstance(m.fetched_at, datetime) else m.fetched_at
        age = (today - fetched).days if fetched else None
        if age is not None and age > STALE_PRICE_DAYS:
            seen_sp.add(sid)
            stale_prices.append({
                "security_id": sid, "ticker": p["ticker"],
                "last_priced": fetched.isoformat() if fetched else None, "days_old": age,
            })

    # ── 4. Stale accounts (reuse the import-status freshness logic) ────────────
    stale_accounts = [
        {"account_id": r["account_id"], "account": r["account"], "brokerage": r["brokerage"],
         "source": r["source"], "last_loaded": r["last_loaded"], "days_since_load": r["days_since_load"]}
        for r in import_status(db) if r["stale"]
    ]

    # ── 5. Zero-cost / $0-ACB positions ───────────────────────────────────────
    zero_cost = []
    for a in acb_rows:
        q = _d(a["quantity"]); acb = _d(a["total_acb_cad"])
        if q <= 0 or abs(acb) >= Decimal("0.01"):
            continue
        sec = secs.get(a["security_id"])
        exp = _opt_expiry(sec)
        if exp and exp < today:
            continue   # expired option, handled by its own check
        zero_cost.append({
            "security_id": a["security_id"],
            "ticker": sec.ticker if sec else None,
            "account": accts[a["account_id"]].name if a["account_id"] in accts else None,
            "quantity": str(a["quantity"]),
        })

    # ── 6. Unused securities (no transactions reference them) ──────────────────
    # Orphans — typically Plaid listing a security it doesn't actually hold, or a security
    # left behind after a position fully closed. Harmless but clutter; safe to delete.
    # Screener-universe securities (Fundamental Screener) are deliberately transaction-free —
    # they exist only to hold cached fundamentals for stocks you don't hold — so they're
    # excluded here rather than flagged as orphans.
    from app.models.transactions import Transaction as _Txn
    used_ids = {r[0] for r in db.query(_Txn.security_id).filter(_Txn.security_id.isnot(None)).distinct()}
    unused_securities = [
        {"security_id": s.id, "ticker": s.ticker, "name": s.name, "asset_class": s.asset_class}
        for s in secs.values() if s.id not in used_ids and not s.in_screener_universe
    ]

    def _check(key, title, severity, items, hint, action):
        return {
            "key": key, "title": title, "severity": severity,
            "status": "pass" if not items else severity,
            "count": len(items), "items": items, "hint": hint, "action": action,
        }

    checks = [
        _check("unpriced", "Unpriced holdings", "warning", unpriced,
               "Held securities with no market price — carried at cost, so value and P&L are approximate.",
               {"label": "Fix in Securities", "route": (
                   "/admin?tab=securities&ids=" + ",".join(str(u["security_id"]) for u in unpriced)
                   if unpriced else "/admin?tab=securities"
               )}),
        _check("expired_options", "Expired options still open", "warning", expired_options,
               f"Options that expired in the last {EXPIRED_WINDOW_DAYS} days with a non-zero position and no "
               f"recorded expiry/assignment — their premium or loss isn't realized yet."
               + (f" ({expired_backlog} older unclosed options exist too — a settled backlog that "
                  "doesn't affect current value.)" if expired_backlog else ""),
               {"label": "Close expired options", "route": "/admin?tab=expired-options"}),
        _check("zero_cost", "Zero-cost positions", "danger", zero_cost,
               "Journaled-in or transferred shares with no book value, so ACB and P&L are wrong.",
               {"label": "Set book value", "route": "/transactions"}),
        _check("stale_prices", "Stale prices", "warning", stale_prices,
               f"Held equities priced more than {STALE_PRICE_DAYS} days ago.",
               {"label": "Refresh prices", "route": "/admin?tab=prices"}),
        _check("stale_accounts", "Accounts needing an import", "warning", stale_accounts,
               "Accounts with no recent transactions or imports for their data source.",
               {"label": "Go to import", "route": "/import"}),
        _check("unused_securities", "Unused securities", "warning", unused_securities,
               "Securities with no transactions — usually Plaid listing something it doesn't hold, "
               "or a leftover after a position closed. Safe to delete.",
               {"label": "Clean up in Securities", "route": "/admin?tab=securities"}),
    ]
    issues = sum(c["count"] for c in checks)
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "issue_count": issues,
        "checks_passing": sum(1 for c in checks if c["status"] == "pass"),
        "checks_total": len(checks),
        "checks": checks,
    }
