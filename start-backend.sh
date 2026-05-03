#!/bin/bash
cd /Users/Mini/Documents/portfolio-tracker/backend
source .venv/bin/activate
exec uvicorn app.main:app --reload --port 8000
