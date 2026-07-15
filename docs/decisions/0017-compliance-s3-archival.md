# ADR-0017: Compliance audit events archived to S3 (compliance_daily)

- **Status**: Accepted
- **Date**: 2026-07-15
- **Deciders**: @whchoi98
- **Related**: [ADR-0004](0004-compliance-pagination-prewarm.md) · [ADR-0016](0016-audit-response-cache-partial-contract.md) · [ADR-0007](0007-athena-varchar-partitions.md)

## Context

The audit feed was the only data family served exclusively live: the UI's
in-memory response cache holds at most the newest 2000 events per window
(ADR-0016), and the upstream feed itself has finite retention. At the
2026-07 volume (~6k events/day — heavily self-amplified by the dashboard's
own prewarm reads being audited as `compliance_api_accessed`), 2000 events
now cover *hours*, not days. Long-horizon audit questions ("who exported
data in May?") had no home, and ADR-0016 explicitly listed the missing
Compliance→S3 archive as its accepted gap.

Two properties shape the design:

1. `/v1/compliance/activities` walks strictly newest→oldest via `after_id`;
   there is no timestamp filter and no forward cursor. Reaching day D means
   traversing every event newer than D.
2. Event payloads are dynamic per type (~20 types observed; `request_body`
   / `url` on API events, `group_id` on membership events, …) — a fully
   columnar schema would chase the upstream forever.

## Decision

1. **Daily archival in the collector Lambda** (`archiveComplianceEvents`):
   after the analytics snapshot, walk the feed backward and bucket events
   by their `created_at` UTC day into `compliance/date=YYYY-MM-DD/`
   NDJSON partitions plus the standard `raw/compliance/` sidecar. Default
   window: the last **2 complete UTC days** (T-1 + a T-2 overlap re-write
   as idempotent insurance). Compliance is real-time — no 3-day buffer.
2. **Hybrid schema**: stable envelope columns (`id`, `type`, `created_at`,
   `actor_*`, `organization_id`) + the **full original event as a JSON
   string** (`payload`). Athena reaches type-specific fields via
   `json_extract_scalar(payload, '$.field')` — no migration per new field.
   Glue table `compliance_daily` (6th table, same varchar-date partition
   projection as its siblings).
3. **Never shrink a partition**: only a walk that crossed *below* the
   window start proves the oldest captured day complete; any other stop
   (page/time cap, empty page, `has_more=false` glitch) drops that day
   instead of overwriting a previously complete file with a shorter one.
   Newest-first ordering means T-1 completes before T-2, so a budget cut
   sacrifices only the insurance overlap that yesterday's run already
   archived.
4. **Resilient walk**: 3-attempt retry on 429/5xx/network, 15 s per-page
   abort, 1.2 s inter-page pacing (shared 60 rpm budget),
   `getRemainingTimeInMillis` guard at a 60 s margin (Lambda timeout
   raised to 10 min). Failures land in `results.compliance_error` +
   `console.error` — never sink the analytics snapshot.
5. **Backfill runs from a workstation, not Lambda**: a paced deep walk
   (same flatten + retry pattern) writes every complete day the feed still
   retains — history depth × ~6k events/day exceeds any Lambda budget.
   Analytics-backfill invokes (payload with `date`) skip compliance by
   default (`complianceDays=0`) so a 30-invoke loop doesn't re-walk the
   same live window 30 times.
6. **Consumers**: `compliance_daily` joins the Athena allowlist, the
   chatbot schema hint (with an explicit event-time/no-3-day-buffer
   exception), and `/api/archive/query` — whose rows are now masked
   server-side (including `%40`-encoded emails inside recorded
   `url`/`request_body` strings) because free-form SQL output can't rely
   on render-time masking.

## Consequences

### Positive

- Audit history survives upstream retention and the 2000-event UI cap;
  Athena can answer arbitrary-horizon audit questions and join events
  against the analytics tables.
- The archive is complete-by-construction per partition (drop-guard), and
  the raw sidecar preserves unmapped future fields.

### Negative / accepted

- Data is one day behind (partitions end at yesterday; the live audit page
  covers the head). The daily walk must traverse today's partial events
  first — pure overhead that grows with volume.
- The dashboard's own reads inflate the feed it archives
  (`compliance_api_accessed` ≈ thousands/day). Follow-up candidate: an
  incremental head-merge for the prewarm (fetch only pages until a
  known event id) would cut self-noise ~90% and shrink every walk.
- `payload` duplicates the envelope columns (~2× storage) — accepted for
  schema stability; compliance volume is a few MB/day.
