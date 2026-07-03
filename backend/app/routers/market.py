"""Dashboard news — three sections, not tied to any one security:

  GET /news            General Market — scoped to whichever country the ticker-bar toggle
                        is set to (Canada: ^GSPTSE; US: ^GSPC/^DJI/^IXIC), so switching the
                        toggle changes this feed too.
  GET /top-stories      Cross-index overlap signal: a story counts as "top" when it appears
                        in 2+ of the index feeds simultaneously — more robust than Yahoo's
                        own editorsPick flag, which we verified live is too sparse (0 hits
                        for Canada, 1 each for the US indices) to build a section on.
  GET /portfolio-news   News for your biggest MOVERS today (|day_change_pct|) among currently
                        held, Yahoo-coverable securities — not ranked by dollar value, so a
                        smaller position with real news today isn't structurally excluded.
                        Securities with no resolvable Yahoo ticker (small Canadian mutual
                        funds, structured notes) are skipped rather than wasting a fetch.

Pulls from major index tickers rather than ETFs for General Market/Top Stories — verified
live that ^GSPC/^DJI return genuine market-wide headlines ("Stock market today: ..."), while
ETF tickers like SPY/QQQ skew toward ETF-comparison filler articles ("What Actually Drove
IWD...").
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User
from app.services.news_service import fetch_yahoo_news

router = APIRouter(prefix="/api/market", tags=["market"])

_INDEX_SYMBOLS_BY_COUNTRY = {
    "CA": ["^GSPTSE"],
    "US": ["^GSPC", "^DJI", "^IXIC"],
}
# Broader pool for the cross-feed overlap signal (includes TSX sub-indices so Canadian
# stories have a real chance of qualifying as "top", not just US ones).
_TOP_STORY_POOL = ["^GSPTSE", "^SPTTFS", "^SPTTEN", "^GSPC", "^DJI", "^IXIC", "^RUT"]


def _merge_dedupe_sort(symbols: list[str], cap: int = 12) -> list[dict]:
    seen: set[str] = set()
    items: list[dict] = []
    for sym in symbols:
        for item in fetch_yahoo_news(sym):
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            items.append(item)
    items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
    return items[:cap]


@router.get("/news")
def get_market_news(
    country: str = Query("CA", pattern="^(CA|US)$"),
    current_user: User = Depends(get_current_user),
):
    return {"items": _merge_dedupe_sort(_INDEX_SYMBOLS_BY_COUNTRY[country])}


@router.get("/top-stories")
def get_top_stories(current_user: User = Depends(get_current_user)):
    by_url: dict[str, dict] = {}
    for sym in _TOP_STORY_POOL:
        for item in fetch_yahoo_news(sym):
            entry = by_url.setdefault(item["url"], {"item": item, "sources": set()})
            entry["sources"].add(sym)

    overlapping = [(e["item"], len(e["sources"])) for e in by_url.values() if len(e["sources"]) >= 2]
    overlapping.sort(key=lambda t: (t[1], t[0].get("published_at") or ""), reverse=True)
    items = []
    for item, source_count in overlapping[:10]:
        items.append({**item, "source_count": source_count})
    return {"items": items}


@router.get("/portfolio-news")
def get_portfolio_news(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from app.services.acb_service import get_all_positions_acb
    from app.services.price_service import _yahoo_candidates
    from app.models.master import Security
    from app.models.prices import MarketPrice

    acb_rows = get_all_positions_acb(db)
    held_sec_ids = {a["security_id"] for a in acb_rows if float(a["quantity"]) > 0}
    if not held_sec_ids:
        return {"items": []}

    secs = {
        s.id: s for s in db.query(Security)
        .filter(Security.id.in_(held_sec_ids), Security.is_option == False)  # noqa: E712
        .all()
    }
    prices = {
        mp.security_id: mp for mp in db.query(MarketPrice)
        .filter(MarketPrice.security_id.in_(secs.keys()))
        .all()
    }

    # Rank by today's |day_change_pct| (biggest movers first) — not by market value, so a
    # smaller position with real news today isn't excluded just because it's a small dollar
    # amount. Securities with no resolvable Yahoo ticker (e.g. small Canadian mutual funds
    # like PGF550) are skipped entirely rather than wasting a fetch on guaranteed-empty news.
    candidates: list[tuple[str, float]] = []
    for sid, sec in secs.items():
        mp = prices.get(sid)
        if not mp or mp.day_change_pct is None:
            continue
        yahoo_syms = _yahoo_candidates(sec, mp.fetch_ticker)
        if not yahoo_syms:
            continue
        candidates.append((yahoo_syms[0], abs(float(mp.day_change_pct))))

    candidates.sort(key=lambda c: c[1], reverse=True)
    top_symbols = [sym for sym, _ in candidates[:8]]

    return {"items": _merge_dedupe_sort(top_symbols)}
