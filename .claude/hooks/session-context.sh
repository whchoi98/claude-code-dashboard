#!/usr/bin/env bash
# SessionStart: Load lightweight project context so Claude starts grounded.
# Output goes into the session context; keep it short.

set -euo pipefail

ROOT=$(pwd)

echo "# Session context for claude-code-dashboard"
echo
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
