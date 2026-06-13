"""Extract investment holdings from any statement PDF using Google Gemini.

Mirrors the CRE app's parser: @google/generative-ai → gemini-2.5-flash with
responseMimeType=application/json, temperature 0, native inline PDF input. Here it's
the Python `google-generativeai` SDK. Generalises across institutions (Manulife,
Principal, brokerage statements) — Gemini reads the PDF and returns structured JSON,
so there's no per-format regex to maintain.

Config: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-2.5-flash).
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

logger = logging.getLogger(__name__)

_PROMPT = """You are a precise financial-data extractor. The attached PDF is an investment \
account statement. Extract the account's holdings and metadata.

Return ONLY valid JSON (no markdown, no code fences) matching exactly this shape:
{
  "institution": string,        // institution / plan provider, e.g. "Manulife", "Principal Financial Group"
  "account_type": string|null,  // registered type if shown: RRSP, TFSA, RESP, RRIF, LIRA, 401K, IRA, ROTH, NON_REG; else null
  "as_of": string,              // statement period END date, formatted YYYY-MM-DD
  "period_start": string|null,  // statement period START date (YYYY-MM-DD) if shown, else null
  "currency": string,           // ISO currency of the values, e.g. CAD, USD
  "account_total": number|null, // total account market value
  "flows": {                    // money movements DURING this statement period (from the
                                //   "summary of changes" / "what happened this period" section)
    "contributions": number|null, // employee + employer contributions paid in this period
    "transfers_in": number|null,  // money/assets transferred INTO the plan this period
    "withdrawals": number|null    // money withdrawn/transferred OUT this period (positive number)
  },
  "holdings": [
    {
      "name": string,           // fund / security name
      "code": string|null,      // fund code or ticker symbol if shown, else null
      "units": number|null,     // units / shares held
      "unit_price": number|null,// price per unit
      "value": number           // market value of the holding
    }
  ]
}

Rules:
- Numbers must be plain JSON numbers — never include "$", commas, or "%".
- Include EVERY holding/fund line, even very small ones.
- If units or unit_price aren't shown but the value is, set the missing one to null.
- For "flows", read the period's change-summary (opening value + contributions + transfers
  + growth = closing value). Report only money that moved IN or OUT — NOT investment growth,
  interest or dividends. If a figure isn't shown, set it to null. Withdrawals are a positive number.
- Only extract data actually present in the statement; never invent figures."""


def is_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY", "").strip())


def _dec(v) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _loads_lenient(text: str) -> dict:
    """Parse Gemini's JSON, tolerating the occasional code fence or trailing comma
    it emits even in JSON mode."""
    import re
    raw = (text or "").strip()
    if raw.startswith("```"):                       # strip ```json … ``` fences
        raw = re.sub(r"^```[A-Za-z]*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw).strip()
    i, j = raw.find("{"), raw.rfind("}")            # narrow to the outermost object
    if i != -1 and j > i:
        raw = raw[i:j + 1]
    try:
        return json.loads(raw)
    except Exception:
        cleaned = re.sub(r",(\s*[}\]])", r"\1", raw)  # drop trailing commas before } or ]
        try:
            return json.loads(cleaned)
        except Exception as e:
            raise ValueError(f"Gemini returned non-JSON output: {e}")


def parse_statement(pdf_bytes: bytes) -> dict:
    import google.generativeai as genai

    genai.configure(api_key=os.environ["GEMINI_API_KEY"].strip())
    model = genai.GenerativeModel(
        os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
        generation_config={
            "response_mime_type": "application/json",
            "max_output_tokens": 65536,
            "temperature": 0,
        },
    )
    resp = model.generate_content([
        {"mime_type": "application/pdf", "data": pdf_bytes},
        _PROMPT,
    ])
    obj = _loads_lenient(resp.text)

    # ── Normalize to the importer's shape ────────────────────────────────────
    as_of: Optional[date] = None
    raw_date = (obj.get("as_of") or "").strip()
    try:
        as_of = datetime.strptime(raw_date, "%Y-%m-%d").date()
    except Exception:
        as_of = date.today()

    period_start: Optional[date] = None
    raw_start = (obj.get("period_start") or "").strip()
    if raw_start:
        try:
            period_start = datetime.strptime(raw_start, "%Y-%m-%d").date()
        except Exception:
            period_start = None

    raw_flows = obj.get("flows") or {}
    flows = {
        "contributions": _dec(raw_flows.get("contributions")),
        "transfers_in": _dec(raw_flows.get("transfers_in")),
        "withdrawals": _dec(raw_flows.get("withdrawals")),
    }

    holdings = []
    for h in obj.get("holdings", []) or []:
        value = _dec(h.get("value"))
        if value is None:
            continue
        holdings.append({
            "name": (h.get("name") or "Holding").strip(),
            "code": (str(h.get("code")).strip() if h.get("code") else None),
            "units": _dec(h.get("units")) or Decimal("0"),
            "unit_price": _dec(h.get("unit_price")),
            "value": value,
        })
    if not holdings:
        raise ValueError("Gemini found no holdings in this PDF — is it an investment statement?")

    return {
        "institution": (obj.get("institution") or "Statement").strip(),
        "account_type": (obj.get("account_type") or None),
        "currency": (obj.get("currency") or "CAD").upper().strip(),
        "as_of": as_of,
        "period_start": period_start,
        "account_total": _dec(obj.get("account_total")),
        "flows": flows,
        "holdings": holdings,
    }
