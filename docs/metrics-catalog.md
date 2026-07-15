# Metrics Catalog

claude-code-dashboard가 수집/가공하는 **모든 지표**의 단일 참조 문서. 세 개의 1차 데이터 소스 — **Analytics API**, **Compliance API**, **Spend Report CSV** — 와 그로부터 서버가 계산하는 파생 지표를 정리합니다. 대시보드 페이지별 매핑도 함께 수록합니다.

- 1차 소스: [Analytics API](#1-analytics-api) · [Compliance API](#2-compliance-api) · [Spend Report CSV](#3-spend-report-csv)
- 파생: [경제 생산성 · 수락률 · 도입률 등](#4-파생-지표)
- 매핑: [대시보드 페이지별 사용 지표](#5-대시보드-페이지별-매핑)
- 제약: [데이터 한계](#6-데이터-한계-및-해석-주의)

---

## 0. 데이터 소스 한눈에

| 소스 | 키 타입 | 베이스 URL | 갱신 주기 | 접근 경로 |
|---|---|---|---|---|
| **Analytics API — engagement** | Analytics 키 | `/v1/organizations/analytics/{users,summaries,skills,connectors,…}` | 일 단위 집계, 3일 버퍼 | 서버 `/api/analytics/*` → S3-first → 실 API fallback |
| **Analytics API — cost 계열** | 같은 Analytics 키 | `/v1/organizations/analytics/{cost_report,usage_report,user_cost_report,user_usage_report}` | ~4시간 watermark, 버퍼는 부분 데이터, 요청당 31일 상한 | 서버 `/api/cost/{live,users,user-tokens,groups,efficiency}` |
| **Spend Limits API** | 같은 키 (`read:spend_limits`) | `/v1/organizations/spend_limits/effective` | 실시간 (월 단위 누적) | 서버 `/api/cost/spend-limits` |
| **Compliance API** | Compliance 키 (없으면 Analytics 키 폴백) | `/v1/compliance/activities` · `/v1/compliance/groups`(그룹 실명) | 거의 실시간 | 서버 `/api/compliance/activities` · 그룹 이름은 서버 내부 1h 캐시 |
| **Spend Report CSV** (폴백) | 없음 (Console UI에서 수동 export) | `s3://<archive>/spend-reports/*.csv` | 업로드 시점 | 31일 초과 정산·라이브 장애 시에만 — `/api/cost/csv` 및 `/api/cost/efficiency` 폴백 |
| (참고) Admin API | `sk-ant-admin01-…` | `/v1/organizations/usage_report/*` · `/cost_report` | 1시간 지연 | 서버 `/api/admin/*` — **현재 조직은 응답 0** |

---

## 1. Analytics API

Enterprise Analytics API는 5개의 엔드포인트를 제공합니다. 모두 Primary Owner가 발급한 Analytics scope 키로만 접근 가능하며 **토큰·비용·모델 breakdown은 포함하지 않습니다**.

### 1.1 `GET /v1/organizations/analytics/users?date=YYYY-MM-DD`

단일 날짜의 **사용자별** 참여도 + Claude Code 생산성 지표. 페이지네이션 cursor(`next_page`) 존재.

| 필드 경로 | 타입 | 의미 |
|---|---|---|
| `user.id` | string | Anthropic 내부 user ID |
| `user.email_address` | string | 이메일 (UI에서는 `maskEmail()` 적용) |
| `chat_metrics.distinct_conversation_count` | int | Claude.ai 앱에서 시작한 고유 대화 수 |
| `chat_metrics.message_count` | int | 보낸 메시지 총합 |
| `chat_metrics.thinking_message_count` | int | Extended thinking 토글 사용 메시지 |
| `chat_metrics.distinct_projects_used_count` | int | 사용한 Claude 프로젝트 수 |
| `chat_metrics.distinct_projects_created_count` | int | 새로 만든 프로젝트 수 |
| `chat_metrics.distinct_artifacts_created_count` | int | 생성한 Artifact 수 |
| `chat_metrics.distinct_skills_used_count` | int | 사용한 Skills 수 |
| `chat_metrics.connectors_used_count` | int | 커넥터 호출 수 |
| `chat_metrics.distinct_files_uploaded_count` | int | 업로드한 파일 수 |
| `chat_metrics.shared_conversations_viewed_count` | int | 공유 대화 조회 수 |
| `chat_metrics.distinct_shared_artifacts_viewed_count` | int | 공유 Artifact 조회 수 |
| `claude_code_metrics.core_metrics.distinct_session_count` | int | CC 세션 수 |
| `claude_code_metrics.core_metrics.commit_count` | int | Claude Code가 만든 Git commit 수 |
| `claude_code_metrics.core_metrics.pull_request_count` | int | CC가 만든 PR 수 |
| `claude_code_metrics.core_metrics.lines_of_code.added_count` | int | CC가 **추가한** 라인 수 (수락된 diff) |
| `claude_code_metrics.core_metrics.lines_of_code.removed_count` | int | CC가 **삭제한** 라인 수 |
| `claude_code_metrics.tool_actions.{edit,multi_edit,write,notebook_edit}_tool.accepted_count` | int | 도구별 제안 수락 수 |
| `claude_code_metrics.tool_actions.{edit,multi_edit,write,notebook_edit}_tool.rejected_count` | int | 도구별 제안 거절 수 |
| `office_metrics.{excel,powerpoint,word}.{session_count,message_count,skills_used_count,…}` | int | Office 앱별 사용 (현재 조직은 0) |
| `cowork_metrics.{distinct_session_count,action_count,dispatch_turn_count,message_count,…}` | int | Cowork 기능 사용량 |
| `web_search_count` | int | Web search 도구 호출 수 |

### 1.2 `GET /v1/organizations/analytics/summaries?starting_date=&ending_date=`

날짜 범위(최대 31일)의 **조직 단위** 일자별 요약. 서버는 upstream `{summaries: […]}` → `{data: […]}`로 정규화.

| 필드 | 타입 | 의미 |
|---|---|---|
| `starting_at` / `ending_at` | ISO datetime | 일자 경계 (ending은 exclusive) |
| `daily_active_user_count` (DAU) | int | 그 날 활동한 고유 사용자 |
| `weekly_active_user_count` (WAU) | int | 직전 7일 |
| `monthly_active_user_count` (MAU) | int | 직전 30일 |
| `cowork_daily/weekly/monthly_active_user_count` | int | Cowork 전용 DAU/WAU/MAU |
| `assigned_seat_count` | int | 할당된 유상 seat 수 |
| `pending_invite_count` | int | 수락 대기 중 초대 |
| `daily_adoption_rate` | float % | DAU ÷ seats × 100 |
| `weekly_adoption_rate` | float % | WAU ÷ seats × 100 |
| `monthly_adoption_rate` | float % | MAU ÷ seats × 100 |

### 1.3 `GET /v1/organizations/analytics/skills?date=`

스킬별 고유 사용자 수. 날짜 기준.

| 필드 | 의미 |
|---|---|
| `skill_name` | 스킬 식별자 |
| `distinct_user_count` | 해당 날짜에 이 스킬을 쓴 고유 사용자 수 |
| `chat_metrics.distinct_conversation_skill_used_count` | Chat에서 사용된 대화 수 |
| `claude_code_metrics.distinct_session_skill_used_count` | Claude Code에서 사용된 세션 수 |
| `office_metrics.{excel,powerpoint,word}.distinct_session_skill_used_count` | Office 앱별 사용 |
| `cowork_metrics.distinct_session_skill_used_count` | Cowork 사용 |
| `skill_display_name` | 표시용 스킬 이름 (2026-07 신설, 없으면 `skill_name` 사용) |
| `invocation_count` | 스킬 호출 횟수 (2026-07 신설 — 사용당 비용의 분모) |
| `attributed_list_price` | 스킬 사용에 귀속된 list price, 분수 센트 문자열 (2026-07 신설 — /100 = USD) |
| `estimated_overage_spend` | 스킬 관련 초과 지출 추정치 (2026-07 신설) |

> 사용자×스킬 차원은 **존재하지 않음** — 스킬 행에는 actor/email이 없고, 사용자 행에는
> 스킬 이름 없이 표면별 사용 횟수(`cowork/office/science skills_used_count`)만 있다.
> 사용자 상세 패널의 스킬 카드가 조직 기준임을 명시하는 이유.

### 1.4 `GET /v1/organizations/analytics/connectors?date=`

커넥터별 고유 사용자 수. 구조는 1.3과 대칭 (`connector_name`, `…_connector_used_count`).

### 1.5 `GET /v1/organizations/analytics/apps/chat/projects?date=`

Claude.ai Chat 프로젝트별 사용.

| 필드 | 의미 |
|---|---|
| `project_id` / `project_name` | 프로젝트 식별 |
| `distinct_user_count` | 고유 사용자 |
| `distinct_conversation_count` | 고유 대화 |
| `message_count` | 메시지 총합 |
| `created_at` | 프로젝트 생성 시각 |
| `created_by.{id,email_address}` | 생성자 |

### 1.6 Analytics API 제약 (2026-07-04 공식 문서 재확인)

- **첫 이용 가능 날짜**: `2026-01-01` (`starting_at`은 최근 365일 이내여야 함)
- **3일 버퍼 — engagement 계열만**: `users`·`users/range`·`summaries`·`skills`·`connectors`·`projects`는 여전히 `today - 3` 이하만 조회 가능. **cost 계열(`cost_report`·`usage_report`·`user_cost_report`·`user_usage_report`)은 버퍼 구간을 부분 데이터로 제공** — `data_refreshed_at` watermark(약 4시간 주기 갱신, 사용일 기준 약 30일 후 확정) 이후 tail은 미완성 값
- **cost 계열 기간 상한**: 요청당 **최대 31일** ("date range must span at most 31 days") — 초과 선택은 CSV 폴백 경로로 처리
- **summaries 최대 범위**: 31일 (기타 engagement 롤업 모드는 366일)
- **Rate limit**: 60 rpm (**키가 아닌 조직 단위** — 여러 뷰어 동시 접속 시 공유)
- **Bedrock 경유 Claude Code는 미반영**
- **`group_by[]=rbac_group_id` 지원** (2026-07~): cost 계열 4개 엔드포인트 모두. any-membership 방식(여러 그룹 소속 사용자는 각 그룹 행에 전액 계상 → 그룹 합계가 조직 총액 초과 가능), 버킷당 상위 100개 그룹. 간헐적 503("Team membership data is not ready yet") 플랩 있음 — 서버가 last-good 캐시로 흡수. `claude_project_id`는 여전히 400

---

## 2. Compliance API

Enterprise Compliance API는 현재 **단일 엔드포인트**로 노출됩니다: `/v1/compliance/activities`. 감사 이벤트 피드 형태이며 페이지네이션 cursor를 지원합니다. 추론(대화 내용)은 포함하지 않습니다 — 대화 내용은 Console의 "Export Data" 기능으로 별도 export해야 합니다.

### 2.1 `GET /v1/compliance/activities?limit=&page=&before=&after=`

| 필드 | 타입 | 의미 |
|---|---|---|
| `id` | string | `activity_…` ID |
| `type` | string (enum, 35종 이상) | 이벤트 타입 (아래 분류 참고) |
| `created_at` | ISO datetime | 이벤트 발생 시각 |
| `organization_id` / `organization_uuid` | string | 조직 식별 |
| `actor.type` | `user_actor` / `api_actor` | 행위자 유형 |
| `actor.email_address` | string (user_actor 한정) | 사용자 이메일 |
| `actor.user_id` | string | 사용자 ID |
| `actor.api_key_id` | string (api_actor 한정) | API key ID |
| `actor.ip_address` | string | 요청 IP |
| `actor.user_agent` | string | UA 문자열 (Claude.app/Electron 등) |
| `actor.client_platform` | string or null | `iOS` / `Android` 등 |
| 이벤트별 추가 필드 | - | `claude_chat_id`, `claude_project_id`, `previous_role`, `current_role`, `user_email`, `provider`, `file_name`, `request_method`, `status_code`, `url`, … |

### 2.2 이벤트 타입 분류 (서버가 분류하는 방식)

`src/pages/Compliance.tsx`의 `RISK_TYPES` / `LOGIN_TYPES` 세트 기준.

| 분류 | 예시 이벤트 타입 |
|---|---|
| **Login (로그인)** | `user_signed_in_sso` · `user_signed_in_google` · `user_signed_in_apple` · `user_signed_out` · `social_login_succeeded` · `user_logged_out` |
| **Risk (고위험)** | `claude_user_role_updated` · `org_user_invite_sent` · `org_user_invite_deleted` · `org_user_deleted` · `org_sso_toggled` · `org_sso_connection_deleted` · `org_data_export_started` · `org_data_export_completed` · `org_domain_verified` · `project_deleted` |
| **Activity (일반)** | `claude_chat_viewed` · `claude_chat_created` · `claude_file_viewed` · `claude_file_uploaded` · `compliance_api_accessed` · `project_created` · `project_renamed` · `project_document_created` · `project_document_deleted` · `conversation_created` · `conversation_deleted` · `conversation_renamed` · `user_name_changed` · `user_requested_magic_link` · `user_attempted_magic_link_verification` · `user_sent_phone_code` · `user_verified_phone_code` · `org_user_invite_accepted` · `org_user_invite_rejected` · `org_user_invite_re_sent` · `org_sso_add_initiated` · `org_sso_connection_activated` · `org_sso_connection_deactivated` · `org_jit_toggled` · `org_domain_add_initiated` |

### 2.3 파생 Compliance 지표 (서버 집계)

대시보드는 `/api/compliance/activities?max=500&pages=5` 응답에서 다음을 클라이언트 집계합니다:

- **Event type histogram (Top 12)**: 이벤트 타입별 개수
- **Top actors (Top 10)**: 행위자별 이벤트 수 (마스킹된 이메일 기준)
- **Daily events / Risk events**: 일자별 전체/위험 이벤트 count
- **Unique actors**: 기간 내 고유 actor 수
- **Risk count / Login count / API-call count**: 분류별 집계

### 2.4 Compliance API 제약

- **추론 활동 미포함** — 대화 내용은 별도 Data Export
- Rate limit은 문서화되어 있지 않음 (Analytics와 동일하다고 가정)
- 페이지네이션 필요 (대용량 조직은 수천~수만 이벤트/일)

---

## 3. Spend Report CSV

Claude Console **Settings → Analytics → Spend → "Export Spend Report"** 에서 사용자가 수동으로 CSV를 다운로드 후 S3 `spend-reports/` 접두사에 업로드합니다. 파일명은 `spend-report-<orgUuid>-<start>-to-<end>.csv` 규칙.

### 3.1 CSV 컬럼 스펙

| 컬럼 | 타입 | 의미 |
|---|---|---|
| `user_email` | string | 사용자 이메일 |
| `account_uuid` | string | 조직 내부 account UUID |
| `product` | string | `Claude Code` / `Chat` / `Cowork` / `Browser Extension` / `Excel` / `PowerPoint` / `Word` 중 하나 |
| `model` | string | `claude_opus_4_7` / `claude_opus_4_6` / `claude_sonnet_4_6` / `claude_haiku_4_5_20251001` 등 |
| `total_requests` | int | 기간 누계 요청 수 |
| `total_prompt_tokens` | int | 기간 누계 입력 토큰 수 |
| `total_completion_tokens` | int | 기간 누계 출력 토큰 수 |
| `total_net_spend_usd` | float | 할인 적용 후 실 지출 (USD) |
| `total_gross_spend_usd` | float | 할인 적용 전 지출 (USD) |

**중요**: 행 단위는 **user × product × model**. 각 행은 기간 전체 누계이며, **일자별 breakdown은 없습니다**. 일자별 시계열을 원하면 하루 단위 커스텀 기간으로 CSV를 여러 번 export해서 쌓아야 합니다.

### 3.2 `/api/cost/csv` 파생 집계

서버가 CSV를 읽어 다음 aggregation을 반환:

- **Totals**: `net_spend_usd`, `gross_spend_usd`, `prompt_tokens`, `completion_tokens`, `requests`
- **Distinct counts**: `distinct_users`, `distinct_models`, `distinct_products`
- 클라이언트(`src/pages/Cost.tsx`)에서 재집계:
  - 사용자별 합계 (스펜드/토큰/요청/사용 product/model 수)
  - 모델별 합계 + 점유율(share)
  - 제품별 합계 + 점유율
  - product × model 매트릭스 (stacked bar)
  - Top 10 (total tokens / input / output / spend)

### 3.3 CSV 제약

- **일자별 breakdown 부재** — 시계열 불가
- **수동 업로드** — CI/CD로 자동화 안 됨 (Console이 Export API를 노출하지 않음)
- Bedrock 경유 Claude Code 사용은 **미포함**. AWS Bedrock invocation logs + Cost Explorer 별도 확인 필요

---

## 4. 파생 지표

### 4.1 Tool Acceptance Rate (Analytics)

```
acceptance_rate = sum(accepted_count) / sum(accepted_count + rejected_count)
```

- 도구 4종(`edit`, `multi_edit`, `write`, `notebook_edit`)을 합쳐 **사용자/조직 수준** 으로 집계.
- 분모가 0이면 `null` (UI에서 "—"로 표시).
- 의미: AI 제안 품질 × 사용자 신뢰도 결합 지표.

### 4.2 Adoption Rate (Analytics summaries — API 제공값)

- `daily_adoption_rate` = DAU ÷ `assigned_seat_count` × 100
- `weekly_adoption_rate`, `monthly_adoption_rate` 동일 구조.
- Analytics API가 **계산해서 응답**하므로 서버는 패스스루.

### 4.3 Productivity Score (Organization — `src/pages/Productivity.tsx`)

조직 단위 복합 점수 (0–100):

```
score = 0.30 · min(1, LOC_per_dev_per_day / 200)
      + 0.25 · org_acceptance_rate
      + 0.20 · min(1, commits_per_dev_per_day / 1.5)
      + 0.15 · min(1, avg_active_share / 0.5)
      + 0.10 · min(1, sessions_per_dev_per_day / 3)
```

- `dev`는 **활성 개발자** (해당 날짜에 `distinct_session_count > 0`)
- `avg_active_share` = 평균 활성 개발자 ÷ 전체 유저 수

### 4.4 Economic Productivity Score (Spend × Analytics — `src/pages/Cost.tsx` 하단)

**CSV의 사용자별 지출**과 **Analytics의 사용자별 산출**을 조인한 뒤 유저 단위 점수 (0–100):

```
# Output 점수 (산출 가치)
output_score = LOC_added + 100·commits + 1000·PRs + 0.5·tool_accepted

# 최종 점수
score = 0.35 · N(output_per_dollar)           ← output_score ÷ spend_usd
      + 0.20 · tool_acceptance_rate
      + 0.20 · N(1 / tokens_per_LOC)          ← 토큰 효율
      + 0.15 · N(commits_per_active_day / 1.5)
      + 0.10 · N(prs_per_active_day   / 0.5)
```

- `N(x)` = 조직 내 최대값 대비 정규화 후 [0,1] 클램프.
- 단위 비용 지표도 함께 계산: `cost_per_LOC`, `cost_per_commit`, `cost_per_PR`, `cost_per_session`, `output_per_dollar`, `tokens_per_LOC`.

### 4.5 User Activity Score (Analytics only — `src/pages/UserProductivity.tsx`)

UI 표기: **"활동 점수(Activity Score)"** (2026-07-12 개칭 — §4.4 경제 생산성 점수와의 혼동 방지; 화면에 "(비용 미반영)"과 비용 메뉴 상호 참조 명시). CSV 없이 Analytics 데이터만으로 계산 (기간 기반):

```
score = 0.30 · N(LOC_added_per_day / 200)
      + 0.25 · user_acceptance_rate
      + 0.20 · N(commits_per_day / 1.5)
      + 0.15 · N(active_day_share / 0.4)
      + 0.10 · N(sessions_per_day / 3)
```

- CSV 없어도 동작 → Analytics 키만 있으면 생산성 랭킹 가능.
- Cost 효율 차원은 배제 (경제 생산성 페이지가 별도로 제공).

### 4.6 Risk Density (Compliance)

```
risk_density = risk_events / total_events
```

- 기간 내 전체 이벤트 중 고위험 이벤트(역할 변경·삭제·데이터 export·SSO 토글) 비율.
- 대시보드는 단순 카운트로 표시하지만 concept 지표로 유용.

### 4.8 Actions per Prompt (Agentic 페이지 — `src/pages/Agentic.tsx`)

```
actions_per_prompt = sum(cowork_metrics.action_count) / sum(cowork_metrics.message_count)
```

- **Cowork 전용** — action_count와 message_count(프롬프트)를 모두 제공하는 유일한 표면.
- 높을수록 팀이 Claude에 더 많이 위임. KPI = 기간 합계 비율(ratio-of-sums), 일별 추이·사용자별 테이블 동일 정의.
- 그룹 스코프 적용: 선택 그룹 기준으로 재계산 (지출 섹션만 전사 기준).

### 4.9 CC Actions per Session (Agentic 페이지 보조 지표)

```
cc_actions_per_session = sum(accepted_count 4개 도구) / sum(distinct_session_count)
```

- Claude Code에는 프롬프트 수 필드가 없어 세션당 **수행된**(accepted만) 작업 수를 위임도 프록시로 사용.
- rejected는 제외 — 실행되지 않은 제안은 "수행한 작업"이 아님 (Cowork action_count 의미론과 정합).

### 4.10 Skill Cost per Use (사용자 상세 패널 스킬 카드)

```
cost_per_use = sum(attributed_list_price)/100 / sum(invocation_count)   # 기간 합산, 스킬별
```

- 조직 전체 기준 (사용자×스킬 차원 부재). 아카이브(구스키마) 일자는 invocation_count가 없어
  표면별 skill-used 카운트로 폴백 — 카드 캡션에 실제 집계 창을 표기.

### 4.11 사용자별 제품/모델 지출 + 이전 기간 대비 (사용자 상세 패널)

- `user_cost_report × product` / `× model` (라이브, 페이지 창 ≤31일).
- 점유율 = 해당 제품(모델) 지출 ÷ 사용자 기간 총지출.
- 이전 기간 Δ = 동일 길이 직전 창과 비교 — `prevEnd = start−1일`, `prevStart = start−days일`.
  이전 창 조회 실패 시 "신규"가 아니라 "—"로 표시 (비교 불가와 신규를 구분).

### 4.12 Cache Efficiency Hint (Server Proxy)

`/api/analytics/users/range` 응답의 `cache` 객체:

```json
{"s3_hits": 14, "live_calls": 0}
```

- 14일 요청 중 14일이 S3 archive에서 즉시 응답.
- `live_calls`가 크면 아카이브가 최신이 아니라는 신호 → Collector 재실행 권장.

### 4.13 사용자별 Cache Hit Rate (`/api/cost/user-tokens` — user_usage_report)

```
cache_hit_rate = cache_read_input_tokens / (uncached + cache_read + cache_creation_1h + cache_creation_5m)
```

- 서버(`userUsageToUsers`)가 사용자별 토큰 계층(`uncached_tokens`, `cache_read_tokens`, `cache_creation_tokens`)과 함께 산출. 입력 토큰 0이면 `null`.
- Cost 페이지의 조직 `token_tiers.cache_hit_rate`와 동일 기준(분모 = 전체 입력)이라 조직↔사용자 비교 가능.
- 표시 위치: 사용자 상세 패널 "캐시 효율" 카드(적중률 + 계층 타일), Users 테이블 "캐시 적중" 컬럼(엔게이지먼트 컬럼과 동일하게 today−3 종료로 기간 정렬; 31일 초과 창은 '—').

---

## 5. 대시보드 페이지별 매핑

어떤 페이지가 어떤 소스·지표를 쓰는지:

| 페이지 | 1차 소스 | 표시 지표 |
|---|---|---|
| **Overview** | Analytics `/summaries` + `/users` | DAU/WAU/MAU, adoption_rate, 총 LOC, CC 세션, 커밋/PR, 도구 수락률 |
| **Users** | Analytics `/users/range` + `/api/cost/user-tokens` | 사용자별 메시지/세션/LOC/커밋/PR/Cowork(세션·작업)/Design(세션)/수락률/캐시 적중(§4.13), 행 클릭 시 기간 Drill-down(제품·모델 지출, 스킬, 캐시 효율 카드) |
| **User Productivity** | Analytics `/users/range` | 활동 점수 (§4.5, 비용 미반영), 기간별 랭킹 |
| **Claude Chat** | Analytics `/users/range` (`chat_metrics`) | 활성 사용자·메시지(확장 사고)·대화·아티팩트·프로젝트·스킬/커넥터 사용·웹 검색, 일별 추이 2종, 사용자별 테이블 |
| **Trends** | Analytics `/summaries` | DAU/WAU/MAU 라인, seat vs MAU, daily adoption_rate |
| **Claude Code** | Analytics `/users` | LOC/commits/PRs 총합, 도구별 수락 스택, 수락률 radial, Top contributors + 사용자별 정렬 테이블(세션·LOC·커밋·PR·수락률) |
| **Productivity** | Analytics `/users/range` | Organization Productivity Score (§4.3), LOC/commits/PRs/수락률 시계열 |
| **Adoption** | Analytics `/skills` + `/connectors` + `/apps/chat/projects` | 스킬/커넥터별 사용자, Top 프로젝트 메시지 수 |
| **Cost** | Analytics `cost_report`+`usage_report`(헤드라인) · `user_cost_report`(사용자별 지출·모델별) · `user_usage_report`(사용자별 토큰) · `cost_report×rbac_group_id`(그룹별) · Spend Limits API(월 한도/누적) · CSV는 31일 초과·장애 폴백 · `/users/range`(효율 조인) | Total spend, 모델별 점유(pie), product × model 스택, **그룹별 비용(실명)**, Top 10 (total/input/output/spend — 선택 기간 라이브), **Spend Limits 소진율**, **경제 생산성 점수** (§4.4) |
| **Audit** | Compliance `/activities` | KPI(total/risk/login/actors), 이벤트 타입/행위자 Top, 일자별 추이, 최근 이벤트 피드 |
| **Analyze** | 위 모두 (snapshot) + (SQL 모드) Athena 아카이브 | Bedrock Sonnet 4.6 자연어 분석 (SSE 스트리밍) |
| **Archive** | S3 + Glue + Athena | 임의 SELECT SQL — NDJSON 파티션 조회 |

---

## 6. 데이터 한계 및 해석 주의

### 6.1 Analytics API
- **Bedrock 경유 Claude Code는 0으로 집계**됨. 실제 조직 사용량과 API 반영값이 불일치할 수 있음.
- **LOC `added_count`는 순증가가 아님** — 세션 내 작성/삭제 반복이 있으면 누적됨. 순 변경은 `added − removed`로도 완벽하지 않음 (같은 라인을 두 번 썼다 지운 경우 포함).
- **3일 버퍼** 내 날짜는 데이터 없음 또는 부분 집계.

### 6.2 Compliance API
- **대화 내용(inference) 미포함** — Console "Export Data" 기능 별도.
- **인증 이벤트는 user_actor**, **API 호출은 api_actor** — 두 집합은 서로 독립.
- IP 주소/UA는 PII. 대시보드는 UI에 표시는 하되 LLM 프롬프트 전달 시 마스킹 권장.

### 6.3 Spend Report CSV
- **일자별 breakdown 없음**. 시계열을 원하면 하루 단위 export를 여러 번 해서 이름에 날짜 인코딩 + S3에 파티션화.
- Bedrock/Vertex 경유 사용은 미포함.
- `total_net_spend_usd ≠ total_gross_spend_usd`일 때는 기업 계약 할인 적용 상태.
- 서버는 파일명 패턴 `spend-report-<uuid>-<start>-to-<end>.csv`에서 기간을 파싱.

### 6.4 조인 무결성
- **이메일을 조인 키로 사용**. 대소문자 변이가 있으면 미스매치.
- CSV에는 있고 Analytics에는 없는 사용자(또는 반대)는 경제 생산성 응답에 포함되지만 절반은 0으로 표시됨.
- 기간이 다르면(예: CSV 21일 vs Analytics 14일) 산출/지출이 불일치. 서버는 CSV 기간을 Analytics ending date buffer(`today − 3`)로 clamp.

### 6.5 샘플 크기
- 조직이 10명 수준이면 단일 이상치 사용자가 전체 분포를 지배. 점수 해석 시 **절대값이 아니라 조직 내 상대 순위**로 해석 권장.

---

## 7. 확장 아이디어 (현재 미구현)

- **Retention cohort** — Analytics `/users/range`에서 사용자의 첫 활동일 기준 N일차 잔존 계산.
- **Tool mastery trajectory** — 시간에 따른 개별 사용자의 수락률 변화.
- **Spend anomaly detection** — 일일 CSV가 누적되면 z-score 기반 급증 감지.
- **Compliance correlation** — `risk_events` 급증 시점과 배포/조직 변경 시점 상관.
- **Cross-product cost attribution** — CSV의 `product` 기준 팀/부서 매핑 테이블 조인.
- **Session density** — active_days ÷ 기간 × sessions_per_day로 몰입도 지표.

---

## 8. 보안 노트 — Athena 쿼리 sanitizer

`/api/archive/query`와 `/api/analyze` (SQL 모드)는 모두 **Bedrock이 생성했든 사용자가 입력했든** 동일한 `sanitizeAthenaQuery()`를 거칩니다 (`server/aws.js`). 방어 원칙:

1. **Multi-statement 차단** — 주석을 먼저 스트립하고 남은 `;`가 있으면 reject. `SELECT 1 -- ; DROP ... ; DROP TABLE x`처럼 주석 뒤로 진짜 세미콜론을 숨기는 공격을 잡습니다.
2. **Allowlist** — `SELECT` 또는 `WITH`로만 시작 허용. `DESCRIBE`, `SHOW`, `INSERT` 등은 거부.
3. **Forbidden keyword** — `INSERT / UPDATE / DELETE / DROP / ALTER / CREATE / TRUNCATE / GRANT / REVOKE / MERGE / CALL / EXECUTE / MSCK / REPAIR / USE / COPY / UNLOAD / LOAD DATA / INTO OUTFILE` 가 본문 어디에든 있으면 거부.
4. **Table allowlist** — 모든 `FROM/JOIN` 대상이 다음 테이블 중 하나여야 합니다:
   - `claude_code_analytics` · `summaries_daily` · `skills_daily` · `connectors_daily` · `projects_daily` · `compliance_daily`
   - CTE 별칭(`WITH name AS (...)`)은 자동으로 허용 목록에 추가됨.
   - 서브쿼리(`FROM (SELECT ...)`) 내부의 `FROM`도 `matchAll`로 재귀적으로 검증.
5. **IAM은 추가 방어선** — task 롤은 `ccd` 워크그룹과 `claude_code_analytics` 데이터베이스에만 접근 허용. IAM만으로 의존하지 않고, 쿼리 단계에서 선제적으로 차단.

테스트 커버리지는 `tests/server/test-athena-sanitizer.mjs` (18 케이스 — 합법 6, 인젝션 시도 12) 참고. `bash tests/run-all.sh`로 실행됩니다.

---

*이 문서는 `/sync-docs` 스킬의 대상입니다. 페이지 로직이 변경되면 §5 매핑과 §4 파생 공식을 함께 업데이트하세요.*
