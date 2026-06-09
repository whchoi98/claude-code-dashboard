# ADR-0008: Tool-use chatbot replaces fixed-mode Analyze

- **Status**: Accepted
- **Date**: 2026-06-09
- **Deciders**: @whchoi98
- **Supersedes**: the `direct`/`sql` mode selector + `POST /api/analyze`

## Context

`/analyze` was a single-turn Q&A: the user pre-selected a `direct` (inject
snapshot) or `sql` (LLM authors one Athena query) mode, and each request carried
only the current question — no memory. This is less capable than the sibling
`model-monitoring` chatbot, whose power comes from a Bedrock tool-use loop,
multi-turn memory, and dynamic follow-ups.

## Decision

Replace `/api/analyze` with `POST /api/chat/stream`: a Bedrock Converse tool-use
loop (`MAX_TOOL_HOPS = 4`) over four tools — `get_analytics_overview`,
`run_athena_sql` (via the existing `sanitizeAthenaQuery`), `get_cost_summary`,
`search_users`. The LLM decides which tools to call. Conversation memory is
**client-side**: the last 12 turns are sent as `history[]` (no new infra). The
chatbot is exposed both as the reworked `/analyze` page and a global
`FloatingChat` widget, sharing one `ChatPanel`. Email masking moves to the
**tool-result layer** (server-side) so raw addresses never enter the prompt.

## Consequences

- More capable, conversational analysis; the model mixes data sources per turn.
- No new infra/IAM (reuses `bedrock:InvokeModelWithResponseStream` + athena/s3).
- Pure helpers live in `server/chat-tools.js` (unit-tested); the Bedrock
  streaming loop lives in `server/aws.js`.
- Follow-ups reuse the Sonnet model id (Haiku deferred — would need in-region
  model access).
- `direct`/`sql` modes and `generateSql` are removed.
