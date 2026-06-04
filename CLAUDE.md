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

## Deployment (Production — self-hosted on QNAP)
Migrated off Render (June 2026) to a self-hosted stack. **No monthly hosting fee.**

**Infrastructure chain:** QNAP TVS-72XT NAS → Virtualization Station → Ubuntu 24.04 VM
(`apps-server`, 8 GB RAM, user `deploy`) → Docker → **Coolify** v4 PaaS → **Cloudflare Tunnel**.

**Live URLs:**
- Frontend: https://portfolio.danderud.ca
- Backend API: https://portfolio-api.danderud.ca (`/docs` for Swagger)
- Coolify dashboard: https://coolify.danderud.ca

**Coolify project "Portfolio"** (all apps build from this repo via the connected
GitHub App `coolify-github-bromanow`, Build Pack = Dockerfile, auto-deploy on push):
| App | Base Dir | Dockerfile | Port | Watch Path | Domain |
|-----|----------|-----------|------|-----------|--------|
| `portfolio-frontend` | `/frontend` | `frontend/Dockerfile` (Vite build → nginx) | 80 | `frontend/**` | http://portfolio.danderud.ca |
| backend (`portfolio-backend`) | `/backend` | `backend/Dockerfile` (uvicorn) | 8000 | `backend/**` | http://portfolio-api.danderud.ca |
| `portfolio-ibeam` | `/ibeam` | `ibeam/Dockerfile` (voyz/ibeam + login patch) | 5000 | `ibeam/**` | *(none — internal only)* |
| PostgreSQL 16 | — | `postgres:16-alpine` image | 5432 | — | *(internal)* |

**Networking gotchas (important):**
- **Cloudflare SSL/TLS mode = Full** (not Flexible — Flexible caused ERR_TOO_MANY_REDIRECTS).
- Coolify app **Domains use `http://`** (not https) — the tunnel/Traefik terminate TLS; `https://`
  in the domain forces a Traefik redirect that loops. Cloudflare still serves the public URL over HTTPS.
- Tunnel `qnap-tunnel` routes: `coolify.danderud.ca`→`localhost:8000`; everything else
  (`portfolio.danderud.ca`, `portfolio-api.danderud.ca`)→`localhost:80` (Coolify's Traefik routes by hostname).
- All app containers share the Docker network **`coolify`** (auto-attached; no toggle needed).
  Inter-app DNS by container name / **Network Alias**. IBeam has alias `ibeam` → backend reaches it
  at `https://ibeam:5000`.
- **VITE_API_BASE_URL** must be a **build-time** var in Coolify (Vite inlines it at `npm run build`).

**Production env vars** (set in Coolify, not in this repo):
- Backend: `DATABASE_URL=postgresql://postgres:<pw>@<pg-container>:5432/portfolio_tracker`,
  `IBEAM_BASE_URL=https://ibeam:5000`, `ALLOWED_ORIGINS=https://portfolio.danderud.ca`, `SECRET_KEY`, admin vars.
- Frontend: `VITE_API_BASE_URL=https://portfolio-api.danderud.ca` (build-time).
- IBeam: `IBEAM_ACCOUNT`, `IBEAM_PASSWORD`, `IBEAM_PYOTP_SECRET`, `IBEAM_TWO_FA_HANDLER=PYOTP`, etc.

**SSH to the VM:** `ssh deploy@<vm-ip>` (find IP in QNAP Virtualization Station). Use the
**Coolify web UI** for deploys/logs/env; SSH only for `docker` inspection. DB container id and
secrets are in the auto-memory note, not here.

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

**Production IBeam** runs as the `portfolio-ibeam` Coolify app (image built from `ibeam/Dockerfile`
= `voyz/ibeam` + `ibeam/patch_login.py`, which handles IBKR's "Select 2FA Device" dropdown).
2FA is fully automated via `IBEAM_TWO_FA_HANDLER=PYOTP` + TOTP secret. Backend reaches it at
`https://ibeam:5000` (Docker network alias `ibeam`).
⚠️ **Only ONE IBeam session per IBKR user** — two instances (e.g. an old Render one) compete and
neither stays authenticated. Suspend any other instance before relying on this one. (See auth-status
check: `authenticated:true, established:true, competing:false`.)

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

## Performance & Snapshot Engine
The Performance page is driven by daily `portfolio_snapshots` (per account, per date),
computed by `services/portfolio_history_service.py` (`compute_portfolio_snapshots`) and
surfaced via `/api/portfolio/performance/timeline` (chart) and `/performance/returns`
(table). Snapshot dates = distinct `historical_prices.price_date` (so they're sparse —
only trading days with price data). Trigger a rebuild with the **"Recompute Snapshots"**
button (or `POST /api/portfolio/compute-snapshots`).

Hard-won correctness rules (June 2026 — these fixed a long series of data bugs; don't
regress them):
- **Positions:** running quantity is NOT clamped to ≥0 per-transaction (that created
  phantom long positions when a disposal was recorded before its matching buy, common in
  wheel-trading accounts). Negative running balances are skipped (valued $0) at valuation.
- **Pricing:** `_price_at` carries the last price **forward**, and **backward** from the
  earliest known price when a held position predates its price history. Unpriced securities
  fall back to a **manual MarketPrice** (this is how structured notes show at $100 par — set
  a manual price for any sourceless holding; it fixes both dashboard and snapshots).
- **Cash:** tracked in the account's **base currency** (mirrors `get_cash_balances` routing:
  `transaction_amount` same-ccy, `account_currency_amount`/`cad_amount` cross-ccy), converted
  to CAD at the **snapshot-date** FX rate. Do NOT sum `cad_amount` — it drifts on FX /
  Norbert's-Gambit (DLR) flows.
- **Dormant/closed accounts:** if no positions AND last transaction > 365 days before the
  snapshot date, cash is zeroed (an FX/spread residual on a closed account isn't real money).
  Dormancy is judged across the **logical account** (all CAD/USD siblings, by name minus
  " (USD)") — so an idle USD cash sub isn't zeroed while its CAD sibling is actively traded.
  Active accounts that merely dip to $0 keep recent transactions, so they're untouched.
- **Returns:** Modified Dietz — gain net of external cash flows (DEPOSIT/WITHDRAWAL/
  TRANSFER_IN/TRANSFER_OUT/JOURNAL), over time-weighted average capital. Returns are
  suppressed ("—") when an account's current value ≈ $0. Income is already inside account
  value (cash), so there is NO separate income term (avoids double-counting).
- **CAD+USD sub-accounts** with the same base name merge into one logical account on the
  Performance page (the returns endpoint strips the " (USD)" suffix).

## Roadmap (next up — discussed, not yet started)
Two workstreams were planned before the snapshot data-fix detour:
1. **Responsive / multi-device + PWA** — app is desktop-first; make it usable on iPhone/iPad
   (responsive Tailwind + tables→cards on mobile + bottom-tab nav + installable PWA).
2. **Information-architecture rethink** — reorganize ~10 nav items around jobs (Overview /
   Holdings / Performance / Activity / Research), plus easier mobile transaction capture.
A bigger future feature set: an **opportunity engine** (whole-market screeners merging
technical signals + social/news sentiment, e.g. via the Claude API) — needs a paid market-data
provider decision first. Five scoping questions are still open (devices, users, data budget,
markets, signal philosophy: suggest/explain vs auto buy-sell).

## GitHub
Check `git remote -v` for the remote URL.
