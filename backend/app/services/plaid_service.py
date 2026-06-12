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


def _get_or_create_brokerage(db: Session, name: str):
    from app.models.master import Brokerage
    name = name or "Plaid"
    code = ("PLAID_" + "".join(c for c in name.upper() if c.isalnum())[:14]) or "PLAID"
    b = db.query(Brokerage).filter(Brokerage.code == code).first()
    if not b:
        b = Brokerage(name=name, code=code, active=True)
        db.add(b)
        db.flush()
    return b


def _upsert_security(db: Session, psec: dict, on: date):
    """Map a Plaid security to our Security and refresh its price.

    Real tickers are reused (so they price via yfinance too); proprietary funds
    with no ticker get a stable synthetic ticker keyed on the Plaid security id.
    """
    from app.models.master import Security
    from app.models.prices import MarketPrice, HistoricalPrice

    ticker_sym = (psec.get("ticker_symbol") or "").upper().strip()
    ptype = (psec.get("type") or "").lower()
    asset_class = _ASSET_CLASS_MAP.get(ptype, "EQUITY")
    ccy = (psec.get("iso_currency_code") or "CAD").upper()
    name = psec.get("name")

    ticker = ticker_sym or f"PLAID:{psec['security_id']}"
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

    # Price: prefer the holding's institution_price (set by caller via _price_for);
    # here use the security's close_price as a fallback current price.
    px = _d(psec.get("close_price"))
    if px is not None:
        _write_price(db, sec.id, px, ccy, on)
    return sec


def _write_price(db: Session, security_id: int, native_price: Decimal, ccy: str, on: date):
    from app.models.prices import MarketPrice, HistoricalPrice
    fx = _fx_to_cad(db, ccy, on)
    price_cad = (native_price * fx).quantize(Decimal("0.0001"))

    mp = db.query(MarketPrice).filter(MarketPrice.security_id == security_id).first()
    if not mp:
        mp = MarketPrice(security_id=security_id, price=native_price, currency=ccy)
        db.add(mp)
    mp.price = native_price
    mp.currency = ccy
    mp.price_cad = price_cad
    mp.price_date = on
    mp.fetched_at = datetime.utcnow()
    mp.source = "plaid"

    hp = (db.query(HistoricalPrice)
          .filter(HistoricalPrice.security_id == security_id, HistoricalPrice.price_date == on)
          .first())
    if not hp:
        hp = HistoricalPrice(security_id=security_id, price_date=on, currency=ccy, source="plaid")
        db.add(hp)
    hp.close_price = native_price
    hp.close_price_cad = price_cad
    hp.currency = ccy


def _get_or_create_account(db: Session, item, pacct: dict, owner: str):
    """Find (via PlaidAccount mapping) or create our Account for a Plaid account."""
    from app.models.master import Account
    from app.models.plaid import PlaidAccount

    pa = db.query(PlaidAccount).filter(PlaidAccount.plaid_account_id == pacct["account_id"]).first()
    if pa:
        return db.get(Account, pa.account_id)

    subtype = (pacct.get("subtype") or "").lower()
    account_type = _SUBTYPE_MAP.get(subtype, (subtype.upper()[:20] if subtype else "NON_REG"))
    ccy = ((pacct.get("balances") or {}).get("iso_currency_code") or "USD").upper()
    mask = pacct.get("mask")
    name = pacct.get("official_name") or pacct.get("name") or "Plaid account"
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

    data = _post("/investments/holdings/get", {"access_token": item.access_token})
    accounts = {a["account_id"]: a for a in data.get("accounts", [])}
    securities = {s["security_id"]: s for s in data.get("securities", [])}
    holdings = data.get("holdings", [])
    today = date.today()

    # 1. Securities → our Security rows + base prices.
    sec_map: dict[str, int] = {}
    for sid, psec in securities.items():
        sec = _upsert_security(db, psec, today)
        sec_map[sid] = sec.id

    # 2. Group holdings by Plaid account; create our Account + replace its positions.
    summary = {"accounts": 0, "holdings": 0, "securities": len(securities)}
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
            if qty == 0:
                continue
            unit_price = _d(h.get("institution_price"))
            cost_basis = _d(h.get("cost_basis"))          # per-unit cost
            mkt_val = _d(h.get("institution_value"))       # native market value
            # Cost: per-unit cost × qty, else fall back to market value (P&L ≈ 0).
            cost_native = (cost_basis * qty) if cost_basis is not None else (mkt_val or Decimal("0"))
            cad_amount = (cost_native * _fx_to_cad(db, ccy, today)).quantize(Decimal("0.01"))
            # Refresh the price from the holding's unit price (more current than security close).
            if unit_price is not None and h["security_id"] in sec_map:
                _write_price(db, sec_map[h["security_id"]], unit_price, ccy, today)

            db.add(Transaction(
                account_id=acct.id,
                security_id=sec_map.get(h["security_id"]),
                transaction_date=today,
                transaction_type="OPENING_BALANCE",
                quantity=qty,
                price=unit_price,
                transaction_currency=ccy,
                transaction_amount=cad_amount,
                cad_amount=cad_amount,
                raw_description=f"Plaid holding: {psec.get('name', '')}"[:500] or None,
                external_ref=f"plaid-pos-{pacct_id}-{h['security_id']}",
            ))
            summary["holdings"] += 1

    item.last_synced_at = datetime.utcnow()
    db.commit()
    logger.info("Plaid sync item=%s: %s", item.item_id, summary)
    return summary
