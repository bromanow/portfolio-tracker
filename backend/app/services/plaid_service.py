"""Plaid connector.

v1 = holdings sync. Each sync pulls /investments/holdings/get and represents every
fund as a single OPENING_BALANCE transaction (cash-neutral, drives quantity + ACB),
priced at Plaid's current unit price. That makes our accounts' holdings and value
track Plaid exactly — the whole point of connecting. Flow/income history
(contributions, dividends) is a follow-up once this pipeline is verified.

Uses the Plaid REST API directly via httpx (no SDK dependency). Credentials and
environment come from PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
PLAID_ENV = os.environ.get("PLAID_ENV", "sandbox").strip().lower()
PLAID_CLIENT_ID = os.environ.get("PLAID_CLIENT_ID", "").strip()
PLAID_SECRET = os.environ.get("PLAID_SECRET", "").strip()
_BASE = {
    "sandbox": "https://sandbox.plaid.com",
    "production": "https://production.plaid.com",
}.get(PLAID_ENV, "https://sandbox.plaid.com")

# Plaid investment country codes (Principal = US, Manulife/Scotia = CA)
COUNTRY_CODES = ["US", "CA"]
PRODUCTS = ["investments"]


def is_configured() -> bool:
    return bool(PLAID_CLIENT_ID and PLAID_SECRET)


# ── Access-token encryption at rest ───────────────────────────────────────────
# A production access_token grants read access to real financial data, so it must
# not sit in the DB as plaintext. Encrypt with Fernet using PLAID_ENCRYPTION_KEY.
# If no key is set we fall back to plaintext (with a warning) so dev/sandbox still
# works; production should always set the key.
def _fernet():
    key = os.environ.get("PLAID_ENCRYPTION_KEY", "").strip()
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode())
    except Exception as e:
        logger.warning("PLAID_ENCRYPTION_KEY invalid (%s) — storing token unencrypted", e)
        return None


def encrypt_token(token: str) -> str:
    f = _fernet()
    if not f:
        logger.warning("No PLAID_ENCRYPTION_KEY — storing Plaid access_token unencrypted")
        return token
    return f.encrypt(token.encode()).decode()


def decrypt_token(stored: str) -> str:
    f = _fernet()
    if not f:
        return stored
    try:
        from cryptography.fernet import InvalidToken
        return f.decrypt(stored.encode()).decode()
    except Exception:
        return stored   # not encrypted (pre-key) — treat as plaintext


def _post(path: str, body: dict) -> dict:
    payload = {"client_id": PLAID_CLIENT_ID, "secret": PLAID_SECRET, **body}
    with httpx.Client(timeout=30) as client:
        r = client.post(f"{_BASE}{path}", json=payload)
    if r.status_code >= 400:
        # Surface Plaid's error_code/message so the UI can show something useful.
        try:
            err = r.json()
        except Exception:
            err = {"error_message": r.text[:300]}
        raise PlaidError(err.get("error_code", "PLAID_ERROR"),
                         err.get("error_message", "Plaid request failed"))
    return r.json()


class PlaidError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


# ── Link / token flow ─────────────────────────────────────────────────────────
def create_link_token(user_id: str) -> str:
    resp = _post("/link/token/create", {
        "user": {"client_user_id": str(user_id)},
        "client_name": "Portfolio Tracker",
        "products": PRODUCTS,
        "country_codes": COUNTRY_CODES,
        "language": "en",
    })
    return resp["link_token"]


def exchange_public_token(public_token: str) -> tuple[str, str]:
    """Returns (access_token, item_id)."""
    resp = _post("/item/public_token/exchange", {"public_token": public_token})
    return resp["access_token"], resp["item_id"]


def create_sandbox_public_token(institution_id: str = "ins_109508") -> str:
    """Sandbox only: mint a public_token for an investments-capable test institution,
    skipping the Link UI (whose returning-user phone flow only offers depository banks)."""
    if PLAID_ENV != "sandbox":
        raise PlaidError("NOT_SANDBOX", "Simulated connect is only available in Sandbox.")
    resp = _post("/sandbox/public_token/create", {
        "institution_id": institution_id,
        "initial_products": PRODUCTS,
    })
    return resp["public_token"]


def get_institution(access_token: str) -> tuple[Optional[str], Optional[str]]:
    """Returns (institution_id, institution_name) for display."""
    try:
        item = _post("/item/get", {"access_token": access_token})
        inst_id = (item.get("item") or {}).get("institution_id")
        if not inst_id:
            return None, None
        inst = _post("/institutions/get_by_id", {
            "institution_id": inst_id, "country_codes": COUNTRY_CODES,
        })
        return inst_id, (inst.get("institution") or {}).get("name")
    except Exception as e:
        logger.warning("Plaid get_institution failed: %s", e)
        return None, None


# ── Mapping helpers ─────────────────────────────────────────────────────────
_SUBTYPE_MAP = {
    "401k": "401K", "401a": "401K", "403b": "403B", "457b": "457B",
    "ira": "IRA", "roth": "ROTH", "roth 401k": "ROTH", "roth ira": "ROTH",
    "rrsp": "RRSP", "rsp": "RRSP", "tfsa": "TFSA", "resp": "RESP", "rrif": "RRIF",
    "brokerage": "NON_REG", "non-taxable brokerage account": "NON_REG",
}
_ASSET_CLASS_MAP = {
    "equity": "EQUITY", "etf": "ETF", "mutual fund": "FUND",
    "fixed income": "FIXED_INCOME", "derivative": "OPTION",
    "cash": "CASH", "cryptocurrency": "CRYPTO",
}


def _d(v) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except Exception:
        return None


def _fx_to_cad(db: Session, ccy: Optional[str], on: date) -> Decimal:
    ccy = (ccy or "CAD").upper()
    if ccy == "CAD":
        return Decimal("1")
    try:
        from app.services.fx_service import get_rate
        rate = get_rate(db, on, ccy, "CAD")
        return Decimal(str(rate)) if rate else Decimal("1")
    except Exception:
        return Decimal("1")


def _clean_institution_name(name: Optional[str]) -> str:
    """Strip Plaid's login-portal suffixes, e.g. 'Principal Financial Group -
    Participant Logon' → 'Principal Financial Group'."""
    name = (name or "Plaid").strip()
    import re as _re
    name = _re.sub(r"\s*[-–—]\s*(participant|member|employee|plan|retirement)?\s*"
                   r"log\s*[io]n.*$", "", name, flags=_re.I).strip()
    return name or "Plaid"


