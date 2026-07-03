"""Yahoo Finance news fetch + normalization — shared between the security detail card's
News tab (app/routers/securities.py) and the Dashboard's Market News section
(app/routers/market.py), so both parse yfinance's Ticker.news response identically.

yfinance's news shape (v1.5.1, verified live in production) wraps each story under a
'content' key: title/summary/description/pubDate/provider/canonicalUrl/clickThroughUrl/
thumbnail.resolutions[]. This has changed across yfinance versions before, so keep the
parsing centralized here rather than duplicated per caller.
"""
from __future__ import annotations

from typing import Optional


def _yahoo_thumbnail(content: dict) -> Optional[str]:
    thumb = content.get("thumbnail") or {}
    resolutions = thumb.get("resolutions") or []
    # Prefer a small non-original resolution (keeps cards light); fall back to the original
    # image, else None (some stories — esp. wire-service text — have no image at all).
    small = [r for r in resolutions if r.get("tag") != "original" and r.get("url")]
    if small:
        return min(small, key=lambda r: r.get("width") or 9999).get("url")
    return thumb.get("originalUrl")


def normalize_yahoo_news(raw: list[dict]) -> list[dict]:
    """Turn yfinance's raw Ticker.news list into our flat news-item shape, dropping any
    entry missing a title or a usable URL."""
    items = []
    for entry in raw:
        content = entry.get("content") or {}
        if not content.get("title"):
            continue
        url = (content.get("clickThroughUrl") or {}).get("url") or (content.get("canonicalUrl") or {}).get("url")
        if not url:
            continue
        items.append({
            "id": entry.get("id") or content.get("id"),
            "title": content.get("title"),
            "summary": content.get("summary") or content.get("description") or None,
            "published_at": content.get("pubDate") or content.get("displayTime"),
            "publisher": (content.get("provider") or {}).get("displayName"),
            "url": url,
            "thumbnail_url": _yahoo_thumbnail(content),
        })
    return items


def fetch_yahoo_news(symbol: str) -> list[dict]:
    """Fetch + normalize news for one Yahoo symbol. Never raises — returns [] on any
    failure (delisted ticker, no coverage, transient Yahoo error, etc.)."""
    import yfinance as yf
    try:
        raw = yf.Ticker(symbol).news or []
    except Exception:
        return []
    return normalize_yahoo_news(raw)
