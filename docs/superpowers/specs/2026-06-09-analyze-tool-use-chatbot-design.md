# Analyze → Tool-Use Chatbot — Design

- **Status**: Proposed
- **Date**: 2026-06-09
- **Owners**: @whchoi98
- **Supersedes**: the fixed-mode `POST /api/analyze` endpoint and the `direct`/`sql`
  mode selector in `src/pages/Analyze.tsx`
- **Related**: forthcoming ADR-0008 (tool-use chatbot replaces fixed-mode analyze);
  pattern ported from the chatbot in the sibling project `/home/ec2-user/my-project/model-monitoring`

## Context

The `/analyze` route (`src/pages/Analyze.tsx` + `POST /api/analyze` in
`server/aws.js:393`) is a **single-turn analytics Q&A**, not a chatbot:

1. Each request carries only the current `question` — the backend builds
   `messages: [{ role: 'user', content: [{ text }] }]` (`aws.js:459`), so the
   model has **no memory of prior turns**.
2. The user must pre-select a fixed `direct` or `sql` **mode**. `direct` injects
   a full analytics snapshot JSON into the prompt; `sql` runs a separate
   LLM pass (`generateSql`) to author one Athena query, runs it, then analyzes
   the rows. The model cannot mix sources or decide for itself what data it needs.
3. There are only static "quick prompts" — no contextual follow-ups.

The sibling project `model-monitoring` implements a true chatbot whose power
comes from three things this project lacks: a **Bedrock tool-use loop** (the LLM
autonomously calls tools to fetch data, up to `MAX_TOOL_HOPS`), **multi-turn
conversation memory**, and **dynamically generated follow-up questions**. This
design ports that pattern, adapted to this project's stack (Express + AWS SDK v3
Converse, the existing Athena sanitizer, the `maskEmail` privacy convention, the
stateless 10-minute cache, and CloudFront-level Cognito auth).

The good parts of the current `/analyze` are **kept**: SSE streaming, the
`react-markdown` renderer (`Markdown.tsx`), and the Markdown/PDF export toolbar.

## Goals (v1)

- Convert `/analyze` into a conversational, **tool-use chatbot** where the model
  autonomously calls data tools instead of the user picking a `direct`/`sql` mode.
- **Multi-turn memory** via client-sent conversation history (no new infra).
- Expose the chatbot **both** as the reworked `/analyze` full page (keeping
  MD/PDF export) **and** as a floating widget available on every page, sharing
  one `ChatPanel` component.
- **Dynamic follow-up questions** after each answer.
- Chat UX polish: typing indicator, tool-call badges, conversation reset button.
- Reuse the existing `runAthenaSafe` sanitizer for any model-authored SQL, and
  mask emails **server-side in tool results** (defense in depth beyond the prompt).

## Non-goals (v2 candidates)

- AgentCore Memory or server-side session persistence (client history is
  sufficient for an internal analytics assistant; revisit if cross-device
  continuity is needed).
- A dedicated auth gate on the chat endpoint (the whole app already sits behind
  CloudFront + Cognito Lambda@Edge — see ADR-0001).
- Browser-specific popup-vs-modal branching (model-monitoring does this; we ship
  a single modal implementation).
- Haiku for follow-up generation (default reuses the existing Sonnet model id to
  avoid a new in-region Bedrock model-access dependency; Haiku is a later
  cost/latency optimization).

## Decisions (recorded from brainstorming)

| # | Decision | Choice |
|---|---|---|
| Data access | tool-use loop vs fixed modes | **Tool-use loop** — drop the mode selector |
| Memory | client history vs AgentCore vs server session | **Client history** in the request body |
| Surface | page vs widget vs both | **Both** — page + global floating widget, shared `ChatPanel` |
| Extras | which polish features | **All**: dynamic follow-ups, typing indicator, tool-call badges, reset button |
| Follow-up model | Sonnet vs Haiku | **Reuse Sonnet `MODEL_ID`** (Haiku deferred) |
| `/api/analyze` | keep vs remove | **Remove** — superseded by `/api/chat/stream` |

## Architecture