def _get_or_create_brokerage(db: Session, name: str):
    from app.models.master import Brokerage
    name = _clean_institution_name(name)
    code = ("PLAID_" + "".join(c for c in name.upper() if c.isalnum())[:14]) or "PLAID"
    b = db.query(Brokerage).filter(Brokerage.code == code).first()
    if not b:
        b = Brokerage(name=name, code=code, active=True)
        db.add(b)
        db.flush()
    elif b.name != name:
        b.name = name   # heal an old/unclean name on re-sync
    return b


def _upsert_security(db: Session, psec: dict, on: date):
    """Map a Plaid security to our Security and refresh its price.

    Matching is keyed on Plaid's immutable security_id (via the plaid_securities
    map), so a user can freely rename the ticker/name of a synced fund and the next
    sync still resolves to the same record. New funds reuse a real ticker when Plaid
    provides one (so they also price via yfinance), else CUSIP/ISIN, else a synthetic key.
    """
    from app.models.master import Security
    from app.models.plaid import PlaidSecurity
    from app.models.transactions import Transaction

    psid = psec["security_id"]
    ccy = (psec.get("iso_currency_code") or "CAD").upper()

    def _finish(sec):
        px = _d(psec.get("close_price"))
        if px is not None:
            _write_price(db, sec.id, px, ccy, on)
        return sec

    # 1. Known mapping → reuse the existing record (respect any user rename).
    pm = db.query(PlaidSecurity).filter(PlaidSecurity.plaid_security_id == psid).first()
    if pm:
        sec = db.get(Security, pm.security_id)
        if sec:
            return _finish(sec)

    # 2. Recover a security from a prior sync's position row — covers funds the user
    #    already renamed before this mapping existed — then record the mapping.
    prior = (db.query(Transaction)
             .filter(Transaction.external_ref.like(f"plaid-pos-%-{psid}"))
             .first())
    if prior and prior.security_id:
        sec = db.get(Security, prior.security_id)
        if sec:
            db.add(PlaidSecurity(plaid_security_id=psid, security_id=sec.id))
            db.flush()
            return _finish(sec)

    # 2.5 Reuse a statement-created security for the same fund (matched by normalized name) so a
    #     value-only statement history and the live Plaid feed share ONE security — no duplicate.
    pname = (psec.get("name") or "").strip()
    if pname:
        norm = "".join(c for c in pname.upper() if c.isalnum())
        mapped = {r[0] for r in db.query(PlaidSecurity.security_id).all()}
        for cand in db.query(Security).filter(Security.ticker.like("%:%")).all():
            if (cand.id not in mapped and cand.name
                    and "".join(c for c in cand.name.upper() if c.isalnum()) == norm):
                db.add(PlaidSecurity(plaid_security_id=psid, security_id=cand.id))
                db.flush()
                return _finish(cand)

    # 3. New security: real ticker → CUSIP → ISIN → synthetic key; then map it.
    ticker_sym = (psec.get("ticker_symbol") or "").upper().strip()
    cusip = (psec.get("cusip") or "").strip()
    isin = (psec.get("isin") or "").strip()
    asset_class = _ASSET_CLASS_MAP.get((psec.get("type") or "").lower(), "EQUITY")
    name = psec.get("name")
    ticker = ticker_sym or cusip or isin or f"PLAID:{psid}"
    sec = db.query(Security).filter(Security.ticker == ticker).first()
    if not sec:
        sec = Security(ticker=ticker, name=name, asset_class=asset_class, currency=ccy)
        db.add(sec)
        db.flush()
    else:
        if name and not sec.name:
            sec.name = name
        if not sec.currency:
            sec.currency = ccy
    db.add(PlaidSecurity(plaid_security_id=psid, security_id=sec.id))
    db.flush()
    return _finish(sec)


