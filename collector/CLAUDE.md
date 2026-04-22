# collector — daily Analytics API snapshot Lambda

## Role

Node 20 Lambda. Fetches five Analytics API endpoints and writes partitioned NDJSON to `s3://<archive>/<table>/date=YYYY-MM-DD/`. Runs on an EventBridge rule at 14:00 UTC, or can be invoked manually with a `{ date, summariesStart, summariesEnd }` payload.

## Files

- **`handler.js`** — `export const handler`; resolves the Analytics API key from Secrets Manager (or `ANTHROPIC_ANALYTICS_KEY` env), paginates each endpoint, and writes NDJSON per partition.
- **`glue-schemas.md`** — the flattened column schemas the server uses via `inflateUser()` to reconstruct nested Analytics shapes on read.
- **`package.json`** — `@aws-sdk/client-s3` + `@aws-sdk/client-secrets-manager` only; the Lambda runtime provides the rest.

## Conventions

- **Field names must match `flattenUser` → `inflateUser` contract**. Whenever the Analytics API schema changes, update both `collector/handler.js` (write side) and `server/index.js` (read side). A mismatch silently writes zeros.
- **NDJSON** (one JSON object per line). Athena/Glue are configured via `JsonSerDe`.
- **Partition dates** use the `date=YYYY-MM-DD` Hive convention. Glue projections cover 2026-01-01 → NOW.
- **`summariesStart`/`summariesEnd` are exclusive upper bound** — the Analytics API rejects ranges where `starting_date == ending_date`. Default behavior pulls the last 14 days of summaries.

## Backfill

Invoke Lambda per day:

```bash
for d in $(seq 0 28); do
  date=$(date -u -d "2026-03-22 +$d days" +%Y-%m-%d)
  next=$(date -u -d "$date +1 day" +%Y-%m-%d)
  aws lambda invoke --region ap-northeast-2 \
    --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"date\":\"$date\",\"summariesStart\":\"$date\",\"summariesEnd\":\"$next\"}" \
    /tmp/out.json
done
```
