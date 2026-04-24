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

# pre-commit: block staged secrets and never-committable files (.env,
# settings.local.json, spend CSVs, cdk.out artifacts). Belt-and-suspenders
# alongside .gitignore — catches the case where someone `git add -f`s a file.
cat > "$HOOK_DIR/pre-commit" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# 1) Block files that must never be committed. infra/edge/dist/ is the
# generated Lambda@Edge bundle with Cognito secrets baked in — the source
# files in infra/edge/ (templates + handlers) are the only committable part.
blocked=$(git diff --cached --name-only | grep -E '^(\.env|\.env\..*|\.claude/settings\.local\.json|_local/|" data"/|.*\.csv|cdk\.out/|.*/cdk\.out/|cdk-outputs\.json|.*/cdk-outputs\.json|infra/edge/dist/)' || true)
if [ -n "$blocked" ]; then
  echo "🚨 pre-commit blocked: the following files must not be committed:" >&2
  echo "$blocked" | sed 's/^/   - /' >&2
  echo "   Remove with: git reset HEAD <file>  (and verify .gitignore)" >&2
  exit 1
fi

# 2) Scan staged diff for high-confidence secret shapes
patterns=(
  'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}'
  'sk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{40,}'
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{36,}'
  '-----BEGIN (RSA|EC|OPENSSH|PGP|DSA|ENCRYPTED) PRIVATE KEY-----'
  # Cognito OAuth client secret baked into source (Lambda@Edge/auth templates).
  # Matches shapes like `clientSecret: '1mqf...'` or `client_secret=abc...`.
  # The template `_shared.template.js` uses clientSecret:\s*'' (empty) and is safe.
  "clientSecret[[:space:]]*[:=][[:space:]]*['\"][a-z0-9]{40,}"
  "client_secret[[:space:]]*[:=][[:space:]]*['\"][a-z0-9]{40,}"
)
staged_diff=$(git diff --cached -U0)
for pat in "${patterns[@]}"; do
  # `-- $pat` separator stops grep from treating `-----BEGIN …` as a flag.
  # Skip lines containing EXAMPLE / FAKE / YOUR-KEY-HERE (fixtures & docs).
  hit=$(echo "$staged_diff" | grep -E -- "$pat" | grep -vE 'EXAMPLE|FAKE|YOUR-|your-key-here|placeholder' || true)
  if [ -n "$hit" ]; then
    echo "🚨 pre-commit blocked: secret-like pattern in staged diff:" >&2
    echo "   pattern: $pat" >&2
    echo "   sample:  ${hit:0:120}" >&2
    echo "   If this is a real key, rotate it immediately and remove from staging." >&2
    exit 1
  fi
done
EOF
chmod +x "$HOOK_DIR/pre-commit"

echo "Installed git hooks:"
ls -l "$HOOK_DIR/commit-msg" "$HOOK_DIR/pre-commit"
