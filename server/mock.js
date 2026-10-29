// Mock generators mirroring the live Claude Enterprise Analytics API schemas.
// Deterministic per-date so charts look stable between reloads.

const USERS = [
  { id: 'u_01', email: 'alice.kim@acme.com' },
  { id: 'u_02', email: 'brian.park@acme.com' },
  { id: 'u_03', email: 'chloe.lee@acme.com' },
  { id: 'u_04', email: 'daniel.cho@acme.com' },
  { id: 'u_05', email: 'emma.jung@acme.com' },
  { id: 'u_06', email: 'felix.han@acme.com' },
  { id: 'u_07', email: 'grace.oh@acme.com' },
  { id: 'u_08', email: 'henry.shin@acme.com' },
  { id: 'u_09', email: 'irene.kwon@acme.com' },
  { id: 'u_10', email: 'james.yoon@acme.com' },
  { id: 'u_11', email: 'kate.ryu@acme.com' },
  { id: 'u_12', email: 'leo.moon@acme.com' },
  { id: 'u_13', email: 'mia.baek@acme.com' },
  { id: 'u_14', email: 'noah.seo@acme.com' },
  { id: 'u_15', email: 'olivia.jeon@acme.com' },
  { id: 'u_16', email: 'paul.ahn@acme.com' },
  { id: 'u_17', email: 'quinn.nam@acme.com' },
  { id: 'u_18', email: 'rachel.ko@acme.com' },
  { id: 'u_19', email: 'sam.hwang@acme.com' },
  { id: 'u_20', email: 'tina.jo@acme.com' },
]
const SEAT_COUNT = 25
// Per-product active users for the summaries mock (share of org-wide DAU/WAU/MAU).
const PRODUCT_SHARES = { claude_code: 0.6, chat: 0.5, claude_design: 0.12, office_agent: 0.06 }
function perProductActive({ dau, wau, mau }) {
  const out = {}
  for (const [product, share] of Object.entries(PRODUCT_SHARES)) {
    out[`${product}_daily_active_user_count`] = Math.floor(dau * share)
    out[`${product}_weekly_active_user_count`] = Math.floor(wau * share)
    out[`${product}_monthly_active_user_count`] = Math.floor(mau * share)
  }
  return out
}
const SHARE_STATUSES = ['organization', 'private', 'public', null]

const SKILLS = [
  'code-review', 'pdf-processing', 'webapp-testing', 'sql-generator',
  'doc-writer', 'data-analysis', 'diagram-builder', 'test-generator',
]
const CONNECTORS = ['github', 'gitlab', 'jira', 'confluence', 'slack', 'notion', 'google-drive']
const PLUGINS = ['superpowers', 'pr-review-toolkit', 'context7', 'playwright', 'deploy-on-aws', 'serena']
const PROJECTS = [
  'billing-service-refactor', 'mobile-app-v3', 'data-pipeline',
  'customer-support-bot', 'infra-migration', 'security-audit',
]

function hashSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function rng(seed) {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}
function dowFactor(date) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay()
  if (d === 0 || d === 6) return 0.25
  if (d === 1 || d === 5) return 0.85
  return 1
}

function emptyOffice() {
  return {
    distinct_session_count: 0, message_count: 0,
    skills_used_count: 0, distinct_skills_used_count: 0,
    connectors_used_count: 0, distinct_connectors_used_count: 0,
  }
}

