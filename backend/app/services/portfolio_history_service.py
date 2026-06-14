"""
Portfolio value timeline computation.

Builds daily snapshots of each account's market value by replaying
transactions against historical price data.

Algorithm
─────────
1. Load ALL transactions sorted by (date, id) into memory.
2. Load ALL historical prices into a memory dict keyed by security_id,
   sorted by date — O(1) look-ups with bisect.
3. Also load manual MarketPrice rows (source='manual') as constant prices
   for fixed-value securities (mortgages, savings accounts, etc.).
4. Walk through every trading day that exists in historical_prices:
     a. Advance the transaction cursor, updating running per-account positions.
     b. For each account, multiply qty × price and sum → market_value_cad.
     c. Accumulate invested_cad from BUY/SELL/DRIP cash flows up to that date.
     d. Upsert a PortfolioSnapshot row.
5. Commit in batches for performance.

Position quantity rules (same direction as acb_service.py)
─────────────────────────────────────────────────────────
  +qty: BUY, OPENING_BALANCE, OPTION_BUY (long), DRIP(qty>0),
        FORWARD_SPLIT, SPLIT(qty>0), TRANSFER_IN, JOURNAL(qty>0)
  −qty: SELL, OPTION_EXPIRY, OPTION_ASSIGNMENT, TRANSFER_OUT,
        JOURNAL(qty<0), SPLIT(qty<0)
  zero: REVERSE_SPLIT sets the position to the new qty directly
  skip: DIVIDEND, INTEREST, RETURN_OF_CAPITAL, FEE, OTHER, DEPOSIT,
        WITHDRAWAL (no effect on share count)

OPTION_SELL opens a short position (qty stored as negative).
"""

from __future__ import annotations

import bisect
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ZERO = Decimal("0")

# ─── transaction classification ──────────────────────────────────────────────

# Types that ADD to quantity (use abs(qty) as the delta)
_QTY_ADD = frozenset({
    "BUY", "OPENING_BALANCE", "DRIP", "OPTION_BUY",
    "FORWARD_SPLIT", "TRANSFER_IN",
})
# Types that SUBTRACT from quantity (use abs(qty) as the delta)
_QTY_SUB = frozenset({
    "SELL", "TRANSFER_OUT",
})
# Types that SET quantity to the transaction's qty (reverse splits)
_QTY_SET = frozenset({"REVERSE_SPLIT"})
# Types that zero out the position (options closing events)
_QTY_ZERO = frozenset({"OPTION_EXPIRY", "OPTION_ASSIGNMENT"})

# invested_cad accounting: net cash deployed (buys add, sells subtract)
# DRIP: reinvested income — we treat it as 0 net cash (already counted as income)
# TRANSFER_IN/OUT: deliberately excluded — cad_amounts are often inconsistent between
#   the two sides of a transfer, causing worse distortion than excluding them entirely.
#   Instead, the returns endpoint handles transfers by computing them separately.
_INVESTED_ADD = frozenset({"BUY", "OPENING_BALANCE", "OPTION_BUY"})   # cash out
_INVESTED_SUB = frozenset({"SELL"})                                    # cash in (recovery)
_INVESTED_FEE = frozenset({"FEE"})                                     # cost of investing

# income_cad accounting: cumulative income received (cash flows TO the investor)
# OPTION_SELL: premium received for writing options
# DRIP: reinvested dividend — treat as income (the dividend value, even though shares are bought)
# RETURN_OF_CAPITAL: cash returned to investor (return of original investment)
_INCOME_ADD = frozenset({"INTEREST", "DIVIDEND", "OPTION_SELL", "DRIP", "RETURN_OF_CAPITAL"})
_INCOME_SUB = frozenset({"FEE"})  # fees reduce net income

