"""Keep the screener universe's S&P 500 / TSX 60 membership current.

The curated static lists in `app/data/screener_universe.py` seed the universe, but index
constituents change (quarterly S&P rebalances, TSX 60 reviews). This service pulls the current
membership from Wikipedia and reconciles the `Security.index_member` / `in_screener_universe`
flags: new constituents are added, departed ones are dropped — but only rows the sync owns
(`index_member=True`) are ever auto-dropped, so names a user added to the screener by hand are
left untouched.

Defensive by design: if a fetch returns an implausibly small list (a broken scrape, a Wikipedia
layout change), the whole sync aborts WITHOUT touching the DB rather than wiping the universe.
Run quarterly by the scheduler, or on demand via POST /api/screener/sync-index.
"""
from __future__ import annotations

import logging

import requests
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from app.models.master import Security
from app.services.normalizer import get_or_create_security

logger = logging.getLogger(__name__)

_HEADERS = {"User-Agent": "Mozilla/5.0 (portfolio-tracker index-universe sync)"}
_SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
_TSX60_URL = "https://en.wikipedia.org/wiki/S%26P/TSX_60"

# Plausibility floors — if a scrape returns fewer than this, treat it as broken and abort.
# The real indices are 500 and 60; these leave generous slack for Wikipedia edits mid-scrape.
_SP500_MIN = 450
_TSX60_MIN = 55


def _scrape_symbols(url: str, symbol_col: int = 0) -> list[str]:
    """Return the symbol column of the first sortable wikitable on the page."""
    resp = requests.get(url, headers=_HEADERS, timeout=25)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    tables = soup.select("table.wikitable")
    if not tables:
        raise ValueError(f"no wikitable found at {url}")
    out: list[str] = []
    for tr in tables[0].select("tr")[1:]:
        cells = tr.select("td")
        if len(cells) <= symbol_col:
            continue
        sym = cells[symbol_col].get_text(strip=True)
        if sym:
            out.append(sym)
    return out


def _norm_us(sym: str) -> str:
    """Wikipedia writes class shares with a dot (BRK.B); we store them with a dash (BRK-B)
    to match yfinance. Uppercase + strip is enough otherwise."""
    return sym.upper().strip().replace(".", "-")


def _norm_ca(sym: str) -> str:
    """TSX 60 symbols on Wikipedia are bare (RY, ATD), sometimes with a .TO/.TSX suffix, and
    dual-class names carry a class dot (RCI.B, CTC.A). We store bare tickers with exchange=TSX
    and the class share with a DASH (RCI-B) — matching both the existing rows and yfinance's
    format (RCI-B.TO) — so: strip the exchange suffix first, then turn the remaining class dot
    into a dash. Without the dot→dash step the sync creates a duplicate 'RCI.B' and orphans the
    real 'RCI-B'."""
    s = sym.upper().strip()
    for suffix in (".TO", ".TSX", ".TSXV", ".V"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
            break
    return s.replace(".", "-")


def fetch_index_constituents() -> tuple[set[str], set[str]]:
    """(us_tickers, ca_tickers) in this app's stored form. Raises if either list looks broken."""
    us_raw = _scrape_symbols(_SP500_URL)
    ca_raw = _scrape_symbols(_TSX60_URL)
    if len(us_raw) < _SP500_MIN:
        raise ValueError(f"S&P 500 scrape returned only {len(us_raw)} names (< {_SP500_MIN}); aborting")
    if len(ca_raw) < _TSX60_MIN:
        raise ValueError(f"TSX 60 scrape returned only {len(ca_raw)} names (< {_TSX60_MIN}); aborting")
    us = {_norm_us(s) for s in us_raw if s}
    ca = {_norm_ca(s) for s in ca_raw if s}
    return us, ca


def sync_index_universe(db: Session, fetch=fetch_index_constituents) -> dict:
    """Reconcile Security.index_member / in_screener_universe against the live index membership.

    `fetch` is injectable for testing. Returns a summary dict. On a failed/implausible fetch it
    raises before any DB write, leaving the universe exactly as it was.
    """
    us_now, ca_now = fetch()          # raises on a broken scrape → no DB changes
    current = us_now | ca_now

    added: list[str] = []
    for ticker in sorted(us_now):
        sec = get_or_create_security(db, ticker, currency="USD")
        if not sec.index_member or not sec.in_screener_universe:
            added.append(ticker)
        sec.index_member = True
        sec.in_screener_universe = True
    for ticker in sorted(ca_now):
        sec = get_or_create_security(db, ticker, currency="CAD", exchange="TSX")
        if not sec.index_member or not sec.in_screener_universe:
            added.append(ticker)
        sec.index_member = True
        sec.in_screener_universe = True

    # Departed constituents: rows the sync owns that are no longer in either index. Drop them
    # from both flags but keep the Security row (it may be held / have transaction history).
    dropped: list[str] = []
    owned = db.query(Security).filter(Security.index_member.is_(True)).all()
    for sec in owned:
        if sec.ticker not in current:
            sec.index_member = False
            sec.in_screener_universe = False
            dropped.append(sec.ticker)

    db.commit()

    summary = {
        "us_constituents": len(us_now),
        "ca_constituents": len(ca_now),
        "added": sorted(a for a in added if a in current),
        "dropped": sorted(dropped),
        "added_count": len(added),
        "dropped_count": len(dropped),
    }
    logger.info(
        "Index universe sync: %d US + %d CA constituents; +%d added, -%d dropped %s",
        len(us_now), len(ca_now), len(added), len(dropped),
        (dropped[:10] + (["…"] if len(dropped) > 10 else [])) if dropped else "",
    )
    return summary
