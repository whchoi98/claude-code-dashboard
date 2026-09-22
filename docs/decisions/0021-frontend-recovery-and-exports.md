# ADR-0021: Frontend recovery, scope isolation and table exports

Date: 2026-09-21

Status: Accepted

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Context

The dashboard has twenty routes and organization-specific data. Uncancelled requests, delayed upload callbacks and page-local last-good responses could outlive the view that initiated them. The frontend also loaded every page at startup and lacked automated interaction coverage.

### Decision

- Load route modules and the floating chat panel on demand. Keep navigation outside each page's Suspense and error boundary; reset page state when pathname or organization changes.
- `useFetch` aborts superseded/unmounted requests, validates JSON, limits requests to 65 seconds and returns a promise that settles with each refetch. A callback captured for a previous organization or URL cannot interrupt the current request.
- Preserve same-organization data during refresh for the existing Cost stale-while-revalidate UI. Clear organization changes during render. Cost Live separately binds its last-good response to the organization and verifies snapshot identity.
- Validate custom ISO calendar dates in the browser and format calendar labels in UTC. Keep the existing preset and server-side range policies.
- Export Users and Cost Live rows after filtering and sorting. Use the same `maskEmail()` decision as the screen, retain numeric precision, quote CSV cells, include a UTF-8 BOM and neutralize text formulas.
- Verify interactions with Vitest and browser flows with Playwright using synthetic API responses.

### Consequences

Organization switches cannot reuse another organization's local view state. Retained data is still possible during same-organization refreshes, so consumers must honor loading and provenance indicators. A failed lazy module may require the provided full reload action because React caches a rejected lazy import.

CSV files reflect the current visible scope. They do not add server export endpoints or change the presentation-level privacy contract in [ADR-0020](0020-identity-aware-masking.md).

### Evidence

Implementation: [App](../../src/App.tsx), [Layout](../../src/components/Layout.tsx), [request hook](../../src/lib/api.ts), [CSV serializer](../../src/lib/csv.ts), [date validation](../../src/lib/dateRange.ts).

Verification: [frontend tests](../../tests/frontend/), [browser tests](../../tests/e2e/), [dated improvement report](../project-review-2026-09-21.md).

<a id="korean"></a>
## 한국어

### 배경

대시보드는 20개 화면과 조직별 데이터를 제공합니다. 취소되지 않은 요청, 늦게 끝난 업로드 콜백, 화면에 남긴 마지막 성공 응답이 원래 조회를 시작한 화면보다 오래 유지될 수 있었습니다. 모든 화면 코드가 처음부터 로드됐고 사용자 조작에 대한 자동 검사도 부족했습니다.

### 결정

- 화면 모듈과 플로팅 채팅 패널을 사용할 때 불러옵니다. 메뉴는 페이지별 Suspense·오류 경계 밖에 두며, 경로나 조직이 바뀌면 페이지 상태를 초기화합니다.
- `useFetch`는 대체·언마운트된 요청을 취소하고 JSON을 검증하며 65초 제한을 적용합니다. 재조회는 실제 요청이 끝날 때 완료되고, 이전 조직·URL의 콜백은 현재 요청을 중단할 수 없습니다.
- Cost의 기존 갱신 방식을 위해 같은 조직의 이전 응답은 유지할 수 있습니다. 조직 전환은 렌더링 단계에서 분리하며, Cost Live는 마지막 성공 응답의 조직과 스냅샷 식별자를 별도로 확인합니다.
- 브라우저에서 실제 ISO 날짜를 검증하고 UTC로 달력 날짜를 표시합니다. 기존 프리셋과 서버의 기간 정책을 따릅니다.
- 사용자·비용 실시간 표에서 필터·정렬한 행을 내보냅니다. 화면과 같은 `maskEmail()` 판정, 숫자 정밀도, 셀 이스케이프, UTF-8 BOM과 문자열 수식 방지를 적용합니다.
- Vitest로 사용자 조작을 검사하고 Playwright로 샘플 API를 사용하는 브라우저 흐름을 확인합니다.

### 결과

다른 조직의 로컬 화면 상태를 재사용하지 않습니다. 같은 조직을 갱신할 때는 이전 데이터가 남을 수 있으므로 호출 화면은 로딩·출처 표시를 따라야 합니다. React가 실패한 lazy import를 보관하므로 청크 로딩 오류에는 제공된 전체 새로고침이 필요할 수 있습니다.

CSV는 현재 보이는 범위를 따릅니다. 서버 내보내기 API를 추가하거나 [ADR-0020](0020-identity-aware-masking.md)의 표시 계층 개인정보 정책을 바꾸지 않습니다.

### 근거

구현: [App](../../src/App.tsx), [Layout](../../src/components/Layout.tsx), [조회 훅](../../src/lib/api.ts), [CSV 직렬화](../../src/lib/csv.ts), [날짜 검증](../../src/lib/dateRange.ts).

검증: [프런트엔드 테스트](../../tests/frontend/), [브라우저 테스트](../../tests/e2e/), [날짜별 개선 기록](../project-review-2026-09-21.md).
