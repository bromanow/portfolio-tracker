"""
Static snapshot of the stock universe available to the Fundamental Screener.

This is a curated list, not a live feed of index membership — S&P 500 and TSX 60
constituents change over time (additions/removals/spinoffs), so this will drift from the
real index composition. Re-run POST /api/screener/seed-universe after editing this file to
add any new tickers (existing ones are left untouched; nothing is ever removed
automatically, since a security dropped from an index may still be a real portfolio holding
that shouldn't lose its data).

Each entry is (ticker, exchange, currency). US listings use exchange="NASDAQ"/"NYSE";
Canadian (TSX) listings use exchange="TSX", currency="CAD".
"""

# ─── S&P 500 (large/liquid-cap US equities, USD) ──────────────────────────────
SP500 = [
    # Technology
    "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "META", "AVGO", "ORCL", "CRM", "ADBE",
    "CSCO", "ACN", "AMD", "INTU", "IBM", "TXN", "QCOM", "NOW", "AMAT", "PANW",
    "MU", "ADI", "LRCX", "KLAC", "SNPS", "CDNS", "ANSS", "FTNT", "MSI", "ROP",
    "APH", "TEL", "GLW", "HPQ", "HPE", "NTAP", "STX", "WDC", "JNPR", "KEYS",
    "GEN", "AKAM", "EPAM", "TDY", "TYL", "FFIV", "ZBRA", "ON", "SWKS", "TER",
    "ENPH", "SEDG", "PTC", "CDW", "GDDY", "NXPI",
    # Communication Services
    "NFLX", "DIS", "CMCSA", "TMUS", "VZ", "T", "CHTR", "EA", "TTWO", "WBD",
    "OMC", "IPG", "LYV", "NWSA", "FOXA", "PARA",
    # Consumer Discretionary
    "AMZN", "TSLA", "HD", "MCD", "NKE", "LOW", "SBUX", "TJX", "BKNG", "CMG",
    "ORLY", "MAR", "GM", "F", "ROST", "YUM", "AZO", "HLT", "DHI", "LEN",
    "NVR", "PHM", "EBAY", "ETSY", "RCL", "CCL", "NCLH", "EXPE", "LVS", "MGM",
    "WYNN", "DPZ", "ULTA", "TSCO", "APTV", "BBY", "GPC", "KMX", "POOL", "DECK",
    # Consumer Staples
    "PG", "KO", "PEP", "COST", "WMT", "PM", "MO", "MDLZ", "CL", "KMB",
    "GIS", "STZ", "SYY", "KHC", "HSY", "MKC", "CLX", "K", "CHD", "TAP",
    "CAG", "CPB", "TSN", "ADM", "KR", "TGT", "DG", "DLTR", "EL", "KDP",
    "MNST", "BF-B",
    # Healthcare
    "UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "DHR", "BMY",
    "AMGN", "MDT", "ISRG", "SYK", "GILD", "VRTX", "CVS", "CI", "ELV", "HCA",
    "REGN", "ZTS", "BSX", "BDX", "EW", "IDXX", "A", "IQV", "MRNA", "HUM",
    "MCK", "COR", "CAH", "DXCM", "RMD", "ALGN", "BIIB", "WAT", "MTD", "STE",
    "ZBH", "HOLX", "TECH", "COO", "PODD", "DVA", "CNC", "MOH", "UHS", "VTRS",
    # Financials
    "BRK-B", "JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "AXP", "SPGI",
    "BLK", "C", "SCHW", "CB", "PGR", "MMC", "AON", "USB", "PNC", "TFC",
    "COF", "AIG", "MET", "PRU", "TRV", "ALL", "AFL", "BK", "STT", "FITB",
    "MCO", "ICE", "CME", "NDAQ", "AJG", "WTW", "HIG", "RJF", "DFS", "SYF",
    "MTB", "HBAN", "RF", "CFG", "KEY", "NTRS", "PFG", "GL", "CINF", "L",
    "BRO", "FDS", "MKTX", "IVZ", "BEN", "AMP",
    # Industrials
    "CAT", "UNP", "HON", "RTX", "BA", "GE", "LMT", "UPS", "DE", "ADP",
    "GD", "NOC", "ETN", "ITW", "CSX", "NSC", "WM", "EMR", "FDX", "PH",
    "CARR", "PCAR", "TT", "CMI", "ROK", "OTIS", "JCI", "AME", "DOV", "XYL",
    "IR", "FAST", "PAYX", "VRSK", "CTAS", "URI", "GWW", "SNA", "SWK", "PWR",
    "EFX", "RSG", "WAB", "ODFL", "JBHT", "CHRW", "EXPD", "MAS", "ALLE", "PNR",
    "HII", "TXT", "LDOS", "LHX", "BAX",
    # Energy
    "XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "VLO", "OXY", "WMB",
    "KMI", "OKE", "HES", "BKR", "HAL", "FANG", "DVN", "CTRA", "MRO", "TRGP",
    "EQT", "APA",
    # Utilities
    "NEE", "SO", "DUK", "AEP", "SRE", "D", "EXC", "XEL", "ED", "PCG",
    "WEC", "EIX", "AWK", "PEG", "ES", "DTE", "FE", "AEE", "CMS", "CNP",
    "ATO", "NI", "LNT", "EVRG", "PNW",
    # Materials
    "LIN", "SHW", "APD", "ECL", "FCX", "NEM", "NUE", "DOW", "DD", "PPG",
    "VMC", "MLM", "CTVA", "ALB", "IFF", "LYB", "STLD", "AVY", "PKG", "IP",
    "CF", "MOS", "FMC", "EMN", "BALL", "AMCR",
    # Real Estate
    "PLD", "AMT", "EQIX", "PSA", "O", "SPG", "WELL", "DLR", "CCI", "VICI",
    "AVB", "EQR", "SBAC", "EXR", "MAA", "INVH", "ESS", "UDR", "ARE", "VTR",
    "IRM", "KIM", "HST", "REG", "BXP", "CPT", "FRT",
]

# ─── TSX 60 (large-cap Canadian equities, CAD) ─────────────────────────────────
TSX60 = [
    "RY", "TD", "ENB", "CNQ", "CP", "BN", "BMO", "TRP", "BNS", "SU",
    "CNR", "SHOP", "MFC", "CM", "SLF", "ATD", "WCN", "FTS", "GIB-A", "L",
    "NTR", "NA", "IMO", "T", "BCE", "AEM", "TRI", "WPM", "CSU", "TOU",
    "K", "POW", "PPL", "RCI-B", "DOL", "IFC", "GWO", "QSR", "FM", "MG",
    "CCO", "OTEX", "WN", "SAP", "EMA", "TIH", "CVE", "ARX", "GIL", "BAM",
    "H", "STN", "WSP", "CTC-A", "FNV", "KEY", "AQN", "CAE", "ELF", "CIGI",
]
