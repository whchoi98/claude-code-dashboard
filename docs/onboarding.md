# Onboarding

Day-1 setup for a new developer.

## Prerequisites

- Node.js ≥ 20 (`node -v`)
- npm ≥ 10
- Docker running (`docker version`)
- AWS CLI v2 with SSO or keypair for the target account
- AWS CDK CLI from the locked `infra/` dependencies (`cd infra && npx cdk --version`)
- For deployment, the configured AWS account, existing VPC, API secrets and `ccd/cognito-config` must be available; imported resource ARNs live in `infra/lib/compute-stack.ts`.

## Setup

```bash
# Clone and install
git clone https://github.com/whchoi98/claude-code-dashboard.git
cd claude-code-dashboard
npm ci
(cd infra && npm ci)
(cd collector && npm ci)

# Local environment
cp .env.example .env
# Edit .env — set ANTHROPIC_ANALYTICS_KEY (minimum).
# Optional: ANTHROPIC_ADMIN_KEY_ADMIN, ANTHROPIC_COMPLIANCE_KEY.

# First run
npm run dev
# → http://localhost:5173
```

## Common tasks

| Task | Command |
|------|---------|
| Start local dev (hot reload) | `npm run dev` |
| Type-check only | `npm run typecheck` |
| Server/structure + frontend tests | `npm test` |
| Install browser for tests | `npx playwright install chromium` |
| Production browser tests (synthetic APIs) | `npm run test:e2e` |
| Production build | `npm run build` |
| Prepare edge auth bundle | `npm run build:edge` (before CDK synth/diff/deploy) |
| Review compute changes | `cd infra && npx cdk diff ccd-compute --context existingVpcId=vpc-0dfa5610180dfa628` |
| Deploy compute stack | `cd infra && npx cdk deploy ccd-compute --context existingVpcId=vpc-0dfa5610180dfa628` |
| Invoke collector manually | `aws lambda invoke --region ap-northeast-2 --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 --payload '{"date":"2026-04-18"}' --cli-binary-format raw-in-base64-out /tmp/out.json` |
| Query Athena from the UI | open `/archive` — default SQL template is pre-filled |

## Where to read first

1. [Documentation index](README.md) and [AGENTS.md](../AGENTS.md) — navigation and contributor conventions.
2. `docs/architecture.md` — the big picture.
3. `src/App.tsx`, `src/components/Layout.tsx`, `src/lib/api.ts` — lazy routing, navigation/recovery and organization-scoped requests; page-specific aggregation lives in `src/pages/`.
4. `server/index.js` / `server/aws.js` — API surface.
5. `infra/lib/*-stack.ts` — infrastructure.

## Cost awareness

The [README planning example](../README.md#cost-estimate-ap-northeast-2) describes historical assumptions. Check the actual configured resources and account billing for current costs; this documentation sync does not recalculate AWS prices.

## Troubleshooting

- **`cdk deploy` fails with EIP quota** — the account's 5 EIPs are already consumed. Deploy with `--context existingVpcId=<vpc-id>` to reuse an existing VPC.
- **Bedrock calls return 403** — check the task role has `bedrock:InvokeModel` on the inference profile ARN. See `docs/runbooks/` or `infra/lib/compute-stack.ts`.
- **`tsc --noEmit` stuck on 404 imports** — run `npm install` in the project root.
- **Mock data appears in engagement pages** — no Analytics key is configured. With a key, upstream errors are reported without substituting synthetic records. Engagement dates follow the learned finalization horizon; live cost serves through today and chunks windows up to 186 days. CSV is an optional reconciliation/outage fallback, not a requirement for every window over 31 days.
- **A browser storage preference fails** — language and organization choices remain usable for the current visit even when localStorage is unavailable.
- **A page or request fails** — use its retry action. A failed lazy module may require the full Reload action; browser tests cover both the navigation shell and request recovery.
