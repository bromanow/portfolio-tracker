"""
Covered Call Portfolio Builder.

Picks an optimal starting book of N Canadian + M US covered-call names from the curated
candidate universe (app/data/covered_call_universe.py), given user-set target parameters
(min dividend yield, min annualized premium yield/"target return", IV/DTE bounds, etc).

Reuses covered_call_service.py's scoring engine end-to-end (scan_tickers → per-ticker
opportunities → _score/explain_score) rather than reimplementing option-chain fetching or
scoring — this module only adds candidate-universe scoping and the "pick the best contract
per ticker, then the best N/M tickers" selection on top.
"""
import logging
import statistics
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.data.covered_call_universe import US_CANDIDATES, CA_CANDIDATES
from app.services.covered_call_service import ScanParams, scan_tickers, explain_score

logger = logging.getLogger(__name__)


@dataclass
class BuildParams:
    # Reuses the scanner's own tunable knobs so "IV thresholds, option premiums, DTE range"
    # all map onto the exact same fields the scoring engine already understands.
    min_dte: int = 14
    max_dte: int = 60
    min_otm_pct: float = 0.5
    max_otm_pct: float = 25.0
    min_option_oi: int = 50
    min_option_vol: int = 3
    min_avg_stock_vol: int = 250_000
    min_div_yield: float = 0.0
    min_annual_yield_pct: float = 0.0   # the "target return" floor, annualized premium yield
    # Aggressiveness dial: delta is the real lever (0.15-0.25 conservative, 0.35-0.50 aggressive)
    # — exact on the IBKR live path, Black-Scholes-estimated on the yfinance fallback. Left
    # unset (None) by default so existing callers/behavior are unaffected.
    min_delta: Optional[float] = None
    max_delta: Optional[float] = None
    # Absolute IV floor — distinct from the score's IV/HV *ratio* multiplier (which only
    # rewards richness vs the stock's own history); this lets a user chase high-premium,
    # high-vol names outright regardless of whether IV looks "rich" relative to HV.
    min_iv_pct: Optional[float] = None
    num_ca: int = 5
    num_us: int = 10
    extra_tickers: Optional[list[str]] = None   # user-added candidates (from the retired watchlist)
    # Step 2 of the two-step flow: an explicit, user-approved ticker list from /screen.
    # When set, build_portfolio scans ONLY these tickers (ignores the curated universe and
    # extra_tickers) and returns every one of them (num_ca/num_us caps don't apply — the
    # approved list IS the chosen set).
    tickers: Optional[list[str]] = None

    def to_scan_params(self) -> ScanParams:
        return ScanParams(
            min_avg_stock_vol=self.min_avg_stock_vol,
            min_option_oi=self.min_option_oi,
            min_option_vol=self.min_option_vol,
            min_dte=self.min_dte,
            max_dte=self.max_dte,
            min_otm_pct=self.min_otm_pct,
            max_otm_pct=self.max_otm_pct,
            min_div_yield=self.min_div_yield,
            min_rating="Avoid",   # keep everything meeting the hard filters; rank by score after
        )


def _best_per_ticker(
    opportunities: list[dict],
    min_annual_yield_pct: float,
    min_delta: Optional[float] = None,
    max_delta: Optional[float] = None,
    min_iv_pct: Optional[float] = None,
) -> list[dict]:
    """Collapse multiple strikes/expiries per ticker down to that ticker's single best-scoring
    contract satisfying the hard filters (target-return floor, delta band, IV floor), so a
    ticker isn't dropped just because ITS highest-scoring contract happens to miss the band
    while a different strike/expiry for the same name would have qualified."""
    best: dict[str, dict] = {}
    for opp in opportunities:
        if opp["annual_yield_pct"] < min_annual_yield_pct:
            continue
        if min_delta is not None or max_delta is not None:
            delta = opp.get("delta")
            if delta is None:
                continue   # can't verify the requested delta band — exclude rather than guess
            if min_delta is not None and delta < min_delta:
                continue
            if max_delta is not None and delta > max_delta:
                continue
        if min_iv_pct is not None:
            iv = opp.get("iv_pct")
            if iv is None or iv < min_iv_pct:
                continue
        t = opp["ticker"]
        if t not in best or opp["score"] > best[t]["score"]:
            best[t] = opp
    return list(best.values())


