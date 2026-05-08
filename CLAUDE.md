# Portfolio Tracker — Claude Context

## What This Is
A multi-client investment portfolio tracker supporting Interactive Brokers (IBKR) and Canadian brokerages (Scotia iTrade, Olympia, Scotia Wealth). Features ACB tracking (Canadian pool method), options tracking, covered call scanner, price fetching, and performance reporting.

## How to Start
```bash
# Terminal 1 — Backend (port 8000)
cd /Users/Mini/Documents/portfolio-tracker/backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000

# OR use the start script:
bash start.sh

# Terminal 2 — Frontend (port 5173)
cd /Users/Mini/Documents/portfolio-tracker/frontend
npm run dev
```
Open http://localhost:5173

## Tech Stack
- **Frontend**: React + TypeScript + Vite + Tailwind CSS + Axios
- **Backend**: Python FastAPI + SQLAlchemy (ORM) + Alembic
- **Database**: PostgreSQL (local: `postgresql://Mini@localhost/portfolio_tracker`)
- **Auth**: JWT tokens via python-jose + passlib/bcrypt
- **Data**: yfinance (price fetching), ib_insync (IBKR live data), httpx (IBeam API)
- **Scheduling**: APScheduler (nightly tasks)

## Environment Variables
Backend reads from environment (create `backend/.env` if needed):
```
DATABASE_URL=postgresql://Mini@localhost/portfolio_tracker
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
ADMIN_NAME=...
SECRET_KEY=...                   # JWT signing secret
IBEAM_BASE_URL=...               # Optional: IBeam Docker URL for cloud IBKR
ALLOWED_ORIGINS=...              # Extra CORS origins (comma-separated)
```
Frontend `frontend/.env`:
```
VITE_API_BASE_URL=http://localhost:8000   # optional — default uses Vite proxy to /api
```

## Project Structure
```
portfolio-tracker/
├── backend/
│   ├── app/
│   │   ├── main.py               # FastAPI app, startup (create_all, migrations, admin user seed)
│   │   ├── database.py           # SQLAlchemy engine + SessionLocal + Base
│   │   ├── dependencies.py       # JWT auth, account-level authorization helpers
│   │   ├── scheduler.py          # APScheduler nightly jobs
│   │   ├── models/
│   │   │   ├── master.py         # Brokerage, Account, Security, Currency, FXRate, MarketPrice
│   │   │   ├── transactions.py   # Transaction model
│   │   │   ├── options.py        # OptionContract model
│   │   │   ├── imports.py        # ImportBatch model
│   │   │   ├── auth.py           # User model
│   │   │   ├── clients.py        # Client, UserClient models
│   │   │   ├── prices.py         # Price history model
│   │   │   ├── ibkr.py           # IBKRFlexConfig model
│   │   │   └── scanner.py        # ScannerResult model
│   │   ├── routers/
│   │   │   ├── auth.py           # POST /api/auth/login, /refresh
│   │   │   ├── portfolio.py      # GET /api/portfolio (positions, P&L, ACB)
│   │   │   ├── transactions.py   # CRUD transactions
│   │   │   ├── accounts.py       # CRUD accounts
│   │   │   ├── securities.py     # CRUD securities
│   │   │   ├── imports.py        # CSV import endpoints
│   │   │   ├── prices.py         # Price fetch + history
│   │   │   ├── options.py        # Options positions
│   │   │   ├── scanner.py        # Covered call scanner
│   │   │   ├── ibkr.py           # IBKR live data (IBeam or ib_insync)
│   │   │   ├── clients.py        # Multi-client management
│   │   │   ├── admin.py          # Admin-only endpoints
│   │   │   └── system.py         # Health, diagnostics
│   │   ├── parsers/
│   │   │   ├── ibkr_trades.py    # IBKR Detailed Trades CSV (~80 columns)
│   │   │   ├── ibkr_history.py   # IBKR trade history flex query
│   │   │   ├── itrade.py         # Scotia iTrade CSV parser
│   │   │   ├── olympia.py        # Olympia Trust CSV parser
│   │   │   └── scotia_wealth.py  # Scotia Wealth CSV parser
│   │   └── services/
│   │       ├── acb_service.py    # ACB calculation (Canadian pool method)
│   │       ├── portfolio.py      # Portfolio aggregation, P&L, returns
│   │       ├── portfolio_history_service.py  # Historical NAV tracking
│   │       ├── price_service.py  # yfinance price fetching + caching
│   │       ├── fx_service.py     # BOC FX rates (auto-refreshed on startup)
│   │       ├── ibkr_service.py   # IBKR connectivity (IBeam cloud or ib_insync local)
│   │       ├── ibkr_flex.py      # IBKR Flex Query scheduled import
│   │       ├── covered_call_service.py  # Covered call opportunity analysis
│   │       ├── signals_service.py       # Technical signals
│   │       ├── normalizer.py     # Transaction normalization across brokerages
│   │       └── auth_service.py   # JWT creation/verification, password hashing
│   ├── requirements.txt
│   └── start.sh                  # Activate venv + uvicorn
└── frontend/
    └── src/
        ├── pages/
        │   ├── Dashboard.tsx     # Portfolio summary, allocation charts
        │   ├── Holdings.tsx      # Current positions table
        │   ├── Performance.tsx   # Returns, benchmarks, history charts
        │   ├── Transactions.tsx  # Transaction ledger with filters
        │   ├── Import.tsx        # CSV upload interface
        │   ├── Options.tsx       # Options positions + P&L
        │   ├── Scanner.tsx       # Covered call scanner
        │   ├── Prices.tsx        # Price management
        │   ├── Admin.tsx         # Admin panel
        │   ├── Reports.tsx       # Report generation
        │   └── Login.tsx         # JWT login page
        ├── components/
        │   ├── Layout.tsx        # App shell + sidebar nav
        │   ├── Sidebar.tsx       # Navigation sidebar
        │   ├── PositionsPanel.tsx
        │   ├── SecurityDetailPanel.tsx
        │   ├── PortfolioAnalyticsPanel.tsx
        │   ├── RiskScoringPanel.tsx
        │   ├── SignalsTab.tsx
        │   ├── FundamentalsTab.tsx
        │   └── DataTable.tsx
        ├── context/
        │   ├── AuthContext.tsx   # JWT auth state, login/logout
        │   ├── ClientContext.tsx # Active client selection
        │   └── FilterContext.tsx # Global filter state
        └── api/client.ts         # Axios instance with JWT interceptors
```

