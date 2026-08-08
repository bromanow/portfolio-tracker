"""Synthetic covered call (a.k.a. Poor Man's Covered Call / PMCC) finder.

The capital problem: writing a real covered call on a $900 stock needs $90k for 100 shares. A PMCC
replaces the 100 shares with a **deep-in-the-money LEAPS call** (a long-dated call, delta ~0.80) as
a lower-capital stock substitute, then sells a near-term out-of-the-money call against it — a
diagonal spread that earns similar premium income for a fraction of the capital.

**Account constraint (surfaced to the user, not enforced here):** a PMCC is a diagonal spread —
a registered account (RRSP/TFSA) can't post the long option as cover for the short call, so the
short reads as naked and isn't permitted. PMCC is a **non-registered (margin) account** strategy.

Data comes from yfinance (last-session quotes, Black-Scholes-estimated Greeks) — the same basis as
the covered-call scanner's yfinance path — so it works any day of the week.
"""
from __future__ import annotations

import logging
import math
from datetime import date, datetime
from typing import Optional

import yfinance as yf
from sqlalchemy.orm import Session

from app.services.covered_call_service import _bs_greeks, _hv_from_db, _hv_from_yfinance

logger = logging.getLogger(__name__)


def _dte(exp_str: str) -> int:
    return (datetime.strptime(exp_str, "%Y-%m-%d").date() - date.today()).days


def _f(v) -> Optional[float]:
    try:
        f = float(v)
        return f if not (math.isnan(f) or math.isinf(f)) else None
    except (TypeError, ValueError):
        return None


