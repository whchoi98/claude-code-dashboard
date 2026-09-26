// Standalone ESM test for sanitizeAthenaQuery.
// Runs with: node tests/server/test-athena-sanitizer.mjs
// Exit code 0 on success, 1 on any failure (TAP-like output).

import { sanitizeAthenaQuery } from '../../server/aws.js'

const cases = [
  // [ description, query, expect: 'pass' | substring of expected error ]
  ['valid single SELECT',             "SELECT * FROM claude_code_analytics WHERE date='2026-04-19'", 'pass'],
  ['valid WITH/CTE alias resolves',   "WITH t AS (SELECT user_email FROM claude_code_analytics) SELECT * FROM t", 'pass'],
  ['multiple CTEs',                   "WITH a AS (SELECT 1 FROM claude_code_analytics), b AS (SELECT 1 FROM summaries_daily) SELECT * FROM a JOIN b ON a.c=b.c", 'pass'],
  ['trailing semicolon only',         "SELECT 1 FROM claude_code_analytics;", 'pass'],
  ['schema-qualified table',          "SELECT 1 FROM claude_code_analytics.claude_code_analytics", 'pass'],
  ['table alias',                     "SELECT a.user_email FROM claude_code_analytics a JOIN summaries_daily s ON a.date=s.date", 'pass'],
  ['org2 twin table allowed',         "SELECT 1 FROM claude_code_analytics_org2 WHERE date='2026-07-01'", 'pass'],
  ['org2 compliance twin allowed',    "SELECT type FROM compliance_daily_org2 WHERE date='2026-07-01'", 'pass'],
  ['org3 twin does not exist',        "SELECT 1 FROM claude_code_analytics_org3", 'Table not allowed'],

  // Injection attempts
  ['multi-statement chained',         "SELECT 1 FROM claude_code_analytics; DROP TABLE users", 'Multi-statement'],
  ['line comment hiding ;',           "SELECT 1 FROM claude_code_analytics /* ; DROP */; DROP TABLE x", 'Multi-statement'],
  ['subquery reading unknown table',  "SELECT * FROM (SELECT * FROM secrets_table) x", 'Table not allowed'],
  ['union to information_schema',     "SELECT 1 FROM claude_code_analytics UNION SELECT * FROM information_schema.tables", 'Table not allowed'],
  ['forbidden DELETE keyword',        "SELECT 1 FROM claude_code_analytics WHERE id IN (DELETE FROM x)", 'Forbidden'],
  ['forbidden UPDATE keyword',        "SELECT 1 FROM claude_code_analytics /* then */ UPDATE x SET y=1", 'Forbidden'],
  ['INSERT statement',                "INSERT INTO x VALUES(1)", 'Only SELECT'],
  ['DESCRIBE statement',              "DESCRIBE claude_code_analytics", 'Only SELECT'],
  ['SHOW TABLES',                     "SHOW TABLES", 'Only SELECT'],
  ['unknown table direct',            "SELECT * FROM secrets_table", 'Table not allowed'],
  ['empty query',                     "", 'non-empty'],
  ['line-comment only (no body)',     "-- harmless\n", 'Only SELECT'],
]

// Archived audit names (pre-2026-09-24): non-admin sessions must run against the
// name-redacted views wherever a base table is named; verified admins
// (revealAuditNames) keep the base tables. [desc, query, reveal, check(sql)]
const redactCases = [
  ['masked: FROM rewritten to the view', "SELECT payload FROM compliance_daily WHERE date='2026-09-01'", false,
    (q) => /FROM compliance_daily_redacted WHERE/.test(q) && !/\bcompliance_daily\b/.test(q)],
  ['masked: org2 twin rewritten', "SELECT 1 FROM compliance_daily_org2", false,
    (q) => q.includes('compliance_daily_org2_redacted') && !/\bcompliance_daily_org2\b/.test(q)],
  ['masked: comma join → both sides', "SELECT * FROM claude_code_analytics a, compliance_daily c", false,
    (q) => q.includes('compliance_daily_redacted c') && !/\bcompliance_daily\b/.test(q)],
  ['masked: quoted + upper case', 'SELECT * FROM claude_code_analytics."COMPLIANCE_DAILY"', false,
    (q) => /compliance_daily_redacted/i.test(q) && !/"COMPLIANCE_DAILY"/.test(q)],
  ['masked: subquery + qualified column', "SELECT compliance_daily.payload FROM (SELECT * FROM compliance_daily) compliance_daily", false,
    (q) => !/\bcompliance_daily\b/i.test(q) && (q.match(/compliance_daily_redacted/g) || []).length === 3],
  ['masked: view name not double-rewritten', "SELECT 1 FROM compliance_daily_redacted", false,
    (q) => q === "SELECT 1 FROM compliance_daily_redacted"],
  ['masked: other tables untouched', "SELECT 1 FROM claude_code_analytics", false,
    (q) => q === "SELECT 1 FROM claude_code_analytics"],
  ['admin: base table kept', "SELECT json_extract_scalar(payload, '$.filename') FROM compliance_daily WHERE date='2026-09-01'", true,
    (q) => /FROM compliance_daily WHERE/.test(q) && !q.includes('_redacted')],
  ['default is the redacted form', "SELECT 1 FROM compliance_daily", undefined,
    (q) => q.includes('compliance_daily_redacted')],
]

let pass = 0
let fail = 0
let testNum = 0

console.log('TAP version 13')
console.log(`1..${cases.length + redactCases.length}`)

for (const [desc, query, expect] of cases) {
  testNum += 1
  try {
    sanitizeAthenaQuery(query)
    if (expect === 'pass') {
      console.log(`ok ${testNum} - ${desc}`)
      pass += 1
    } else {
      console.log(`not ok ${testNum} - ${desc}`)
      console.log(`  ---`)
      console.log(`  expected: error containing "${expect}"`)
      console.log(`  got:      no error (query passed)`)
      console.log(`  ---`)
      fail += 1
    }
  } catch (err) {
    if (expect === 'pass') {
      console.log(`not ok ${testNum} - ${desc}`)
      console.log(`  ---`)
      console.log(`  expected: pass`)
      console.log(`  got:      ${err.message}`)
      console.log(`  ---`)
      fail += 1
    } else if (err.message.toLowerCase().includes(expect.toLowerCase())) {
      console.log(`ok ${testNum} - ${desc}`)
      pass += 1
    } else {
      console.log(`not ok ${testNum} - ${desc}`)
      console.log(`  ---`)
      console.log(`  expected: error containing "${expect}"`)
      console.log(`  got:      ${err.message}`)
      console.log(`  ---`)
      fail += 1
    }
  }
}

for (const [desc, query, reveal, check] of redactCases) {
  testNum += 1
  let got
  try { got = reveal === undefined ? sanitizeAthenaQuery(query) : sanitizeAthenaQuery(query, { revealAuditNames: reveal }) } catch (err) { got = `ERROR ${err.message}` }
  const good = typeof got === 'string' && !got.startsWith('ERROR') && check(got)
  console.log(`${good ? 'ok' : 'not ok'} ${testNum} - ${desc}${good ? '' : ` (got: ${got})`}`)
  if (good) pass += 1; else fail += 1
}

console.log(`# passed: ${pass} / ${pass + fail} (failed: ${fail})`)
process.exit(fail === 0 ? 0 : 1)