def build_portfolio(db: Session, params: BuildParams, progress_cb=None) -> dict:
    """
    Scan the CA and US candidate universes separately (so the geographic split is
    guaranteed regardless of relative scores) and return the top `num_ca` + `num_us`
    picks by score, each with its recommended contract and a "why" explanation.
    """
    scan_params = params.to_scan_params()

    if params.tickers:
        # Step 2 of the two-step flow — an explicit approved list, no curated defaults.
        ca_universe = [t for t in params.tickers if t.upper().endswith(".TO") or t.upper().endswith(".V")]
        us_universe = [t for t in params.tickers if t not in ca_universe]
        num_ca, num_us = len(ca_universe), len(us_universe)
    else:
        ca_universe = list(CA_CANDIDATES)
        us_universe = list(US_CANDIDATES)
        if params.extra_tickers:
            for t in params.extra_tickers:
                tu = t.strip().upper()
                if tu.endswith(".TO") or tu.endswith(".V"):
                    if tu not in ca_universe:
                        ca_universe.append(tu)
                elif tu and tu not in us_universe:
                    us_universe.append(tu)
        num_ca, num_us = params.num_ca, params.num_us

    total = len(ca_universe) + len(us_universe)
    done = 0

    def _cb(i, n, ticker):
        nonlocal done
        done += 1
        if progress_cb:
            progress_cb(done, total, ticker)

    ca_opps, ca_errors, ca_meta = scan_tickers(ca_universe, db, scan_params, progress_cb=_cb)
    us_opps, us_errors, us_meta = scan_tickers(us_universe, db, scan_params, progress_cb=_cb)

    ca_best = sorted(
        _best_per_ticker(ca_opps, params.min_annual_yield_pct, params.min_delta, params.max_delta, params.min_iv_pct),
        key=lambda o: -o["score"],
    )
    us_best = sorted(
        _best_per_ticker(us_opps, params.min_annual_yield_pct, params.min_delta, params.max_delta, params.min_iv_pct),
        key=lambda o: -o["score"],
    )

    ca_picks = ca_best[:num_ca]
    us_picks = us_best[:num_us]

    def _enrich(opp: dict) -> dict:
        why = explain_score(
            annual_yield=opp.get("annual_yield_pct"),
            delta=opp.get("delta"),
            otm_pct=opp.get("otm_pct"),
            iv_pct=opp.get("iv_pct"),
            hv_30_pct=opp.get("hv_30_pct"),
            iv_hv_ratio=opp.get("iv_hv_ratio"),
            dte=opp.get("dte"),
            open_interest=opp.get("open_interest"),
            bid_ask_spread_pct=opp.get("bid_ask_spread_pct"),
        )
        return {**opp, "why": why}

    picks = [_enrich(o) for o in ca_picks] + [_enrich(o) for o in us_picks]

    logger.info(
        "build_portfolio: %d CA candidates → %d picks, %d US candidates → %d picks",
        len(ca_universe), len(ca_picks), len(us_universe), len(us_picks),
    )

    return {
        "picks": picks,
        "ca_picks": len(ca_picks),
        "us_picks": len(us_picks),
        "ca_candidates_scanned": len(ca_universe),
        "us_candidates_scanned": len(us_universe),
        "errors": ca_errors + us_errors,
        "data_source": ca_meta["data_source"],
        "shortfall": {
            "ca": num_ca - len(ca_picks),
            "us": num_us - len(us_picks),
        },
    }


def _aggregate_by_ticker(opportunities: list[dict], min_annual_yield_pct: float,
                          min_delta: Optional[float], max_delta: Optional[float],
                          min_iv_pct: Optional[float]) -> list[dict]:
    """Step 1 of the two-step flow: group ALL of a ticker's qualifying contracts (not just
    its single best) into a stock-level suitability summary — best/median score across its
    own chain, total open interest across strikes (liquidity depth, not one strike's OI),
    and how many contracts even qualify at all (0 means an illiquid/no-chain name). This is
    what lets you judge "is this a consistently good covered-call name" before locking into
    one specific strike/expiry, which build_portfolio (Step 2) does separately."""
    by_ticker: dict[str, list[dict]] = {}
    for opp in opportunities:
        if opp["annual_yield_pct"] < min_annual_yield_pct:
            continue
        if min_delta is not None or max_delta is not None:
            delta = opp.get("delta")
            if delta is None:
                continue
            if min_delta is not None and delta < min_delta:
                continue
            if max_delta is not None and delta > max_delta:
                continue
        if min_iv_pct is not None:
            iv = opp.get("iv_pct")
            if iv is None or iv < min_iv_pct:
                continue
        by_ticker.setdefault(opp["ticker"], []).append(opp)

    rows = []
    for ticker, contracts in by_ticker.items():
        best = max(contracts, key=lambda o: o["score"])
        scores = [c["score"] for c in contracts]
        rows.append({
            "ticker": ticker,
            "company_name": best.get("company_name"),
            "currency": best.get("currency"),
            "current_price": best.get("current_price"),
            "dividend_yield": best.get("dividend_yield"),
            "avg_stock_volume": best.get("avg_stock_volume"),
            "contracts_found": len(contracts),
            "total_open_interest": sum(c.get("open_interest") or 0 for c in contracts),
            "best_score": best["score"],
            "median_score": round(statistics.median(scores), 4),
            "best_annual_yield_pct": best["annual_yield_pct"],
            "best_iv_pct": best.get("iv_pct"),
            "best_iv_hv_ratio": best.get("iv_hv_ratio"),
            "best_dte": best["dte"],
            "best_strike": best["strike"],
            "best_expiry_date": best["expiry_date"],
            "best_recommendation": best.get("recommendation"),
        })
    return rows


