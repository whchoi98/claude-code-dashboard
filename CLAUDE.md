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
| External APIs | Anthropic Analytics API · Admin API · Compliance API (the Analytics key's scopes now cover compliance reads — the dedicated Compliance key is optional; server falls back automatically) |

## Project Structure

```
claude-code-dashboard/
├── src/                    React SPA (Vite)
│   ├── components/         Shared UI (Layout, ClaudeIcon, KpiCard, ChartCard, PageHeader, LoadingState, UserDetailPanel, DateRangeControl, CsvUploader, Markdown, SortableTh). Layout pins the sidebar to the viewport via h-screen + per-pane overflow-y-auto so scrolling moves only the main pane; it also renders the version badge (links to /changelog) and the static AWS run-rate label.
│   ├── pages/              19 routes (Overview, Executive, Users, UserProductivity, UserSearch, Trends, ClaudeCode, ClaudeChat, Cowork, Office, Design, Productivity, Agentic, Adoption, Cost, Compliance, Analyze, Archive, Changelog). Default date range is 7d. The DateRangeControl now allows today as the end date (engagement endpoints clamp to the 3-day buffer server-side; the cost family serves recent days with partial data).
│   ├── lib/                i18n (ko/en), useDateRange, useFetch, useHealth, useSortable, format (masking, number, date)
│   ├── types.ts            Analytics API schema types
│   ├── App.tsx             Router
│   ├── index.css           Tailwind entry + the generic `@media print` block keyed off `body.app-print` that powers Save-as-PDF on Analyze, Cost, and Executive (visibility-isolated `.print-export` subtree, auto-expanded `<details>`, Claude palette preserved on paper)
│   └── main.tsx            Entry + I18nProvider
├── server/                 Express API layer
│   ├── orgs.js             Multi-org resolution (ADR-0018): org ids primary|org2, ?org= validation, per-org key/S3-prefix/label helpers
│   ├── index.js            Proxy routes: /api/analytics/*, /api/admin/*, /api/compliance/* (after_id cursor; response-level SWR cache with 45s-foreground/240s-background walk budgets + partial:true degrade — ADR-0016; 5-min prewarm top-ups the four UI preset windows with frontend-identical keys), /api/health, plus a 10-minute in-memory cache shared across upstream calls; gzip compression middleware (SSE chat stream exempt via no-transform — CloudFront can't compress: its dynamic behaviors run CACHING_DISABLED, only /assets/* is edge-cached+brotli'd)
│   ├── aws.js              registerAwsRoutes(): /api/cost/{live,users,user-tokens,groups,spend-limits,csv,upload,uploads,efficiency} (/cost/live + /cost/groups ride a 10-min success TTL cache with stale-while-revalidate — the rbac dimension runs 12–30s upstream), /api/groups(+/upload — email→group map; source chain: admin CSV > compliance members endpoint (real membership, 1h cache) > spend-derived arrays > last-good), /api/chat/stream (Bedrock SSE chatbot), /api/archive/query (Athena, 60-second polling budget), plus the analytics→CsvResp reshape used by /cost/live
│   └── mock.js             Deterministic mock generators (dev fallback only)
├── collector/              Node 20 Lambda — daily S3 snapshot of Analytics API
│   ├── handler.js          Flatten → NDJSON → s3://<bucket>/<table>/date=YYYY-MM-DD/ (+ raw sidecar of unflattened records under raw/<table>/ — retroactive recovery for API fields flatten.js doesn't map yet)
│   └── glue-schemas.md     Columnar schema for Athena
├── infra/                  CDK (TypeScript)
│   ├── bin/app.ts          Entry — 4 stacks with context-driven VPC selection
│   └── lib/                network-stack · storage-stack · compute-stack · collector-stack
├── public/claude.svg       Favicon
├── site/                   Public GitHub Pages brochure (self-contained index.html + img/ masked screenshots; publish via scripts/deploy-pages.sh → gh-pages branch)
├── docs/                   Architecture, ADRs, runbooks, onboarding, API reference
├── scripts/                setup + install-hooks + deploy-pages.sh (gh-pages publish)
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
- **Version strings** (bump all on release — see `/release`): `package.json` `version` is the single source of truth (the sidebar badge reads it via `Layout.tsx` `pkg.version`, so the UI shows the new version only after the next deploy); README.md + README.ko.md shields badges (`version-X.Y.Z-blue`); `CHANGELOG.md` version heading. Tag as `vX.Y.Z`.
- **TypeScript**: strict mode, noUnusedLocals, noUnusedParameters.
- **Server code**: ESM (`"type": "module"` in package.json). Use `node --check` for syntax validation before deploy.
- **Emails**: Always render via `maskEmail()` in UI (keep first 2 chars + domain). Server prompts enforce this in LLM output.
- **Secrets**: Never hardcoded. Stored in AWS Secrets Manager (`ccd/analytics-key`, `ccd/admin-key`, `ccd/compliance-key`) and injected into ECS tasks via `ecs.Secret.fromSecretsManager`. Local dev reads from gitignored `.env`.
- **CDK context**: Always pass `--context existingVpcId=vpc-0dfa5610180dfa628` in this account (EIP quota exhausted; reuse shared VPC).
- **Regions**: ap-northeast-2 primary. Bedrock model: `global.anthropic.claude-sonnet-4-6` (cross-region inference profile).
- **Multi-org (ADR-0018)**: a second subscription is org `org2` — key env `ANTHROPIC_ANALYTICS_KEY_2` (secret `ccd/analytics-key-2`), enabled in infra by flipping `enableOrg2` to `true` in `infra/cdk.json` (COMMITTED — a CLI-only flag would silently revert org2 on the next routine deploy). Every server route resolves `orgFromReq(req)`; every response-cache key is org-prefixed; org2 S3/Glue live under `org2/` + `*_org2` tables. New routes/pages MUST thread the org (see server/CLAUDE.md Multi-org rules).

## Data Sources

| API | Key | Endpoint | Provides |
|---|---|---|---|
| Analytics — productivity | `sk-ant-api01-...` (Analytics scope) | `/v1/organizations/analytics/{users,summaries,skills,connectors,apps/chat/projects}` | Per-user engagement + CC productivity (LOC, commits, PRs, tool acceptance). NO USD/cost. |
| Analytics — cost (live) | same Analytics key | `/v1/organizations/analytics/{cost_report,usage_report,user_cost_report,user_usage_report}` | Org-wide spend (USD) + tokens by `(product, model, rbac_group_id, …)`, plus **per-user USD (user_cost_report) and per-user tokens (user_usage_report)** — ADR-0003's "no per-user dimension" no longer holds (2026-07). ~4h refresh watermark (`data_refreshed_at`), 30-day correction window, **31-day max span per request** (the server CHUNKS longer windows into ≤31-day segments and merges, up to 186 days — ADR-0019). |
| Admin | `sk-ant-admin01-...` | `/v1/organizations/usage_report/{claude_code,messages}` + `/cost_report` | Workspace-scoped per-user × model `estimated_cost`; daily token + USD totals. Used by `/api/admin/*` proxy routes (still wired but not the primary cost path). |
| Compliance | `sk-ant-api01-...` (Compliance scope) | `/v1/compliance/activities` + `/v1/compliance/groups(/{id}/members)` | Audit events (cursor pagination via `after_id`, NOT `next_page`; see `server/index.js`) + RBAC group names AND authoritative per-group membership (`next_page` cursor, 1h cache; drives `/api/groups` since 2026-07-12 — ADR-0014). |
| CSV (Spend Report) | N/A (manual export) | S3 `spend-reports/` | Per-user × product × model spend totals. **Fallback/reconciliation only** since 2026-07: live per-user spend (user_cost_report) and tokens (user_usage_report) drive the Cost page's Top-N tables; the CSV covers >31-day windows and live-report outages. |
| S3 Archive | N/A (collector fills) | `s3://<bucket>/<table>/date=YYYY-MM-DD/` | Fast replay of Analytics API data beyond the 90-day window. Since 2026-07-15 compliance audit events are ALSO archived (`compliance/date=…` + raw sidecar, partition day = event `created_at` day, current through yesterday — ADR-0017) and queryable via Athena `compliance_daily`; the live audit PAGE still serves from the in-memory prewarm cache (newest 2000 events). |

## Auto-Sync Rules

1. **Before exiting Plan mode**: update `docs/architecture.md` if the plan touches stacks, data flow, or external dependencies.
2. **After writing/editing source**: `check-doc-sync.sh` hook runs; update the module's `CLAUDE.md` if the change alters its role.
3. **After an ADR**: link it from the Key Design Decisions section of `docs/architecture.md`.
4. **After a CDK deploy**: update the Deployed Stacks section in `docs/architecture.md` if resource names changed.
5. **Run `/sync-docs`** after a major refactor to score documentation freshness and generate a punchlist.
