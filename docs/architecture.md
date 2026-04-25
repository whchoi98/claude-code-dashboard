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
| Express proxy (`server/index.js`) | Per-request fan-out to Analytics / Admin / Compliance APIs with a 5-minute in-memory cache |
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
| Amazon Bedrock (Claude Sonnet 4.6) | Natural-language analysis via `ConverseStream` — SSE to the browser |
| Athena workgroup | Ad-hoc SQL over archived partitions; powers the Archive page and the AI autonomous-SQL mode |
| Server-side aggregation | `/api/cost/efficiency` joins Spend CSV + `users/range` to compute the economic productivity score |

### Query / Presentation

| Component | Purpose |
|-----------|---------|
| React SPA | 11 pages, i18n (en/ko), date range control, user drill-down panel, markdown rendering |
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

Browser request → CloudFront → WAF → ALB → Fargate Express → (S3 archive or live Anthropic API) → JSON → browser. AI mode extends: browser → Express → Bedrock `ConverseStream` → SSE chunks → browser.

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
- **Three independent API keys** — Analytics, Admin, and Compliance scopes each get their own Secrets Manager secret so they can be rotated independently and any one of them is optional.
- **CloudFront prefix list on ALB SG** — blocks direct ALB access from the internet without requiring mTLS or a private ALB.
- **ARM64 Fargate** — cheaper than x86 (~20 %) and matches the dev host architecture so Docker image builds don't need QEMU emulation.
- **Email masking as a contract** — `maskEmail()` is called in both the frontend and the LLM system prompt, making the UI safe by default.

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

See `docs/runbooks/` for incident procedures (listener drift, failed rolling deploy, ECR push denied, WAF block rate spike).

---

# 한국어

## 시스템 개요

`claude-code-dashboard`는 세 계층으로 구성된 애널리틱스 앱입니다: 브라우저의 React/Vite SPA, ECS Fargate에서 세 종류 Anthropic API로 fan-out하는 Express 프록시, 90일 Analytics API 윈도우 이후를 위한 S3 + Glue + Athena 아카이브. ALB 앞에 CloudFront + WAF가 있으며, ALB Security Group은 CloudFront managed prefix list로 잠겨 ALB 직접 접근이 차단됩니다.

## 레이어별 구성요소

### Ingestion (수집)

| 구성요소 | 역할 |
|---------|------|
| Express 프록시 (`server/index.js`) | Analytics / Admin / Compliance API 요청 fan-out, 5분 in-memory 캐시 |
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
| Amazon Bedrock (Claude Sonnet 4.6) | `ConverseStream`으로 자연어 분석 → 브라우저 SSE |
| Athena 워크그룹 | 아카이브 파티션에 ad-hoc SQL, Archive 페이지와 AI autonomous-SQL 모드 구동 |
| 서버 사이드 집계 | `/api/cost/efficiency`가 Spend CSV + `users/range`를 조인해 경제 생산성 점수 계산 |

### Query / Presentation (조회 / 표현)

| 구성요소 | 역할 |
|---------|------|
| React SPA | 11개 페이지, i18n(영/한), 날짜 범위 컨트롤, 사용자 drill-down 패널, 마크다운 렌더링 |
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

브라우저 요청 → CloudFront → WAF → ALB → Fargate Express → (S3 아카이브 또는 실시간 Anthropic API) → JSON → 브라우저. AI 모드 확장: 브라우저 → Express → Bedrock `ConverseStream` → SSE 청크 → 브라우저.

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

사고 대응 절차(listener drift, 롤링 배포 실패, ECR push 거부, WAF 차단 급증)는 `docs/runbooks/` 참고.
