// Round-trip test for the collector flatten ↔ server inflate contract.
// node tests/server/test-flatten-inflate.mjs — exit 0 on success, 1 on failure.
import { flattenUser, flattenSkill, flattenConnector, flattenProject, flattenPlugin, flattenArtifact } from '../../collector/flatten.js'
import { inflateUser, withUserShape } from '../../server/inflate.js'

let n = 0, failed = 0
const ok = (name, cond) => { n++; console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${name}`); if (!cond) failed++ }

// A synthetic Analytics-API user record covering every metric group.
const record = {
  user: { id: 'u1', email_address: 'a@acme.com' },
  chat_metrics: { distinct_conversation_count: 3, message_count: 40, thinking_message_count: 5, distinct_files_uploaded_count: 2, distinct_artifacts_created_count: 1, distinct_skills_used_count: 4, connectors_used_count: 2 },
  claude_code_metrics: {
    core_metrics: { distinct_session_count: 7, commit_count: 9, pull_request_count: 2, lines_of_code: { added_count: 100, removed_count: 20 } },
    tool_actions: {
      edit_tool: { accepted_count: 10, rejected_count: 1 },
      multi_edit_tool: { accepted_count: 5, rejected_count: 0 },
      write_tool: { accepted_count: 3, rejected_count: 2 },
      notebook_edit_tool: { accepted_count: 1, rejected_count: 0 },
    },
  },
  web_search_count: 8,
  cowork_metrics: {
    distinct_session_count: 2, action_count: 11, dispatch_turn_count: 4, message_count: 6,
    file_edit_count: 3, edit_tool_count: 2, multi_edit_tool_count: null,
    write_tool_count: 0, notebook_edit_tool_count: null, sessions_with_file_edits_count: 1,
  },
  office_metrics: {
    excel:      { distinct_session_count: 1, message_count: 2, skills_used_count: 3, distinct_skills_used_count: 4, connectors_used_count: 5, distinct_connectors_used_count: 6 },
    powerpoint: { distinct_session_count: 7, message_count: 8, skills_used_count: 9, distinct_skills_used_count: 10, connectors_used_count: 11, distinct_connectors_used_count: 12 },
    word:       { distinct_session_count: 13, message_count: 14, skills_used_count: 15, distinct_skills_used_count: 16, connectors_used_count: 17, distinct_connectors_used_count: 18 },
    outlook:    { distinct_session_count: 19, message_count: 20, skills_used_count: 21, distinct_skills_used_count: 22, connectors_used_count: 23, distinct_connectors_used_count: 24 },
  },
  design_metrics: { distinct_session_count: 30, distinct_projects_used_count: 31, distinct_projects_created_count: 32, message_count: 33 },
}

const flat = flattenUser(record)
const round = inflateUser(flat)
const empty = flattenUser({ user: { id: 'x', email_address: 'x@y.com' } })

// --- Task 1: existing-field characterization (behavior preserved by extraction) ---
ok('flatten keeps user id/email', flat.user_id === 'u1' && flat.user_email === 'a@acme.com')
ok('round-trip chat messages', round.chat_metrics.message_count === 40)
ok('round-trip cc loc added', round.claude_code_metrics.core_metrics.lines_of_code.added_count === 100)
ok('round-trip edit_tool accepted', round.claude_code_metrics.tool_actions.edit_tool.accepted_count === 10)
ok('round-trip cowork existing', round.cowork_metrics.distinct_session_count === 2 && round.cowork_metrics.action_count === 11)
ok('round-trip web_search_count', round.web_search_count === 8)

// flattenSkill / flattenConnector smoke (extracted in Task 1; exercise field maps + zero-defaults)
const skill = flattenSkill({ skill_name: 'pdf', distinct_user_count: 5, chat_metrics: { distinct_conversation_skill_used_count: 12 }, claude_code_metrics: { distinct_session_skill_used_count: 7 }, cowork_metrics: { distinct_session_skill_used_count: 2 } })
ok('flattenSkill maps fields', skill.skill_name === 'pdf' && skill.distinct_users === 5 && skill.chat_uses === 12 && skill.claude_code_uses === 7 && skill.cowork_uses === 2)
ok('flattenSkill zero-defaults sparse input', flattenSkill({ skill_name: 'x' }).chat_uses === 0 && flattenSkill({ skill_name: 'x' }).distinct_users === 0)
const conn = flattenConnector({ connector_name: 'github', distinct_user_count: 9, chat_metrics: { distinct_conversation_connector_used_count: 4 }, claude_code_metrics: { distinct_session_connector_used_count: 3 }, cowork_metrics: { distinct_session_connector_used_count: 1 } })
ok('flattenConnector maps fields', conn.connector_name === 'github' && conn.distinct_users === 9 && conn.chat_uses === 4 && conn.claude_code_uses === 3 && conn.cowork_uses === 1)
ok('flattenConnector zero-defaults sparse input', flattenConnector({ connector_name: 'y' }).chat_uses === 0)

// --- Task 2: office_metrics (4 surfaces incl. outlook) ---
ok('flatten office outlook messages', flat.office_outlook_messages === 20)
ok('flatten office excel distinct_connectors', flat.office_excel_distinct_connectors === 6)
ok('round-trip office word skills_used', round.office_metrics.word.skills_used_count === 15)
ok('round-trip office outlook present (4th surface)', round.office_metrics.outlook.distinct_session_count === 19)
ok('office surfaces = excel,outlook,powerpoint,word', Object.keys(round.office_metrics).sort().join(',') === 'excel,outlook,powerpoint,word')
ok('absent office_metrics → 0', empty.office_excel_sessions === 0 && empty.office_outlook_messages === 0)

// --- Task 3: cowork tool-edit (null-preserving) + design_metrics ---
ok('flatten cowork file_edit_count', flat.cowork_file_edit_count === 3)
ok('flatten cowork edit_tool_count', flat.cowork_edit_tool_count === 2)
ok('flatten cowork sessions_with_file_edits_count', flat.cowork_sessions_with_file_edits_count === 1)
ok('flatten cowork null preserved (not 0)', flat.cowork_multi_edit_tool_count === null && flat.cowork_notebook_edit_tool_count === null)
ok('flatten cowork real 0 preserved (not null)', flat.cowork_write_tool_count === 0)
ok('round-trip cowork tool-edit value', round.cowork_metrics.file_edit_count === 3)
ok('round-trip cowork null stays null', round.cowork_metrics.multi_edit_tool_count === null)
ok('round-trip cowork real 0 stays 0', round.cowork_metrics.write_tool_count === 0)
ok('flatten design', flat.design_sessions === 30 && flat.design_projects_created === 32)
ok('round-trip design_metrics', round.design_metrics.distinct_session_count === 30 && round.design_metrics.message_count === 33)
ok('absent cowork tool-edit → null', empty.cowork_file_edit_count === null)
ok('absent design → 0', empty.design_sessions === 0)

// --- Task 4: schema-drift guard (flatten must emit every documented new column) ---
// Keep NEW_COLUMNS in sync with flattenUser (collector/flatten.js), USER_COLUMNS
// (infra/lib/storage-stack.ts), and collector/glue-schemas.md — all list the same names.
const NEW_COLUMNS = [
  'office_excel_sessions','office_excel_messages','office_excel_skills_used','office_excel_distinct_skills','office_excel_connectors_used','office_excel_distinct_connectors',
  'office_powerpoint_sessions','office_powerpoint_messages','office_powerpoint_skills_used','office_powerpoint_distinct_skills','office_powerpoint_connectors_used','office_powerpoint_distinct_connectors',
  'office_word_sessions','office_word_messages','office_word_skills_used','office_word_distinct_skills','office_word_connectors_used','office_word_distinct_connectors',
  'office_outlook_sessions','office_outlook_messages','office_outlook_skills_used','office_outlook_distinct_skills','office_outlook_connectors_used','office_outlook_distinct_connectors',
  'cowork_file_edit_count','cowork_edit_tool_count','cowork_multi_edit_tool_count','cowork_write_tool_count','cowork_notebook_edit_tool_count','cowork_sessions_with_file_edits_count',
  'design_sessions','design_projects_used','design_projects_created','design_messages',
]
const flatKeys = new Set(Object.keys(flat))
ok('flatten emits all 34 documented new columns', NEW_COLUMNS.every((c) => flatKeys.has(c)) && NEW_COLUMNS.length === 34)

// --- Step 7: flattenProject (created_by flattened; sparse → null/0) ---
const proj = flattenProject({ project_id: 'p1', project_name: 'Demo', distinct_user_count: 3, distinct_conversation_count: 5, message_count: 40, created_at: '2026-04-10T09:08:43Z', created_by: { id: 'u9', email_address: 'a@acme.com' } })
ok('flattenProject maps scalars', proj.project_id === 'p1' && proj.project_name === 'Demo' && proj.distinct_user_count === 3 && proj.distinct_conversation_count === 5 && proj.message_count === 40 && proj.created_at === '2026-04-10T09:08:43Z')
ok('flattenProject flattens created_by', proj.created_by_id === 'u9' && proj.created_by_email === 'a@acme.com')
const projSparse = flattenProject({ project_id: 'p2' })
ok('flattenProject sparse → null/0', projSparse.created_by_id === null && projSparse.created_by_email === null && projSparse.message_count === 0 && projSparse.created_at === null)
// drift guard: flattenProject must emit exactly the 8 documented PROJECT_COLUMNS (+ snapshot_date added by the writer)
const PROJECT_COLUMN_NAMES = ['project_id','project_name','distinct_user_count','distinct_conversation_count','message_count','created_at','created_by_id','created_by_email']
ok('flattenProject emits exactly its 8 documented columns', PROJECT_COLUMN_NAMES.every((c) => c in proj) && Object.keys(proj).length === 8)

// --- Step 8: v2.2 additions — last_activity_date + cowork plugins/artifacts ---
// Feature-flag semantics: absent upstream field must flatten to NULL, never 0
// (null = org not enabled, 0 = no activity — the UI renders them differently).
{
  const rich = flattenUser({
    user: { id: 'u3', email_address: 'c@acme.com' },
    last_activity_date: '2026-08-23',
    cowork_metrics: { plugins_used_count: 7, distinct_plugins_used_count: 2, artifacts_created_count: 5 },
  })
  ok('flattenUser maps last_activity_date', rich.last_activity_date === '2026-08-23')
  ok('flattenUser maps cowork plugin counters', rich.cowork_plugins_used === 7 && rich.cowork_distinct_plugins === 2)
  ok('flattenUser maps cowork artifacts_created', rich.cowork_artifacts_created === 5)

  const sparse = flattenUser({ user: { id: 'u4', email_address: 'd@acme.com' } })
  ok('absent last_activity_date → null (staged rollout, never 0/empty)', sparse.last_activity_date === null)
  ok('absent cowork plugin/artifact counters → null, never 0',
    sparse.cowork_plugins_used === null && sparse.cowork_distinct_plugins === null && sparse.cowork_artifacts_created === null)

  const round = inflateUser(rich)
  ok('inflate restores last_activity_date', round.last_activity_date === '2026-08-23')
  ok('inflate restores cowork plugin/artifact counters',
    round.cowork_metrics.plugins_used_count === 7 && round.cowork_metrics.distinct_plugins_used_count === 2
    && round.cowork_metrics.artifacts_created_count === 5)
  const roundSparse = inflateUser(sparse)
  ok('inflate keeps null semantics for feature-flag fields',
    roundSparse.last_activity_date === null && roundSparse.cowork_metrics.plugins_used_count === null
    && roundSparse.cowork_metrics.artifacts_created_count === null)
}

// --- Step 9: flattenPlugin (new plugins_daily table, probed 2026-08-27) ---
{
  const p = flattenPlugin({
    plugin_name: 'serena', plugin_id: 'serena@claude-plugins-official',
    distinct_user_count: 4, install_count: 2, invocation_count: 19,
    claude_code_metrics: { distinct_session_plugin_used_count: 6 },
    cowork_metrics: { distinct_session_plugin_used_count: 1 },
  })
  ok('flattenPlugin maps scalars', p.plugin_name === 'serena' && p.plugin_id === 'serena@claude-plugins-official'
    && p.distinct_users === 4 && p.install_count === 2 && p.invocation_count === 19)
  ok('flattenPlugin maps surface uses', p.claude_code_uses === 6 && p.cowork_uses === 1)
  const sparse = flattenPlugin({ plugin_name: 'co-agent' })
  ok('flattenPlugin sparse → null id, 0 counts', sparse.plugin_id === null && sparse.distinct_users === 0
    && sparse.install_count === 0 && sparse.invocation_count === 0 && sparse.claude_code_uses === 0 && sparse.cowork_uses === 0)
  const PLUGIN_COLUMN_NAMES = ['plugin_name', 'plugin_id', 'distinct_users', 'install_count', 'invocation_count', 'claude_code_uses', 'cowork_uses', 'unified_session_uses']
  ok('flattenPlugin emits exactly its 8 documented columns', PLUGIN_COLUMN_NAMES.every((c) => c in p) && Object.keys(p).length === 8)
}

// ── withUserShape: raw sidecar rows keep the full nested shape ──────────────
{
  const sparseRaw = {
    user: { id: 'u1', email_address: 'a@x.com' },
    chat_metrics: { message_count: 7, distinct_projects_used_count: 3 },
    cowork_metrics: { distinct_session_count: 2, artifacts_created_count: null },
    office_metrics: null,
    extra_field: 'kept',
  }
  const u = withUserShape(sparseRaw)
  ok('raw values win', u.chat_metrics.message_count === 7 && u.chat_metrics.distinct_projects_used_count === 3)
  ok('missing counters come from the skeleton', u.chat_metrics.distinct_conversation_count === 0)
  ok('missing nested objects exist', typeof u.office_metrics.word.distinct_session_count === 'number'
    && typeof u.claude_code_metrics.core_metrics.lines_of_code.added_count === 'number')
  ok('explicit null counter stays null (not reported ≠ 0)', u.cowork_metrics.artifacts_created_count === null)
  ok('a null nested object keeps the skeleton shape', typeof u.office_metrics.excel === 'object')
  ok('identity + unknown extra fields preserved', u.user.email_address === 'a@x.com' && u.extra_field === 'kept')
  ok('raw input is not mutated', sparseRaw.office_metrics === null && !('claude_code_metrics' in sparseRaw))
}

// Chat and Cowork unified (2026-10) — shapes copied from raw/users, raw/skills,
// raw/connectors, raw/plugins (org2, 2026-10-25).
{
  const unifiedRecord = {
    ...record,
    chat_metrics: { ...record.chat_metrics, message_count: 0 },
    chat_cowork_unified_metrics: {
      chat: { distinct_conversation_count: 2, message_count: 20, thinking_message_count: 3, distinct_files_uploaded_count: 1, distinct_artifacts_created_count: 1, distinct_skills_used_count: 2, connectors_used_count: 4, distinct_shared_artifacts_viewed_count: null },
      sessions: { distinct_session_count: 1, message_count: 6, action_count: 9, dispatch_turn_count: 2, file_edit_count: 3, skills_used_count: 1, plugins_used_count: 0, artifacts_created_count: 1 },
    },
  }
  const flat = flattenUser(unifiedRecord)
  ok('unified: chat counters flatten to unified_chat_*', flat.unified_chat_messages === 20 && flat.unified_chat_conversations === 2 && flat.unified_chat_connectors === 4)
  ok('unified: session counters flatten to unified_session*', flat.unified_sessions === 1 && flat.unified_session_actions === 9 && flat.unified_session_file_edit_count === 3)
  const back = inflateUser(flat)
  ok('unified: roundtrip rebuilds both blocks', back.chat_cowork_unified_metrics?.chat?.message_count === 20
    && back.chat_cowork_unified_metrics?.sessions?.distinct_session_count === 1
    && back.chat_cowork_unified_metrics?.sessions?.artifacts_created_count === 1)
  ok('unified: a reported 0 stays 0 (plugins_used_count)', back.chat_cowork_unified_metrics.sessions.plugins_used_count === 0)

  const plainFlat = flattenUser(record)
  ok('unified: absent block flattens to NULL, never 0', plainFlat.unified_chat_messages === null && plainFlat.unified_sessions === null)
  ok('unified: absent block is omitted on inflate (upstream shape)', !('chat_cowork_unified_metrics' in inflateUser(plainFlat)))
  ok('unified: pre-column partitions (keys missing) inflate without the block', !('chat_cowork_unified_metrics' in inflateUser({ user_id: 'u', user_email: 'e' })))

  const skill = flattenSkill({ skill_name: 's', distinct_user_count: 1, chat_metrics: { distinct_conversation_skill_used_count: 0 }, claude_code_metrics: {}, cowork_metrics: {}, chat_cowork_unified_metrics: { chat: { distinct_conversation_skill_used_count: 3 }, sessions: { distinct_session_skill_used_count: 2 } } })
  ok('unified: skill row → unified_chat_uses / unified_session_uses', skill.unified_chat_uses === 3 && skill.unified_session_uses === 2)
  ok('unified: skill row without the block → NULL', flattenSkill({ skill_name: 's' }).unified_chat_uses === null)
  const conn = flattenConnector({ connector_name: 'c', chat_cowork_unified_metrics: { chat: { distinct_conversation_connector_used_count: 5 }, sessions: { distinct_session_connector_used_count: 1 } } })
  ok('unified: connector row → unified_*_uses', conn.unified_chat_uses === 5 && conn.unified_session_uses === 1)
  const plug = flattenPlugin({ plugin_name: 'p', chat_cowork_unified_metrics: { distinct_session_plugin_used_count: 4 } })
  ok('unified: plugin row reads the FLAT unified block', plug.unified_session_uses === 4)

  // Glue drift guard against the REAL table definitions: every column a
  // flatten helper writes must exist in its storage-stack.ts column list, or
  // Athena silently never sees it.
  const { readFileSync } = await import('node:fs')
  const stack = readFileSync(new URL('../../infra/lib/storage-stack.ts', import.meta.url), 'utf8')
  const colsOf = (name) => {
    const m = stack.match(new RegExp(`const ${name}[^=]*= \\[([\\s\\S]*?)\\n\\]`))
    return new Set([...(m?.[1] ?? '').matchAll(/name: '([a-z0-9_]+)'/g)].map((x) => x[1]))
  }
  const missingIn = (keys, cols) => keys.filter((k) => !cols.has(k))
  ok('Glue USER_COLUMNS holds every flattenUser column', missingIn(Object.keys(flat), colsOf('USER_COLUMNS')).length === 0)
  ok('Glue SKILL_COLUMNS holds every flattenSkill column', missingIn(Object.keys(skill), colsOf('SKILL_COLUMNS')).length === 0)
  ok('Glue PLUGIN_COLUMNS holds every flattenPlugin column', missingIn(Object.keys(plug), colsOf('PLUGIN_COLUMNS')).length === 0)

  // analytics/artifacts rows (group_by[]=product), per the 2026-10 reference.
  const art = flattenArtifact({ product: 'chat_cowork_unified', artifact_type: 'text/markdown', is_shared: true, artifacts_created_count: 4, published_artifacts_created_count: 1, distinct_user_count: 3 })
  ok('flattenArtifact maps every field', art.product === 'chat_cowork_unified' && art.artifact_type === 'text/markdown' && art.is_shared === true
    && art.artifacts_created === 4 && art.published_artifacts_created === 1 && art.distinct_users === 3)
  const artSparse = flattenArtifact({})
  ok('flattenArtifact sparse → null dims, 0 counts', artSparse.product === null && artSparse.is_shared === null && artSparse.artifacts_created === 0)
  ok('Glue ARTIFACT_COLUMNS holds every flattenArtifact column', missingIn(Object.keys(art), colsOf('ARTIFACT_COLUMNS')).length === 0)
  ok('artifacts_daily (+ org2 twin) is a Glue table', /table\('artifacts_daily', ARTIFACT_COLUMNS, 'artifacts'\)/.test(stack)
    && /table\('artifacts_daily_org2', ARTIFACT_COLUMNS, 'org2\/artifacts'\)/.test(stack))
}

console.log(`\n1..${n}`)
process.exit(failed === 0 ? 0 : 1)
