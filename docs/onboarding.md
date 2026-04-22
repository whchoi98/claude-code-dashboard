# Onboarding

Day-1 setup for a new developer.

## Prerequisites

- Node.js ≥ 20 (`node -v`)
- npm ≥ 10
- Docker running (`docker version`)
- AWS CLI v2 with SSO or keypair for the target account
- AWS CDK CLI (`npx cdk --version` — bootstrap works without global install)

## Setup

```bash
# Clone and install
git clone https://github.com/whchoi98/claude-code-dashboard.git
cd claude-code-dashboard
bash scripts/setup.sh          # installs root + infra + collector deps, installs git hooks

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
| Type-check only | `npx tsc --noEmit` |
| Production build | `npm run build` |
| Deploy compute stack | `cd infra && npx cdk deploy ccd-compute --context existingVpcId=vpc-0dfa5610180dfa628` |
| Invoke collector manually | `aws lambda invoke --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 --payload '{"date":"2026-04-18"}' --cli-binary-format raw-in-base64-out /tmp/out.json` |
| Query Athena from the UI | open `/archive` — default SQL template is pre-filled |

## Where to read first

1. `CLAUDE.md` — project-wide conventions.
2. `docs/architecture.md` — the big picture.
3. `src/pages/*.tsx` — page-by-page logic; each is small and self-contained.
4. `server/index.js` / `server/aws.js` — API surface.
5. `infra/lib/*-stack.ts` — infrastructure.

## Cost awareness

A fresh deployment in `ap-northeast-2` runs **~$80/month** in light use (Fargate 2 tasks, ALB+WAF, Bedrock ~50 analyze queries). Moderate use is **~$130**, heavy use **~$250**. Full breakdown in [README.md — Cost Estimate](../README.md#cost-estimate-ap-northeast-2). Tear down with `cdk destroy --all` when idle.

## Troubleshooting

- **`cdk deploy` fails with EIP quota** — the account's 5 EIPs are already consumed. Deploy with `--context existingVpcId=<vpc-id>` to reuse an existing VPC.
- **Bedrock calls return 403** — check the task role has `bedrock:InvokeModel` on the inference profile ARN. See `docs/runbooks/` or `infra/lib/compute-stack.ts`.
- **`tsc --noEmit` stuck on 404 imports** — run `npm install` in the project root.
- **Mock data appears in Cost/Productivity pages** — means the Analytics API key is missing or a recent day is inside the 3-day buffer; see `docs/runbooks/` once created.
