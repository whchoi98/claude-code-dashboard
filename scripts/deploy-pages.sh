#!/usr/bin/env bash
# Publish site/ (the public GitHub Pages brochure) to the gh-pages branch.
# Same pattern as nfm-dashboard: legacy Pages build from gh-pages root.
#
# Usage: ./scripts/deploy-pages.sh [commit message]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$ROOT/site"
MSG="${1:-docs(pages): publish brochure $(date -u +%F)}"
WORKTREE="$(mktemp -d)"

[ -f "$SITE/index.html" ] || { echo "site/index.html not found — nothing to publish"; exit 1; }

cleanup() { git -C "$ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true; rm -rf "$WORKTREE"; }
trap cleanup EXIT

if git -C "$ROOT" ls-remote --exit-code origin gh-pages >/dev/null 2>&1; then
  git -C "$ROOT" fetch origin gh-pages
  git -C "$ROOT" worktree add "$WORKTREE" -B gh-pages origin/gh-pages
else
  git -C "$ROOT" worktree add --detach "$WORKTREE"
  git -C "$WORKTREE" checkout --orphan gh-pages
  git -C "$WORKTREE" rm -rf --quiet . 2>/dev/null || true
fi

# Mirror site/ into the branch root (Pages serves from /)
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$SITE"/. "$WORKTREE"/
touch "$WORKTREE/.nojekyll"

git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
  echo "gh-pages already up to date"
else
  git -C "$WORKTREE" commit -m "$MSG"
  git -C "$WORKTREE" push origin gh-pages
  echo "published: https://whchoi98.github.io/claude-code-dashboard/"
fi
