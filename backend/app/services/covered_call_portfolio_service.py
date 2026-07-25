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
    num_ca: int = 5
    num_us: int = 10
    extra_tickers: Optional[list[str]] = None   # user-added candidates (from the retired watchlist)

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


def _best_per_ticker(opportunities: list[dict], min_annual_yield_pct: float) -> list[dict]:
    """Collapse multiple strikes/expiries per ticker down to that ticker's single best-scoring
    contract, then drop any ticker whose best pick still misses the target-return floor."""
    best: dict[str, dict] = {}
    for opp in opportunities:
        if opp["annual_yield_pct"] < min_annual_yield_pct:
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

    ca_best = sorted(_best_per_ticker(ca_opps, params.min_annual_yield_pct), key=lambda o: -o["score"])
    us_best = sorted(_best_per_ticker(us_opps, params.min_annual_yield_pct), key=lambda o: -o["score"])

    ca_picks = ca_best[: params.num_ca]
    us_picks = us_best[: params.num_us]

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
            "ca": params.num_ca - len(ca_picks),
            "us": params.num_us - len(us_picks),
        },
    }
