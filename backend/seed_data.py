"""
Seed script: populates brokerages, accounts, currencies, and type mappings.
Run from backend/ directory: python seed_data.py
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from app.database import engine, Base, SessionLocal
import app.models.master  # noqa
import app.models.transactions  # noqa
import app.models.options  # noqa
import app.models.imports  # noqa
import app.models.prices  # noqa — must be imported before querying Security (relationship to MarketPrice)
from app.models.master import Brokerage, Account, Currency, BrokerageTypeMapping

def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    try:
        # ── Currencies ──────────────────────────────────────────────────────
        for code, name in [("CAD", "Canadian Dollar"), ("USD", "US Dollar")]:
            if not db.query(Currency).filter_by(code=code).first():
                db.add(Currency(code=code, name=name))

        db.flush()

        # ── Brokerages ──────────────────────────────────────────────────────
        itrade_b = db.query(Brokerage).filter_by(code="ITRADE").first()
        if not itrade_b:
            itrade_b = Brokerage(name="Scotia iTrade", code="ITRADE")
            db.add(itrade_b)

        ibkr_b = db.query(Brokerage).filter_by(code="IBKR").first()
        if not ibkr_b:
            ibkr_b = Brokerage(name="Interactive Brokers", code="IBKR")
            db.add(ibkr_b)

        db.flush()

        # ── iTrade Accounts ──────────────────────────────────────────────────
        itrade_accounts = [
            ("Brian RRSP CAD", "RRSP", "CAD", "Brian"),
            ("Brian RRSP USD", "RRSP", "USD", "Brian"),
            ("Brian TFSA CAD", "TFSA", "CAD", "Brian"),
            ("Brian TFSA USD", "TFSA", "USD", "Brian"),
            ("Michelle RRSP CAD", "RRSP", "CAD", "Michelle"),
            ("Michelle RRSP USD", "RRSP", "USD", "Michelle"),
            ("Michelle TFSA CAD", "TFSA", "CAD", "Michelle"),
            ("Michelle TFSA USD", "TFSA", "USD", "Michelle"),
            ("Non-Registered CAD", "NON_REG", "CAD", "Brian"),
            ("Non-Registered USD", "NON_REG", "USD", "Brian"),
        ]
        for name, acct_type, ccy, owner in itrade_accounts:
            if not db.query(Account).filter_by(brokerage_id=itrade_b.id, name=name).first():
                db.add(Account(
                    brokerage_id=itrade_b.id,
                    name=name,
                    account_type=acct_type,
                    base_currency=ccy,
                    owner=owner,
                ))

        # ── IBKR Accounts ────────────────────────────────────────────────────
        ibkr_accounts = [
            ("Brian TFSA", "TFSA", "CAD", "Brian"),
            ("Brian RRSP", "RRSP", "CAD", "Brian"),
            ("Michelle TFSA", "TFSA", "CAD", "Michelle"),
            ("Michelle RRSP", "RRSP", "CAD", "Michelle"),
            ("Non-Registered", "NON_REG", "CAD", "Brian"),
        ]
        for name, acct_type, ccy, owner in ibkr_accounts:
            if not db.query(Account).filter_by(brokerage_id=ibkr_b.id, name=name).first():
                db.add(Account(
                    brokerage_id=ibkr_b.id,
                    name=name,
                    account_type=acct_type,
                    base_currency=ccy,
                    owner=owner,
                ))

        db.flush()

        # ── iTrade Type Mappings ─────────────────────────────────────────────
        itrade_mappings = [
            ("BUY", "BUY"),
            ("SELL", "SELL"),
            ("Stock dividend", "DIVIDEND"),
            ("DRIP", "DRIP"),
            ("Expired", "OPTION_EXPIRY"),
            ("Assigned", "OPTION_ASSIGNMENT"),
            ("Reverse", "REVERSE_SPLIT"),
            ("Exchange adjustment", "SPLIT"),
            ("Transfer", "JOURNAL"),
            ("Redeemed", "SELL"),
            ("Fee", "FEE"),
            ("Return of Capital", "RETURN_OF_CAPITAL"),
            ("Interest", "INTEREST"),
            ("Withholding Tax", "WITHHOLDING_TAX"),
        ]
        for raw, canonical in itrade_mappings:
            if not db.query(BrokerageTypeMapping).filter_by(
                brokerage_id=itrade_b.id, raw_type=raw
            ).first():
                db.add(BrokerageTypeMapping(
                    brokerage_id=itrade_b.id,
                    raw_type=raw,
                    canonical_type=canonical,
                ))

        # ── IBKR Type Mappings ───────────────────────────────────────────────
        ibkr_mappings = [
            ("Buy", "BUY"),
            ("Sell", "SELL"),
            ("Dividend", "DIVIDEND"),
            ("Expired", "OPTION_EXPIRY"),
            ("Assigned", "OPTION_ASSIGNMENT"),
            ("Forex Trade Component", "FX_ADJUSTMENT"),
            ("Deposit", "DEPOSIT"),
            ("Credit Interest", "INTEREST"),
            ("Other Fee", "FEE"),
            ("Sales Tax", "FEE"),
            ("Adjustment", "ADJUSTMENT"),
            ("Exercise", "OPTION_EXERCISE"),
            ("Withdrawal", "WITHDRAWAL"),
            ("Withholding Tax", "WITHHOLDING_TAX"),
        ]
        for raw, canonical in ibkr_mappings:
            if not db.query(BrokerageTypeMapping).filter_by(
                brokerage_id=ibkr_b.id, raw_type=raw
            ).first():
                db.add(BrokerageTypeMapping(
                    brokerage_id=ibkr_b.id,
                    raw_type=raw,
                    canonical_type=canonical,
                ))

        db.commit()
        print("✓ Seed data inserted successfully")
        print(f"  Brokerages: {db.query(Brokerage).count()}")
        print(f"  Accounts:   {db.query(Account).count()}")
        print(f"  Currencies: {db.query(Currency).count()}")
        print(f"  Mappings:   {db.query(BrokerageTypeMapping).count()}")

    finally:
        db.close()


if __name__ == "__main__":
    seed()
