"""
Covered Call Portfolio Builder & Manager.

Two-step selection flow:
POST /api/covered-call-portfolio/screen    – Step 1: background job, ranks the FULL CA/US
                                              candidate universe by stock-level suitability
GET  /api/covered-call-portfolio/screen/{job_id}  – poll a screen job
POST /api/covered-call-portfolio/propose   – Step 2: background job, finds the best contract
                                              per ticker (pass `tickers` from Step 1's picks,
                                              or omit it to scan the curated universe directly)
GET  /api/covered-call-portfolio/propose/{job_id} – poll a propose job
POST /api/covered-call-portfolio/{id}/adopt        – adopt a PROPOSED set of picks
GET  /api/covered-call-portfolio                   – list portfolios
GET  /api/covered-call-portfolio/{id}              – one portfolio + its holdings
"""
import logging
import threading
import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import background_jobs
from app.database import get_db, SessionLocal

router = APIRouter(prefix="/api/covered-call-portfolio", tags=["covered-call-portfolio"])
logger = logging.getLogger(__name__)


class ProposeRequest(BaseModel):
    min_dte: int = 14
    max_dte: int = 60
    min_otm_pct: float = 0.5
    max_otm_pct: float = 25.0
    min_option_oi: int = 50
    min_option_vol: int = 3
    min_avg_stock_vol: int = 250_000
    min_div_yield: float = 0.0
    max_stock_price: float = 0.0
    min_annual_yield_pct: float = 0.0
    min_delta: Optional[float] = None
    max_delta: Optional[float] = None
    min_iv_pct: Optional[float] = None
    num_ca: int = 5
    num_us: int = 10
    extra_tickers: Optional[list[str]] = None
    # Data-driven candidate universe: rank the full in-screener-universe by liquidity,
    # volatility & yield instead of the hand-curated static lists. Defaults ON.
    dynamic_universe: bool = True
    us_pool: int = 100
    ca_pool: int = 40
    # Step 2 of the two-step flow — an explicit ticker list approved in /screen. When set,
    # only these tickers are scanned (num_ca/num_us/extra_tickers are ignored).
    tickers: Optional[list[str]] = None


class AdoptRequest(BaseModel):
    name: str = "Covered Call Portfolio"
    mode: str  # SIMULATED | REAL
    account_id: Optional[int] = None       # REAL mode only
    picks: list[dict]                      # the propose job's result "picks" list (or a subset)


class SellToOpenRequest(BaseModel):
    strike: float
    expiry_date: date
    contracts: int = 1
    premium_per_contract: Optional[float] = None
    trade_date: Optional[date] = None   # defaults to today in the handler
    notes: Optional[str] = None


class RollRequest(BaseModel):
    close_premium_per_contract: Optional[float] = None   # cost to buy back the expiring leg
    new_strike: float
    new_expiry_date: date
    new_premium_per_contract: Optional[float] = None
    contracts: Optional[int] = None   # defaults to the closed leg's contract count
    trade_date: Optional[date] = None
    notes: Optional[str] = None


class CloseRequest(BaseModel):
    outcome: str  # ASSIGNED | EXPIRED_WORTHLESS
    trade_date: Optional[date] = None
    notes: Optional[str] = None


class MatchTransactionRequest(BaseModel):
    transaction_id: int


class UpdateHoldingRequest(BaseModel):
    contracts: Optional[int] = None            # each contract = 100 shares (SIMULATED sizing)
    cost_basis_per_share: Optional[float] = None