## Database
Local PostgreSQL: `portfolio_tracker` database  
Schema managed by SQLAlchemy `create_all` + manual `_run_migrations()` in `main.py` (adds columns to existing tables).  
No Alembic auto-migrations — new columns are added in the `pending` list inside `_run_migrations()`.

Key tables:
- **accounts** — brokerage accounts (account_type: RRSP/TFSA/RESP/NON_REG, base_currency, owner, client_id)
- **securities** — master securities list (ticker, exchange, asset_class, is_option)
- **transactions** — all trades (buy/sell/dividend/option_buy/option_sell etc.)
- **option_contracts** — option details linked to securities
- **market_prices** — latest price per security (price, beta, dividend_yield, market_cap)
- **fx_rates** — daily CAD/USD exchange rates from Bank of Canada
- **clients** — client entities for multi-client support
- **user_clients** — user ↔ client access mapping
- **users** — auth users (role: admin or user)
- **ibkr_flex_configs** — stored Flex Query tokens per user
- **scanner_results** — covered call scan results with Greeks

## Auth
- JWT-based (access + refresh tokens stored in localStorage as `pt_auth_token`)
- Admin user created on startup if `ADMIN_EMAIL` + `ADMIN_PASSWORD` env vars set and no users exist
- All routes except `/api/auth/login` require Bearer token
- Non-admin users scoped to their assigned clients' accounts via `user_clients` table

## IBKR Integration
Two modes (auto-selected):
1. **Local dev**: `ib_insync` connecting to IB Gateway or TWS on localhost
2. **Cloud/prod**: IBeam Docker service — set `IBEAM_BASE_URL` env var

Flex Query scheduled imports configured via Admin page per user.

## CSV Import Parsers
Each brokerage has a dedicated parser in `backend/app/parsers/`:
- `ibkr_trades.py` — IBKR Detailed Trades export (~80 cols), aggregates execution splits by IBOrderID
- `ibkr_history.py` — IBKR Flex Query trade history
- `itrade.py` — Scotia iTrade
- `olympia.py` — Olympia Trust
- `scotia_wealth.py` — Scotia Wealth

Transactions are normalized through `services/normalizer.py` before storage.

## ACB Calculation
Canadian pool method (not FIFO/LIFO) implemented in `services/acb_service.py`.  
Short option positions tracked with negative quantity.  
Superficial loss rules applied on wash sales within 30-day window.

## FX Rates
Bank of Canada rates fetched via `services/fx_service.py`.  
Auto-refreshed on startup if rates are more than 3 days stale.  
Used for CAD↔USD conversion throughout portfolio calculations.

## GitHub
Check `git remote -v` for the remote URL.
