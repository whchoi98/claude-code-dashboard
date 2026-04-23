#!/usr/bin/env bash
# TAP-style test runner. All tests source this file for assertions.

set -u

# ── Assertions ─────────────────────────────────────────────────────────────
PASS=0
FAIL=0
TESTS=0

assert() {
  TESTS=$((TESTS + 1))
  local name="$1"; shift
  if "$@"; then
    PASS=$((PASS + 1))
    echo "ok $TESTS - $name"
  else
    FAIL=$((FAIL + 1))
    echo "not ok $TESTS - $name"
  fi
}

assert_file_exists() { assert "file exists: $1" test -f "$1"; }
assert_dir_exists()  { assert "dir exists: $1"  test -d "$1"; }
assert_executable()  { assert "executable: $1"  test -x "$1"; }
assert_contains()    { assert "$1 contains '$2'" grep -q "$2" "$3"; }

export -f assert assert_file_exists assert_dir_exists assert_executable assert_contains
export PASS FAIL TESTS

# ── Discover + run test scripts ────────────────────────────────────────────
ROOT=$(cd "$(dirname "$0")" && pwd)
echo "TAP version 13"

for suite in "$ROOT"/hooks/*.sh "$ROOT"/structure/*.sh; do
  [ -f "$suite" ] || continue
  echo "# --- $(basename "$suite") ---"
  # shellcheck disable=SC1090
  source "$suite"
done

# Node-based sanitizer tests — they have their own TAP output + exit code.
for node_suite in "$ROOT"/server/*.mjs; do
  [ -f "$node_suite" ] || continue
  echo "# --- $(basename "$node_suite") ---"
  if node "$node_suite"; then
    TESTS=$((TESTS + 1)); PASS=$((PASS + 1))
    echo "ok $TESTS - $(basename "$node_suite") passed"
  else
    TESTS=$((TESTS + 1)); FAIL=$((FAIL + 1))
    echo "not ok $TESTS - $(basename "$node_suite") failed"
  fi
done

echo "# passed: $PASS / $TESTS (failed: $FAIL)"
[ "$FAIL" -eq 0 ]