def _spawn_propose(req: ProposeRequest) -> dict:
    name = "covered_call_portfolio_propose"
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(name)

    def _run():
        try:
            from app.services.covered_call_portfolio_service import BuildParams, build_portfolio

            params = BuildParams(
                min_dte=req.min_dte, max_dte=req.max_dte,
                min_otm_pct=req.min_otm_pct, max_otm_pct=req.max_otm_pct,
                min_option_oi=req.min_option_oi, min_option_vol=req.min_option_vol,
                min_avg_stock_vol=req.min_avg_stock_vol, min_div_yield=req.min_div_yield,
                max_stock_price=req.max_stock_price,
                min_annual_yield_pct=req.min_annual_yield_pct,
                min_delta=req.min_delta, max_delta=req.max_delta, min_iv_pct=req.min_iv_pct,
                num_ca=req.num_ca, num_us=req.num_us, extra_tickers=req.extra_tickers,
                tickers=req.tickers,
                dynamic_universe=req.dynamic_universe, us_pool=req.us_pool, ca_pool=req.ca_pool,
            )

            def _progress(done, total, ticker):
                background_jobs.update_progress(job_id, {
                    "stage": "scanning", "source": ticker, "done": done, "total": total,
                })

            with SessionLocal() as db:
                result = build_portfolio(db, params, progress_cb=_progress)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("Covered-call portfolio propose job failed")
            background_jobs.fail_job(job_id, str(exc))

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.post("/propose")
def propose_portfolio(body: ProposeRequest = None):
    """Start a background scan of the CA/US candidate universes. Returns a job_id to poll."""
    return _spawn_propose(body or ProposeRequest())


@router.get("/propose/{job_id}")
def get_propose_job(job_id: str):
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/pmcc")
def pmcc_lookup(ticker: str, db: Session = Depends(get_db)):
    """Synthetic covered call (Poor Man's Covered Call) finder for one ticker: a deep-ITM LEAPS
    long leg + a near-term OTM short call, with capital/income economics. Non-registered only."""
    from app.services.pmcc_service import find_pmcc
    if not ticker or not ticker.strip():
        raise HTTPException(status_code=400, detail="ticker is required")
    try:
        return find_pmcc(db, ticker.strip().upper())
    except Exception as exc:
        logger.exception("PMCC lookup failed for %s", ticker)
        return {"available": False, "reason": str(exc)}


def _spawn_screen(req: ProposeRequest) -> dict:
    name = "covered_call_portfolio_screen"
    if background_jobs.is_running(name):
        running = [j for j in background_jobs.list_jobs() if j["name"] == name and j["status"] == "running"]
        return {"job_id": running[0]["id"] if running else None, "status": "already_running", "already_running": True}

    job_id = background_jobs.start_job(name)

    def _run():
        try:
            from app.services.covered_call_portfolio_service import BuildParams, screen_stock_universe

            params = BuildParams(
                min_dte=req.min_dte, max_dte=req.max_dte,
                min_otm_pct=req.min_otm_pct, max_otm_pct=req.max_otm_pct,
                min_option_oi=req.min_option_oi, min_option_vol=req.min_option_vol,
                min_avg_stock_vol=req.min_avg_stock_vol, min_div_yield=req.min_div_yield,
                max_stock_price=req.max_stock_price,
                min_annual_yield_pct=req.min_annual_yield_pct,
                min_delta=req.min_delta, max_delta=req.max_delta, min_iv_pct=req.min_iv_pct,
                extra_tickers=req.extra_tickers,
                dynamic_universe=req.dynamic_universe, us_pool=req.us_pool, ca_pool=req.ca_pool,
            )

            def _progress(done, total, ticker):
                background_jobs.update_progress(job_id, {
                    "stage": "screening", "source": ticker, "done": done, "total": total,
                })

            with SessionLocal() as db:
                result = screen_stock_universe(db, params, progress_cb=_progress)
            background_jobs.finish_job(job_id, result)
        except Exception as exc:
            logger.exception("Covered-call stock screen job failed")
            background_jobs.fail_job(job_id, str(exc))

    threading.Thread(target=_run, daemon=True).start()
    return {"job_id": job_id, "status": "started", "already_running": False}


@router.post("/screen")
def screen_stocks(body: ProposeRequest = None):
    """Step 1 of the two-step flow: rank the FULL CA/US candidate universe by stock-level
    covered-call suitability (not a specific contract). Returns a job_id to poll — use the
    result's tickers as the `tickers` field on /propose (Step 2) to find each one's best
    contract."""
    return _spawn_screen(body or ProposeRequest())


