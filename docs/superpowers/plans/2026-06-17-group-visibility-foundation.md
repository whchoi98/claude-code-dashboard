# Group Visibility — Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-defined group-level visibility — an `email→group` CSV mapping (S3) + a global URL-synced group selector that scopes pages, proven on the Users page.

**Architecture:** A pure `parseGroupMap` + two S3-backed routes (`/api/groups`, `/api/groups/upload`) mirror the spend-reports upload infra in `server/aws.js`. A `useGroupScope` hook combines the fetched map with a `?group=` URL param (same idiom as `useDateRange`) and exposes `inGroup(email)`; a `GroupControl` dropdown in `Layout` writes the URL. The Users page applies `inGroup` in its per-user aggregation (client-side scoping; proxy routes unchanged).

**Tech Stack:** Node 20 ESM (`server/aws.js`, multer + AWS SDK v3 S3), standalone `.mjs` unit tests, React 18 + TS 5 strict (`react-router-dom` `useSearchParams`, `useFetch`), Vite build verification.

---

## Spec

Approved design: `docs/superpowers/specs/2026-06-17-group-visibility-foundation-design.md` (v1.4.0). This plan implements it verbatim. **Rollout to the remaining ~10 pages is OUT of scope** (Foundation + Users pilot only).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `server/aws.js` | pure `parseGroupMap(csvText)`; `POST /api/groups/upload`; `GET /api/groups` | 1 (parser), 2 (routes) |
| `tests/server/test-group-map.mjs` | `parseGroupMap` unit test | 1 |
| `src/lib/useGroupScope.ts` | fetch map + `?group=` URL state → `{group,setGroup,groups,hasMap,loading,inGroup,refetch}` | 3 |
| `src/components/GroupControl.tsx` | sidebar dropdown (All/groups/Unmapped) + upload affordance | 4 |
| `src/components/Layout.tsx` | render `<GroupControl />` near the language toggle | 4 |
| `src/lib/i18n.tsx` | `group.*` keys (en+ko) | 4 |
| `src/pages/Users.tsx` | apply `inGroup` in the per-user aggregation (pilot) | 5 |
| `package.json` / `CHANGELOG.md` | v1.4.0 + release notes | 6 |

## Context the implementer needs (shared by all tasks)

- `server/aws.js` registers routes via `registerAwsRoutes(app, …)`, mounting an `express.Router` at `/api` (so `router.get('/groups')` → `/api/groups`). The S3 client `s3`, the `uploadSingle` multer wrapper (field name `file`, memory storage, JSON error handling), and the module-scope `parseCsv(text) → {columns, rows}` helper already exist and must be reused. The bucket is `process.env.ARCHIVE_S3_BUCKET`.
- The spend-reports routes (`/cost/csv`, `/cost/upload`) are the exact pattern to mirror: list `ListObjectsV2Command` by prefix → pick latest by `LastModified` → `GetObjectCommand` → `Body.transformToString()` → `parseCsv`. Upload: validate required columns → `PutObjectCommand`.
- ESM only; validate with `node --check server/aws.js`. Tests: `node tests/server/<file>.mjs` then `bash tests/run-all.sh`. Frontend: `npx tsc --noEmit` (strict, noUnusedLocals) + `npx vite build`. Korean commits; never `--no-verify`.
- Every UI string needs BOTH en and ko keys in `src/lib/i18n.tsx`; never hardcode strings in JSX props.

---

## Task 1: `parseGroupMap` (pure, exported) + unit test

**Files:**
- Modify: `server/aws.js` (add exported `parseGroupMap` next to `parseCsv`, ~line 1413)
- Test: `tests/server/test-group-map.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/server/test-group-map.mjs`:

