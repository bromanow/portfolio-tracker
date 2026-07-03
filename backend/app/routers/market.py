"""Broad market news for the Dashboard's Market News section (not tied to a security).

Pulls from major index tickers rather than ETFs — verified live that ^GSPC/^DJI return
genuine market-wide headlines ("Stock market today: ..."), while ETF tickers like SPY/QQQ
skew toward ETF-comparison filler articles ("What Actually Drove IWD...").
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.dependencies import get_current_user
from app.models.auth import User
from app.services.news_service import fetch_yahoo_news

router = APIRouter(prefix="/api/market", tags=["market"])

_MARKET_SYMBOLS = ["^GSPC", "^DJI", "^IXIC"]  # S&P 500, Dow, Nasdaq


@router.get("/news")
def get_market_news(current_user: User = Depends(get_current_user)):
    seen_urls: set[str] = set()
    items: list[dict] = []
    for sym in _MARKET_SYMBOLS:
        for item in fetch_yahoo_news(sym):
            if item["url"] in seen_urls:
                continue
            seen_urls.add(item["url"])
            items.append(item)
    items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
    return {"items": items[:10]}
