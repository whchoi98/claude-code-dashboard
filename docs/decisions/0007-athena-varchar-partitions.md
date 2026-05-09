# ADR-0007 — Athena partitions stored as `varchar`

**Status**: Accepted (codifies existing Glue schema)
**Date**: 2026-05-09
**Driver commit**: Archive `athena_error` fix in v0.4.0

## Context

The Glue tables produced by `infra/lib/storage-stack.ts` partition
`date` as **`varchar`**, not `DATE`:

```ts
partitionKeys: [{ name: 'date', type: 'string' }],
parameters: {
  'projection.date.type':     'date',
  'projection.date.format':   'yyyy-MM-dd',
  'projection.date.range':    '2026-01-01,NOW',
}
```

Partition projection is set to `date` so the planner still does proper
range pruning, but the **column itself is varchar** because the S3
prefix is a literal `date=YYYY-MM-DD/` string emitted by the collector.

This combination is fine in isolation, but it bites when SQL is written
the way you'd expect from the schema hint:

```sql
-- BROKEN on Athena Engine v3
WHERE date BETWEEN DATE '2026-04-01' AND DATE '2026-04-30'
-- TYPE_MISMATCH: Cannot check if varchar is BETWEEN date and date
```

Trino (Athena Engine v3) refuses to auto-cast varchar to DATE for
`BETWEEN` comparisons. The Archive page's pre-filled query and the
`/api/analyze` SQL-mode prompt both shipped with the broken form,
so every default query the user could click failed with `athena_error`.

## Decision

Keep the partition column as **`varchar` storing `YYYY-MM-DD`** (don't
migrate to `DATE`), and **mandate plain string literals** in WHERE
clauses:

```sql
-- CORRECT
WHERE date BETWEEN '2026-04-01' AND '2026-04-30'
```

Rationale for not switching to a `DATE` column:

- The collector writes ISO strings to S3 prefixes; switching the column
  type would require a data migration and a Glue table rebuild.
- Zero-padded ISO dates compare correctly as strings (`'2026-04-01' <
  '2026-04-30'` is true), so partition pruning still works.
- Partition projection (`projection.date.type: 'date'`) already
  optimizes range scans regardless of the storage column type.

## Consequences

- `src/pages/Archive.tsx` — pre-filled query uses string literals.
- `server/aws.js` — `ATHENA_SCHEMA_HINT` block (consumed by the LLM in
  SQL mode) explicitly tells Claude **not** to wrap dates in `DATE
  '...'` and references the TYPE_MISMATCH error so failed runs become
  self-correcting.
- `runAthena` polling timeout was bumped to 60s with an explicit
  timeout error in the same change set — unrelated to the type
  mismatch but bundled because both surfaced as `athena_error`.

## How to revisit

If we ever migrate the underlying storage to a `DATE`-typed partition
(e.g., switching to Iceberg tables with a different partitioning
scheme), update the Archive default query and the LLM schema hint at
the same time. The two prompts in `server/aws.js` and `Archive.tsx`
are the canonical sources of "this is the right way to filter by
date" — keep them aligned.