function mockUserRecord(user, date, rand, factor) {
  const active = rand() < 0.75 * factor
  const chatConvos = active ? Math.floor(1 + rand() * 8 * factor) : 0
  const chatMessages = chatConvos === 0 ? 0 : Math.floor(chatConvos * (4 + rand() * 10))
  const ccActive = active && rand() < 0.7
  const ccSessions = ccActive ? Math.floor(1 + rand() * 5 * factor) : 0
  const linesAdded = ccSessions === 0 ? 0 : Math.floor((30 + rand() * 260) * ccSessions)
  const linesRemoved = ccSessions === 0 ? 0 : Math.floor(linesAdded * (0.1 + rand() * 0.4))
  const commits = ccSessions === 0 ? 0 : Math.floor(rand() * 3)
  const prs = ccSessions === 0 ? 0 : (rand() < 0.2 ? 1 : 0)

  const tool = (rate) => {
    if (ccSessions === 0) return { accepted_count: 0, rejected_count: 0 }
    const total = Math.floor((5 + rand() * 40) * ccSessions)
    const accepted = Math.floor(total * rate)
    return { accepted_count: accepted, rejected_count: total - accepted }
  }

  return {
    user: { id: user.id, email_address: user.email },
    chat_metrics: {
      distinct_conversation_count: chatConvos,
      message_count: chatMessages,
      thinking_message_count: chatMessages > 0 ? Math.floor(chatMessages * 0.4) : 0,
      distinct_projects_used_count: active && rand() < 0.3 ? 1 + Math.floor(rand() * 2) : 0,
      distinct_projects_created_count: active && rand() < 0.12 ? 1 : 0,
      distinct_artifacts_created_count: active && rand() < 0.25 ? Math.floor(1 + rand() * 3) : 0,
      distinct_skills_used_count: active && rand() < 0.3 ? Math.floor(1 + rand() * 2) : 0,
      connectors_used_count: active && rand() < 0.25 ? Math.floor(1 + rand() * 3) : 0,
      distinct_files_uploaded_count: active && rand() < 0.35 ? Math.floor(1 + rand() * 4) : 0,
      shared_conversations_viewed_count: 0,
      distinct_shared_artifacts_viewed_count: 0,
    },
    claude_code_metrics: {
      core_metrics: {
        distinct_session_count: ccSessions,
        commit_count: commits,
        pull_request_count: prs,
        lines_of_code: { added_count: linesAdded, removed_count: linesRemoved },
      },
      tool_actions: {
        edit_tool: tool(0.82 + rand() * 0.1),
        multi_edit_tool: tool(0.78 + rand() * 0.1),
        write_tool: tool(0.75 + rand() * 0.15),
        notebook_edit_tool: tool(0.70 + rand() * 0.2),
      },
    },
    office_metrics: {
      excel: emptyOffice(),
      powerpoint: emptyOffice(),
      word: emptyOffice(),
      outlook: emptyOffice(),
    },
    cowork_metrics: {
      distinct_session_count: ccActive && rand() < 0.3 ? Math.floor(1 + rand() * 3) : 0,
      action_count: 0,
      dispatch_turn_count: 0,
      message_count: 0,
      file_edit_count: null,
      edit_tool_count: null,
      multi_edit_tool_count: null,
      write_tool_count: null,
      notebook_edit_tool_count: null,
      sessions_with_file_edits_count: null,
      skills_used_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_connectors_used_count: 0,
    },
    design_metrics: {
      distinct_session_count: 0,
      distinct_projects_used_count: 0,
      distinct_projects_created_count: 0,
      message_count: 0,
    },
    web_search_count: active ? Math.floor(rand() * 12) : 0,
  }
}

// Chat and Cowork unified: a deployment that offers it carries the block on
// EVERY user row (zeros for users not on it). Every fourth mock user is on the
// unified experience — their chat and Cowork activity MOVES into the block,
// exactly as upstream reports it. Pure re-shaping: no extra rand() calls, so
// every other mock value stays stable.
const zeroed = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? null : 0]))
function withUnified(rec, onUnified) {
  if (!onUnified) {
    return { ...rec, chat_cowork_unified_metrics: { chat: { ...zeroed(rec.chat_metrics), distinct_connectors_used_count: 0 }, sessions: zeroed(rec.cowork_metrics) } }
  }
  return {
    ...rec,
    chat_metrics: zeroed(rec.chat_metrics),
    cowork_metrics: zeroed(rec.cowork_metrics),
    chat_cowork_unified_metrics: {
      chat: { ...rec.chat_metrics, distinct_connectors_used_count: rec.chat_metrics.connectors_used_count > 0 ? 1 : 0 },
      sessions: { ...rec.cowork_metrics },
    },
  }
}