```
 src/pages/Analyze.tsx (variant="page")  ──┐
   + MD/PDF export toolbar (kept)          │
                                           ├─→ <ChatPanel> ─→ useChatStream()
 src/components/chat/FloatingChat.tsx ─────┘      │  - messages[], isStreaming,
   (mounted in Layout.tsx, every page)            │    followups[], toolCalls
                                                  │  - send() / stop() / reset()
                                                  │  - SSE parser (\n\n split)
                                                  ▼
                       POST /api/chat/stream  { message, history[], locale }
                                                  ▼
            server/aws.js  ── tool-use loop (ConverseStreamCommand + toolConfig)
                                                  │   for hop in 0..MAX_TOOL_HOPS(4)
                                                  ▼
   TOOL_REGISTRY:  get_analytics_overview · run_athena_sql · get_cost_summary · search_users
                                                  │   (emails masked in tool results)
                                                  ▼
                       follow-up generation (1 Converse call) → SSE 'done'
```

- **Memory**: the client keeps the full `messages[]` in React state and sends the
  last N turns (text only, role-tagged) as `history[]` on every request. The
  server rebuilds Bedrock `messages[]` from `history` + the new `message`.
- **One shared component**: `ChatPanel` renders the conversation, composer,
  suggested/follow-up pills, and header (with reset). A `variant` prop switches
  between the full-page layout (with export) and the compact widget modal.

## Component changes

### Server (`server/aws.js`)

**Remove**: `POST /api/analyze` (lines ~392–478) and the now-unused standalone
`generateSql` LLM pass (SQL is now authored inline by the model via the
`run_athena_sql` tool). Keep `runAthenaSafe`, `fetchAnalytics`, the cost reshape,
and `runAthena` — they become tool implementations.

**Add**: `POST /api/chat/stream`.

Request body:
```jsonc
{
  "message": "string (required)",
  "history": [{ "role": "user|assistant", "text": "string" }],  // last ≤12 turns, text only
  "locale": "en | ko"
}
```

Tool-use loop (ports model-monitoring `_chat_generator`):
```
sseInit(res)
messages = history.map(toBedrockTurn).concat([{ role:'user', content:[{ text: message }] }])
let hop = 0, stopReason
for (; hop <= MAX_TOOL_HOPS; hop++) {
  const stream = await bedrock.send(new ConverseStreamCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT(locale) }],
    messages,
    toolConfig: { tools: TOOL_SPECS },
    inferenceConfig: { maxTokens: 2000, temperature: 0.2 },
  }))
  // accumulate assistant content blocks (text + toolUse) while streaming text deltas
  for await (const ev of stream.stream) {
    if (ev.contentBlockDelta?.delta?.text) sseSend(res, 'text', { text: <delta> })
    // collect contentBlockStart/Delta/Stop for toolUse blocks into assistantContent[]
    if (ev.messageStop) stopReason = ev.messageStop.stopReason
  }
  messages.push({ role: 'assistant', content: assistantContent })
  if (stopReason !== 'tool_use') break
  if (hop === MAX_TOOL_HOPS) { sseSend(res,'status',{message:'tool limit reached'}); break }
  const toolResults = []
  for (const tu of toolUses) {
    sseSend(res, 'tool_call', { id: tu.toolUseId, name: tu.name, input: redact(tu.input) })
    const out = await runTool(tu.name, tu.input)              // throws → captured below
    sseSend(res, 'tool_result', { id: tu.toolUseId, name: tu.name, ok: out.ok, rowCount: out.rowCount })
    toolResults.push({ toolResult: { toolUseId: tu.toolUseId, content: [{ json: out.data }],
                                     status: out.ok ? 'success' : 'error' } })
  }
  messages.push({ role: 'user', content: toolResults })
}
const followups = await generateFollowups(message, finalText, locale)   // best-effort
sseSend(res, 'followups', { suggestions: followups })
sseSend(res, 'done', { ok: true, modelId: MODEL_ID, hops: hop })
res.end()
```

`MAX_TOOL_HOPS = 4`. `redact()` trims/masks tool inputs before echoing to the
client (mask any email-shaped value).

**SSE event protocol** (shared by page + widget):

| event | data | meaning |
|---|---|---|
| `status` | `{ message }` | phase / warning text |
| `tool_call` | `{ id, name, input }` | model invoked a tool (input redacted) |
| `tool_result` | `{ id, name, ok, rowCount? }` | tool finished → badge state |
| `text` | `{ text }` | assistant token delta |
| `followups` | `{ suggestions: string[] }` | 3 contextual follow-ups |
| `error` | `{ message, hint }` | fatal error |
| `done` | `{ ok, modelId, hops }` | end of turn |

`done` (or `error`) is emitted in a `finally` so the client never relies on the
socket merely closing.

**System prompt**: reuse the existing enterprise-analyst text + the email-masking
rule (`aws.js:441-442`) + an instruction to use tools for real data and never
guess + the ko/en language note + a note that the conversation is multi-turn.

