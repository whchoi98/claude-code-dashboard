# Architecture

<p align="center">
  <kbd>[<a href="#english">English</a>]</kbd>
  <kbd>[<a href="#한국어">한국어</a>]</kbd>
</p>

---

# English

## System overview

`claude-code-dashboard` is a three-tier analytics application: a React/Vite SPA in the browser, an Express proxy on ECS Fargate that fans out to three Anthropic API families, and an S3-backed archive with Glue + Athena for retention beyond the 90-day Analytics API window. CloudFront + WAF front the ALB, and the ALB's security group is locked to the CloudFront managed prefix list so direct ALB access is blocked.

## Components by layer

### Ingestion

| Component | Purpose |
|-----------|---------|
| Express proxy (`server/index.js`) | Per-request fan-out to Analytics / Admin / Compliance APIs with a 10-minute in-memory cache and a startup-+-5-min compliance prewarm scheduler |
| Collector Lambda (`collector/handler.js`) | Daily snapshot of five Analytics endpoints into partitioned NDJSON on S3 |
| Spend Report uploader (manual) | Claude Console CSV dropped into `s3://<archive>/spend-reports/` for the Cost page |

### Storage

| Component | Purpose |
|-----------|---------|
| Versioned S3 bucket | NDJSON partitions (`<table>/date=YYYY-MM-DD/`), spend reports, Athena results |
| Glue Data Catalog | Tables (`claude_code_analytics`, `summaries_daily`, `skills_daily`, `connectors_daily`) with Hive-style date partition projection |
| Secrets Manager | `ccd/analytics-key`, `ccd/admin-key`, `ccd/compliance-key` |

### Processing

