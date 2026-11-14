# ADR-0023: Read cost and usage from the Usage and Cost Analytics API, with the legacy reports as fallback

Date: 2026-11-14

Status: Accepted — amends [ADR-0003](0003-hybrid-live-cost.md) and [ADR-0019](0019-over-31-day-windows.md)

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Context

On 2026-10-29 Anthropic launched the Usage and Cost Analytics API in beta (`GET /v1/organizations/analytics/usage` and `/cost`, header `anthropic-beta: analytics-usage-cost-2026-08-24`). The same release note marks the four report endpoints this dashboard's cost features are built on as legacy: `cost_report`, `usage_report`, `user_cost_report` and `user_usage_report`. They remain supported and no removal date is published.

The new endpoints take the same key, the same 31-day span and 365-day lookback, the same `data_refreshed_at` watermark and the same 60 rpm organization limit. What differs is the response. The legacy reports return time buckets, each with a `results[]` list; the new API returns rows, each `{ starting_at, ending_at, group, cost | usage }`, and it emits no row for a bucket without data. Other differences that touch this code:

- `bucket_width` is `time_bucket_width`, has no default, and requires `ending_at`.
- `limit` counts rows (1–1000), not buckets.
- The per-user reports become `group_by[]=actor` with `actor_types[]=user_actor`.
- Claude Tag's product value is `claude_tag`; the legacy reports spell it `claude-tag`.
- `group_by[]=cost_type` lists a fourth type, `session_usage`.
- Every group in every bucket is returned. The legacy reports cap each bucket at its top 100 groups.

A paced live probe on 2026-11-13 ran each query the dashboard sends against both families and fed both through the existing reshape functions. Organization totals matched to six decimals, the per-user rows were identical (plain, by model, by product, by RBAC group, and tokens), the today-only window was accepted with tomorrow as `ending_at`, and `data_refreshed_at` was the same. The RBAC group dimension was slow on both families (1.4–27 s for the same query on different calls), so its latency comes from the shared membership backend and is not specific to either API.

### Decision

- **The new API is the default for every cost read.** `fetchCostSummary`, `fetchUserReport` and `fetchGroupCost` in `server/aws.js` call it first.
- **An adapter converts its rows back into the legacy body shapes** (`server/cost-api.js`): `rowsToDailyBuckets` rebuilds one bucket per UTC day and zero-fills days without rows, and `flattenV2Row` lifts `group` and `cost`/`usage` to the legacy row. The reshapers, the ≤31-day chunking of ADR-0019, the TTL caches, the keep-warm loop and the routes are unchanged, and so are the response shapes the frontend reads.
- **A rejected call falls back to the legacy report once.** Only 400, 403 and 404 trigger it: they say the endpoint or the query is not served. 429, 5xx and network errors do not, because both families share one rate budget and one backend, and a second 12–30 s RBAC walk would cross the CloudFront 60 s origin timeout. The existing stale and last-good paths cover those.
- **After a fallback, the organization stays on legacy for 30 minutes**, unless the legacy report rejected the call the same way (400, 403 or 404). A query both families reject is the query's fault and leaves the new API on. A legacy call that only failed transiently did not reject the query, so the organization still moves to legacy; otherwise every call would pay for both families until legacy recovered. The legacy error is the one the route sees.
- **`CCD_COST_API=legacy` pins the legacy reports** without a deploy of new code.
- **Claude Tag keeps the legacy product id `claude-tag`** inside the dashboard, so a product never splits into two series across the two families, cached windows or CSV history.
- **`session_usage` is hidden while it is $0.** It is Claude Managed Agents session time and does not apply to a Claude Enterprise organization.
- `/api/cost/live` reports which family served it in `cost_api` (`v2` or `legacy`).

What this change does not do: it adds no new dimension or view. Grouping by `actor_type`, asking for user × product × model in one request, ranking with `order_by`, and reading both organizations with one parent-organization key (`organization_ids[]`) are possible follow-ups.

### Consequences

