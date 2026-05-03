"""
Bank of Canada FX rate service.
Fetches USD/CAD rates and caches in the database.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
import logging
import httpx
from sqlalchemy.orm import Session
from app.models.master import FXRate

logger = logging.getLogger(__name__)

BOC_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2020-01-01"


async def fetch_boc_rates(db: Session) -> int:
    """Fetch all USD/CAD rates from Bank of Canada and cache in DB. Returns count of new rates added."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(BOC_URL)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.error("Failed to fetch BoC rates: %s", e)
        return 0

    observations = data.get("observations", [])
    added = 0

    for obs in observations:
        date_str = obs.get("d", "")
        rate_val = obs.get("FXUSDCAD", {})
        if isinstance(rate_val, dict):
            rate_val = rate_val.get("v", None)

        if not date_str or rate_val is None:
            continue

        try:
            rate_date = date.fromisoformat(date_str)
            rate = Decimal(str(rate_val))
        except Exception:
            continue

        # Check if exists
        existing = db.query(FXRate).filter(
            FXRate.rate_date == rate_date,
            FXRate.from_currency == "USD",
            FXRate.to_currency == "CAD",
        ).first()

        if not existing:
            fx = FXRate(
                rate_date=rate_date,
                from_currency="USD",
                to_currency="CAD",
                rate=rate,
                source="BOC",
            )
            db.add(fx)
            added += 1

    db.commit()
    logger.info("Added %d new FX rates from BoC", added)
    return added


def get_rate(db: Session, rate_date: date, from_currency: str, to_currency: str) -> Optional[Decimal]:
    """
    Get FX rate for a given date. Falls back to previous business day if not available.
    Supports USD/CAD and CAD/USD.
    """
    if from_currency == to_currency:
        return Decimal("1")

    # Normalize: we store USD/CAD
    invert = False
    if from_currency == "CAD" and to_currency == "USD":
        from_currency, to_currency = "USD", "CAD"
        invert = True

    if from_currency != "USD" or to_currency != "CAD":
        logger.warning("FX rate not available for %s/%s", from_currency, to_currency)
        return None

    # Try up to 7 days back (weekend / holiday fallback)
    for i in range(8):
        check_date = rate_date - timedelta(days=i)
        fx = db.query(FXRate).filter(
            FXRate.rate_date == check_date,
            FXRate.from_currency == "USD",
            FXRate.to_currency == "CAD",
        ).first()
        if fx:
            rate = fx.rate
            if invert:
                rate = Decimal("1") / rate
            return rate

    logger.warning("No FX rate found for %s/%s on or before %s", from_currency, to_currency, rate_date)
    return None


def get_usd_to_cad(db: Session, rate_date: date) -> Optional[Decimal]:
    return get_rate(db, rate_date, "USD", "CAD")


def ensure_rates_loaded(db: Session) -> bool:
    """Check if we have recent rates, return True if we do."""
    count = db.query(FXRate).count()
    return count > 0
