"""
ACB (Adjusted Cost Base) calculation engine.
Uses the Canadian pool method (not FIFO/LIFO).

Short option positions (written calls/puts) are tracked with negative quantity.
When an option is written (OPTION_SELL), the position goes negative.
When bought back (OPTION_BUY), the short is closed and realized gain is recorded.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
import logging
from sqlalchemy.orm import Session
from app.models.transactions import Transaction
from app.models.master import Security

logger = logging.getLogger(__name__)

ZERO = Decimal("0")


class ACBLot:
    def __init__(self):
        self.quantity: Decimal = ZERO
        self.total_acb: Decimal = ZERO  # Total ACB in CAD

    @property
    def acb_per_share(self) -> Decimal:
        if self.quantity == ZERO:
            return ZERO
        return self.total_acb / self.quantity

    def buy(self, quantity: Decimal, cost_cad: Decimal):
        self.quantity += quantity
        self.total_acb += cost_cad

    def sell(self, quantity: Decimal) -> tuple[Decimal, Decimal]:
        """Sell from a long position. Returns (acb_of_sold, acb_per_share). Guards against going negative."""
        sell_qty = abs(quantity)
        if self.quantity <= ZERO:
            return ZERO, ZERO
        acb_per = self.acb_per_share
        acb_of_sold = acb_per * sell_qty
        self.quantity -= sell_qty
        self.total_acb -= acb_of_sold
        if self.quantity < ZERO:
            self.quantity = ZERO
            self.total_acb = ZERO
        return acb_of_sold, acb_per

    def adjust_for_split(self, ratio: Decimal):
        """Adjust quantity for a stock split. ratio = new_shares / old_shares."""
        self.quantity *= ratio
        # ACB per share adjusts automatically; total_acb stays the same

    def adjust_for_return_of_capital(self, amount_cad: Decimal):
        self.total_acb = max(ZERO, self.total_acb - amount_cad)


def calculate_acb_for_security(
    db: Session,
    security_id: int,
    account_id: int,
    as_of: Optional[date] = None,
    _txns: Optional[list] = None,      # pre-loaded sorted transactions for this (sec, acct)
    _txn_pool: Optional[dict] = None,  # full {(sec_id, acct_id): [txns]} for split lookups
) -> dict:
    """
    Calculate the ACB for a given security in a given account.
    Returns dict with quantity, total_acb, acb_per_share, realized_gains.

    Supports short option positions (written calls/puts):
      - OPTION_SELL when flat/short → opens/adds to short position (negative quantity)
      - OPTION_BUY when short → buys to close (realizes gain/loss)
      - OPTION_EXPIRY when short → option expired worthless (profit = premium received)
      - OPTION_ASSIGNMENT when short → assigned (profit = premium received)
    """
    if _txns is not None:
        transactions = _txns
    else:
        query = db.query(Transaction).filter(
            Transaction.security_id == security_id,
            Transaction.account_id == account_id,
        ).order_by(Transaction.transaction_date, Transaction.id)
        if as_of:
            query = query.filter(Transaction.transaction_date <= as_of)
        transactions = query.all()

    lot = ACBLot()
    realized_gains: list[dict] = []

    for txn in transactions:
        _apply_txn(lot, txn, db, security_id, realized_gains, _txn_pool)

    return {
        "security_id": security_id,
        "account_id": account_id,
        "quantity": lot.quantity,
        "total_acb_cad": lot.total_acb,
        "acb_per_share_cad": lot.acb_per_share,
        "realized_gains": realized_gains,
    }


def _apply_txn(lot: "ACBLot", txn, db, security_id, realized_gains: list, _txn_pool):
    """Apply ONE transaction to the running ACB lot, appending any realized gains.

    This is the single source of truth for how each transaction type moves quantity and
    cost basis. Both calculate_acb_for_security() (final state) and position_acb_timeline()
    (per-date series, used by the snapshot service) drive off it, so the Performance chart
    and Holdings can never diverge on position quantities."""
    t_type = txn.transaction_type
    qty = txn.quantity or ZERO
    cad_amount = txn.cad_amount or ZERO

    if True:
        # ── Regular buy / opening balance ──────────────────────────────────────
        if t_type in ("BUY", "OPENING_BALANCE"):
            cost = abs(cad_amount)
            if qty > ZERO:
                lot.buy(qty, cost)

        # ── Option buy: open long OR buy-to-close a short ──────────────────────
        elif t_type == "OPTION_BUY":
            cost = abs(cad_amount)
            if qty > ZERO:
                if lot.quantity < ZERO:
                    # Buying back written options (buy-to-close)
                    close_qty = min(qty, abs(lot.quantity))
                    weight = close_qty / abs(lot.quantity)
                    premium_for_close = abs(lot.total_acb) * weight  # portion of premium received
                    cost_for_close = cost * (close_qty / qty) if qty > ZERO else ZERO
                    gain = premium_for_close - cost_for_close
                    realized_gains.append({
                        "date": txn.transaction_date,
                        "quantity": close_qty,
                        "proceeds_cad": premium_for_close,
                        "acb_cad": cost_for_close,
                        "gain_cad": gain,
                        "transaction_id": txn.id,
                    })
                    lot.quantity += close_qty   # move toward zero
                    lot.total_acb += premium_for_close  # move toward zero
                    if lot.quantity >= ZERO:
                        lot.quantity = ZERO
                        lot.total_acb = ZERO
                    # Any remaining qty after closing the short opens a new long
                    remaining_qty = qty - close_qty
                    if remaining_qty > ZERO:
                        remaining_cost = cost - cost_for_close
                        lot.buy(remaining_qty, remaining_cost)
                else:
                    # Opening or adding to a long option position
                    lot.buy(qty, cost)

        # ── Regular sell (stocks/ETFs) ─────────────────────────────────────────
        elif t_type == "SELL":
            if qty != ZERO:
                sell_qty = abs(qty)
                acb_of_sold, acb_per = lot.sell(sell_qty)
                proceeds = abs(cad_amount)
                gain = proceeds - acb_of_sold
                realized_gains.append({
                    "date": txn.transaction_date,
                    "quantity": sell_qty,
                    "proceeds_cad": proceeds,
                    "acb_cad": acb_of_sold,
                    "gain_cad": gain,
                    "transaction_id": txn.id,
                })

        # ── Option sell: close long OR write/short an option ──────────────────
        elif t_type == "OPTION_SELL":
            if qty != ZERO:
                sell_qty = abs(qty)
                if lot.quantity > ZERO:
                    # Selling a long option position (closing a long)
                    acb_of_sold, acb_per = lot.sell(sell_qty)
                    proceeds = abs(cad_amount)
                    gain = proceeds - acb_of_sold
                    realized_gains.append({
                        "date": txn.transaction_date,
                        "quantity": sell_qty,
                        "proceeds_cad": proceeds,
                        "acb_cad": acb_of_sold,
                        "gain_cad": gain,
                        "transaction_id": txn.id,
                    })
                else:
                    # Writing/shorting options (flat or adding to existing short)
                    premium = abs(cad_amount)
                    lot.quantity -= sell_qty   # goes negative
                    lot.total_acb -= premium   # negative = money received (owed back if closed)

        # ── Option expiry ──────────────────────────────────────────────────────
        elif t_type == "OPTION_EXPIRY":
            if lot.quantity > ZERO:
                # Long option expired worthless: loss = premium paid
                expire_qty = min(abs(qty) if qty != ZERO else lot.quantity, lot.quantity)
                weight = expire_qty / lot.quantity if lot.quantity > ZERO else ZERO
                cost_of_expired = lot.total_acb * weight
                realized_gains.append({
                    "date": txn.transaction_date,
                    "quantity": expire_qty,
                    "proceeds_cad": ZERO,
                    "acb_cad": cost_of_expired,
                    "gain_cad": -cost_of_expired,
                    "transaction_id": txn.id,
                })
                lot.quantity -= expire_qty
                lot.total_acb -= cost_of_expired
                if lot.quantity <= ZERO:
                    lot.quantity = ZERO
                    lot.total_acb = ZERO

            elif lot.quantity < ZERO:
                # Short option expired worthless: profit = entire premium received
                expire_qty = min(abs(qty) if qty != ZERO else abs(lot.quantity), abs(lot.quantity))
                weight = expire_qty / abs(lot.quantity) if lot.quantity < ZERO else ZERO
                premium_received = abs(lot.total_acb) * weight
                realized_gains.append({
                    "date": txn.transaction_date,
                    "quantity": expire_qty,
                    "proceeds_cad": premium_received,
                    "acb_cad": ZERO,
                    "gain_cad": premium_received,
                    "transaction_id": txn.id,
                })
                lot.quantity += expire_qty   # move toward zero
                lot.total_acb += premium_received  # move toward zero
                if lot.quantity >= ZERO:
                    lot.quantity = ZERO
                    lot.total_acb = ZERO
            # else: qty == 0, nothing to expire

        # ── Option assignment / exercise ──────────────────────────────────────
        elif t_type in ("OPTION_ASSIGNMENT", "OPTION_EXERCISE"):
            # Assignment/exercise closes the option position.
            # The underlying stock impact is in separate SELL/BUY transactions.
            assign_qty = abs(qty) if qty != ZERO else abs(lot.quantity)
            if lot.quantity < ZERO:
                # Short option being assigned: close short, realize the premium as gain
                close_qty = min(assign_qty, abs(lot.quantity))
                weight = close_qty / abs(lot.quantity) if lot.quantity < ZERO else ZERO
                premium_received = abs(lot.total_acb) * weight
                realized_gains.append({
                    "date": txn.transaction_date,
                    "quantity": close_qty,
                    "proceeds_cad": premium_received,
                    "acb_cad": ZERO,
                    "gain_cad": premium_received,
                    "transaction_id": txn.id,
                })
                lot.quantity += close_qty
                lot.total_acb += premium_received
                if lot.quantity >= ZERO:
                    lot.quantity = ZERO
                    lot.total_acb = ZERO

            elif lot.quantity > ZERO:
                # Long option exercised: close long position
                # (option cost should be folded into underlying stock ACB)
                close_qty = min(assign_qty, lot.quantity)
                weight = close_qty / lot.quantity if lot.quantity > ZERO else ZERO
                cost_of_exercised = lot.total_acb * weight
                lot.quantity -= close_qty
                lot.total_acb -= cost_of_exercised
                if lot.quantity <= ZERO:
                    lot.quantity = ZERO
                    lot.total_acb = ZERO

        # ── Dividend ───────────────────────────────────────────────────────────
        elif t_type == "DIVIDEND":
            pass  # Dividends don't affect ACB

        # ── DRIP ───────────────────────────────────────────────────────────────
        elif t_type == "DRIP":
            cost = abs(cad_amount)
            if qty > ZERO:
                lot.buy(qty, cost)

        # ── Transfer in (receives shares from another account) ─────────────────
        elif t_type == "TRANSFER_IN":
            cost = abs(cad_amount)
            if qty > ZERO:
                lot.buy(qty, cost)

        # ── Transfer out (sends shares to another account) ─────────────────────
        elif t_type == "TRANSFER_OUT":
            if qty != ZERO:
                sell_qty = abs(qty)
                acb_of_sold, acb_per = lot.sell(sell_qty)
                proceeds = abs(cad_amount)
                gain = proceeds - acb_of_sold
                realized_gains.append({
                    "date": txn.transaction_date,
                    "quantity": sell_qty,
                    "proceeds_cad": proceeds,
                    "acb_cad": acb_of_sold,
                    "gain_cad": gain,
                    "transaction_id": txn.id,
                })

        # ── Stock split / reverse split ────────────────────────────────────────
        elif t_type in ("SPLIT", "REVERSE_SPLIT"):
            if qty > ZERO:
                if lot.quantity > ZERO:
                    # Same-security split (iTrade two-row format):
                    # qty = TOTAL new shares; compute ratio and adjust.
                    ratio = qty / lot.quantity
                    lot.adjust_for_split(ratio)
                elif lot.quantity == ZERO:
                    # Cross-security reorganization (e.g. option split changing the strike).
                    # This security is the NEW replacement; inherit ACB from the retiring
                    # security which recorded a SPLIT with negative qty on the same date/account.
                    from datetime import timedelta
                    old_txn = db.query(Transaction).filter(
                        Transaction.account_id == txn.account_id,
                        Transaction.transaction_date == txn.transaction_date,
                        Transaction.transaction_type.in_(["SPLIT", "REVERSE_SPLIT"]),
                        Transaction.quantity < 0,
                        Transaction.security_id != security_id,
                    ).first()
                    lot.quantity = qty
                    if old_txn:
                        cutoff = txn.transaction_date - timedelta(days=1)
                        if _txn_pool is not None:
                            old_txns = [
                                t for t in _txn_pool.get((old_txn.security_id, txn.account_id), [])
                                if t.transaction_date <= cutoff
                            ]
                            old_result = calculate_acb_for_security(
                                db, old_txn.security_id, txn.account_id, cutoff,
                                _txns=old_txns, _txn_pool=_txn_pool,
                            )
                        else:
                            old_result = calculate_acb_for_security(
                                db, old_txn.security_id, txn.account_id, cutoff,
                            )
                        lot.total_acb = old_result["total_acb_cad"]
            elif qty < ZERO and lot.quantity > ZERO:
                # This security is being retired by a cross-security reorganization.
                # Close without realizing a gain (ACB transfers to the replacement security).
                lot.quantity = ZERO
                lot.total_acb = ZERO

        # ── Forward split (Scotia Wealth single-row format) ────────────────────
        elif t_type == "FORWARD_SPLIT":
            # Scotia Wealth "Exchange adjustment" emits ONE row with qty =
            # the NUMBER OF NEW SHARES ADDED (delta, not total).
            # e.g. 3-for-2 split on 50 shares → qty = 25 → new total = 75.
            # Simply add the shares; ACB per share adjusts automatically.
            if qty > ZERO:
                lot.quantity += qty

        # ── Journal / internal transfer ────────────────────────────────────────
        # iTrade uses JOURNAL to move securities between CAD and USD sub-ledgers.
        # Both legs share the same account_id; after the Currency Split tool runs,
        # the USD leg (positive qty) lives in the USD sub-account and the CAD leg
        # (negative qty) stays in the CAD account.
        #
        # Negative qty → shares leave this account (no realized gain — it's an
        # internal reorganisation, not a sale).
        # Positive qty → shares enter this account.  ACB comes from cad_amount
        # when non-zero; otherwise we try to parse the book value embedded in
        # raw_description (e.g. "BOOK VALUE $42;107.45" where ";" is a
        # thousands-separator in some iTrade exports).
        elif t_type == "JOURNAL":
            if qty < ZERO:
                # Remove shares without recording a gain (pure transfer out)
                sell_qty = abs(qty)
                if lot.quantity > ZERO:
                    acb_of_moved, _ = lot.sell(sell_qty)
                    # No realized gain entry — ACB just leaves the lot
            elif qty > ZERO:
                # Add shares.  ACB cost basis priority:
                #  1. cad_amount set explicitly on the transaction (user-entered
                #     book value, or set by create_transfer_pair endpoint)
                #  2. "BOOK VALUE $..." embedded in raw_description (some iTrade
                #     exports include this; ";" is their thousands separator)
                # If neither is present the shares are added at zero cost — the
                # user should edit the JOURNAL IN transaction and enter the
                # book value in the transaction currency + CAD equivalent.
                cost = abs(cad_amount)
                if cost == ZERO and txn.raw_description:
                    import re as _re
                    m = _re.search(r'BOOK VALUE\s*\$\s*([0-9;,]+(?:\.[0-9]+)?)', txn.raw_description, _re.IGNORECASE)
                    if m:
                        raw_val = m.group(1).replace(';', '').replace(',', '')
                        try:
                            cost = Decimal(raw_val)
                        except Exception:
                            cost = ZERO
                lot.buy(qty, cost)

        # ── Return of capital ──────────────────────────────────────────────────
        elif t_type == "RETURN_OF_CAPITAL":
            lot.adjust_for_return_of_capital(abs(cad_amount))


def position_acb_timeline(
    db: Session,
    security_id: int,
    account_id: int,
    _txns: Optional[list] = None,
    _txn_pool: Optional[dict] = None,
    as_of: Optional[date] = None,
) -> list[tuple]:
    """Return the running (date, quantity, total_acb_cad) after each transaction for one
    (security, account), collapsed to the LAST state on each date. Drives off the same
    _apply_txn() core as calculate_acb_for_security, so the snapshot engine's quantities
    are identical to Holdings/ACB. The caller carry-forwards: the position on any snapshot
    date is the last entry with date <= that snapshot."""
    if _txns is not None:
        transactions = _txns
    else:
        query = db.query(Transaction).filter(
            Transaction.security_id == security_id,
            Transaction.account_id == account_id,
        ).order_by(Transaction.transaction_date, Transaction.id)
        if as_of:
            query = query.filter(Transaction.transaction_date <= as_of)
        transactions = query.all()

    lot = ACBLot()
    realized_gains: list[dict] = []
    timeline: list[tuple] = []
    for txn in transactions:
        _apply_txn(lot, txn, db, security_id, realized_gains, _txn_pool)
        d = txn.transaction_date
        if hasattr(d, "date") and not isinstance(d, date):
            d = d.date()
        if timeline and timeline[-1][0] == d:
            timeline[-1] = (d, lot.quantity, lot.total_acb)
        else:
            timeline.append((d, lot.quantity, lot.total_acb))
    return timeline


def check_superficial_loss(
    db: Session,
    security_id: int,
    account_id: int,
    sell_date: date,
    realized_loss: Decimal,
) -> Optional[dict]:
    """
    Check if a sale is a superficial loss (bought within 30 days before/after).
    Returns superficial loss info if applicable.
    """
    if realized_loss >= ZERO:
        return None  # Not a loss

    window_start = sell_date - timedelta(days=30)
    window_end = sell_date + timedelta(days=30)

    # Check for buys within the window
    buys = db.query(Transaction).filter(
        Transaction.security_id == security_id,
        Transaction.account_id == account_id,
        Transaction.transaction_type.in_(["BUY", "DRIP"]),
        Transaction.transaction_date >= window_start,
        Transaction.transaction_date <= window_end,
        Transaction.transaction_date != sell_date,
    ).all()

    if buys:
        return {
            "is_superficial": True,
            "sell_date": sell_date,
            "disallowed_loss": abs(realized_loss),
            "related_buys": [b.id for b in buys],
        }
    return None


def get_all_positions_acb(
    db: Session,
    account_id: Optional[int] = None,
    as_of: Optional[date] = None,
) -> list[dict]:
    """
    Calculate ACB for all securities in all accounts (or one account).
    Includes both long positions (positive quantity) and short option positions
    (negative quantity).
    """
    from collections import defaultdict

    # Load all relevant transactions in a single query, then process in memory.
    txn_query = db.query(Transaction).filter(Transaction.security_id.isnot(None))
    if account_id:
        txn_query = txn_query.filter(Transaction.account_id == account_id)
    if as_of:
        txn_query = txn_query.filter(Transaction.transaction_date <= as_of)
    all_txns = txn_query.order_by(Transaction.transaction_date, Transaction.id).all()

    txn_pool: dict = defaultdict(list)
    pairs: set = set()
    for t in all_txns:
        key = (t.security_id, t.account_id)
        txn_pool[key].append(t)
        pairs.add(key)

    # Batch-load Security records for ticker / asset_class annotation.
    all_sec_ids = {sid for sid, _ in pairs}
    sec_map = (
        {s.id: s for s in db.query(Security).filter(Security.id.in_(all_sec_ids)).all()}
        if all_sec_ids else {}
    )

    results = []
    for security_id, acct_id in pairs:
        acb = calculate_acb_for_security(
            db, security_id, acct_id, as_of,
            _txns=txn_pool[(security_id, acct_id)],
            _txn_pool=txn_pool,
        )
        if acb["quantity"] != ZERO or acb["realized_gains"]:
            sec = sec_map.get(security_id)
            acb["ticker"] = sec.ticker if sec else "UNKNOWN"
            acb["asset_class"] = sec.asset_class if sec else "EQUITY"
            results.append(acb)

    return results