def screen_stock_universe(db: Session, params: BuildParams, progress_cb=None) -> dict:
    """Step 1: rank the FULL CA/US candidate universe by stock-level covered-call
    suitability (not tied to any one strike/expiry) so you can review and hand-pick which
    names you actually want, before Step 2 (build_portfolio) finds each one's best contract.
    Unlike build_portfolio, this returns EVERY qualifying ticker — no num_ca/num_us cap."""
    scan_params = params.to_scan_params()

    ca_universe = list(CA_CANDIDATES)
    us_universe = list(US_CANDIDATES)
    if params.extra_tickers:
        for t in params.extra_tickers:
            tu = t.strip().upper()
            if tu.endswith(".TO") or tu.endswith(".V"):
                if tu not in ca_universe:
                    ca_universe.append(tu)
            elif tu and tu not in us_universe:
                us_universe.append(tu)

    total = len(ca_universe) + len(us_universe)
    done = 0

    def _cb(i, n, ticker):
        nonlocal done
        done += 1
        if progress_cb:
            progress_cb(done, total, ticker)

    ca_opps, ca_errors, ca_meta = scan_tickers(ca_universe, db, scan_params, progress_cb=_cb)
    us_opps, us_errors, us_meta = scan_tickers(us_universe, db, scan_params, progress_cb=_cb)

    ca_rows = sorted(
        _aggregate_by_ticker(ca_opps, params.min_annual_yield_pct, params.min_delta, params.max_delta, params.min_iv_pct),
        key=lambda r: -r["best_score"],
    )
    us_rows = sorted(
        _aggregate_by_ticker(us_opps, params.min_annual_yield_pct, params.min_delta, params.max_delta, params.min_iv_pct),
        key=lambda r: -r["best_score"],
    )

    logger.info(
        "screen_stock_universe: %d CA candidates → %d qualify, %d US candidates → %d qualify",
        len(ca_universe), len(ca_rows), len(us_universe), len(us_rows),
    )

    return {
        "ca": ca_rows,
        "us": us_rows,
        "ca_candidates_scanned": len(ca_universe),
        "us_candidates_scanned": len(us_universe),
        "errors": ca_errors + us_errors,
        "data_source": ca_meta["data_source"],
    }


def get_open_legs_with_risk(db: Session) -> list[dict]:
    """Every currently-open call across all ACTIVE portfolios, with DTE and an
    ITM/assignment-risk flag — the shared data source for both the expiry calendar
    (GET /calendar) and the scheduler's daily alert check, so the two can never
    disagree about what counts as "at risk"."""
    from datetime import date
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding, CoveredCallTrade
    from app.models.master import Security
    from app.models.prices import MarketPrice

    portfolios = db.query(CoveredCallPortfolio).filter(CoveredCallPortfolio.status == "ACTIVE").all()
    today = date.today()
    entries = []
    for p in portfolios:
        holdings = (
            db.query(CoveredCallHolding)
            .filter(CoveredCallHolding.portfolio_id == p.id, CoveredCallHolding.status == "ACTIVE")
            .all()
        )
        for h in holdings:
            latest = (
                db.query(CoveredCallTrade)
                .filter(CoveredCallTrade.holding_id == h.id)
                .order_by(CoveredCallTrade.trade_date.desc(), CoveredCallTrade.id.desc())
                .first()
            )
            if latest is None or latest.trade_type != "SELL_TO_OPEN":
                continue
            security = db.query(Security).filter(Security.id == h.security_id).first()
            mp = db.query(MarketPrice).filter(MarketPrice.security_id == h.security_id).first()
            current_price = float(mp.price) if mp else None
            strike = float(latest.strike)
            entries.append({
                "portfolio_id": p.id, "portfolio_name": p.name, "mode": p.mode,
                "holding_id": h.id, "ticker": security.ticker if security else None,
                "currency": security.currency if security else None,
                "strike": strike, "expiry_date": latest.expiry_date.isoformat(),
                "dte": (latest.expiry_date - today).days, "contracts": latest.contracts,
                "premium_per_contract": float(latest.premium_per_contract) if latest.premium_per_contract is not None else None,
                "current_price": current_price,
                "itm": current_price is not None and current_price > strike,
            })
    return entries