def _write_price(db: Session, security_id: int, native_price: Decimal, ccy: str, on: date):
    from app.models.prices import MarketPrice, HistoricalPrice
    from sqlalchemy.dialects.postgresql import insert as _pg_insert
    # Never store a future-dated price (mirrors the before_flush guard in database.py; this
    # path's historical write uses core insert, which bypasses that ORM-level guard).
    if on > date.today():
        logger.warning("Plaid: skipping future-dated price for security_id=%s date=%s", security_id, on)
        return
    fx = _fx_to_cad(db, ccy, on)
    price_cad = (native_price * fx).quantize(Decimal("0.0001"))

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    if not mp:
        mp = MarketPrice(security_id=security_id, price=native_price, currency=ccy)
        db.add(mp); db.flush()   # flush so a second write of the same security finds it (autoflush-safe)
    mp.price = native_price
    mp.currency = ccy
    mp.price_cad = price_cad
    mp.price_date = on
    mp.fetched_at = datetime.utcnow()
    mp.source = "plaid"

    # Idempotent historical price — upsert on the (security_id, price_date) unique constraint, so a
    # security written more than once in a sync (e.g. two Plaid records resolving to one merged fund)
    # updates instead of inserting a duplicate and crashing the whole sync.
    db.execute(
        _pg_insert(HistoricalPrice.__table__)
        .values(security_id=security_id, price_date=on, close_price=native_price,
                close_price_cad=price_cad, currency=ccy, source="plaid")
        .on_conflict_do_update(
            index_elements=["security_id", "price_date"],
            set_={"close_price": native_price, "close_price_cad": price_cad, "currency": ccy}))


def _get_or_create_account(db: Session, item, pacct: dict, owner: str):
    """Find (via PlaidAccount mapping) or create our Account for a Plaid account."""
    from app.models.master import Account
    from app.models.plaid import PlaidAccount

    pa = db.query(PlaidAccount).filter(PlaidAccount.plaid_account_id == pacct["account_id"]).first()
    if pa:
        return db.get(Account, pa.account_id)

    subtype = (pacct.get("subtype") or "").lower()
    name = pacct.get("official_name") or pacct.get("name") or "Plaid account"
    # Plaid sometimes mis-types retirement plans (e.g. a 401k tagged "thrift savings
    # plan"). Prefer the subtype map, but fall back to keywords in the account name.
    account_type = _SUBTYPE_MAP.get(subtype)
    if not account_type:
        _nm = name.lower()
        account_type = (
            "401K" if "401" in _nm else
            "ROTH" if "roth" in _nm else
            "IRA"  if "ira" in _nm else
            "RRSP" if ("rrsp" in _nm or "rsp" in _nm) else
            "TFSA" if "tfsa" in _nm else
            "RESP" if "resp" in _nm else
            (subtype.upper()[:20] if subtype else "NON_REG")
        )
    ccy = ((pacct.get("balances") or {}).get("iso_currency_code") or "USD").upper()
    mask = pacct.get("mask")
    if mask:
        name = f"{name} ••{mask}"

    brokerage = _get_or_create_brokerage(db, item.institution_name or "Plaid")
    acct = Account(
        brokerage_id=brokerage.id,
        name=name[:100],
        account_number=pacct.get("mask"),
        account_type=account_type,
        base_currency=ccy,
        owner=owner or "Unknown",
        active=True,
    )
    db.add(acct)
    db.flush()
    db.add(PlaidAccount(plaid_item_id=item.id, plaid_account_id=pacct["account_id"], account_id=acct.id))
    db.flush()
    return acct


