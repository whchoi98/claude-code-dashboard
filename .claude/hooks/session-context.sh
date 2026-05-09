#!/usr/bin/env bash
# SessionStart: Load lightweight project context so Claude starts grounded.
# Output goes into the session context; keep it short.

set -euo pipefail

ROOT=$(pwd)

echo "# Session context for claude-code-dashboard"
echo

# Settings-file secret guard. The PreToolUse secret-scan.sh hook only
# inspects tool_input payloads — it can't see a secret that already
# lives inside .claude/settings*.json (those are loaded straight into
# the agent context). We scan the parsed JSON values rather than
# raw text so search patterns embedded in legitimate audit commands
# (e.g. `git grep "sk-ant-api01-"`) don't false-positive.
# shellcheck source=lib/secret-patterns.sh
. "$(dirname "$0")/lib/secret-patterns.sh"
for f in .claude/settings.json .claude/settings.local.json; do
  [ -f "$f" ] || continue
  if python3 - "$f" "${SECRET_PATTERNS[@]}" <<'PY'
import json, re, sys
path, *patterns = sys.argv[1:]
combined = re.compile("|".join(patterns))
def walk(node):
    if isinstance(node, str):
        # Audit commands the user runs regularly include the literal
        # token shape; treat them as known-good rather than secrets.
        if "grep " in node or "git grep" in node:
            return False
        return bool(combined.search(node))
    if isinstance(node, list): return any(walk(v) for v in node)
    if isinstance(node, dict): return any(walk(v) for v in node.values())
    return False
with open(path) as fh:
    sys.exit(0 if walk(json.load(fh)) else 1)
PY
  then
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
