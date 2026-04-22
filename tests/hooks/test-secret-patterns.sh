#!/usr/bin/env bash
# Run the secret-scan hook against fixture samples.

HOOK=".claude/hooks/secret-scan.sh"
TP="tests/fixtures/secret-samples.txt"
FP="tests/fixtures/false-positives.txt"

[ -f "$HOOK" ] || return 0
[ -f "$TP" ]   || return 0
[ -f "$FP" ]   || return 0

# Each line of the true-positive file should cause the hook to exit 2
while IFS= read -r line; do
  [ -z "$line" ] && continue
  payload="{\"content\":\"$line\"}"
  echo "$payload" | "$HOOK" >/dev/null 2>&1
  rc=$?
  assert "true positive blocked: ${line:0:40}…" test "$rc" -eq 2
done < "$TP"

# Each line of the false-positive file should NOT cause the hook to block
while IFS= read -r line; do
  [ -z "$line" ] && continue
  payload="{\"content\":\"$line\"}"
  echo "$payload" | "$HOOK" >/dev/null 2>&1
  rc=$?
  assert "false positive allowed: ${line:0:40}…" test "$rc" -ne 2
done < "$FP"
