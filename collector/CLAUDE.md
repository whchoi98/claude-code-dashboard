# collector — daily Analytics API snapshot Lambda

## Role

Node 20 Lambda. Fetches five Analytics API endpoints and writes partitioned NDJSON to `s3://<archive>/<table>/date=YYYY-MM-DD/`, plus a **raw sidecar** of the unflattened upstream records to `s3://<archive>/raw/<table>/date=YYYY-MM-DD/` (since 2026-07-12). Runs on an EventBridge rule at 14:00 UTC, or can be invoked manually with a `{ date, summariesStart, summariesEnd }` payload.

## Files

- **`handler.js`** — `export const handler`; resolves the Analytics API key from Secrets Manager (or `ANTHROPIC_ANALYTICS_KEY` env), paginates each endpoint, imports the flatten helpers from `flatten.js`, and writes NDJSON per partition.
- **`flatten.js`** — pure, dependency-free write-side helpers (`flattenUser`/`flattenSkill`/`flattenConnector`/`flattenProject`): nested Analytics API record → flat columnar NDJSON row. The read-side inverse is `server/inflate.js` `inflateUser()`; the two are unit-tested together in `tests/server/test-flatten-inflate.mjs`.
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

Note: the Compliance audit feed is NOT backfilled here — it's served live
(with cursor pagination + a 5-minute startup prewarm in the Express server).
Only Analytics endpoints (users / summaries / skills / connectors / projects)
land in S3.
