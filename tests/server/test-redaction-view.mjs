// The compliance_daily_redacted views (infra/lib/storage-stack.ts) null archived
// file / artifact names with a Trino regexp_replace. The pattern lives inside a
// String.raw template, where one missing backslash silently yields an invalid
// regex (the first draft did exactly that). This test compiles the pattern
// straight out of the source file and runs it over JSON.stringify output —
// how collector/flatten.js serializes `payload`.
// node tests/server/test-redaction-view.mjs — exit 0 on success, 1 on failure.
import { readFileSync } from 'node:fs'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

const src = readFileSync(new URL('../../infra/lib/storage-stack.ts', import.meta.url), 'utf8')
const m = /const payloadSql = String\.raw`([^`]*)`/.exec(src)
ok('payloadSql String.raw literal found', !!m)
const sql = m ? m[1] : ''                       // String.raw: the text between the backticks, verbatim
const lit = /^regexp_replace\(payload, '([^']*)', '([^']*)'\)$/.exec(sql)
ok('SQL is regexp_replace(payload, <pattern>, <replacement>)', !!lit)
const [, pattern = '', replacement = ''] = lit || []

let re = null
try { re = new RegExp(pattern, 'g') } catch (err) { console.log(`# ${err.message}`) }
ok('pattern compiles', re !== null)
const redact = (s) => (re ? s.replace(re, replacement) : s)

const payload = JSON.stringify({
  type: 'claude_file_viewed',
  filename: 'Q3 "plan" \\ final.pdf',
  nested: { title: 'Board deck — 🔒 draft', list: [{ filename: 'a\nb.txt' }] },
  description: 'Q3 revenue model for the board',
  other: 'title', filename2: 'keep me', skill_name: 'pdf', t: null, e: '', n: 3,
})
const out = redact(payload)
let parsed = null
try { parsed = JSON.parse(out) } catch { /* reported below */ }
ok('result is still valid JSON', parsed !== null)
ok('top-level filename nulled (escaped quote + backslash inside)', parsed?.filename === null)
ok('nested title nulled (non-ASCII inside)', parsed?.nested?.title === null)
ok('filename inside an array nulled (escaped newline inside)', parsed?.nested?.list?.[0]?.filename === null)
ok('a VALUE that reads "title" is untouched', parsed?.other === 'title')
ok('artifact description nulled', parsed?.description === null)
ok('similar and config keys (filename2, skill_name) are untouched', parsed?.filename2 === 'keep me' && parsed?.skill_name === 'pdf')
ok('non-string values untouched', parsed?.t === null && parsed?.e === '' && parsed?.n === 3)
ok('empty-string names become null', JSON.parse(redact(JSON.stringify({ filename: '' }))).filename === null)
ok('idempotent on an already-redacted payload', redact(out) === out)

ok('views defined for both org table families',
  /redactedView\('compliance_daily_redacted', 'compliance_daily'\)/.test(src)
  && /redactedView\('compliance_daily_org2_redacted', 'compliance_daily_org2'\)/.test(src))

console.log(`1..${n}`)
process.exit(failed ? 1 : 0)
