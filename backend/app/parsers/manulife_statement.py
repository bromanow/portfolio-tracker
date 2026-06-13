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


def parse_manulife_pdf(pdf_bytes: bytes) -> dict:
    funds: list[dict] = []
    total: Optional[Decimal] = None
    as_of: Optional[date] = None

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
                    mp = _PERIOD_RE.search(line)
                    if mp and mp.group(1) in _MONTHS:
                        as_of = date(int(mp.group(3)), _MONTHS[mp.group(1)], int(mp.group(2)))

    if not funds:
        raise ValueError("No Manulife fund holdings found — is this a Manulife statement PDF?")

    parsed_total = sum((f["value"] for f in funds), Decimal("0"))
    return {
        "institution": "Manulife",
        "account_type": "RRSP",
        "currency": "CAD",
        "as_of": as_of or date.today(),
        "account_total": total or parsed_total,
        "holdings": funds,   # each: {code, name, units, unit_price, value}
    }
