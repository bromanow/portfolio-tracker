"""Live IBeam bid/ask + greeks for held option positions.

Kept separate from /options (which is fast, DB-only) because this makes live IBeam calls.
The Options tab fetches it async and merges by security_id. Cached briefly so repeated loads
and the single-session IBeam gateway aren't hammered; returns {available:false} when IBeam is
down so the UI can show "—" gracefully.
"""
from __future__ import annotations

import time
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.auth import User

router = APIRouter(prefix="/api/portfolio/options-live", tags=["options-live"])

_CACHE: dict[int, tuple[float, dict]] = {}   # security_id → (fetched_at, quote)
_TTL = 60.0
_QUOTE_KEYS = ("bid", "ask", "delta", "gamma", "theta", "vega", "iv_pct")


@router.get("")
def options_live(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from app.services.acb_service import get_all_positions_acb
    from app.services.price_service import parse_option_ticker
    from app.services import ibkr_service
    from app.models.master import Security

    if not ibkr_service.is_ibeam_available():
        return {"available": False, "quotes": {}}

    secs = {s.id: s for s in db.query(Security).filter(Security.is_option == True).all()}  # noqa: E712
    today = date.today()
    now = time.time()
    quotes: dict[int, dict] = {}

    for a in get_all_positions_acb(db):
        if Decimal(str(a["quantity"])) == 0:
            continue
        sid = a["security_id"]
        if sid in quotes:
            continue
        sec = secs.get(sid)
        if not sec:
            continue
        po = parse_option_ticker(sec.ticker, security=sec)
        if not po or po["expiry"] < today:
            continue   # not an option / already expired

        cached = _CACHE.get(sid)
        if cached and now - cached[0] < _TTL:
            quotes[sid] = cached[1]
            continue
        try:
            q = ibkr_service.fetch_option_price_ibeam(
                po["underlying"], po["expiry"], po["strike"], po["option_type"], po["is_canadian"],
            )
        except Exception:
            q = None
        if q:
            quote = {k: q.get(k) for k in _QUOTE_KEYS}
            _CACHE[sid] = (now, quote)
            quotes[sid] = quote

    return {"available": True, "quotes": quotes}
