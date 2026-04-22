#!/usr/bin/env bash
# Notification: Forward Claude Code notifications to configured sinks.
# No-op by default. Wire to Slack/Discord/SNS via environment variables.

set -euo pipefail

payload=$(cat)
message=$(echo "$payload" | grep -oE '"message"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')

# Example: Slack webhook (opt-in via env)
if [ -n "${CCD_SLACK_WEBHOOK:-}" ] && [ -n "$message" ]; then
  curl -sS -X POST -H 'Content-Type: application/json' \
    --data "{\"text\":\"[claude-code-dashboard] ${message//\"/\\\"}\"}" \
    "$CCD_SLACK_WEBHOOK" >/dev/null 2>&1 || true
fi

exit 0