# cash_balance_cad accounting: actual cash in the account (mirrors get_cash_balances logic).
# These types are pure quantity adjustments with no cash movement — skip entirely.
# NOTE: TRANSFER_IN/OUT are intentionally NOT excluded here — they represent real cash
# flowing into/out of the account and are included by get_cash_balances too.
# (The invested_cad logic excludes transfers for a different reason: cross-account
#  amount inconsistencies distort the invested-capital figure. Cash balance is unaffected.)
_CASH_NEUTRAL = frozenset({
    "OPENING_BALANCE", "REVERSE_SPLIT", "FORWARD_SPLIT", "STOCK_DIVIDEND",
    # JOURNAL is an in-kind security move (Norbert's-Gambit currency conversion, fund
    # switch, cross-sleeve transfer) — it carries NO cash. The cash statement
    # (routers/portfolio.py SKIP_TYPES) and dashboard (services/portfolio.py
    # CASH_NEUTRAL_TYPES) both exclude it; this set must too. Omitting it double-counted
    # the CAD leg of NG journals as cash out — e.g. iTrade Brian RRSP's three NG journals
    # (55,435.67 + 20,735.11 + 70,694.90) reconstructed as a phantom −$146,865 CAD balance
    # on a closed account, with the matching USD journal legs as a phantom +cash on the USD
    # sub. The BUY/SELL legs of the gambit already move the cash correctly.
    "JOURNAL",
    # PLAN_CONTRIBUTION is a statement-account contribution: it's an external flow for the
    # return calc (portfolio.py _FLOW_TYPES), but its value is already reflected in the
    # holdings snapshot, so it must NOT also add to cash here (would double-count value).
    "PLAN_CONTRIBUTION",
})
# DRIP is handled separately: include only when cad_amount < 0 (iTrade purchase outflow)
# or cad_amount > 0 with qty == 0 (iTrade DRP cash income). SW reinvestment (qty > 0,
# amount > 0) is cash-neutral and excluded — same rules as get_cash_balances.


# ─── helpers ─────────────────────────────────────────────────────────────────

def _d(v) -> Decimal:
    if v is None:
        return ZERO
    return Decimal(str(v))


def _price_at(series: list[tuple[date, Decimal]], snap_date: date) -> Optional[Decimal]:
    """
    Return the nearest available price for snap_date from a sorted
    [(date, price)] list:
      - the most recent price on or before snap_date (carry-forward), or
      - if none exists yet, the earliest price we ever got (carry-backward).

    Carry-forward handles weekly-NAV funds, thinly-traded names and data gaps.
    Carry-backward handles a held position whose price history only *starts*
    later than the holding period (e.g. Scotia Wealth USD funds first priced
    well after they were bought) — without it those positions value at $0 and
    the account looks empty even though it's fully invested. The look-back uses
    the first-known price for dates before the security's history begins (a mild
    approximation, but far better than $0). Returns None only if there is no
    price for the security at all.
    """
    if not series:
        return None
    # series is sorted ascending by date; find rightmost date <= snap_date
    lo, hi = 0, len(series) - 1
    idx = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= snap_date:
            idx = mid
            lo = mid + 1
        else:
            hi = mid - 1
    if idx < 0:
        # No price on/before snap_date — carry the earliest known price backward.
        return series[0][1]
    return series[idx][1]


# ─── main entry point ────────────────────────────────────────────────────────

