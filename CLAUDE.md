# CLAUDE.md

This file gives Claude Code persistent context about this project. Keep it in sync with the actual code — run `/sync-docs` after major changes.

## Project

- **Name**: claude-code-dashboard
- **Purpose**: Enterprise analytics dashboard for Claude Code — joins Anthropic Analytics / Admin / Compliance APIs and an S3 archive to expose adoption, productivity, cost, and audit insights with an AI natural-language query layer.
- **Stage**: Deployed (CloudFront + ALB + ECS Fargate in ap-northeast-2, account 061525506239)

## Tech Stack

| Layer | Stack |
|---|---|
| Frontend | React 18 · Vite 5 · TypeScript 5 · Tailwind 3 · Recharts 2 · React Router 6 · react-markdown 10 + remark-gfm |
| Backend | Express 4 on Node 20 · AWS SDK v3 (Bedrock Runtime, S3, Athena, Secrets Manager) |
| Infra | AWS CDK 2.170 (TypeScript) — 4 stacks (network/storage/compute/collector) |
| Runtime | Fargate ARM64 · CloudFront + WAF · ALB (CloudFront-prefix-list locked) · Secrets Manager · Lambda |
| Data | S3 NDJSON archive · Glue Data Catalog · Athena · Bedrock (Claude Sonnet 4.6 via global inference profile) |
| External APIs | Anthropic Analytics API · Admin API · Compliance API (three separate keys) |

## Project Structure

```
claude-code-dashboard/
├── src/                    React SPA (Vite)
│   ├── components/         Shared UI (Layout, ClaudeIcon, KpiCard, ChartCard, PageHeader, LoadingState, UserDetailPanel, DateRangeControl, CsvUploader, Markdown, SortableTh). Layout pins the sidebar to the viewport via h-screen + per-pane overflow-y-auto so scrolling moves only the main pane; it also renders the version badge (links to /changelog) and the static AWS run-rate label.
│   ├── pages/              14 routes (Overview, Executive, Users, UserProductivity, UserSearch, Trends, ClaudeCode, Productivity, Adoption, Cost, Compliance, Analyze, Archive, Changelog). Default date range is 7d. The DateRangeControl now allows today as the end date (Analytics 3-day buffer surfaces partial counts; the popover footnote calls this out).
│   ├── lib/                i18n (ko/en), useDateRange, useFetch, useHealth, useSortable, format (masking, number, date)
│   ├── types.ts            Analytics API schema types
│   ├── App.tsx             Router
│   ├── index.css           Tailwind entry + the generic `@media print` block keyed off `body.app-print` that powers Save-as-PDF on Analyze, Cost, and Executive (visibility-isolated `.print-export` subtree, auto-expanded `<details>`, Claude palette preserved on paper)
│   └── main.tsx            Entry + I18nProvider
├── server/                 Express API layer
│   ├── index.js            Proxy routes: /api/analytics/*, /api/admin/*, /api/compliance/* (after_id cursor; startup prewarm + 5-min interval refresh for the 7d/14d/30d audit windows), /api/health, plus a 10-minute in-memory cache shared across upstream calls
│   ├── aws.js              registerAwsRoutes(): /api/cost/{live,csv,upload,uploads,uploads/:file,efficiency}, /api/analyze (Bedrock SSE), /api/archive/query (Athena, 60-second polling budget), plus the analytics→CsvResp reshape used by /cost/live
│   └── mock.js             Deterministic mock generators (dev fallback only)
├── collector/              Node 20 Lambda — daily S3 snapshot of Analytics API
│   ├── handler.js          Flatten → NDJSON → s3://<bucket>/<table>/date=YYYY-MM-DD/
│   └── glue-schemas.md     Columnar schema for Athena
├── infra/                  CDK (TypeScript)
│   ├── bin/app.ts          Entry — 4 stacks with context-driven VPC selection
│   └── lib/                network-stack · storage-stack · compute-stack · collector-stack
├── public/claude.svg       Favicon
├── docs/                   Architecture, ADRs, runbooks, onboarding, API reference
├── scripts/                setup + install-hooks
├── tests/                  Harness tests (hooks, structure, secrets)
└── tools/prompts/          AI prompt templates
```