def find_pmcc(
    db: Session,
    ticker: str,
    *,
    short_min_dte: int = 21,
    short_max_dte: int = 45,
    short_min_otm_pct: float = 2.0,
    short_max_otm_pct: float = 12.0,
    leaps_min_dte: int = 270,
    leaps_max_dte: int = 730,
    leaps_target_delta: float = 0.80,
    leaps_min_delta: float = 0.70,
) -> dict:
    """Return the best PMCC pairing for one ticker, or {available: False, reason}.

    Long leg: the LEAPS call whose delta is closest to `leaps_target_delta` (and ≥ min), among
    long-dated deep-ITM calls. Short leg: the near-term OTM call with the richest premium yield.
    """
    yft = yf.Ticker(ticker)
    try:
        info = yft.info or {}
    except Exception as exc:
        return {"available": False, "reason": f"quote lookup failed: {exc}"}
    price = _f(info.get("currentPrice")) or _f(info.get("regularMarketPrice")) or _f(info.get("previousClose"))
    if not price or price <= 0:
        return {"available": False, "reason": "no underlying price"}

    hv = _hv_from_db(ticker, db) or _hv_from_yfinance(ticker)
    try:
        expirations = list(yft.options or [])
    except Exception as exc:
        return {"available": False, "reason": f"no option chain: {exc}"}

    long_exps = [e for e in expirations if leaps_min_dte <= _dte(e) <= leaps_max_dte]
    short_exps = [e for e in expirations if short_min_dte <= _dte(e) <= short_max_dte]
    if not long_exps:
        return {"available": False, "reason": "no LEAPS expiries in range (needs ~9-24 months out)"}
    if not short_exps:
        return {"available": False, "reason": "no near-term expiries in range"}

    # ── Long leg: deep-ITM LEAPS with delta closest to target ────────────────────
    best_long = None
    for exp in long_exps:
        dte = _dte(exp)
        try:
            calls = yft.option_chain(exp).calls
        except Exception:
            continue
        for _, r in calls.iterrows():
            strike = _f(r.get("strike"))
            ask = _f(r.get("ask"))
            bid = _f(r.get("bid"))
            if strike is None or strike >= price or not ask or ask <= 0:
                continue
            iv = (_f(r.get("impliedVolatility")) or 0) * 100
            iv_use = iv if iv > 0 else (hv or 35.0)
            delta, _theta = _bs_greeks(price, strike, iv_use, dte)
            if delta is None or delta < leaps_min_delta:
                continue
            intrinsic = max(price - strike, 0.0)
            cand = {
                "expiry_date": exp, "dte": dte, "strike": strike,
                "bid": bid, "ask": ask, "mid": round((bid or ask) + (ask - (bid or ask)) / 2, 4) if bid else ask,
                "delta": round(delta, 4), "iv_pct": round(iv_use, 1),
                "intrinsic": round(intrinsic, 4), "extrinsic": round(ask - intrinsic, 4),
                "_score": -abs(delta - leaps_target_delta),
            }
            if best_long is None or cand["_score"] > best_long["_score"]:
                best_long = cand
    if best_long is None:
        return {"available": False, "reason": f"no LEAPS with delta ≥ {leaps_min_delta:.2f} found"}

    # ── Short leg: near-term OTM call with the best premium yield ─────────────────
    lo_k = price * (1 + short_min_otm_pct / 100)
    hi_k = price * (1 + short_max_otm_pct / 100)
    best_short = None
    for exp in short_exps:
        dte = _dte(exp)
        try:
            calls = yft.option_chain(exp).calls
        except Exception:
            continue
        for _, r in calls.iterrows():
            strike = _f(r.get("strike"))
            bid = _f(r.get("bid"))
            ask = _f(r.get("ask"))
            if strike is None or not (lo_k <= strike <= hi_k) or not bid or bid <= 0:
                continue
            mid = round((bid + (ask or bid)) / 2, 4)
            iv = (_f(r.get("impliedVolatility")) or 0) * 100
            delta, _t = _bs_greeks(price, strike, iv if iv > 0 else (hv or 35.0), dte)
            yield_annual = (mid / price) * (365 / dte) * 100 if dte > 0 else 0
            cand = {
                "expiry_date": exp, "dte": dte, "strike": strike,
                "bid": bid, "ask": ask, "mid": mid,
                "delta": round(delta, 4) if delta is not None else None,
                "iv_pct": round(iv, 1) if iv else None,
                "annual_yield_pct": round(yield_annual, 2),
            }
            if best_short is None or cand["annual_yield_pct"] > best_short["annual_yield_pct"]:
                best_short = cand
    if best_short is None:
        return {"available": False, "reason": "no near-term OTM call with a bid found"}

    # ── Economics ────────────────────────────────────────────────────────────────
    long_debit = best_long["ask"] * 100                 # you buy the LEAPS at the ask
    short_income = best_short["bid"] * 100              # you sell the short at the bid
    net_debit = round(long_debit - short_income, 2)
    cc_capital = price * 100                            # a real covered call ties up 100 shares
    capital_savings_pct = round((1 - net_debit / cc_capital) * 100, 1) if cc_capital else None
    income_yield_annual = round(short_income / net_debit * (365 / best_short["dte"]) * 100, 2) if net_debit > 0 and best_short["dte"] > 0 else None
    breakeven = round(best_long["strike"] + net_debit / 100, 2)
    max_profit = round((best_short["strike"] - best_long["strike"]) * 100 - net_debit, 2)
    # Extrinsic coverage: over the short's life the LEAPS bleeds ~ its extrinsic × (short_dte/long_dte).
    # The short credit should exceed that for the trade to be theta-positive.
    leaps_decay = best_long["extrinsic"] * 100 * (best_short["dte"] / best_long["dte"]) if best_long["dte"] else None
    extrinsic_coverage = round(short_income / leaps_decay, 2) if leaps_decay and leaps_decay > 0 else None

    return {
        "available": True,
        "ticker": ticker.upper(),
        "underlying_price": round(price, 2),
        "currency": (info.get("currency") or "USD").upper(),
        "long_leg": {k: v for k, v in best_long.items() if not k.startswith("_")},
        "short_leg": best_short,
        "economics": {
            "long_debit": round(long_debit, 2),
            "short_income": round(short_income, 2),
            "net_debit": net_debit,
            "covered_call_capital": round(cc_capital, 2),
            "capital_savings_pct": capital_savings_pct,
            "income_yield_annual_pct": income_yield_annual,
            "breakeven": breakeven,
            "max_profit": max_profit,
            "extrinsic_coverage_ratio": extrinsic_coverage,
        },
        "note": "Diagonal spread — non-registered (margin) accounts only; not permitted in RRSP/TFSA.",
    }
