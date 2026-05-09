#!/usr/bin/env bash
# PreToolUse: Block Write/Edit/Bash calls that would persist secrets.
# Exits with code 2 to block the tool call when a high-confidence secret is detected.

set -euo pipefail

payload=$(cat)

# Collect candidate strings from common fields
content=$(echo "$payload" | grep -oE '("content"|"command"|"new_string")[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/^[^:]*:[[:space:]]*//' | tr '\n' ' ')

[ -z "$content" ] && exit 0

# shellcheck source=lib/secret-patterns.sh
. "$(dirname "$0")/lib/secret-patterns.sh"

for pat in "${SECRET_PATTERNS[@]}"; do
  # `--` is load-bearing: PEM-style patterns start with `-----` which
  # grep otherwise misinterprets as an option flag.
  if echo "$content" | grep -qE -- "$pat"; then
    echo "🚨 BLOCKED: Secret pattern detected in tool input." >&2
    echo "   Pattern: ${pat:0:50}..." >&2
    echo "   Move the secret to AWS Secrets Manager or a gitignored .env file." >&2
    exit 2
  fi
done

exit 0
