"""Parse a Manulife group-retirement statement PDF into holdings.

Manulife's "Details of your investments" table extracts cleanly with pdfplumber,
one fund per line:
    4143MLFidelityBondPlusInste2* 668.41826 $12.4470 $8,319.74 20.9% 1.8%
i.e.  {fundCode}{name}* {units} ${unitPrice} ${value} {pctOfPortfolio}% {ror}%

We key each fund on its 4-digit Manulife fund code (stable across statements).
"""
from __future__ import annotations

import io
import re
from datetime import date
from decimal import Decimal
from typing import Optional

import pdfplumber

# code + name (greedy until '*') + units + $unitPrice + $value(2dp) + pct% + ror%
_FUND_RE = re.compile(
    r"^(\d{4})(.+?)\*\s+([\d.]+)\s+\$([\d.]+)\s+\$([\d,]+\.\d{2})\s+([\d.]+)%\s+([\d.]+)%"
)
# Manulife's PDF text is often whitespace-stripped, so allow optional spaces.
_TOTAL_RE = re.compile(r"current\s*value\s*of\s*your\s*account\s*is\s*\$([\d,]+\.\d{2})", re.I)
_PERIOD_RE = re.compile(r"to\s*([A-Z][a-z]+)\s*(\d{1,2}),\s*(\d{4})")
_START_RE = re.compile(r"from\s*([A-Z][a-z]+)\s*(\d{1,2}),\s*(\d{4})", re.I)
# "What happened this period" change-summary is a multi-column table; the ROW TOTAL is the
# LAST dollar figure on the line. Best-effort only — Gemini handles this far more reliably.
_DOLLARS = re.compile(r"\$([\d,]+\.\d{2})")
_MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], start=1)}


def _dec(s: str) -> Decimal:
    return Decimal(s.replace(",", ""))


def _clean_name(raw: str) -> str:
    """'MLFidelityBondPlusInste2' -> 'ML Fidelity Bond Plus Inste2' (readable enough)."""
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", raw)          # camelCase → spaced
    s = re.sub(r"(?<=[A-Za-z])(?=&)|(?<=&)(?=[A-Za-z])", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _date_from(m) -> Optional[date]:
    if m and m.group(1).capitalize() in _MONTHS:
        return date(int(m.group(3)), _MONTHS[m.group(1).capitalize()], int(m.group(2)))
    return None


def parse_manulife_pdf(pdf_bytes: bytes) -> dict:
    funds: list[dict] = []
    total: Optional[Decimal] = None
    as_of: Optional[date] = None
    period_start: Optional[date] = None
    contributions: Optional[Decimal] = None
    transfers_in: Optional[Decimal] = None
    withdrawals: Optional[Decimal] = None

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for line in text.split("\n"):
                m = _FUND_RE.match(line.strip())
                if m:
                    code, name, units, px, val, _pct, _ror = m.groups()
                    funds.append({
                        "code": code,
                        "name": _clean_name(name),
                        "units": _dec(units),
                        "unit_price": _dec(px),
                        "value": _dec(val),
                    })
                if total is None:
                    mt = _TOTAL_RE.search(line)
                    if mt:
                        total = _dec(mt.group(1))
                if as_of is None:
                    as_of = _date_from(_PERIOD_RE.search(line))
                if period_start is None:
                    period_start = _date_from(_START_RE.search(line))

                low = line.lower().replace(" ", "")
                amts = _DOLLARS.findall(line)
                if amts:
                    if contributions is None and low.startswith("pluscontributions"):
                        contributions = _dec(amts[-1])            # row total = last column
                    if transfers_in is None and "transferred" in low and "intoyourplan" in low:
                        transfers_in = _dec(amts[-1])
                    if withdrawals is None and ("withdrawal" in low or "transferredout" in low):
                        withdrawals = _dec(amts[-1])

    if not funds:
        raise ValueError("No Manulife fund holdings found — is this a Manulife statement PDF?")

    parsed_total = sum((f["value"] for f in funds), Decimal("0"))
    return {
        "institution": "Manulife",
        "account_type": "RRSP",
        "currency": "CAD",
        "as_of": as_of or date.today(),
        "period_start": period_start,
        "account_total": total or parsed_total,
        "flows": {
            "contributions": contributions,
            "transfers_in": transfers_in,
            "withdrawals": withdrawals,
        },
        "holdings": funds,   # each: {code, name, units, unit_price, value}
    }
