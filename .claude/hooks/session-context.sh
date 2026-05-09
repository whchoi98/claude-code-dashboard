#!/usr/bin/env bash
# SessionStart: Load lightweight project context so Claude starts grounded.
# Output goes into the session context; keep it short.

set -euo pipefail

ROOT=$(pwd)

echo "# Session context for claude-code-dashboard"
echo

# Settings-file secret guard. The PreToolUse secret-scan.sh hook only
# inspects tool_input payloads — it cannot catch a secret that already
# lives inside .claude/settings*.json (those are loaded straight into
# the agent context). Scan them at session start and warn loudly if a
# live API key snuck in via the permission-acceptance flow.
SECRET_REGEX='sk-ant-(api|admin)0[0-9]+-[A-Za-z0-9_-]{40,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[bp]-[A-Za-z0-9-]{20,}'
for f in .claude/settings.json .claude/settings.local.json; do
  [ -f "$f" ] || continue
  # Strip lines that are clearly search patterns (grep / git grep arguments)
  # before scanning, so the scanner doesn't flag legitimate audit commands.
  if grep -vE 'grep .*"sk-ant-' "$f" 2>/dev/null | grep -qE "$SECRET_REGEX"; then
    echo "## ⚠️  SECURITY WARNING"
    echo "- Live secret detected in $f. Rotate the credential and replace the literal value with __TRACKED_VAR__."
    echo
  fi
done

echo "## Git"
if [ -d .git ]; then
  echo "- branch: $(git branch --show-current 2>/dev/null || echo '(unknown)')"
  echo "- last commit: $(git log -1 --pretty=format:'%h %s' 2>/dev/null || echo '(no commits)')"
  echo "- dirty files: $(git status --short 2>/dev/null | wc -l)"
else
  echo "- (not a git repo)"
fi

echo
echo "## Deployed stacks (ap-northeast-2)"
if command -v aws >/dev/null 2>&1; then
  aws cloudformation list-stacks --region ap-northeast-2 \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
    --query 'StackSummaries[?starts_with(StackName,`ccd-`)].StackName' \
    --output text 2>/dev/null | tr '\t' '\n' | sed 's/^/- /'
fi

echo
echo "## Recent docs"
find docs -name "*.md" -type f -mtime -7 2>/dev/null | head -5 | sed 's/^/- /'

exit 0
