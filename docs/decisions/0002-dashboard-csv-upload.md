# ADR-0002: In-dashboard Spend Report CSV upload

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: @whchoi98

## Context

The Cost page is the only part of the dashboard that depends on a CSV export from Anthropic Console (the Admin API does not expose the per-user × product × model granularity the Spend Report provides). Pre-this-change, refreshing the data required:

1. Anthropic Console → export Spend Report CSV.
2. Terminal: `aws s3 cp spend-report-*.csv s3://ccd-storage-archive…/spend-reports/`.
3. Page reload.

Two downsides: it gates Cost page freshness on AWS CLI access (only engineers have it), and it makes "replace the CSV because I uploaded the wrong one" a round-trip through the CLI again.

Requirement: let any dashboard-authenticated admin replace, add, or delete Spend Report CSVs without AWS CLI access.

## Options considered

### Option A — Browser → Express → S3 (multipart upload, chosen)

File picker on Cost page → `POST /api/cost/upload` (multipart) → Express uses `multer` to buffer in memory → `PutObjectCommand` to `spend-reports/`.

- **Pros**: Same-origin, no CORS. One network hop. Reuses the existing Cognito + Lambda@Edge auth gate automatically. Server-side validation (required columns, size cap, filename regex) in the same place as the consumer code. Simple to reason about.
- **Cons**: Express holds the bytes in memory — for our worst case (25 MB cap, 2 replicas, Fargate 1 GB) this is fine but it doesn't scale to GB-sized files.

### Option B — Pre-signed PUT URL (browser → S3 direct)

Backend issues a `GetSignedUrl(PutObject)` → browser PUTs the file directly to S3 with that URL.

- **Pros**: No server memory pressure. Handles GB-sized files. Nicer for progress bars.
- **Cons**: Three network flights (request pre-signed URL → PUT to S3 → notify server). Requires S3 bucket CORS config. Validation has to happen *after* the upload or in a Lambda-backed S3 event (much more infrastructure). Harder to return clean schema errors to the UI.

### Option C — No UI, better AWS CLI docs

Expand the "no data yet" empty state on the Cost page with a copy-paste-ready `aws s3 cp` command and a link to Anthropic Console.

- **Pros**: 0 new code.
- **Cons**: Doesn't solve the original problem — non-engineer admins still need CLI access.

## Decision

**Option A**. The failure mode of A (memory pressure at GB file sizes) is strictly outside Anthropic's Spend Report sizes — the worst real-world case for a 1000-user org × monthly export is ~4 MB. The 25 MB `multer.limits.fileSize` cap gives us 5× headroom. If we ever see GB-sized imports (e.g. multi-year backfill), Option B is a clean evolutionary step — the UI and auth gate don't change.

Operationally the scope grew beyond the original ask because:

- **`GET /api/cost/uploads`** (list): needed so the UI can show history + warn on period overlap.
- **`DELETE /api/cost/uploads/:file`**: needed so a mistaken upload can be undone without CLI access.

## Consequences

- **Positive**: Cost page is now self-service. The upload component (`src/components/CsvUploader.tsx`) is reusable for any future CSV ingests (e.g., budget forecasts). Server-side schema validation catches bad exports at ingest rather than producing empty charts later.
- **Negative**: Adding multer introduces a CVE watch surface — bumped to 2.x for the fix set. Filename patterns from Anthropic may drift (as seen with the `spend-report--YYYY-…` double-dash case); we now have to keep the regex tolerant. The ALB target holds the file bytes in memory briefly, so a very large body could add latency to concurrent requests during the upload.
- **Follow-ups**:
  - WAF `SizeRestrictions_BODY` rule was blocking this feature globally (bodies > 8 KB). Overridden to COUNT (see CHANGELOG). Revisit if we add a non-authenticated POST endpoint.
  - Consider S3 versioning on the `spend-reports/` prefix so a `DELETE` is recoverable.
  - Consider a "rename" action for uploaded files (right now a user who wants to fix a wrong filename needs to delete + re-upload).

## References

- [`server/aws.js`](../../server/aws.js) — `/api/cost/upload` / `/api/cost/uploads` / `/api/cost/uploads/:file` handlers.
- [`src/components/CsvUploader.tsx`](../../src/components/CsvUploader.tsx) — picker + preview + history UI.
- [`docs/api-reference.md`](../api-reference.md) — endpoint documentation.
- [`infra/lib/compute-stack.ts`](../../infra/lib/compute-stack.ts) — WAF `ruleActionOverrides` keeping this endpoint unblocked.
