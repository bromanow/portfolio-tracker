"""
Covered Call Portfolio Builder & Manager.

POST /api/covered-call-portfolio/propose   – background job: score the CA/US candidate
                                              universes, return top N/M picks
GET  /api/covered-call-portfolio/propose/{job_id} – poll a propose job
POST /api/covered-call-portfolio/{id}/adopt        – adopt a PROPOSED set of picks
GET  /api/covered-call-portfolio                   – list portfolios
GET  /api/covered-call-portfolio/{id}              – one portfolio + its holdings
"""
import logging
import threading
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
    min_annual_yield_pct: float = 0.0
    min_delta: Optional[float] = None
    max_delta: Optional[float] = None
    min_iv_pct: Optional[float] = None
    num_ca: int = 5
    num_us: int = 10
    extra_tickers: Optional[list[str]] = None


class AdoptRequest(BaseModel):
    name: str = "Covered Call Portfolio"
    mode: str  # SIMULATED | REAL
    account_id: Optional[int] = None       # REAL mode only
    picks: list[dict]                      # the propose job's result "picks" list (or a subset)


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
                min_annual_yield_pct=req.min_annual_yield_pct,
                min_delta=req.min_delta, max_delta=req.max_delta, min_iv_pct=req.min_iv_pct,
                num_ca=req.num_ca, num_us=req.num_us, extra_tickers=req.extra_tickers,
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
            .order_by(CoveredCallTrade.trade_date.desc())
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
