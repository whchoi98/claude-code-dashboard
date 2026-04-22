# claude-code-dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](./CHANGELOG.md)
[![English](https://img.shields.io/badge/lang-English-informational)](#english)
[![한국어](https://img.shields.io/badge/lang-한국어-informational)](#한국어)

Enterprise analytics dashboard for Claude Code — engagement, productivity, cost, and audit insights with an AI query layer.

Claude Code 엔터프라이즈 애널리틱스 대시보드 — 참여도·생산성·비용·감사 지표를 통합하고 AI 질의응답 레이어를 제공합니다.

---

# English

## Overview

`claude-code-dashboard` joins the Anthropic **Analytics**, **Admin**, and **Compliance** APIs — plus an uploaded Spend Report CSV and a daily S3 archive — into a single CloudFront-fronted dashboard. It answers five questions at once: *Who is using Claude?*, *How productive are they?*, *How much are we spending?*, *What did they do (audit)?*, *What does the data mean?* (AI analysis via Amazon Bedrock).

The architecture mirrors the [kiro-dashboard](https://github.com/whchoi98/kiro-dashboard) reference stack: CloudFront → WAF → ALB → ECS Fargate (private subnets) → NAT → external APIs, with S3 / Glue / Athena underneath for retention beyond the 90-day Analytics API window.

## Features

- **11 pages** — Overview · Users (drill-down) · User Productivity · Trends · Claude Code · Productivity · Adoption · Cost · Audit · Analyze (AI) · Archive.
- **Three API integrations** — Analytics, Admin, Compliance (each via its own Secrets Manager secret; all three are optional, the dashboard degrades gracefully).
- **S3-first data layer** — a Lambda collector snapshots the Analytics API daily into partitioned NDJSON. Queries hit S3 first (~150 ms) and fall back to the live API only on cache miss.
- **AI natural-language query** — Server-sent-events streaming from Amazon Bedrock (Claude Sonnet 4.6 cross-region profile). Two modes: direct snapshot analysis, and autonomous Athena SQL generation + execution over the archive.
- **Economic productivity score** — joins Spend Report CSV with Analytics productivity to rank users by `output / $` efficiency.
- **Bilingual UI** — runtime English / Korean toggle with localStorage persistence.
- **Privacy by default** — every user email is rendered masked (`co*****@gmail.com`).
- **Audit trail** — Compliance API feed with risk-event highlighting (role changes, SSO toggles, data exports).

## Prerequisites

- Node.js >= 20
- Docker (for CDK image asset builds)
- AWS CLI v2 with credentials for the target account
- AWS CDK v2.170+
- Optional: Anthropic Analytics API key, Admin API key, Compliance API key

## Installation

```bash
# Clone
git clone https://github.com/whchoi98/claude-code-dashboard.git
cd claude-code-dashboard

# Install all workspaces
npm install
(cd infra && npm install)
(cd collector && npm install)

# Configure local environment
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_ANALYTICS_KEY

# Run locally (Vite on 5173 + Express on 5174, concurrent)
npm run dev
```

## Usage

```bash
# Build the SPA + start the Express API in production mode
npm run build
npm run server
# → http://localhost:5174

# Deploy to AWS (reuses an existing VPC to avoid EIP quota issues)
cd infra
npx cdk deploy --all --require-approval never \
  --context existingVpcId=vpc-xxxxxxxxxxxxxxxxx

# After deploy, inject API keys into Secrets Manager
aws secretsmanager put-secret-value --secret-id ccd/analytics-key \
  --secret-string 'sk-ant-api01-...'
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_ANALYTICS_KEY` | Enterprise Analytics API key (sk-ant-api01-… with Analytics scope) | (required for live mode) |
| `ANTHROPIC_ADMIN_KEY_ADMIN` | Admin API key (sk-ant-admin01-…) — enables Cost page | (optional) |
| `ANTHROPIC_COMPLIANCE_KEY` | Compliance API key (sk-ant-api01-… with Compliance scope) | (optional) |
| `AWS_REGION` | AWS region for Bedrock / Athena / S3 | `ap-northeast-2` |
| `BEDROCK_MODEL_ID` | Bedrock foundation model or inference profile | `global.anthropic.claude-sonnet-4-6` |
| `ARCHIVE_S3_BUCKET` | S3 bucket for NDJSON archive + spend reports | (set by CDK) |
| `ATHENA_WORKGROUP` | Athena workgroup name | `claude-code-dashboard` |
| `ATHENA_DATABASE` | Glue database name | `claude_code_analytics` |
| `ATHENA_OUTPUT_LOCATION` | S3 URI for Athena query results | (set by CDK) |
| `PORT` | Express listen port | `5174` (dev) / `8080` (container) |

## Project Structure

```
claude-code-dashboard/
├── src/                    # React SPA (Vite)
│   ├── components/         # Shared UI, DateRangeControl, UserDetailPanel
│   ├── pages/              # 11 routes
│   ├── lib/                # i18n, useFetch, useDateRange, formatting
│   └── types.ts            # API schema types
├── server/                 # Express proxy + AWS integrations
│   ├── index.js            # /api/analytics/*, /api/admin/*, /api/compliance/*
│   ├── aws.js              # Bedrock SSE, Athena, CSV parsing, efficiency join
│   └── mock.js             # Deterministic mocks for local dev
├── collector/              # Daily Lambda — Analytics API → S3 NDJSON
├── infra/                  # AWS CDK (TypeScript) — 4 stacks
├── docs/                   # Architecture, ADRs, runbooks
├── tests/                  # Harness tests (hooks, structure, secrets)
└── scripts/                # setup.sh, install-hooks.sh
```

## Cost Estimate (ap-northeast-2)

Monthly AWS charges for a single production deployment. Numbers assume the **default 2-task ECS service**, the **existing VPC reuse** pattern (no new NAT Gateway), and light-to-moderate dashboard traffic.

| Resource | Spec | Monthly |
|----------|------|---------|
| Application Load Balancer | 1 ALB + light LCU | ~$22 |
| AWS WAF (regional) | 1 Web ACL + 2 managed rule groups + rate rule | ~$9 |
| ECS Fargate | 2 ARM64 tasks · 0.5 vCPU · 1 GB · 24/7 | ~$30 |
| Secrets Manager | 3 secrets (Analytics / Admin / Compliance) | ~$1.20 |
| S3 archive | <1 GB NDJSON + versioning | ~$0.05 |
| CloudWatch Logs | 30-day retention, ~1 GB/month | ~$1 |
| Glue Data Catalog | 4 tables + partition projections | ~$1 |
| Athena | Ad-hoc queries, ~10 GB scanned/month | ~$1 |
| CloudFront | 50 GB free tier covers most small deployments | ~$1-3 |
| Lambda collector + EventBridge | 30 invocations/month · 512 MB · 30s avg | ~$0 (free tier) |
| **Fixed subtotal** | | **~$66 – 70** |
| Bedrock (Claude Sonnet 4.6) | 50 analyze requests/month (~$0.20 each) | ~$10 |
| Bedrock (heavy) | 500 analyze requests/month | ~$100 |
| Fargate auto-scale peaks | Up to 6 tasks during spikes | +$10 – 40 |
| Data transfer (CloudFront out) | ~10 GB/month | ~$1 |
| **Total (light)** | Fewer than 100 analyze queries, steady 2 tasks | **~$80 / month** |
| **Total (moderate)** | 200–500 analyze queries, occasional peaks | **~$130 / month** |
| **Total (heavy)** | 1,000+ analyze queries, frequent scale-ups | **~$250 / month** |

If you let CDK create a brand-new VPC (no `existingVpcId` context), add **~$43 / month** for a NAT Gateway.

Free-tier eligible accounts in their first 12 months should pay noticeably less (50 GB CloudFront, 750 h t2/t3 EC2 credits are not used here, but Fargate has no free tier). The cheapest way to lower the baseline is to shrink the ECS service to 1 task (drops ~$15) at the cost of no rolling-deploy headroom.

## Testing

```bash
# Type check
npx tsc --noEmit

# Production build
npx vite build

# Server syntax
node --check server/index.js server/aws.js server/mock.js collector/handler.js

# CDK synth
(cd infra && npx cdk synth --context existingVpcId=vpc-xxxxxxxxxxxxxxxxx)

# Harness suite
bash tests/run-all.sh
```

## API Documentation

See [docs/api-reference.md](./docs/api-reference.md) for every route exposed by the Express proxy.

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/short-description`.
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/) format — e.g. `feat: add per-user token heatmap` or `fix: mask email in Adoption page`.
4. Push and open a PR against `main`.
5. Ensure `/test-all` passes and fill in the PR checklist.

## License

Released under the [MIT License](./LICENSE).

## Contact

- Maintainer: [@whchoi98](https://github.com/whchoi98)
- Issues: [github.com/whchoi98/claude-code-dashboard/issues](https://github.com/whchoi98/claude-code-dashboard/issues)

---

# 한국어

## 개요

`claude-code-dashboard`는 Anthropic **Analytics**, **Admin**, **Compliance** API에 더해 업로드된 Spend Report CSV와 일일 S3 아카이브를 결합해 하나의 CloudFront 프론트 대시보드로 제공합니다. 다섯 가지 질문에 동시에 답합니다: *누가 Claude를 쓰는가?*, *얼마나 생산적인가?*, *얼마를 쓰고 있는가?*, *무슨 활동을 했는가(감사)?*, *데이터가 무엇을 의미하는가?* (Amazon Bedrock 기반 AI 분석).

아키텍처는 [kiro-dashboard](https://github.com/whchoi98/kiro-dashboard) 레퍼런스 스택과 동일합니다: CloudFront → WAF → ALB → ECS Fargate (프라이빗 서브넷) → NAT → 외부 API. 그 아래 S3 / Glue / Athena가 90일 Analytics API 윈도우 이후의 장기 보관을 담당합니다.

## 주요 기능

- **11개 페이지** — 개요 · 사용자(드릴다운) · 사용자별 생산성 · 추세 · Claude Code · 생산성 · 도입 · 비용 · 감사 · 분석(AI) · 아카이브.
- **세 개의 API 통합** — Analytics, Admin, Compliance (각각 별도 Secrets Manager 시크릿으로 주입; 모두 선택적이며 키가 없어도 UI는 graceful하게 동작).
- **S3-우선 데이터 레이어** — Lambda collector가 매일 Analytics API 스냅샷을 파티셔닝된 NDJSON으로 S3에 저장합니다. 조회는 S3 먼저(~150 ms), 캐시 miss 시에만 실제 API fallback.
- **AI 자연어 질의** — Amazon Bedrock(Claude Sonnet 4.6 cross-region 프로파일) 기반 SSE 스트리밍. 두 모드: 실시간 스냅샷 직접 분석, 자율 Athena SQL 생성 + 실행.
- **경제 생산성 점수** — Spend Report CSV와 Analytics 생산성을 결합해 `달러당 output` 기준 사용자 랭킹 제공.
- **이중 언어 UI** — 영/한 실시간 토글 (localStorage 저장).
- **기본 개인정보 보호** — 모든 이메일을 마스킹해 표시 (`co*****@gmail.com`).
- **감사 추적** — Compliance API 이벤트 피드 + 위험 이벤트 하이라이트 (역할 변경, SSO 토글, 데이터 export 등).

## 사전 요구 사항

- Node.js 20 이상
- Docker (CDK 이미지 자산 빌드용)
- AWS CLI v2 + 대상 계정 자격 증명
- AWS CDK v2.170 이상
- 선택: Anthropic Analytics / Admin / Compliance API 키

## 설치 방법

```bash
# 클론
git clone https://github.com/whchoi98/claude-code-dashboard.git
cd claude-code-dashboard

# 전체 워크스페이스 설치
npm install
(cd infra && npm install)
(cd collector && npm install)

# 로컬 환경 설정
cp .env.example .env
# .env 편집 — 최소한 ANTHROPIC_ANALYTICS_KEY 설정

# 로컬 실행 (Vite 5173 + Express 5174 동시 실행)
npm run dev
```

## 사용법

```bash
# SPA 빌드 + Express 프로덕션 모드
npm run build
npm run server
# → http://localhost:5174

# AWS 배포 (EIP 쿼터 문제 회피를 위해 기존 VPC 재사용)
cd infra
npx cdk deploy --all --require-approval never \
  --context existingVpcId=vpc-xxxxxxxxxxxxxxxxx

# 배포 후 Secrets Manager에 API 키 주입
aws secretsmanager put-secret-value --secret-id ccd/analytics-key \
  --secret-string 'sk-ant-api01-...'
```

## 환경 설정

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `ANTHROPIC_ANALYTICS_KEY` | Enterprise Analytics API 키 (sk-ant-api01-… Analytics scope) | (live 모드 필수) |
| `ANTHROPIC_ADMIN_KEY_ADMIN` | Admin API 키 (sk-ant-admin01-…) — 비용 페이지 활성화 | (선택) |
| `ANTHROPIC_COMPLIANCE_KEY` | Compliance API 키 (sk-ant-api01-… Compliance scope) | (선택) |
| `AWS_REGION` | Bedrock / Athena / S3 리전 | `ap-northeast-2` |
| `BEDROCK_MODEL_ID` | Bedrock 파운데이션 모델 또는 inference profile | `global.anthropic.claude-sonnet-4-6` |
| `ARCHIVE_S3_BUCKET` | NDJSON 아카이브 + spend report용 S3 버킷 | (CDK가 설정) |
| `ATHENA_WORKGROUP` | Athena 워크그룹 이름 | `claude-code-dashboard` |
| `ATHENA_DATABASE` | Glue 데이터베이스 이름 | `claude_code_analytics` |
| `ATHENA_OUTPUT_LOCATION` | Athena 쿼리 결과 S3 URI | (CDK가 설정) |
| `PORT` | Express 리스닝 포트 | `5174` (개발) / `8080` (컨테이너) |

## 프로젝트 구조

```
claude-code-dashboard/
├── src/                    # React SPA (Vite)
│   ├── components/         # 공용 UI, DateRangeControl, UserDetailPanel
│   ├── pages/              # 11개 라우트
│   ├── lib/                # i18n, useFetch, useDateRange, 포맷팅
│   └── types.ts            # API 스키마 타입
├── server/                 # Express 프록시 + AWS 통합
│   ├── index.js            # /api/analytics/*, /api/admin/*, /api/compliance/*
│   ├── aws.js              # Bedrock SSE, Athena, CSV 파싱, efficiency join
│   └── mock.js             # 로컬 개발용 결정론적 목업
├── collector/              # 일일 Lambda — Analytics API → S3 NDJSON
├── infra/                  # AWS CDK (TypeScript) — 4개 스택
├── docs/                   # 아키텍처 · ADR · 런북
├── tests/                  # 하니스 테스트 (hook, 구조, secret)
└── scripts/                # setup.sh, install-hooks.sh
```

## 월간 예상 비용 (ap-northeast-2)

하나의 프로덕션 배포에 대한 월간 AWS 청구 예상치입니다. **기본값 ECS 2 태스크**, **기존 VPC 재사용 패턴**(NAT Gateway 신규 생성 없음), 경량~중간 대시보드 트래픽을 가정합니다.

| 리소스 | 스펙 | 월간 비용 |
|--------|------|-----------|
| Application Load Balancer | ALB 1개 + 적은 LCU | 약 $22 |
| AWS WAF (Regional) | Web ACL 1개 + 관리형 룰 그룹 2개 + rate 룰 | 약 $9 |
| ECS Fargate | ARM64 2 태스크 · 0.5 vCPU · 1 GB · 24/7 | 약 $30 |
| Secrets Manager | 시크릿 3개 (Analytics / Admin / Compliance) | 약 $1.20 |
| S3 archive | NDJSON < 1 GB + versioning | 약 $0.05 |
| CloudWatch Logs | 30일 보존, 월 약 1 GB | 약 $1 |
| Glue Data Catalog | 4 테이블 + 파티션 projection | 약 $1 |
| Athena | Ad-hoc 쿼리, 월 약 10 GB 스캔 | 약 $1 |
| CloudFront | 무료 티어 50 GB로 대부분 커버 | 약 $1-3 |
| Lambda 컬렉터 + EventBridge | 월 30회 호출 · 512 MB · 30초 평균 | 약 $0 (free tier) |
| **고정 소계** | | **약 $66 – 70** |
| Bedrock (Claude Sonnet 4.6) | 월 50회 분석 (~$0.20/회) | 약 $10 |
| Bedrock (많이 사용) | 월 500회 분석 | 약 $100 |
| Fargate 오토스케일 피크 | 스파이크 시 최대 6 태스크 | +$10 – 40 |
| Data transfer (CloudFront out) | 월 약 10 GB | 약 $1 |
| **총합 (경량)** | 월 100회 미만 분석, 2 태스크 고정 | **월 약 $80** |
| **총합 (중간)** | 월 200~500회 분석, 가끔 피크 | **월 약 $130** |
| **총합 (많이 사용)** | 월 1,000회 이상 분석, 잦은 스케일업 | **월 약 $250** |

`existingVpcId` 컨텍스트 없이 CDK가 새 VPC를 만들게 두면 NAT Gateway 비용 **월 약 $43** 추가됩니다.

가입 후 12개월 이내의 AWS Free Tier 계정은 더 저렴합니다 (CloudFront 50 GB, 일부 Lambda 호출 무료). Fargate는 free tier가 없습니다. 기본 비용을 더 줄이려면 ECS 서비스를 1 태스크로 축소하면 약 $15 절감되지만 롤링 배포 여유가 사라집니다.

## 테스트

```bash
# 타입 체크
npx tsc --noEmit

# 프로덕션 빌드
npx vite build

# 서버 문법 검사
node --check server/index.js server/aws.js server/mock.js collector/handler.js

# CDK synth
(cd infra && npx cdk synth --context existingVpcId=vpc-xxxxxxxxxxxxxxxxx)

# 하니스 테스트 스위트
bash tests/run-all.sh
```

## API 문서

Express 프록시가 노출하는 전체 라우트는 [docs/api-reference.md](./docs/api-reference.md)를 참고합니다.

## 기여 방법

1. 저장소를 fork합니다.
2. 기능 브랜치를 생성합니다: `git checkout -b feat/short-description`.
3. [Conventional Commits](https://www.conventionalcommits.org/) 형식으로 커밋합니다 — 예: `feat: 사용자별 토큰 히트맵 추가` 또는 `fix: 도입 페이지의 이메일 마스킹`.
4. Push 후 `main`을 대상으로 PR을 엽니다.
5. `/test-all`이 통과하는지 확인하고 PR 체크리스트를 채웁니다.

## 라이선스

[MIT License](./LICENSE) 하에 배포됩니다.

## 연락처

- 메인테이너: [@whchoi98](https://github.com/whchoi98)
- 이슈 트래커: [github.com/whchoi98/claude-code-dashboard/issues](https://github.com/whchoi98/claude-code-dashboard/issues)
