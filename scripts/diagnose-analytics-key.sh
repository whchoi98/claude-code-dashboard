#!/usr/bin/env bash
# Classify why the Analytics API key isn't working. Reads the key from a hidden
# prompt (never stored/echoed), probes a few endpoints, and prints HTTP codes +
# error types + request_ids (NOT the key) so we can pinpoint: bad key string vs
# wrong scope vs org-level analytics access vs endpoint/incident.
set -uo pipefail
VER=2023-06-01
B=https://api.anthropic.com

read -rs -p "Paste the Analytics API key to diagnose: " KEY; echo
[ -n "${KEY:-}" ] || { echo "✗ empty"; exit 1; }

# Length is a cheap truncation check (a full sk-ant-api01 key is ~108 chars).
echo "key: length=${#KEY}  prefix=${KEY:0:14}…  suffix=…${KEY: -4}"
case "$KEY" in sk-ant-api01-*) echo "prefix OK (sk-ant-api01-)";; *) echo "⚠ prefix is NOT sk-ant-api01- (wrong key type?)";; esac
echo ""

probe() { # $1=label  $2=url
  local code body etype rid
  code=$(curl -s -o /tmp/diag.json -w "%{http_code}" --max-time 25 "$2" -H "x-api-key: $KEY" -H "anthropic-version: $VER")
  etype=$(python3 -c "import json;print(json.load(open('/tmp/diag.json')).get('error',{}).get('type',''))" 2>/dev/null)
  rid=$(python3 -c "import json;print(json.load(open('/tmp/diag.json')).get('request_id',''))" 2>/dev/null)
  printf "  %-22s HTTP %s   %s  %s\n" "$1" "$code" "${etype:-ok}" "$rid"
  rm -f /tmp/diag.json
}

echo "probes:"
probe "models (key valid?)"     "$B/v1/models"
probe "analytics/summaries"     "$B/v1/organizations/analytics/summaries?starting_date=2026-05-20&ending_date=2026-06-07"
probe "analytics/users"         "$B/v1/organizations/analytics/users?date=2026-06-07&limit=2"
probe "analytics/cost_report"   "$B/v1/organizations/analytics/cost_report?starting_at=2026-05-20T00:00:00Z&ending_at=2026-06-07T00:00:00Z&bucket_width=1d&group_by%5B%5D=product"
unset KEY

echo ""
echo "How to read this:"
echo "  • models=401 authentication_error      → the key STRING is rejected (truncated / wrong / not yet active). Re-copy or regenerate."
echo "  • analytics=403 permission_error        → valid key, WRONG SCOPE. Generate an *Analytics*-scoped key."
echo "  • analytics=404 not_found_error         → key auths but this org has no analytics resource → org-level Analytics access / wrong org / Anthropic endpoint. Share the request_id with Anthropic support."
echo "  • analytics=200                         → it works; re-run scripts/rotate-analytics-key.sh."