- The dashboard depends on a beta header for its primary cost path. If Anthropic renames or withdraws it, the first call of each window costs one extra request and the organization runs on legacy for 30 minutes at a time until the code is updated.
- Upstream request counts are unchanged in the normal case. A ≤31-day chunk is one page while it holds at most 1,000 rows (7 days of product × model were 105 rows for the primary organization on 2026-11-13, so about 465 for 31 days); a busier organization adds pages, which the existing pagination loop follows (`?page=`, verified live).
- Buckets are no longer capped at 100 groups.
- The legacy code paths stay until Anthropic announces their removal. Removing them then is a deletion in three functions.
- Row order inside a day differs between the families (the new API orders by amount). Every consumer aggregates through maps or sorts, so no output depends on it.

### Evidence

Implementation: [adapter](../../server/cost-api.js), [cost fetchers](../../server/aws.js).

Verification: [adapter tests](../../tests/server/test-cost-api-v2.mjs), [route tests against a stubbed upstream](../../tests/server/test-cost-api-routes.mjs).

<a id="korean"></a>
## 한국어

### 배경

Anthropic은 2026-10-29에 Usage and Cost Analytics API를 베타로 출시했습니다(`GET /v1/organizations/analytics/usage`, `/cost`, 헤더 `anthropic-beta: analytics-usage-cost-2026-08-24`). 같은 릴리스 노트에서 이 대시보드의 비용 기능이 쓰는 리포트 네 개(`cost_report`, `usage_report`, `user_cost_report`, `user_usage_report`)를 legacy로 지정했습니다. 지원은 계속되고 종료일은 공지되지 않았습니다.

새 엔드포인트는 키, 31일 범위와 365일 조회 한도, `data_refreshed_at` 워터마크, 조직당 분당 60회 한도가 기존과 같습니다. 다른 것은 응답입니다. 기존 리포트는 시간 버킷마다 `results[]` 목록을 주고, 새 API는 `{ starting_at, ending_at, group, cost | usage }` 행을 주며 데이터가 없는 버킷은 행을 내지 않습니다. 이 코드에 영향을 주는 나머지 차이는 다음과 같습니다.

- `bucket_width`가 `time_bucket_width`로 바뀌었고 기본값이 없으며 `ending_at`이 필수입니다.
- `limit`은 버킷이 아니라 행 수(1–1000)입니다.
- 사용자별 리포트는 `group_by[]=actor`에 `actor_types[]=user_actor`를 붙인 형태가 됩니다.
- Claude Tag의 제품 값이 `claude_tag`입니다. 기존 리포트는 `claude-tag`로 씁니다.
- `group_by[]=cost_type`에 네 번째 유형 `session_usage`가 있습니다.
- 모든 버킷의 모든 그룹을 돌려줍니다. 기존 리포트는 버킷당 상위 100개 그룹까지만 줍니다.

2026-11-13에 대시보드가 보내는 쿼리를 두 계열에 간격을 두고 실행해 기존 변환 함수에 넣어 비교했습니다. 조직 합계는 소수 여섯 자리까지 같았고, 사용자별 행(기본, 모델별, 제품별, RBAC 그룹별, 토큰)도 같았습니다. 오늘 하루짜리 창은 `ending_at`을 내일로 보내도 받아들였고 `data_refreshed_at`도 같았습니다. RBAC 그룹 차원은 두 계열 모두 느렸습니다(같은 쿼리가 호출마다 1.4초에서 27초). 지연의 원인은 공유 멤버십 백엔드이고 어느 한 API의 문제가 아닙니다.

### 결정