def compute_portfolio_snapshots(
    db: Session,
    account_ids: Optional[list[int]] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> dict:
    """
    Compute and upsert daily portfolio value snapshots.

    account_ids: limit to specific accounts (None = all)
    from_date:   start of range (None = earliest transaction)
    to_date:     end of range (None = today)
    """
    from app.models.master import Account, PortfolioSnapshot, Security
    from app.models.transactions import Transaction
    from app.models.prices import HistoricalPrice, MarketPrice
    from sqlalchemy import func as sqlfunc

    if to_date is None:
        to_date = date.today()

    # ── 1. Accounts in scope ──────────────────────────────────────────────────
    acct_q = db.query(Account)
    if account_ids:
        acct_q = acct_q.filter(Account.id.in_(account_ids))
    accounts = {a.id: a for a in acct_q.all()}
    if not accounts:
        return {"snapshots": 0, "accounts": 0, "dates": 0}

    # ── 1b. Option multipliers: 100× for options, 1× for everything else ─────
    # Matches portfolio.py: multiplier = 100 if sec.is_option else 1
    option_sec_ids: set[int] = set(
        r[0] for r in db.query(Security.id).filter(Security.is_option == True).all()
    )

    # ── 1c. Option expiry dates ───────────────────────────────────────────────
    # Expired options have $0 value regardless of any stale price in the DB.
    # Without this guard, _price_at() carries the last known price forward
    # indefinitely, creating phantom market value for closed-out option positions.
    from app.models.options import OptionContract
    option_expiry: dict[int, date] = {
        row.security_id: row.expiry_date
        for row in db.query(OptionContract).all()
        if row.expiry_date is not None
    }

    # ── 2a. Position transactions: require security_id (needed for price lookup) ─
    txn_q = (
        db.query(Transaction)
        .filter(
            Transaction.account_id.in_(accounts.keys()),
            Transaction.transaction_date.isnot(None),
            Transaction.security_id.isnot(None),
        )
        .order_by(Transaction.transaction_date, Transaction.id)
    )
    if to_date:
        txn_q = txn_q.filter(Transaction.transaction_date <= to_date)
    all_txns = txn_q.all()

    if not all_txns:
        return {"snapshots": 0, "accounts": len(accounts), "dates": 0}

    earliest_txn_date = all_txns[0].transaction_date
    if isinstance(earliest_txn_date, datetime):
        earliest_txn_date = earliest_txn_date.date()
    if from_date:
        snap_start = max(from_date, earliest_txn_date)
    else:
        snap_start = earliest_txn_date

    # ── 2b. Cash transactions: no security_id filter — includes DEPOSIT/WITHDRAWAL/
    #        FEE/INTEREST/CASH_OPENING rows that have no associated security ────────
    cash_txn_q = (
        db.query(Transaction)
        .filter(
            Transaction.account_id.in_(accounts.keys()),
            Transaction.transaction_date.isnot(None),
        )
        .order_by(Transaction.transaction_date, Transaction.id)
    )
    if to_date:
        cash_txn_q = cash_txn_q.filter(Transaction.transaction_date <= to_date)
    all_cash_txns = cash_txn_q.all()

    # ── 3. Historical prices → {security_id: sorted[(date, price_cad)]} ──────
    # Load prices with a lookback buffer so that _price_at() can fall back to a
    # recent close when a security has no entry exactly on snap_date (e.g. today's
    # intraday hasn't been written yet, or a holiday gap).  The buffer must be at
    # least as large as _price_at()'s max_stale_days (7).
    _PRICE_LOOKBACK_DAYS = 10
    price_load_start = snap_start - timedelta(days=_PRICE_LOOKBACK_DAYS)
    price_rows = (
        db.query(HistoricalPrice.security_id, HistoricalPrice.price_date, HistoricalPrice.close_price_cad)
        .filter(
            HistoricalPrice.price_date >= price_load_start,
            HistoricalPrice.price_date <= to_date,
            HistoricalPrice.close_price_cad.isnot(None),
        )
        .order_by(HistoricalPrice.security_id, HistoricalPrice.price_date)
        .all()
    )
    price_series: dict[int, list[tuple[date, Decimal]]] = defaultdict(list)
    for sec_id, pd_, cp in price_rows:
        price_series[sec_id].append((pd_, _d(cp)))

    # Manual prices — fallback for securities that have no historical price series at all
    # (e.g. mortgages at face value, savings accounts at $1/unit).
    manual_prices: dict[int, Decimal] = {}
    for mp in db.query(MarketPrice).filter(
        MarketPrice.source == "manual",
        MarketPrice.price_cad.isnot(None),
    ).all():
        manual_prices[mp.security_id] = _d(mp.price_cad)

    # Live market prices — used as a fallback for today's date when historical_prices
    # doesn't yet have an intraday row (e.g. Compute Snapshots run before price refresh).
    # This ensures today's snapshot always matches the Dashboard's live securities value.
    today = date.today()
    live_price_map: dict[int, Decimal] = {}
    if to_date >= today:
        for mp in db.query(MarketPrice).filter(MarketPrice.price_cad.isnot(None)).all():
            if mp.price_cad and _d(mp.price_cad) > ZERO:
                live_price_map[mp.security_id] = _d(mp.price_cad)

    def _get_price(sec_id: int, snap_date: date) -> Optional[Decimal]:
        # Expired options are worth $0 — never carry a stale price forward.
        expiry = option_expiry.get(sec_id)
        if expiry is not None and snap_date > expiry:
            return None

        # For today: prefer live market_prices so the snapshot agrees with the
        # Dashboard (historical_prices may not yet have today's close).
        if snap_date >= today:
            live = live_price_map.get(sec_id)
            if live is not None:
                return live

        if sec_id in price_series:
            p = _price_at(price_series[sec_id], snap_date)
            if p is not None:
                return p
        # Fallback: constant manual price (mortgages, savings accounts, etc.)
        return manual_prices.get(sec_id)

    # ── 4. Snapshot dates: every trading day in historical_prices in range ────
    snap_dates_raw = (
        db.query(HistoricalPrice.price_date)
        .filter(
            HistoricalPrice.price_date >= snap_start,
            HistoricalPrice.price_date <= to_date,
        )
        .distinct()
        .order_by(HistoricalPrice.price_date)
        .all()
    )
    snap_dates = [r[0] for r in snap_dates_raw]
    if not snap_dates:
        logger.warning("No historical price dates found in range %s – %s", snap_start, to_date)
        return {"snapshots": 0, "accounts": len(accounts), "dates": 0}

    logger.info("Computing snapshots for %d accounts × %d dates (%s → %s)",
                len(accounts), len(snap_dates), snap_dates[0], snap_dates[-1])

    # ── 5. Walk transactions and build running positions ──────────────────────
    # positions[account_id][security_id] = net_quantity
    positions: dict[int, dict[int, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    # invested[account_id] = cumulative net cash deployed in CAD
    invested: dict[int, Decimal] = defaultdict(Decimal)
    # income[account_id] = cumulative income received in CAD (interest, dividends, option premiums)
    income: dict[int, Decimal] = defaultdict(Decimal)
    # Cash tracked in the account's BASE currency (mirrors get_cash_balances), then
    # converted to CAD at the snapshot-date FX rate. Summing cad_amount directly is
    # wrong for FX / Norbert's-Gambit flows — that field drifts from the true native
    # balance — so we track the native base-currency total and convert at the as-of rate.
    base_cash: dict[int, Decimal] = defaultdict(Decimal)
    # Foreign-currency cash held inside an account (e.g. a USD opening balance in a CAD
    # account): {acct_id: {ccy: native_amount}}.
    foreign_cash: dict[int, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    # Most recent transaction date per account, used to detect dormant/closed accounts.
    last_txn_date: dict[int, date] = {}
    # Group CAD+USD sub-accounts (same name minus " (USD)") so dormancy is judged at the
    # LOGICAL account level: an idle sub must NOT be zeroed if a sibling is still active
    # (e.g. the idle USD cash sub of an actively-traded TFSA, whose USD cash offsets the
    # CAD sub's negative cash from a Norbert's-Gambit conversion).
    _logical_groups: dict[str, list[int]] = defaultdict(list)
    for _aid, _a in accounts.items():
        _logical_groups[(_a.name or "").replace(" (USD)", "").strip()].append(_aid)
    account_siblings: dict[int, list[int]] = {
        _aid: _logical_groups[(_a.name or "").replace(" (USD)", "").strip()]
        for _aid, _a in accounts.items()
    }

    # Cached FX lookup (ccy → CAD at a given date), forward-fills via fx_service.
    from app.services.fx_service import get_rate as _get_rate
    _fx_cache: dict[tuple, Decimal] = {}

    def _fx_to_cad(ccy: str, d: date) -> Decimal:
        if not ccy or ccy.upper() == "CAD":
            return Decimal("1")
        k = (ccy.upper(), d)
        if k not in _fx_cache:
            _fx_cache[k] = _get_rate(db, d, ccy.upper(), "CAD") or ZERO
        return _fx_cache[k]

    txn_idx = 0
    n_txns = len(all_txns)

    # Pre-load existing snapshots for upsert efficiency
    existing_snaps: dict[tuple[date, int], PortfolioSnapshot] = {}
    existing_rows = (
        db.query(PortfolioSnapshot)
        .filter(
            PortfolioSnapshot.account_id.in_(accounts.keys()),
            PortfolioSnapshot.snapshot_date >= snap_start,
            PortfolioSnapshot.snapshot_date <= to_date,
        )
        .all()
    )
    for row in existing_rows:
        existing_snaps[(row.snapshot_date, row.account_id)] = row

    total_written = 0
    BATCH_SIZE = 500
    batch_count = 0

    cash_txn_idx = 0
    n_cash_txns = len(all_cash_txns)

    for snap_date in snap_dates:
        # ── Advance transaction cursor ────────────────────────────────────────
        while txn_idx < n_txns:
            txn = all_txns[txn_idx]
            txn_date = txn.transaction_date
            if isinstance(txn_date, datetime):
                txn_date = txn_date.date()
            if txn_date > snap_date:
                break
            txn_idx += 1

            t_type = txn.transaction_type
            qty = _d(txn.quantity)
            acct_id = txn.account_id
            sec_id = txn.security_id
            cad_amt = abs(_d(txn.cad_amount))

            # ── Position quantity ─────────────────────────────────────────────
            if t_type in _QTY_ADD:
                if qty > ZERO:
                    positions[acct_id][sec_id] += qty
            elif t_type in _QTY_SUB:
                # Use abs(qty): both normal SELLs (negative qty) and reversal/correction
                # SELLs (positive qty) reduce the position. Do NOT clamp to zero here — a
                # disposal recorded before its matching acquisition (common with same-day
                # or out-of-order trades) would otherwise "forget" the negative dip and
                # leave a phantom long position once the later BUY lands. Negative running
                # balances are skipped at valuation time instead (matches the ACB engine).
                positions[acct_id][sec_id] -= abs(qty)
            elif t_type == "OPTION_SELL":
                # Short option: negative quantity
                positions[acct_id][sec_id] -= abs(qty)
            elif t_type in _QTY_ZERO:
                positions[acct_id][sec_id] = ZERO
            elif t_type in _QTY_SET:
                positions[acct_id][sec_id] = abs(qty)
            elif t_type == "JOURNAL":
                # Quantity can be positive (inflow) or negative (outflow). No clamp here —
                # see the _QTY_SUB note; negative running balances are skipped at valuation.
                positions[acct_id][sec_id] += qty
            elif t_type == "OPTION_EXERCISE":
                # Long option exercised — removes the option position (goes to zero).
                # The underlying shares are handled via a separate BUY/SELL transaction.
                positions[acct_id][sec_id] = ZERO
            elif t_type == "SPLIT":
                # Some SPLIT rows add shares (+), some are adjustments (net delta). No clamp
                # here — see the _QTY_SUB note; negatives are skipped at valuation.
                positions[acct_id][sec_id] += qty

            # ── Invested capital ──────────────────────────────────────────────
            if t_type in _INVESTED_ADD and cad_amt > ZERO:
                invested[acct_id] += cad_amt
            elif t_type in _INVESTED_SUB and cad_amt > ZERO:
                invested[acct_id] -= cad_amt
            elif t_type in _INVESTED_FEE and cad_amt > ZERO:
                invested[acct_id] += cad_amt  # fees are a cost of investing

            # ── Income ───────────────────────────────────────────────────────
            if t_type in _INCOME_ADD and cad_amt > ZERO:
                income[acct_id] += cad_amt
            elif t_type in _INCOME_SUB and cad_amt > ZERO:
                income[acct_id] -= cad_amt

        # ── Advance cash cursor (separate: no security_id filter required) ─────
        while cash_txn_idx < n_cash_txns:
            ct = all_cash_txns[cash_txn_idx]
            ct_date = ct.transaction_date
            if isinstance(ct_date, datetime):
                ct_date = ct_date.date()
            if ct_date > snap_date:
                break
            cash_txn_idx += 1

            ct_type = ct.transaction_type
            ct_acct = ct.account_id
            # Track the most recent transaction per account (all types) to detect
            # dormant/closed accounts. Processed in date order, so this ends up as the
            # latest transaction on or before snap_date.
            last_txn_date[ct_acct] = ct_date
            if ct_type in _CASH_NEUTRAL:
                continue

            acct = accounts.get(ct_acct)
            base_ccy = (acct.base_currency or "CAD").upper() if acct else "CAD"

            # DRIP gating (mirrors get_cash_balances): include only iTrade-style DRIPs
            # (account_currency_amount < 0, or > 0 with no shares issued). SW reinvestment
            # DRIPs (amount > 0, qty > 0) and IBKR DRIPs (amount NULL) stay cash-neutral.
            if ct_type == "DRIP":
                aca = ct.account_currency_amount
                if not (aca is not None and (aca < 0 or (aca > 0 and (ct.quantity in (None, 0))))):
                    continue

            # CASH_OPENING uses the native transaction_currency/amount.
            if ct_type == "CASH_OPENING":
                ccy = (ct.transaction_currency or base_ccy).upper()
                amount = _d(ct.transaction_amount)
                if ccy == base_ccy:
                    base_cash[ct_acct] += amount
                else:
                    foreign_cash[ct_acct][ccy] += amount
                continue

            # Currency routing (mirrors get_cash_balances):
            #   same currency as account → transaction_amount is the reliable native figure
            #   cross-currency           → account_currency_amount (base ccy), else cad_amount
            tx_ccy = (ct.transaction_currency or base_ccy).upper()
            if tx_ccy == base_ccy:
                amount = ct.transaction_amount if ct.transaction_amount is not None else ct.account_currency_amount
            else:
                amount = ct.account_currency_amount if ct.account_currency_amount is not None else ct.cad_amount
            base_cash[ct_acct] += _d(amount)

        # ── Compute market value per account ──────────────────────────────────
        for acct_id in accounts:
            holdings = positions.get(acct_id, {})
            total_val = ZERO
            priced_val = ZERO
            unpriced_val = ZERO

            for sec_id, qty in holdings.items():
                # Skip flat positions.
                if qty == ZERO:
                    continue
                # A negative running balance is never a real holding — it's a disposal
                # recorded before its matching acquisition (e.g. same-day or out-of-order
                # trades) or a genuine over-disposal data error. Skip it (value $0), which
                # makes net-zero securities correctly worth nothing regardless of order.
                # (Short options are left at $0 here too, preserving prior behaviour.)
                if qty < ZERO:
                    continue
                price = _get_price(sec_id, snap_date)
                if price is not None:
                    multiplier = 100 if sec_id in option_sec_ids else 1
                    val = (qty * price * multiplier).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    total_val += val
                    priced_val += val
                # Unpriced positions: skip for now (they'll show as gaps)
                # Could fallback to manual/ACB but keep it clean

            priced_frac = float(priced_val / total_val) if total_val > ZERO else None

            # Upsert
            key = (snap_date, acct_id)
            snap = existing_snaps.get(key)
            if snap is None:
                snap = PortfolioSnapshot(snapshot_date=snap_date, account_id=acct_id)
                db.add(snap)
                existing_snaps[key] = snap
            snap.market_value_cad = total_val
            # Convert base-currency cash to CAD at the snapshot-date rate (matches the
            # dashboard), plus any foreign-currency cash held inside the account.
            _acct = accounts.get(acct_id)
            _base_ccy = (_acct.base_currency or "CAD").upper() if _acct else "CAD"
            cash_cad_val = base_cash.get(acct_id, ZERO) * _fx_to_cad(_base_ccy, snap_date)
            for _fccy, _famt in foreign_cash.get(acct_id, {}).items():
                if _famt != ZERO:
                    cash_cad_val += _famt * _fx_to_cad(_fccy, snap_date)
            # Dormant/closed account: no positions AND no transactions for >12 months —
            # judged across the LOGICAL account (all CAD/USD siblings) so an idle sub isn't
            # zeroed while a sibling is active. Any leftover cash on a truly closed account is
            # an FX / Norbert's-Gambit spread residual, not real money (e.g. a closed RRSP
            # whose CAD/USD legs net to a small non-zero figure). Zero it.
            _sibs = account_siblings.get(acct_id, [acct_id])
            _ltx = max((last_txn_date[s] for s in _sibs if s in last_txn_date), default=None)
            if total_val == ZERO and _ltx is not None:
                _days_idle = (snap_date - _ltx).days
                # Negative reconstructed cash on a holding-less account is always an
                # artifact: a non-margin cash account can't owe money with no positions,
                # so it's reconstruction drift on a closed / transferred-out account (e.g.
                # an iTrade RRSP fully journaled to Scotia Wealth, whose cash sweep leaves
                # the rebuilt balance off zero). Clear it after a short idle window so it
                # doesn't drag the line for a year. Positive residuals (FX / Norbert's-
                # Gambit spreads) keep the conservative 365-day window. Dormancy is judged
                # across the LOGICAL account (siblings), so an idle sub paired with an
                # active sibling is never zeroed.
                if (cash_cad_val < ZERO and _days_idle > 30) or _days_idle > 365:
                    cash_cad_val = ZERO
            snap.cash_balance_cad = cash_cad_val.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            snap.invested_cad = invested.get(acct_id, ZERO)
            snap.income_cad = income.get(acct_id, ZERO)
            snap.priced_fraction = priced_frac
            total_written += 1

        batch_count += 1
        if batch_count >= BATCH_SIZE:
            db.flush()
            batch_count = 0

    db.commit()
    logger.info("Snapshot computation complete: %d rows written", total_written)
    return {
        "snapshots": total_written,
        "accounts": len(accounts),
        "dates": len(snap_dates),
        "date_range": f"{snap_dates[0]} → {snap_dates[-1]}" if snap_dates else "—",
    }
