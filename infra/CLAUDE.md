# infra — AWS CDK (TypeScript)

## Role

Four-stack CDK app that provisions the VPC references, S3 + Glue + Athena, ECS Fargate compute with ALB + CloudFront + WAF, and the collector Lambda + two EventBridge rules (14:00 UTC analytics-only, 00:30 UTC compliance-only; Lambda timeout 15 min).

## Layout

```
infra/
├── bin/app.ts              # Entry; reads context (existingVpcId, cloudfrontPrefixListId, …)
├── lib/
│   ├── network-stack.ts    # VPC (new or lookup by id)
│   ├── storage-stack.ts    # S3 archive bucket + Glue DB + 14 tables (7 primary incl. compliance_daily + plugins_daily + 7 *_org2 mirrors over org2/<prefix>/) + Athena workgroup
│   ├── compute-stack.ts    # ECS service, ALB, CloudFront, WAF, Secrets Manager
│   └── collector-stack.ts  # Lambda (15-min timeout) + 2 EventBridge rules (14:00 analytics / 00:30 compliance)
├── cdk.json                # `cdk` app command
└── package.json
```

## Conventions

- **Always pass `existingVpcId`** in this account: the target account's EIP quota is exhausted so a brand-new VPC+NAT cannot be provisioned. Example:
  ```bash
  npx cdk deploy --all --context existingVpcId=vpc-0dfa5610180dfa628
  ```
- **CloudFront prefix list** is region-specific; `bin/app.ts` has a built-in map (`CF_PREFIX_LIST_BY_REGION`) but can be overridden via `--context cloudfrontPrefixListId=pl-xxxxxxxx`.
- **Secrets names are the contract**: `ccd/analytics-key`, `ccd/admin-key`, `ccd/compliance-key`. Create them in Secrets Manager *before* the first `compute-stack` deploy or the stack will fail on secret lookup (using `Secret.fromSecretNameV2`).
- **Multi-org (org2)**: `ccd/analytics-key-2` is wired into BOTH compute-stack (`ANTHROPIC_ANALYTICS_KEY_2` via `ecs.Secret.fromSecretsManager`) and collector-stack (`ANTHROPIC_ANALYTICS_KEY_2_SECRET_ARN` + read grant) when the resolved `enableOrg2` context is true. The committed `infra/cdk.json` currently enables it, so normal deploys include org2 and require `ccd/analytics-key-2`. An absent flag defaults off in the construct; change the committed context deliberately when adapting a single-org deployment.
- **Lambda@Edge secret injection**: CDK packages `infra/edge/dist/` into each Lambda@Edge zip. `dist/` is **generated** by `npm run build:edge` and `.gitignore`d — the committable source lives directly in `infra/edge/` (handlers + `_shared.template.js`). Rebuild before every deploy:
  ```bash
  npm run build:edge        # → produces infra/edge/dist/{_shared.js, check-auth.js, …}
  npx cdk deploy ...        # packages dist/ into the Lambda zips
  ```
  The template has an empty `CONFIG = /*__CCD_COGNITO_CONFIG__*/{…}/*__END_COGNITO_CONFIG__*/` sentinel; the build script replaces the whole expression with a JSON literal pulled from Secrets Manager (`ccd/cognito-config` — holds `userPoolId`, `clientId`, `clientSecret`, `domain`, `region`). Never commit these values to source.
- **Fargate is ARM64**. Both the task runtime platform and the Docker image asset use `LINUX_ARM64`.
- **Listener logical IDs** should be bumped (e.g., `Http` → `HttpV2`) if you need to force a listener recreation after drift. Deleting the listener out-of-band breaks CFN's reference.
- **Cognito pool/client are managed outside these stacks.** `compute-stack.ts` imports `ccd/cognito-config`; it does not create or replace a UserPool or UserPoolClient. The edge build reads this config and ECS receives only the pool/client identifiers. When adding an alias, align the existing Cognito client callback/logout URLs, the CDK CloudFront aliases/certificate, and DNS. See `docs/runbooks/cognito-users.md`.
- **CloudFront alias domains + ACM cert ARE now CDK-managed** (`domainNames` + `certificate` on the `Cdn` Distribution in `compute-stack.ts`, using the us-east-1 `*.whchoi.net` cert). They were originally console-added, and the 2026-07-12 origin-readTimeout deploy's CloudFormation update **silently stripped them** (`ERR_CERT_COMMON_NAME_INVALID` on the aliases) — any out-of-band change to a CFN-managed resource is reverted by the next deploy that touches it. When adding a NEW alias: update `domainNames` in the CDK source (cert is a wildcard, usually no change), add the Cognito callback URLs (previous bullet), and create the Route53/DNS CNAME.

## Cross-region gotchas

Validate application releases with a production image smoke test, then compare the synthesized stack before deploying. Routine application-only releases replace the task-definition image; observe CloudFormation completion, ECS rollout completion, the app container's digest/health, and load-balancer target health. Record deployed artifacts in `docs/deployments/`; [the 2026-09-21 record](../docs/deployments/2026-09-21.md) is an example.

- WAF is **regional** (attached to the ALB) — it lives in the same region as the ALB, not us-east-1.
- CloudFront is global but the distribution resource is created in the compute stack's region (CFN accepts this).
- The Bedrock inference profile `global.anthropic.claude-sonnet-4-6` resolves to whichever region has capacity; no additional IAM scoping beyond the task role needed.
