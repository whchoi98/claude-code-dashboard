# Changelog

[![English](https://img.shields.io/badge/lang-English-informational)](#english)
[![한국어](https://img.shields.io/badge/lang-한국어-informational)](#한국어)

---

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cognito + Lambda@Edge authentication**: every CloudFront URL now sits behind a Cognito Hosted UI login. Four viewer-request Lambda@Edge functions run at every edge PoP — `check-auth` (default), `parse-auth` (`/parseauth`), `refresh-auth` (`/refreshauth`), `sign-out` (`/signout`). JWT validation uses the pool's JWKs with a 5-minute per-container cache. Unauth'd traffic is blocked before reaching WAF, ALB, or the ECS task. See [ADR 0001](docs/decisions/0001-cognito-lambda-edge-auth.md).
- **Sign out link in the sidebar**: plain `<a href="/signout">` so the browser issues a real request and the edge handler can clear HttpOnly cookies and redirect to Cognito `/logout`.
- **CSV upload / list / delete from the dashboard**: three new endpoints — `POST /api/cost/upload`, `GET /api/cost/uploads`, `DELETE /api/cost/uploads/:file` — remove the need for AWS CLI access when refreshing the Spend Report. Multer-backed multipart handler (25 MB cap, schema check against required columns, path-traversal-safe filenames). Client-side preview (rows, users, derived period) with period-overlap warning against existing uploads. See [ADR 0002](docs/decisions/0002-dashboard-csv-upload.md).
- **Date range control on the Cost page**: same 7d / 14d / 30d / custom picker used across the rest of the dashboard, bound to the Economic Productivity section (which joins the CSV with live Analytics per-user productivity). Top KPIs stay anchored to the CSV's native period by design — the CSV is pre-aggregated and has no daily breakdown to filter on. Effective range (server-clamped to Analytics' 3-day buffer) is displayed.
- **`useFetch()` now returns `refetch()`**: mutation-triggering UIs (first consumer: `CsvUploader`) can invalidate cached GETs without a full page reload.
- Build-time secret injection for Lambda@Edge via `scripts/build-edge.mjs`: renders `infra/edge/dist/` from `_shared.template.js` by substituting Cognito config pulled from Secrets Manager (`ccd/cognito-config`). `dist/` is gitignored.
- Cognito user management runbook at [`docs/runbooks/cognito-users.md`](docs/runbooks/cognito-users.md).

### Changed

- Cost page top-level data (KPIs, product×model tables, Top-10 rankings) stays bound to the CSV's fixed period. Only the Economic Productivity section is date-range-aware.
- `@aws-sdk/client-secrets-manager` added at the repo root to support the edge-bundle build step.
- `multer` added at version 2.x (2.1.1) with an explicit JSON error wrapper so every upload failure path returns structured JSON instead of Express's default HTML error page.

### Fixed

- **WAF `SizeRestrictions_BODY` blocks every POST > 8 KB**: the default `AWSManagedRulesCommonRuleSet` sub-rule silently killed the new `/api/cost/upload` with a WAF 403 HTML page (`<html> <h...`). Downgraded to COUNT via `ruleActionOverrides` so the rule is still logged for observability but no longer blocks. All other CommonRuleSet protections (XSS, SQLi, LFI/RFI, bad UA) remain BLOCK.
- CSV filename regex for the upload sanitizer now accepts Anthropic Console's actual export format (`spend-report--YYYY-MM-DD-to-YYYY-MM-DD.csv`, with a double dash) so the period is preserved instead of falling back to a today-derived name.
- `console.log` diagnostic on upload entry so `CloudWatch Logs` can confirm whether a failing upload reached the container vs. being blocked upstream.

### Security

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

### Added

- **Cognito + Lambda@Edge 인증**: 이제 모든 CloudFront URL은 Cognito Hosted UI 로그인을 거쳐야 접근 가능. 네 개의 viewer-request Lambda@Edge 함수가 모든 엣지 PoP에서 실행 — `check-auth` (default), `parse-auth` (`/parseauth`), `refresh-auth` (`/refreshauth`), `sign-out` (`/signout`). JWT 검증은 User Pool의 JWKs + 컨테이너별 5분 캐시 사용. 미인증 트래픽은 WAF · ALB · ECS에 도달하기 전에 차단. 자세한 내용은 [ADR 0001](docs/decisions/0001-cognito-lambda-edge-auth.md) 참조.
- **사이드바 로그아웃 링크**: SPA 라우터를 우회하도록 순수 `<a href="/signout">`로 구현 — 브라우저가 실제 요청을 보내야 엣지 핸들러가 HttpOnly 쿠키 삭제 + Cognito `/logout`으로 리다이렉트 가능.
- **대시보드에서 CSV 업로드/목록/삭제**: 세 가지 새 엔드포인트 — `POST /api/cost/upload`, `GET /api/cost/uploads`, `DELETE /api/cost/uploads/:file` — 덕분에 Spend Report 갱신 시 AWS CLI 권한 불필요. Multer 기반 multipart 처리기 (25 MB 상한, 필수 컬럼 스키마 체크, path-traversal-safe 파일명). 클라이언트 프리뷰 (행 수, 사용자 수, 파일명 기반 기간 추출) + 기존 업로드와 기간 중복 경고. [ADR 0002](docs/decisions/0002-dashboard-csv-upload.md) 참조.
- **비용 페이지 기간 선택 컨트롤**: 다른 페이지와 동일한 7d / 14d / 30d / 커스텀 picker, **Economic Productivity 섹션** (CSV × 실시간 Analytics per-user 생산성 조인)에 연결. 상단 KPI는 CSV 고정 기간에 바인딩 유지 — CSV는 사전 집계 데이터라 일별 필터링 불가. 서버가 실제 적용한 기간(Analytics 3일 버퍼 반영됨)을 UI에 명시.
- **`useFetch()`에 `refetch()` 추가**: mutation을 발생시키는 UI (첫 이용자: `CsvUploader`)가 full reload 없이 캐시된 GET을 무효화 가능.
- Lambda@Edge용 **빌드 타임 시크릿 주입** `scripts/build-edge.mjs`: `_shared.template.js`에서 Secrets Manager(`ccd/cognito-config`)의 값을 치환하여 `infra/edge/dist/`를 생성. `dist/`는 gitignore.
- Cognito 사용자 관리 runbook: [`docs/runbooks/cognito-users.md`](docs/runbooks/cognito-users.md).

### Changed

- Cost 페이지 상단 데이터(KPI · 제품×모델 테이블 · Top-10)는 CSV의 고정 기간에 바인딩 유지. Economic Productivity 섹션만 기간 선택에 반응.
- `@aws-sdk/client-secrets-manager`를 레포 루트에 추가 — edge bundle 빌드 단계에서 사용.
- `multer` 2.x (2.1.1) 추가 + 명시적 JSON 에러 래퍼: 모든 업로드 실패 경로가 Express 기본 HTML 에러 페이지 대신 구조화된 JSON 반환.

### Fixed

- **WAF `SizeRestrictions_BODY`가 8 KB 초과 POST 전부 차단**: 기본 `AWSManagedRulesCommonRuleSet`의 서브룰이 신규 `/api/cost/upload`를 WAF 403 HTML 페이지(`<html> <h...`)로 조용히 끄고 있었음. `ruleActionOverrides`로 COUNT 다운그레이드 — 규칙은 로그만 남고 BLOCK하지 않음. 나머지 CommonRuleSet 보호(XSS · SQLi · LFI/RFI · bad UA)는 그대로 BLOCK 유지.
- 업로드 sanitizer의 CSV 파일명 정규식이 Anthropic Console 실제 export 형식(`spend-report--YYYY-MM-DD-to-YYYY-MM-DD.csv`, 이중 대시)을 수용하도록 수정 — 기간이 fallback 오늘 날짜로 손실되지 않음.
- 업로드 진입점에 `console.log` 진단 로그 추가 — 실패한 업로드가 컨테이너까지 도달했는지 vs 상류에서 차단됐는지 CloudWatch 로그로 구분 가능.

### Security

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
