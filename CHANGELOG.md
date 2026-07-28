# Changelog

[![English](https://img.shields.io/badge/lang-English-informational)](#english)
[![한국어](https://img.shields.io/badge/lang-한국어-informational)](#한국어)

---

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.3] - 2026-07-28

The AI analysis chatbot can now answer questions about recent days. Reported as: asking "who was most active on July 27" returned "no data for July 27 yet" — even though two sources could answer it (the live `user_usage_report` serves per-user activity through TODAY at a ~4h watermark, and `compliance_daily` has per-actor audit events through yesterday). The system prompt routed every per-user ranking to `search_users`, whose snapshot ends at the 3-day analytics buffer.

### Added

- **`get_user_usage` chat tool.** Per-user request counts and token usage (live `user_usage_report`), ranked by requests, serving recent days including today. The system prompt now carries a buffer-day strategy — a question about today/yesterday must never be answered with a bare "no data": try `get_user_usage` (through today) and `compliance_daily` per-actor event counts (through yesterday), and present the numbers as preliminary. `search_users` is explicitly labeled finalized-days-only.

### Fixed

Three defects the pre-deploy adversarial review confirmed in the new tool, fixed before it shipped:

- **Real names stripped from tool results.** The tool initially forwarded the upstream actor `name` alongside the masked email — a real name next to `wh***@…` fully re-identifies the person, defeating the masking (no other per-user surface, UI or chat, exposes names). Masked email is now the only identity key, matching the `search_users` contract.
- **Model-picked windows span-capped at 31 days.** A "most active over the last year" question would have fanned out into a silent ≤186-day multi-chunk upstream walk (~60–110 requests on the shared 60 rpm budget) and presented the clamped result as the full ask. `clampChatUserWindow` now caps the window to the newest 31 days, and `span_clamped`/`window_clamped`/`stale` flags flow through to the model so it states the actually-served window.
- **Chat windows excluded from keep-warm.** A chat-picked window is consumed once per turn, but it self-registered into the cost keep-warm registry — up to ~11 dead background upstream refetches over the next 90 minutes per question, and a burst of distinct windows could evict the Cost page's preset keys. The chat path now passes `warm: false` (same rationale as the existing multi-chunk guard).

## [2.0.2] - 2026-07-28

The Cost page's '1d' preset now means TODAY. Reported as "selecting 1d analyzes July 24, not today" — the preset deliberately anchored to the newest finalized day back when per-user cost data stopped at the 3-day buffer; the cost family has served today (at a ~4h refresh watermark) since 2026-07, so the anchor was stale.

### Changed

- **Cost '1d' targets today (`freshEnd`).** `useDateRange` gains a `freshEnd` option: '1d' still anchors to the newest finalized day (today−3) by default — engagement endpoints clamp server-side to the 3-day buffer, so a "today" label there would mislabel the data — and only Cost opts in (its whole family serves recent days). The '1d' tooltip explains each variant (new i18n keys, en/ko).

### Fixed

Three defects the pre-deploy adversarial review confirmed in the change itself, fixed before it shipped:

- **Server keep-warm presets moved with the frontend.** The cost cache's preset windows still seeded '1d' as `[today−3, today−3]` — with the frontend now requesting `[today, today]`, every default Cost open would have gone cold daily (the group-tab first click regressing to its 12–30s upstream stall) while ~12 dead keys per org kept burning the shared 60 rpm budget every 8 minutes. Presets now warm `[today, today]`; the one exception stays pinned to the finalized day: `/cost/efficiency`'s ungrouped `user_cost_report` key, because that route clamps its whole window to today−3 internally.
- **Empty "today" no longer falls back to the CSV.** From 00:00 UTC (09:00 KST) until the ~4h watermark ingests today's first usage, the live report legitimately returns zero rows — the old fallback chain would have rendered the uploaded CSV's whole export period (or the "upload a CSV" empty state on CSV-less orgs) under a "today" picker every single morning. A settled-but-empty live response now counts as usable for a today-only window and the page renders zeros plus an explanatory note.
- **No forecast KPIs or cross-window fallbacks on a partial day.** With a today-only window, the 30-day projection / 7-day average tiles extrapolated a few ingested hours ×30 (understating the run-rate several-fold all day) and the per-user Top tables silently substituted other windows (efficiency's today−3, the CSV's export period). Today-only windows now render forecast placeholders and keep the Top tables on live same-window sources only.

## [2.0.1] - 2026-07-27

The org switcher now remembers your choice. Reported as "aws-kor-team (org2) data isn't showing" — root-caused to the switcher selection being URL-only and non-persistent, so every fresh visit silently reset to the default org.

### Added

- **Org selection persistence.** The sidebar org switcher's pick is stored in `localStorage` (`ccd.org`) and restored on the next visit. The restore runs synchronously **before React mounts** (`restoreOrgSelection()` in `main.tsx`), so the very first render — and the first fetch wave — already carries the saved `?org=`; no wasted default-org request round. Guardrails, each adversarially reviewed and covered by a 15-case browser E2E: an explicit `?org=` deep link always wins and is never persisted (only switcher clicks are); a `?group=`-carrying link skips the restore entirely (primary is URL-implicit, so a shared group-filtered link must not be hijacked to another org with its filter dropped); and a stored id the server no longer reports (single-org rollback) is auto-removed once `/api/orgs` loads — while an empty list from a transient `/api/orgs` failure keeps the preference.

## [2.0.0] - 2026-07-22

Multi-org: a second Anthropic subscription becomes a switchable source across every page — plus compliance events on Athena, an audit page that survives its own event volume, and correct numbers on any date window up to 186 days. (Deployed to production 2026-07-22.)

### Fixed

- **Wrong numbers on every window longer than 31 days (ADR-0019).** Two independent mechanisms: the engagement `/range` routes silently truncated every request to its most recent 31 days while echoing the full requested window (11 pages rendered last-31-day totals under 90-day labels), and the cost family surfaced the upstream 31-day span cap as a 502 — the Cost page then silently substituted whole-CSV-period numbers (primary) or collapsed entirely (org2), and Executive rendered the failure as **$0 spend**. Now: cost windows chunk into ≤31-day upstream segments and merge exactly (per-user rows re-aggregate; verified to the cent against independent sub-windows; 186-day cap with an explicit banner beyond it), and engagement ranges serve the whole window S3-archive-first — skills/connectors/projects read the raw sidecar (full live-API shape) — with live fallback bounded to the newest 31 missing days and a `coverage` block + shared banner for anything unservable. Executive shows '—' instead of $0 on cost failures; the UserDetailPanel's ≤31-day cost-card gating is superseded. Also: keyed deployments no longer substitute deterministic mock rows when `summaries`/single-day analytics calls fail upstream (observed rendering fake Executive numbers under 429) — they degrade to honest empty data. Archive gaps the audit surfaced (org2: 25 scattered days, primary: 2026-06-07) were backfilled inside the API's 90-day lookback.

- **User Search failing on orgs without a spend-report CSV (`no_spend_report`).** The page treated the uploaded spend-report CSV as load-bearing, so org2 — which has never uploaded one — died with "Failed to load data". The CSV is now optional enrichment: candidate users come from the engagement archive ∪ CSV rows, and the cost/token surfaces degrade **per selected user** to the live `user_cost_report` 30-day window — with explicit loading/error states instead of silently rendering $0.00, live-specific labels in both locales, and the CSV-derived daily-token chart hidden when no CSV rows cover the user. This also fixes primary-org users who joined after the last CSV upload: they now show live spend figures instead of $0.00 CSV cards mislabeled as CSV-derived.

- **Silent CSV substitution after a transient live-cost failure.** When the live cost query failed (a 429 burst is the usual cause), the Cost page quietly rendered the uploaded spend report's own period totals under the user's selected range — e.g. April-only $51.4k labeled Apr→Jul. The page now shows a loud amber banner naming both periods plus a "Retry live" button, and `fetchJson` no longer lets a network-level fetch rejection escape as an unhandled rejection (observed killing the whole Node process from one dead upstream socket; default 30s timeout added).

- **Group-scoped Cost page showing $0 for newly created groups.** Upstream cost attribution rides a slow membership snapshot (≥14h behind live membership), so a new group's spend legitimately reads zero until the next daily snapshot; the Cost page now explains this with an amber note instead of looking broken.

- **Audit page not loading (CloudFront 504).** Org audit volume passed 2000 events per preset window (≈700+/day, dominated by `claude_file_viewed`), so any request that missed the upstream page cache re-paginated the Compliance API in the foreground for 30–85s — past the CloudFront 60s origin timeout. `/api/compliance/activities` now rides a response-level SWR cache (`makeTtlCache`: in-flight dedup, stale-while-revalidate) whose 5-min prewarm top-ups the four preset windows **with the exact key formula the frontend sends** (the old prewarm used engagement-buffer offsets that never matched a real request); foreground walks carry a 45s budget + 15s per-page abort and degrade mid-walk failures (429/5xx/network) or budget exhaustion to `partial: true` responses, while background walks (prewarm + a throttled completion retry after any partial serve) get a 240s budget so cached entries converge to complete results. Frontend: the truncation banner now distinguishes volume caps from upstream failures and time-budget stops (new i18n keys), the Executive Risk KPI flags partial windows, and the Audit subtitle's `{total}` now uses `total_fetched` (was always equal to `{shown}`).

### Added

- **Multi-org support — a second Anthropic subscription as a switchable source (ADR-0018).** A sidebar org switcher (rendered only when two orgs are configured; URL-shareable `?org=`) scopes every page to either subscription: all server routes resolve the org per request via `server/orgs.js`, every response cache / keep-warm loop / prewarm is org-keyed (each org spends its own 60 rpm budget), the collector snapshots both orgs (org2 under `org2/` prefixes + six `*_org2` Glue tables), and the chatbot binds its whole session (tools, system prompt, Athena hints) to the selected org. Org switches hard-reset fetched data, the group scope, and the chat conversation — no surface can render cross-org numbers. Single-org deployments are byte-identical (org2 machinery is inert without `ANTHROPIC_ANALYTICS_KEY_2`); infra enables org2 via the committed `enableOrg2` flag in `infra/cdk.json` + secret `ccd/analytics-key-2`.

- **Audit event detail panel.** Clicking a row (or its event-type badge, the keyboard/AT entry point) on the Audit page opens a right slide-in with the full event: actor details (masked email, IP, user agent), every event-specific field, and a collapsible raw-JSON view. Emails are masked in all three surfaces — including percent-encoded (`%40`) and 1-char-local forms inside recorded `url`/`request_body` values. The dialog moves focus in, traps Tab, restores focus on close, and unmounts from the a11y tree when hidden; drag-selecting text in a row (copying an IP) no longer opens it.

- **Compliance events archived to S3 + Athena (`compliance_daily`).** The daily collector now walks the audit feed backward (after_id) and writes each complete UTC day to `compliance/date=…` partitions (+ raw sidecar): stable envelope columns plus the full original event as a JSON-string `payload` (query type-specific fields via `json_extract_scalar` — no schema migrations). The walk retries 429/5xx, paces the shared 60 rpm budget, self-limits on Lambda remaining time, and never overwrites a complete partition with a shorter one (partial oldest-day drop). Queryable from the Archive page and the chatbot (`compliance_daily` joined the Athena allowlist + schema hints, with an explicit event-time/no-3-day-buffer exception); `/api/archive/query` rows are now email-masked server-side, including `%40`-encoded emails inside recorded request strings. Full history backfilled via a paced workstation walk. See ADR-0017.

- **Collector raw sidecar.** Alongside every flattened NDJSON partition the collector now archives the pristine unflattened upstream records under `raw/<table>/date=YYYY-MM-DD/` — fields the explicit flatten mapping doesn't carry yet stay recoverable retroactively (re-flatten from S3 instead of depending on the API's ~365-day lookback). All 108 historical partitions were backfilled; deliberately no Glue table over `raw/` (recovery safety net, not a query surface).

- **Public brochure on GitHub Pages.** A self-contained Korean landing page (`site/index.html` — hero, value pillars, 9 feature cards, 8 masked screenshots with a lightbox, architecture flow, security posture, live-demo CTA to c4e.whchoi.net) published to https://whchoi98.github.io/claude-code-dashboard/ from the `gh-pages` branch via `scripts/deploy-pages.sh`, mirroring the nfm-dashboard brochure pattern.
- **Architecture diagram in the how-it-works section.** Hand-authored 1400×860 SVG (`site/img/ccd-arch.svg`) in the model-monitoring brochure style — user path (CloudFront/Cognito → ALB/Regional WAF → Fargate), Anthropic API fan-out, S3-first replay, Bedrock, collector pipeline, dual Secrets injection — embedded responsively with 90° rotation on mobile.

### Changed

- **Activity Score vs Cost-Efficiency Score disambiguation.** The User Productivity score column is now labeled "Activity Score" with an explicit "(cost is not a factor)" formula note and a cross-reference to the Cost menu's Cost Efficiency section; the Cost Efficiency subtitle states it is intentionally different from the Activity Score. Four hardcoded English chart/formula strings were moved into en/ko i18n.

### 수정

- **31일 초과 모든 조회 창의 수치 오류 (ADR-0019).** 두 갈래의 독립적 원인: 엔게이지먼트 `/range` 라우트가 요청 창을 조용히 최근 31일로 절단하면서 응답에는 전체 창을 반환(11개 페이지가 90일 라벨 아래 31일 합계를 렌더), 비용 계열은 업스트림 31일 스팬 상한이 502로 전파되며 Cost 페이지가 CSV 전체 기간 수치로 조용히 대체(primary)되거나 완전히 붕괴(org2), Executive는 실패를 **$0 지출**로 렌더. 수정: 비용 창은 ≤31일 청크로 분할 후 정확히 병합(사용자별 행 재집계, 독립 부분창 합계와 센트 단위 일치 검증, 186일 상한 + 초과 시 명시 배너), 엔게이지먼트 범위는 전체 창을 S3 아카이브 우선으로 서빙(skills/connectors/projects는 raw 사이드카 — 라이브 API 형태 그대로) + 라이브 폴백은 최신 31일로 제한 + 서빙 불가 일자는 `coverage` 블록·공용 배너로 표시. Executive는 비용 실패 시 $0 대신 '—'; keyed 배포에서 summaries·단일일 라우트가 업스트림 실패 시 mock 행을 반환하던 경로 제거(429 시 가짜 수치가 실제처럼 렌더되는 것을 관측). 감사가 찾은 아카이브 갭(org2 25일, primary 2026-06-07)은 90일 룩백 내 백필 완료.

- **스펜드 리포트 CSV 없는 조직에서 사용자 검색 실패 (`no_spend_report`).** 페이지가 업로드된 CSV를 필수 데이터로 취급해 CSV가 없는 org2에서 "Failed to load data"로 사망. CSV는 이제 선택적 enrichment: 후보 사용자는 엔게이지먼트 아카이브 ∪ CSV 행이고, 비용/토큰 표면은 **선택된 사용자 단위**로 라이브 `user_cost_report` 30일 창으로 강등 — $0.00 조용한 렌더 대신 명시적 로딩/오류 상태, 양 로케일 라이브 전용 라벨, CSV 미커버 사용자의 일별 토큰 차트 숨김. 마지막 CSV 업로드 이후 합류한 primary 사용자도 $0.00 CSV 카드 대신 라이브 지출을 표시.

- **라이브 비용 실패 시 조용한 CSV 대체.** 라이브 비용 조회가 실패하면(429 버스트가 흔한 원인) Cost 페이지가 스펜드 리포트의 자체 기간 합계를 선택 기간 라벨 아래 조용히 렌더 — 예: 4월 한정 $51.4k가 4→7월로 표시. 이제 두 기간을 명시한 앰버 배너 + "라이브 재시도" 버튼을 표시하고, `fetchJson`은 네트워크 수준 fetch 거부를 격리(죽은 업스트림 소켓 하나가 unhandledRejection으로 Node 프로세스 전체를 죽이는 것을 실증; 기본 30초 타임아웃 추가).

- **신규 그룹의 그룹 스코프 비용 페이지가 $0으로 표시.** 업스트림 비용 귀속이 라이브 멤버십보다 ≥14시간 늦은 멤버십 스냅샷을 타므로, 신설 그룹의 지출은 다음 일일 스냅샷까지 정상적으로 0으로 조회됨 — 비용 페이지가 고장처럼 보이는 대신 앰버 안내로 설명.

- **감사 페이지 로딩 실패 (CloudFront 504).** 조직 감사 볼륨이 프리셋 창당 2000건을 초과(일 700건+, `claude_file_viewed` 위주)하면서, 캐시를 비껴간 요청이 Compliance API를 포그라운드에서 30~85초간 재페이지네이션 — CloudFront 60초 오리진 타임아웃 초과. `/api/compliance/activities`에 응답 레벨 SWR 캐시(`makeTtlCache`: in-flight 중복 제거, stale-while-revalidate)를 적용하고, 5분 프리웜이 **프런트엔드가 보내는 것과 동일한 키 수식**으로 4개 프리셋 창을 top-up(기존 프리웜은 인게이지먼트 버퍼 오프셋을 써서 실제 요청 키와 전혀 일치하지 않았음). 포그라운드 워크는 45초 예산 + 페이지당 15초 abort로 60초 아래 하드 바운드, 도중 실패(429/5xx/네트워크)·예산 초과는 `partial: true`로 강등, 백그라운드 워크(프리웜·partial 후 완주 재시도)는 240초 예산으로 완전한 결과에 수렴. 프런트: 잘림 배너가 볼륨 상한/업스트림 실패/시간 예산을 구분(신규 i18n 키), Executive Risk KPI에 부분 데이터 표시, 감사 부제의 `{total}` 보간 버그(`total_fetched` 사용) 수정.

### 추가

- **멀티 조직 지원 — 두 번째 Anthropic 구독을 전환 가능한 소스로 (ADR-0018).** 사이드바 조직 스위처(조직이 2개일 때만 표시, `?org=` URL 공유 가능)가 모든 페이지를 선택 구독으로 스코프: 전 서버 라우트가 `server/orgs.js`로 요청별 org 해석, 모든 응답 캐시·keep-warm·프리웜이 org 키잉(각 조직은 자체 60rpm 예산), 컬렉터가 두 조직 스냅샷(org2는 `org2/` 프리픽스 + `*_org2` Glue 테이블 6종), 챗봇 세션(도구·시스템 프롬프트·Athena 힌트)도 선택 org에 바인딩. 조직 전환 시 데이터·그룹 스코프·챗 대화를 하드 리셋 — 어떤 표면도 교차 조직 수치를 렌더링하지 않음. 단일 조직 배포는 바이트 동일(`ANTHROPIC_ANALYTICS_KEY_2` 없으면 org2 기제 비활성); 인프라는 `infra/cdk.json`의 `enableOrg2` 플래그(커밋됨) + `ccd/analytics-key-2` 시크릿으로 활성화.

- **감사 이벤트 상세 패널.** 감사 페이지에서 행(또는 키보드/보조기기 진입점인 이벤트 타입 배지)을 클릭하면 우측 슬라이드-인으로 이벤트 전체를 표시 — 액터 정보(마스킹된 이메일·IP·user agent), 이벤트별 필드, 접이식 원본 JSON. 세 표면 모두 이메일 마스킹(기록된 `url`/`request_body` 안의 `%40` 인코딩·1글자 local part 포함). 다이얼로그는 포커스 이동·Tab 트랩·닫힘 시 포커스 복원을 수행하고 닫힌 상태에서는 접근성 트리에서 제거되며, 행 안 텍스트 드래그 선택(IP 복사)으로는 열리지 않음.

- **Compliance 이벤트 S3 적재 + Athena 조회 (`compliance_daily`).** 일일 컬렉터가 감사 피드를 after_id로 역방향 워크해 완결된 UTC 일자별로 `compliance/date=…` 파티션(+raw 사이드카)에 적재: 안정 엔벨로프 컬럼 + 원본 이벤트 전체를 JSON 문자열 `payload`로 보존(타입별 필드는 `json_extract_scalar`로 조회 — 스키마 마이그레이션 불필요). 워크는 429/5xx 재시도·60rpm 페이싱·Lambda 잔여시간 자체 제한을 갖추고, 완전한 파티션을 더 짧은 파일로 덮어쓰지 않음(부분 최고일 드롭). Archive 페이지·챗봇에서 조회 가능(`compliance_daily` allowlist·스키마 힌트 등재, 이벤트 시각 파티션·3일 버퍼 예외 명시); `/api/archive/query` 응답은 서버측 이메일 마스킹(`%40` 인코딩 포함). 과거 이력은 워크스테이션 페이스드 워크로 전량 백필. ADR-0017 참조.

- **Collector 원본 사이드카.** 평탄화 NDJSON 파티션과 나란히 비평탄화 원본 레코드를 `raw/<table>/date=YYYY-MM-DD/`에 병행 적재 — flatten 매핑이 아직 다루지 않는 필드를 API의 ~365일 lookback에 의존하지 않고 S3에서 소급 복구 가능. 과거 파티션 108개 전량 백필 완료; `raw/`에는 의도적으로 Glue 테이블 없음(복구 안전망, 질의 표면 아님).

- **GitHub Pages 공개 브로셔.** 자체 완결형 한국어 랜딩 페이지(`site/index.html` — 히어로, 핵심 가치, 기능 9종, 마스킹된 스크린샷 8장 + 라이트박스, 아키텍처 흐름, 보안 포지셔닝, c4e.whchoi.net 라이브 데모 CTA)를 `scripts/deploy-pages.sh`로 `gh-pages` 브랜치에 게시 — https://whchoi98.github.io/claude-code-dashboard/ (nfm-dashboard 브로셔 패턴).
- **동작 원리 섹션 아키텍처 다이어그램.** model-monitoring 브로셔 스타일의 수제 1400×860 SVG(`site/img/ccd-arch.svg`) — 사용자 경로(CloudFront/Cognito → ALB/Regional WAF → Fargate), Anthropic API 팬아웃, S3-first 리플레이, Bedrock, 수집 파이프라인, 이중 Secrets 주입 — 모바일에서 90° 회전되는 반응형 임베드.

### 변경

- **활동 점수 vs 비용 효율 점수 구분 명확화.** User Productivity 점수 컬럼을 "활동 점수"로 명명하고 "(비용은 요소가 아님)" 수식 주석과 Cost 메뉴 비용 효율 섹션 상호 참조를 추가; 비용 효율 부제는 활동 점수와 의도적으로 다름을 명시. 하드코딩된 영문 차트/수식 문자열 4건을 en/ko i18n으로 이동.

### 변경

- **활동 점수와 비용 효율 점수 구분 명확화.** 사용자별 생산성의 점수 컬럼을 "활동 점수"로 표기하고 공식에 "(비용 미반영)"과 비용 메뉴 상호 참조를 명시; 비용 효율 부제에 활동 점수와 의도적으로 다른 지표임을 명시. 하드코딩된 영어 차트/공식 문자열 4건을 en/ko i18n으로 전환.

## [1.9.0] - 2026-07-12

A new Claude Chat page, per-user cache efficiency everywhere, richer Users columns, a Claude Code per-user table — and the whole dashboard now works on mobile. (Deployed to production 2026-07-12.)

### Added

- **Claude Chat page (new sidebar menu, 19th route).** Period usage & activity for claude.ai conversations: active users, messages (with extended-thinking count), conversations, artifacts, projects created, skill/connector uses and web searches as KPIs, two daily-trend charts (messages × conversations; artifacts/projects/web), and a sortable per-user table. Fully group-scoped like the other surface pages.
- **Per-user Cache Efficiency.** The user detail panel gains a Cache Efficiency card (hit rate + cache read / cache write / uncached input tiers from `user_usage_report`, same `cache_read ÷ input` convention as the Cost page org KPI), and the Users table gains a sortable **Cache Hit** column — window-aligned with the engagement columns (both end at today−3) so one row never mixes two date regimes.
- **Users table surface columns.** New **Cowork** (sessions + action sub-count) and **Design** (sessions) columns alongside the existing chat/CC metrics.
- **Claude Code per-user table.** The Claude Code page gains a sortable per-user activity table (sessions, LOC, commits, PRs, tool-accept rate) below the Top Contributors chart, mirroring the Cowork/Design pattern.

### Changed

- **Mobile support.** Below `lg` the sidebar becomes a slide-in drawer behind a hamburger top bar (backdrop tap / Escape / nav tap all close it; the closed drawer is removed from the tab order and accessibility tree). KPI grids stack to 2-up, chart pairs stack vertically, tables scroll horizontally inside their cards, page padding tightens, and header controls wrap. Verified at 375px across the main pages with zero horizontal overflow.

### Fixed

- **Desktop sidebar floated above the user-detail panel backdrop** (a mobile z-index leaked through — z-index on a flex item creates a stacking context even when static). Now `lg:z-auto`.
- **PDF export layout survived the responsive sweep** — `lg:` classes don't apply on A4 portrait, so `print:` grid fallbacks keep Save-as-PDF on Cost/Executive/Analyze multi-column.
- **FloatingChat no longer overlaps the open mobile drawer**, and the chat `get_cost_summary` tool keeps its org-wide contract.

### 추가

- **Claude Chat 페이지 (신규 사이드바 메뉴, 19번째 라우트).** claude.ai 대화의 기간별 사용량·활동: 활성 사용자·메시지(확장 사고 병기)·대화·아티팩트·생성 프로젝트·스킬/커넥터 사용·웹 검색 KPI, 일별 추이 차트 2종(메시지×대화; 아티팩트/프로젝트/웹), 사용자별 정렬 테이블. 다른 표면 페이지처럼 그룹 완전 스코프.
- **사용자별 캐시 효율.** 사용자 상세 패널에 캐시 효율 카드(적중률 + 캐시 읽기/생성/비캐시 계층, `user_usage_report` 기반 — Cost 페이지 조직 KPI와 동일한 `cache_read ÷ input` 기준) 추가, Users 테이블에 정렬 가능한 **캐시 적중** 컬럼 추가 — 엔게이지먼트 컬럼과 기간 정렬(둘 다 today−3 종료)로 한 행에 두 기간이 섞이지 않음.
- **Users 테이블 표면 컬럼.** 기존 채팅/CC 지표에 **Cowork**(세션+작업 수)·**Design**(세션) 컬럼 추가.
- **Claude Code 사용자별 테이블.** 상위 기여자 차트 아래에 Cowork/Design 패턴의 정렬 테이블(세션·LOC·커밋·PR·수락률) 추가.

### 변경

- **모바일 지원.** `lg` 미만에서 사이드바가 햄버거 상단 바 뒤의 슬라이드 드로어로 전환(백드롭 탭/Escape/메뉴 탭으로 닫힘; 닫힌 드로어는 탭 순서·접근성 트리에서 제외). KPI 그리드 2열 스택, 차트 쌍 세로 스택, 테이블은 카드 내 가로 스크롤, 페이지 패딩 축소, 헤더 컨트롤 줄바꿈. 주요 페이지 375px에서 가로 넘침 0 검증.

### 수정

- **데스크톱 사이드바가 사용자 상세 패널 백드롭 위로 부상** (모바일용 z-index 누출 — flex 아이템의 z-index는 static이어도 스태킹 컨텍스트 생성). `lg:z-auto`로 해결.
- **PDF 내보내기 레이아웃 보존** — `lg:` 클래스는 A4 세로에 적용되지 않으므로 `print:` 그리드 폴백으로 Cost/Executive/Analyze의 다열 인쇄 유지.
- **FloatingChat이 열린 모바일 드로어와 겹치지 않음**, 챗봇 `get_cost_summary` 도구의 전사 기준 계약 유지.

## [1.8.0] - 2026-07-12

Group membership goes fully automatic (Compliance members endpoint), the Cost page becomes truly group-scoped, and five performance rounds make every menu open instantly (TTL caches + keep-warm + compression + edge caching). (Deployed to production 2026-07-12.)

### Added

- **Automatic group membership from the Compliance members endpoint (ADR-0014).** `/api/groups` now serves REAL point-in-time RBAC membership via `GET /v1/compliance/groups/{id}/members` — a group created in the Console (and every member move) appears in the GroupTabs within an hour, with zero admin action. Source chain: admin CSV (`live`, intent override) > real membership (`members`) > spend-derived (`auto`) > freshest last-good (`stale: true`) > `empty`. Guard rails: page-cap exhaustion throws instead of silently truncating, per-group fetches are all-or-nothing with a 5-min failure cooldown + chunked fan-out, the map cache expires with the listing it was built from, an authoritative zero-group listing is persisted so outages can't resurrect deleted groups, and the two membership last-good keys are eviction-immune.
- **Group-scoped Cost page.** Selecting a group tab now scopes the org-level cost KPIs, daily trend and product/model charts to that group via the documented `rbac_group_ids[]` filter on `cost_report`/`usage_report` (verified: filtered totals equal the grouped-by slice exactly) — ending the v1.7.0 "partial scope" caveat in live mode. The client only trusts a scope the server echoes back (rolling-deploy skew protection); a scoped-empty result no longer falls back to the org-wide CSV; scoped upstream failures get a per-(window, group) last-good, a 503 `rbac_scope_unavailable`, and a dedicated recovery panel instead of the CSV-upload empty state. Per-dev KPI and the Economic Productivity $/LOC · $/Commit averages recompute for the scoped cohort; a neutral scope note explains the any-membership / as-of-usage-time attribution. CSV-mapping and Unmapped scopes keep the partial behavior.
- **Per-user spend by model.** The user detail panel (Users / User Productivity) gains a "Spend by model" card — the selected user's live `user_cost_report × model` spend, share and requests over the page window. The User Search model tab's bar chart now plots **live per-model spend** (falling back to CSV-period spend), so every model the user ran appears — including post-CSV releases like Fable 5 — and the CSV token rows show their spend.

### Performance

- **Cost routes ride a 10-min success TTL cache** (`makeTtlCache`: stale-while-revalidate, `stale: true`-marked degraded serves, 6×TTL max-age foreground fallback, in-flight dedup, 45s per-page upstream timeouts) — `/cost/live`, `/cost/groups`, `/cost/spend-limits` and the whole `fetchUserReport` family. The rbac dimension runs 12–30s upstream; warm hits are ~1 ms.
- **Keep-warm loops keep every Fargate task hot**: an 8-min cost cycle re-registers the UI's preset windows AND every group's default-window scoped key (tab clicks are instant; deleted groups drop out automatically), start-jittered to de-phase the tasks and paced (10s inter-key sleeps, `topUp` skips fresh entries) against the shared 60 rpm org budget; a 5-min analytics cycle warms the engagement endpoints every menu boots on (`users/range` powers 11 pages — day-granular, so one 30d warm covers every preset sub-range) plus `summaries` 7/14/30d and the `/cost/efficiency` join.
- **Transfer layer**: gzip compression middleware (SPA bundle 1.12 MB → ~324 KB, API JSON ~95% smaller; the SSE chat stream is exempt via `no-transform`) and a dedicated CloudFront `/assets/*` behavior (CACHING_OPTIMIZED + brotli — content-hashed filenames, Cognito check-auth still runs on every request). CloudFront origin readTimeout 30 → 60s so a genuinely cold 30-day group window can finish.
- **Client stale-while-revalidate**: a same-scope refetch (range change / manual refetch) keeps rendering the last settled data under a "Refreshing latest data…" pulse instead of a full-page loading veil; scope changes keep the veil so another group's numbers never render under the wrong tab.

### Fixed

- **Alias domains lost their TLS certificate after an infra deploy** (`ERR_CERT_COMMON_NAME_INVALID` on `c4e.whchoi.net`). The CloudFront alternate domain names and the `*.whchoi.net` ACM certificate had been added in the console only; the first deploy that touched the distribution reverted them. Both are now declared in the CDK source (`domainNames` + `certificate`), so deploys can no longer strip them.
- **Chat `get_cost_summary` tool input is allowlisted** — the model-controlled tool arguments can no longer reach the new `rbac_group_ids[]` filter; the tool stays unconditionally org-wide as its spec promises.

### 추가

- **Compliance members 엔드포인트 기반 그룹 멤버십 자동화 (ADR-0014).** `/api/groups`가 `GET /v1/compliance/groups/{id}/members`의 **실제 현재 시점 RBAC 멤버십**을 서빙 — 콘솔에서 그룹을 만들거나 멤버를 이동하면 관리자 조치 없이 1시간 내 GroupTabs에 반영. 소스 체인: 관리자 CSV(`live`, 의도 오버라이드) > 실제 멤버십(`members`) > 지출 파생(`auto`) > 더 신선한 last-good(`stale: true`) > `empty`. 가드레일: 페이지 캡 도달 시 무경고 절단 대신 throw, 그룹별 조회는 all-or-nothing + 실패 5분 쿨다운 + 청크 fan-out, 맵 캐시는 기반 리스팅 시각으로 만료, 그룹 0개의 확정 관측을 지속화해 장애 중 삭제 그룹 부활 차단, 멤버십 last-good 키 2종은 축출 면제.
- **비용 페이지 그룹 스코프.** 그룹 탭 선택 시 조직 레벨 비용 KPI·일별 추이·제품/모델 차트가 문서화된 `rbac_group_ids[]` 필터로 해당 그룹 기준으로 전환(검증: 필터 합계 = grouped-by 슬라이스 정확 일치) — v1.7.0의 "부분 스코프" 제약을 라이브 모드에서 해소. 서버가 적용 그룹 id를 echo한 경우에만 스코프로 신뢰(롤링 배포 스큐 보호); 스코프 빈 결과는 전사 CSV로 폴백하지 않음; 스코프 업스트림 실패는 (기간,그룹)별 last-good + 503 `rbac_scope_unavailable` + 전용 복구 패널로 처리. per-dev KPI와 경제 생산성 $/LOC·$/Commit 평균은 스코프 코호트로 재계산; any-membership·사용 시점 귀속을 중립 톤 안내문으로 설명. CSV 매핑·Unmapped 스코프는 기존 partial 동작 유지.
- **사용자별 모델 지출.** 사용자 상세 패널(Users/사용자별 생산성)에 "모델별 지출" 카드 추가 — 선택 사용자의 페이지 기간 라이브 `user_cost_report × model` 지출·점유율·요청수. 사용자 검색 모델 탭의 막대그래프는 **라이브 모델별 지출** 기준으로 전환(라이브 불가 시 CSV 기간 지출 폴백)해 Fable 5처럼 CSV 이후 출시된 모델까지 사용자가 쓴 모든 모델이 표시되며, CSV 토큰 행에도 지출을 병기.

### 성능

- **비용 라우트 10분 TTL 캐시** (`makeTtlCache`: stale-while-revalidate, 열화 서빙 `stale: true` 마킹, 6×TTL 초과 시 포그라운드 폴백, in-flight dedup, 페이지당 45초 업스트림 타임아웃) — `/cost/live`·`/cost/groups`·`/cost/spend-limits`·`fetchUserReport` 계열 전체. rbac 차원은 업스트림에서 12–30초; 웜 응답은 ~1ms.
- **keep-warm 루프로 전 Fargate 태스크 상시 웜**: 8분 비용 사이클이 UI 프리셋 창과 **모든 그룹의 기본 창 스코프 키**를 재등록(그룹 탭 즉시 응답, 삭제 그룹 자동 탈락)하고 시작 지터로 태스크 위상을 분리, 키 간 10초 간격 + `topUp`으로 공유 60rpm 예산을 페이싱; 5분 analytics 사이클이 전 메뉴 공통 엔게이지먼트 엔드포인트(`users/range`=11페이지, 일 단위 캐시라 30d 1회로 전 프리셋 커버)와 `summaries` 7/14/30d, `/cost/efficiency` 조인을 워밍.
- **전송 계층**: gzip 압축 미들웨어(SPA 번들 1.12MB → ~324KB, API JSON ~95% 감소; SSE 챗 스트림은 `no-transform`으로 제외) + CloudFront `/assets/*` 전용 동작(CACHING_OPTIMIZED + brotli — 콘텐츠 해시 파일명, Cognito check-auth는 매 요청 유지). CloudFront origin readTimeout 30→60초로 콜드 30일 그룹 창 완주 허용.
- **클라이언트 stale-while-revalidate**: 동일 스코프 재조회(기간 변경·수동 refetch)는 전체 로딩 화면 대신 이전 정착 데이터 + "최신 데이터 갱신 중…" 표시로 처리; 스코프 변경은 로딩 유지(다른 그룹 수치가 잘못된 탭 아래 렌더되지 않도록).

### 수정

- **인프라 배포 후 별칭 도메인 TLS 인증서 소실** (`c4e.whchoi.net`에서 `ERR_CERT_COMMON_NAME_INVALID`). CloudFront 대체 도메인과 `*.whchoi.net` ACM 인증서가 콘솔에서만 추가돼 있어, 배포판을 건드린 첫 배포가 이를 원복. 이제 CDK 소스에 `domainNames` + `certificate`로 선언되어 배포가 지울 수 없음.
- **챗봇 `get_cost_summary` 도구 입력 allowlist** — 모델이 제어하는 도구 인자가 신규 `rbac_group_ids[]` 필터에 도달할 수 없게 차단; 도구 스펙대로 항상 전사 기준 유지.

## [1.7.0] - 2026-07-08

Group scope moves to per-page tabs, a new Agentic (actions-per-prompt) page, and the user detail panel gains product spend + skills. (Deployed to production 2026-07-07/08.)

### Added

- **Agentic page (new sidebar menu).** "How agentic is the work?" — actions Claude performs per prompt (Cowork `action_count / message_count`; higher = more delegation), with org/period average, daily trend, and a sortable per-user table with Δ vs the average. Claude Code shows actions-per-session as its proxy (the API exposes no prompt count). Includes org-wide total-spend and spend-by-model charts for context. Group tabs + partial-scope note.
- **User detail panel: product spend + skills.** Selecting a user on Users / User Productivity now shows the page-window per-product spend (bar chart, share of the user's total, Δ vs the previous equal-length window via two `user_cost_report?group_by[]=product` calls — new `?by=product` on `/api/cost/users`) and a Skills card: the user's per-surface skill-use counts plus org-wide top skills with uses and $/use (`attributed_list_price / invocation_count`; the API has no user × skill dimension — labeled as such). The drill-down now follows the page date range instead of a fixed default window.
- **User Search model tab shows models missing from the CSV period.** Models the selected user ran that predate-proof the uploaded spend report (e.g. `claude-fable-5`, `claude-sonnet-5`) are merged in from the live `user_cost_report?group_by[]=model` (last 30 days) with spend & request counts, under a caption naming the source and window. The Models Used KPI includes them, and `shortModel` now strips hyphenated `claude-` prefixes ("fable 5", not "claude fable 5").

### Fixed

- **Groups vanished from the group tabs when they were nobody's top group.** `deriveGroupMap` collapsed each user to their single max-spend group, so secondary memberships (e.g. CXO/Security members whose Engineering spend won) erased whole groups from the tab list. The auto-derived map now carries every membership per user (spend-desc arrays, any-membership — consistent with the Cost by Group card), and the scope filter checks membership inclusion. Admin-CSV mappings are unchanged.

### Changed

- **Group scope moved from the sidebar to per-page tabs.** The sidebar group selector (`GroupControl`) is removed; a new `GroupTabs` pill row (All groups · groups · Unmapped, plus the mapping-CSV upload) renders under the page header on 10 pages (Users, User Productivity, User Search, Claude Code, Cowork, Office, Design, Productivity, Adoption, Cost). Sidebar navigation now carries the `?group=` selection across pages.
- **Cost page is partially group-scoped.** Per-user Top-10 tables, the chargeback chart, Spend Limits and the efficiency section follow the selected group (the efficiency cohort-median KPI is recomputed for the scoped cohort); org-level aggregates stay org-wide, flagged by a partial-scope note that also survives the Save-as-PDF export. Cowork gained the same partial-scope note for its org-summaries widgets (Adoption KPI, DAU/WAU/MAU trend).

### 추가

- **Agentic 페이지 (신규 사이드바 메뉴).** "작업이 얼마나 에이전틱한가요?" — 프롬프트당 Claude가 수행하는 작업 수(Cowork `action_count / message_count`; 높을수록 위임이 많음). 조직/기간 평균, 일별 추이, 평균 대비 Δ가 붙은 사용자별 정렬 테이블 제공. Claude Code는 API에 프롬프트 수가 없어 세션당 작업 수를 보조 지표로 표시. 맥락용 조직 전체 총지출·모델별 지출 차트 포함. 그룹 탭 + partial 노트.
- **사용자 상세 패널: 제품별 지출 + 스킬.** Users/사용자별 생산성에서 사용자 선택 시 페이지 기간의 제품별 지출(막대 차트, 본인 총액 대비 점유율, 동일 길이 이전 기간 대비 Δ — `user_cost_report?group_by[]=product` 2회 호출, `/api/cost/users`에 `?by=product` 신설)과 스킬 카드(사용자별 표면별 스킬 사용 횟수 + 조직 전체 주요 스킬의 사용 횟수·사용당 비용 `attributed_list_price / invocation_count`; API에 사용자×스킬 차원이 없어 조직 기준으로 명시)를 표시. 드릴다운 기간이 고정 기본값 대신 페이지 date range를 따름.
- **사용자 검색 모델 탭에 CSV 기간 누락 모델 표시.** 업로드된 Spend Report 이후 출시된 모델(`claude-fable-5`, `claude-sonnet-5` 등)을 라이브 `user_cost_report?group_by[]=model`(최근 30일)에서 병합해 지출·요청수로 표시하고, 출처·기간을 캡션으로 명시. Models Used KPI에 포함되며 `shortModel`이 하이픈 `claude-` 접두사도 제거("claude fable 5" 대신 "fable 5").

### 수정

- **누구의 최대 지출 그룹도 아닌 그룹이 그룹 탭에서 사라지던 문제.** `deriveGroupMap`이 사용자당 최대 지출 그룹 1개로 붕괴시켜 부소속 그룹(예: Engineering 지출이 더 큰 CXO/Security 멤버)이 탭 목록에서 통째로 탈락. 자동 유도 맵이 이제 사용자별 전체 소속(지출 내림차순 배열, any-membership — 그룹별 비용 카드와 일관)을 담고, 스코프 필터는 포함 여부를 검사. 관리자 CSV 매핑은 변경 없음.

### 변경

- **그룹 스코프를 사이드바에서 페이지별 탭으로 이동.** 사이드바 그룹 셀렉터(`GroupControl`) 제거; 새 `GroupTabs` 알약 탭(All groups · 그룹들 · Unmapped + 매핑 CSV 업로드)이 10개 페이지(Users, 사용자별 생산성, 사용자 검색, Claude Code, Cowork, Office, Design, 생산성, 도입, 비용)의 페이지 헤더 아래 렌더. 사이드바 내비게이션이 `?group=` 선택을 페이지 간 유지.
- **Cost 페이지 부분 그룹 스코프.** 사용자별 Top-10 테이블·차지백 차트·Spend Limits·효율 섹션이 선택 그룹을 따르고(효율 cohort median KPI는 스코프 기준 재계산), 조직 레벨 집계는 전사 기준 유지 — partial 안내 노트가 PDF 내보내기에도 포함. Cowork의 조직 summaries 위젯(도입 KPI, DAU/WAU/MAU 추이)에도 동일한 partial 노트 추가.

## [1.6.0] - 2026-07-04

Cost page goes fully live — RBAC group cost with real names, per-user tokens without CSV, spend limits, and date-range accuracy fixes. (Deployed to production 2026-07-03/04.)

### Added

- **Cost by Group card.** The upstream Analytics API now supports `group_by[]=rbac_group_id` (shipped ~2026-07, announced via blog only), so the Cost page renders per-group spend natively via the new `GET /api/cost/groups`. Group labels are **real names** (Engineering, CXO, …) resolved through the documented Compliance groups endpoint (`GET /v1/compliance/groups`, 1-hour cache — each listing emits a `group_list_viewed` audit event) with `grp-<id suffix>` fallback. Upstream semantics are any-membership: a multi-group user counts fully in each group, so group rows can sum above the org total (the subtitle says so).
- **Automatic group mapping.** When no admin `email,group` CSV is uploaded, `GET /api/groups` now auto-derives the sidebar group scope from live `user_cost_report × rbac_group_id` (each user → their max-spend group, real names) — `source:"auto"`. An uploaded CSV still wins.
- **Live per-user token tables.** New `GET /api/cost/user-tokens` proxies the new upstream `user_usage_report`, so the Input/Total/Output token Top-10 tables now follow the selected date range live — the Spend Report CSV is no longer required for per-user tokens (fallback only).
- **Spend Limits (Monthly) card.** New `GET /api/cost/spend-limits` proxies the new Spend Limits API (`/v1/organizations/spend_limits/effective`): per-member month-to-date spend, effective limit, utilization (highlighted at ≥90%), and limit source (user override / seat tier / RBAC group / org). Independent of the page date range; resets on the 1st (UTC).
- **Compliance key fallback.** The server now falls back to the Analytics key for `/api/compliance/*` when no dedicated Compliance key is configured — the provisioned Analytics key carries the compliance read scopes (officially combinable per the new admin-api-keys docs). `/api/health` reports `compliance` / `analytics-fallback` / `none`.

### Fixed

- **Date-range accuracy on the Cost page.** The per-user sections (estimated-cost Top 10, per-user × model chart) covered 3 fewer days than the headline KPIs, and a fully-recent range made them vanish: the server still clamped `user_cost_report` to `today−3` even though the upstream cost family now serves the finalization buffer with partial data (watermark model, verified live), and the one-sided clamp could invert the window into an upstream 400. Windows are now resolved by `resolveUserCostWindow` (ending ≤ today, never inverted); the Top-10 cost table sources the full-range `/api/cost/users`; `/api/cost/efficiency` deliberately stays `today−3`-aligned so its spend÷productivity ratios ($/LOC, score) don't mix windows. Also fixed the default cost window being 32 days — one day over the (newly documented) 31-day upstream span cap — which broke date-less chatbot cost questions.
- **Upstream RBAC flap resilience.** The `rbac_group_id` dimension intermittently returns 503 ("Team membership data is not ready yet"). The group endpoints now keep last-good responses (served with `stale: true`) and the Cost page shows an explanatory note instead of silently dropping the card.

### Changed

- **CSV demoted to fallback.** With live per-user spend and tokens, the Spend Report CSV now covers only >31-day reconciliation windows and live-report outages; captions above the Top tables state exactly which source and period each table reflects.

### 추가

- **그룹별 비용 카드.** upstream Analytics API가 `group_by[]=rbac_group_id`를 지원하기 시작해(2026-07 경, 블로그로만 발표) 신규 `GET /api/cost/groups`로 그룹별 지출을 네이티브 표시합니다. 그룹 라벨은 문서화된 Compliance groups 엔드포인트(`GET /v1/compliance/groups`, 1시간 캐시 — 호출마다 `group_list_viewed` 감사 이벤트 발생)로 조회한 **실명**(Engineering, CXO 등)이며 `grp-<ID 접미사>` 폴백을 둡니다. upstream 의미론은 any-membership: 여러 그룹 소속 사용자는 각 그룹에 전액 계상되어 합계가 조직 총액을 넘을 수 있습니다(부제에 명시).
- **그룹 매핑 자동화.** 관리자 `email,group` CSV가 없으면 `GET /api/groups`가 라이브 `user_cost_report × rbac_group_id`에서 사이드바 그룹 스코프를 자동 유도합니다(사용자별 최대지출 그룹, 실명 라벨) — `source:"auto"`. CSV 업로드 시 CSV 우선.
- **사용자별 토큰 테이블 라이브 전환.** 신규 `GET /api/cost/user-tokens`가 신설 upstream `user_usage_report`를 프록시해 Input/Total/Output 토큰 Top-10이 선택 기간을 라이브로 추종합니다 — 사용자별 토큰에 더 이상 Spend Report CSV가 필요 없습니다(폴백 전용).
- **Spend Limits (월간) 카드.** 신규 `GET /api/cost/spend-limits`가 신설 Spend Limits API(`/v1/organizations/spend_limits/effective`)를 프록시: 멤버별 월 누적 지출, 유효 한도, 소진율(90% 이상 강조), 한도 출처(사용자 오버라이드/시트 티어/RBAC 그룹/조직). 페이지 기간 선택과 무관하며 매월 1일 00:00 UTC 리셋.
- **Compliance 키 폴백.** 전용 Compliance 키가 없으면 서버가 `/api/compliance/*`에 Analytics 키를 사용합니다 — 발급된 Analytics 키가 compliance 읽기 스코프를 보유(신설 admin-api-keys 문서가 스코프 결합을 공식화). `/api/health`가 `compliance` / `analytics-fallback` / `none`을 보고.

### 수정

- **Cost 페이지 기간 정확도.** 사용자별 섹션(추정 비용 Top 10, 사용자별 모델 차트)이 헤드라인 KPI보다 3일 적게 집계되고, 최근 날짜만 선택하면 사라지던 문제: upstream cost 계열이 확정 버퍼를 부분 데이터로 제공하게 됐는데도(watermark 모델, 실측 검증) 서버가 `user_cost_report`를 `today−3`으로 clamp했고, 한쪽만 clamp해 기간이 역전되면 upstream 400이 났습니다. 이제 `resolveUserCostWindow`(ending ≤ today, 역전 방지)로 해석하고, Top-10 비용 테이블은 전체 기간 `/api/cost/users`를 사용하며, `/api/cost/efficiency`는 비용÷생산성 비율($/LOC, 점수)의 창 혼합을 막기 위해 의도적으로 `today−3` 정렬을 유지합니다. 기본 비용 창이 32일로 (신규 문서화된) 31일 upstream 상한을 1일 초과해 날짜 없는 챗봇 비용 질문이 실패하던 문제도 수정.
- **upstream RBAC 플랩 내성.** `rbac_group_id` 차원이 간헐적으로 503("Team membership data is not ready yet")을 반환합니다. 그룹 엔드포인트가 마지막 정상 응답을 보관해 `stale: true`로 서빙하고, Cost 페이지는 카드를 조용히 없애는 대신 안내 문구를 표시합니다.

### 변경

- **CSV를 폴백으로 강등.** 사용자별 지출·토큰이 라이브로 제공되면서 Spend Report CSV는 31일 초과 정산과 라이브 리포트 장애 폴백만 담당합니다. Top 테이블 위 캡션이 각 테이블의 소스와 기간을 정확히 표시합니다.

## [1.5.0] - 2026-06-17

Group visibility — rollout to per-user pages.

### Added

- **Group scope across the dashboard.** The Foundation's group selector now scopes 7 more per-user pages — UserProductivity, ClaudeCode, Cowork, Office, Design, Productivity, and UserSearch — via the shared `useGroupScope().inGroup` predicate. The `/api/groups` mapping is now fetched once through a `GroupScopeProvider` context (instead of per page), so a single post-upload refetch refreshes every consumer and there's no duplicate request. Org-level pages that can't honor group scope (Overview, Trends, Adoption, Executive, Cost, Compliance) show a subtle "group scope not applied — org-wide data" note when a group is selected, so the selection is never silently ignored. (Cowork's DAU/WAU/MAU trend and adoption ratio come from org-level daily summaries and remain org-wide; full scoping of Cost/Executive and Compliance audit filtering is a later cycle.)

### 추가

- **대시보드 전반 그룹 스코프.** Foundation의 그룹 선택기가 공유 `useGroupScope().inGroup` 술어로 사용자 단위 7개 페이지(UserProductivity·ClaudeCode·Cowork·Office·Design·Productivity·UserSearch)를 추가로 스코프합니다. `/api/groups` 매핑은 이제 `GroupScopeProvider` 컨텍스트로 한 번만 fetch해(페이지별 중복 제거) 업로드 후 한 번의 refetch가 모든 소비자를 갱신합니다. 그룹 스코프가 적용되지 않는 org 단위 페이지(Overview·Trends·Adoption·Executive·Cost·Compliance)는 그룹 선택 시 "그룹 미적용 — 전사 데이터" 안내를 표시해 선택이 조용히 무시되지 않도록 합니다. (Cowork의 DAU/WAU/MAU 추세와 도입률은 org 단위 일별 요약에서 오므로 전사 기준으로 유지되며, Cost/Executive 전체 스코프와 Compliance 감사 필터는 다음 사이클입니다.)

## [1.4.0] - 2026-06-17

Group visibility — Foundation (admin email→group mapping + global scope filter; Users pilot).

### Added

- **Group-level visibility (Foundation).** Admins upload an `email,group` CSV (stored latest-wins at `s3://<archive>/group-map/` via `POST /api/groups/upload`); `GET /api/groups` returns the parsed map + group list. A new global **Group scope** selector in the sidebar (URL-synced `?group=`, same idiom as the date range) scopes pages to a selected group — or to `(Unmapped)` users for admin gap-spotting. The **Users page** is the pilot: its per-user aggregation now filters by the selected group via a reusable `useGroupScope().inGroup(email)` predicate. Groups come from the uploaded mapping because the Analytics API's `rbac_group_id`/`claude_project_id` dimensions return HTTP 400 ("not yet supported") and user records carry no group field. Rollout to the remaining pages is a later cycle.

### 추가

- **그룹 단위 가시성 (Foundation).** 관리자가 `email,group` CSV를 업로드하면(`POST /api/groups/upload` → `s3://<archive>/group-map/`에 최신본 저장), `GET /api/groups`가 파싱된 매핑+그룹 목록을 반환합니다. 사이드바에 전역 **그룹 범위** 선택기(날짜 범위와 동일한 `?group=` URL 동기화)를 추가해 선택한 그룹으로 페이지를 스코프하거나 `(미매핑)` 사용자를 골라낼 수 있습니다. **Users 페이지**가 파일럿으로, 사용자별 집계가 재사용 가능한 `useGroupScope().inGroup(email)` 술어로 선택 그룹을 필터링합니다. Analytics API의 `rbac_group_id`/`claude_project_id` 차원이 HTTP 400("미지원")을 반환하고 사용자 레코드에 그룹 필드가 없어, 그룹은 업로드된 매핑에서 가져옵니다. 나머지 페이지 적용은 다음 사이클입니다.

## [1.3.0] - 2026-06-17

Cost Efficiency score v3 — per-surface within-cohort normalization.

### Changed

- **Rebuilt the cost-efficiency value term (v3).** v2 summed surfaces with arbitrary multipliers (a design project ≡ 4 LOC), which is fiction — a LOC, a design project, and a cowork action aren't the same unit. v3 instead normalizes each surface's per-user output **within that surface's own cohort** (code vs code, design vs design, …) to `[0,1]` via the winsorized median-anchor, blends only the surfaces a user is **active** in (coverage-aware, so a code-only dev isn't penalized for design = 0), divides by total spend (per-surface cost attribution is unavailable), then re-normalizes across active users (so idle billed seats don't distort the cohort). The 4-term structure is unchanged (value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08); only the value numerator changed. `value` now measures quality-per-surface-used while `breadth` measures how-many-surfaces — separated concerns. Response carries `score_version:"3.0"`, per-user `surface_scores`/`productivity_index`/`efficiency_raw`, and `totals.median_score` (replacing `totals.value_units`); the headline KPI is now the cohort median score.

### 변경

- **비용 효율 value 항을 v3로 재작성.** v2는 surface들을 임의 배율(디자인 프로젝트 ≡ 4 LOC)로 합쳤는데, LOC·디자인 프로젝트·cowork 액션은 같은 단위가 아니므로 허구입니다. v3는 각 surface의 사용자별 산출을 **해당 surface 자기 코호트 내에서**(코드는 코드끼리, 디자인은 디자인끼리) winsorized 중앙값 앵커로 `[0,1]` 정규화하고, 사용자가 **활성**인 surface만 블렌드(coverage-aware — 코드만 쓰는 개발자가 design = 0 으로 손해 보지 않음)하며, 총 지출로 나눈 뒤(surface별 비용 귀속 불가) 활성 사용자 기준으로 재정규화합니다(유휴 과금 좌석이 코호트를 왜곡하지 않도록). 4항 구조는 유지(value/$ 0.55 · 수락 0.25 · delivery 0.12 · breadth 0.08), value 분자만 교체. 이제 `value`는 "쓰는 surface별 품질", `breadth`는 "쓰는 surface 개수"로 관심사를 분리합니다. 응답에 `score_version:"3.0"`, per-user `surface_scores`/`productivity_index`/`efficiency_raw`, `totals.median_score`(기존 `totals.value_units` 대체). 헤드라인 KPI는 코호트 중앙값 점수.

## [1.2.0] - 2026-06-17

Economic Productivity score v2 ("Value per Dollar").

### Changed

- **Rewrote the per-user economic-productivity score** as cost-efficiency v2. Each signal counts once (no more commits/PRs/accepts double-counting); output is multi-surface (net-LOC churn-discounted + cowork/Office/design), replacing gross-LOC; dropped the `1/tokens_per_LOC` term (was silently 0 on the live path and rewarded under-use); normalization is winsorized + cohort-median-anchored (outlier-immune, not divide-by-max). Weights value/$ 0.55 · acceptance 0.25 · delivery 0.12 · breadth 0.08. Response carries `score_version:"2.0"`, per-user `value_units`/`score_components`, and `totals.value_units`. Reframed the UI as "Cost Efficiency — not a performance metric."

### 변경

- **사용자별 경제 생산성 점수를 비용 효율 v2로 재작성.** 각 신호를 한 번만 계산(commits/PRs/accepts 이중계산 제거), 산출을 멀티 surface(순-LOC churn 할인 + cowork/Office/design)로 확장(총 LOC 대체), `1/tokens_per_LOC` 항 제거(라이브에서 0·과소사용 보상), 정규화를 winsorized + 코호트 중앙값 앵커로(아웃라이어 면역). 가중치 value/$ 0.55 · 수락 0.25 · delivery 0.12 · breadth 0.08. 응답에 `score_version`·per-user `value_units`/`score_components`·`totals.value_units`. UI를 "비용 효율 — 성과 지표 아님"으로 리프레이밍.

## [1.1.1] - 2026-06-17

Fix: monthly cost total was undercounted.

### Fixed

- **Cost page total for ranges > 7 days.** The Analytics `cost_report`/`usage_report` cap daily buckets at ~7 per page, but `fetchCostSummary` fetched only page 1 — so a 30-day total showed just the first ~7 days (e.g. ~$6k instead of ~$34k); 1d/7d were correct. Added `fetchAllReportPages`, which follows `has_more`/`next_page` and merges every page (mirroring the per-user path), and applied it to all four reports (cost, usage, cost_type, token_type). The headline total, token KPIs, and by-type/cache cards now cover the full window.

### 수정

- **7일 초과 기간의 비용 총합 정정.** Analytics `cost_report`/`usage_report`는 페이지당 일일 버킷을 ~7개로 제한하는데 `fetchCostSummary`가 1페이지만 가져와, 30일 총합이 첫 ~7일치만 표시됐습니다(예: ~$34k 대신 ~$6k; 1d/7d는 정상). `has_more`/`next_page`를 따라 모든 페이지를 병합하는 `fetchAllReportPages`를 추가해 4개 리포트(cost·usage·cost_type·token_type) 전부에 적용. 헤드라인 총합·토큰 KPI·유형별/캐시 카드가 전체 기간을 반영합니다.

## [1.1.0] - 2026-06-17

Office and Design surface pages.

### Added

- **Office page** (`/office`, nav 📑) — Claude usage across the Excel / PowerPoint / Word / Outlook surfaces: active users, sessions, messages, skills KPIs; usage-by-app bar; stacked daily engagement; top-users table. Reuses `/api/analytics/users/range` (no backend change). Shows an empty-state until Office adoption begins (gated on window total > 0).
- **Design page** (`/design`, nav 🎨) — Claude Design surface activity: active users, sessions, messages, projects-created KPIs; daily engagement; projects used-vs-created trend; top-users table. Brand color `#4CA371`.

### 추가

- **Office 페이지** (`/office`, nav 📑) — Excel / PowerPoint / Word / Outlook surface 내 Claude 사용: 활성 사용자·세션·메시지·스킬 KPI, 앱별 사용량 막대, 일별 stacked 참여량, Top 사용자 테이블. `/api/analytics/users/range` 재사용(백엔드 무변경). Office 도입 전까지 empty-state(윈도우 합계>0 게이트).
- **Design 페이지** (`/design`, nav 🎨) — Claude Design surface 활동: 활성 사용자·세션·메시지·생성 프로젝트 KPI, 일별 참여량, 사용 vs 생성 프로젝트 추세, Top 사용자 테이블. 브랜드색 `#4CA371`.

## [1.0.0] - 2026-06-17

First stable release — dedicated Cowork analysis page.

### Added

- **Cowork page** (`/cowork`, nav 🤝) — a first-class view of cowork usage that was previously only thin secondary metrics on code-centric pages. 4 KPIs (active cowork users, sessions, messages, adoption), a DAU/WAU/MAU trend, daily engagement (sessions/messages/actions/dispatch turns), a sortable Top-cowork-users table, and a file-editing adoption section. Reuses `/api/analytics/summaries` + `/api/analytics/users/range` (no backend change). The file-editing section shows an empty-state until the org's cowork tool-edit counters populate (distinguished by null vs zero).

### Changed

- Trends page cowork-DAU line recolored to the cowork brand color `#B75E40` (was a mismatched green).

### 추가

- **Cowork 페이지** (`/cowork`, nav 🤝) — 그동안 code 중심 페이지에 곁다리로만 있던 cowork 사용량을 1급 뷰로. KPI 4개(활성 사용자·세션·메시지·도입률), DAU/WAU/MAU 추세, 일별 참여량(세션·메시지·액션·dispatch), 정렬 가능한 Top cowork 사용자 테이블, 파일편집 도입 섹션. `/api/analytics/summaries` + `/api/analytics/users/range` 재사용(백엔드 무변경). 파일편집 섹션은 조직의 tool-edit 카운터가 채워질 때까지 empty-state(null과 0을 구분).

### 변경

- Trends 페이지 cowork-DAU 라인 색을 cowork 브랜드색 `#B75E40`으로 정정(기존 녹색 불일치).

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

[Unreleased]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.9.0...HEAD
[1.9.0]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.6.0...v1.7.0
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

[Unreleased]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.9.0...HEAD
[1.9.0]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/whchoi98/claude-code-dashboard/compare/v1.6.0...v1.7.0
[0.1.0]: https://github.com/whchoi98/claude-code-dashboard/releases/tag/v0.1.0
