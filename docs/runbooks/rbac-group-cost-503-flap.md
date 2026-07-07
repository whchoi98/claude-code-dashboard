# Runbook: RBAC group cost upstream 503 flap ("Team membership data is not ready yet")

## Symptom

- Cost page shows the amber note **"그룹별 비용을 일시적으로 표시할 수 없습니다 …"** where the Cost by Group card should be, or the card renders with the subtitle suffix **"마지막 정상 조회 값 표시 중"** (`stale: true`).
- The per-page group tabs (GroupTabs, formerly the sidebar selector) show only "All groups" even though no admin CSV was ever needed before (auto-derive degraded to `source:"empty"`).
- ECS logs show `[cost/groups] upstream 503; serving last-good …` or `[groups] auto-derive unavailable, falling back to empty: user_cost_report 503`.
- A direct upstream probe returns `503 overloaded_error` — `"Team membership data is not ready yet; RBAC group breakdowns and filters are temporarily unavailable."`

## Impact

Only the group surfaces degrade: the Cost by Group card and the auto-derived per-page group scope (GroupTabs). Every other Cost section (headline KPIs, per-user Top-10, tokens, spend limits) and all other pages are unaffected. This is an **upstream Anthropic condition, not our outage** — first observed 2026-07-03 (worked in the morning, 503 for 24 h+ after); it is completely undocumented, so there is no retry contract to lean on.

## Diagnose

```bash
cd ~/my-project/claude-code-dashboard
KEY=$(aws secretsmanager get-secret-value --region ap-northeast-2 \
  --secret-id ccd/analytics-key --query SecretString --output text)

# 1. Is the rbac dimension itself down? (503 = flap; 200 = recovered)
curl -s -o /tmp/rbac.json -w "rbac dimension: HTTP %{http_code}\n" \
  "https://api.anthropic.com/v1/organizations/analytics/cost_report?starting_at=$(date -u -d '4 days ago' +%F)T00:00:00Z&ending_at=$(date -u -d '3 days ago' +%F)T00:00:00Z&bucket_width=1d&group_by[]=rbac_group_id" \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01"
head -c 200 /tmp/rbac.json; echo

# 2. Control — everything EXCEPT the rbac dimension should be 200
curl -s -o /dev/null -w "control (product×model): HTTP %{http_code}\n" \
  "https://api.anthropic.com/v1/organizations/analytics/cost_report?starting_at=$(date -u -d '4 days ago' +%F)T00:00:00Z&ending_at=$(date -u -d '3 days ago' +%F)T00:00:00Z&bucket_width=1d&group_by[]=product&group_by[]=model" \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01"

# 3. Group NAMES are independent (Compliance groups endpoint) — should stay 200
curl -s -o /dev/null -w "compliance/groups: HTTP %{http_code}\n" \
  "https://api.anthropic.com/v1/compliance/groups?limit=5" \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01"

# 4. What the tasks are seeing
aws logs filter-log-events --region ap-northeast-2 \
  --log-group-name ccd-compute-Logs6819BB44-qqZW46J5IBLA \
  --start-time $(($(date +%s%3N) - 3600000)) \
  --filter-pattern '"503"' --query 'events[-5:].message' --output text
```

If (1) is 503 while (2) and (3) are 200, this runbook applies. If (2) also fails, the problem is broader (key, network, Anthropic incident) — check `https://status.anthropic.com` instead.

## Mitigate

There is nothing to "fix" on our side — the server is already designed to absorb the flap:

1. **Do NOT restart or redeploy the ECS service during a flap.** The last-good cache (`groupLastGood`, per-window key) is in-memory per task; a restart discards it and the card degrades from "stale data + note" to "note only" until upstream recovers.
2. If users ask, the honest status is: group data is temporarily unavailable upstream; the card recovers automatically (the UI note says exactly this).
3. Optional recovery watch (notifies when the dimension is back):

```bash
while true; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://api.anthropic.com/v1/organizations/analytics/cost_report?starting_at=$(date -u -d '4 days ago' +%F)T00:00:00Z&ending_at=$(date -u -d '3 days ago' +%F)T00:00:00Z&bucket_width=1d&group_by[]=rbac_group_id" \
    -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01")
  echo "$(date -u +%FT%TZ) rbac_group_id: HTTP $CODE"
  [ "$CODE" = "200" ] && break
  sleep 300
done
```

## Escalate

If the flap persists beyond ~24 h, contact Anthropic support with a `request_id` from the 503 body (`head -c 400 /tmp/rbac.json`) and note the exact error string — the condition is undocumented, so the request_id is the only useful handle.

## Verify recovery

- [ ] Diagnose step (1) returns HTTP 200 with non-empty `data[]`.
- [ ] Cost page reloads with the Cost by Group card showing **real group names** (Engineering, CXO, …) and no stale/unavailable note.
- [ ] Per-page group tabs (GroupTabs) repopulate within one page load (auto-derive) — no CSV upload needed.

## Notes

- Last verified: 2026-07-04 (live flap in progress while writing)
- Related: [ADR-0011](../decisions/0011-rbac-group-visibility-native.md) — why last-good caching + the Compliance groups name source were chosen.
