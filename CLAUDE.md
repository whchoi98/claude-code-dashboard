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
│   ├── components/         Shared UI (Layout, ClaudeIcon, KpiCard, ChartCard, UserDetailPanel, DateRangeControl, Markdown)
│   ├── pages/              11 routes (Overview, Users, UserProductivity, Trends, ClaudeCode, Productivity, Adoption, Cost, Compliance, Analyze, Archive)
│   ├── lib/                i18n (ko/en), useDateRange, useFetch, format (masking, number, date)
│   ├── types.ts            Analytics API schema types
│   ├── App.tsx             Router
│   └── main.tsx            Entry + I18nProvider
├── server/                 Express API layer
│   ├── index.js            Proxy routes: /api/analytics/*, /api/admin/*, /api/compliance/*, health
│   ├── aws.js              Bedrock (SSE analyze, SQL gen), Athena, S3 CSV, cost efficiency join
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
| Analytics (Enterprise) | `sk-ant-api01-...` | `/v1/organizations/analytics/{users,summaries,skills,connectors,apps/chat/projects}` | Engagement, CC productivity (LOC, commits, PRs, tool acceptance) |
| Admin | `sk-ant-admin01-...` | `/v1/organizations/usage_report/{claude_code,messages}` + `/cost_report` | Token counts, model breakdown, estimated cost (cents USD) |
| Compliance | `sk-ant-api01-...` (Compliance scope) | `/v1/compliance/activities` | Audit events (login, role change, file/chat ops, API calls) |
| CSV (Spend Report) | N/A (manual export) | S3 `spend-reports/` | Per-user × product × model spend + token totals |
| S3 Archive | N/A (collector fills) | `s3://<bucket>/<table>/date=YYYY-MM-DD/` | Fast replay of Analytics API data beyond 90-day window |

## Auto-Sync Rules

1. **Before exiting Plan mode**: update `docs/architecture.md` if the plan touches stacks, data flow, or external dependencies.
2. **After writing/editing source**: `check-doc-sync.sh` hook runs; update the module's `CLAUDE.md` if the change alters its role.
3. **After an ADR**: link it from the Key Design Decisions section of `docs/architecture.md`.
4. **After a CDK deploy**: update the Deployed Stacks section in `docs/architecture.md` if resource names changed.
5. **Run `/sync-docs`** after a major refactor to score documentation freshness and generate a punchlist.
