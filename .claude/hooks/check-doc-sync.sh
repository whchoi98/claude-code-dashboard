#!/usr/bin/env bash
# PostToolUse: Detect doc drift when source files are written/edited.
# Emits a suggestion; does not block. Matcher = Write|Edit.

set -euo pipefail

# tool_input JSON is provided on stdin by Claude Code hooks
payload=$(cat)
path=$(echo "$payload" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

[ -z "${path:-}" ] && exit 0

# Walk up from the changed file to find the nearest CLAUDE.md
dir=$(dirname "$path")
while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/CLAUDE.md" ]; then
    mod_time=$(stat -c %Y "$dir/CLAUDE.md" 2>/dev/null || stat -f %m "$dir/CLAUDE.md" 2>/dev/null || echo 0)
    file_time=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || echo 0)
    # If CLAUDE.md older than the file being edited, suggest update
    if [ "$file_time" -gt "$mod_time" ]; then
      echo "💡 Doc drift: $dir/CLAUDE.md may be stale (older than $path)." >&2
      echo "   Consider updating it, or run /sync-docs." >&2
    fi
    break
  fi
  dir=$(dirname "$dir")
done

exit 0
