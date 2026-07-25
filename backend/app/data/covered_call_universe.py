"""
Candidate universe for the Covered Call Portfolio Builder.

A curated subset of `screener_universe.py`'s SP500/TSX60 lists, narrowed to names that
are actually good covered-call candidates: liquid enough for tight option spreads, listed
with active options chains, and (mostly) dividend payers so the strategy stacks option
premium on top of a yield floor rather than relying on premium alone. Not every SP500/TSX60
name qualifies — many are non-dividend growth names or have thin options markets.

Same flat-list convention as screener_universe.py (plain ticker strings, no per-ticker
dict) — extend it the same way if a name is missing.
"""

# ─── US candidates (large-cap, optionable, dividend-paying) ───────────────────
US_CANDIDATES = [
    "AAPL", "MSFT", "JNJ", "PG", "KO", "PEP", "XOM", "CVX", "JPM", "BAC",
    "WFC", "HD", "MCD", "V", "MA", "UNH", "ABBV", "PFE", "MRK", "T",
    "VZ", "IBM", "CSCO", "INTC", "TXN", "QCOM", "AVGO", "MMM", "CAT", "HON",
    "GE", "BA", "UPS", "LMT", "RTX", "GD", "SO", "DUK", "NEE", "D",
    "O", "MO", "PM", "CL", "KMB", "GIS", "K", "SYY", "WMT", "TGT",
    "COST", "LOW", "SBUX", "NKE", "DIS", "CMCSA", "ABT", "BMY", "AMGN", "GILD",
    "SCHW", "BLK", "SPG", "PLD", "AMT", "CCI", "PSA", "EPD", "ET", "MPLX",
    "XLE", "XLF", "XLU", "XLP", "SPY", "QQQ", "IWM",
]

# ─── Canadian candidates (TSX large-cap, optionable, dividend-paying) ─────────
# Explicit .TO suffix (not the bare-ticker convention TSX60 uses in screener_universe.py) —
# covered_call_service._scan_ticker_live detects Canadian names via ticker.endswith(".TO"),
# and yfinance itself needs the suffix to disambiguate from a same-letter US ticker (e.g.
# bare "T" resolves to AT&T on NYSE, not Telus — TSX Telus is "T.TO").
CA_CANDIDATES = [
    "RY.TO", "TD.TO", "BNS.TO", "BMO.TO", "CM.TO", "NA.TO", "MFC.TO", "SLF.TO", "GWO.TO", "IFC.TO",
    "ENB.TO", "TRP.TO", "PPL.TO", "CNQ.TO", "SU.TO", "IMO.TO", "CVE.TO",
    "BCE.TO", "T.TO", "RCI-B.TO", "QBR-B.TO",
    "FTS.TO", "EMA.TO", "AQN.TO", "CU.TO",
    "CTC-A.TO", "L.TO", "MRU.TO", "ATD.TO",
    "BAM.TO", "BN.TO", "POW.TO", "GWL.TO",
]