export const generateMock = {
  users(date) {
    const rand = rng(hashSeed(date))
    const factor = dowFactor(date)
    const data = USERS.map((u, i) => withUnified(mockUserRecord(u, date, rand, factor), i % 4 === 3))
    return { data, has_more: false, next_page: null }
  },

  summaries(startingDate, endingDate) {
    const out = []
    const start = new Date(`${startingDate}T00:00:00Z`)
    const end = new Date(`${endingDate}T00:00:00Z`)
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10)
      const rand = rng(hashSeed(date))
      const factor = dowFactor(date)
      const dau = Math.floor(USERS.length * (0.45 + rand() * 0.35) * factor)
      const wau = Math.min(USERS.length, Math.floor(dau * (1.4 + rand() * 0.4)))
      const mau = Math.min(USERS.length, Math.floor(wau * (1.1 + rand() * 0.2)))
      const nextDay = new Date(t + 86400000).toISOString().slice(0, 10)
      out.push({
        starting_at: `${date}T00:00:00Z`,
        ending_at: `${nextDay}T00:00:00Z`,
        daily_active_user_count: dau,
        weekly_active_user_count: wau,
        monthly_active_user_count: mau,
        cowork_daily_active_user_count: Math.floor(dau * 0.15),
        cowork_weekly_active_user_count: Math.floor(wau * 0.2),
        cowork_monthly_active_user_count: Math.floor(mau * 0.25),
        // Per-product breakdown, derived (no extra rand() calls — keeps every
        // other mock value stable). science_* is deliberately OMITTED: an org
        // without that product reports no field at all (absent ≠ 0).
        ...perProductActive({ dau, wau, mau }),
        // Derived like the per-product counts (no rand()); NOT additive with chat_/cowork_.
        chat_cowork_unified_daily_active_user_count: Math.floor(dau * 0.2),
        chat_cowork_unified_weekly_active_user_count: Math.floor(wau * 0.22),
        chat_cowork_unified_monthly_active_user_count: Math.floor(mau * 0.25),
        assigned_seat_count: SEAT_COUNT,
        pending_invite_count: Math.max(0, Math.floor(2 + rand() * 3)),
        daily_adoption_rate:   Number(((dau / SEAT_COUNT) * 100).toFixed(2)),
        weekly_adoption_rate:  Number(((wau / SEAT_COUNT) * 100).toFixed(2)),
        monthly_adoption_rate: Number(((mau / SEAT_COUNT) * 100).toFixed(2)),
      })
    }
    return { data: out, has_more: false, next_page: null }
  },

  skills(date) {
    const rand = rng(hashSeed(date) ^ 0xA11)
    const data = SKILLS.map((name, i) => {
      const distinctUsers = Math.floor(1 + rand() * 10)
      return {
        skill_name: name,
        skill_display_name: null,
        distinct_user_count: distinctUsers,
        // Derived fields (no rand() — existing mock values stay unchanged).
        invocation_count: distinctUsers * 3 + i,
        share_status: SHARE_STATUSES[i % SHARE_STATUSES.length],
        currency: 'USD',
        estimated_overage_spend: (distinctUsers * 137.5 + i * 11).toFixed(4),
        attributed_list_price: (distinctUsers * 412.25 + i * 23).toFixed(4),
        chat_metrics: { distinct_conversation_skill_used_count: Math.floor(distinctUsers * (1 + rand() * 3)) },
        claude_code_metrics: { distinct_session_skill_used_count: Math.floor(distinctUsers * (1 + rand() * 2)) },
        office_metrics: {
          excel: { distinct_session_skill_used_count: 0 },
          powerpoint: { distinct_session_skill_used_count: 0 },
          word: { distinct_session_skill_used_count: 0 },
        },
        cowork_metrics: { distinct_session_skill_used_count: Math.floor(rand() * 3) },
        // Derived (no rand()): unified chat / sessions skill uses.
        chat_cowork_unified_metrics: {
          chat: { distinct_conversation_skill_used_count: Math.floor(distinctUsers / 2) },
          sessions: { distinct_session_skill_used_count: i % 3 === 0 ? 1 : 0 },
        },
      }
    })
    return { data, has_more: false, next_page: null }
  },

  plugins(date) {
    const rand = rng(hashSeed(date) ^ 0x91C)
    const data = PLUGINS.map((name, i) => {
      const distinctUsers = Math.floor(1 + rand() * 12)
      return {
        plugin_name: name,
        plugin_id: `plg_${String(i + 1).padStart(3, '0')}`,
        distinct_user_count: distinctUsers,
        install_count: Math.floor(distinctUsers * (1 + rand())),
        invocation_count: Math.floor(distinctUsers * (2 + rand() * 6)),
        claude_code_metrics: { distinct_session_plugin_used_count: Math.floor(distinctUsers * (1 + rand() * 2)) },
        cowork_metrics: { distinct_session_plugin_used_count: Math.floor(rand() * 3) },
        // Flat on plugin rows, like upstream. Derived (no rand()).
        chat_cowork_unified_metrics: { distinct_session_plugin_used_count: i % 2 },
      }
    })
    // Upstream aggregate bucket for plugin activity reported without a name
    // (appended after the rand()-driven rows so their values stay stable).
    data.push({
      plugin_name: 'third-party', plugin_id: null,
      distinct_user_count: 2, install_count: 0, invocation_count: 5,
      claude_code_metrics: { distinct_session_plugin_used_count: 3 },
      cowork_metrics: { distinct_session_plugin_used_count: 0 },
    })
    return { data, has_more: false, next_page: null }
  },

  connectors(date) {
    const rand = rng(hashSeed(date) ^ 0xBEE)
    const data = CONNECTORS.map((name, i) => {
      const distinctUsers = Math.floor(1 + rand() * 14)
      return {
        connector_name: name,
        connector_display_name: null,
        distinct_user_count: distinctUsers,
        // Derived tool-call classification (no rand()).
        read_call_count: distinctUsers * 9 + i,
        write_call_count: distinctUsers * 2 + (i % 3),
        unclassified_call_count: distinctUsers + i,
        managed_auth_distinct_user_count: i % 2 === 0 ? Math.max(0, distinctUsers - 1) : null,
        individual_auth_distinct_user_count: i % 2 === 0 ? 1 : null,
        chat_metrics: { distinct_conversation_connector_used_count: Math.floor(distinctUsers * (1 + rand() * 2)) },
        claude_code_metrics: { distinct_session_connector_used_count: Math.floor(distinctUsers * (1 + rand() * 1.5)) },
        office_metrics: {
          excel: { distinct_session_connector_used_count: 0 },
          powerpoint: { distinct_session_connector_used_count: 0 },
          word: { distinct_session_connector_used_count: 0 },
        },
        cowork_metrics: { distinct_session_connector_used_count: Math.floor(rand() * 2) },
        chat_cowork_unified_metrics: {
          chat: { distinct_conversation_connector_used_count: Math.floor(distinctUsers / 3) },
          sessions: { distinct_session_connector_used_count: i % 4 === 0 ? 1 : 0 },
        },
      }
    })
    return { data, has_more: false, next_page: null }
  },

  projects(date) {
    const rand = rng(hashSeed(date) ^ 0xCAF)
    const data = PROJECTS.map((name, i) => {
      const users = Math.floor(1 + rand() * 8)
      const convos = Math.floor(users * (1 + rand() * 3))
      return {
        project_id: `proj_${String(i + 1).padStart(3, '0')}`,
        project_name: name,
        distinct_user_count: users,
        distinct_conversation_count: convos,
        message_count: Math.floor(convos * (3 + rand() * 8)),
        created_at: '2026-01-12T00:00:00Z',
        created_by: { id: USERS[i % USERS.length].id, email_address: USERS[i % USERS.length].email },
      }
    })
    return { data, has_more: false, next_page: null }
  },

  // users endpoint, rollup mode + group_by[]=rbac_group_id: one row per
  // group, metric objects summed over the window. Any-membership like
  // upstream — Leadership overlaps Engineering, so rows sum above the org.
  userGroups(startingDate, endingDate) {
    const dayRecs = []
    for (let t = Date.parse(`${startingDate}T00:00:00Z`); t <= Date.parse(`${endingDate}T00:00:00Z`); t += 86400000) {
      dayRecs.push(generateMock.users(new Date(t).toISOString().slice(0, 10)).data)
    }
    const data = MOCK_GROUPS.map((g) => {
      const ids = new Set(g.members.map((m) => m.id))
      const recs = dayRecs.flatMap((d) => d.filter((r) => ids.has(r.user.id)))
      const active = new Set(recs.filter((r) => r.chat_metrics.message_count + r.claude_code_metrics.core_metrics.distinct_session_count
        + r.chat_cowork_unified_metrics.chat.message_count > 0).map((r) => r.user.id))
      const totals = {}
      for (const { user: _u, last_activity_date: _l, ...rest } of recs) mergeSum(totals, rest)
      return { rbac_group_id: g.id, rbac_group_name: g.name, distinct_user_count: active.size, user: null, ...totals }
    })
    return { data, next_page: null }
  },

  // Raw Compliance directory walk (organizations → users + user_preferences),
  // the shape fetchDirectoryRaw returns. Instruction texts are synthetic.
  directory() {
    const roles = ['admin', 'developer', 'claude_code_user', 'claude_code_user', 'user', 'user', 'user']
    const users = USERS.map((u, i) => ({ id: u.id, email: u.email, organization_role: i === 0 ? 'primary_owner' : roles[i % roles.length] }))
    const prefs = USERS.map((u, i) => ({
      user: { id: u.id, email_address: u.email },
      conversation_preferences: i % 3 === 0 ? 'Keep answers brief and cite sources.' : null,
      cowork_global_instructions: i % 5 === 0 ? 'Work in the shared team folder; never delete files.' : null,
    }))
    return {
      orgs: [{ org: { uuid: '00000000-0000-4000-8000-000000000001', name: 'Acme' }, users: { ok: true, data: users }, prefs: { ok: true, data: prefs } }],
      truncated: false,
    }
  },

  // Plugins API listings → [plugins, marketplaces] for toPluginCatalog.
  pluginCatalog() {
    const marketplaces = [
      { id: 'marketplace_mock_internal', name: 'acme-internal', source: 'github' },
      { id: 'marketplace_mock_manual', name: 'Uploaded', source: 'manual' },
    ]
    const prefs = ['required', 'auto_install', 'available', 'not_available']
    const plugins = PLUGINS.slice(0, 4).map((name, i) => ({
      type: 'plugin', id: `plugin_mock_${i + 1}`, name, display_name: name.replace(/-/g, ' '),
      served_version_id: `pluginver_mock_${i}a`, served_version_pinned: i === 1,
      latest_version_id: i === 1 ? `pluginver_mock_${i}b` : `pluginver_mock_${i}a`,
      owner: i === 3 ? { type: 'user', user_id: USERS[3].id } : { type: 'organization' },
      marketplace_id: marketplaces[i % 2].id,
      organization_installation_preference: prefs[i], organization_installation_preference_inherited: i !== 0,
      content_scan: { status: i === 2 ? 'flagged' : 'passed' }, reach: i % 2 ? 'local' : 'remote',
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z',
    }))
    return [plugins, marketplaces]
  },

  // analytics/artifacts with group_by[]=product: product × MIME type × shared.
  artifacts(date) {
    const rand = rng(hashSeed(date) ^ 0xA27)
    const cells = [
      ['chat', 'text/markdown'], ['chat', 'application/vnd.ant.react'], ['chat', 'image/svg+xml'],
      ['claude_code', 'text/html'], ['cowork', 'text/html'], ['chat_cowork_unified', 'text/markdown'],
    ]
    const data = []
    for (const [product, type] of cells) {
      for (const shared of [false, true]) {
        const created = Math.floor(rand() * (shared ? 3 : 9))
        if (created === 0) continue
        data.push({
          product, artifact_type: type, is_shared: shared,
          artifacts_created_count: created,
          published_artifacts_created_count: shared ? Math.floor(created / 2) : 0,
          distinct_user_count: Math.max(1, Math.floor(created / 2)),
        })
      }
    }
    return { data, next_page: null }
  },
}

const MOCK_GROUPS = [
  { id: 'rbac_group_mock_eng', name: 'Engineering', members: USERS.slice(0, 10) },
  { id: 'rbac_group_mock_sales', name: 'Sales', members: USERS.slice(10, 15) },
  { id: 'rbac_group_mock_design', name: 'Design', members: USERS.slice(15, 20) },
  { id: 'rbac_group_mock_lead', name: 'Leadership', members: USERS.slice(0, 3) },
]

// Sum every numeric leaf of `o` into `acc` (nested objects merge); non-numeric
// leaves keep the first value seen. null counters stay null until a number arrives.
function mergeSum(acc, o) {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!acc[k] || typeof acc[k] !== 'object') acc[k] = {}
      mergeSum(acc[k], v)
    } else if (typeof v === 'number') {
      acc[k] = (typeof acc[k] === 'number' ? acc[k] : 0) + v
    } else if (!(k in acc)) {
      acc[k] = v
    }
  }
}
