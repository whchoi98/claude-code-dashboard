# Anthropic API field reference

> Scope: documents the **upstream Anthropic API contract** (Analytics + Compliance) as consumed by this dashboard. For the project's own `/api/*` proxy surface, see [`api-reference.md`](./api-reference.md).

This file is the source of truth for "what fields does Anthropic actually return" — extracted from `src/types.ts`, `server/aws.js`, `server/index.js`, `collector/handler.js`, and `src/pages/Compliance.tsx`. Update it when you discover a new field; the LLM SQL prompt in `server/aws.js` and the Glue schema in `collector/glue-schemas.md` should be kept in lockstep.

| Family | Base URL | Auth header | Key scope |
|---|---|---|---|
| Analytics — productivity + cost | `https://api.anthropic.com/v1/organizations/analytics/*` | `x-api-key: sk-ant-api01-…` | Analytics |
| Compliance | `https://api.anthropic.com/v1/compliance/*` | `x-api-key: sk-ant-api01-…` | Compliance |
| Admin (still wired but not the primary cost path in v0.5.x) | `https://api.anthropic.com/v1/organizations/usage_report/*` + `/cost_report` | `x-api-key: sk-ant-admin01-…` | Admin |

All three keys also need the `anthropic-version: 2023-06-01` header.

---

## 0. Official Anthropic documentation

The tables below were reverse-engineered from the live API responses observed by this project — they reflect what the dashboard actually consumes, not necessarily everything Anthropic publishes. **Always cross-check against the canonical docs before relying on a field, especially when adding a new endpoint or chasing a schema change.**

### Analytics API

| Doc | URL |
|---|---|
| Claude Code Analytics API — overview, scopes, all `/v1/organizations/analytics/*` endpoints (users, summaries, skills, connectors, chat projects, cost_report, usage_report) | <https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api> |
| Claude Code Analytics API (LLM-friendly raw markdown) | <https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api.md> |

### Compliance API

| Doc | URL |
|---|---|
| Compliance API — overview | <https://platform.claude.com/docs/en/manage-claude/compliance-api> |
| Get access (key provisioning + scopes) | <https://platform.claude.com/docs/en/manage-claude/compliance-api-access> |
| Activity Feed — query patterns, pagination semantics, retention | <https://platform.claude.com/docs/en/manage-claude/compliance-activity-feed> |
| API reference root | <https://platform.claude.com/docs/en/api/compliance> |
| Query compliance activities (`GET /v1/compliance/activities`) | <https://platform.claude.com/docs/en/api/compliance/activities/list> |
| Errors | <https://platform.claude.com/docs/en/manage-claude/compliance-errors> |
| Design your integration (recommended access patterns) | <https://platform.claude.com/docs/en/manage-claude/compliance-integration-patterns> |
| FAQ | <https://platform.claude.com/docs/en/manage-claude/compliance-faq> |

### Tip for Claude (or any LLM) reading these docs

The human-facing URLs above (no suffix) return a Mintlify SPA — fine for a browser but useless for `curl` or `WebFetch`. For agent consumption append `.md` to any URL above to get a plain-markdown rendering of the same page (e.g. `…/compliance-activity-feed.md`). The whole doc tree's URL list lives at <https://docs.claude.com/llms.txt>.

---

## 1. Analytics API — productivity family

Canonical reference: [Claude Code Analytics API](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api).

### `GET /v1/organizations/analytics/users?date=YYYY-MM-DD`

Per-user engagement + Claude Code productivity for a single day. Response is `{ data: UserRecord[], next_page, has_more }`.

#### `UserRecord`