## Key Commands

```bash
# Local dev
npm install                    # root + infra + collector should be installed separately
npm run dev                    # Vite (5173) + Express (5174) concurrently
npm run build                  # tsc -b && vite build → dist/
npm run preview                # preview built bundle
npm run server                 # Express standalone (prod behavior)

# Infra
cd infra && npm install
npx cdk synth --context existingVpcId=vpc-0dfa5610180dfa628
npx cdk deploy --all --require-approval never --context existingVpcId=vpc-0dfa5610180dfa628
npx cdk deploy ccd-compute --context existingVpcId=vpc-0dfa5610180dfa628   # single stack

# Collector
aws lambda invoke --region ap-northeast-2 --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 \
  --payload '{"date":"2026-04-18"}' --cli-binary-format raw-in-base64-out /tmp/out.json
```

## Conventions

- **Language**: Korean for conversation and commit messages, English for code/identifiers/UI strings (the UI has a runtime en/ko toggle).
- **TypeScript**: strict mode, noUnusedLocals, noUnusedParameters.
- **Server code**: ESM (`"type": "module"` in package.json). Use `node --check` for syntax validation before deploy.
- **Emails**: Always render via `maskEmail()` in UI (keep first 2 chars + domain). Server prompts enforce this in LLM output.
- **Secrets**: Never hardcoded. Stored in AWS Secrets Manager (`ccd/analytics-key`, `ccd/admin-key`, `ccd/compliance-key`) and injected into ECS tasks via `ecs.Secret.fromSecretsManager`. Local dev reads from gitignored `.env`.
- **CDK context**: Always pass `--context existingVpcId=vpc-0dfa5610180dfa628` in this account (EIP quota exhausted; reuse shared VPC).
- **Regions**: ap-northeast-2 primary. Bedrock model: `global.anthropic.claude-sonnet-4-6` (cross-region inference profile).

## Data Sources

| API | Key | Endpoint | Provides |
|---|---|---|---|
| Analytics — productivity | `sk-ant-api01-...` (Analytics scope) | `/v1/organizations/analytics/{users,summaries,skills,connectors,apps/chat/projects}` | Per-user engagement + CC productivity (LOC, commits, PRs, tool acceptance). NO USD/cost. |
| Analytics — cost (live) | same Analytics key | `/v1/organizations/analytics/{cost_report,usage_report}` | Org-wide spend (USD) + tokens by `(product, model)`. **No per-user dimension** — see ADR-0003. ~4h refresh, 30-day correction window. |
| Admin | `sk-ant-admin01-...` | `/v1/organizations/usage_report/{claude_code,messages}` + `/cost_report` | Workspace-scoped per-user × model `estimated_cost`; daily token + USD totals. Used by `/api/admin/*` proxy routes (still wired but not the primary cost path). |
| Compliance | `sk-ant-api01-...` (Compliance scope) | `/v1/compliance/activities` | Audit events. Cursor pagination via `after_id` (NOT `next_page`); see `server/index.js`. |
| CSV (Spend Report) | N/A (manual export) | S3 `spend-reports/` | Per-user × product × model spend totals. Drives the Cost page's per-user Top-N tables (live API has no user dimension). |
| S3 Archive | N/A (collector fills) | `s3://<bucket>/<table>/date=YYYY-MM-DD/` | Fast replay of Analytics API data beyond the 90-day window. Compliance is NOT yet archived to S3 — relies on the in-memory prewarm cache + cursor pagination from the live endpoint. |

## Auto-Sync Rules

1. **Before exiting Plan mode**: update `docs/architecture.md` if the plan touches stacks, data flow, or external dependencies.
2. **After writing/editing source**: `check-doc-sync.sh` hook runs; update the module's `CLAUDE.md` if the change alters its role.
3. **After an ADR**: link it from the Key Design Decisions section of `docs/architecture.md`.
4. **After a CDK deploy**: update the Deployed Stacks section in `docs/architecture.md` if resource names changed.
5. **Run `/sync-docs`** after a major refactor to score documentation freshness and generate a punchlist.
