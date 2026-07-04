# Runbook: Spend Limits card missing — `read:spend_limits` scope recovery

## Symptom

- The **Spend Limits (Monthly)** card never renders on the Cost page (note: it renders only when `/api/cost/spend-limits` returns ≥ 1 member — an empty org also hides it).
- `GET /api/cost/spend-limits` returns `502 upstream_error` whose `upstream` body is an Anthropic **403** listing held vs required scopes, e.g. `Missing required scopes. Got: [...] Needed one of: ['read:spend_limits']`.
- Typical trigger: the Analytics key was rotated to a key created **without** the `read:spend_limits` scope — Claude Enterprise key scopes are **fixed at creation** and cannot be added to an existing key.

## Impact

Only the Spend Limits card (and any future limit-management features needing `write:spend_limits`). Group names may also degrade to `grp-<id>` labels if the new key additionally lost the `read:compliance_org_data` scope, and the Compliance page fails if `read:compliance_activities` was lost — check the 403's "Got:" list for what the current key actually carries.

## Diagnose

```bash
cd ~/my-project/claude-code-dashboard
KEY=$(aws secretsmanager get-secret-value --region ap-northeast-2 \
  --secret-id ccd/analytics-key --query SecretString --output text)

# The 403 body lists BOTH the scopes the key has and the scopes needed:
curl -s "https://api.anthropic.com/v1/organizations/spend_limits/effective?limit=1" \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" | head -c 400; echo
```

Expected healthy scope set on this org's key (verified 2026-07-04): `read:analytics`, `read:compliance_activities`, `read:compliance_org_data`, `read:compliance_user_data`, `read:spend_limits`, `write:spend_limits`.

## Fix

1. **Create a replacement key with the full scope set** (scopes are immutable per key): the **primary owner** goes to `claude.ai → Organization settings → API → Keys → + Create key` and selects all six scopes above (at minimum add `read:spend_limits`; keep the analytics + compliance scopes so the key-consolidation fallback keeps working).
2. **Rotate the secret + redeploy** with the existing one-shot script (interactive terminal — the key is entered at a hidden prompt, never echoed):

```bash
bash scripts/rotate-analytics-key.sh
```

The script validates the key against the Analytics API, updates the gitignored `.env`, pushes to Secrets Manager `ccd/analytics-key`, and forces an ECS redeploy so tasks pick up the new secret.

3. Revoke the old under-scoped key in the Console once verification passes.

## Verify

- [ ] Diagnose curl now returns HTTP 200 with `data[]`.
- [ ] `/api/health` (through the dashboard, or `curl 127.0.0.1:5174/api/health` in local dev) shows `analyticsKey: "analytics"`.
- [ ] Cost page renders the Spend Limits (Monthly) card with member rows.
- [ ] Compliance page and group names still work (the same key serves those scopes).

## Rollback

If the new key misbehaves, restore the previous secret version and redeploy:

```bash
aws secretsmanager update-secret-version-stage --region ap-northeast-2 \
  --secret-id ccd/analytics-key --version-stage AWSCURRENT \
  --move-to-version-id $(aws secretsmanager list-secret-version-ids --region ap-northeast-2 \
    --secret-id ccd/analytics-key \
    --query 'Versions[?contains(VersionStages,`AWSPREVIOUS`)].VersionId|[0]' --output text) \
  --remove-from-version-id $(aws secretsmanager list-secret-version-ids --region ap-northeast-2 \
    --secret-id ccd/analytics-key \
    --query 'Versions[?contains(VersionStages,`AWSCURRENT`)].VersionId|[0]' --output text)

aws ecs update-service --region ap-northeast-2 \
  --cluster $(aws ecs list-clusters --region ap-northeast-2 --query 'clusterArns[?contains(@,`ccd`)]|[0]' --output text) \
  --service $(aws ecs list-services --region ap-northeast-2 \
    --cluster $(aws ecs list-clusters --region ap-northeast-2 --query 'clusterArns[?contains(@,`ccd`)]|[0]' --output text) \
    --query 'serviceArns[0]' --output text) \
  --force-new-deployment
```

## Notes

- Last verified: 2026-07-04
- Scope reference: `https://platform.claude.com/docs/en/manage-claude/admin-api-keys` (scope table + "fixed at creation" rule) and `.../spend-limits-api` (GET needs `read:spend_limits`, POST/DELETE need `write:spend_limits`).
- Related: [ADR-0011](../decisions/0011-rbac-group-visibility-native.md) note on graceful degradation when compliance scopes are absent.