| Field | Type | Notes |
|---|---|---|
| `user.id` | string | Anthropic user UUID |
| `user.email_address` | string | render via `maskEmail()` |
| `chat_metrics.distinct_conversation_count` | number | |
| `chat_metrics.message_count` | number | |
| `chat_metrics.thinking_message_count` | number | extended-thinking turns |
| `chat_metrics.distinct_projects_used_count` | number | |
| `chat_metrics.distinct_projects_created_count` | number | |
| `chat_metrics.distinct_artifacts_created_count` | number | |
| `chat_metrics.distinct_skills_used_count` | number | |
| `chat_metrics.connectors_used_count` | number | |
| `chat_metrics.distinct_files_uploaded_count` | number | |
| `chat_metrics.shared_conversations_viewed_count` | number? | optional |
| `chat_metrics.distinct_shared_artifacts_viewed_count` | number? | optional |
| `claude_code_metrics.core_metrics.distinct_session_count` | number | |
| `claude_code_metrics.core_metrics.commit_count` | number | by Claude Code |
| `claude_code_metrics.core_metrics.pull_request_count` | number | by Claude Code |
| `claude_code_metrics.core_metrics.lines_of_code.added_count` | number | |
| `claude_code_metrics.core_metrics.lines_of_code.removed_count` | number | |
| `claude_code_metrics.tool_actions.edit_tool.{accepted,rejected}_count` | number | |
| `claude_code_metrics.tool_actions.multi_edit_tool.{accepted,rejected}_count` | number | |
| `claude_code_metrics.tool_actions.write_tool.{accepted,rejected}_count` | number | |
| `claude_code_metrics.tool_actions.notebook_edit_tool.{accepted,rejected}_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.distinct_session_count` | number | `word` is optional |
| `office_metrics.{excel,powerpoint,word?}.message_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.skills_used_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.distinct_skills_used_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.connectors_used_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.distinct_connectors_used_count` | number | |
| `cowork_metrics.distinct_session_count` | number | |
| `cowork_metrics.action_count` | number | |
| `cowork_metrics.dispatch_turn_count` | number | |
| `cowork_metrics.message_count` | number | |
| `cowork_metrics.skills_used_count` | number | |
| `cowork_metrics.distinct_skills_used_count` | number | |
| `cowork_metrics.connectors_used_count` | number | |
| `cowork_metrics.distinct_connectors_used_count` | number | |
| `web_search_count` | number | per-user web-search invocations |

> ⚠ No USD / cost / token field on this endpoint. Use `cost_report` + `usage_report` for spend, joined client-side.

### `GET /v1/organizations/analytics/summaries?starting_date=&ending_date=`

