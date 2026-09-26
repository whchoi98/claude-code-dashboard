# ADR-0022: Time-windowed Compliance walks and bounded daily archives

Date: 2026-09-26

Status: Accepted — amends [ADR-0004](0004-compliance-pagination-prewarm.md), [ADR-0016](0016-audit-response-cache-partial-contract.md) and [ADR-0017](0017-compliance-s3-archival.md)

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Context

ADR-0004 and ADR-0017 were designed on the premise that `GET /v1/compliance/activities` had no timestamp filter, so the live audit page and the daily archive walked the whole feed backward from "now" in pages of 100. Every request is itself a `compliance_api_accessed` event in the organization's feed, and the dashboard's own reads had become the majority of that feed. A custom window in the past walked from the newest event, reached the 2000-event cap first, and showed no events.

The current reference documents `created_at.{gte,gt,lte,lt}` (RFC 3339), `limit` up to 5000, and an opaque cursor: pass the response's `last_id` as the next `after_id`. The server-side time filter was verified live on 2026-08-19. On 2026-09-24 the feed also stopped returning file, project-document and artifact names, including on older activities.

### Decision

- **Live walk** (`server/compliance.js`, `walkActivities`): upstream pages of 1000 (`AUDIT_UPSTREAM_PAGE`) and the documented `last_id` cursor, with a fallback to the last event id. A window ending before today (UTC) adds `created_at.gte`/`lt`. Windows ending today, which covers every preset, stay unfiltered, so the four preset walks send identical parameters and share one page chain through the upstream page cache. The prewarm and the route use the same `limit`, so the `auditKey` formula still matches between them. Parameters stay fixed for the whole walk because the cursor is bound to its query.
- **Daily archive** (`collector/handler.js`, `collectComplianceDay`): each UTC day is its own bounded query (`limit=2000`). A day counts as complete only on an empty page that doesn't claim `has_more: true`, or on a short page (fewer events than requested) with an explicit `has_more: false`. A full page whose flag says false, or any page without the flag, is confirmed with one more request. An incomplete day, an empty page that still claims more data, or a zero-event day is never written, because the same-key PutObject would shrink a stored partition.
- **Name preservation**: a partition is last written two days after its date, so days up to 2026-09-22 may still hold names. The exact cut-over time on 09-24 is unknown. The collector skips days before 2026-09-24 unless the payload sets `allowRedactedOverwrite: true`. Normal runs only touch T−1 and T−2.
- The 00:30 UTC compliance-only schedule is kept. The bounded query no longer depends on it, but moving the rule would be churn with no benefit.
- **Archived names are admin-only** (decided 2026-09-26): only a verified `unmasked` session (ADR-0020's administrators) reads `compliance_daily(_org2)` directly. Every other session's SQL is rewritten, token by token on the text that runs, to Glue views `compliance_daily_redacted(_org2)`, which set `payload` `filename`/`title` and the published-artifact `description` to null. The S3 data is not modified. A bulk rewrite of the archived partitions was considered and not done, so admins keep the names and nothing has to be migrated.

### Consequences

- A cold preset walk goes from 20 upstream requests to 2. The four presets share them, so each prewarm cycle drops from about 20 requests to about 2, and the dashboard's own audit noise falls by the same factor.
- An archive run goes from about 110–150 requests to about 3 per day per organization.
- Past custom windows now return their own events. ADR-0016's walk budgets and `partial` contract are unchanged and remain the safety net.
- Pages are larger (roughly 1–3 MB), so the per-page abort is 30 s in both the live walk and the collector. The live walk still stays inside ADR-0016's 45 s foreground budget.
- Archived partitions from before 2026-09-24 keep file and artifact names that the live feed no longer returns. Only administrators see them. `/api/archive/query` and the chatbot's `run_athena_sql` route every other session through the redacted views. The collector's redaction guard keeps those partitions from being overwritten by a re-archive.

### Evidence

Implementation: [walk helpers](../../server/compliance.js), [server walk](../../server/index.js), [collector archiver](../../collector/handler.js).

Verification: [walk helper tests](../../tests/server/test-compliance-walk.mjs), [collector day tests](../../tests/server/test-collector-compliance.mjs).

<a id="korean"></a>
## 한국어

### 배경

ADR-0004와 ADR-0017은 `GET /v1/compliance/activities`에 시간 필터가 없다는 전제로 설계되었습니다. 그래서 감사 화면과 일일 아카이브가 모두 "지금"부터 100건 단위로 피드를 거슬러 올라갔습니다.

- 요청 하나하나가 조직 피드에 `compliance_api_accessed` 이벤트로 남고, 대시보드 자신의 조회가 피드의 대부분을 차지하게 되었습니다.
- 과거 날짜의 사용자 지정 기간은 최신 이벤트부터 걷다가 2000건 한도에 먼저 닿아 0건으로 표시되었습니다.

현재 레퍼런스에는 다음이 문서화되어 있습니다.

- `created_at.{gte,gt,lte,lt}`(RFC 3339) 필터. 서버측 시간 필터는 2026-08-19에 라이브로 확인했습니다.
- 최대 5000건의 `limit`
- 불투명 커서: 응답의 `last_id`를 다음 `after_id`로 넘깁니다.

또한 2026-09-24부터 피드는 과거 활동을 포함해 파일·프로젝트 문서·아티팩트 이름을 제공하지 않습니다.

### 결정

- **라이브 워크** (`server/compliance.js`, `walkActivities`)
  - 업스트림 페이지 크기는 1000(`AUDIT_UPSTREAM_PAGE`)이고, 커서는 문서대로 `last_id`를 쓰되 없으면 마지막 이벤트 id로 대체합니다.
  - 오늘(UTC) 이전에 끝나는 기간에만 `created_at.gte`/`lt`를 붙입니다.
  - 프리셋은 모두 오늘에서 끝나므로 필터를 붙이지 않습니다. 그래야 네 프리셋 워크가 같은 파라미터로 페이지 체인을 공유합니다.
  - prewarm과 라우트가 같은 `limit`을 쓰므로 `auditKey` 공식은 그대로 일치합니다.
  - 커서가 해당 쿼리에 묶여 있으므로, 한 워크 안에서는 파라미터를 바꾸지 않습니다.
- **일일 아카이브** (`collector/handler.js`, `collectComplianceDay`)
  - UTC 하루씩 경계가 있는 쿼리(`limit=2000`)로 받습니다.
  - 다음 두 경우에만 그날을 완결로 봅니다. `has_more: true`가 아닌 빈 페이지, 또는 `has_more: false`가 명시된 짧은 페이지(요청 수보다 적게 온 페이지)입니다. 가득 찬 페이지에 false가 붙었거나 플래그가 없는 페이지는 한 번 더 요청해 확인합니다.
  - 다음 경우에는 쓰지 않습니다. 같은 키 PutObject가 저장된 파티션을 줄여 버리기 때문입니다.
    - 미완결인 날
    - 데이터가 더 있다면서 빈 페이지가 온 경우
    - 이벤트가 0건인 날
- **이름 보존**
  - 파티션은 해당 날짜 이틀 뒤에 마지막으로 쓰이므로, 2026-09-22까지의 파티션에는 이름이 남아 있을 수 있습니다(09-24 적용 시각은 알 수 없습니다).
  - 그래서 payload에 `allowRedactedOverwrite: true`가 없으면 2026-09-24 이전 날짜를 건너뜁니다.
  - 정기 실행은 T−1과 T−2만 다룹니다.
- 00:30 UTC 스케줄은 유지합니다. 새 방식은 이 스케줄에 의존하지 않지만, 옮겨서 얻는 이점이 없습니다.
- **보관된 이름은 관리자 전용**(2026-09-26 결정)
  - `compliance_daily(_org2)`를 직접 읽는 것은 검증된 `unmasked` 세션(ADR-0020의 관리자)뿐입니다.
  - 그 밖의 세션이 보낸 SQL은 실행되는 텍스트 전체에서 토큰 단위로 `compliance_daily_redacted(_org2)` Glue 뷰로 바뀝니다. 이 뷰는 `payload`의 `filename`/`title`과 게시된 아티팩트의 `description`을 null로 바꿉니다.
  - S3 데이터는 수정하지 않았습니다. 보관 파티션을 일괄로 다시 쓰는 방안도 검토했지만 하지 않았습니다. 이 방식이면 관리자는 이름을 그대로 보고, 옮길 데이터도 없습니다.

### 결과

- **라이브 워크**: 프리셋의 콜드 워크가 20요청에서 2요청으로 줄었습니다. 네 프리셋이 이 요청을 공유하므로 prewarm 한 주기도 약 20요청에서 약 2요청이 되고, 셀프 감사 노이즈도 같은 비율로 줄어듭니다.
- **아카이브**: 한 번 실행할 때 약 110~150요청이던 것이 org별 하루 약 3요청으로 줄었습니다.
- **과거 기간 조회**: 사용자 지정 과거 기간이 해당 날짜의 이벤트를 보여 줍니다. ADR-0016의 워크 예산과 `partial` 계약은 그대로 안전장치로 남습니다.
- **페이지 크기**: 페이지가 약 1~3MB로 커져서 라이브 워크와 collector 모두 페이지당 타임아웃을 30초로 늘렸습니다. 라이브 워크는 여전히 ADR-0016의 45초 포그라운드 예산 안에 있습니다.
- **보관된 이름**: 2026-09-24 이전 파티션에는 라이브 피드가 더 이상 주지 않는 파일·아티팩트 이름이 남아 있고, 관리자만 볼 수 있습니다. `/api/archive/query`와 챗봇의 `run_athena_sql`은 관리자가 아닌 세션을 가림 처리된 뷰로 보냅니다. collector의 보호 장치는 재아카이브가 이 파티션을 덮어쓰지 못하게 막습니다.

### 근거

구현: [워크 헬퍼](../../server/compliance.js), [서버 워크](../../server/index.js), [collector 아카이버](../../collector/handler.js).

검증: [워크 헬퍼 테스트](../../tests/server/test-compliance-walk.mjs), [collector 일자 테스트](../../tests/server/test-collector-compliance.mjs).