**Tool registry** (`TOOL_REGISTRY` + `TOOL_SPECS` in Bedrock `toolSpec` format):

| tool | input schema | implementation | reuse |
|---|---|---|---|
| `get_analytics_overview` | `{}` | org adoption/productivity snapshot (DAU/WAU, LOC, commits, PRs, tool acceptance, skill/connector adoption) | `fetchAnalytics()` / compact snapshot at `index.js:545` |
| `run_athena_sql` | `{ sql: string }` | sanitized SELECT over the S3 archive; returns `{ columns, rows }` (cap rows, e.g. 200) | **`runAthenaSafe`** (allowlist + 24 forbidden keywords) — unchanged |
| `get_cost_summary` | `{}` | org spend by product × model + token totals | `analyticsReportsToCostResp` |
| `search_users` | `{ query?: string, limit?: number }` | per-user engagement/productivity Top-N or lookup; **emails masked server-side via `maskEmail` before returning** | users/range aggregation |

`run_athena_sql` is the security-critical tool: model output is untrusted, so it
**must** pass through `runAthenaSafe`. A rejected query returns an error
`toolResult` (model explains it to the user); it does not abort the stream.

**Follow-up generation** (`generateFollowups`): one non-streaming `ConverseCommand`
(reusing `MODEL_ID`) that asks for exactly 3 short, entity-specific follow-up
questions in the same language as the answer; returns a JSON array, with
line-based fallback parsing. Best-effort — on any failure return `[]` and the UI
falls back to static suggestions.

### Frontend (`src/`)

New directory `src/components/chat/`:

- **`useChatStream.ts`** (in `src/lib/`) — the hook. State: `messages: ChatMessage[]`,
  `isStreaming`, `followups: string[]`. Actions: `send(text)`, `stop()`, `reset()`.
  Owns the SSE reader (split on `\n\n`, parse `event:`/`data:` lines) and an
  `AbortController`. On `send`, it pushes a user message + an empty assistant
  message, then mutates the trailing assistant message as `text`/`tool_call`/
  `tool_result`/`followups` arrive. Sends the last 12 turns as `history`.
  `ChatMessage = { id, role, text, toolCalls?: {id,name,status}[], status?, error? }`.
- **`ChatPanel.tsx`** — shared surface. Props: `variant: 'page' | 'widget'`,
  `onClose?`. Renders `MessageList` + `ChatComposer` + suggested-prompt pills
  (empty state) + follow-up pills (after an answer) + a header with model label
  and reset button (and a close button when `variant==='widget'`).
- **`MessageList.tsx`** — message bubbles (user right / assistant left, Claude
  palette), assistant text via `Markdown.tsx`, a **3-dot typing indicator** while
  streaming with no text yet, **tool-call badges** (purple, name + spinner/✓),
  clickable suggested/follow-up pills, auto-scroll to bottom on new content.
- **`ChatComposer.tsx`** — textarea, Enter-to-send / Shift+Enter newline,
  Send/Stop button (Stop shown while streaming), disabled while streaming.
- **`FloatingChat.tsx`** — bottom-right launcher button + a fixed compact modal
  containing `<ChatPanel variant="widget">`. Mounted once in `Layout.tsx` so it
  appears on every route. Open/close state is local; conversation persists while
  the widget stays mounted.

Changed files:

- **`src/pages/Analyze.tsx`** — rebuilt to render `<ChatPanel variant="page">`
  full width, wrapped by the existing `PageHeader` and the **MD/PDF export
  toolbar** (the `exportMarkdown`/`exportPdf` + `.print-export`/`app-print`
  mechanism is retained, now reading from the shared `messages[]`). The
  `direct`/`sql` mode selector is removed.
- **`src/components/Layout.tsx`** — mount `<FloatingChat />` once.

### i18n keys (en + ko in `src/lib/i18n.tsx`)

Add a `chat.*` section: `chat.placeholder`, `chat.send`, `chat.stop`,
`chat.thinking`, `chat.reset`, `chat.followups`, `chat.suggested`,
`chat.tool.<name>` labels, `chat.widget.open`, `chat.widget.title`, plus the
suggested-prompt list (`chat.prompts`, JSON-encoded like the current
`analyze.prompts`). Every key gets **both** `en` and `ko` values (the JSX-prop
i18n bypass trap — see `feedback_i18n_jsx_props`). Existing `analyze.*` keys that
are still referenced (title/subtitle/export) are kept; obsolete `analyze.mode.*`
keys are removed.

### Documentation

