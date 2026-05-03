#!/bin/bash
set -e
cd /Users/Mini/Documents/portfolio-tracker/backend
source .venv/bin/activate
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
