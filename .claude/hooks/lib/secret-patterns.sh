#!/usr/bin/env bash
# Shared secret-pattern definitions. Source this from any hook that
# needs to flag credentials — both `secret-scan.sh` (PreToolUse, blocks
# tool input that would persist a secret) and `session-context.sh`
# (SessionStart, scans .claude/settings*.json so a key that arrived via
# the permission-acceptance flow surfaces a warning before any tool runs).
#
# Keep this file the single source of truth — drift between the two
# hooks is the bug class this exists to prevent.

# shellcheck disable=SC2034  # Variables here are consumed by sourcing scripts.
SECRET_PATTERNS=(
  'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}'      # Anthropic API key
  'sk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{40,}'    # Anthropic Admin key
  'AKIA[0-9A-Z]{16}'                            # AWS Access Key ID
  'aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}'
  'ghp_[A-Za-z0-9]{36,}'                        # GitHub PAT
  'xox[baprs]-[A-Za-z0-9-]{10,}'                # Slack tokens
  '-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----'
)