```js
// Standalone ESM test for parseGroupMap (server/aws.js).
// node tests/server/test-group-map.mjs — exit 0 on success, 1 on failure.
import { parseGroupMap } from '../../server/aws.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// Basic: builds the email→group map and a sorted unique group list.
;(() => {
  const r = parseGroupMap('email,group\na@x.com,Platform\nb@y.com,Apps')
  ok('maps each email to its group', r.map['a@x.com'] === 'Platform' && r.map['b@y.com'] === 'Apps')
  ok('groups are unique and sorted', JSON.stringify(r.groups) === JSON.stringify(['Apps', 'Platform']))
})()

// Emails lowercased + trimmed for case-insensitive matching; group trimmed.
;(() => {
  const r = parseGroupMap('email,group\n  A@X.com  ,  Platform  ')
  ok('email lowercased + trimmed', r.map['a@x.com'] === 'Platform')
  ok('group trimmed', r.groups[0] === 'Platform')
})()

// Rows missing email OR group are skipped (tolerant GET path).
;(() => {
  const r = parseGroupMap('email,group\n,Platform\nc@z.com,\nd@z.com,Data')
  ok('skips rows missing email or group', Object.keys(r.map).length === 1 && r.map['d@z.com'] === 'Data')
})()

// Duplicate group names dedup to one entry.
;(() => {
  const r = parseGroupMap('email,group\na@x.com,Platform\nb@x.com,Platform')
  ok('dedups group names', r.groups.length === 1 && r.groups[0] === 'Platform')
  ok('keeps both email mappings', r.map['a@x.com'] === 'Platform' && r.map['b@x.com'] === 'Platform')
})()

// Missing required columns → empty result (the upload route reports the 400; the parser is tolerant).
;(() => {
  const r = parseGroupMap('name,team\nAlice,Platform')
  ok('missing email/group columns → empty map+groups', Object.keys(r.map).length === 0 && r.groups.length === 0)
})()

// Empty / null input → empty result, no throw.
;(() => {
  ok('empty string → empty', JSON.stringify(parseGroupMap('')) === JSON.stringify({ map: {}, groups: [] }))
  ok('null → empty (no throw)', JSON.stringify(parseGroupMap(null)) === JSON.stringify({ map: {}, groups: [] }))
})()

// Last write wins for a duplicate email (latest row in the file).
;(() => {
  const r = parseGroupMap('email,group\na@x.com,Platform\na@x.com,Apps')
  ok('duplicate email → last row wins', r.map['a@x.com'] === 'Apps')
})()

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `node tests/server/test-group-map.mjs`
Expected: FAIL — `parseGroupMap` is not exported yet (`SyntaxError`/`undefined is not a function`), exit non-zero.

- [ ] **Step 3: Add `parseGroupMap` to `server/aws.js`**

`parseCsv` is a module-scope `function` declaration (hoisted), so place `parseGroupMap` immediately after it (after the closing `}` of `parseCsv`, ~line 1413). Add:

```js
// Pure: parse an `email,group` CSV into a lookup map + sorted unique group list.
// Emails are lowercased for case-insensitive matching. Rows missing either field
// (or with empty values) are skipped; duplicate emails take the last row. Returns
// { map:{}, groups:[] } when the CSV lacks the required columns or is empty.
// Exported for unit tests; the upload route validates column presence separately.
export function parseGroupMap(csvText) {
  const { columns, rows } = parseCsv(String(csvText ?? ''))
  if (!columns.includes('email') || !columns.includes('group')) return { map: {}, groups: [] }
  const map = {}
  const groupSet = new Set()
  for (const r of rows) {
    const email = String(r.email ?? '').trim().toLowerCase()
    const group = String(r.group ?? '').trim()
    if (!email || !group) continue
    map[email] = group
    groupSet.add(group)
  }
  return { map, groups: [...groupSet].sort() }
}
```

- [ ] **Step 4: Validate syntax**

Run: `node --check server/aws.js` → no output, exit 0.

- [ ] **Step 5: Run the test to verify it PASSES**

Run: `node tests/server/test-group-map.mjs` → all `ok`, final `1..11`, exit 0.
Run: `bash tests/run-all.sh` → all pass (was 58/58; now 59/59 with the new test file).

- [ ] **Step 6: Commit**

```bash
git add server/aws.js tests/server/test-group-map.mjs
git commit -m "feat(groups): parseGroupMap — email→group CSV 파서 (pure, 단위테스트)"
```

---

## Task 2: `/api/groups` + `/api/groups/upload` routes

**Files:**
- Modify: `server/aws.js` (add two routes inside `registerAwsRoutes`, after the `/cost/efficiency` route and before `app.use('/api', router)`)

There is no route-level test harness (routes need S3); verify with `node --check` + the existing suite, mirroring repo convention.

- [ ] **Step 1: Add the two routes**

In `server/aws.js`, find the line `  app.use('/api', router)` (near the end of `registerAwsRoutes`). Immediately ABOVE it, insert:

```js
  // ── Group mapping (admin email→group CSV in S3) ─────────────────────────
  // The Analytics API's rbac_group_id / claude_project_id group dimensions
  // return HTTP 400 ("not yet supported") and user records carry no group
  // field, so groups come from an admin-uploaded `email,group` CSV stored
  // latest-wins at s3://<archive>/group-map/. Reuses the spend-report upload
  // infra (uploadSingle multer wrapper, s3 client, parseCsv, parseGroupMap).
  const GROUP_MAP_REQUIRED_COLUMNS = ['email', 'group']

  // POST /api/groups/upload (multipart, field "file") — validate + store latest-wins.
  router.post('/groups/upload', uploadSingle, async (req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Attach a CSV file under field name "file".' })
    try {
      const body = req.file.buffer.toString('utf8')
      const { columns } = parseCsv(body)
      const missing = GROUP_MAP_REQUIRED_COLUMNS.filter((c) => !columns.includes(c))
      if (missing.length) {
        return res.status(400).json({
          error: 'schema_mismatch',
          message: `CSV is missing required columns: ${missing.join(', ')}`,
          expected: GROUP_MAP_REQUIRED_COLUMNS, found: columns,
        })
      }
      const { map, groups } = parseGroupMap(body)
      if (groups.length === 0) {
        return res.status(400).json({ error: 'empty_mapping', message: 'CSV has no valid email,group rows.' })
      }
      const d = new Date().toISOString().slice(0, 10)
      const key = `group-map/group-map-${d}.csv`
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: req.file.buffer, ContentType: 'text/csv',
        Metadata: { uploadedVia: 'dashboard', originalName: req.file.originalname.slice(0, 250) },
      }))
      res.json({ ok: true, file: key.split('/').pop(), rows: Object.keys(map).length, groups })
    } catch (err) {
      console.error('[groups/upload] error:', err?.message || err)
      res.status(500).json({ error: 'upload_failed', message: err?.message || String(err) })
    }
  })

  // GET /api/groups — latest mapping under group-map/ → { source, file, groups, map }.
  // No mapping uploaded → { source:'empty', groups:[], map:{} } (200, not an error).
  router.get('/groups', async (_req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'group-map/' }))
      const objects = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
      if (objects.length === 0) return res.json({ source: 'empty', file: null, groups: [], map: {} })
      const latest = objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
      const body = await obj.Body.transformToString()
      const { map, groups } = parseGroupMap(body)
      res.json({ source: 'live', file: latest.Key.split('/').pop(), groups, map })
    } catch (err) {
      console.error('[groups] error:', err?.message || err)
      res.status(500).json({ error: 'groups_read_failed', message: err?.message || String(err) })
    }
  })