@router.get("/screen/{job_id}")
def get_screen_job(job_id: str):
    job = background_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/{portfolio_id}/adopt")
def adopt_portfolio(portfolio_id: int, body: AdoptRequest, db: Session = Depends(get_db)):
    """
    Deprecated path kept for symmetry — in practice `POST /adopt` (no existing id) is used
    to create+adopt in one step; see create_and_adopt below. Left as a 404 stub since a
    PROPOSED row isn't created until adoption in the current flow (no separate "save
    proposal" step yet).
    """
    raise HTTPException(status_code=404, detail="Portfolio not found — use POST /adopt to create one")


@router.post("/adopt")
def create_and_adopt(body: AdoptRequest, db: Session = Depends(get_db)):
    """
    Adopt a set of picks (from a /propose job's result) as a new portfolio.

    SIMULATED: creates a holding + an initial SELL_TO_OPEN trade per pick immediately,
    using the pick's own price/premium snapshot — fully self-contained.
    REAL: creates a holding per pick with shares=None (derived live from the real account's
    transactions later); no trade rows are created since there's no real option sold yet.
    """
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding, CoveredCallTrade
    from app.services.normalizer import get_or_create_security

    if body.mode not in ("SIMULATED", "REAL"):
        raise HTTPException(status_code=400, detail="mode must be SIMULATED or REAL")
    if body.mode == "REAL" and not body.account_id:
        raise HTTPException(status_code=400, detail="account_id is required for REAL mode")
    if not body.picks:
        raise HTTPException(status_code=400, detail="No picks provided")

    portfolio = CoveredCallPortfolio(
        name=body.name, mode=body.mode, status="ACTIVE",
        account_id=body.account_id if body.mode == "REAL" else None,
    )
    db.add(portfolio)
    db.flush()

    for pick in body.picks:
        ticker = pick["ticker"]
        security = get_or_create_security(db, ticker=ticker, currency=pick.get("currency") or "USD")
        if pick.get("company_name") and not security.name:
            security.name = pick["company_name"]

        holding = CoveredCallHolding(
            portfolio_id=portfolio.id,
            security_id=security.id,
            shares=100.0 if body.mode == "SIMULATED" else None,
            cost_basis_per_share=pick.get("current_price") if body.mode == "SIMULATED" else None,
            proposal_score=pick.get("score"),
            proposal_why=pick.get("why"),
        )
        db.add(holding)
        db.flush()

        if body.mode == "SIMULATED":
            db.add(CoveredCallTrade(
                holding_id=holding.id,
                trade_type="SELL_TO_OPEN",
                strike=pick["strike"],
                expiry_date=pick["expiry_date"],
                contracts=1,
                premium_per_contract=pick.get("mid"),
                trade_date=date.today(),
            ))

    db.commit()
    return {"id": portfolio.id, "name": portfolio.name, "mode": portfolio.mode, "holdings": len(body.picks)}


@router.get("")
def list_portfolios(db: Session = Depends(get_db)):
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding
    rows = db.query(CoveredCallPortfolio).order_by(CoveredCallPortfolio.created_at.desc()).all()
    out = []
    for p in rows:
        n_holdings = db.query(CoveredCallHolding).filter(CoveredCallHolding.portfolio_id == p.id).count()
        out.append({
            "id": p.id, "name": p.name, "mode": p.mode, "status": p.status,
            "account_id": p.account_id, "created_at": p.created_at.isoformat() if p.created_at else None,
            "holdings": n_holdings,
        })
    return out


@router.get("/calendar")
def get_expiry_calendar(db: Session = Depends(get_db)):
    """Every currently-open call across all ACTIVE portfolios, for the expiry calendar —
    bucketing by expiry_date happens client-side (dte/expiry_date are enough to group by).
    ITM/assignment-risk is derived from the underlying's live MarketPrice, same source the
    rest of the app already uses (no separate price fetch). Same data source the scheduler's
    daily alert check uses, so the two can never disagree about what's "at risk"."""
    from app.services.covered_call_portfolio_service import get_open_legs_with_risk
    return get_open_legs_with_risk(db)


