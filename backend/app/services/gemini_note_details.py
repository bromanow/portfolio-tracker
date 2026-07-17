"""Extract structured-note term-sheet fields from an issuer PDF info sheet using Google
Gemini — mirrors gemini_statement.py's pattern (inline PDF input, JSON-mode response, no
per-issuer regex to maintain).

Config: reuses GEMINI_API_KEY / GEMINI_MODEL (same as gemini_statement.py).
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY", "").strip())


def _loads_lenient(text: str) -> dict:
    """Parse Gemini's JSON, tolerating the occasional code fence or trailing comma
    it emits even in JSON mode. Mirrors gemini_statement.py's helper of the same name."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[A-Za-z]*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw).strip()
    i, j = raw.find("{"), raw.rfind("}")
    if i != -1 and j > i:
        raw = raw[i:j + 1]
    try:
        return json.loads(raw)
    except Exception:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", raw)
        try:
            return json.loads(cleaned)
        except Exception as e:
            raise ValueError(f"Gemini returned non-JSON output: {e}")

_PROMPT = """You are a precise financial-data extractor. The attached PDF is an issuer info \
sheet / term sheet for a structured note (e.g. a bank-issued autocallable contingent-coupon \
note). Extract its terms.

Return ONLY valid JSON (no markdown, no code fences) matching exactly this shape:
{
  "reference_asset": string|null,      // the underlying index/basket/stock the note tracks
  "payment_amount": string|null,       // e.g. "$10.74 per Note" — keep the original text/format
  "payment_frequency": string|null,    // e.g. "Monthly", "Quarterly"
  "payment_barrier_pct": number|null,  // e.g. 70.0 for "70.0% of Initial Asset Level"
  "autocall_level_pct": number|null,   // e.g. 105.0 for "105.0% of Initial Asset Level"
  "barrier_level_pct": number|null,    // principal barrier, e.g. 70.0
  "status": string|null,               // one of: "Active", "Called", "Matured" if stated; else null
  "product_category": string|null,     // e.g. "Callable Contingent Coupon/ROC"
  "cusip_code": string|null,
  "adp_code": string|null,
  "issue_date": string|null,           // YYYY-MM-DD
  "maturity_date": string|null,        // YYYY-MM-DD
  "term_years": number|null            // e.g. 7.0
}

Rules:
- Percentages must be plain numbers (70.0, not "70.0%" or 0.70).
- Dates must be YYYY-MM-DD; if only a "Mon DD, YYYY" format is shown, convert it.
- Only extract data actually present in the PDF; use null for anything not shown — never invent."""


def _dec(v) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _date(v) -> Optional[date]:
    if not v:
        return None
    try:
        return datetime.strptime(str(v).strip(), "%Y-%m-%d").date()
    except Exception:
        return None


def parse_note_pdf(pdf_bytes: bytes) -> dict:
    """Best-effort extraction — raises on any failure so callers can treat it as optional."""
    import google.generativeai as genai

    genai.configure(api_key=os.environ["GEMINI_API_KEY"].strip())
    model = genai.GenerativeModel(
        os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
        generation_config={
            "response_mime_type": "application/json",
            "max_output_tokens": 8192,
            "temperature": 0,
        },
    )
    resp = model.generate_content([
        {"mime_type": "application/pdf", "data": pdf_bytes},
        _PROMPT,
    ])
    obj = _loads_lenient(resp.text)

    return {
        "reference_asset": (obj.get("reference_asset") or None),
        "payment_amount": (obj.get("payment_amount") or None),
        "payment_frequency": (obj.get("payment_frequency") or None),
        "payment_barrier_pct": _dec(obj.get("payment_barrier_pct")),
        "autocall_level_pct": _dec(obj.get("autocall_level_pct")),
        "barrier_level_pct": _dec(obj.get("barrier_level_pct")),
        "status": (obj.get("status") or None),
        "product_category": (obj.get("product_category") or None),
        "cusip_code": (obj.get("cusip_code") or None),
        "adp_code": (obj.get("adp_code") or None),
        "issue_date": _date(obj.get("issue_date")),
        "maturity_date": _date(obj.get("maturity_date")),
        "term_years": _dec(obj.get("term_years")),
    }
