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

// Robustness inherited from parseCsv: a leading UTF-8 BOM (Excel/Sheets export)
// must not break header detection; CRLF endings + quoted emails containing a
// comma must parse correctly.
;(() => {
  const bom = parseGroupMap('﻿email,group\na@x.com,Platform')
  ok('leading UTF-8 BOM is stripped (Excel export)', bom.map['a@x.com'] === 'Platform')
  const crlf = parseGroupMap('email,group\r\nb@y.com,Apps\r\n')
  ok('CRLF line endings parse', crlf.map['b@y.com'] === 'Apps')
  const quoted = parseGroupMap('email,group\n"weird,comma@x.com",Data')
  ok('quoted email containing a comma parses', quoted.map['weird,comma@x.com'] === 'Data')
})()

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
