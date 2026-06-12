# Changelog

[![English](https://img.shields.io/badge/lang-English-informational)](#english)
[![한국어](https://img.shields.io/badge/lang-한국어-informational)](#한국어)

---

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No changes yet — next entries land here._

## [0.9.1] - 2026-06-12

Roadmap step 7: make the archived `projects` data queryable.

### Added

- **`projects_daily` Athena table** — the collector's daily chat-project archive is now queryable via `/api/archive/query` and the chatbot SQL tool. `flattenProject` flattens the nested `created_by` into `created_by_id`/`created_by_email` scalars (projects was previously written raw); `projects_daily` registered in Glue + added to `ATHENA_ALLOWED_TABLES` and both schema hints. Forward-only: pre-existing partitions read `created_by_*` as NULL.

### 추가

- **`projects_daily` Athena 테이블** — collector의 일일 chat-project 아카이브를 `/api/archive/query`·챗봇 SQL로 쿼리 가능. `flattenProject`가 중첩 `created_by`를 `created_by_id`/`created_by_email` 스칼라로 펼침(이전엔 raw). 포워드 전용(옛 파티션은 `created_by_*` NULL).

## [0.9.0] - 2026-06-11

Roadmap step 5: collector capture of office / design / cowork tool-edit metrics.

### Added

- **office_metrics capture** — all 4 surfaces (excel / powerpoint / word / outlook) × 6 fields (`_sessions`, `_messages`, `_skills_used`, `_distinct_skills`, `_connectors_used`, `_distinct_connectors`) archived as 24 flat `bigint` columns; absent → 0.
- **design_metrics capture** — `design_sessions`, `design_projects_used`, `design_projects_created`, `design_messages` (4 columns); absent → 0.
- **cowork tool-edit capture** — `cowork_file_edit_count`, `cowork_edit_tool_count`, `cowork_multi_edit_tool_count`, `cowork_write_tool_count`, `cowork_notebook_edit_tool_count`, `cowork_sessions_with_file_edits_count` (6 columns); **null-preserving** ("not tracked" ≠ "zero usage" — NULL until the org enables cowork file-editing).
- **flatten/inflate contract extracted into pure modules** — `collector/flatten.js` (write) + `server/inflate.js` (read), with a round-trip + schema-drift test (`tests/server/test-flatten-inflate.mjs`).
- **`USER_COLUMNS` 28 → 62** (`infra/lib/storage-stack.ts`). Forward-only: old partitions read new columns as NULL (office/design → 0 on inflate, cowork → null).

### 추가

- **office_metrics 캡처** — excel / powerpoint / word / outlook 4개 surface × 6필드를 flat `bigint` 24컬럼으로 S3 아카이브; absent → 0.
- **design_metrics 캡처** — `design_sessions` / `design_projects_used` / `design_projects_created` / `design_messages` 4컬럼.
- **cowork tool-edit 캡처** — 6컬럼, **null 보존**("미추적" ≠ "0회"; 조직이 cowork file-editing 활성화 전까지 NULL).
- **flatten/inflate 순수 모듈 추출** — `collector/flatten.js`(write) + `server/inflate.js`(read) + 라운드트립·드리프트 테스트.
- **`USER_COLUMNS` 28 → 62**; 포워드 전용(옛 파티션은 신규 컬럼을 NULL로 읽음).

## [0.8.6] - 2026-06-11

Step 4 of the Analytics-API roadmap: per-user × model cost (chargeback).

### Added

- **"Per-user spend by model" chargeback view** on the Cost page — top-10 users as a horizontal bar stacked by model (answers "who's driving Opus spend"). Powered by extending the previously-unused `GET /api/cost/users` with **`?by=model`** → `user_cost_report?group_by[]=model`, aggregated per user into a `by_model[]` breakdown. `userCostToUsers(data, { byModel })` and `fetchUserCostReport({ groupByModel })` gained the mode; the ungrouped path is unchanged. Cost + requests only (no per-user tokens); emails masked at render; model ids normalized (hyphen→underscore) for color/label.

### 추가

- Cost 페이지 **"사용자별 모델 비용" 차지백 뷰** — 지출 상위 10명을 모델별 스택 가로 막대로(“누가 Opus를 쓰는가”). 미사용이던 `GET /api/cost/users`에 **`?by=model`**(→ `user_cost_report?group_by[]=model`)를 추가해 사용자별 `by_model[]` 분해 제공. 비용·요청수만(사용자별 토큰 없음), 이메일 렌더 마스킹.

## [0.8.5] - 2026-06-11

Step 3 of the Analytics-API roadmap: prompt-cache efficiency.

### Added

- **"Prompt-cache efficiency" card** on the Cost page — the cache-hit ratio (cache_read ÷ total input tokens, from the existing usage_report — no estimate) plus a token-tier $ breakdown (uncached / cache read / cache write / output) from a new best-effort `cost_report group_by[]=token_type` fetch. Surfaces the biggest Claude Code cost lever that the input-token rollup otherwise hides. `/cost/live` now returns `token_tiers` + `by_token_type`.
- Generalized the single-dimension cost aggregator (`aggregateAmountBy`) shared by the cost_type and token_type rollups; both secondary fetches are network-rejection-isolated and never break the primary cost view.

### 추가

- Cost 페이지 **"프롬프트 캐시 효율" 카드** — 캐시 히트율(cache_read ÷ 총 입력 토큰, 기존 usage_report 기반·추정 없음) + 토큰 티어별 $ 분해(비캐시/캐시 읽기/캐시 쓰기/출력, 신규 best-effort `cost_report group_by=token_type`). 입력 토큰 합산이 가리던 최대 비용 레버를 노출. `/cost/live`에 `token_tiers`·`by_token_type` 추가.

## [0.8.4] - 2026-06-11

Step 2 of the Analytics-API roadmap: cost-type breakdown.

### Added

- **"Spend by type" card** on the Cost page — splits live spend into **tokens / web search / code execution** (`cost_report group_by[]=cost_type`). A compact card with $ + % (not a donut: tokens are ~100%, so a pie would hide the small-but-metered server-tool spend). `/cost/live` now returns `by_cost_type`; the cost_type fetch is best-effort (a network/HTTP failure leaves it empty without breaking the primary product×model cost view).

### 추가

- Cost 페이지 **"유형별 지출" 카드** — 라이브 지출을 **토큰 / 웹 검색 / 코드 실행**으로 분해(`cost_report group_by=cost_type`). 토큰이 ~100%라 도넛 대신 `$ + %` 카드(메터링 서버 도구 지출을 작아도 명시). `/cost/live`에 `by_cost_type` 추가, cost_type fetch는 best-effort(네트워크/HTTP 실패 시 비어도 메인 비용 뷰는 무영향).

## [0.8.3] - 2026-06-10

UI quick wins from the Analytics-API capability review (step 1 of the roadmap).

### Fixed

- **Cost product chart showed fallback colors + raw `claude_in_chrome`-style labels.** `PRODUCT_COLORS` was keyed in Title Case but the cost_report API now returns snake_case product ids, so every product missed the map. Re-keyed to snake_case + added a `productLabel` display map; new surfaces (Claude Design, Claude in Chrome, Code Review, Research) now get distinct colors and readable labels in the product pie + product×model bar.

### Added

- **"Data as of …" freshness badge** on the Cost page — surfaces cost_report's real `data_refreshed_at` (UTC) instead of the request time, setting expectations against the 3-day Analytics buffer. (`analyticsReportsToCostResp` now passes the field through; CSV path → hidden.)
- **Cowork DAU line** on the Trends active-users chart (the value was already computed into the series but never drawn).

### 변경

- **비용 제품 차트 색/라벨 정상화**: `PRODUCT_COLORS`가 Title Case 키였으나 API가 snake_case 제품 id를 반환해 전부 미매칭(FALLBACK + 원시 라벨)이던 것을 snake_case로 재키 + `productLabel` 표시 맵 추가. 신규 surface(Claude Design·Claude in Chrome·Code Review·Research)도 고유 색·가독 라벨.
- **"데이터 기준" 신선도 배지** (cost_report `data_refreshed_at`, UTC) — 요청 시각 대신 실제 확정 시각 표시. **Cowork DAU 라인**을 Trends 차트에 추가.

## [0.8.2] - 2026-06-10

### Fixed

- **Cost page: single-day ranges (incl. the `1d` default) returned no live data.** The Analytics cost endpoints treat `ending_at` as exclusive, so an inclusive `[d, d]` range was sent as a zero-width window (`starting_at == ending_at`) → 0 rows → silent fallback to the range-agnostic CSV (so "cost didn't change with the date picker"). The inclusive end date is now mapped to a half-open `[d, d+1)` window (`utcNextDay`), fixing `1d` and the multi-day off-by-one in `cost_report` + `user_cost_report`.

### Added

- `scripts/rotate-analytics-key.sh` / `scripts/diagnose-analytics-key.sh` — operational helpers to rotate/diagnose the Analytics API key via a hidden prompt (validate → `.env` → Secrets Manager → ECS redeploy), never exposing the key in shell history or tool input.

### 수정

- **비용 페이지: 단일일 범위(`1d` 기본 포함)가 라이브 데이터를 못 가져오던 문제.** Analytics 비용 엔드포인트의 `ending_at`이 배타적이라 inclusive `[d, d]`가 폭 0 윈도우(`starting_at == ending_at`)로 전송 → 0행 → range-agnostic CSV로 조용히 폴백(그래서 "기간 선택해도 비용이 안 바뀜"). 이제 inclusive 종료일을 half-open `[d, d+1)`로 매핑(`utcNextDay`)해 `1d`와 멀티데이 off-by-one을 함께 해결.

## [0.8.1] - 2026-06-10

### Changed

- **Cost page date range** — a single range picker now sits at the top of the page and drives ALL cost content (org spend, trends, per-user tables, efficiency, KPIs); the duplicate picker in the Economic Productivity section is removed. The page now defaults to **daily** (`1d`) live data.
- **New `1d` preset** on the shared date-range control — resolves to the most recent finalized day (`today−3`) so per-user cost + efficiency render populated, finalized data rather than partial/empty recent days. Available on every page; only the Cost page defaults to it.

### 변경

- **비용 페이지 기간 선택** — 단일 기간 피커를 페이지 상단으로 통합해 모든 비용 내용(조직 지출·트렌드·사용자별·효율·KPI)을 제어. 경제 생산성 섹션의 중복 피커 제거. 기본값을 **일일(`1d`) 라이브**로 변경.
- **`1d` 프리셋 추가** — 최근 확정일(`today−3`)로 해석해 사용자별 비용·효율이 확정 데이터로 채워지도록. 전 페이지에서 선택 가능하나 기본값은 비용 페이지만.

## [0.8.0] - 2026-06-10

Live per-user cost from the Analytics API. The Cost page's per-user "Top by
Cost" table and `distinct_users` KPI now work without a CSV upload. CSV is
retained as optional for per-user token breakdowns and billing-grade
reconciliation. See [ADR-0009](docs/decisions/0009-live-user-cost.md).

### Added

- **`GET /api/cost/users`** — live per-user USD spend via Analytics `user_cost_report`. Paginated (up to 50 pages), clamped to `today − 3`, sorted by `net_spend_usd` descending. Response: `{ source: "live", period, data_refreshed_at, users: [{ email, user_id, name, deleted, net_spend_usd, gross_spend_usd, requests }] }`. Raw emails masked at the frontend via `maskEmail`. No per-user token counts (cost + requests only).

### Changed

- **`GET /api/cost/efficiency`** now defaults to live per-user spend from `user_cost_report` for the exact selected range (no CSV-period activity-weighted scaling on the live path); falls back to the Spend Report CSV path when live data is empty or unavailable. Response `source` is `"live+analytics"` (live path) or `"csv+analytics"` (CSV fallback). In live mode, per-user token fields are 0 and `tokens_per_loc` is `null`.
- **Cost page**: per-user "Top by Cost" table and `distinct_users` KPI are now live (no CSV upload required). The 3 token-ranked per-user tables (`top_total`, `top_input`, `top_output`) render only when per-user tokens are available (CSV path). A `cost.top.live_caveat` note is shown in live-only mode explaining the token gap.

### Note

Per-user token breakdowns (`prompt_tokens`, `completion_tokens`) still require a manually exported Spend Report CSV — the live `user_cost_report` endpoint is cost + requests only. CSV upload is retained as optional reconciliation.

## [0.7.1] - 2026-06-09

Polish for the floating chat widget.

### Added

- **Draggable chat window** — grab the widget's title bar to reposition the floating chat anywhere on screen. Header-only drag (the conversation body, buttons, and text selection stay interactive), clamped to the viewport, and the position is kept for the session. Uses pointer events with `pointercancel` cleanup and direct-transform updates (one React commit per gesture) for smooth dragging.
- **🤖 launcher icon** — the bottom-right chat button (and the widget title bar) now lead with a robot emoji so the control reads clearly as a chatbot.

## [0.7.0] - 2026-06-09

Converts the `/analyze` page into a multi-turn tool-use chatbot and adds a
global floating widget on every page. The model autonomously selects among
four data tools per turn, mixing live analytics, the S3 archive, and cost
reports to answer. Client-side history keeps the last 12 turns for
multi-turn context — no new infra.

### Changed

- **`/analyze` is now a multi-turn tool-use chatbot** — replaces the previous `direct`/`sql` mode selector and `POST /api/analyze`. The model calls the right tool(s) per turn rather than the user pre-selecting a mode. MD/PDF export toolbar retained. See [ADR-0008](docs/decisions/0008-tool-use-chatbot.md).

### Added

- **Global floating chat widget** (`FloatingChat`) mounted in `Layout` — accessible from every page without navigating to `/analyze`. Shares the same `ChatPanel` component as the Analyze page.
- **Dynamic follow-up questions** — after each answer the chatbot proposes up to 3 contextual follow-ups, rendered as clickable pills.
- **Tool-call badges** in message bubbles — show which tools the model invoked (`Overview`, `Athena SQL`, `Cost`, `Users`) with running/done/error states and row counts.
- **Conversation reset** — "New chat" button clears history and suggested prompts.
- **`POST /api/chat/stream`** (Bedrock `ConverseStreamCommand` tool-use loop, `MAX_TOOL_HOPS=4`, SSE events: `status | tool_call | tool_result | text | followups | error | done`).
- **`server/chat-tools.js`** — pure, unit-tested helpers: email masking, history serialisation, follow-up parsing, user ranking, overview compaction, `TOOL_SPECS`, `CHAT_SYSTEM_PROMPT`, `makeToolRunner`.

### Removed

- **`POST /api/analyze`**, `generateSql`, `extractSql`, and the `direct`/`sql` mode selector — superseded by `POST /api/chat/stream`.

## [0.6.0] - 2026-05-10

UX + security pass on top of the v0.5.x line. Sortable statistics
tables across 5 pages, the sidebar now stays put while the main pane
scrolls, the date picker advances to "today" instead of stopping 3
days short (with a UTC/daily-refresh footnote explaining the partial
counts), and a round of harness-side hardening kicked off by the v0.1.0
harness-eval Full report (live API keys redacted from
`.claude/settings.local.json`, deny-list expanded 12 → 29, allow-list
catch-all wildcards pruned, secret patterns deduped into a shared lib,
and a SessionStart guard that scans the settings files at boot).

### Added

- **Bidirectional column sorting** on 5 statistics tables (Cost · Full Efficiency Matrix · Adoption · Top Chat Projects · Users · UserProductivity · Compliance · Audit Feed). Click any column to sort, click again to flip; active column shows ▲/▼, inactive columns show a faint ↕ to advertise that they're clickable. User / project / actor / event-type columns sort as strings (case-insensitive `localeCompare` — Korean labels sort by Hangul order); numeric columns sort by value; `null` / `undefined` are always pinned to the bottom regardless of direction so "$/LOC = 0" rows don't pollute the top of the leaderboard. New shared primitives: `src/lib/useSortable.ts` + `src/components/SortableTh.tsx`. Replaces the per-page unidirectional `Th` components in Users / UserProductivity.
- **DateRangeControl footnote**: `Data is UTC · refreshed daily · last ~3 days may show partial counts (Analytics buffer)` (KO: `데이터 시간대 UTC · 매일 업데이트 · 최근 3일은 부분 집계일 수 있음`). Both the `Apply` button and the footnote now flow through i18n.
- **`docs/anthropic-api-fields.md`** — new reference (309 LOC) cataloging every field the dashboard consumes from Anthropic's Analytics + Compliance APIs, with canonical doc links (incl. the `.md` suffix trick for LLM consumption of the Mintlify-rendered docs site).
- **`.claude/hooks/lib/secret-patterns.sh`** — shared 7-pattern array sourced by both `secret-scan.sh` (PreToolUse) and `session-context.sh` (SessionStart) so the two hooks can no longer drift apart.

### Changed

- **Sidebar is now pinned to the viewport.** Outer flex wrapper is `h-screen`; the sidebar (`aside`) and main pane each get `h-full overflow-y-auto` so they scroll independently. Body-level scrolling no longer drags the sidebar out of view alongside the content.
- **Date picker `maxEnd` raised from `today − 3` to `today`** (UTC). The Analytics API will simply return partial counts for the last ~3 days; the new footnote explains. Preset windows now end on today (e.g., 7d preset = `[today−6, today]` instead of `[today−9, today−3]`).
- **Harness deny-list expanded 12 → 29 entries**: added `rm -fr*`, `rm --recursive*`, `chmod -R 777*`, `chmod 777 /*`, `dd of=/*`, `mkfs.*`, `curl|bash`, `curl|sh`, `wget|bash`, `wget|sh`, `git push --mirror`, `git filter-branch`, `aws iam delete-policy`, `aws s3 rb s3://* --force` (with space — the standard CLI form), `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws rds delete-db-cluster`, `aws cognito-idp delete-user-pool`, `aws secretsmanager delete-secret`. Dropped `Bash(rm -rf *)` (subsumed by `rm -fr*`) and `Bash(aws s3 rb s3://*--force)` (the no-space form was unreachable as a real CLI invocation).
- **`session-context.sh` SessionStart secret guard** scans both `.claude/settings*.json` files at boot using a JSON-aware Python walk over string values (skips `grep`/`git grep` audit-command strings to avoid false-positives on legitimate search patterns). Replaces a fragile `grep -v` line filter that only matched one quoting style. Closes the gap that allowed the v0.5.1 key-commit incident — the PreToolUse `secret-scan.sh` hook only inspects `tool_input` payloads and can't see secrets that arrive via the permission-acceptance flow.

### Fixed

- **Live Anthropic API keys committed to `.claude/settings.local.json`** (lines 30, 58, 59 in v0.5.1) replaced with `__TRACKED_VAR__` placeholders. Verified via `git log -p -S` that the keys never reached git history (the file is gitignored). The user is still responsible for rotating the underlying credentials in Anthropic Console — placeholder swap only stops disk-at-rest exposure.
- **Allow-list catch-all wildcards pruned** (8 entries removed — `Bash(bash *)`, `Bash(node *)`, `Bash(python3 *)`, `Bash(git *)`, `Bash(grep *)`, `Bash(aws ec2 *)`, `Bash(aws ecs *)`, `Bash(aws secretsmanager *)`). These had silently superseded the deny-list for the most dangerous tool families; replaced with scoped read-only entries (`git status`/`diff`/`show`/`log`, `grep -n`/`-E`/`-rn`, `aws ec2 describe-instances`, `aws ecs describe-tasks`/`list-services`, `aws secretsmanager get-secret-value`/`list-secrets`).
- **Hardcoded English strings** that bypassed i18n in `ClaudeCode.tsx` (4 KPI labels + hints, 3 ChartCard titles/subtitles, Bar legend `name="Lines of Code"`) and `Adoption.tsx` (3 ChartCard titles/subtitles, 5 table headers, 4 Bar legends, "never" fallback in stale callout). All keys were already defined in both `en` and `ko` dictionaries — the JSX just wasn't using them. With Korean locale active the affected pages now render entirely in Korean.
- **`secret-scan.sh` PEM private-key true-positive fixture #20 was silently failing**: `grep -E` parsed the leading dashes of the PEM begin-marker as an option flag, so the hook returned exit 0 instead of blocking. Added the `--` separator (`grep -qE -- "$pat"`). Tests: 53/54 → 54/54 pass.
- **Python `FutureWarning: Possible nested set`** from the SessionStart guard's regex (Python's `re` module flags POSIX `[[:space:]]` inside a char class). Switched the AWS secret-key pattern to `\s` which both `grep -E` and Python `re` accept cleanly.

## [0.5.1] - 2026-05-09

Fixes the Executive page so changing the date range actually updates
every KPI on the page (the previous version had a single-day `users`
fetch that always returned `endingDate-3` regardless of preset, so LOC
and tool-acceptance never moved). Also expands from 6 KPIs to 12,
adds a productivity score gauge, and rewrites the headline summary
to reference window-aware totals instead of single-day snapshots.

### Changed

- **Executive page rebuilt around `/api/analytics/users/range`** (was: single-day `/api/analytics/users?date=...`). LOC, commits, PRs, sessions, tool-acceptance, distinct active devs are now real window aggregates that recompute on every range change.
- **Layout: 6 KPIs → 12 KPIs** organized into three labeled sections (People · Productivity · Cost & Risk):
  - *People*: Active devs (window distinct), Avg DAU (with peak), Monthly adoption, Assigned seats.
  - *Productivity*: LOC added (window total + commits/PRs), Tool acceptance (window total), Sessions/dev/day, Composite productivity score (0–100, same formula as the Productivity page).
  - *Cost & Risk*: Spend (with $/dev/day hint), 30-day projection (with 7-day avg basis hint), Cost per 1k LOC, Risk events.
- **Headline rewritten** to reference window aggregates (`{days}d`, `{devs} of {seats} developers`, `{loc} LOC`, `{commits} commits`, `{accept}`, `{spend}`, `{proj}`, `{score}/100`, `{risk}`, top model). Every value moves with the date picker.
- **Subtitle** now spells out the contract — `"All KPIs are window aggregates — change the date range to refresh every number on this page."`

## [0.5.0] - 2026-05-09

Insights pass. Adds the metrics + visualizations the dashboard was
missing for CFO/CTO conversations: a single-page Executive snapshot,
end-of-month cost forecast and per-developer cost on the Cost page,
risk-event spike detection on the Compliance page, and a "stale"
callout on Adoption that flags skills/connectors going unused inside
the selected window.

### Added

- **Executive page (`/exec`)** — single-screen CFO/CTO snapshot with 6 headline KPIs (active devs, monthly adoption, LOC, window spend, 30-day projection, risk events) + 1-line headline summary + DAU and daily-spend trend charts. Built on the same `app-print` pattern as Analyze/Cost so the print dialog produces a clean, sidebar-free PDF for sharing. Sidebar nav entry "Executive" with `Exec` badge.
- **Cost · per-developer KPI** (`src/pages/Cost.tsx`): `total_spend / active_devs_in_range` rendered as a new KPI card. Active devs falls back through `eff.user_count → csv.distinct_users → cost.totals.distinct_users` so the metric works in live, CSV, and hybrid modes.
- **Cost · 30-day projection KPI** (live mode only): rolling forecast = avg of last 7 days × 30, sourced from `data.daily`. Also exposes a sibling "Daily avg (7d)" KPI for context. Hidden in CSV-only mode where there's no daily series.
- **Compliance · risk-event spike threshold**: the daily-events chart now includes a horizontal reference line at `mean(daily risk count) + 1·stdev` (rounded, floored at 1). Bars rendered above the line are statistical outliers worth investigating. Subtitle calls out the threshold value.
- **Adoption · stale skills/connectors callout**: each chart card now shows an amber callout listing items used in the *earlier half* of the window but not the more recent half. Highlights declining adoption that the absolute leaderboard sort still hides at the top.

### Changed

- **Compliance daily chart** switched from a pure line chart to a `ComposedChart` — risk count is now drawn as orange bars (easier to spot spikes) with the total-events line on top, plus the new threshold reference line.

### Internal

- Generalized print CSS class from `analyze-print` to `app-print` so multiple pages (Analyze, Cost, Executive) share one set of `@media print` rules. Visibility-based isolation, `<details>` auto-expansion, and color-preserve hints all live in `src/index.css`.

## [0.4.0] - 2026-05-09

UX polish + ergonomics. Default date window narrowed from 14d to 7d
across every sidebar-routed page; Analyze and Cost grew "Save as PDF"
+ "Save as MD" buttons (browser-native print, zero new deps); Archive's
default Athena query is fixed (`date BETWEEN DATE '…'` was erroring with
TYPE_MISMATCH because the partition column is varchar); the sidebar
now displays an estimated AWS monthly run-rate so cost is visible from
every page.

### Added

- **PDF / Markdown export on Analyze** (`src/pages/Analyze.tsx`): top-right toolbar appears once a conversation has at least one turn. *MD* triggers a Blob download (timestamped filename, GFM tables for query rows, fenced code blocks for SQL). *PDF* sets `body.app-print` then calls `window.print()` — the user picks "Save as PDF" in the browser dialog. Generic `@media print` rules in `src/index.css` use visibility-based isolation so the printable subtree (`.print-export`) stays visible while everything else collapses; `<details>` blocks auto-expand so SQL + row tables print without manual interaction.
- **PDF export on Cost** (`src/pages/Cost.tsx`): same `app-print` machinery as Analyze. Button placed next to the DateRangeControl. Reconciliation `<details>` and the date picker are tagged `print-hide` so the printout is just KPIs + charts + Top-10 tables. Works in both live and CSV modes.
- **AWS run-rate in the sidebar** (`src/components/Layout.tsx`): bottom of the sidebar now shows `AWS 월 예상: ≈ $65/mo · ap-northeast-2` with a hover tooltip listing per-component breakdown (Fargate $10 · ALB $22 · WAF $8 · Bedrock $5 · Athena $2 · S3+Glue+CloudWatch $2 · Secrets Manager $1 · CloudFront+Lambda@Edge $1 · Collector $0.10). Static estimate — usage-driven items scale with traffic.

### Changed

- **Default date window: 14d / 30d → 7d** across Overview, Users, UserProductivity, Productivity, Trends, ClaudeCode, Adoption, Cost, Compliance, and the implicit `useDateRange()` default. UserSearch's "All" preset also now starts on 7d. Trends and Cost previously defaulted to 30d; users can still pick 30d / 14d via the existing range control.

### Fixed

- **Archive page returned `athena_error`** for any `WHERE date BETWEEN DATE '…' AND DATE '…'` query (including its own pre-filled default). Root cause: the Glue table partitions `date` as `varchar`, but the default query and the SQL-mode schema hint both wrapped the literals in `DATE '…'`. Athena Engine v3 throws `TYPE_MISMATCH: Cannot check if varchar is BETWEEN date and date` because Trino refuses to auto-cast varchar to date. Fixed by switching to plain string literals (`WHERE date BETWEEN '2026-04-01' AND '2026-04-30'`); zero-padded ISO dates compare correctly as strings *and* let partition projection still prune. Updated the schema hint in `server/aws.js` so `/api/analyze` SQL mode generates the correct form.
- **Athena polling timeout was 20 s with silent fall-through**: `runAthena` polled 40 × 500 ms then proceeded to `GetQueryResultsCommand` even if the query was still RUNNING, which surfaced as a generic `athena_error` when the SDK rejected the call. Bumped to 120 × 500 ms (60 s) and added an explicit timeout error (`Athena query did not finish within 60 s. Try a narrower date range.`).

## [0.3.0] - 2026-05-09

Reliability + UX milestone. Compliance audit feed pagination is fixed
(was effectively single-page on noisy orgs); Analyze pre-canned
prompts rewritten for actionable insights; new User Search per-user
drill-down dashboard with activity heatmap, streaks, and CSV-derived
cost. Sidebar version badge wired to `package.json` and an in-app
`/changelog` page rendering this file at build time. See [ADR-0004]
for the audit pagination + prewarm decision.

[ADR-0004]: docs/decisions/0004-compliance-pagination-prewarm.md

### Added

- **Compliance/audit feed pagination + warm cache**: `/api/compliance/activities` now uses the upstream API's actual cursor (`after_id` derived from each page's last event id), accepts `starting_date` for early termination, and returns `stop_reason` + `in_window` so the UI can warn when older events were truncated. A startup prewarm self-fetches the 7d / 14d / 30d windows on each ECS task boot and refreshes every 5 minutes — most users hit the upstream cache and see results in <1 s instead of paginating 30+ s of API calls. UI banner surfaces the cap when reached.
- **Analyze Quick prompts expanded from 5 to 12** across four insight categories (adoption, productivity, cost, risk/executive). Each prompt combines multiple dimensions (e.g., "Top contributors with their tool acceptance rate", "spend > 50 % week-over-week or tokens-per-LOC doubled", "forecast next month's spend") so the AI surfaces signals that the static charts can't answer in one glance.
- **User Search page** (`/user-search`): per-user drill-down dashboard modeled on Anthropic's per-user analytics-app sample. Two tabs (Overview / Model), email search + combobox, and a 4-preset date range toggle (All / 30d / 14d / 7d). Overview shows 8 KPIs (sessions, messages, total tokens, active days, current streak, longest streak, peak day-of-week, favorite model), an activity heatmap (7-row × N-column calendar grid, 5-level Claude palette), and a Cost summary card (CSV-derived, activity-scaled to the selected range). Model tab renders daily token bars (estimated by activity-weighted distribution) plus per-model input/output/percent breakdown. ~520 LOC, no new server endpoints — composes the existing `/api/cost/csv` + `/api/analytics/users/range`.
- **`c4e.whchoi.net` alias domain** registered with the Cognito user pool client (callback + logout URLs). The `*.whchoi.net` ACM wildcard cert and CloudFront alias were already in place; only Cognito needed the additional URL.
- **Sidebar version badge + `/changelog` page**: `package.json` `version` is rendered as a small claude-orange pill below the product name, linking to a new in-app Changelog page. The page imports `CHANGELOG.md` via Vite's `?raw` text import and renders the active locale's section through the existing `Markdown` component (handles GFM tables, headings, code, links). Single source of truth: bumping `package.json` + adding a `## [x.y.z]` block to this file updates both the badge and the page on the next deploy.

### Changed

- **In-memory upstream cache TTL: 5 min → 10 min** to overlap with the new compliance prewarm interval (5 min) and reduce cold-fetch likelihood.
- **Compliance request cap: 500/5 pages → 2000/20 pages** at the cost of partial coverage on very noisy orgs. Sized to fit the ~30 s ALB / CloudFront origin response timeout. The upstream cache + prewarm hide this cost from most users.

### Fixed

- **Compliance / audit feed was effectively single-page**: the server's pagination loop relied on `body.next_page`, but the upstream `/v1/compliance/activities` endpoint never returns that field — its cursor is `after_id=<last_event_id>`. Pagination silently broke after page 1, so the audit page only ever showed ~100 most-recent events (typically a single day on active orgs). Fixed by deriving the cursor from `data[-1].id` on each page; the route now also accepts `starting_date` and stops paginating as soon as the oldest event on a page predates that date. This + the prewarm cache transformed a 1.5+ minute cold fetch into a sub-second user response.
- **Docker `.dockerignore` excluded `CHANGELOG.md`** which broke the new `/changelog` page's Vite `?raw` import in the production image (local builds succeeded, ECS image build failed in the Vite Rollup pass with an unresolved-module error). Removed `CHANGELOG.md` from the exclude list (~17 KB image-size cost — negligible) and added `sample/` since those design references aren't needed at runtime.

### Security

- Cognito OAuth **client callback / logout URL whitelist** extended to include `https://c4e.whchoi.net/parseauth` and `https://c4e.whchoi.net/`. The Lambda@Edge auth handler derives `redirect_uri` from the actual `Host` header, so any subdomain on the existing wildcard cert/alias works once Cognito accepts it.

## [0.2.0] - 2026-05-08

Hybrid live cost API + Cognito auth + in-dashboard CSV management.
Cumulative release of all post-0.1.0 work: Lambda@Edge authentication,
self-service Spend Report uploads, the new live `/api/cost/live`
endpoint backed by Anthropic's Analytics API, hybrid live + CSV Cost
UX, activity-weighted per-user spend scaling, daily trends chart, and
the 30-day caveat banner. See [ADR-0001], [ADR-0002], [ADR-0003] for
the three architectural decisions captured in this release.

[ADR-0001]: docs/decisions/0001-cognito-lambda-edge-auth.md
[ADR-0002]: docs/decisions/0002-dashboard-csv-upload.md
[ADR-0003]: docs/decisions/0003-hybrid-live-cost.md

### Added

- **Live Cost data via the Anthropic Analytics API** (`GET /api/cost/live`): org-wide spend and token data refreshed every ~4 hours, queried with `starting_date` / `ending_date`. The endpoint joins `/v1/organizations/analytics/cost_report` (USD spend + request counts) with `/v1/organizations/analytics/usage_report` (input/output/cache token counts) on `(product, model)` and reshapes the response into the same `CsvResp` shape the Cost page already consumes. Same analytics key already used for `/api/analytics/*` proxy routes — zero new credentials.
- **Hybrid live + CSV Cost UX**: the Cost page now sources main aggregates (KPIs, product/model breakdowns, daily trends) from the live API while sourcing per-user Top-10 tables from the uploaded CSV (the analytics endpoints don't expose per-user attribution). The `useCostData` composite hook fires both sources in parallel and falls back gracefully when either is unavailable. CSV upload UI moved into a `<details>` reconciliation expander that auto-opens in CSV-active mode.
- **"Daily spend by model" trends chart** (live mode only): stacked-area Recharts visualization of per-day spend over the selected date range, sourced from the new `daily` array in the live API response.
- **30-day amber caveat banner** + page-level `DateRangeControl` (live mode only) — clarifies the data freshness contract and gives a single date picker that drives every widget on the page.
- **Activity-weighted per-user spend scaling**: `/api/cost/efficiency` now also fetches Analytics activity over the CSV's full period, computes a `ratio = sessions_in_selected_range / sessions_in_csv_period` per user (capped at 1.0), and exposes `range_spend_usd` / `range_prompt_tokens` / `range_completion_tokens` / `range_total_tokens` / `range_requests`. The Cost page's Top-10 per-user tables now respond to the date picker instead of always showing CSV-period totals.
- **Cognito + Lambda@Edge authentication**: every CloudFront URL now sits behind a Cognito Hosted UI login. Four viewer-request Lambda@Edge functions run at every edge PoP — `check-auth` (default), `parse-auth` (`/parseauth`), `refresh-auth` (`/refreshauth`), `sign-out` (`/signout`). JWT validation uses the pool's JWKs with a 5-minute per-container cache. Unauth'd traffic is blocked before reaching WAF, ALB, or the ECS task.
- **Sign out link in the sidebar**: plain `<a href="/signout">` so the browser issues a real request and the edge handler can clear HttpOnly cookies and redirect to Cognito `/logout`.
- **CSV upload / list / delete from the dashboard**: three new endpoints — `POST /api/cost/upload`, `GET /api/cost/uploads`, `DELETE /api/cost/uploads/:file` — remove the need for AWS CLI access when refreshing the Spend Report. Multer-backed multipart handler (25 MB cap, schema check against required columns, path-traversal-safe filenames). Client-side preview (rows, users, derived period) with period-overlap warning against existing uploads.
- **Date range control on the Cost page**: same 7d / 14d / 30d / custom picker used across the rest of the dashboard, bound to the Economic Productivity section (which joins the CSV with live Analytics per-user productivity). Top KPIs stay anchored to the CSV's native period by design — the CSV is pre-aggregated and has no daily breakdown to filter on. Effective range (server-clamped to Analytics' 3-day buffer) is displayed.
- **`useFetch()` now returns `refetch()`**: mutation-triggering UIs (first consumer: `CsvUploader`) can invalidate cached GETs without a full page reload.
- Build-time secret injection for Lambda@Edge via `scripts/build-edge.mjs`: renders `infra/edge/dist/` from `_shared.template.js` by substituting Cognito config pulled from Secrets Manager (`ccd/cognito-config`). `dist/` is gitignored.
- Cognito user management runbook at [`docs/runbooks/cognito-users.md`](docs/runbooks/cognito-users.md).

### Changed

- **Cost page main data is now live by default** (was: CSV-only). KPIs, product/model charts, daily trends, and the date picker all reflect the selected range from the live Analytics API. CSV is the automatic fallback (live API empty/error) and remains the source of truth for ≥30-day finance reconciliation. Per-user widgets always trace back to the CSV (live API has no user dimension), with activity-weighted scaling so they respond to date changes too.
- `PageHeader source` prop union widened to include `'csv'` (was `'live' | 'mock'`); badge label maps `'csv' → "CSV"` instead of falling through to "Mock".
- Cost subtitle / source badge / Total Spend KPI hint are now dynamic — switch between Live API and Reconciliation CSV depending on active source, with a small caveat note when Top-10 tables come from CSV in live mode.
- `Math.round(cents)` removed from the Analytics→CSV reshape conversion; raw division by 100 paired with `toFixed(4)` accumulation preserves sub-cent precision should the upstream return fractional amounts.
- Cost page top-level data (KPIs, product×model tables, Top-10 rankings) stays bound to the CSV's fixed period. Only the Economic Productivity section is date-range-aware.
- `@aws-sdk/client-secrets-manager` added at the repo root to support the edge-bundle build step.
- `multer` added at version 2.x (2.1.1) with an explicit JSON error wrapper so every upload failure path returns structured JSON instead of Express's default HTML error page.

### Fixed

- **`/api/cost/live` initial implementation returned 0 rows in production**: the first cut self-called `/api/admin/claude-code/range` using the admin API key, but that key is workspace-scoped and the active workspace had no Claude Code activity. Migrated to the org-wide Analytics API (`cost_report` + `usage_report` with the analytics key) which sees real spend across all products. Dropped the now-unused `claudeCodeRangeToCostResp` reshape in favor of `analyticsReportsToCostResp`; updated the unit test fixture accordingly.
- **Page-level `DateRangeControl` lied in CSV mode**: it sat above the KPI grid suggesting it filtered everything, but CSV is a single-period snapshot — date changes had no observable effect on the main page. Now hidden in CSV mode; the Productivity section's own picker remains for the parts that *are* date-aware.
- **`CSV · ` badge with trailing dot-space**: when `data.file` was null in CSV mode, the template literal `\`CSV · ${data.file ?? ''}\`` rendered `"CSV · "`. Replaced with a tighter ternary that falls back to the existing `cost.source.csv` i18n string.
- **`useCostData` loading flicker**: previous formula kept `loading=true` while the live channel was still in-flight even when the CSV channel had already returned usable data. Tightened to `data == null && (live.loading || csv.loading)` so the page renders the moment any source produces rows.
- **`useCostData.refetch` was not memoized**: a fresh function reference per render would trigger a re-render loop if a consumer used it in a `useEffect` dependency. Wrapped in `useCallback` with `[live.refetch, csv.refetch]`.
- **Self-call query parameters were not URL-encoded**: `req.query`-derived dates flowed straight into the `/api/admin/claude-code/range` self-call URL, allowing a crafted request to inject extra params (downstream ignored them today, but a future-handler change could surface this). Wrapped both in `encodeURIComponent`.
- **WAF `SizeRestrictions_BODY` blocks every POST > 8 KB**: the default `AWSManagedRulesCommonRuleSet` sub-rule silently killed the new `/api/cost/upload` with a WAF 403 HTML page (`<html> <h...`). Downgraded to COUNT via `ruleActionOverrides` so the rule is still logged for observability but no longer blocks. All other CommonRuleSet protections (XSS, SQLi, LFI/RFI, bad UA) remain BLOCK.
- CSV filename regex for the upload sanitizer now accepts Anthropic Console's actual export format (`spend-report--YYYY-MM-DD-to-YYYY-MM-DD.csv`, with a double dash) so the period is preserved instead of falling back to a today-derived name.
- `console.log` diagnostic on upload entry so `CloudWatch Logs` can confirm whether a failing upload reached the container vs. being blocked upstream.

### Security

- **`.env` file permissions tightened (664 → 600)**. Verified the Anthropic API keys never appeared in any commit (cross-checked against full `git log -p -S sk-ant-api01-…`); this hardens disk-at-rest exposure on the dev host.
- Cognito OAuth **client secret rotated** (old app client `3qf1cr3r61vgc3cge9qh6cf5ik` deleted, replaced by `5bbe3af5qkqv3rghgutp64fgc6`) after the initial secret lived briefly on local disk. New secret never touched git.
- Pre-commit hook extended with a `clientSecret[:=]['\"][a-z0-9]{40,}` pattern and an explicit path blocklist for `infra/edge/dist/` so a `git add -f` cannot re-introduce the Lambda@Edge bundle with secrets.
- Upload endpoint filename regex rejects path traversal; delete endpoint filename regex limits to `[A-Za-z0-9._-]+\.csv`.

## [0.1.0] - 2026-04-22

### Added

- Initial Vite + React 18 + TypeScript + Tailwind frontend with Claude Code color palette and animated asterisk mark.
- Eleven dashboard pages: Overview, Users (with slide-in detail panel), User Productivity, Trends, Claude Code, Productivity, Adoption, Cost, Audit, Analyze, Archive.
- Express 4 proxy layer on Node 20 covering Analytics, Admin, and Compliance API families.
- S3-first `/api/analytics/users/range` that reads archived partitions before falling back to the live API, with parallel per-day fetches.
- Bedrock integration for AI natural-language query — SSE streaming with two modes: direct snapshot analysis and autonomous Athena SQL generation.
- Cost page backed by a Claude Console Spend Report CSV uploaded to `s3://<archive>/spend-reports/`.
- Economic productivity score that joins spend data with Analytics productivity (`Score = 0.35·output/$ + 0.20·acceptance + 0.20·(1/tokens_per_LOC) + 0.15·commit_velocity + 0.10·PR_velocity`).
- Compliance page backed by the `/v1/compliance/activities` endpoint with risk-event classification and privacy-preserving email masking.
- React Context based i18n with runtime English / Korean toggle and localStorage persistence.
- Global date range control (7d / 14d / 30d / custom) wired through every data page.
- AWS CDK (TypeScript) infrastructure: four stacks — `ccd-network`, `ccd-storage`, `ccd-compute`, `ccd-collector`.
- CloudFront + regional WAF (common, known-bad-inputs, 2000/IP rate limit) + ALB locked to the CloudFront origin-facing managed prefix list.
- Daily collector Lambda that writes partitioned NDJSON to S3 and feeds Glue + Athena for historical queries beyond the 90-day API window.

### Security

- Analytics, Admin, and Compliance API keys stored exclusively in AWS Secrets Manager and injected via `ecs.Secret.fromSecretsManager`.
- ALB SG restricted to the CloudFront origin-facing prefix list (`pl-22a6434b` in ap-northeast-2).
- ECS Fargate tasks run in private subnets with no public IPs.
- Email addresses masked in all UI rendering and in LLM prompts (`maskEmail()` keeps the first 2 chars + domain).

## Reference links

[Unreleased]: https://github.com/whchoi98/claude-code-dashboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/whchoi98/claude-code-dashboard/releases/tag/v0.1.0

---

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

_아직 변경 사항 없음 — 새 항목은 여기로._

## [0.8.0] - 2026-06-10

Analytics API에서 사용자별 비용을 라이브로 제공. CSV 업로드 없이도
Cost 페이지의 per-user "Top by Cost" 테이블과 `distinct_users` KPI가
작동. CSV는 사용자별 토큰 상세 + 재무 정산용으로 선택 사항으로 잔존.
[ADR-0009](docs/decisions/0009-live-user-cost.md) 참조.

### Added

- **`GET /api/cost/users`** — Analytics `user_cost_report`를 통한 라이브 사용자별 USD spend. 최대 50 페이지 페이지네이션, `today − 3` 클램프, `net_spend_usd` 내림차순 정렬. 응답: `{ source: "live", period, data_refreshed_at, users: [{ email, user_id, name, deleted, net_spend_usd, gross_spend_usd, requests }] }`. 이메일은 raw 반환 — 프론트엔드에서 `maskEmail`로 마스킹. 사용자별 토큰 카운트 없음 (비용 + 요청 수만).

### Changed

- **`GET /api/cost/efficiency`**가 이제 선택 기간 그대로 `user_cost_report`에서 라이브 per-user spend를 기본 조회(CSV 기간 활동량 가중 분배 불필요). 라이브 데이터가 없거나 비어있으면 Spend Report CSV 경로로 폴백. 응답 `source`는 `"live+analytics"` (라이브 경로) 또는 `"csv+analytics"` (CSV 폴백). 라이브 모드에서 사용자별 토큰 필드는 0, `tokens_per_loc`은 `null`.
- **Cost 페이지**: per-user "Top by Cost" 테이블과 `distinct_users` KPI가 이제 라이브 (CSV 업로드 불필요). 3개 토큰 기준 per-user 테이블 (`top_total`, `top_input`, `top_output`)은 사용자별 토큰이 있는 경우(CSV 경로)에만 렌더링. 라이브 전용 모드에서는 `cost.top.live_caveat` 안내문이 토큰 한계를 설명.

### Note

사용자별 토큰 상세 (`prompt_tokens`, `completion_tokens`)는 여전히 수동 Spend Report CSV 필요 — 라이브 `user_cost_report` 엔드포인트는 비용 + 요청 수만 제공. CSV 업로드는 선택적 정산 수단으로 잔존.

## [0.7.0] - 2026-06-09

`/analyze` 페이지를 멀티턴 tool-use 챗봇으로 전환하고, 모든 페이지에
플로팅 위젯을 추가. 모델이 턴마다 4개 데이터 도구 중 적절한 것을
자율적으로 선택해 실시간 애널리틱스·S3 아카이브·비용 리포트를 혼합해
답변. 클라이언트 사이드 히스토리(최근 12턴)로 멀티턴 컨텍스트 유지 —
신규 인프라 없음.

### Changed

- **`/analyze`를 멀티턴 tool-use 챗봇으로 전환** — 기존 `direct`/`sql` 모드 선택 + `POST /api/analyze`를 제거. 모드를 직접 고르지 않아도 모델이 도구를 자율 선택. MD/PDF 내보내기 툴바는 유지. [ADR-0008](docs/decisions/0008-tool-use-chatbot.md) 참조.

### Added

- **전 페이지 플로팅 챗 위젯** (`FloatingChat`) — `Layout`에 전역 마운트. `/analyze`로 이동하지 않아도 어느 페이지에서나 챗봇 사용 가능. Analyze 페이지와 동일한 `ChatPanel` 컴포넌트 공유.
- **동적 팔로업 질문** — 답변 후 최대 3개의 문맥 맞춤 후속 질문을 클릭 가능한 pill로 표시.
- **도구 호출 배지** — 메시지 버블 안에 모델이 호출한 도구(`개요`, `Athena SQL`, `비용`, `사용자`)를 실행 중/완료/오류 상태와 행 수와 함께 표시.
- **대화 리셋** — "새 대화" 버튼으로 히스토리와 추천 프롬프트를 초기화.
- **`POST /api/chat/stream`** (Bedrock `ConverseStreamCommand` tool-use 루프, `MAX_TOOL_HOPS=4`, SSE 이벤트: `status | tool_call | tool_result | text | followups | error | done`).
- **`server/chat-tools.js`** — 순수 함수·단위 테스트 가능 헬퍼: 이메일 마스킹, 히스토리 직렬화, 팔로업 파싱, 사용자 랭킹, 개요 압축, `TOOL_SPECS`, `CHAT_SYSTEM_PROMPT`, `makeToolRunner`.

### Removed

- **`POST /api/analyze`**, `generateSql`, `extractSql`, `direct`/`sql` 모드 선택기 — `POST /api/chat/stream`으로 대체.

## [0.6.0] - 2026-05-10

v0.5.x 라인 위에서 UX + 보안 정비. 5개 페이지 통계 테이블이 컬럼별로
양방향 정렬되도록 변경, 사이드바가 메인 스크롤과 함께 움직이지 않도록
viewport에 고정, 날짜 picker가 today−3에서 멈추지 않고 today까지
허용 (UTC/일별 업데이트 안내문 함께 노출), 그리고 v0.1.0 harness-eval
Full 보고서를 받아 진행한 한 차례 보안 hardening
(`.claude/settings.local.json`의 라이브 API 키 redact, deny-list
12 → 29 entries로 확장, allow-list catch-all 와일드카드 prune,
secret 패턴을 공유 lib로 통합, 부팅 시 settings 파일 스캔 가드 추가).

### Added

- **5개 통계 테이블에 양방향 컬럼 정렬** (Cost · Full Efficiency Matrix · Adoption · Top Chat Projects · Users · UserProductivity · Compliance · 감사 피드). 컬럼 클릭 시 정렬, 한 번 더 클릭 시 방향 토글. 활성 컬럼은 ▲/▼ 표시, 비활성은 흐린 ↕로 클릭 가능함을 알림. User / project / actor / event-type 컬럼은 문자열 정렬(`localeCompare` — 한글도 정상 정렬), 숫자 컬럼은 수치 비교, `null` / `undefined`는 방향 무관하게 항상 하단 고정. 신규 공유 컴포넌트: `src/lib/useSortable.ts` + `src/components/SortableTh.tsx`. Users / UserProductivity의 페이지별 단방향 `Th` 컴포넌트를 대체.
- **DateRangeControl 안내문**: `데이터 시간대 UTC · 매일 업데이트 · 최근 3일은 부분 집계일 수 있음 (Analytics 버퍼)`. `Apply` 버튼과 안내문 모두 i18n.
- **`docs/anthropic-api-fields.md`** — 신규 레퍼런스 (309 LOC). 대시보드가 사용하는 Anthropic Analytics + Compliance API의 모든 필드를 카탈로그화하고 공식 문서 canonical URL과 LLM-friendly `.md` 변형 트릭을 명시.
- **`.claude/hooks/lib/secret-patterns.sh`** — 공유 7-pattern 배열. `secret-scan.sh` (PreToolUse)와 `session-context.sh` (SessionStart) 양쪽이 source — 두 hook의 패턴 drift 방지.

### Changed

- **사이드바를 viewport에 고정.** 외부 flex 래퍼가 `h-screen`, 사이드바와 메인이 각각 `h-full overflow-y-auto`로 독립 스크롤. body-level 스크롤이 사이드바를 함께 끌고 가던 문제 해결.
- **날짜 picker `maxEnd`를 `today − 3`에서 `today` (UTC)로 상향.** Analytics API는 최근 ~3일에 대해 부분 집계만 반환하지만 안내문에서 그 이유를 명시. Preset 윈도우는 today를 끝으로 (예: 7d preset = `[today−6, today]`, 이전엔 `[today−9, today−3]`).
- **Harness deny-list 12 → 29 entries로 확장**: `rm -fr*`, `rm --recursive*`, `chmod -R 777*`, `chmod 777 /*`, `dd of=/*`, `mkfs.*`, `curl|bash`, `curl|sh`, `wget|bash`, `wget|sh`, `git push --mirror`, `git filter-branch`, `aws iam delete-policy`, `aws s3 rb s3://* --force` (공백 포함 — 표준 CLI 문법), `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws rds delete-db-cluster`, `aws cognito-idp delete-user-pool`, `aws secretsmanager delete-secret` 추가. `Bash(rm -rf *)` (`rm -fr*`에 포섭됨)와 `Bash(aws s3 rb s3://*--force)` (공백 없는 형식은 실제 CLI 호출에 도달 불가) 제거.
- **`session-context.sh` SessionStart secret 가드**가 부팅 시 `.claude/settings*.json` 두 파일을 JSON 트리 walk으로 스캔 (`grep`/`git grep` 감사 명령 string은 false-positive 방지를 위해 skip). 한 가지 quoting 스타일만 매칭하던 fragile한 `grep -v` 라인 필터를 대체. PreToolUse `secret-scan.sh`가 `tool_input` payload만 검사하므로 permission-acceptance 흐름으로 들어온 secret은 잡히지 않던 v0.5.1 사고의 gap을 보강.

### Fixed

- **`.claude/settings.local.json`에 commit된 라이브 Anthropic API 키** (v0.5.1 기준 라인 30, 58, 59)를 `__TRACKED_VAR__` placeholder로 redact. `git log -p -S`로 키가 git 히스토리에 들어간 적 없음 확인 (gitignored). 사용자는 여전히 Anthropic Console에서 자격증명을 회전해야 함 — placeholder 교체는 disk-at-rest 노출만 차단.
- **Allow-list catch-all 와일드카드 prune** (8개 제거 — `Bash(bash *)`, `Bash(node *)`, `Bash(python3 *)`, `Bash(git *)`, `Bash(grep *)`, `Bash(aws ec2 *)`, `Bash(aws ecs *)`, `Bash(aws secretsmanager *)`). 가장 위험한 도구 family들에 대해 deny-list를 조용히 무력화하고 있던 entries. 안전한 read-only entries로 대체 (`git status`/`diff`/`show`/`log`, `grep -n`/`-E`/`-rn`, `aws ec2 describe-instances`, `aws ecs describe-tasks`/`list-services`, `aws secretsmanager get-secret-value`/`list-secrets`).
- **i18n 우회로 영문 하드코딩**된 문자열들 — `ClaudeCode.tsx` (4 KPI 라벨 + hint, 3 ChartCard 제목/부제, Bar legend `name="Lines of Code"`)와 `Adoption.tsx` (3 ChartCard 제목/부제, 5 테이블 헤더, 4 Bar legend, stale 콜아웃의 "never" 폴백). 모든 키는 이미 `en`과 `ko` 사전 양쪽에 정의되어 있었음 — JSX가 사용하지 않고 있던 것뿐. 한국어 locale에서 두 페이지가 완전히 한글로 렌더됨.
- **`secret-scan.sh` PEM private-key true-positive fixture #20이 silent fail이었음**: `grep -E`가 PEM begin-marker의 앞쪽 dash들을 옵션 플래그로 파싱 → hook이 차단 대신 exit 0 반환. `--` 구분자 추가 (`grep -qE -- "$pat"`). 테스트: 53/54 → 54/54 pass.
- **Python `FutureWarning: Possible nested set`** — SessionStart 가드 정규식이 char class 안에 POSIX `[[:space:]]`를 사용해 발생. AWS secret-key 패턴을 `\s`로 전환 (grep -E와 Python re 모두 깔끔하게 수용).

## [0.5.1] - 2026-05-09

경영 요약 페이지에서 기간을 변경해도 KPI가 갱신되지 않던 문제 수정
(이전엔 `users` 단일 일자 호출이라 LOC와 도구 수락률이 항상
`endingDate-3` 값으로만 보였음). 동시에 KPI를 6개 → 12개로 확장하고
생산성 점수 게이지를 추가, 헤드라인 요약을 윈도우 집계 기준으로
재작성.

### Changed

- **경영 요약 페이지를 `/api/analytics/users/range` 기반으로 재구성** (이전: 단일 일자 `/api/analytics/users?date=...`). LOC · 커밋 · PR · 세션 · 도구 수락률 · 활동 개발자 distinct 카운트 모두 윈도우 집계값으로 — 기간 변경 시 모든 수치가 재계산됨.
- **레이아웃: KPI 6개 → 12개**, 3개 섹션(사용자 · 생산성 · 비용 & 리스크)으로 그룹화:
  - *사용자*: 활동 개발자(윈도우 distinct), 평균 DAU(피크 동시 표시), 월간 도입률, 할당된 시트.
  - *생산성*: 추가 LOC(윈도우 합 + 커밋/PR), 도구 수락률(윈도우 합), 세션/개발자/일, 복합 생산성 점수(0-100, Productivity 페이지와 동일 공식).
  - *비용 & 리스크*: 지출(개발자/일당 비용 hint), 30일 예상(7일 평균 기준 hint), 1k LOC당 비용, 위험 이벤트.
- **헤드라인 재작성** — 윈도우 집계값 참조 (`{days}일`, `{seats}명 시트 중 {devs}명`, `{loc} LOC`, `{commits} 커밋`, `{accept}`, `{spend}`, `{proj}`, `{score}/100`, `{risk}`, 최대 지출 모델). 모든 값이 기간 picker에 반응.
- **부제** 명시화 — `"모든 KPI는 윈도우 집계값 — 기간을 변경하면 모든 수치가 갱신됩니다."`

## [0.5.0] - 2026-05-09

인사이트 강화. CFO/CTO 대화에서 부족했던 지표와 시각화를 추가:
경영 요약 단일 화면 페이지, Cost 페이지의 월말 예상 + 개발자당 비용,
Compliance 페이지의 위험 이벤트 spike 임계선, Adoption 페이지에서
선택 윈도우 내에서 사용량이 줄어든 스킬/커넥터를 표면화하는
"stale" 콜아웃.

### Added

- **경영 요약 페이지 (`/exec`)** — 단일 화면 CFO/CTO 스냅샷. 6개 헤드라인 KPI(활동 개발자, 월간 도입률, LOC, 윈도우 지출, 30일 예상, 위험 이벤트) + 1줄 헤드라인 요약 + DAU·일별 지출 트렌드 차트. Analyze/Cost와 같은 `app-print` 패턴 사용 — 인쇄 대화상자에서 사이드바 없이 깔끔한 PDF로 공유. 사이드바에 "Executive" 항목 (`Exec` 배지) 추가.
- **Cost 페이지 개발자당 비용 KPI** (`src/pages/Cost.tsx`): `총 지출 / 윈도우 활동 개발자 수`를 새 KPI 카드로 표시. 활동 개발자 수는 `eff.user_count → csv.distinct_users → cost.totals.distinct_users` 순으로 폴백 — 라이브, CSV, 하이브리드 모드 모두 작동.
- **Cost 페이지 30일 예상 KPI** (라이브 모드 전용): `data.daily`에서 최근 7일 평균 × 30으로 롤링 예측. 형제 KPI "일평균 (7일)"도 함께. CSV 전용 모드에선 일별 데이터가 없어 숨김.
- **Compliance 위험 이벤트 spike 임계선**: 일별 이벤트 차트에 `평균(일별 위험 수) + 1·표준편차` (반올림, 1 이상 floor) 가로 reference line 추가. 임계선 위 막대 = 통계적 outlier로 조사 필요. 차트 부제에 임계값 노출.
- **Adoption 스킬/커넥터 stale 콜아웃**: 각 차트 카드 아래 amber 콜아웃이 *윈도우 전반부에만 사용되고 후반부에 0인* 항목을 나열. 절대 합계 정렬로는 여전히 상단에 보이는 도입 감소 항목을 표면화.

### Changed

- **Compliance 일별 차트**가 단순 line chart → `ComposedChart`로 전환. 위험 카운트는 주황색 막대(spike 인지 용이) + 총 이벤트 선 + 새 임계선 결합.

### Internal

- 인쇄 CSS 클래스를 `analyze-print` → `app-print`로 일반화 — Analyze, Cost, Executive 등 여러 페이지가 하나의 `@media print` 규칙을 공유. visibility 기반 격리, `<details>` 자동 확장, 색상 보존 힌트는 `src/index.css`에서 관리.

## [0.4.0] - 2026-05-09

UX 다듬기. 사이드바에서 진입하는 모든 페이지의 기본 기간을 14d/30d
에서 7d로 통일; Analyze와 Cost 페이지에 "PDF로 저장" + "MD로 저장"
버튼 추가 (브라우저 기본 인쇄 사용, 신규 의존성 0); Archive 기본
Athena 쿼리가 TYPE_MISMATCH로 실패하던 버그 수정; 사이드바 하단에
ap-northeast-2 기준 예상 월 비용 표기.

### Added

- **Analyze 페이지 PDF / MD 내보내기** (`src/pages/Analyze.tsx`): 대화가 한 턴 이상 쌓이면 우측 상단에 툴바 노출. *MD*는 Blob 다운로드(타임스탬프 파일명, 쿼리 결과는 GFM 표, SQL은 펜스 코드 블록). *PDF*는 `body.app-print` 추가 후 `window.print()` — 사용자가 브라우저 인쇄 대화상자에서 "PDF로 저장" 선택. `src/index.css`의 일반화된 `@media print` 규칙은 visibility 기반 격리로 `.print-export` 서브트리만 남기고 나머지를 가리며, `<details>`는 자동 확장돼 SQL + 결과 표가 클릭 없이 그대로 인쇄.
- **Cost 페이지 PDF 내보내기** (`src/pages/Cost.tsx`): Analyze와 동일한 `app-print` 메커니즘 재사용. 버튼은 DateRangeControl 옆에 위치. 정산 expander와 날짜 picker는 `print-hide`로 태깅돼 인쇄본은 KPI + 차트 + Top-10 표만 출력. 라이브/CSV 모드 모두 작동.
- **사이드바 AWS 월 예상 비용** (`src/components/Layout.tsx`): 사이드바 하단에 `AWS 월 예상: ≈ $65/mo · ap-northeast-2` 라벨. 호버 툴팁에 컴포넌트별 내역 (Fargate $10 · ALB $22 · WAF $8 · Bedrock $5 · Athena $2 · S3+Glue+CloudWatch $2 · Secrets Manager $1 · CloudFront+Lambda@Edge $1 · Collector $0.10). 정적 추정치 — 사용량 기반 항목은 트래픽에 따라 변동.

### Changed

- **기본 기간 14d / 30d → 7d** 통일: Overview, Users, UserProductivity, Productivity, Trends, ClaudeCode, Adoption, Cost, Compliance, `useDateRange()` 기본값까지. UserSearch의 "All" 프리셋도 7d로 변경. Trends와 Cost는 이전엔 30d 기본이었으나 range control로 여전히 30d / 14d 선택 가능.

### Fixed

- **Archive 페이지가 모든 `WHERE date BETWEEN DATE '…' AND DATE '…'` 쿼리에 `athena_error` 반환** (기본 쿼리 포함). 근본 원인: Glue 테이블 파티션 `date`가 `varchar` 타입인데 기본 쿼리와 SQL 모드 스키마 힌트 모두 `DATE '…'` 리터럴로 감쌈. Athena Engine v3는 `TYPE_MISMATCH: Cannot check if varchar is BETWEEN date and date`를 throw — Trino가 varchar→date 자동 캐스팅을 거부. 단순 문자열 리터럴 (`WHERE date BETWEEN '2026-04-01' AND '2026-04-30'`)로 전환 — 영-패딩 ISO 날짜는 문자열 비교가 정확히 동작하면서 partition projection도 그대로 pruning. `/api/analyze` SQL 모드가 올바른 형식을 생성하도록 `server/aws.js` 스키마 힌트도 갱신.
- **Athena 폴링 타임아웃 20초 + 조용한 fall-through**: `runAthena`가 40×500ms 폴링 후에도 쿼리가 RUNNING이면 그냥 `GetQueryResultsCommand`로 진행 → SDK가 거부하면 일반 `athena_error`로만 surface. 120×500ms (60초)로 증가 + 명시적 timeout 에러 (`Athena query did not finish within 60 s. Try a narrower date range.`) 추가.

## [0.3.0] - 2026-05-09

신뢰성 + UX 마일스톤. Compliance 감사 피드 페이지네이션 fix
(활발한 조직에선 사실상 1페이지만 보이던 버그), Analyze Quick
prompts를 인사이트 중심으로 재작성, 사용자별 드릴다운 대시보드
(User Search) — 활동 히트맵 + 연속 활동 일수 + CSV 기반 비용,
사이드바 버전 배지 + 빌드 타임에 이 파일을 렌더하는 인앱
`/changelog` 페이지. 이번 릴리즈의 감사 페이지네이션 + prewarm
결정은 [ADR-0004]에 기록.

[ADR-0004]: docs/decisions/0004-compliance-pagination-prewarm.md

### Added

- **Compliance/감사 피드 페이지네이션 + warm cache**: `/api/compliance/activities`가 업스트림의 실제 cursor (`after_id` = 각 페이지 마지막 이벤트 id)를 사용하도록 수정. `starting_date`로 조기 종료, `stop_reason` + `in_window` 응답 필드로 잘림 여부를 UI에서 안내. ECS task 부팅 시 + 5분마다 7d / 14d / 30d 자체 prewarm — 대부분의 사용자가 30+ 초 페이지네이션 대신 1초 미만 캐시 hit. cap 도달 시 amber 경고 배너 노출.
- **Analyze 페이지 Quick prompts 5 → 12개로 확장** (도입/생산성/비용/리스크 4개 카테고리). 각 prompt가 다축 결합 (예: "도구 수락률과 함께 Top 기여자", "주간 spend 50%↑ 또는 토큰/LOC 2배 사용자", "다음 달 spend 예측") — 차트로 한눈에 답하기 어려운 신호를 AI가 표면화.
- **사용자 검색(User Search) 페이지** (`/user-search`): Anthropic 공식 per-user analytics-app 샘플을 모델로 한 사용자별 드릴다운 대시보드. 두 개 탭(Overview / Model), 이메일 검색 + 콤보박스, 4단계 프리셋 날짜 토글(전체 / 30d / 14d / 7d). Overview는 8 KPI(세션, 메시지, 총 토큰, 활동 일수, 현재 streak, 최장 streak, peak 요일, 선호 모델), 활동 히트맵(7행 × N열 캘린더 그리드, 5단계 Claude 팔레트), 비용 요약 카드(CSV 기반, 선택 range에 활동량 가중 분배). Model 탭은 일별 토큰 막대(활동량 가중 분배 추정) + 모델별 input/output/% 분해. ~520 LOC, 신규 서버 엔드포인트 0개 — 기존 `/api/cost/csv` + `/api/analytics/users/range` 합성.
- **`c4e.whchoi.net` alias 도메인** Cognito user pool client에 callback/logout URL 등록. `*.whchoi.net` ACM 와일드카드 인증서와 CloudFront alias는 이미 존재 — Cognito만 추가 등록.
- **사이드바 버전 배지 + `/changelog` 페이지**: `package.json`의 `version`이 제품명 아래에 작은 claude-orange 알약으로 렌더되며, 클릭 시 인앱 Changelog 페이지로 이동. 이 페이지는 Vite의 `?raw` 텍스트 import로 `CHANGELOG.md`를 가져와 활성 로케일 섹션을 기존 `Markdown` 컴포넌트(GFM 표 / 헤딩 / 코드 / 링크 처리)로 렌더링. 단일 진실 공급원: `package.json` 버전 bump + 이 파일에 `## [x.y.z]` 블록 추가만으로 다음 배포에서 배지와 페이지 모두 갱신.

### Changed

- **In-memory upstream 캐시 TTL 5분 → 10분** — 신규 compliance prewarm 5분 주기와 overlap 보장, cold-fetch 가능성 감소.
- **Compliance 요청 cap 500/5pages → 2000/20pages** — 매우 활발한 조직에선 부분 커버리지 trade-off. ALB / CloudFront 30s origin 응답 timeout 안전 마진. upstream 캐시 + prewarm으로 대부분 비용 숨김.

### Fixed

- **Compliance/감사 피드가 사실상 1페이지에서 멈춤**: 서버 페이지네이션이 `body.next_page`에 의존했으나 업스트림 `/v1/compliance/activities`는 그 필드를 반환하지 않음 — cursor는 `after_id=<last_event_id>`. 1페이지 후 종료 → audit 페이지가 항상 최근 ~100 이벤트(활발한 조직에선 보통 1일치)만 표시. `data[-1].id`로 cursor를 만들고, `starting_date`로 조기 종료하도록 수정. prewarm 캐시와 결합해 1.5+ 분 cold fetch가 sub-second 사용자 응답으로 전환.
- **Docker `.dockerignore`가 `CHANGELOG.md` 제외**: 신규 `/changelog` 페이지의 Vite `?raw` import가 production 이미지 빌드에서 unresolved-module 에러로 실패 (로컬 빌드는 성공, ECS 이미지 빌드만 실패). 제외 목록에서 `CHANGELOG.md` 제거 (이미지 사이즈 ~17 KB 추가 — 무시 가능). 런타임에 불필요한 `sample/` 추가.

### Security

- Cognito OAuth **client callback / logout URL 화이트리스트** 확장: `https://c4e.whchoi.net/parseauth` + `https://c4e.whchoi.net/`. Lambda@Edge auth 핸들러가 `redirect_uri`를 실제 `Host` 헤더에서 파생하므로 와일드카드 인증서/alias가 이미 있는 한 Cognito 등록만으로 모든 서브도메인 작동.

## [0.2.0] - 2026-05-08

하이브리드 라이브 비용 API + Cognito 인증 + 인-대시보드 CSV 관리.
0.1.0 이후 작업 누적: Lambda@Edge 인증, 셀프서비스 Spend Report
업로드, Anthropic Analytics API 기반 신규 `/api/cost/live` 엔드포인트,
하이브리드 라이브 + CSV Cost UX, 활동량 가중 사용자별 spend 분배,
일별 트렌드 차트, 30일 caveat 배너. 이번 릴리즈의 세 가지 아키텍처
결정은 [ADR-0001], [ADR-0002], [ADR-0003]에 기록.

[ADR-0001]: docs/decisions/0001-cognito-lambda-edge-auth.md
[ADR-0002]: docs/decisions/0002-dashboard-csv-upload.md
[ADR-0003]: docs/decisions/0003-hybrid-live-cost.md

### Added

- **Anthropic Analytics API 기반 라이브 비용 데이터** (`GET /api/cost/live`): 약 4시간 주기로 갱신되는 조직 단위 spend / token 데이터를 `starting_date` / `ending_date`로 조회. 내부적으로 `/v1/organizations/analytics/cost_report` (USD + 요청 수)와 `/analytics/usage_report` (input/output/cache 토큰)를 `(product, model)` 단위로 조인 후 기존 `CsvResp` 형태로 reshape — Cost 페이지의 차트 집계 로직 변경 없음. 이미 `/api/analytics/*` proxy에서 쓰던 analytics 키 재사용 — 신규 시크릿 0개.
- **하이브리드 라이브 + CSV Cost UX**: 메인 집계(KPI · 제품/모델 차트 · 일별 트렌드)는 라이브 API에서, per-user Top-10 테이블은 업로드된 CSV에서 — Anthropic analytics 엔드포인트는 사용자 차원을 제공하지 않음. 신규 `useCostData` 훅이 두 소스를 병렬 fetch하고 둘 중 한쪽 부재 시 자동 폴백. CSV 업로더는 `<details>` 정산 expander로 접힘 (CSV 모드일 때 자동 펼침).
- **"모델별 일별 지출" 트렌드 차트** (라이브 모드 한정): 라이브 API 응답의 `daily` 배열을 stacked-area Recharts로 시각화 — 선택 기간의 일별 spend 흐름을 한눈에.
- **30일 amber caveat 배너** + 페이지 상단 `DateRangeControl` (라이브 모드 한정) — 데이터 신선도 계약을 표시하고, 페이지 전체 위젯이 동일 range로 움직이도록 단일 picker 제공.
- **활동량 가중 사용자별 spend 분배**: `/api/cost/efficiency`가 CSV 전체 기간에 대한 Analytics 활동량도 추가로 fetch해, 사용자별 `ratio = sessions_in_selected_range / sessions_in_csv_period` (1.0 cap)을 계산하고 `range_spend_usd` / `range_prompt_tokens` / `range_completion_tokens` / `range_total_tokens` / `range_requests`를 응답에 추가. Cost 페이지 Top-10 per-user 테이블이 *기간 선택에 반응*하게 됨 (이전엔 항상 CSV 전체 기간 합계).
- **Cognito + Lambda@Edge 인증**: 이제 모든 CloudFront URL은 Cognito Hosted UI 로그인을 거쳐야 접근 가능. 네 개의 viewer-request Lambda@Edge 함수가 모든 엣지 PoP에서 실행 — `check-auth` (default), `parse-auth` (`/parseauth`), `refresh-auth` (`/refreshauth`), `sign-out` (`/signout`). JWT 검증은 User Pool의 JWKs + 컨테이너별 5분 캐시 사용. 미인증 트래픽은 WAF · ALB · ECS에 도달하기 전에 차단.
- **사이드바 로그아웃 링크**: SPA 라우터를 우회하도록 순수 `<a href="/signout">`로 구현 — 브라우저가 실제 요청을 보내야 엣지 핸들러가 HttpOnly 쿠키 삭제 + Cognito `/logout`으로 리다이렉트 가능.
- **대시보드에서 CSV 업로드/목록/삭제**: 세 가지 새 엔드포인트 — `POST /api/cost/upload`, `GET /api/cost/uploads`, `DELETE /api/cost/uploads/:file` — 덕분에 Spend Report 갱신 시 AWS CLI 권한 불필요. Multer 기반 multipart 처리기 (25 MB 상한, 필수 컬럼 스키마 체크, path-traversal-safe 파일명). 클라이언트 프리뷰 (행 수, 사용자 수, 파일명 기반 기간 추출) + 기존 업로드와 기간 중복 경고.
- **비용 페이지 기간 선택 컨트롤**: 다른 페이지와 동일한 7d / 14d / 30d / 커스텀 picker, **Economic Productivity 섹션** (CSV × 실시간 Analytics per-user 생산성 조인)에 연결. 상단 KPI는 CSV 고정 기간에 바인딩 유지 — CSV는 사전 집계 데이터라 일별 필터링 불가. 서버가 실제 적용한 기간(Analytics 3일 버퍼 반영됨)을 UI에 명시.
- **`useFetch()`에 `refetch()` 추가**: mutation을 발생시키는 UI (첫 이용자: `CsvUploader`)가 full reload 없이 캐시된 GET을 무효화 가능.
- Lambda@Edge용 **빌드 타임 시크릿 주입** `scripts/build-edge.mjs`: `_shared.template.js`에서 Secrets Manager(`ccd/cognito-config`)의 값을 치환하여 `infra/edge/dist/`를 생성. `dist/`는 gitignore.
- Cognito 사용자 관리 runbook: [`docs/runbooks/cognito-users.md`](docs/runbooks/cognito-users.md).

### Changed

- **Cost 페이지 메인 데이터가 기본적으로 라이브 API** (이전: CSV 전용). KPI · 제품/모델 차트 · 일별 트렌드 · 날짜 picker 모두가 선택 range를 반영. CSV는 자동 폴백(라이브 빈/오류 시) + 30일 이상 재무 정산용 진실 공급원으로 잔존. Per-user 위젯은 항상 CSV 기반(라이브에 user 차원 없음), 단 활동량 가중 분배로 *날짜 변경에 반응*하도록 강화.
- `PageHeader source` prop union에 `'csv'` 추가 (이전 `'live' | 'mock'`). 배지 라벨이 `'csv' → "CSV"`로 매핑 (이전엔 fall-through로 "Mock" 표시).
- Cost 페이지 subtitle / source 배지 / Total Spend KPI hint가 동적으로 라이브와 정산 CSV 사이 전환. 라이브 모드 + CSV 기반 Top-10 노출 시 작은 caveat 안내.
- Analytics → CsvResp reshape에서 `Math.round(cents)` 제거. 단순 `cents / 100` + `toFixed(4)` 누적으로 sub-cent 정밀도 유지 (업스트림이 분수 cents를 반환할 가능성 대응).
- Cost 페이지 상단 데이터(KPI · 제품×모델 테이블 · Top-10)는 CSV의 고정 기간에 바인딩 유지. Economic Productivity 섹션만 기간 선택에 반응.
- `@aws-sdk/client-secrets-manager`를 레포 루트에 추가 — edge bundle 빌드 단계에서 사용.
- `multer` 2.x (2.1.1) 추가 + 명시적 JSON 에러 래퍼: 모든 업로드 실패 경로가 Express 기본 HTML 에러 페이지 대신 구조화된 JSON 반환.

### Fixed

- **`/api/cost/live` 초기 구현이 production에서 0행 반환**: 첫 버전이 admin 키로 `/api/admin/claude-code/range`를 self-call했으나 그 admin 키가 *Claude Code 활동 0인 별도 워크스페이스* 소속. 조직 전체 Analytics API(`cost_report` + `usage_report`, analytics 키)로 마이그레이션 — 모든 product의 실제 spend 가시화. 미사용된 `claudeCodeRangeToCostResp`를 `analyticsReportsToCostResp`로 교체, 단위 테스트 fixture 갱신.
- **CSV 모드에서 페이지 상단 `DateRangeControl`이 *거짓말* 동작**: KPI 위에 위치해 페이지 전체 필터처럼 보였으나 CSV는 단일 기간 스냅샷이라 날짜 변경이 메인에 영향 없음. 라이브 모드에서만 노출하도록 게이팅 — Productivity 섹션 자체 picker는 그대로 (그쪽은 실제로 range 적용).
- **CSV 배지의 "CSV · " trailing dot-space**: `data.file`이 null일 때 템플릿 리터럴 `\`CSV · ${data.file ?? ''}\``가 `"CSV · "` 렌더링. 기존 `cost.source.csv` i18n 키로 폴백하는 ternary로 교체.
- **`useCostData` 로딩 깜빡임**: 이전 공식이 라이브 채널이 in-flight인 동안 `loading=true`를 유지 → CSV 채널이 이미 사용 가능한 데이터를 갖고 있어도 화면이 비었음. `data == null && (live.loading || csv.loading)`으로 조여 *유효 데이터 도달 즉시* 렌더.
- **`useCostData.refetch`가 메모이제이션 안 됨**: 매 렌더마다 새 함수 참조 — `useEffect` deps에 사용 시 무한 re-render. `useCallback([live.refetch, csv.refetch])`로 wrap.
- **자체 호출(self-call) 쿼리 파라미터 미인코딩**: `req.query`에서 온 날짜 값이 `/api/admin/claude-code/range` self-call URL에 그대로 삽입 → 정교한 요청으로 추가 파라미터 주입 가능. 양쪽 날짜 모두 `encodeURIComponent` 적용.
- **WAF `SizeRestrictions_BODY`가 8 KB 초과 POST 전부 차단**: 기본 `AWSManagedRulesCommonRuleSet`의 서브룰이 신규 `/api/cost/upload`를 WAF 403 HTML 페이지(`<html> <h...`)로 조용히 끄고 있었음. `ruleActionOverrides`로 COUNT 다운그레이드 — 규칙은 로그만 남고 BLOCK하지 않음. 나머지 CommonRuleSet 보호(XSS · SQLi · LFI/RFI · bad UA)는 그대로 BLOCK 유지.
- 업로드 sanitizer의 CSV 파일명 정규식이 Anthropic Console 실제 export 형식(`spend-report--YYYY-MM-DD-to-YYYY-MM-DD.csv`, 이중 대시)을 수용하도록 수정 — 기간이 fallback 오늘 날짜로 손실되지 않음.
- 업로드 진입점에 `console.log` 진단 로그 추가 — 실패한 업로드가 컨테이너까지 도달했는지 vs 상류에서 차단됐는지 CloudWatch 로그로 구분 가능.

### Security

- **`.env` 파일 권한 강화 (664 → 600)**. Anthropic API 키가 어떤 commit에도 노출된 적 없음을 검증 (`git log -p -S sk-ant-api01-…` 전수 확인); disk-at-rest 노출 표면 축소.
- Cognito OAuth **client secret 회전** (구 `3qf1cr3r61vgc3cge9qh6cf5ik` 삭제, 신규 `5bbe3af5qkqv3rghgutp64fgc6`로 교체) — 초기 시크릿이 잠시 로컬 디스크에 있었기 때문. 새 시크릿은 git에 올라간 적 없음.
- Pre-commit 훅에 `clientSecret[:=]['\"][a-z0-9]{40,}` 패턴 + `infra/edge/dist/` 경로 blocklist 추가 — `git add -f`로도 Lambda@Edge 번들(시크릿 포함)을 커밋 불가.
- 업로드 엔드포인트 파일명 정규식이 path traversal 차단, 삭제 엔드포인트는 `[A-Za-z0-9._-]+\.csv`로 제한.

## [0.1.0] - 2026-04-22

### Added

- Claude Code 색상 팔레트와 애니메이션 asterisk 아이콘을 적용한 Vite + React 18 + TypeScript + Tailwind 프론트엔드 초기 구현.
- 11개 대시보드 페이지 구성: 개요, 사용자(슬라이드인 상세 패널 포함), 사용자별 생산성, 추세, Claude Code, 생산성, 도입, 비용, 감사, 분석, 아카이브.
- Analytics · Admin · Compliance 세 API 계열을 프록시하는 Node 20 기반 Express 4 레이어.
- S3 아카이브 우선 조회 + 실 API fallback 구조의 `/api/analytics/users/range`, 일자별 병렬 fetch로 30일 구간 9초 → 250 ms 단축.
- Bedrock 기반 AI 자연어 질의 — SSE 스트리밍과 두 가지 모드 제공: 실시간 스냅샷 직접 분석, 자율 Athena SQL 생성.
- Claude Console Spend Report CSV(`s3://<archive>/spend-reports/` 업로드) 기반 비용 페이지.
- 지출 데이터와 Analytics 생산성을 결합한 경제 생산성 점수 도입 (`Score = 0.35·output/$ + 0.20·acceptance + 0.20·(1/tokens_per_LOC) + 0.15·commit_velocity + 0.10·PR_velocity`).
- `/v1/compliance/activities` 엔드포인트 기반 감사 페이지, 위험 이벤트 자동 분류 및 이메일 마스킹 적용.
- React Context 기반 i18n, 영/한 실시간 토글과 localStorage 영속화.
- 모든 데이터 페이지에 연결되는 글로벌 날짜 범위 컨트롤 (7일 / 14일 / 30일 / 커스텀).
- AWS CDK(TypeScript) 인프라: `ccd-network` · `ccd-storage` · `ccd-compute` · `ccd-collector` 네 개 스택.
- CloudFront + 리전형 WAF(Common / KnownBadInputs / IP당 2000 rate limit) + CloudFront origin-facing managed prefix list로 잠긴 ALB.
- 파티션 NDJSON을 S3에 저장하고 Glue + Athena로 90일 API 윈도우 이후까지 조회 가능하게 하는 일일 collector Lambda.

### Security

- Analytics · Admin · Compliance API 키를 AWS Secrets Manager에만 저장하고 `ecs.Secret.fromSecretsManager`로만 주입.
- ALB Security Group을 CloudFront origin-facing prefix list(ap-northeast-2: `pl-22a6434b`)로만 제한.
- ECS Fargate 태스크는 프라이빗 서브넷에서 실행되며 퍼블릭 IP 없음.
- UI 렌더링과 LLM 프롬프트 전반에서 이메일 마스킹 적용 (`maskEmail()`은 앞 2자 + 도메인 유지).

## 참조 링크

[Unreleased]: https://github.com/whchoi98/claude-code-dashboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/whchoi98/claude-code-dashboard/releases/tag/v0.1.0