@router.get("/{portfolio_id}")
def get_portfolio(portfolio_id: int, db: Session = Depends(get_db)):
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding, CoveredCallTrade
    from app.models.master import Security

    p = db.query(CoveredCallPortfolio).filter(CoveredCallPortfolio.id == portfolio_id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    holdings = db.query(CoveredCallHolding).filter(CoveredCallHolding.portfolio_id == p.id).all()
    holdings_out = []
    for h in holdings:
        security = db.query(Security).filter(Security.id == h.security_id).first()
        trades = (
            db.query(CoveredCallTrade)
            .filter(CoveredCallTrade.holding_id == h.id)
            .order_by(CoveredCallTrade.trade_date.desc(), CoveredCallTrade.id.desc())
            .all()
        )
        holdings_out.append({
            "id": h.id,
            "security_id": h.security_id,
            "ticker": security.ticker if security else None,
            "company_name": security.name if security else None,
            "currency": security.currency if security else None,
            "shares": float(h.shares) if h.shares is not None else None,
            "cost_basis_per_share": float(h.cost_basis_per_share) if h.cost_basis_per_share is not None else None,
            "status": h.status,
            "opened_at": h.opened_at.isoformat() if h.opened_at else None,
            "proposal_score": float(h.proposal_score) if h.proposal_score is not None else None,
            "proposal_why": h.proposal_why,
            "trades": [
                {
                    "id": t.id, "trade_type": t.trade_type,
                    "strike": float(t.strike), "expiry_date": t.expiry_date.isoformat(),
                    "contracts": t.contracts,
                    "premium_per_contract": float(t.premium_per_contract) if t.premium_per_contract is not None else None,
                    "trade_date": t.trade_date.isoformat() if t.trade_date else None,
                    "roll_chain_id": t.roll_chain_id,
                    "notes": t.notes,
                }
                for t in trades
            ],
        })

    return {
        "id": p.id, "name": p.name, "mode": p.mode, "status": p.status,
        "account_id": p.account_id, "created_at": p.created_at.isoformat() if p.created_at else None,
        "holdings": holdings_out,
    }


# ── Trade management: sell-to-open, roll, close ────────────────────────────────
#
# A "roll chain" is a sequence of trades sharing roll_chain_id: it starts with a
# SELL_TO_OPEN, may continue through any number of (BUY_TO_CLOSE, SELL_TO_OPEN) roll
# pairs, and ends in a terminal BUY_TO_CLOSE (closed outright, no replacement),
# ASSIGNED, or EXPIRED_WORTHLESS. "The open leg" for a holding is its most recent
# trade IF that trade is a SELL_TO_OPEN — any other most-recent trade_type means the
# holding currently has no call sold against it.

def _get_holding(db: Session, portfolio_id: int, holding_id: int):
    from app.models.covered_call import CoveredCallHolding
    h = (
        db.query(CoveredCallHolding)
        .filter(CoveredCallHolding.id == holding_id, CoveredCallHolding.portfolio_id == portfolio_id)
        .first()
    )
    if h is None:
        raise HTTPException(status_code=404, detail="Holding not found in this portfolio")
    return h


def _get_open_leg(db: Session, holding_id: int):
    from app.models.covered_call import CoveredCallTrade
    latest = (
        db.query(CoveredCallTrade)
        .filter(CoveredCallTrade.holding_id == holding_id)
        .order_by(CoveredCallTrade.trade_date.desc(), CoveredCallTrade.id.desc())
        .first()
    )
    if latest is not None and latest.trade_type == "SELL_TO_OPEN":
        return latest
    return None


@router.patch("/{portfolio_id}/holdings/{holding_id}")
def update_holding(portfolio_id: int, holding_id: int, body: UpdateHoldingRequest, db: Session = Depends(get_db)):
    """Resize a SIMULATED holding: set the number of contracts held (shares = contracts × 100)
    and, optionally, the cost basis per share. Scales every trade on the holding to the same
    contract count so premium collected and cost basis stay consistent. REAL-mode holdings derive
    their share count from the linked account, so contracts can't be set there."""
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallTrade

    holding = _get_holding(db, portfolio_id, holding_id)
    portfolio = db.query(CoveredCallPortfolio).filter(CoveredCallPortfolio.id == portfolio_id).first()

    if body.contracts is not None:
        if portfolio and portfolio.mode == "REAL":
            raise HTTPException(status_code=400, detail="Real-mode share counts come from the account and can't be set here")
        if body.contracts < 1:
            raise HTTPException(status_code=400, detail="contracts must be at least 1")
        holding.shares = body.contracts * 100
        for t in db.query(CoveredCallTrade).filter(CoveredCallTrade.holding_id == holding_id).all():
            t.contracts = body.contracts

    if body.cost_basis_per_share is not None:
        holding.cost_basis_per_share = body.cost_basis_per_share

    db.commit()
    db.refresh(holding)
    return {
        "id": holding.id,
        "shares": float(holding.shares) if holding.shares is not None else None,
        "cost_basis_per_share": float(holding.cost_basis_per_share) if holding.cost_basis_per_share is not None else None,
    }


@router.delete("/{portfolio_id}/holdings/{holding_id}")
def delete_holding(portfolio_id: int, holding_id: int, db: Session = Depends(get_db)):
    """Remove a single holding (and its option trades) from a portfolio. For REAL portfolios
    this only deletes the strategy metadata — the linked real Transaction rows are untouched."""
    from app.models.covered_call import CoveredCallTrade

    holding = _get_holding(db, portfolio_id, holding_id)
    db.query(CoveredCallTrade).filter(CoveredCallTrade.holding_id == holding_id).delete(synchronize_session=False)
    db.delete(holding)
    db.commit()
    return {"deleted_holding_id": holding_id}


@router.delete("/{portfolio_id}")
def delete_portfolio(portfolio_id: int, db: Session = Depends(get_db)):
    """Delete an entire portfolio — its holdings and option trades. Real ledger untouched
    (option trades only carry a link to the real Transaction, which is not deleted)."""
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding, CoveredCallTrade

    portfolio = db.query(CoveredCallPortfolio).filter(CoveredCallPortfolio.id == portfolio_id).first()
    if portfolio is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    holding_ids = [h.id for h in db.query(CoveredCallHolding).filter(CoveredCallHolding.portfolio_id == portfolio_id).all()]
    if holding_ids:
        db.query(CoveredCallTrade).filter(CoveredCallTrade.holding_id.in_(holding_ids)).delete(synchronize_session=False)
    db.query(CoveredCallHolding).filter(CoveredCallHolding.portfolio_id == portfolio_id).delete(synchronize_session=False)
    db.delete(portfolio)
    db.commit()
    return {"deleted_portfolio_id": portfolio_id}


@router.post("/{portfolio_id}/holdings/{holding_id}/sell-to-open")
def sell_to_open(portfolio_id: int, holding_id: int, body: SellToOpenRequest, db: Session = Depends(get_db)):
    """Start a new roll chain — sell a call against a holding with no currently open leg."""
    from app.models.covered_call import CoveredCallTrade

    _get_holding(db, portfolio_id, holding_id)
    if _get_open_leg(db, holding_id) is not None:
        raise HTTPException(status_code=409, detail="This holding already has an open call — use /roll or /close instead")

    trade = CoveredCallTrade(
        holding_id=holding_id, trade_type="SELL_TO_OPEN",
        strike=body.strike, expiry_date=body.expiry_date, contracts=body.contracts,
        premium_per_contract=body.premium_per_contract,
        trade_date=body.trade_date or date.today(),
        roll_chain_id=str(uuid.uuid4()), notes=body.notes,
    )
    db.add(trade)
    db.commit()
    db.refresh(trade)
    return {"id": trade.id, "roll_chain_id": trade.roll_chain_id}


@router.post("/{portfolio_id}/holdings/{holding_id}/roll")
def roll(portfolio_id: int, holding_id: int, body: RollRequest, db: Session = Depends(get_db)):
    """Close the current open leg and immediately open the next one, same roll chain."""
    from app.models.covered_call import CoveredCallTrade

    _get_holding(db, portfolio_id, holding_id)
    open_leg = _get_open_leg(db, holding_id)
    if open_leg is None:
        raise HTTPException(status_code=409, detail="No open call on this holding to roll — use /sell-to-open first")

    trade_date = body.trade_date or date.today()
    chain_id = open_leg.roll_chain_id or str(uuid.uuid4())

    close_trade = CoveredCallTrade(
        holding_id=holding_id, trade_type="BUY_TO_CLOSE",
        strike=open_leg.strike, expiry_date=open_leg.expiry_date, contracts=open_leg.contracts,
        premium_per_contract=body.close_premium_per_contract,
        trade_date=trade_date, roll_chain_id=chain_id, notes=body.notes,
    )
    open_trade = CoveredCallTrade(
        holding_id=holding_id, trade_type="SELL_TO_OPEN",
        strike=body.new_strike, expiry_date=body.new_expiry_date,
        contracts=body.contracts or open_leg.contracts,
        premium_per_contract=body.new_premium_per_contract,
        trade_date=trade_date, roll_chain_id=chain_id,
    )
    db.add(close_trade)
    db.add(open_trade)
    db.commit()
    db.refresh(close_trade)
    db.refresh(open_trade)
    return {"closed_id": close_trade.id, "opened_id": open_trade.id, "roll_chain_id": chain_id}


@router.post("/{portfolio_id}/holdings/{holding_id}/close")
def close_leg(portfolio_id: int, holding_id: int, body: CloseRequest, db: Session = Depends(get_db)):
    """Terminal outcome for the current open leg — assigned (shares called away) or
    expired worthless (kept the shares, free to sell a new call). No new leg opened."""
    from app.models.covered_call import CoveredCallTrade

    holding = _get_holding(db, portfolio_id, holding_id)
    if body.outcome not in ("ASSIGNED", "EXPIRED_WORTHLESS"):
        raise HTTPException(status_code=400, detail="outcome must be ASSIGNED or EXPIRED_WORTHLESS")

    open_leg = _get_open_leg(db, holding_id)
    if open_leg is None:
        raise HTTPException(status_code=409, detail="No open call on this holding to close")

    trade_date = body.trade_date or date.today()
    trade = CoveredCallTrade(
        holding_id=holding_id, trade_type=body.outcome,
        strike=open_leg.strike, expiry_date=open_leg.expiry_date, contracts=open_leg.contracts,
        premium_per_contract=None, trade_date=trade_date,
        roll_chain_id=open_leg.roll_chain_id, notes=body.notes,
    )
    db.add(trade)

    # SIMULATED assignment means the shares are actually sold at strike — the holding's
    # position is gone. (EXPIRED_WORTHLESS keeps the shares; nothing to change.)
    if body.outcome == "ASSIGNED" and holding.shares is not None:
        holding.status = "CLOSED"
        holding.closed_at = trade_date

    db.commit()
    db.refresh(trade)
    return {"id": trade.id, "holding_status": holding.status}


@router.get("/{portfolio_id}/summary")
def get_portfolio_summary(portfolio_id: int, db: Session = Depends(get_db)):
    """Premium collected (per holding + portfolio total) and trade-outcome counts.
    Annualized yield-on-capital is computed only for SIMULATED holdings, where a cost
    basis is actually tracked here — REAL holdings' cost basis lives in the real ledger,
    not duplicated in this schema (see Stage 2 real-transaction matching)."""
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding, CoveredCallTrade
    from app.models.master import Security

    p = db.query(CoveredCallPortfolio).filter(CoveredCallPortfolio.id == portfolio_id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    holdings = db.query(CoveredCallHolding).filter(CoveredCallHolding.portfolio_id == p.id).all()

    per_holding = []
    total_premium = 0.0
    total_cost_basis = 0.0
    earliest_trade: Optional[date] = None
    counts = {"SELL_TO_OPEN": 0, "BUY_TO_CLOSE": 0, "ASSIGNED": 0, "EXPIRED_WORTHLESS": 0}

    for h in holdings:
        security = db.query(Security).filter(Security.id == h.security_id).first()
        trades = db.query(CoveredCallTrade).filter(CoveredCallTrade.holding_id == h.id).all()
        premium = 0.0
        for t in trades:
            counts[t.trade_type] = counts.get(t.trade_type, 0) + 1
            if t.premium_per_contract is None:
                continue
            amt = float(t.premium_per_contract) * t.contracts * 100
            if t.trade_type == "SELL_TO_OPEN":
                premium += amt
            elif t.trade_type == "BUY_TO_CLOSE":
                premium -= amt
            if earliest_trade is None or (t.trade_date and t.trade_date < earliest_trade):
                earliest_trade = t.trade_date

        total_premium += premium
        if h.shares is not None and h.cost_basis_per_share is not None:
            total_cost_basis += float(h.shares) * float(h.cost_basis_per_share)

        per_holding.append({
            "holding_id": h.id, "ticker": security.ticker if security else None,
            "premium_collected": round(premium, 2), "status": h.status,
        })

    days = (date.today() - earliest_trade).days if earliest_trade else 0
    annualized_yield_pct = (
        round(total_premium / total_cost_basis * (365 / days) * 100, 2)
        if total_cost_basis > 0 and days > 0 else None
    )

    return {
        "portfolio_id": p.id,
        "total_premium_collected": round(total_premium, 2),
        "total_cost_basis": round(total_cost_basis, 2) if total_cost_basis > 0 else None,
        "annualized_yield_on_capital_pct": annualized_yield_pct,
        "trade_counts": counts,
        "per_holding": per_holding,
    }


# ── REAL mode: match imported option transactions to a holding ────────────────
#
# Real transaction_type strings this app actually imports for options (see
# ibkr_flex.py/ibkr_trades.py): OPTION_SELL, OPTION_BUY, OPTION_EXPIRY,
# OPTION_ASSIGNMENT, OPTION_EXERCISE. None of these match CoveredCallTrade's own
# vocabulary (SELL_TO_OPEN/BUY_TO_CLOSE/ASSIGNED/EXPIRED_WORTHLESS), so matching
# translates one to the other rather than reusing the string directly.
_REAL_TYPE_MAP = {
    "OPTION_SELL": "SELL_TO_OPEN",
    "OPTION_BUY": "BUY_TO_CLOSE",
    "OPTION_ASSIGNMENT": "ASSIGNED",
    "OPTION_EXPIRY": "EXPIRED_WORTHLESS",
}


@router.get("/{portfolio_id}/unmatched-transactions")
def unmatched_transactions(portfolio_id: int, db: Session = Depends(get_db)):
    """Real option transactions on this portfolio's account, for underlyings this
    portfolio holds, that aren't yet linked to a CoveredCallTrade — candidates to match
    via POST .../match-transaction instead of re-entering the trade by hand."""
    from app.models.covered_call import CoveredCallPortfolio, CoveredCallHolding, CoveredCallTrade
    from app.models.master import Security
    from app.models.transactions import Transaction
    from app.services.price_service import parse_option_ticker

    p = db.query(CoveredCallPortfolio).filter(CoveredCallPortfolio.id == portfolio_id).first()
    if p is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    if p.mode != "REAL" or not p.account_id:
        return []

    holdings = db.query(CoveredCallHolding).filter(CoveredCallHolding.portfolio_id == p.id).all()
    tickers_by_underlying = {}
    for h in holdings:
        sec = db.query(Security).filter(Security.id == h.security_id).first()
        if sec:
            tickers_by_underlying[sec.ticker.upper()] = (h.id, sec.ticker)

    already_linked = {
        r[0] for r in db.query(CoveredCallTrade.real_transaction_id)
        .filter(CoveredCallTrade.real_transaction_id.isnot(None)).all()
    }

    txns = (
        db.query(Transaction)
        .filter(
            Transaction.account_id == p.account_id,
            Transaction.transaction_type.in_(list(_REAL_TYPE_MAP.keys())),
        )
        .order_by(Transaction.transaction_date.desc())
        .all()
    )

    out = []
    for t in txns:
        if t.id in already_linked or t.security_id is None:
            continue
        sec = db.query(Security).filter(Security.id == t.security_id).first()
        if sec is None:
            continue
        parsed = parse_option_ticker(sec.ticker, sec)
        if not parsed or parsed["underlying"].upper() not in tickers_by_underlying:
            continue
        holding_id, holding_ticker = tickers_by_underlying[parsed["underlying"].upper()]
        out.append({
            "transaction_id": t.id,
            "holding_id": holding_id,
            "underlying": holding_ticker,
            "transaction_type": t.transaction_type,
            "suggested_trade_type": _REAL_TYPE_MAP[t.transaction_type],
            "option_type": parsed["option_type"],
            "strike": parsed["strike"],
            "expiry_date": parsed["expiry"].isoformat(),
            "contracts": abs(float(t.quantity)) if t.quantity is not None else None,
            "transaction_date": t.transaction_date.isoformat() if t.transaction_date else None,
            "transaction_amount": float(t.transaction_amount) if t.transaction_amount is not None else None,
        })
    return out


@router.post("/{portfolio_id}/holdings/{holding_id}/match-transaction")
def match_transaction(portfolio_id: int, holding_id: int, body: MatchTransactionRequest, db: Session = Depends(get_db)):
    """Create a CoveredCallTrade from a real imported option Transaction instead of the
    user re-entering it by hand — strike/expiry/contracts/premium all read from the real
    row so this can never drift from the actual ledger."""
    from app.models.covered_call import CoveredCallTrade
    from app.models.master import Security
    from app.models.transactions import Transaction
    from app.services.price_service import parse_option_ticker

    holding = _get_holding(db, portfolio_id, holding_id)
    txn = db.query(Transaction).filter(Transaction.id == body.transaction_id).first()
    if txn is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if txn.transaction_type not in _REAL_TYPE_MAP:
        raise HTTPException(status_code=400, detail=f"Unsupported transaction_type: {txn.transaction_type}")

    already = db.query(CoveredCallTrade).filter(CoveredCallTrade.real_transaction_id == txn.id).first()
    if already is not None:
        raise HTTPException(status_code=409, detail="This transaction is already linked to a trade")

    sec = db.query(Security).filter(Security.id == txn.security_id).first()
    parsed = parse_option_ticker(sec.ticker, sec) if sec else None
    if not parsed:
        raise HTTPException(status_code=400, detail="Could not parse option details from this transaction's security")

    trade_type = _REAL_TYPE_MAP[txn.transaction_type]
    contracts = int(abs(txn.quantity)) if txn.quantity is not None else 1

    premium_per_contract = None
    if trade_type in ("SELL_TO_OPEN", "BUY_TO_CLOSE"):
        amt = txn.transaction_amount if txn.transaction_amount is not None else txn.cad_amount
        if amt is not None and contracts > 0:
            premium_per_contract = abs(float(amt)) / contracts / 100

    if trade_type == "SELL_TO_OPEN":
        chain_id = str(uuid.uuid4())
    else:
        open_leg = _get_open_leg(db, holding_id)
        chain_id = open_leg.roll_chain_id if open_leg else str(uuid.uuid4())

    trade = CoveredCallTrade(
        holding_id=holding_id, trade_type=trade_type,
        strike=parsed["strike"], expiry_date=parsed["expiry"], contracts=contracts,
        premium_per_contract=premium_per_contract, trade_date=txn.transaction_date,
        roll_chain_id=chain_id, real_transaction_id=txn.id,
    )
    db.add(trade)

    if trade_type == "ASSIGNED":
        holding.status = "CLOSED"
        holding.closed_at = txn.transaction_date

    db.commit()
    db.refresh(trade)
    return {"id": trade.id, "trade_type": trade.trade_type, "roll_chain_id": chain_id}