# ── Sync ──────────────────────────────────────────────────────────────────────
def sync_item(db: Session, item, owner: str = "Unknown") -> dict:
    """Pull holdings for a connected Item and rebuild positions as OPENING_BALANCE rows."""
    from app.models.transactions import Transaction
    from sqlalchemy import text

    data = _post("/investments/holdings/get", {"access_token": decrypt_token(item.access_token)})
    accounts = {a["account_id"]: a for a in data.get("accounts", [])}
    securities = {s["security_id"]: s for s in data.get("securities", [])}
    holdings = data.get("holdings", [])
    today = date.today()

    # Securities are created lazily, only when a holding turns out to be a REAL position
    # (see the loop below). Plaid's /holdings/get returns a `securities` array listing every
    # security the institution references — including ones with no position, qty 0, or dust —
    # so upserting them all here would spawn orphan securities (0 txns) on every overnight
    # sync. We instead upsert inside the position loop after the qty/dust checks pass.
    sec_map: dict[str, int] = {}

    # 2. Group holdings by Plaid account; create our Account + replace its positions.
    summary = {"accounts": 0, "holdings": 0, "securities": 0}
    by_acct: dict[str, list[dict]] = {}
    for h in holdings:
        by_acct.setdefault(h["account_id"], []).append(h)

    for pacct_id, hlist in by_acct.items():
        pacct = accounts.get(pacct_id)
        if not pacct or pacct.get("type") != "investment":
            continue
        acct = _get_or_create_account(db, item, pacct, owner)
        summary["accounts"] += 1

        # Full replace: drop this account's Plaid position rows, re-create from current holdings.
        db.execute(
            text("DELETE FROM transactions WHERE account_id = :aid AND external_ref LIKE :pat"),
            {"aid": acct.id, "pat": f"plaid-pos-{pacct_id}-%"},
        )
        for h in hlist:
            psec = securities.get(h["security_id"], {})
            ccy = (h.get("iso_currency_code") or psec.get("iso_currency_code") or "CAD").upper()
            qty = _d(h.get("quantity")) or Decimal("0")
            mkt_val = _d(h.get("institution_value"))       # native market value
            ext = f"plaid-pos-{pacct_id}-{h['security_id']}"

            # Cash-equivalent holding → account cash (CASH_OPENING), not a security.
            if psec.get("is_cash_equivalent"):
                cash_native = mkt_val if mkt_val is not None else qty
                cad_amount = (cash_native * _fx_to_cad(db, ccy, today)).quantize(Decimal("0.01"))
                db.add(Transaction(
                    account_id=acct.id, security_id=None, transaction_date=today,
                    transaction_type="CASH_OPENING",
                    transaction_currency=ccy, transaction_amount=cash_native, cad_amount=cad_amount,
                    raw_description=f"Plaid cash: {psec.get('name', '')}"[:500] or None,
                    external_ref=ext,
                ))
                continue

            if qty == 0:
                continue
            # Skip dust (e.g. ~$0.20 target-date glide-path / transfer residue that the
            # record-keeper nets out and doesn't show on statements) — not real positions.
            if mkt_val is not None and abs(mkt_val) < Decimal("1"):
                continue
            unit_price = _d(h.get("institution_price"))
            # Real held position → NOW create/resolve the security (avoids orphan securities
            # for non-held entries in Plaid's `securities` array).
            sid = h["security_id"]
            local_sec_id = sec_map.get(sid)
            if local_sec_id is None:
                local_sec_id = _upsert_security(db, securities.get(sid, {}), today).id
                sec_map[sid] = local_sec_id
                summary["securities"] += 1
            # Value at market (Book = Securities, P&L ≈ 0). These are registered accounts
            # where cost basis is display-only, and Plaid's cost_basis is ambiguous
            # (docs say total; Sandbox returns per-unit-looking values). Wire real cost
            # basis later once validated against production data.
            cost_native = mkt_val if mkt_val is not None else Decimal("0")
            cad_amount = (cost_native * _fx_to_cad(db, ccy, today)).quantize(Decimal("0.01"))
            # Refresh the price from the holding's unit price (more current than security close).
            if unit_price is not None:
                _write_price(db, local_sec_id, unit_price, ccy, today)

            db.add(Transaction(
                account_id=acct.id,
                security_id=local_sec_id,
                transaction_date=today,
                transaction_type="OPENING_BALANCE",
                quantity=qty,
                price=unit_price,
                transaction_currency=ccy,
                transaction_amount=cad_amount,
                cad_amount=cad_amount,
                raw_description=f"Plaid holding: {psec.get('name', '')}"[:500] or None,
                external_ref=ext,
            ))
            summary["holdings"] += 1

    item.last_synced_at = datetime.utcnow()
    db.commit()
    logger.info("Plaid sync item=%s: %s", item.item_id, summary)
    return summary