Org-wide daily roll-up over the requested range. Returns `{ data: Summary[] }` (server normalizes Anthropic's `summaries` key → `data`).

#### `Summary`

| Field | Type | Notes |
|---|---|---|
| `starting_at` | string | ISO 8601 — bucket start, e.g. `2026-05-09T00:00:00Z` |
| `ending_at` | string | ISO 8601 — bucket end (exclusive) |
| `daily_active_user_count` | number | DAU |
| `weekly_active_user_count` | number | rolling 7-day |
| `monthly_active_user_count` | number | rolling 30-day |
| `cowork_daily_active_user_count` | number | |
| `cowork_weekly_active_user_count` | number | |
| `cowork_monthly_active_user_count` | number | |
| `assigned_seat_count` | number | |
| `pending_invite_count` | number | |
| `daily_adoption_rate` | number | percent (0-100) — DAU ÷ assigned_seat_count |
| `weekly_adoption_rate` | number | percent |
| `monthly_adoption_rate` | number | percent |

### `GET /v1/organizations/analytics/skills?date=YYYY-MM-DD`

#### `Skill`

| Field | Type | Notes |
|---|---|---|
| `skill_name` | string | |
| `distinct_user_count` | number | per-day distinct |
| `chat_metrics.distinct_conversation_skill_used_count` | number | |
| `claude_code_metrics.distinct_session_skill_used_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.distinct_session_skill_used_count` | number | |
| `cowork_metrics.distinct_session_skill_used_count` | number | |

### `GET /v1/organizations/analytics/connectors?date=YYYY-MM-DD`

#### `Connector`

| Field | Type | Notes |
|---|---|---|
| `connector_name` | string | |
| `distinct_user_count` | number | |
| `chat_metrics.distinct_conversation_connector_used_count` | number | |
| `claude_code_metrics.distinct_session_connector_used_count` | number | |
| `office_metrics.{excel,powerpoint,word?}.distinct_session_connector_used_count` | number | |
| `cowork_metrics.distinct_session_connector_used_count` | number | |

### `GET /v1/organizations/analytics/apps/chat/projects?date=YYYY-MM-DD`

#### `ChatProject`

| Field | Type | Notes |
|---|---|---|
| `project_id` | string | |
| `project_name` | string | mid-window renames are common — take latest day |
| `distinct_user_count` | number | |
| `distinct_conversation_count` | number | |
| `message_count` | number | |
| `created_at` | string | ISO 8601 |
| `created_by.id` | string | Actor — Anthropic user UUID |
| `created_by.email_address` | string | mask before display |

---

## 2. Analytics API — cost family

Canonical reference: [Claude Code Analytics API §Cost & usage reports](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api).

> ADR-0003 documents the decision to use these two endpoints (with the analytics key) instead of the admin-key cost path.

### `GET /v1/organizations/analytics/cost_report?starting_date=&ending_date=`

Response: `{ data: [{ starting_at, ending_at, results: [...] }] }` — one envelope per day.

#### `cost_report.results[]`

| Field | Type | Notes |
|---|---|---|
| `product` | string\|null | e.g. `"Claude Code"`, `"Chat"`, `"Cowork"`. Null on un-grouped totals — **skip these** to avoid double-counting. |
| `model` | string\|null | e.g. `"claude_sonnet_4_6"`, `"claude_opus_4_6"`. Null on un-grouped totals. |
| `amount` | string | **Decimal string in MINOR currency units (cents).** Parse with `parseFloat` then `/100` — do not round, the value can carry sub-cent precision. |
| `requests` | number | request count for the (product, model, day) bucket |

### `GET /v1/organizations/analytics/usage_report?starting_date=&ending_date=`

Response: same envelope shape as `cost_report` but `results[]` carries token breakdowns instead of currency.

#### `usage_report.results[]`

| Field | Type | Notes |
|---|---|---|
| `product` | string\|null | join key with `cost_report` |
| `model` | string\|null | join key |
| `uncached_input_tokens` | number | |
| `cache_read_input_tokens` | number | |
| `cache_creation.ephemeral_1h_input_tokens` | number | |
| `cache_creation.ephemeral_5m_input_tokens` | number | |
| `output_tokens` | number | |

> The reshape in `server/aws.js:analyticsReportsToCostResp` joins the two on `(product, model)` and emits a `daily[]` array of `{ date, model, spend, input, output, requests }` for the trend chart. **No per-user dimension** — that's the load-bearing reason the dashboard still keeps a CSV reconciliation path (ADR-0003).

---

## 3. Compliance API

Canonical references: [Compliance API overview](https://platform.claude.com/docs/en/manage-claude/compliance-api) · [Activity Feed guide](https://platform.claude.com/docs/en/manage-claude/compliance-activity-feed) · [`GET /v1/compliance/activities` API ref](https://platform.claude.com/docs/en/api/compliance/activities/list).

### `GET /v1/compliance/activities?starting_date=&ending_date=&type=&after_id=&limit=`

Response: `{ data: ActivityEvent[], has_more: boolean }`. Pagination is **`after_id`-cursor**, NOT `next_page` (ADR-0004) — derive the cursor from `data[data.length - 1].id` on each page.

### Activity envelope (every event)

| Field | Type | Notes |
|---|---|---|
| `id` | string | Anthropic event UUID — also serves as the next page's `after_id` |
| `type` | string | event-type slug — see catalog below |
| `created_at` | string | ISO 8601 timestamp |
| `actor.type` | `"user_actor" \| "api_actor"` | discriminator |
| `actor.email_address` | string? | present on `user_actor` |
| `actor.user_id` | string? | present on `user_actor` (may be the only id when email is unmapped) |
| `actor.api_key_id` | string? | present on `api_actor` |
| `actor.ip_address` | string? | optional |
| `actor.user_agent` | string? | optional |
| `organization_id` | string\|null | |

Event-specific extra fields land at the **top level** of the event object (sibling of `id`/`type`/`actor`), so consumers must read them dynamically. The dashboard models this via `[k: string]: unknown` on `ActivityEvent`.

### Event-type catalog

Categorized as the dashboard does internally (`src/pages/Compliance.tsx:RISK_TYPES`/`LOGIN_TYPES`). Anything not in either set is treated as `info`.

#### Risk events

| `type` | Extra top-level fields the dashboard reads |
|---|---|
| `claude_user_role_updated` | `user_email`, `previous_role`, `current_role` |
| `org_user_invite_sent` | `user_email` (target invitee, if available) |
| `org_user_invite_deleted` | `user_email` |
| `org_user_deleted` | `user_email` |
| `org_sso_toggled` | (no event-specific field — actor identity is the signal) |
| `org_sso_connection_deleted` | |
| `org_data_export_started` | |
| `org_data_export_completed` | |
| `org_domain_verified` | |
| `project_deleted` | `project_name` |

#### Login events

| `type` | Extra top-level fields |
|---|---|
| `user_signed_in_sso` | |
| `user_signed_in_google` | |
| `user_signed_in_apple` | |
| `user_signed_out` | |
| `user_logged_out` | |
| `social_login_succeeded` | `provider` (e.g. `"google"`, `"apple"`) |

#### Activity events (informational)

| `type` | Extra top-level fields |
|---|---|
| `claude_chat_viewed` | `claude_chat_id` (chat UUID) |
| `project_created` | `project_name` |
| `project_renamed` | `project_name` (post-rename) |
| `compliance_api_accessed` | `request_method`, `status_code` |
| `file_uploaded` | `file_name` |

> The catalog above is what the dashboard's UI handles explicitly. Anthropic emits other event types — they appear in the audit feed labeled `info` and are dropped into the table without per-event detail extraction. Add a `case` in `eventSummary()` (`Compliance.tsx:76`) when you start surfacing a new one.

---

## 4. Pagination conventions

| Family | Cursor field | Returned in | Stop condition |
|---|---|---|---|
| Analytics — `users/range`, `summaries`, `skills`, `connectors`, `projects` | `?page=<token>` | `body.next_page` (with `body.has_more: true`) | `has_more=false` or empty `next_page` |
| Analytics — `cost_report`, `usage_report` | same | same | same |
| Admin — `usage_report/*`, `cost_report` | same | same | same |
| **Compliance — `activities`** | **`?after_id=<event_id>`** | **NOT a separate field — derive from `data[-1].id`** | `has_more=false` or returned `data.length < limit` |

The Compliance cursor is the most common drift point. The proxy at `server/index.js` enforces the right shape; never paginate Compliance from the client side without re-checking.

---

## 5. Other contract details

- **Rate limit**: 60 requests / minute per key (Analytics). The collector + `users/range` proxy work within this budget by going S3-first.
- **Data freshness**: Analytics endpoints lag real time by ~3 days (the `firstAvailableDate` constraint exposed via `/api/health`). Compliance is real-time.
- **Available history**: Analytics goes back to `2026-01-01`. Older windows return empty `data` arrays.
- **Empty days vs. missing days**: a day with no activity returns an empty `data` array, not a 404. The collector writes a partition file regardless so Athena queries don't have to handle missing partitions.
- **Email casing**: Anthropic returns lowercased email addresses. `maskEmail()` doesn't normalize, so consumers should be case-insensitive when matching against external user lists.

---

## 6. Where each field surfaces in the dashboard

| Source field | Dashboard surface |
|---|---|
| `Summary.daily_active_user_count` | Overview KPI · Trends chart · Executive headline · `/api/analytics/summaries` |
| `Summary.monthly_adoption_rate` | Overview KPI · Executive KPI |
| `UserRecord.claude_code_metrics.core_metrics.lines_of_code.added_count` | Claude Code "LOC" KPI · Productivity trend · Executive headline |
| `UserRecord.claude_code_metrics.tool_actions.*.{accepted,rejected}_count` | Tool-acceptance leaderboard + WoW context · Productivity composite score |
| `Skill.distinct_user_count` | Adoption "peak users per skill" bar · stale-skill detector |
| `cost_report.results[].amount` | Cost page total spend · Executive spend KPI · per-developer KPI |
| `usage_report.results[].output_tokens` | Cost page output-tokens KPI · cost reshape |
| Compliance `actor.email_address` (masked) | Audit feed table · Top actors chart · Risk-by-actor heatmap proposal |
| Compliance `type ∈ RISK_TYPES` | Audit risk KPI · daily risk bars · Executive risk count |

Updates to any of these should also touch [`metrics-catalog.md`](./metrics-catalog.md) so the user-facing definition stays aligned.
