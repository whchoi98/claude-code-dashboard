#!/usr/bin/env bash
# PreToolUse: Block Write/Edit/Bash calls that would persist secrets.
# Exits with code 2 to block the tool call when a high-confidence secret is detected.

set -euo pipefail

payload=$(cat)

# Collect candidate strings from common fields
content=$(echo "$payload" | grep -oE '("content"|"command"|"new_string")[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/^[^:]*:[[:space:]]*//' | tr '\n' ' ')

[ -z "$content" ] && exit 0

# True-positive patterns
patterns=(
  'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}'      # Anthropic API key
  'sk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{40,}'    # Anthropic Admin key
  'AKIA[0-9A-Z]{16}'                            # AWS Access Key ID
  'aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}'
  'ghp_[A-Za-z0-9]{36,}'                        # GitHub PAT
  'xox[baprs]-[A-Za-z0-9-]{10,}'                # Slack tokens
  '-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----'
)

for pat in "${patterns[@]}"; do
  if echo "$content" | grep -qE "$pat"; then
    echo "🚨 BLOCKED: Secret pattern detected in tool input." >&2
    echo "   Pattern: ${pat:0:50}..." >&2
    echo "   Move the secret to AWS Secrets Manager or a gitignored .env file." >&2
    exit 2
  fi
done

exit 0
