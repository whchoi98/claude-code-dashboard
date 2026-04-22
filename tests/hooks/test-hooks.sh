#!/usr/bin/env bash
# Validate that all hooks exist, are executable, and are registered in settings.json.

H=".claude/hooks"

assert_file_exists "$H/check-doc-sync.sh"
assert_file_exists "$H/secret-scan.sh"
assert_file_exists "$H/session-context.sh"
assert_file_exists "$H/notify.sh"

assert_executable "$H/check-doc-sync.sh"
assert_executable "$H/secret-scan.sh"
assert_executable "$H/session-context.sh"
assert_executable "$H/notify.sh"

S=".claude/settings.json"
assert_file_exists "$S"
assert_contains "settings registers SessionStart"   "session-context.sh"  "$S"
assert_contains "settings registers PreToolUse"     "secret-scan.sh"      "$S"
assert_contains "settings registers PostToolUse"    "check-doc-sync.sh"   "$S"
assert_contains "settings registers Notification"   "notify.sh"           "$S"