- `server/CLAUDE.md` — replace the `/analyze` line with `/api/chat/stream` (tool-use
  loop, tool registry, SSE protocol).
- `src/CLAUDE.md` — document `src/components/chat/` and `useChatStream`.
- `docs/api-reference.md` — replace `/analyze` with `/chat/stream`; document tools.
- `docs/architecture.md` — update the AI layer description (tool-use chatbot) and
  link the new ADR.
- `docs/decisions/0008-tool-use-chatbot.md` — new ADR.
- `CHANGELOG.md` — new entry (bilingual).

## Error handling

- **Tool hop limit (4)** reached → emit a `status` warning and finish with the
  text produced so far.
- **Tool execution failure** (e.g. `run_athena_sql` rejected by the sanitizer, or
  an Athena timeout) → return an error `toolResult` to the model so it can explain
  to the user; the SSE stream stays alive.
- **Fatal error** (Bedrock failure, etc.) → `error` event with `message` + `hint`,
  then `res.end()` in `finally`.
- **Abort** (user clicks Stop) → client aborts the fetch; server stream ends.
- **History payload cap** — last 12 turns, text only, to stay well under the WAF
  `SizeRestrictions_BODY` 8 KB limit (see `project_waf_body_limit`); the existing
  override is COUNT-mode, but we keep the body small regardless.

## Security / privacy

- `run_athena_sql` is sanitized by the existing `runAthenaSafe` (table allowlist +
  forbidden keywords) — IAM is not the only line of defense.
- Any tool that surfaces user identities (`search_users`, and any email-bearing
  Athena rows from `run_athena_sql`) passes through `maskEmail` **server-side
  before the data reaches the model**, so raw emails never enter the prompt. The
  output-masking prompt rule is retained as a second layer.
- Redact tool-call inputs echoed to the client via `tool_call` events.

## Test strategy

### Unit tests (Node ESM, `tests/server/`)
- `historyToMessages()` — maps client `history[]` to Bedrock `messages[]` (role
  alternation, text-only content, empty/oversized history).
- `runTool()` dispatch — unknown tool name, `run_athena_sql` routed through
  `runAthenaSafe` (rejection surfaces as an error result, not a throw).
- `parseFollowups()` — JSON array, line-based fallback, malformed → `[]`.
- `maskEmail` applied in `search_users` output.

### Manual smoke (`npm run dev`)
- Multi-turn: ask a question, then a follow-up that depends on the first answer.
- Tool use: a question that forces `run_athena_sql`; confirm a tool-call badge
  appears and the answer cites real rows.
- Widget: open from a non-Analyze page; confirm it works on every route.
- Export: MD + PDF still work from the page variant.
- Privacy: ask "who are the top users" → emails masked in the answer.

### Regression checks
- `node --check server/*.js`; `npm run build` (tsc strict) passes.
- Existing `runAthenaSafe` sanitizer tests still pass (reused, unchanged).

## Out of scope (v2 follow-ups)
- AgentCore / server-side persisted sessions.
- Haiku follow-up model.
- Per-conversation auth/rate limiting beyond the existing CloudFront/Cognito edge.
- Browser popup-vs-modal branching.

## Risk and mitigations

| Risk | Mitigation |
|---|---|
| Model authors unsafe SQL via `run_athena_sql` | existing `runAthenaSafe` allowlist + forbidden-keyword sanitizer; IAM scoping |
| Raw emails leak into prompt/output | server-side `maskEmail` on tool results + output-masking prompt rule |
| Tool loop runs away / high token cost | `MAX_TOOL_HOPS = 4`, `maxTokens: 2000`, history capped at 12 turns |
| Large history trips WAF body limit | text-only, last-12-turns cap; COUNT-mode override already in place |
| Follow-up generation flaky | best-effort; `[]` on failure → static suggested prompts |

## Estimated change footprint
- **Server**: ~+250 / −90 lines in `server/aws.js` (new route + tool registry;
  remove `/analyze` + `generateSql`).
- **Frontend**: ~5 new files under `src/components/chat/` + `src/lib/useChatStream.ts`
  (~400 lines total); `Analyze.tsx` rebuilt (~−150 / +60); `Layout.tsx` (+2).
- **i18n**: ~20 new key pairs.
- **Docs**: 4 doc edits + 1 new ADR + CHANGELOG entry.
- **Tests**: ~3 new `tests/server/*.mjs` files.

## Open questions for implementation
- None. Follow-up model defaults to Sonnet `MODEL_ID`; `/api/analyze` is removed.
