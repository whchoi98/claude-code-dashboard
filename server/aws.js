import express from 'express'
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-athena'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'

// ─── Athena SQL Sanitizer (defense in depth) ────────────────────────────────
// Athena's IAM policy already restricts this task to the ccd workgroup, and
// CDK grants glue:GetTable only on the ccd database. Even so, a naive regex
// check on the `query` body lets an attacker:
//   - chain a DDL after a semicolon (even if Athena rejects, UI errors leak)
//   - hide intent inside block/line comments
//   - read unlisted tables the Glue catalog would happily expose
//
// sanitizeAthenaQuery enforces:
//   1. Strip `--` line and `/* */` block comments, then reject any remaining `;`.
//   2. Must start with SELECT or WITH (AST-shape guard).
//   3. Reject any forbidden keyword anywhere in the cleaned body.
//   4. Every FROM/JOIN target must be in ALLOWED_TABLES.
//
// Throws Error with a user-friendly `message` on any violation; callers
// should translate to HTTP 400.
const ATHENA_ALLOWED_TABLES = new Set([
  'claude_code_analytics',
  'summaries_daily',
  'skills_daily',
  'connectors_daily',
])
const ATHENA_FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|CALL|EXECUTE|EXEC|MSCK|REPAIR|USE|COPY|UNLOAD|DESCRIBE|SHOW|EXPLAIN|INTO\s+OUTFILE|LOAD\s+DATA)\b/i

