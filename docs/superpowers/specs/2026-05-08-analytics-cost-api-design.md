# Hybrid Live Cost API + CSV Reconciliation — Design

- **Status**: Proposed
- **Date**: 2026-05-08
- **Owners**: @whchoi98
- **Supersedes**: nothing — *supplements* [ADR-0002](../../decisions/0002-dashboard-csv-upload.md)
- **Related**: [ADR-0003 (forthcoming)](../../decisions/0003-hybrid-live-cost.md)

## Context

The Cost page (`src/pages/Cost.tsx`) currently sources its data from a manually
uploaded Spend Report CSV under `s3://<archive>/spend-reports/`. ADR-0002 chose
this path because, at the time, the Admin API did not expose the per-user ×
product × model granularity the CSV provides.

Two facts have changed:

1. **The Anthropic Analytics API now exposes per-user token and USD spend** for
   the entire Claude platform, with a 4-hour refresh cadence and a 30-day
   correction window for recent dates.
2. **This codebase already proxies `/v1/organizations/usage_report/claude_code`**
   (the Claude Code Analytics API) via `/api/admin/claude-code/range`. Its
   response carries `model_breakdown[].estimated_cost.amount` (cents USD) per
   user — i.e. the data we need is *already in hand*, just unused on the Cost
   page.