```

(`uploadSingle`, `s3`, `parseCsv`, `PutObjectCommand`, `ListObjectsV2Command`, `GetObjectCommand` are all already in scope — `uploadSingle` and `s3` are defined earlier inside `registerAwsRoutes`; the S3 command classes are imported at the top of the file; `parseGroupMap` is the module-scope export from Task 1.)

- [ ] **Step 2: Validate syntax**

Run: `node --check server/aws.js` → exit 0.

- [ ] **Step 3: Confirm the routes are wired under `/api`**

Run: `grep -n "groups/upload\|router.get('/groups'\|app.use('/api'" server/aws.js`
Expected: the two new routes appear BEFORE the `app.use('/api', router)` line.

- [ ] **Step 4: Run the full suite (no regression)**

Run: `bash tests/run-all.sh` → all pass (59/59). `node tests/server/test-group-map.mjs` → `1..11`.

- [ ] **Step 5: Commit**

```bash
git add server/aws.js
git commit -m "feat(groups): GET /api/groups + POST /api/groups/upload (S3 group-map/, latest-wins)"
```

---

## Task 3: `useGroupScope` hook

**Files:**
- Create: `src/lib/useGroupScope.ts`

- [ ] **Step 1: Create the hook**

Create `src/lib/useGroupScope.ts`:

```ts
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useFetch } from './api'