export function sanitizeAthenaQuery(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Query must be a non-empty string.')
  }

  // 1) Strip comments (do this BEFORE semicolon check so "SELECT 1 -- ; DROP" is caught)
  const stripped = raw
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()

  // 2) Collapse a single trailing semicolon, reject any other
  const normalized = stripped.replace(/;\s*$/, '')
  if (/;/.test(normalized)) {
    throw new Error('Multi-statement queries are not allowed. Remove intermediate semicolons.')
  }

  // 3) Must start with SELECT or WITH
  if (!/^\s*(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error('Only SELECT or WITH...SELECT statements are permitted.')
  }

  // 4) Reject forbidden keywords anywhere in the body
  const forbiddenMatch = normalized.match(ATHENA_FORBIDDEN_KEYWORDS)
  if (forbiddenMatch) {
    throw new Error(`Forbidden SQL keyword: "${forbiddenMatch[0]}". This endpoint is read-only over the approved tables.`)
  }

  // 5) Collect CTE (WITH name AS (...)) aliases — they are local and should
  //    satisfy the allowlist check for any subsequent FROM/JOIN reference.
  const cteNames = new Set()
  if (/^\s*WITH\b/i.test(normalized)) {
    for (const m of normalized.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi)) {
      cteNames.add(m[1].toLowerCase())
    }
  }

  // 6) Every FROM/JOIN target must be in ATHENA_ALLOWED_TABLES or in cteNames.
  //    Schema-qualified (db.table) falls back to the final identifier. A
  //    subquery like `FROM (SELECT ...)` has no identifier immediately after
  //    FROM and is therefore NOT captured — but any inner FROM inside that
  //    subquery IS captured by matchAll() and checked independently.
  const tableRefs = [...normalized.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_."]*)/gi)]
    .map((m) => m[1].replace(/"/g, '').split('.').pop().toLowerCase())
    .filter(Boolean)

  if (tableRefs.length === 0) {
    throw new Error('Query must reference at least one FROM/JOIN table.')
  }
  for (const t of tableRefs) {
    if (!ATHENA_ALLOWED_TABLES.has(t) && !cteNames.has(t)) {
      throw new Error(
        `Table not allowed: "${t}". Permitted tables: ${[...ATHENA_ALLOWED_TABLES].join(', ')}.`,
      )
    }
  }

  return normalized
}

const ATHENA_SCHEMA_HINT = `
Available Athena database: \`claude_code_analytics\`
Tables (all partitioned by string \`date\` in YYYY-MM-DD, projection enabled from 2026-01-01):

• claude_code_analytics (per-user-per-day, one row per active user):
  user_id, user_email, chat_conversations, chat_messages, chat_thinking_messages,
  chat_files_uploaded, chat_artifacts, chat_skills, chat_connectors,
  cc_sessions, lines_of_code_added, lines_of_code_removed,
  commits_by_claude_code, prs_by_claude_code,
  edit_tool_accepted, edit_tool_rejected,
  multi_edit_tool_accepted, multi_edit_tool_rejected,
  write_tool_accepted, write_tool_rejected,
  notebook_edit_tool_accepted, notebook_edit_tool_rejected,
  web_search_count,
  cowork_sessions, cowork_messages, cowork_actions, cowork_dispatch_turns

• summaries_daily (one row per day, org-wide):
  date, daily_active_user_count, weekly_active_user_count, monthly_active_user_count,
  assigned_seat_count, pending_invite_count,
  cowork_daily_active_user_count, cowork_weekly_active_user_count, cowork_monthly_active_user_count

• skills_daily:   skill_name, distinct_users, chat_uses, claude_code_uses, cowork_uses
• connectors_daily: connector_name, distinct_users, chat_uses, claude_code_uses, cowork_uses

Always filter by partition: WHERE date BETWEEN DATE '...' AND DATE '...'.
All values are integers; rates are computed, not stored.
`.trim()

export function registerAwsRoutes(app, { fetchAnalytics }) {
  const REGION = process.env.AWS_REGION || 'us-east-1'
  const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6'

  const bedrock = new BedrockRuntimeClient({ region: REGION })
  const athena = new AthenaClient({ region: REGION })
  const s3 = new S3Client({ region: REGION })

  const router = express.Router()

  // ── Helpers ──────────────────────────────────────────────────────────────
  async function runAthena(query) {
    const WG = process.env.ATHENA_WORKGROUP
    const DB = process.env.ATHENA_DATABASE
    const OUT = process.env.ATHENA_OUTPUT_LOCATION
    if (!WG || !DB || !OUT) throw new Error('Athena env not configured')

    const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: WG,
      QueryExecutionContext: { Database: DB },
      ResultConfiguration: { OutputLocation: OUT },
    }))
    for (let i = 0; i < 40; i++) {
      const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }))
      const state = QueryExecution?.Status?.State
      if (state === 'SUCCEEDED') break
      if (state === 'FAILED' || state === 'CANCELLED') {
        throw new Error(`Athena ${state}: ${QueryExecution?.Status?.StateChangeReason || 'query failed'}`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId, MaxResults: 500 }))
    const raw = results.ResultSet?.Rows ?? []
    if (raw.length === 0) return { columns: [], rows: [] }
    const columns = raw[0].Data?.map((d) => d.VarCharValue || '') ?? []
    const rows = raw.slice(1).map((r) => {
      const out = {}
      r.Data?.forEach((d, i) => { out[columns[i]] = d.VarCharValue ?? null })
      return out
    })
    return { columns, rows }
  }

  function sseInit(res) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
  }
  function sseSend(res, event, data) {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // Pull the SQL out of whatever Claude returned. Tries several common patterns.
  function extractSql(text) {
    const trimmed = (text || '').trim()

    // 1) ```sql ... ``` or ``` ... ``` fenced block (most common)
    const fenceMatch = trimmed.match(/```(?:sql)?\s*([\s\S]*?)```/i)
    if (fenceMatch) {
      const inner = fenceMatch[1].trim()
      if (/^(SELECT|WITH)\b/i.test(inner)) return inner
    }

    // 2) Bare response, entire body is SQL
    if (/^(SELECT|WITH)\b/i.test(trimmed)) return trimmed

    // 3) SQL embedded somewhere — grab from first SELECT/WITH to end of statement
    const bareMatch = trimmed.match(/\b(SELECT|WITH)\b[\s\S]*?(;|$)/i)
    if (bareMatch) {
      const extracted = bareMatch[0].replace(/;\s*$/, '').trim()
      if (/^(SELECT|WITH)\b/i.test(extracted)) return extracted
    }

    const snippet = trimmed.slice(0, 400).replace(/\s+/g, ' ')
    throw new Error(
      `Generated query is not a SELECT/WITH statement. Model output was:\n---\n${snippet}\n---`,
    )
  }

  async function generateSql(question, locale) {
    const sys = [
      'You are an Athena SQL generator. The user asks a question; you return ONE Athena SQL statement that answers it.',
      '',
      'Output format (STRICT):',
      '- Emit ONLY a single fenced code block: ```sql ... ```',
      '- Nothing before, nothing after the fenced block. No prose, no explanation, no headings.',
      '- The SQL inside MUST start with SELECT or WITH. No DDL, no DML, no multi-statement output.',
      '',
      'SQL rules:',
      '- Always include a partition filter on `date`. The partition is a STRING column in YYYY-MM-DD format.',
      '  Correct form: WHERE date BETWEEN \'2026-04-01\' AND \'2026-04-18\'',
      '  If the user did not specify a range, default to the last 14 days ending today - 3 (3-day API buffer).',
      '- Use CAST(date AS DATE) ONLY when you need date arithmetic; for equality/BETWEEN comparisons, use string form.',
      '- Do not invent columns. Use only columns listed in the schema below.',
      '- Acceptance-rate expressions: SUM(x_accepted) / NULLIF(SUM(x_accepted + x_rejected), 0). Cast to DOUBLE when computing rates.',
      '- Always add ORDER BY where it makes the answer deterministic. Always add LIMIT (default 50).',
      '',
      ATHENA_SCHEMA_HINT,
      '',
      `Today is ${new Date().toISOString().slice(0, 10)}. The Analytics API has a 3-day buffer so filters should end at date - 3 days at latest.`,
    ].join('\n')

    const out = await bedrock.send(new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: sys }],
      messages: [{ role: 'user', content: [{ text: question }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0 },
    }))
    const text = out.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') || ''
    try {
      return { sql: extractSql(text), raw: text }
    } catch (e) {
      // Re-raise with the raw model output attached so the UI can show it.
      const err = new Error(e.message)
      err.raw = text
      throw err
    }
  }

  // Execute an Athena SQL that has already passed sanitizeAthenaQuery.
  async function runAthenaSafe(rawQuery) {
    const safe = sanitizeAthenaQuery(rawQuery)
    return runAthena(safe)
  }

  // ── /api/analyze — SSE streaming ─────────────────────────────────────────
  router.post('/analyze', async (req, res) => {
    const { question, locale = 'en', mode = 'direct' } = req.body || {}
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' })
    }

    sseInit(res)
    try {
      let context
      let sqlEcho = null
      let rowsEcho = null

      if (mode === 'sql') {
        sseSend(res, 'status', { message: locale === 'ko' ? 'SQL 생성 중…' : 'Generating SQL…' })
        const { sql } = await generateSql(question, locale)
        sqlEcho = sql
        sseSend(res, 'sql', { sql })

        sseSend(res, 'status', { message: locale === 'ko' ? 'Athena 실행 중…' : 'Running Athena query…' })
        // Run through the same sanitizer as the direct /archive/query endpoint —
        // the LLM is untrusted output and must not bypass our table allowlist.
        const { columns, rows } = await runAthenaSafe(sql)
        rowsEcho = rows.slice(0, 200)
        sseSend(res, 'rows', { columns, rows: rowsEcho })

        context = {
          mode: 'sql',
          sql,
          columns,
          rows: rowsEcho,
          row_count: rows.length,
        }
      } else {
        sseSend(res, 'status', { message: locale === 'ko' ? '실시간 데이터 로드 중…' : 'Loading live snapshot…' })
        const snapshot = await fetchAnalytics()
        context = { mode: 'direct', snapshot }
      }

      const languageNote = locale === 'ko'
        ? '답변은 반드시 한국어로 작성하세요. 한국어 마크다운 리포트 형식으로 3~5개 섹션(## 헤더)과 구체 수치, 계산 근거를 포함하세요.'
        : 'Write in clear English. The output MUST be valid Markdown: 3–5 "## " headings, "-" bullet lists, and GFM pipe tables where numeric comparisons help. Include specific numbers and explicit rate/growth calculations.'

      const sys = [
        'You are an enterprise analytics analyst for Claude Code Enterprise.',
        'You receive an analytics context (either a live snapshot or Athena query rows) and answer the question with specific numbers.',
        'Rules:',
        '- Cite exact numbers and compute rates/growth explicitly.',
        '- Call out data caveats: 3-day buffer, 90-day max lookback, no Bedrock usage.',
        '- PRIVACY: When citing any user email, keep only the first 2 characters of the local part, mask the rest with literal asterisks, and keep the @domain visible. Example: alice.kim@acme.com → al*******@acme.com. Never emit raw full emails.',
        '- FORMATTING: Write plain Markdown that a standard Markdown renderer (GitHub/CommonMark) can parse. Do NOT escape asterisks with backslashes — write ab*****@domain.com, never ab\\*\\*\\*\\*\\*@domain.com. The asterisks inside masked emails are literal characters, not bold syntax, so a surrounding renderer will display them correctly.',
        languageNote,
      ].join('\n')

      const userMsg = [
        `QUESTION: ${question}`,
        '',
        context.mode === 'sql'
          ? `You autonomously generated this Athena SQL:\n\`\`\`sql\n${sqlEcho}\n\`\`\`\n\nRESULT (${context.row_count} rows, first 200 shown):\n\`\`\`json\n${JSON.stringify(rowsEcho, null, 2).slice(0, 40000)}\n\`\`\``
          : `ANALYTICS SNAPSHOT (JSON):\n\`\`\`json\n${JSON.stringify(context.snapshot, null, 2).slice(0, 60_000)}\n\`\`\``,
      ].join('\n')

      sseSend(res, 'status', { message: locale === 'ko' ? '분석 작성 중…' : 'Drafting analysis…' })

      const stream = await bedrock.send(new ConverseStreamCommand({
        modelId: MODEL_ID,
        system: [{ text: sys }],
        messages: [{ role: 'user', content: [{ text: userMsg }] }],
        inferenceConfig: { maxTokens: 2000, temperature: 0.2 },
      }))

      for await (const ev of stream.stream) {
        const delta = ev.contentBlockDelta?.delta?.text
        if (delta) sseSend(res, 'text', { text: delta })
        if (ev.messageStop) sseSend(res, 'stop', { reason: ev.messageStop.stopReason })
      }

      sseSend(res, 'done', { ok: true, modelId: MODEL_ID })
      res.end()
    } catch (err) {
      sseSend(res, 'error', {
        message: err?.message || String(err),
        hint: 'Ensure the ECS task role has bedrock:InvokeModelWithResponseStream + (if SQL mode) athena & s3 permissions.',
      })
      res.end()
    }
  })

  // ── /api/archive/query — sanitized synchronous Athena SELECT ────────────
  // Defence in depth against SQL injection: sanitizer rejects multi-statement,
  // forbidden keywords, and any table not in the explicit allowlist. Athena IAM
  // policy restricts the task role further, but we never rely on IAM alone —
  // a bad query still leaks intent via error messages.
  router.post('/archive/query', async (req, res) => {
    const { query } = req.body || {}
    try {
      const { rows } = await runAthenaSafe(query)
      res.json({ rows })
    } catch (err) {
      // sanitizeAthenaQuery throws Error with a helpful message — surface as 400.
      const msg = err?.message || String(err)
      const isValidation =
        msg.startsWith('Query must') ||
        msg.startsWith('Multi-statement') ||
        msg.startsWith('Only SELECT') ||
        msg.startsWith('Forbidden') ||
        msg.startsWith('Table not allowed')
      if (isValidation) {
        return res.status(400).json({ error: 'query_rejected', message: msg })
      }
      res.status(500).json({ error: 'athena_error', message: msg })
    }
  })

  // ── CSV Spend Report (from S3) ──────────────────────────────────────────
  // Returns the latest spend-report CSV from s3://<archive>/spend-reports/
  // parsed into a structured JSON with aggregations.
  router.get('/cost/csv', async (_req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })
    try {
      // List objects under spend-reports/ and pick the latest by LastModified
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'spend-reports/',
      }))
      const objects = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
      if (objects.length === 0) {
        return res.status(404).json({
          error: 'no_spend_report',
          message: `Upload a CSV to s3://${BUCKET}/spend-reports/`,
        })
      }
      const latest = objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
      const body = await obj.Body.transformToString()
      const { rows, columns } = parseCsv(body)

      // Normalize numeric fields
      const records = rows.map((r) => ({
        user_email:              r.user_email,
        account_uuid:            r.account_uuid,
        product:                 r.product,
        model:                   r.model,
        total_requests:          Number(r.total_requests || 0),
        total_prompt_tokens:     Number(r.total_prompt_tokens || 0),
        total_completion_tokens: Number(r.total_completion_tokens || 0),
        total_net_spend_usd:     Number(r.total_net_spend_usd || 0),
        total_gross_spend_usd:   Number(r.total_gross_spend_usd || 0),
      }))

      // Derive period from filename like spend-report-2026-04-01-to-2026-04-21.csv
      const name = latest.Key.split('/').pop() || ''
      const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
      const period = m ? { starting_date: m[1], ending_date: m[2] } : null

      res.json({
        source: 'csv',
        file: name,
        size_bytes: latest.Size,
        last_modified: latest.LastModified,
        period,
        columns,
        rows: records,
        totals: {
          requests:          records.reduce((s, r) => s + r.total_requests, 0),
          prompt_tokens:     records.reduce((s, r) => s + r.total_prompt_tokens, 0),
          completion_tokens: records.reduce((s, r) => s + r.total_completion_tokens, 0),
          net_spend_usd:     Number(records.reduce((s, r) => s + r.total_net_spend_usd, 0).toFixed(2)),
          gross_spend_usd:   Number(records.reduce((s, r) => s + r.total_gross_spend_usd, 0).toFixed(2)),
          distinct_users:    new Set(records.map((r) => r.user_email)).size,
          distinct_models:   new Set(records.map((r) => r.model)).size,
          distinct_products: new Set(records.map((r) => r.product)).size,
        },
      })
    } catch (err) {
      res.status(500).json({ error: 's3_read_failed', message: err?.message || String(err) })
    }
  })

  // ── Economic Productivity (CSV spend × Analytics API productivity join) ──
  // Joins the uploaded Spend Report CSV (per-user spend/tokens) with the live
  // Analytics API users/range (per-user LOC, commits, PRs, tool acceptance),
  // then computes cost-efficiency metrics per user.
  router.get('/cost/efficiency', async (req, res) => {
    const BUCKET = process.env.ARCHIVE_S3_BUCKET
    if (!BUCKET) return res.status(400).json({ error: 'archive_bucket_not_configured' })

    // 1) Pull the latest spend CSV
    let csvRows = []
    let csvPeriod = null
    try {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: 'spend-reports/',
      }))
      const objs = (list.Contents || []).filter((o) => o.Key?.endsWith('.csv'))
      if (objs.length === 0) {
        return res.status(404).json({
          error: 'no_spend_report',
          message: 'Upload a Claude Console Spend Report CSV first.',
        })
      }
      const latest = objs.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0]
      const name = latest.Key.split('/').pop() || ''
      const m = name.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/)
      csvPeriod = m ? { starting_date: m[1], ending_date: m[2] } : null
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key }))
      const body = await obj.Body.transformToString()
      csvRows = parseCsv(body).rows
    } catch (err) {
      return res.status(500).json({ error: 's3_read_failed', message: err?.message || String(err) })
    }

    // 2) Aggregate CSV by user
    const bySpendUser = new Map()
    for (const r of csvRows) {
      const u = bySpendUser.get(r.user_email) ?? {
        spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0,
        models: new Set(), products: new Set(),
      }
      u.spend            += Number(r.total_net_spend_usd || 0)
      u.prompt_tokens    += Number(r.total_prompt_tokens || 0)
      u.completion_tokens+= Number(r.total_completion_tokens || 0)
      u.requests         += Number(r.total_requests || 0)
      u.models.add(r.model)
      u.products.add(r.product)
      bySpendUser.set(r.user_email, u)
    }

    // 3) Pull matching Analytics productivity via server self-call.
    //    Clamp ending date to today - 3 (Analytics API buffer) so we don't
    //    trigger mock fallbacks on very recent days that aren't yet aggregated.
    const today = new Date()
    today.setUTCDate(today.getUTCDate() - 3)
    const maxEnd = today.toISOString().slice(0, 10)
    const starting = req.query.starting_date || csvPeriod?.starting_date
    let   ending   = req.query.ending_date   || csvPeriod?.ending_date
    if (ending && ending > maxEnd) ending = maxEnd
    const PORT = Number(process.env.PORT) || 5174
    const rangeResp = await fetch(
      `http://127.0.0.1:${PORT}/api/analytics/users/range?starting_date=${starting}&ending_date=${ending}`,
    ).then((r) => r.json()).catch(() => ({ days: [] }))

    // 4) Aggregate productivity per user. Skip mock-fallback days so bogus
    //    @acme.com records from the mock generator never contaminate results.
    const byProdUser = new Map()
    for (const d of rangeResp.days || []) {
      if (d.source === 'mock') continue
      for (const rec of d.data || []) {
        const cc   = rec.claude_code_metrics?.core_metrics
        const ta   = rec.claude_code_metrics?.tool_actions
        if (!cc) continue
        const email = rec.user?.email_address
        if (!email) continue
        const u = byProdUser.get(email) ?? {
          sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0,
          accepted: 0, rejected: 0, messages: 0, active_days: 0,
        }
        if (cc.distinct_session_count > 0 || rec.chat_metrics?.message_count > 0) u.active_days += 1
        u.sessions   += cc.distinct_session_count ?? 0
        u.loc_added  += cc.lines_of_code?.added_count ?? 0
        u.loc_removed+= cc.lines_of_code?.removed_count ?? 0
        u.commits    += cc.commit_count ?? 0
        u.prs        += cc.pull_request_count ?? 0
        u.messages   += rec.chat_metrics?.message_count ?? 0
        u.accepted   += (ta?.edit_tool?.accepted_count ?? 0) + (ta?.multi_edit_tool?.accepted_count ?? 0) +
                        (ta?.write_tool?.accepted_count ?? 0) + (ta?.notebook_edit_tool?.accepted_count ?? 0)
        u.rejected   += (ta?.edit_tool?.rejected_count ?? 0) + (ta?.multi_edit_tool?.rejected_count ?? 0) +
                        (ta?.write_tool?.rejected_count ?? 0) + (ta?.notebook_edit_tool?.rejected_count ?? 0)
        byProdUser.set(email, u)
      }
    }

    // 5) Join + compute efficiency metrics
    const allEmails = new Set([...bySpendUser.keys(), ...byProdUser.keys()])
    const joined = [...allEmails].map((email) => {
      const s = bySpendUser.get(email) ?? { spend: 0, prompt_tokens: 0, completion_tokens: 0, requests: 0, models: new Set(), products: new Set() }
      const p = byProdUser.get(email)   ?? { sessions: 0, loc_added: 0, loc_removed: 0, commits: 0, prs: 0, accepted: 0, rejected: 0, messages: 0, active_days: 0 }

      // Output score: weighted sum of productivity outcomes
      const output_score = p.loc_added + (100 * p.commits) + (1000 * p.prs) + (0.5 * p.accepted)
      const total_tokens = s.prompt_tokens + s.completion_tokens
      const tool_total = p.accepted + p.rejected

      return {
        email,
        spend_usd: Number(s.spend.toFixed(2)),
        requests: s.requests,
        prompt_tokens: s.prompt_tokens,
        completion_tokens: s.completion_tokens,
        total_tokens,
        models: s.models.size,
        products: s.products.size,
        loc_added: p.loc_added,
        loc_removed: p.loc_removed,
        commits: p.commits,
        prs: p.prs,
        sessions: p.sessions,
        active_days: p.active_days,
        tool_accepted: p.accepted,
        tool_rejected: p.rejected,
        tool_acceptance_rate: tool_total === 0 ? null : p.accepted / tool_total,
        output_score,
        cost_per_loc:      p.loc_added > 0 ? Number((s.spend / p.loc_added).toFixed(4)) : null,
        cost_per_commit:   p.commits   > 0 ? Number((s.spend / p.commits).toFixed(2))   : null,
        cost_per_pr:       p.prs       > 0 ? Number((s.spend / p.prs).toFixed(2))       : null,
        cost_per_session:  p.sessions  > 0 ? Number((s.spend / p.sessions).toFixed(2))  : null,
        output_per_dollar: s.spend > 0 ? Number((output_score / s.spend).toFixed(2))    : null,
        tokens_per_loc:    p.loc_added > 0 ? Math.round(total_tokens / p.loc_added)     : null,
      }
    })

    // 6) Normalize to 0-100 economic productivity score
    //    0.35 * output_per_dollar (higher is better)
    //    0.20 * tool_acceptance_rate
    //    0.20 * inverse(tokens_per_loc)
    //    0.15 * normalized(commits per 10 active days)
    //    0.10 * normalized(prs per 10 active days)
    const cap = (x) => Math.max(0, Math.min(1, x))
    const maxOPD = Math.max(1, ...joined.map((j) => j.output_per_dollar ?? 0))
    const minTPL = joined.filter((j) => j.tokens_per_loc != null).reduce((a, b) => Math.min(a, b.tokens_per_loc), Infinity)
    const scored = joined.map((j) => {
      const opd = (j.output_per_dollar ?? 0) / maxOPD
      const acc = j.tool_acceptance_rate ?? 0
      // Lower tokens/LOC = better; normalize with min of cohort as 1
      const tokRatio = j.tokens_per_loc && isFinite(minTPL) ? cap(minTPL / j.tokens_per_loc) : 0
      const commitsPer10d = j.active_days > 0 ? (j.commits / j.active_days) * 10 / 15 : 0 // 15 commits/10days = ideal
      const prsPer10d     = j.active_days > 0 ? (j.prs     / j.active_days) * 10 / 5  : 0 // 5 PRs/10days = ideal
      const economic_productivity_score = Math.round((
        0.35 * cap(opd) +
        0.20 * cap(acc) +
        0.20 * cap(tokRatio) +
        0.15 * cap(commitsPer10d) +
        0.10 * cap(prsPer10d)
      ) * 100)
      return { ...j, economic_productivity_score }
    })

    const totals = scored.reduce((t, u) => ({
      spend_usd:         t.spend_usd + u.spend_usd,
      loc_added:         t.loc_added + u.loc_added,
      commits:           t.commits + u.commits,
      prs:               t.prs + u.prs,
      prompt_tokens:     t.prompt_tokens + u.prompt_tokens,
      completion_tokens: t.completion_tokens + u.completion_tokens,
    }), { spend_usd: 0, loc_added: 0, commits: 0, prs: 0, prompt_tokens: 0, completion_tokens: 0 })

    res.json({
      source: 'csv+analytics',
      period: csvPeriod,
      user_count: scored.length,
      totals: {
        spend_usd: Number(totals.spend_usd.toFixed(2)),
        loc_added: totals.loc_added,
        commits:   totals.commits,
        prs:       totals.prs,
        prompt_tokens:     totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        avg_cost_per_loc:    totals.loc_added > 0 ? Number((totals.spend_usd / totals.loc_added).toFixed(4)) : null,
        avg_cost_per_commit: totals.commits   > 0 ? Number((totals.spend_usd / totals.commits).toFixed(2))   : null,
      },
      users: scored.sort((a, b) => b.economic_productivity_score - a.economic_productivity_score),
    })
  })

  app.use('/api', router)
}

// Minimal CSV parser that handles quoted fields and commas inside quotes.
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return { columns: [], rows: [] }
  const split = (line) => {
    const out = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inQuote) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (c === '"') inQuote = false
        else cur += c
      } else {
        if (c === '"') inQuote = true
        else if (c === ',') { out.push(cur); cur = '' }
        else cur += c
      }
    }
    out.push(cur)
    return out
  }
  const columns = split(lines[0])
  const rows = lines.slice(1).map((l) => {
    const cols = split(l)
    const obj = {}
    columns.forEach((c, i) => { obj[c] = cols[i] ?? '' })
    return obj
  })
  return { columns, rows }
}