| Component | Purpose |
|-----------|---------|
| Amazon Bedrock (Claude Sonnet 4.6) | Multi-turn tool-use chatbot (`POST /api/chat/stream`) via `ConverseStreamCommand` + `toolConfig` — SSE to the browser. The model autonomously calls four tools (`get_analytics_overview`, `run_athena_sql`, `get_cost_summary`, `search_users`). See [ADR-0008](decisions/0008-tool-use-chatbot.md). |
| Athena workgroup | Ad-hoc SQL over archived partitions; powers the Archive page and the chatbot's `run_athena_sql` tool |
| Server-side aggregation | `/api/cost/live` joins Analytics `cost_report` + `usage_report` on `(product, model)` and reshapes into the `CsvResp` shape consumed by the Cost page. `/api/cost/users` proxies `user_cost_report` (paginated, raw emails, full selected range — the cost family serves the 3-day buffer with partial data) for live per-user USD spend; `/api/cost/user-tokens` proxies the newer `user_usage_report` for live per-user token counts; `/api/cost/groups` proxies `cost_report × rbac_group_id` for per-RBAC-group spend, labeled with real group names from `GET /v1/compliance/groups` (1h-cached, last-good on the upstream 503 flap); `/api/cost/spend-limits` proxies the Spend Limits API for per-member monthly limits + month-to-date spend. `/api/cost/efficiency` joins `user_cost_report` spend with `users/range` productivity on `email`, deliberately window-aligned to `today−3` (the productivity source's buffer) so its ratios don't mix windows. `/api/cost/csv` keeps the manual Spend Report path as fallback for >31-day reconciliation and live-report outages. See [ADR-0003](decisions/0003-hybrid-live-cost.md) and [ADR-0009](decisions/0009-live-user-cost.md). |

### Query / Presentation

| Component | Purpose |
|-----------|---------|
| React SPA | 17 pages, i18n (en/ko), date range control (7d default; allows today as end date with a UTC/daily-refresh footnote), user drill-down panel, markdown rendering, single-page Executive snapshot at `/exec`, in-app Changelog page at `/changelog` (renders bundled `CHANGELOG.md` via Vite `?raw`). Sidebar pinned to viewport via `h-screen` + per-pane `overflow-y-auto`. Per-row statistics tables use a shared `useSortable` hook + `<SortableTh>` for bidirectional column sort with null-tail-pinning. |
| Recharts | Line / area / bar / stacked bar / pie / scatter / radial charts |
| react-markdown + remark-gfm | Streamed markdown rendering for AI analysis output |

### Observability

| Component | Purpose |
|-----------|---------|
| CloudWatch Logs | ECS app logs (`/aws/ecs/...`), Lambda logs, WAF logs |
| ECS circuit breaker | Auto-rollback on failed rolling deploys |
| ALB target group health check | `/api/health` on port 8080 |

### Security

| Component | Purpose |
|-----------|---------|
| Cognito + Lambda@Edge (viewer-request) | Every CloudFront URL gated by Cognito Hosted UI login. Four handlers (`check-auth`, `parse-auth`, `refresh-auth`, `sign-out`) enforce the JWT cookie on every edge PoP. Unauth'd traffic is 302'd to `/oauth2/authorize` **before** it reaches WAF/ALB/ECS. See [ADR-0001](decisions/0001-cognito-lambda-edge-auth.md). |
| CloudFront + managed SECURITY_HEADERS response policy | TLS 1.2+ termination, HTTP/2 + /3, HSTS, CSP-ready |
| AWS-managed WAF rules (REGIONAL, attached to ALB) | `AWSManagedRulesCommonRuleSet` (minus `SizeRestrictions_BODY`, downgraded to COUNT to permit CSV upload) + `AWSManagedRulesKnownBadInputsRuleSet` + rate-based (2000 req / 5 min / IP) |
| CloudFront origin-facing prefix list | ALB SG ingress restricted to `pl-22a6434b` only — direct ALB access blocked |
| Private subnets | Fargate tasks have no public IPs; outbound via NAT |
| IAM scoping | Task role limited to: `bedrock:InvokeModel*` on Claude models, `athena:*Query*` on the workgroup, S3 read/write on the archive bucket, Secrets Manager read on the three API-key secrets + `ccd/cognito-config` at build time (not at ECS runtime — edge build pulls it) |

## Full architecture diagram

```
                  ┌───────────────────────────────────────────┐
   Internet ────▶ │  CloudFront distribution                  │   TLS · HTTP/3 · SECURITY_HEADERS
                  │  (viewer protocol: redirect-to-HTTPS)     │
                  │                                           │
                  │  ┌─────────────────────────────────────┐  │
                  │  │ Lambda@Edge  (us-east-1 replication)│  │   Cognito auth gate
                  │  │   default      → check-auth         │  │   — JWT cookie verify
                  │  │   /parseauth   → parse-auth         │  │   — code → token exchange
                  │  │   /refreshauth → refresh-auth       │  │   — silent token refresh
                  │  │   /signout     → sign-out           │  │   — clear cookies + /logout
                  │  └─────────────────────────────────────┘  │
                  └──────────────────┬────────────────────────┘
                                     │  (authenticated requests only)
                                     ▼  (origin-facing prefix list pl-22a6434b)
                  ┌───────────────────────────────────────────┐
                  │  Application Load Balancer (public)       │   Regional WAF (common + bad-inputs + rate)
                  │  Listener :80  →  TG :8080                │
                  └──────────────────┬────────────────────────┘
                                     │
                                     ▼  (ALB SG → Service SG on :8080)
                  ┌───────────────────────────────────────────┐
                  │  ECS Fargate service  (ARM64, 2–6 tasks)  │
                  │  - Vite SPA static assets                 │
                  │  - Express /api proxy                     │
                  └──────┬────────────┬────────────┬──────────┘
                         │            │            │
                         ▼            ▼            ▼
                 ┌───────────┐ ┌──────────┐ ┌───────────────┐
                 │ Anthropic │ │ Amazon   │ │ Amazon S3     │
                 │  APIs     │ │ Bedrock  │ │ + Glue +      │
                 │  (3 keys) │ │ (Sonnet  │ │   Athena      │
                 │           │ │  4.6)    │ │               │
                 └───────────┘ └──────────┘ └──────┬────────┘
                                                   ▲
                                                   │ (NDJSON partitions)
                              ┌────────────────────┴──────────────────┐
                              │  EventBridge (daily 14:00 UTC)        │
                              │           │                           │
                              │           ▼                           │
                              │  Collector Lambda (Node 20)           │
                              │  - fetchAllPages × 5 endpoints        │
                              │  - flattenUser (Analytics → NDJSON)   │
                              └───────────────────────────────────────┘
```

## Data flow summary

Browser request → CloudFront → WAF → ALB → Fargate Express → (S3 archive or live Anthropic API) → JSON → browser. AI chatbot mode (`/api/chat/stream`) extends: browser → Express → Bedrock `ConverseStreamCommand` tool-use loop (max 4 hops, tools call live APIs + Athena) → SSE chunks → browser.

## Infrastructure (CDK stacks)

| Stack | Contents |
|-------|----------|
| `ccd-network` | VPC (new or looked up), S3 Gateway endpoint |
| `ccd-storage` | Versioned S3 archive bucket, Glue database + 4 projection-partitioned tables, Athena workgroup |
| `ccd-compute` | ECS cluster, task definition (ARM64), service (2–6 tasks, CPU auto-scale), ALB + listener + WAF, CloudFront distribution, Secrets Manager references |
| `ccd-collector` | Collector Lambda + EventBridge rule (daily 14:00 UTC) + log retention custom resource |

## Key design decisions

- **Reuse an existing VPC by context** — the target account's EIP quota is exhausted; creating a new VPC with NAT would fail. `NetworkStack` branches on `existingVpcId` context to stay deployable.
- **S3-first caching** — queries hit S3 before the live API. A 30-day range that would take 22 seconds serial (or ~3 seconds parallel while eating 50 % of the 60 rpm budget) now returns in 250 ms with 0 API calls.
- **Three independent API keys, with fallback** — Analytics, Admin, and Compliance scopes each get their own Secrets Manager secret so they can be rotated independently and any one of them is optional. Since 2026-07 the server falls back to the Analytics key for Compliance reads (`COMPLIANCE_KEY → ANTHROPIC_ANALYTICS_KEY`) — the provisioned Analytics key carries the compliance read scopes, so the dedicated Compliance secret is optional; `/api/health` reports which key serves the audit feed.
- **CloudFront prefix list on ALB SG** — blocks direct ALB access from the internet without requiring mTLS or a private ALB.
- **ARM64 Fargate** — cheaper than x86 (~20 %) and matches the dev host architecture so Docker image builds don't need QEMU emulation.
- **Email masking as a contract** — `maskEmail()` is called in both the frontend and the LLM system prompt, making the UI safe by default.
- **Live per-user cost via `user_cost_report`** — since v0.8.0, the Cost page's per-user "Top by Cost" table and `distinct_users` KPI are sourced live from `GET /api/cost/users` (Analytics `user_cost_report`). `/cost/efficiency` joins live per-user spend with `users/range` productivity on `email`, window-aligned to `today−3` on purpose (mixing a full-range spend window with the buffer-clamped productivity window would inflate $/LOC). Since 2026-07 per-user **tokens** are also live (`user_usage_report` → `/api/cost/user-tokens`), so the CSV upload is a fallback only: >31-day reconciliation (the cost family caps spans at 31 days) and live-report outages. See [ADR-0003](decisions/0003-hybrid-live-cost.md), [ADR-0009](decisions/0009-live-user-cost.md), [ADR-0010](decisions/0010-cost-window-policy.md) and [ADR-0012](decisions/0012-live-user-tokens.md).
- **RBAC group cost with real names** — `cost_report × rbac_group_id` (upstream since 2026-07) powers the Cost page's per-group card, and the sidebar group scope auto-derives its email→group map from `user_cost_report × rbac_group_id` when no admin CSV is uploaded. Group ids resolve to display names via the documented Compliance groups endpoint (`GET /v1/compliance/groups`, 1h cache — each listing emits a `group_list_viewed` audit event), not the undocumented `rbac_groups` listing. The upstream dimension flaps (intermittent 503 "Team membership data is not ready yet"); the server keeps last-good responses and the UI shows an explanatory note instead of a missing card. See [ADR-0011](decisions/0011-rbac-group-visibility-native.md).
- **Compliance after_id pagination + prewarm** — the Compliance API has no timestamp filter and only paginates via `after_id`. ECS task startup self-fetches the 7d / 14d / 30d windows in the background and refreshes every 5 minutes; the upstream cache (TTL 10 min) absorbs subsequent user requests so the audit feed renders in <1 s instead of paginating 30+ s of API calls. The daily chart adds a `mean+1·stdev` reference line so risk spikes are obvious. See [ADR-0004](decisions/0004-compliance-pagination-prewarm.md).
- **7d default range** — every range-aware page boots on `range=7d` (was 14d / 30d in v0.3.0). Trade-off: tighter signal, but at 7 days the half-window bisection used by Adoption's stale-skill detector and the Compliance spike threshold both still produce useful values. See [ADR-0005](decisions/0005-default-7d-window.md).
- **Athena varchar partitions** — Glue tables partition `date` as `varchar`, not `DATE`, because the collector writes ISO strings. Queries must compare to plain string literals (`WHERE date BETWEEN '2026-04-01' AND '2026-04-30'`); wrapping in `DATE '…'` raises `TYPE_MISMATCH` on Engine v3. The `run_athena_sql` chatbot tool spec and the Archive page's pre-filled query both follow this convention. See [ADR-0007](decisions/0007-athena-varchar-partitions.md).
- **Print-driven PDF export** — Save-as-PDF on Analyze, Cost, and Executive uses browser `window.print()` against a body-class-toggled `@media print` block (`body.app-print`). Zero new infra (no Puppeteer, no Lambda) and the printout matches what the user sees on screen because the styles are the same. See [ADR-0006](decisions/0006-print-driven-pdf-export.md).
- **Tool-use chatbot replaces fixed-mode Analyze** — `/api/analyze` (single-turn, user-selected `direct`/`sql` mode) replaced by `POST /api/chat/stream`: a Bedrock Converse tool-use loop that lets the model autonomously pick among four tools per turn. Client-side history (last 12 turns) gives multi-turn memory with no new infra. Pure helpers in `server/chat-tools.js` keep the Bedrock loop unit-testable. A global `FloatingChat` widget and the `/analyze` page both share one `ChatPanel` component. See [ADR-0008](decisions/0008-tool-use-chatbot.md).

## Cost breakdown

| Component | Monthly | Notes |
|-----------|---------|-------|
| ALB + WAF | ~$31 | Fixed |
| Fargate (2 ARM64 tasks, 24/7) | ~$30 | +$15/task when scaling |
| Secrets Manager (3 secrets) | ~$1 | |
| S3 + Glue + Athena + CloudWatch | ~$4 | |
| CloudFront | ~$2 | Free-tier 50 GB covers most usage |
| Lambda + EventBridge | ~$0 | Within free tier |
| Bedrock (Claude Sonnet 4.6) | ~$10 (light) to ~$100 (heavy) | $0.20/analyze request avg |
| **Baseline total** | **~$80 / month (light)** | ~$130 moderate, ~$250 heavy |

New-VPC path adds one NAT Gateway (~$43/month) plus EIP cost, so reuse an existing VPC whenever possible (`--context existingVpcId=...`).

## Operations

See `docs/runbooks/` for incident procedures. Currently shipped:
- [`alb-listener-drift.md`](runbooks/alb-listener-drift.md) — recover when the ALB listener loses its target group association.
- [`cognito-users.md`](runbooks/cognito-users.md) — provision / disable Hosted UI users.

Gaps tracked for future runbooks: rolling-deploy rollback, collector backfill, compliance prewarm cache flush, cost data reconciliation when live ≠ CSV, RBAC group-cost upstream 503 flap diagnosis, Spend Limits missing-scope (`read:spend_limits`) recovery.

---

# 한국어

## 시스템 개요

`claude-code-dashboard`는 세 계층으로 구성된 애널리틱스 앱입니다: 브라우저의 React/Vite SPA, ECS Fargate에서 세 종류 Anthropic API로 fan-out하는 Express 프록시, 90일 Analytics API 윈도우 이후를 위한 S3 + Glue + Athena 아카이브. ALB 앞에 CloudFront + WAF가 있으며, ALB Security Group은 CloudFront managed prefix list로 잠겨 ALB 직접 접근이 차단됩니다.

## 레이어별 구성요소

### Ingestion (수집)

| 구성요소 | 역할 |
|---------|------|
| Express 프록시 (`server/index.js`) | Analytics / Admin / Compliance API 요청 fan-out, 10분 in-memory 캐시, 부팅 시점 + 5분 주기 compliance prewarm 스케줄러 |
| Collector Lambda (`collector/handler.js`) | 5개 Analytics 엔드포인트를 파티셔닝된 NDJSON으로 S3에 일일 스냅샷 |
| Spend Report 업로더 (수동) | Claude Console CSV를 `s3://<archive>/spend-reports/`에 투입, 비용 페이지 입력 |

### Storage (저장)

| 구성요소 | 역할 |
|---------|------|
| 버전 관리 S3 버킷 | NDJSON 파티션(`<table>/date=YYYY-MM-DD/`), spend report, Athena 결과 |
| Glue Data Catalog | 테이블 (`claude_code_analytics`, `summaries_daily`, `skills_daily`, `connectors_daily`) + Hive 방식 date partition projection |
| Secrets Manager | `ccd/analytics-key`, `ccd/admin-key`, `ccd/compliance-key` |

### Processing (처리)

| 구성요소 | 역할 |
|---------|------|
| Amazon Bedrock (Claude Sonnet 4.6) | 멀티턴 tool-use 챗봇 (`POST /api/chat/stream`) — `ConverseStreamCommand` + `toolConfig` + SSE. 모델이 4개 도구(`get_analytics_overview`, `run_athena_sql`, `get_cost_summary`, `search_users`)를 자율적으로 호출. [ADR-0008](decisions/0008-tool-use-chatbot.md) 참조. |
| Athena 워크그룹 | 아카이브 파티션에 ad-hoc SQL, Archive 페이지와 챗봇의 `run_athena_sql` 도구 구동 |
| 서버 사이드 집계 | `/api/cost/live`는 Analytics `cost_report` + `usage_report`를 `(product, model)` 단위로 조인해 Cost 페이지의 `CsvResp` 형태로 reshape. `/api/cost/users`는 `user_cost_report`를 페이지네이션해 선택 기간 전체(cost 계열은 3일 버퍼를 부분 데이터로 제공)의 사용자별 라이브 USD spend 제공; `/api/cost/user-tokens`는 신설 `user_usage_report`로 사용자별 라이브 토큰 제공; `/api/cost/groups`는 `cost_report × rbac_group_id`로 RBAC 그룹별 지출을 제공하며 `GET /v1/compliance/groups`에서 조회한 실명 라벨 사용(1h 캐시, upstream 503 플랩 시 last-good); `/api/cost/spend-limits`는 Spend Limits API로 멤버별 월 한도+누적 지출 제공. `/api/cost/efficiency`는 `user_cost_report` 지출과 `users/range` 생산성을 `email`로 조인하되 비율 왜곡 방지를 위해 의도적으로 `today−3` 창 정렬 유지. `/api/cost/csv`는 31일 초과 정산·라이브 장애 폴백으로 잔존. [ADR-0003](decisions/0003-hybrid-live-cost.md) 및 [ADR-0009](decisions/0009-live-user-cost.md) 참조. |

### Query / Presentation (조회 / 표현)

| 구성요소 | 역할 |
|---------|------|
| React SPA | 17개 페이지, i18n(영/한), 날짜 범위 컨트롤(7d 기본, today를 최대 종료일로 허용 + UTC/일별 업데이트 안내), 사용자 drill-down 패널, 마크다운 렌더링, `/exec` 단일 화면 경영 요약, `/changelog`에서 Vite `?raw`로 번들된 `CHANGELOG.md` 렌더링. 사이드바는 `h-screen` + per-pane `overflow-y-auto`로 viewport 고정. 행별 통계 테이블은 공유 `useSortable` 훅 + `<SortableTh>`로 양방향 컬럼 정렬(`null`은 방향 무관 하단 고정). |
| Recharts | 라인/영역/막대/스택/파이/산점도/방사형 차트 |
| react-markdown + remark-gfm | AI 분석 결과 스트리밍 마크다운 렌더링 |

### Observability (관찰)

| 구성요소 | 역할 |
|---------|------|
| CloudWatch Logs | ECS 앱 로그, Lambda 로그, WAF 로그 |
| ECS circuit breaker | 롤링 배포 실패 시 자동 롤백 |
| ALB Target Group health check | 8080 포트 `/api/health` |

### Security (보안)

| 구성요소 | 역할 |
|---------|------|
| Cognito + Lambda@Edge (viewer-request) | 모든 CloudFront URL이 Cognito Hosted UI 로그인 필요. 네 개 핸들러(`check-auth`, `parse-auth`, `refresh-auth`, `sign-out`)가 엣지 PoP에서 JWT 쿠키 검증을 강제. 미인증 트래픽은 WAF/ALB/ECS 도달 **이전**에 `/oauth2/authorize`로 302. [ADR-0001](decisions/0001-cognito-lambda-edge-auth.md) 참조. |
| CloudFront + managed SECURITY_HEADERS 응답 정책 | TLS 1.2+ 종단, HTTP/2+/3, HSTS, CSP 기반 |
| AWS 관리형 WAF 규칙 (REGIONAL, ALB에 연결) | `AWSManagedRulesCommonRuleSet` (CSV 업로드 허용을 위해 `SizeRestrictions_BODY`만 COUNT로 다운그레이드) + `AWSManagedRulesKnownBadInputsRuleSet` + rate-based (IP당 5분 2000건) |
| CloudFront origin-facing prefix list | ALB SG 인바운드를 `pl-22a6434b`로만 제한 → ALB 직접 접근 차단 |
| 프라이빗 서브넷 | Fargate 태스크는 퍼블릭 IP 없음, 아웃바운드는 NAT 경유 |
| IAM 최소 권한 | 태스크 롤: `bedrock:InvokeModel*` (Claude 모델 한정), `athena:*Query*` (워크그룹 한정), 아카이브 버킷 S3 RW, 세 시크릿에 대한 Secrets Manager read + 빌드 시점 `ccd/cognito-config` (ECS 런타임은 이 시크릿에 접근하지 않음 — edge 빌드 단계에서만 사용) |

## 전체 아키텍처 다이어그램

```
                  ┌───────────────────────────────────────────┐
   Internet ────▶ │  CloudFront 배포                           │   TLS · HTTP/3 · SECURITY_HEADERS
                  │  (viewer protocol: redirect-to-HTTPS)     │
                  │                                           │
                  │  ┌─────────────────────────────────────┐  │
                  │  │ Lambda@Edge (us-east-1 복제)          │  │   Cognito 인증 게이트
                  │  │   default      → check-auth          │  │   — JWT 쿠키 검증
                  │  │   /parseauth   → parse-auth          │  │   — code ↔ token 교환
                  │  │   /refreshauth → refresh-auth        │  │   — silent refresh
                  │  │   /signout     → sign-out            │  │   — 쿠키 삭제 + /logout
                  │  └─────────────────────────────────────┘  │
                  └──────────────────┬────────────────────────┘
                                     │  (인증된 요청만)
                                     ▼  (origin-facing prefix list pl-22a6434b)
                  ┌───────────────────────────────────────────┐
                  │  Application Load Balancer (public)       │   리전형 WAF (common + bad-inputs + rate)
                  │  Listener :80  →  TG :8080                │
                  └──────────────────┬────────────────────────┘
                                     │
                                     ▼  (ALB SG → Service SG on :8080)
                  ┌───────────────────────────────────────────┐
                  │  ECS Fargate 서비스 (ARM64, 2–6 태스크)     │
                  │  - Vite SPA 정적 자산                        │
                  │  - Express /api 프록시                       │
                  └──────┬────────────┬────────────┬──────────┘
                         │            │            │
                         ▼            ▼            ▼
                 ┌───────────┐ ┌──────────┐ ┌───────────────┐
                 │ Anthropic │ │ Amazon   │ │ Amazon S3     │
                 │  API 3종   │ │ Bedrock  │ │ + Glue +      │
                 │  (키 3개)  │ │ (Sonnet  │ │   Athena      │
                 │           │ │  4.6)    │ │               │
                 └───────────┘ └──────────┘ └──────┬────────┘
                                                   ▲
                                                   │ (NDJSON 파티션)
                              ┌────────────────────┴──────────────────┐
                              │  EventBridge (매일 14:00 UTC)          │
                              │           │                           │
                              │           ▼                           │
                              │  Collector Lambda (Node 20)           │
                              │  - fetchAllPages × 5 엔드포인트         │
                              │  - flattenUser (Analytics → NDJSON)   │
                              └───────────────────────────────────────┘
```

## 데이터 흐름 요약

브라우저 요청 → CloudFront → WAF → ALB → Fargate Express → (S3 아카이브 또는 실시간 Anthropic API) → JSON → 브라우저. AI 챗봇 모드(`/api/chat/stream`): 브라우저 → Express → Bedrock `ConverseStreamCommand` tool-use 루프(최대 4 hop, 도구가 실시간 API + Athena 호출) → SSE 청크 → 브라우저.

## 인프라 (CDK 스택)

| 스택 | 포함 리소스 |
|------|-------------|
| `ccd-network` | VPC (신규 또는 lookup), S3 Gateway endpoint |
| `ccd-storage` | 버전 관리 S3 아카이브 버킷, Glue 데이터베이스 + projection partition 4개 테이블, Athena 워크그룹 |
| `ccd-compute` | ECS 클러스터, 태스크 정의(ARM64), 서비스(2–6 태스크, CPU 자동 스케일), ALB + listener + WAF, CloudFront 배포, Secrets Manager 참조 |
| `ccd-collector` | Collector Lambda + EventBridge 규칙(매일 14:00 UTC) + 로그 보존 custom resource |

## 주요 설계 결정

- **컨텍스트로 기존 VPC 재사용** — 대상 계정의 EIP 쿼터가 고갈되어 신규 NAT 생성 시 실패. `NetworkStack`이 `existingVpcId` 컨텍스트로 분기해 배포 가능한 상태 유지.
- **S3-우선 캐싱** — 모든 조회가 실 API보다 S3를 먼저 시도. 30일 range 요청이 22초(순차)/3초(병렬, 60 rpm 중 50% 소비)에서 250 ms·API 호출 0회로 단축.
- **독립된 3개 API 키** — Analytics · Admin · Compliance scope 각각 별도 Secrets Manager 시크릿. 독립 회전 가능하며 각 키는 선택적.
- **ALB SG에 CloudFront prefix list** — mTLS나 private ALB 없이도 인터넷 직접 접근 차단.
- **ARM64 Fargate** — x86 대비 약 20% 저렴, 개발 호스트 아키텍처와 일치해 Docker 빌드 시 QEMU 에뮬레이션 불필요.
- **이메일 마스킹을 계약으로** — `maskEmail()`을 프론트엔드와 LLM 시스템 프롬프트 양쪽에서 호출해 UI를 기본적으로 안전하게 유지.
- **`user_cost_report` 기반 라이브 사용자별 비용** — v0.8.0부터 Cost 페이지의 per-user "Top by Cost" 테이블과 `distinct_users` KPI가 `GET /api/cost/users`(Analytics `user_cost_report`)에서 라이브로 공급됨. `/cost/efficiency`는 라이브 per-user spend를 `email` 기준으로 `users/range` 생산성과 조인하되 **의도적으로 `today−3` 창 정렬 유지**(전체 기간 지출과 버퍼 clamp된 생산성을 섞으면 $/LOC가 부풀려짐). 2026-07부터 사용자별 **토큰**도 라이브(`user_usage_report` → `/api/cost/user-tokens`)이므로 CSV 업로드는 폴백 전용: 31일 초과 정산(cost 계열 기간 상한)과 라이브 장애 시. [ADR-0003](decisions/0003-hybrid-live-cost.md), [ADR-0009](decisions/0009-live-user-cost.md), [ADR-0010](decisions/0010-cost-window-policy.md), [ADR-0012](decisions/0012-live-user-tokens.md) 참조.
- **RBAC 그룹 비용 + 실명** — `cost_report × rbac_group_id`(upstream 2026-07~)가 Cost 페이지 그룹별 카드를 구동하고, 사이드바 그룹 스코프는 관리자 CSV가 없으면 `user_cost_report × rbac_group_id`에서 email→그룹 매핑을 자동 유도. 그룹 ID는 문서화된 Compliance groups 엔드포인트(`GET /v1/compliance/groups`, 1h 캐시 — 호출마다 `group_list_viewed` 감사 이벤트 발생)로 실명 해석하며 비문서화 `rbac_groups` 목록은 사용하지 않음. upstream 차원이 플랩(간헐 503 "Team membership data is not ready yet")하므로 서버가 last-good 응답을 보관하고 UI는 카드 소실 대신 안내 문구 표시. [ADR-0011](decisions/0011-rbac-group-visibility-native.md) 참조.
- **Compliance after_id 페이지네이션 + prewarm** — Compliance API는 timestamp 필터가 없고 `after_id` cursor로만 페이지네이션. ECS task 부팅 시 7d / 14d / 30d 백그라운드 fetch + 5분마다 재실행. upstream 캐시(TTL 10분)가 사용자 요청을 흡수해 audit 페이지가 30+ 초 페이지네이션 대신 1초 미만 응답. 일별 차트에는 `평균+1σ` reference line이 추가돼 위험 spike를 즉시 인지. [ADR-0004](decisions/0004-compliance-pagination-prewarm.md) 참조.
- **7d 기본 기간** — 모든 기간 인지 페이지가 `range=7d`로 부팅 (v0.3.0까지는 14d / 30d). 더 좁은 신호와 트레이드오프이지만, Adoption stale-skill 감지의 윈도우 이등분과 Compliance spike 임계값 계산이 7d에서도 의미 있는 값을 산출. [ADR-0005](decisions/0005-default-7d-window.md) 참조.
- **Athena varchar 파티션** — Glue 테이블의 `date` 파티션은 `varchar`이지 `DATE`가 아님 (collector가 ISO 문자열로 적재). 쿼리는 단순 문자열 리터럴(`WHERE date BETWEEN '2026-04-01' AND '2026-04-30'`)로 비교해야 하며, `DATE '…'`로 감싸면 Engine v3가 `TYPE_MISMATCH`로 거부. `run_athena_sql` 챗봇 도구 스펙과 Archive 페이지의 기본 쿼리 모두 이 규칙을 따름. [ADR-0007](decisions/0007-athena-varchar-partitions.md) 참조.
- **인쇄 기반 PDF 내보내기** — Analyze · Cost · Executive 의 Save-as-PDF는 `body.app-print` 클래스로 토글되는 `@media print` 블록 + 브라우저 `window.print()`만 사용. 신규 인프라 0(Puppeteer · Lambda 불필요)이며, 화면과 동일한 스타일을 그대로 인쇄. [ADR-0006](decisions/0006-print-driven-pdf-export.md) 참조.
- **고정 모드 Analyze를 tool-use 챗봇으로 대체** — `/api/analyze` (단일 턴, `direct`/`sql` 모드 수동 선택)를 `POST /api/chat/stream`으로 교체. Bedrock Converse tool-use 루프로 모델이 턴마다 4개 도구를 자율 선택. 클라이언트 사이드 히스토리(최근 12턴)로 멀티턴 메모리를 신규 인프라 없이 구현. 순수 헬퍼는 `server/chat-tools.js`에 분리해 Bedrock 루프를 단위 테스트 가능. 전역 `FloatingChat` 위젯과 `/analyze` 페이지 모두 하나의 `ChatPanel` 컴포넌트를 공유. [ADR-0008](decisions/0008-tool-use-chatbot.md) 참조.

## 비용 내역

| 구성요소 | 월간 비용 | 비고 |
|----------|-----------|------|
| ALB + WAF | 약 $31 | 고정 |
| Fargate (ARM64 2 태스크, 24/7) | 약 $30 | 스케일업 시 태스크당 +$15 |
| Secrets Manager (시크릿 3개) | 약 $1 | |
| S3 + Glue + Athena + CloudWatch | 약 $4 | |
| CloudFront | 약 $2 | Free tier 50 GB로 대부분 커버 |
| Lambda + EventBridge | 약 $0 | Free tier 내 |
| Bedrock (Claude Sonnet 4.6) | 약 $10 (경량) ~ 약 $100 (많이 사용) | 분석 요청 1건당 평균 $0.20 |
| **기준 합계** | **월 약 $80 (경량)** | 중간 약 $130, 많이 사용 약 $250 |

신규 VPC 경로는 NAT Gateway 1개(월 약 $43) + EIP 비용이 추가되므로 가능한 경우 기존 VPC 재사용(`--context existingVpcId=...`)을 권장합니다.

## 운영

`docs/runbooks/` 의 사고 대응 절차. 현재 보유:
- [`alb-listener-drift.md`](runbooks/alb-listener-drift.md) — ALB listener의 target group 연결 손실 복구.
- [`cognito-users.md`](runbooks/cognito-users.md) — Hosted UI 사용자 관리.

향후 추가 후보: 롤링 배포 롤백, collector backfill, compliance prewarm 캐시 flush, 라이브 ≠ CSV 비용 데이터 정산 절차, RBAC 그룹 비용 upstream 503 플랩 진단, Spend Limits 스코프(`read:spend_limits`) 누락 복구.
