#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"

echo "========================================"
echo "  Portfolio Tracker - Starting Up"
echo "========================================"

# ── Check for Node.js ────────────────────────────────────────────────────────
# Source common shell profiles to get PATH with nvm/volta/fnm
[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
[ -f "$HOME/.volta/bin/volta" ] && export PATH="$HOME/.volta/bin:$PATH"
[ -f "$HOME/.config/fnm/fnm" ] && eval "$(fnm env)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/tmp/node-v20.11.0-darwin-x64/bin:$PATH"

if ! command -v node &>/dev/null; then
  echo ""
  echo "ERROR: Node.js is not installed or not in PATH."
  echo ""
  echo "To install Node.js, run one of:"
  echo "  brew install node          (if you have Homebrew)"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  echo "  Then: nvm install 20"
  echo ""
  echo "After installing, run this script again."
  echo ""
  echo "Alternatively, start only the backend:"
  echo "  cd backend && python3 -m venv .venv && source .venv/bin/activate"
  echo "  pip install -r requirements.txt && python seed_data.py"
  echo "  uvicorn app.main:app --reload"
  echo ""
  exit 1
fi

NPM_CMD="npm"
if ! command -v npm &>/dev/null; then
  echo "npm not found, trying npx..."
  NPM_CMD="npx npm"
fi

echo "[info] Node: $(node --version), npm: $(npm --version 2>/dev/null || echo 'via npx')"

# ── Python virtual environment ───────────────────────────────────────────────
cd "$BACKEND_DIR"

if [ ! -d ".venv" ]; then
  echo "[backend] Creating Python virtual environment..."
  python3 -m venv .venv
fi

echo "[backend] Activating virtual environment..."
source .venv/bin/activate

echo "[backend] Installing Python dependencies..."
pip install -q -r requirements.txt

echo "[backend] Running seed data..."
python seed_data.py 2>&1 || echo "[backend] Seed skipped (data already exists or non-fatal error)"

echo "[backend] Starting FastAPI on port 8000..."
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
echo "[backend] PID: $BACKEND_PID"

# ── Node / npm ───────────────────────────────────────────────────────────────
cd "$FRONTEND_DIR"

if [ ! -d "node_modules" ]; then
  echo "[frontend] Installing npm dependencies (this may take a minute)..."
  npm install
fi

echo "[frontend] Starting Vite dev server on port 5173..."
npm run dev &
FRONTEND_PID=$!
echo "[frontend] PID: $FRONTEND_PID"

echo ""
echo "========================================"
echo "  App is starting!"
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:8000"
echo "  API Docs: http://localhost:8000/docs"
echo ""
echo "  Press Ctrl+C to stop both servers."
echo "========================================"

# Wait for both to finish (or Ctrl+C)
trap "echo 'Shutting down...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait $BACKEND_PID $FRONTEND_PID
