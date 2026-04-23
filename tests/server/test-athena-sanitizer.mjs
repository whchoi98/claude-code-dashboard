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

let pass = 0
let fail = 0
let testNum = 0

console.log('TAP version 13')
console.log(`1..${cases.length}`)

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

console.log(`# passed: ${pass} / ${pass + fail} (failed: ${fail})`)
process.exit(fail === 0 ? 0 : 1)
