#!/usr/bin/env bash
# One-shot setup for a fresh clone.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "==> [1/4] Installing root dependencies"
npm install --no-audit --no-fund

echo "==> [2/4] Installing infra dependencies"
(cd infra && npm install --no-audit --no-fund)

echo "==> [3/4] Installing collector dependencies"
(cd collector && npm install --no-audit --no-fund)

echo "==> [4/4] Installing git hooks"
bash "$ROOT/scripts/install-hooks.sh" || echo "(skipping — not a git repo)"

if [ ! -f "$ROOT/.env" ] && [ -f "$ROOT/.env.example" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "==> Created .env from .env.example — please fill in ANTHROPIC_ANALYTICS_KEY."
fi

echo
echo "Setup complete. Try:"
echo "  npm run dev        # Vite (5173) + Express (5174)"
echo "  npm run build      # production bundle"
echo "  bash tests/run-all.sh"
