# Changelog

[![English](https://img.shields.io/badge/lang-English-informational)](#english)
[![한국어](https://img.shields.io/badge/lang-한국어-informational)](#한국어)

---

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
