# infra — AWS CDK (TypeScript)

## Role

Four-stack CDK app that provisions the VPC references, S3 + Glue + Athena, ECS Fargate compute with ALB + CloudFront + WAF, and the collector Lambda + EventBridge rule.

## Layout

```
infra/
├── bin/app.ts              # Entry; reads context (existingVpcId, cloudfrontPrefixListId, …)
├── lib/
│   ├── network-stack.ts    # VPC (new or lookup by id)
│   ├── storage-stack.ts    # S3 archive bucket + Glue DB + 6 tables (incl. compliance_daily) + Athena workgroup
│   ├── compute-stack.ts    # ECS service, ALB, CloudFront, WAF, Secrets Manager
│   └── collector-stack.ts  # Lambda + EventBridge schedule
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
- **Lambda@Edge secret injection**: CDK packages `infra/edge/dist/` into each Lambda@Edge zip. `dist/` is **generated** by `npm run build:edge` and `.gitignore`d — the committable source lives directly in `infra/edge/` (handlers + `_shared.template.js`). Rebuild before every deploy:
  ```bash
  npm run build:edge        # → produces infra/edge/dist/{_shared.js, check-auth.js, …}
  npx cdk deploy ...        # packages dist/ into the Lambda zips
  ```
  The template has an empty `CONFIG = /*__CCD_COGNITO_CONFIG__*/{…}/*__END_COGNITO_CONFIG__*/` sentinel; the build script replaces the whole expression with a JSON literal pulled from Secrets Manager (`ccd/cognito-config` — holds `userPoolId`, `clientId`, `clientSecret`, `domain`, `region`). Never commit these values to source.
- **Fargate is ARM64**. Both the task runtime platform and the Docker image asset use `LINUX_ARM64`.
- **Listener logical IDs** should be bumped (e.g., `Http` → `HttpV2`) if you need to force a listener recreation after drift. Deleting the listener out-of-band breaks CFN's reference.
- **Cognito callback URLs are NOT managed by CDK** — they live in the user pool client and are mutated by `aws cognito-idp update-user-pool-client` when a new alias domain (e.g., `c4e.whchoi.net`) is added. The CDK app currently re-creates the user pool client without these URLs on every deploy of the compute stack (Cognito + Lambda@Edge live in compute-stack.ts — there is no separate auth stack) — when adding an alias, also re-add the URLs to the CDK source so the next deploy doesn't overwrite them. Tracked separately; current values are: `https://d3ewilmru2tbq4.cloudfront.net`, `https://ccdashboard.whchoi.net`, `https://c4e.whchoi.net` (each with `/parseauth` for callback and `/` for logout).
- **CloudFront alias domains + ACM cert ARE now CDK-managed** (`domainNames` + `certificate` on the `Cdn` Distribution in `compute-stack.ts`, using the us-east-1 `*.whchoi.net` cert). They were originally console-added, and the 2026-07-12 origin-readTimeout deploy's CloudFormation update **silently stripped them** (`ERR_CERT_COMMON_NAME_INVALID` on the aliases) — any out-of-band change to a CFN-managed resource is reverted by the next deploy that touches it. When adding a NEW alias: update `domainNames` in the CDK source (cert is a wildcard, usually no change), add the Cognito callback URLs (previous bullet), and create the Route53/DNS CNAME.

## Cross-region gotchas

- WAF is **regional** (attached to the ALB) — it lives in the same region as the ALB, not us-east-1.
- CloudFront is global but the distribution resource is created in the compute stack's region (CFN accepts this).
- The Bedrock inference profile `global.anthropic.claude-sonnet-4-6` resolves to whichever region has capacity; no additional IAM scoping beyond the task role needed.
