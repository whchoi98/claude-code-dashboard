# Documentation

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

| Document | Purpose |
|---|---|
| [Project overview](../README.md) | Features, installation, configuration and validation commands |
| [Onboarding](onboarding.md) | Local setup, browser tests and deployment preparation |
| [Architecture](architecture.md) | Runtime components, data flow, AWS stacks and design decisions |
| [API reference](api-reference.md) | Express routes, organization scope, response fields and SSE events |
| [Metrics catalog](metrics-catalog.md) | Dashboard metric definitions and data sources |
| [Anthropic field notes](anthropic-api-fields.md) | Recorded upstream field mappings |
| [Release history](../CHANGELOG.md) | Versioned English and Korean release notes |
| [Project improvement review](project-review-2026-09-21.md) | Findings, usability changes and dated verification evidence |
| [2026-09-21 deployment](deployments/2026-09-21.md) | Production image digest, task revision and deployment verification |

Recent decisions: [organization scope](decisions/0018-multi-org-support.md), [long date ranges](decisions/0019-over-31-day-windows.md), [identity-aware masking](decisions/0020-identity-aware-masking.md), [frontend recovery and exports](decisions/0021-frontend-recovery-and-exports.md).

Operational runbooks: [ALB listener](runbooks/alb-listener-drift.md), [Cognito users](runbooks/cognito-users.md), [group cost availability](runbooks/rbac-group-cost-503-flap.md), [Spend Limits scope](runbooks/spend-limits-scope-missing.md).

Contributor context: [AGENTS.md](../AGENTS.md), [project guide](../CLAUDE.md), [frontend](../src/CLAUDE.md), [server](../server/CLAUDE.md), [collector](../collector/CLAUDE.md), [infrastructure](../infra/CLAUDE.md).

<a id="korean"></a>
## 한국어

| 문서 | 용도 |
|---|---|
| [프로젝트 개요](../README.ko.md) | 기능, 설치, 설정, 검증 명령 |
| [온보딩](onboarding.md) | 로컬 실행, 브라우저 테스트, 배포 준비 |
| [아키텍처](architecture.md) | 실행 구성, 데이터 흐름, AWS 스택과 설계 결정 |
| [API 참조](api-reference.md) | Express 경로, 조직 구분, 응답 필드, SSE 이벤트 |
| [지표 목록](metrics-catalog.md) | 대시보드 지표 정의와 데이터 출처 |
| [Anthropic 필드 기록](anthropic-api-fields.md) | 기록된 업스트림 필드 매핑 |
| [릴리스 이력](../CHANGELOG.md) | 버전별 영문·한글 변경 내역 |
| [프로젝트 개선 기록](project-review-2026-09-21.md) | 분석 결과, 편의 기능, 날짜별 검증 근거 |
| [2026-09-21 배포 기록](deployments/2026-09-21.md) | 운영 이미지 다이제스트, 태스크 리비전, 배포 검증 |

최근 설계 결정: [조직 구분](decisions/0018-multi-org-support.md), [긴 조회 기간](decisions/0019-over-31-day-windows.md), [로그인 사용자별 마스킹](decisions/0020-identity-aware-masking.md), [프런트엔드 복구와 내보내기](decisions/0021-frontend-recovery-and-exports.md).

운영 절차: [ALB 리스너](runbooks/alb-listener-drift.md), [Cognito 사용자](runbooks/cognito-users.md), [그룹 비용 가용성](runbooks/rbac-group-cost-503-flap.md), [Spend Limits 권한](runbooks/spend-limits-scope-missing.md).

작업 지침: [AGENTS.md](../AGENTS.md), [프로젝트](../CLAUDE.md), [프런트엔드](../src/CLAUDE.md), [서버](../server/CLAUDE.md), [수집기](../collector/CLAUDE.md), [인프라](../infra/CLAUDE.md).
