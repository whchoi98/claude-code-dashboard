# collector — daily Analytics API snapshot Lambda

## Role

Node 20 Lambda. Fetches six Analytics API endpoints (users, summaries, skills, connectors, chat projects, plugins — plugins since v2.2/2026-08) **plus the Compliance audit feed** and writes partitioned NDJSON to `s3://<archive>/<table>/date=YYYY-MM-DD/`, plus a **raw sidecar** of the unflattened upstream records to `s3://<archive>/raw/<table>/date=YYYY-MM-DD/` (since 2026-07-12; compliance since 2026-07-15 — ADR-0017). Runs on TWO EventBridge rules — **14:00 UTC analytics-only** (payload `{complianceDays: 0}`) and **00:30 UTC compliance-only** (payload `{complianceOnly: true}`; right after UTC midnight today's feed is minutes deep, so the backward walk reaches yesterday in 1-2 pages — at 14:00 it would burn ~50-60 pages traversing today first). Manual invokes accept `{ date, summariesStart, summariesEnd, complianceOnly, complianceStart, complianceEnd, complianceDays, compliancePages, org }`.

**Multi-org (contract 2026-07-21)**: every run loops orgs — `primary` (legacy env `ANTHROPIC_ANALYTICS_KEY(_SECRET_ARN)`, legacy S3 paths EXACTLY) then `org2` (env `ANTHROPIC_ANALYTICS_KEY_2(_2_SECRET_ARN)`, S3 keys under the `org2/` prefix in both the columnar tables AND the raw sidecar). org2 runs only when its env is configured; payload `org: 'primary'|'org2'` limits a manual run to one org (unknown values throw). Result convention: primary keeps unprefixed keys (`writes.users`, `counts.compliance_events`), org2 keys carry `org2_` (`writes.org2_users`, `counts.org2_compliance_events`); the return also lists `orgs`. The `getRemainingTimeInMillis` guard covers the whole multi-org run — a later org is skipped (`writes.org2_skipped: 'time'`) when < 90 s remain.

## Files

- **`handler.js`** — `export const handler`; resolves each org's Analytics API key from Secrets Manager (or plain env), cached per org, paginates each endpoint, imports the flatten helpers from `flatten.js`, and writes NDJSON per partition. Exports the pure org helpers (`orgsForRun`/`orgConfigured`/`orgS3Prefix`/`orgKeyPrefix`) tested in `tests/server/test-collector-orgs.mjs`.
- **`flatten.js`** — pure, dependency-free write-side helpers (`flattenUser`/`flattenSkill`/`flattenConnector`/`flattenProject`/`flattenPlugin`): nested Analytics API record → flat columnar NDJSON row. The read-side inverse is `server/inflate.js` `inflateUser()`; the two are unit-tested together in `tests/server/test-flatten-inflate.mjs`.
- **`glue-schemas.md`** — the flattened column schemas the server uses via `inflateUser()` to reconstruct nested Analytics shapes on read.
- **`package.json`** — `@aws-sdk/client-s3` + `@aws-sdk/client-secrets-manager` only; the Lambda runtime provides the rest.

## Conventions

- **Field names must match `flattenUser` → `inflateUser` contract**. Whenever the Analytics API schema changes, update both `collector/flatten.js` (write side) and `server/inflate.js` (read side) — plus the Glue columns in `infra/lib/storage-stack.ts`. A mismatch silently writes zeros.
- **Raw sidecar = retroactive recovery.** flatten.js maps fields EXPLICITLY, so new upstream fields are dropped from the columnar tables until a column is added. The `raw/<table>/` sidecar keeps the pristine records (no `snapshot_date` stamp), so a later column addition can re-flatten history from S3 instead of re-calling the API (~365-day lookback). Deliberately no Glue table over `raw/` — recovery safety net, not a query surface. Partitions written before 2026-07-12 have no raw sidecar unless backfilled.
- **NDJSON** (one JSON object per line). Athena/Glue are configured via `JsonSerDe`.
- **Partition dates** use the `date=YYYY-MM-DD` Hive convention. Glue projections cover 2026-01-01 → NOW.
- **`summariesStart`/`summariesEnd` are exclusive upper bound** — the Analytics API rejects ranges where `starting_date == ending_date`. Default behavior pulls the last 14 days of summaries.

## Backfill

Invoke the Lambda once per day for any window. Pick a `START` (the oldest day
that has Analytics API data — `2026-01-01` is the floor) and a `DAYS` count:

```bash
START=2026-04-01    # adjust as needed; do not pre-date 2026-01-01
DAYS=30
for d in $(seq 0 $((DAYS - 1))); do
  date=$(date -u -d "$START +$d days" +%Y-%m-%d)
  next=$(date -u -d "$date +1 day" +%Y-%m-%d)
  aws lambda invoke --region ap-northeast-2 \
    --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"date\":\"$date\",\"summariesStart\":\"$date\",\"summariesEnd\":\"$next\"}" \
    /tmp/out.json
done
```

Analytics-backfill invokes (any payload with an explicit `date`) SKIP the
compliance walk by default (`complianceDays=0`) — a 30-invoke loop must not
re-walk the same live compliance window 30 times against the shared 60 rpm
budget.

## Compliance archival (since 2026-07-15 — ADR-0017)

`archiveComplianceEvents` runs after the analytics snapshot on every
scheduled (dateless) invoke: walks `/v1/compliance/activities` backward via
`after_id` (newest-first; no timestamp filter exists), buckets events by
`created_at` UTC day, and writes `compliance/date=D/` + `raw/compliance/`
partitions for the last 2 COMPLETE days (T-1 + a T-2 idempotent overlap).
Non-obvious invariants:

- **Never shrink a partition**: only crossing below the window start
  (`stop='window'`) proves the oldest captured day complete; every other
  stop (page/time cap, empty page, `has_more=false` glitch) DROPS that day
  (`compliance_dropped_partial_day`) instead of overwriting a complete
  file with a shorter one. Newest-first order ⇒ T-1 completes before T-2,
  so budget cuts sacrifice only the overlap that yesterday already wrote.
- **Walk resilience**: 3-attempt retry on 429/5xx/network, 15 s per-page
  abort, 0.6 s pacing, `getRemainingTimeInMillis` guard at 60 s (Lambda
  timeout 15 min). Failures → `results.compliance_error` +
  `console.error`; the analytics snapshot is never sunk.
- **Volume reality (2026-07-15)**: ~6k events/day (largely the dashboard's
  own prewarm reads audited as `compliance_api_accessed`) — a 2-day window
  costs 110-150 pages, hence the 200-page default cap.
- **Deep backfill runs from a workstation** (repo-root `_local/backfill-compliance.mjs`
  pattern — paced full-feed walk writing every complete day); Lambda
  budgets can't reach weeks of history.
