#!/usr/bin/env bash
echo "========================================"
echo "  Portfolio Tracker — Frontend (port 5173)"
echo "========================================"
cd "$(dirname "$0")/frontend"
exec npm run dev