- **모든 비용 조회의 기본 경로는 새 API입니다.** `server/aws.js`의 `fetchCostSummary`, `fetchUserReport`, `fetchGroupCost`가 새 API를 먼저 호출합니다.
- **어댑터가 새 API의 행을 기존 응답 형태로 되돌립니다**(`server/cost-api.js`). `rowsToDailyBuckets`는 UTC 하루마다 버킷 하나를 만들고 행이 없는 날을 0으로 채우며, `flattenV2Row`는 `group`과 `cost` 또는 `usage`를 기존 행 형태로 폅니다. 변환 함수, ADR-0019의 31일 이하 청크 분할, TTL 캐시, keep-warm 루프, 라우트, 프런트엔드가 읽는 응답 형태는 바뀌지 않습니다.
- **거부된 호출은 기존 리포트로 한 번 재시도합니다.** 400, 403, 404만 대상입니다. 엔드포인트나 쿼리가 제공되지 않는다는 뜻이기 때문입니다. 429, 5xx, 네트워크 오류는 재시도하지 않습니다. 두 계열이 같은 호출 한도와 백엔드를 쓰고, 12초에서 30초 걸리는 RBAC 조회를 한 번 더 하면 CloudFront의 60초 오리진 제한을 넘습니다. 이 경우는 기존 stale, last-good 경로가 처리합니다.
- **폴백이 일어나면 그 조직은 30분 동안 기존 리포트를 씁니다.** 기존 리포트도 같은 방식(400, 403, 404)으로 거부한 경우만 예외입니다. 두 계열이 모두 거부한 쿼리는 쿼리가 문제이므로 새 API를 끄지 않습니다. 기존 호출이 일시적으로만 실패했다면 쿼리를 거부한 것이 아니므로 조직을 기존 리포트로 옮깁니다. 그러지 않으면 기존 리포트가 회복될 때까지 모든 호출이 두 계열을 다 부르게 됩니다. 라우트에는 기존 리포트의 오류가 전달됩니다.
- **`CCD_COST_API=legacy`로 기존 리포트를 고정할 수 있습니다.** 코드를 새로 배포할 필요가 없습니다.
- **Claude Tag는 대시보드 안에서 기존 제품 값 `claude-tag`를 유지합니다.** 두 계열, 캐시된 창, CSV 이력 사이에서 한 제품이 두 계열로 갈라지지 않습니다.
- **`session_usage`는 0달러인 동안 숨깁니다.** Claude Managed Agents 세션 시간이라 Claude Enterprise 조직에는 해당하지 않습니다.
- `/api/cost/live`는 어느 계열이 응답했는지를 `cost_api`(`v2` 또는 `legacy`)로 알립니다.

이번 변경에 없는 것: 새 차원이나 화면은 추가하지 않습니다. `actor_type` 그룹핑, 사용자 × 제품 × 모델 한 번에 조회, `order_by` 랭킹, 부모 조직 키 하나로 두 조직 조회(`organization_ids[]`)는 후속 작업 후보입니다.

### 결과

- 주 비용 경로가 베타 헤더에 의존합니다. Anthropic이 헤더를 바꾸거나 철회하면 각 창의 첫 호출에 요청 하나가 더 들고, 코드를 고칠 때까지 조직이 30분 단위로 기존 리포트를 씁니다.
- 정상 상황의 업스트림 요청 수는 같습니다. 31일 이하 청크는 1,000행 이내면 한 페이지입니다(2026-11-13 primary 조직의 제품 × 모델 7일치가 105행이었으니 31일이면 약 465행). 조합이 더 많은 조직은 페이지가 늘고, 기존 페이지네이션 루프가 `?page=`로 따라갑니다(실데이터로 확인).
- 버킷당 100개 그룹 상한이 없어집니다.
- 기존 코드 경로는 Anthropic이 종료를 공지할 때까지 남깁니다. 그때 제거할 곳은 함수 세 개입니다.
- 하루 안의 행 순서가 두 계열에서 다릅니다(새 API는 금액순). 모든 소비 코드가 Map으로 집계하거나 정렬하므로 순서에 의존하는 출력은 없습니다.

### 근거

구현: [어댑터](../../server/cost-api.js), [비용 조회 함수](../../server/aws.js).

검증: [어댑터 테스트](../../tests/server/test-cost-api-v2.mjs), [가짜 업스트림을 쓴 라우트 테스트](../../tests/server/test-cost-api-routes.mjs).
