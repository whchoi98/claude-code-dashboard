# collector — daily Analytics API snapshot Lambda

## Role

Node 20 Lambda. Fetches six Analytics API endpoints (users, summaries, skills, connectors, chat projects, plugins — plugins since v2.2/2026-08) **plus the Compliance audit feed** and writes partitioned NDJSON to `s3://<archive>/<table>/date=YYYY-MM-DD/`, plus a **raw sidecar** of the unflattened upstream records to `s3://<archive>/raw/<table>/date=YYYY-MM-DD/` (since 2026-07-12; compliance since 2026-07-15 — ADR-0017). Runs on TWO EventBridge rules — **14:00 UTC analytics-only** (payload `{complianceDays: 0}`) and **00:30 UTC compliance-only** (payload `{complianceOnly: true}`; each day is a bounded `created_at` query since ADR-0022, so the schedule no longer changes the cost — it is kept as is). Manual invokes accept `{ date, summariesStart, summariesEnd, complianceOnly, complianceStart, complianceEnd, complianceDays, compliancePages, allowRedactedOverwrite, org }`.

**Multi-org (contract 2026-07-21)**: every run loops orgs — `primary` (legacy env `ANTHROPIC_ANALYTICS_KEY(_SECRET_ARN)`, legacy S3 paths EXACTLY) then `org2` (env `ANTHROPIC_ANALYTICS_KEY_2(_2_SECRET_ARN)`, S3 keys under the `org2/` prefix in both the columnar tables AND the raw sidecar). org2 runs only when its env is configured; payload `org: 'primary'|'org2'` limits a manual run to one org (unknown values throw). Result convention: primary keeps unprefixed keys (`writes.users`, `counts.compliance_events`), org2 keys carry `org2_` (`writes.org2_users`, `counts.org2_compliance_events`); the return also lists `orgs`. The `getRemainingTimeInMillis` guard covers the whole multi-org run — a later org is skipped (`writes.org2_skipped: 'time'`) when < 90 s remain.

## Files

- **`handler.js`** — `export const handler`; resolves each org's Analytics API key from Secrets Manager (or plain env), cached per org, paginates each endpoint, imports the flatten helpers from `flatten.js`, and writes NDJSON per partition. Exports the pure org helpers (`orgsForRun`/`orgConfigured`/`orgS3Prefix`/`orgKeyPrefix`) tested in `tests/server/test-collector-orgs.mjs`.
- **`flatten.js`** — pure, dependency-free write-side helpers (`flattenUser`/`flattenSkill`/`flattenConnector`/`flattenProject`/`flattenPlugin`/`flattenActivity`): nested Analytics API record → flat columnar NDJSON row. The read-side inverse is `server/inflate.js` `inflateUser()`; the two are unit-tested together in `tests/server/test-flatten-inflate.mjs`.
- **`glue-schemas.md`** — the flattened column schemas the server uses via `inflateUser()` to reconstruct nested Analytics shapes on read.
- **`package.json`** — `@aws-sdk/client-s3` + `@aws-sdk/client-secrets-manager` only; the Lambda runtime provides the rest.

## Conventions

- **Field names must match `flattenUser` → `inflateUser` contract**. Whenever the Analytics API schema changes, update both `collector/flatten.js` (write side) and `server/inflate.js` (read side) — plus the Glue columns in `infra/lib/storage-stack.ts`. A mismatch silently writes zeros.
- **Raw sidecar = retroactive recovery.** flatten.js maps fields EXPLICITLY, so new upstream fields are dropped from the columnar tables until a column is added. The `raw/<table>/` sidecar keeps the pristine records (no `snapshot_date` stamp), so a later column addition can re-flatten history from S3 instead of depending on the live API retention window. Deliberately no Glue table over `raw/` — recovery safety net, not a query surface. Partitions written before 2026-07-12 have no raw sidecar unless backfilled.
- **NDJSON** (one JSON object per line). Athena/Glue are configured via `JsonSerDe`.
- **Partition dates** use the `date=YYYY-MM-DD` Hive convention. Glue projections cover 2026-01-01 → NOW.
- **`summariesStart` is inclusive; `summariesEnd` is an exclusive upper bound** — the Analytics API rejects ranges where `starting_date == ending_date`. Default behavior pulls the last 14 days of summaries.

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

## Compliance archival (since 2026-07-15 — ADR-0017, bounded days since 2026-09-26 — ADR-0022)

`archiveComplianceEvents` runs when the payload enables a compliance window.
The 14:00 analytics rule sets `complianceDays: 0`; the 00:30 compliance-only rule
archives the last 2 COMPLETE UTC days (T-1 + a T-2 idempotent overlap) into
`compliance/date=D/` + `raw/compliance/`. Each day is its OWN bounded query
(`collectComplianceDay`): `created_at.gte=D` / `created_at.lt=D+1`,
`limit=2000`, next page via the response's opaque `last_id` (fallback: the
last event id) — about 3 requests per day at ~6k events/day, where the old
unfiltered backward walk cost 110-150 pages per run.
Non-obvious invariants:

- **Never shrink a partition**: a day is complete only on an EMPTY page
  that doesn't claim `has_more:true`, or a SHORT page (fewer events than
  requested) with an explicit `has_more:false`. A full page whose flag says
  false, or any page without the flag, is confirmed with one more request. A page/time cap, an empty page that still claims `has_more`, or a
  zero-event day is recorded in `results.compliance_day_status`
  (`incomplete_*` / `empty_not_written`; registered before the loop, so it
  survives a mid-run throw) and NOT written — the same-key
  PutObject would replace a complete file with a shorter one. Days run
  newest first, so a budget cut drops only the T-2 overlap that yesterday
  already wrote.
- **Name-redaction guard**: since 2026-09-24 the feed no longer returns file,
  project-document or artifact names (retroactively). A partition is last
  written two days after its date, so days up to 2026-09-22 may still hold
  the names; days before `COMPLIANCE_REDACTION_GUARD_BEFORE` (2026-09-24)
  are skipped (`skipped_redaction_guard`) unless the payload sets
  `allowRedactedOverwrite: true`.
- **Walk resilience**: 3-attempt retry on 429/5xx/network, 30 s per-page
  abort (2000-event pages are a few MB), 1 s pacing between pages,
  `getRemainingTimeInMillis` guard at 60 s (Lambda timeout 15 min). Failures
  → `results.compliance_error` + `console.error`; the analytics snapshot is
  never sunk. `compliancePages` is the per-DAY page cap (default 50).
- **Deep backfill**: a `complianceStart`/`complianceEnd` payload now walks
  each day as a bounded query (~3 requests/day), so a Lambda invoke can cover
  weeks. The repo-root `_local/backfill-compliance.mjs` workstation script
  still does the old full-feed walk and writes S3 directly — it bypasses the
  redaction guard.
