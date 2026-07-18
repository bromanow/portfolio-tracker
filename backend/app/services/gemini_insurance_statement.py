"""Extract policy fields from a life insurance statement PDF using Google Gemini.

Same pattern as gemini_statement.py (investment statements): gemini-2.5-flash,
responseMimeType=application/json, temperature 0, native inline PDF input. Generalises
across insurers (Manulife, Sun Life, Canada Life, ...) — Gemini reads the PDF and returns
structured JSON, so there's no per-insurer layout to maintain.

Config: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-2.5-flash).
"""
from __future__ import annotations

import os
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

from app.services.gemini_statement import is_configured, _loads_lenient  # noqa: F401 (is_configured re-exported for callers)

_PROMPT = """You are a precise financial-data extractor. The attached PDF is a life \
insurance policy statement (e.g. Manulife Perspecta, Sun Life, Canada Life universal/whole \
life statement). Extract the policy's key fields.

Return ONLY valid JSON (no markdown, no code fences) matching exactly this shape:
{
  "insurer_name": string,          // insurance company, e.g. "Manulife", "Sun Life"
  "contract_type": string|null,    // type/name of contract, e.g. "PERSPECTA - SINGLE LIFE", "Whole Life", "Term 20"
  "policy_number": string|null,    // policy/contract number
  "policy_issue_date": string|null,  // date the policy was originally issued, YYYY-MM-DD
  "statement_date": string,        // this statement's "as of" / statement date, YYYY-MM-DD
  "insured_name": string|null,     // name of the person whose life is insured
  "beneficiary": string|null,      // beneficiary name(s); join multiple with ", "
  "sum_insured": number|null,      // base sum insured / face amount
  "death_benefit": number|null,    // total death benefit payable (may exceed sum insured if increasing)
  "cash_surrender_value": number|null,  // cash surrender value / accumulated fund value as of the statement date
  "currency": string             // ISO currency of the dollar values, e.g. CAD, USD
}

Rules:
- Numbers must be plain JSON numbers — never include "$", commas, or "%".
- Use the values as of the statement date shown on the document, not historical/prior-year figures.
- If a field isn't present in the statement, use null — never invent a figure.
- "statement_date" is required; if genuinely absent, use the most recent date shown anywhere in the document."""


def _dec(v) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _parse_date(raw: Optional[str]) -> Optional[date]:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except Exception:
        return None


def parse_insurance_statement(pdf_bytes: bytes) -> dict:
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

    statement_date = _parse_date(obj.get("statement_date")) or date.today()

    return {
        "insurer_name": (obj.get("insurer_name") or None),
        "contract_type": (obj.get("contract_type") or None),
        "policy_number": (obj.get("policy_number") or None),
        "policy_issue_date": _parse_date(obj.get("policy_issue_date")),
        "statement_date": statement_date,
        "insured_name": (obj.get("insured_name") or None),
        "beneficiary": (obj.get("beneficiary") or None),
        "sum_insured": _dec(obj.get("sum_insured")),
        "death_benefit": _dec(obj.get("death_benefit")),
        "cash_surrender_value": _dec(obj.get("cash_surrender_value")),
        "currency": (obj.get("currency") or "CAD").upper().strip(),
    }