/** Sentinel group value: users NOT present in the uploaded mapping. */
export const UNMAPPED = '__unmapped__'

type GroupsResp = {
  source: 'live' | 'empty'
  file: string | null
  groups: string[]
  map: Record<string, string>   // lowercased email → group
}

/**
 * Global group-scope state. Combines the admin-uploaded email→group map
 * (`GET /api/groups`) with a URL-synced `?group=` selection (same idiom as
 * useDateRange). `inGroup(email)` is the predicate every scoped page applies
 * in its per-user aggregation:
 *   - group === ''            → All (everyone)
 *   - group === UNMAPPED      → email NOT in the mapping
 *   - else                    → map[email_lower] === group
 */
export function useGroupScope() {
  const [params, setParams] = useSearchParams()
  const { data, loading, refetch } = useFetch<GroupsResp>('/api/groups')

  const groups = useMemo(() => data?.groups ?? [], [data])
  const map = useMemo(() => data?.map ?? {}, [data])
  const hasMap = data?.source === 'live' && groups.length > 0

  const rawGroup = params.get('group') ?? ''
  // Fall back to "All" if the selected name is no longer present in the map.
  const group = rawGroup === UNMAPPED || groups.includes(rawGroup) ? rawGroup : ''

  const setGroup = useCallback((g: string) => {
    const next = new URLSearchParams(params)
    if (!g) next.delete('group')
    else next.set('group', g)
    setParams(next, { replace: true })
  }, [params, setParams])

  const inGroup = useCallback((email: string | null | undefined): boolean => {
    if (!group) return true
    const e = (email ?? '').toLowerCase()
    if (group === UNMAPPED) return !(e in map)
    return map[e] === group
  }, [group, map])

  return { group, setGroup, groups, hasMap, loading, inGroup, refetch }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit` → exit 0. (The hook isn't consumed yet, but strict mode validates it compiles. `noUnusedLocals` is satisfied because every binding is returned.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/useGroupScope.ts
git commit -m "feat(groups): useGroupScope 훅 (?group= URL 상태 + inGroup 술어)"
```

---

## Task 4: `GroupControl` + Layout + i18n

**Files:**
- Create: `src/components/GroupControl.tsx`
- Modify: `src/components/Layout.tsx` (import + render near the language toggle)
- Modify: `src/lib/i18n.tsx` (`group.*` keys, en + ko)

- [ ] **Step 1: Add the `group.*` i18n keys (English)**

In `src/lib/i18n.tsx`, in the `en` dict, add these keys (place them next to other global/nav keys, e.g. right after the `status.*` block):

```ts
    'group.label':          'Group scope',
    'group.all':            'All groups',
    'group.unmapped':       '(Unmapped)',
    'group.upload':         'Upload map',
    'group.upload.hint':    'CSV columns: email, group',
    'group.upload.success': 'Mapping updated',
    'group.upload.groups':  'groups',
    'group.upload.rows':    'users',
    'group.empty':          'No mapping uploaded — showing all users.',
```

- [ ] **Step 2: Add the `group.*` i18n keys (Korean)**

In `src/lib/i18n.tsx`, in the `ko` dict, add the matching keys:

```ts
    'group.label':          '그룹 범위',
    'group.all':            '전체 그룹',
    'group.unmapped':       '(미매핑)',
    'group.upload':         '매핑 업로드',
    'group.upload.hint':    'CSV 열: email, group',
    'group.upload.success': '매핑 갱신됨',
    'group.upload.groups':  '그룹',
    'group.upload.rows':    '사용자',
    'group.empty':          '매핑 미업로드 — 전체 사용자 표시.',
```

- [ ] **Step 3: Create `GroupControl.tsx`**

Create `src/components/GroupControl.tsx`:

```tsx
import { useCallback, useRef, useState } from 'react'
import clsx from 'clsx'
import { useT } from '../lib/i18n'
import { useGroupScope, UNMAPPED } from '../lib/useGroupScope'

/**
 * Sidebar group selector + upload affordance. URL-synced via useGroupScope, so
 * every page's useGroupScope reflects the selection without prop-drilling. The
 * upload mirrors CsvUploader (multipart POST → refetch). When no mapping exists,
 * only "All groups" shows plus an upload prompt.
 */
export function GroupControl() {
  const t = useT()
  const { group, setGroup, groups, hasMap, refetch } = useGroupScope()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const doUpload = useCallback(async (file: File) => {
    setBusy(true); setMsg(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/groups/upload', { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
      setMsg({ kind: 'ok', text: `${t('group.upload.success')}: ${body.groups.length} ${t('group.upload.groups')} · ${body.rows} ${t('group.upload.rows')}` })
      if (inputRef.current) inputRef.current.value = ''
      await refetch?.()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Upload failed.' })
    } finally {
      setBusy(false)
    }
  }, [t, refetch])

  return (
    <div className="rounded-lg border border-ink-100 bg-white p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-ink-600">{t('group.label')}</span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[11px] text-ink-400 underline hover:text-ink-700"
        >
          {t('group.upload')}
        </button>
      </div>
      <select
        value={group}
        onChange={(e) => setGroup(e.target.value)}
        className="w-full rounded-md border border-ink-100 bg-paper-muted/40 px-2 py-1 text-xs text-ink-700"
      >
        <option value="">{t('group.all')}</option>
        {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        {hasMap && <option value={UNMAPPED}>{t('group.unmapped')}</option>}
      </select>
      {!hasMap && <div className="mt-1 text-[10px] text-ink-400">{t('group.empty')}</div>}
      {open && (
        <div className="mt-2 space-y-1">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f) }}
            className="text-[10px] file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-claude-500 file:px-2 file:py-1 file:text-white"
          />
          <div className="text-[10px] text-ink-400">{t('group.upload.hint')}</div>
          {msg && (
            <div className={clsx('text-[10px]', msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-600')}>
              {msg.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Render `GroupControl` in `Layout`**

In `src/components/Layout.tsx`, add the import after the other component imports (after line 4, `import { FloatingChat } from './chat/FloatingChat'`):

```tsx
import { GroupControl } from './GroupControl'
```

Then, in the `mt-auto space-y-3 pt-6` footer block, insert `<GroupControl />` immediately BEFORE the `{/* Language toggle */}` comment. Find:

```tsx
          {/* Language toggle */}
          <div className="flex items-center gap-1 rounded-lg border border-ink-100 bg-white p-0.5 text-xs font-medium">
```

Replace with:

```tsx
          {/* Group scope */}
          <GroupControl />

          {/* Language toggle */}
          <div className="flex items-center gap-1 rounded-lg border border-ink-100 bg-white p-0.5 text-xs font-medium">
```

- [ ] **Step 5: Type-check + build**

Run: `npx tsc --noEmit` → exit 0 (confirms every `group.*` key resolves in both dicts and `GroupControl` types are sound).
Run: `npx vite build` → success.

- [ ] **Step 6: Commit**

```bash
git add src/components/GroupControl.tsx src/components/Layout.tsx src/lib/i18n.tsx
git commit -m "feat(groups): GroupControl 드롭다운 + 업로드 (Layout 전역 마운트 + i18n)"
```

---

## Task 5: Users pilot — apply `inGroup`

**Files:**
- Modify: `src/pages/Users.tsx` (call `useGroupScope`, filter the aggregation)

- [ ] **Step 1: Import the hook**

In `src/pages/Users.tsx`, after the existing `import { useDateRange } from '../lib/useDateRange'` (line 8), add:

```tsx
import { useGroupScope } from '../lib/useGroupScope'
```

- [ ] **Step 2: Call the hook inside the component**

In `Users.tsx`, after `const { range } = useDateRange('7d')` (line 26), add:

```tsx
  const { inGroup } = useGroupScope()
```

- [ ] **Step 3: Apply `inGroup` in the aggregation loop**

In the `aggregated` `useMemo`, find:

```tsx
    for (const d of data?.days ?? []) {
      for (const r of d.data) {
        const cc = r.claude_code_metrics
```

Replace with:

```tsx
    for (const d of data?.days ?? []) {
      for (const r of d.data) {
        if (!inGroup(r.user.email_address)) continue
        const cc = r.claude_code_metrics
```

Then update the `useMemo` dependency array — find the line that closes this memo:

```tsx
  }, [data])
```

(the one immediately after `return Array.from(byEmail.values()).map((u) => ({ ...u, accept: acceptRate(u.accepted, u.rejected) }))`) and replace with:

```tsx
  }, [data, inGroup])
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit` → exit 0.
Run: `npx vite build` → success.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Users.tsx
git commit -m "feat(groups): Users 페이지에 inGroup 스코프 적용 (파일럿)"
```

---

## Task 6: v1.4.0 + CHANGELOG

**Files:**
- Modify: `package.json` (version)
- Modify: `CHANGELOG.md` (bilingual entry under `# English`)

**CHANGELOG convention (verify before editing):** since v0.9.0 each release entry lives ONCE under `# English` and is bilingual — a `### Added`/`### Changed` (English) sub-block immediately followed by a `### 추가`/`### 변경` (Korean) sub-block. The standalone `# 한국어` section is frozen at `[0.8.0]`; do NOT add v1.4.0 there.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.3.0",` to `"version": "1.4.0",`.

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, the English `## [Unreleased]` block reads:

```markdown
## [Unreleased]

_No changes yet — next entries land here._
```

Replace it with:

```markdown
## [Unreleased]

_No changes yet — next entries land here._

## [1.4.0] - 2026-06-17

Group visibility — Foundation (admin email→group mapping + global scope filter; Users pilot).

### Added

- **Group-level visibility (Foundation).** Admins upload an `email,group` CSV (stored latest-wins at `s3://<archive>/group-map/` via `POST /api/groups/upload`); `GET /api/groups` returns the parsed map + group list. A new global **Group scope** selector in the sidebar (URL-synced `?group=`, same idiom as the date range) scopes pages to a selected group — or to `(Unmapped)` users for admin gap-spotting. The **Users page** is the pilot: its per-user aggregation now filters by the selected group via a reusable `useGroupScope().inGroup(email)` predicate. Groups come from the uploaded mapping because the Analytics API's `rbac_group_id`/`claude_project_id` dimensions return HTTP 400 ("not yet supported") and user records carry no group field. Rollout to the remaining pages is a later cycle.

### 추가

- **그룹 단위 가시성 (Foundation).** 관리자가 `email,group` CSV를 업로드하면(`POST /api/groups/upload` → `s3://<archive>/group-map/`에 최신본 저장), `GET /api/groups`가 파싱된 매핑+그룹 목록을 반환합니다. 사이드바에 전역 **그룹 범위** 선택기(날짜 범위와 동일한 `?group=` URL 동기화)를 추가해 선택한 그룹으로 페이지를 스코프하거나 `(미매핑)` 사용자를 골라낼 수 있습니다. **Users 페이지**가 파일럿으로, 사용자별 집계가 재사용 가능한 `useGroupScope().inGroup(email)` 술어로 선택 그룹을 필터링합니다. Analytics API의 `rbac_group_id`/`claude_project_id` 차원이 HTTP 400("미지원")을 반환하고 사용자 레코드에 그룹 필드가 없어, 그룹은 업로드된 매핑에서 가져옵니다. 나머지 페이지 적용은 다음 사이클입니다.
```

- [ ] **Step 3: Build (validates version badge + CHANGELOG `?raw` import)**

Run: `npx vite build` → success.
Run: `node -e "console.log(require('./package.json').version)"` → `1.4.0`.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): v1.4.0 — 그룹 가시성 Foundation"
```

---

## After all tasks

Dispatch a final holistic code review across the whole branch, then use `superpowers:finishing-a-development-branch`. Deploy = `/deploy` (`ccd-compute`) **plus a CloudFront `/*` invalidation** (dist `EAKHVAM1T8MX8`) — new frontend strings + a sidebar control shipped. The `group-map/` S3 prefix needs no infra change (same `ARCHIVE_S3_BUCKET`, and the task role already has read/write there for `spend-reports/`); confirm during review that the bucket policy/IAM isn't prefix-scoped (the cost upload writing to `spend-reports/` under the same role indicates it isn't, but verify).

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §1 mapping source: `parseGroupMap` (Task 1), `POST /api/groups/upload` + `GET /api/groups` with `source:'empty'` fallback (Task 2).
- §2 global state + control: `useGroupScope` with `?group=` + `inGroup` semantics incl. `__unmapped__` and stale-name→All fallback (Task 3); `GroupControl` dropdown (All/groups/Unmapped) + upload affordance + `!hasMap` prompt, mounted in `Layout` (Task 4).
- §3 pilot: `inGroup` in `Users.tsx` aggregation, `group===''`→no-op (Task 5).
- §4 masking: `/api/groups` returns raw map; `GroupControl` renders only group names (no emails); `Users.tsx` still masks via its existing `maskEmail`. (No new email rendering introduced — confirmed: `GroupControl` shows group names only.)
- §5 edge cases: no mapping→`source:'empty'` + prompt (Tasks 2/4); malformed CSV→`400 schema_mismatch` (Task 2) / tolerant GET (Task 1); stale `?group=`→All fallback (Task 3); case-insensitive match (Tasks 1/3); `(Unmapped)` surfaces gap (Tasks 2/3).
- §6 testing: `parseGroupMap` unit test (Task 1); tsc + vite build (Tasks 3–5); suite green; v1.4.0 (Task 6).
- §7 out-of-scope: no rollout to other pages, no list/delete UI, no server-side filtering — none added. ✓

**2. Placeholder scan** — no TBD/TODO; every code step shows complete code; every command states expected output.

**3. Type/name consistency** — `UNMAPPED = '__unmapped__'` defined in Task 3, imported by Task 4; `inGroup`/`group`/`setGroup`/`groups`/`hasMap`/`refetch` returned by `useGroupScope` (Task 3) and consumed in Tasks 4–5 with matching names. `GroupsResp.source` `'live'|'empty'` matches the route's responses (Task 2). Field name `file` for the field upload (multipart) is consistent across `GroupControl` (`form.append('file', …)`), the reused `uploadSingle` (`upload.single('file')`), and the route. `parseGroupMap` return `{map, groups}` identical in Task 1 (impl + test), Task 2 (routes), Task 3 (`GroupsResp`). CHANGELOG version `1.4.0` matches `package.json` (Task 6).
