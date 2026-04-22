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
const SKILLS = [
  'code-review', 'pdf-processing', 'webapp-testing', 'sql-generator',
  'doc-writer', 'data-analysis', 'diagram-builder', 'test-generator',
]
const CONNECTORS = ['github', 'gitlab', 'jira', 'confluence', 'slack', 'notion', 'google-drive']
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
    },
    cowork_metrics: {
      distinct_session_count: ccActive && rand() < 0.3 ? Math.floor(1 + rand() * 3) : 0,
      action_count: 0,
      dispatch_turn_count: 0,
      message_count: 0,
      skills_used_count: 0, distinct_skills_used_count: 0,
      connectors_used_count: 0, distinct_connectors_used_count: 0,
    },
    web_search_count: active ? Math.floor(rand() * 12) : 0,
  }
}

export const generateMock = {
  users(date) {
    const rand = rng(hashSeed(date))
    const factor = dowFactor(date)
    const data = USERS.map((u) => mockUserRecord(u, date, rand, factor))
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
    const data = SKILLS.map((name) => {
      const distinctUsers = Math.floor(1 + rand() * 10)
      return {
        skill_name: name,
        distinct_user_count: distinctUsers,
        chat_metrics: { distinct_conversation_skill_used_count: Math.floor(distinctUsers * (1 + rand() * 3)) },
        claude_code_metrics: { distinct_session_skill_used_count: Math.floor(distinctUsers * (1 + rand() * 2)) },
        office_metrics: {
          excel: { distinct_session_skill_used_count: 0 },
          powerpoint: { distinct_session_skill_used_count: 0 },
          word: { distinct_session_skill_used_count: 0 },
        },
        cowork_metrics: { distinct_session_skill_used_count: Math.floor(rand() * 3) },
      }
    })
    return { data, has_more: false, next_page: null }
  },

  connectors(date) {
    const rand = rng(hashSeed(date) ^ 0xBEE)
    const data = CONNECTORS.map((name) => {
      const distinctUsers = Math.floor(1 + rand() * 14)
      return {
        connector_name: name,
        distinct_user_count: distinctUsers,
        chat_metrics: { distinct_conversation_connector_used_count: Math.floor(distinctUsers * (1 + rand() * 2)) },
        claude_code_metrics: { distinct_session_connector_used_count: Math.floor(distinctUsers * (1 + rand() * 1.5)) },
        office_metrics: {
          excel: { distinct_session_connector_used_count: 0 },
          powerpoint: { distinct_session_connector_used_count: 0 },
          word: { distinct_session_connector_used_count: 0 },
        },
        cowork_metrics: { distinct_session_connector_used_count: Math.floor(rand() * 2) },
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
}
