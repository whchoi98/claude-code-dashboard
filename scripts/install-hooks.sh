#!/usr/bin/env bash
# Install local git hooks. Idempotent.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -d "$ROOT/.git" ]; then
  echo "Not a git repo — skipping hook install."
  exit 0
fi

HOOK_DIR="$ROOT/.git/hooks"
mkdir -p "$HOOK_DIR"

# commit-msg: remove any AI co-author trailers
cat > "$HOOK_DIR/commit-msg" <<'EOF'
#!/usr/bin/env bash
# Strip Co-Authored-By lines for AI assistants.
MSG=$1
[ -z "$MSG" ] && exit 0
if grep -qE "^Co-Authored-By:.*(Claude|anthropic|bot@users\.noreply)" "$MSG"; then
  grep -vE "^Co-Authored-By:.*(Claude|anthropic|bot@users\.noreply)" "$MSG" > "${MSG}.tmp"
  mv "${MSG}.tmp" "$MSG"
fi
exit 0
EOF
chmod +x "$HOOK_DIR/commit-msg"

echo "Installed git hooks:"
ls -l "$HOOK_DIR/commit-msg"