The result: the dominant pain ("operators must download a Console CSV every
month") can be eliminated for Claude Code usage **without** new credentials,
infrastructure, or external dependencies. The CSV path retains its role for
finance reconciliation (where the 30-day correction window matters) and for
non-Claude-Code products (Chat, Cowork, etc.) which the
`usage_report/claude_code` endpoint does not cover.

## Goals (v1)

1. Cost page loads live without any prior CSV upload, for the Claude Code
   product.
2. Per-user × model spend / tokens for any selected date range, using the
   existing date range control.
3. Time-series ("Trends") section showing daily spend by model.
4. CSV upload remains available for finance reconciliation (≥30 days back) and
   non-Claude-Code product coverage.
5. Auto-fallback: if the live API is unreachable (missing key, upstream 5xx,
   empty), the page silently falls back to the latest CSV.

## Non-goals (v2 candidates)

1. Migrating `/api/cost/efficiency` (the CSV × users/range join) to live API.
2. Live cost for non-Claude-Code products (Chat, Cowork, Browser Extension,
   Excel, PowerPoint).
3. Context-window / inference-geo dimensions in the UI.
4. Collector Lambda extension to snapshot cost data into S3 NDJSON.
5. Deprecation of CSV upload (retained as the reconciliation source of truth).

## Decisions (recorded from brainstorming)

| # | Question | Choice | Rationale |
|---|----------|--------|-----------|
| Q1 | End state | **Hybrid** — API primary, CSV as ≥30-day reconciliation source | 30-day correction window means API is unsuitable for billing-grade totals; CSV remains finance source of truth |
| Q2 | v1 scope | **MVP-Standard** — per-user spend/token + product/model time-series trends | Per-user replaces CSV's primary use; trends answer "month-over-month" question CSV cannot |
| Q3 | Data fetch | **Live API + 5-min in-memory cache** | Matches existing Admin API pattern in `server/index.js`. No new infra. No re-snapshot complexity from 30-day mutation window |
| Q4 | UI placement | **Inline in `Cost.tsx`, automatic fallback** | Reuses existing `PageHeader` `source` badge. Operators have one place for cost. Auto-fallback keeps page alive when API is unreachable |
| Q5 | Spec source | **Anthropic public docs (verified)** | `/v1/organizations/usage_report/claude_code` schema confirmed via `platform.claude.com/docs/en/api/admin-api/claude-code/get-claude-code-usage-report` |
| App | Implementation | **Approach A — minimal direct wiring** | Uses already-proxied endpoint. Zero new credentials. ~250-350 LOC change |

## API surface (verified)

`GET /v1/organizations/usage_report/claude_code` (Admin API, key
`sk-ant-admin...`) — already wired in this repo as `/api/admin/claude-code` and
its date-range fan-out `/api/admin/claude-code/range`.

Response (per record, day × actor):

```json
{
  "date": "2026-04-15T00:00:00Z",
  "actor": { "type": "user_actor", "email_address": "dev@example.com" },
  "core_metrics": { "num_sessions": 5, "lines_of_code": {"added": 1543, "removed": 892}, "commits_by_claude_code": 12, "pull_requests_by_claude_code": 2 },
  "tool_actions": { "edit_tool": {"accepted": 45, "rejected": 5}, ... },
  "model_breakdown": [
    {
      "model": "claude-opus-4-7",
      "tokens": {"input": 100000, "output": 35000, "cache_read": 10000, "cache_creation": 5000},
      "estimated_cost": {"currency": "USD", "amount": 1025}
    }
  ]
}
```

Constraints:

- **`actor` may be `user_actor` (email) or `api_actor` (api_key_name)** — both
  appear in real responses.
- **`amount` is in cents (minor units)** — must divide by 100 for USD display.
- **Data freshness ≤ 1 hour** for this endpoint (per docs); newer events not yet
  reflected.
- **Single-day query only** — multi-day requires fan-out (already handled by
  existing `/api/admin/claude-code/range`).

## Architecture

```
Browser (Cost.tsx)
  │
  ├─ Try: GET /api/cost/live?starting_date=&ending_date=
  │       │
  │       ▼
  │  Express (server/aws.js)
  │  registerCostLiveRoute → reuses internal range fan-out
  │       │
  │       ▼
  │  GET /v1/organizations/usage_report/claude_code (per day)
  │       │
  │       ▼
  │  Reshape (claudeCodeRangeToCostResp): aggregate per user × model
  │  across the date range; convert cents → USD; flag `source: "live"`
  │       │
  │       ▼
  │  Response shape EQUAL to /api/cost/csv (CsvResp) so the UI is symmetric
  │
  └─ Fallback (any of: missing admin key / upstream error / empty data):
     GET /api/cost/csv (existing, unchanged)
     Server returns `source: "csv"`

Trends section: client-side aggregates the live response by `date × model`
into a stacked area chart. (CSV mode: trends section is hidden — CSV is a
single-period snapshot, no daily granularity.)

Cache: existing 5-minute in-memory cache in server/index.js; reused via the
internal /admin/claude-code/range call path.
```

## Component changes

### Server (`server/aws.js`)

One new route handler:

```js
// GET /api/cost/live?starting_date=YYYY-MM-DD&ending_date=YYYY-MM-DD
//
// Reuses the existing /admin/claude-code/range internal logic, then reshapes
// the per-day actor records into a CsvResp-compatible payload.
//
// Errors:
//   400 admin_key_required        → ANTHROPIC_ADMIN_KEY not configured
//   502 upstream_error            → Anthropic API non-2xx
//   200 source=live with rows=[]  → empty period (UI handles → fallback to CSV)
router.get('/cost/live', async (req, res) => { ... })
```

Reshape function (also in `aws.js`):

```js
function claudeCodeRangeToCostResp(rangeBody, period) {
  // rangeBody: { days: [{ date, data: [actor records...] }] }
  // Aggregate across all days: key = (user_email, model)
  // user_email derived from actor.email_address OR `API key: ${actor.api_key_name}`
  // product hardcoded to "Claude Code"
  // total_prompt_tokens   = sum(input + cache_read + cache_creation)
  // total_completion_tokens = sum(output)
  // total_net_spend_usd   = sum(estimated_cost.amount) / 100
  // total_gross_spend_usd = same as net (no separate gross from this API)
  // total_requests        = sum(num_sessions) per user — note: approximation
  //
  // Returns: { source: "live", file: null, last_modified: <ISO>, period, rows, totals }
}
```

**Existing routes are not modified.** `/api/admin/claude-code/range`,
`/api/cost/csv`, `/api/cost/efficiency`, `/api/cost/upload` are all kept as-is.

### Frontend (`src/pages/Cost.tsx`)

Composite hook for live-with-fallback:

```ts
function useCostData(range) {
  const live = useFetch<CostResp>(`/api/cost/live?starting_date=${range.startingDate}&ending_date=${range.endingDate}`)
  const csv  = useFetch<CostResp>('/api/cost/csv', {
    enabled: !!live.error || (live.data?.rows.length === 0),
  })
  // returns { data, loading, error, source: 'live' | 'csv' | null, refetch }
}
```

The existing `agg` `useMemo` (lines 121-185) is unchanged — it operates on
`CsvRow[]` which both sources produce.

UI additions:

- `<DateRangeControl />` shown above the KPI grid (currently only used by the
  efficiency section).
- `PageHeader source={...}` switches dynamically between `"live"` and `"csv"`.
- Amber 30-day caveat banner above KPI grid when `source === "live"`.
- `<ChartCard title={t('cost.trends.title')}>` with stacked area by model,
  rendered only in live mode (CSV has no daily granularity).
- `<details>` expander labeled `cost.recon.expander` containing `<CsvUploader />`
  and the upload history list. Auto-opens when `source === "csv"` or on
  `no_spend_report` error.
- KPI "Requests" label gets a `*` and tooltip in live mode: *"approximate; based
  on session count"*.

### i18n keys (en + ko in `src/lib/i18n.tsx`)

```
cost.source.live              "Live API"            / "라이브 API"
cost.source.csv               "Reconciliation CSV"  / "정산 CSV"
cost.live.caveat.30day        "Values within the last 30 days may be revised as new events are reflected"
                              / "최근 30일 내 값은 신규 이벤트 반영에 따라 변경될 수 있습니다"
cost.live.requests.approx     "Approximate (session count)" / "추정값 (세션 수 기준)"
cost.trends.title             "Daily spend by model"  / "모델별 일별 지출"
cost.trends.subtitle          "Live API · Claude Code only"  / "라이브 API · Claude Code 한정"
cost.recon.expander           "Reconciliation CSV (≥ 30 days)" / "정산 CSV (30일 이전)"
```

### Types

In `src/pages/Cost.tsx` (or hoisted to `types.ts` if reused):

```ts
type CostSource = 'live' | 'csv'
type CostResp = Omit<CsvResp, 'source'> & { source: CostSource; file: string | null }
```

### Documentation

- `docs/api-reference.md` — append a row under "Cost" for `GET /api/cost/live`.
- `docs/decisions/0003-hybrid-live-cost.md` — new ADR linking to this spec.

## Error handling

| Scenario | Server | Frontend |
|---|---|---|
| `ANTHROPIC_ADMIN_KEY` unset | `/api/cost/live` → 400 `admin_key_required` | Use CSV. `source="csv"` + small badge "Admin key not configured" |
| Upstream 4xx (scope, expired) | `/api/cost/live` → propagated status | Use CSV. Log full body to console for diagnosis |
| Upstream 5xx | `/api/cost/live` → 502 `upstream_error` | Use CSV. Show "Retry" button |
| Live OK, rows=[] | `/api/cost/live` → 200 `source=live, rows=[]` | If CSV exists, use CSV with notice "No live data yet". If neither, EmptyState |
| CSV missing too | `/api/cost/csv` → 404 `no_spend_report` | EmptyState + auto-open uploader |
| 30-day mutation | (server passes through, no special handling) | Always show amber banner in live mode |

The `useFetch` retry semantics already cover transient network blips; no new
retry policy needed.

## Test strategy

### Unit tests (server/aws.js)

- `claudeCodeRangeToCostResp` happy path — 2 days × 2 users × 2 models
- empty `rangeBody.days` → returns `rows: [], totals: zeros`
- API actor (no email_address) → `user_email = "API key: <name>"`
- cents → USD conversion (1025 cents → 10.25 USD; verify rounding)
- multiple actors, same email across days → aggregated, not duplicated
- model name passthrough (no normalization)

### Manual smoke (in `npm run dev`)

1. Open Cost page with default 30d range → live data shows, source badge "live"
2. Verify KPI total = sum of `model_breakdown[].estimated_cost.amount` / 100 across rows
3. Trends section: hover over a day, value matches that day's spend
4. Change date range to 7d → page reloads from cache or fresh fetch
5. Comment out `ANTHROPIC_ADMIN_KEY` in `.env` → page falls back to CSV automatically
6. Restore key → next reload returns to live
7. Upload a fresh CSV via expander → no break, but live remains primary
8. Empty range (very old dates) → EmptyState OR CSV fallback

### Regression checks

- `/api/cost/csv` response unchanged (curl + diff)
- `/api/cost/efficiency` unchanged
- `/api/admin/claude-code/range` unchanged
- ECS task definition: no new env vars
- WAF: no new endpoints needed (no body restriction triggers)

## Out of scope (v2 follow-ups)

1. **Live cost for non-CC products**: requires verifying the Analytics-key
   variant of the API (the user's "Claude 플랫폼 전반" claim) once Anthropic
   docs for that surface stabilize. Current docs page
   `/docs/en/api/analytics-api` returned "Not Found - Loading…" during this
   spec's research phase.
2. **`/api/cost/efficiency` migration**: replace the CSV side of the join with
   live spend data. Separate PR for blast radius reasons.
3. **Context-window / region dimensions** (`context_window`, `inference_geo`):
   visualize cost split between 200K vs 1M context modes, or by region.
4. **Collector S3 archive of cost data** for ranges beyond Analytics API's
   90-day window. Re-snapshot policy needed (30-day mutation window).
5. **ADR-0002 deprecation**: mark superseded once non-CC product coverage
   lands.

## Risk and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `total_requests` metric drift (sessions ≠ requests) | High | UI tooltip + i18n note; document approximation in api-reference.md |
| 30-day mutation surprises finance team | Medium | Amber banner; CSV remains canonical for billing |
| Admin key scope mismatch | Low | Existing `/admin/claude-code` already validates this; same code path |
| Cents/USD unit confusion in reshape | Medium | Unit test for conversion; type the field as `usd: number` post-conversion |
| API actor records polluting per-user charts | Medium | Distinct `"API key: …"` namespace prevents collision with email-keyed users |
| 5-min cache hides recently fixed CSV upload | Low | Fallback path bypasses cache (CSV reads S3 directly) |

## Estimated change footprint

- 1 new server route + reshape function in `server/aws.js` (~100-130 LOC)
- `src/pages/Cost.tsx` modifications (~80-120 LOC; mostly hook + new sections)
- 7 new i18n key pairs in `src/lib/i18n.tsx` (~20 LOC)
- 1 row in `docs/api-reference.md`
- 1 new file `docs/decisions/0003-hybrid-live-cost.md` (~80 LOC)
- 1 unit test file (~50-80 LOC)

**Total: ~330-470 LOC across 5-6 files. Zero infrastructure changes. Zero new
ECS env vars. Zero new IAM policies.**

## Open questions for implementation

None blocking. The following can be resolved during PR review without changing
this spec:

1. Should the reshape function live in `server/aws.js` or a new
   `server/cost.js` file? (Style preference — `aws.js` already has cost
   handlers so it's a natural home.)
2. Trends chart: stacked area vs stacked bar? (Recommend stacked area for
   continuity.)
3. KPI count under "Distinct users": should `API key:` actors be counted as
   users? (Recommend separate count exposed in tooltip.)
