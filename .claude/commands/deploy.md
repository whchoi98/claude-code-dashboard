---
description: Build the Vite bundle, rebuild the container image, and deploy ccd-compute (fast path)
argument-hint: "[stack name: all | ccd-compute (default) | ccd-collector | ccd-storage | ccd-network]"
---

# /deploy

Fast-path deployment for iteration on the ECS Fargate service. Defaults to the `ccd-compute` stack (which rebuilds the Docker image and rolls the tasks).

## Preflight

1. Confirm AWS context:
   ```bash
   aws sts get-caller-identity
   aws configure get region
   ```
   Expected: account `061525506239`, region `ap-northeast-2`.
2. Pass `--context existingVpcId=vpc-0dfa5610180dfa628` — the account's EIP quota is exhausted, so the CDK must reuse the shared VPC.

## Sequence

```bash
# 1. Type check (fast fail)
npx tsc --noEmit

# 2. Optional local build check
npx vite build

# 3. Deploy the target stack (default = ccd-compute)
cd infra
npx cdk deploy ${1:-ccd-compute} --require-approval never \
  --context existingVpcId=vpc-0dfa5610180dfa628 \
  --outputs-file cdk-outputs.json
```

## Recovery

- **Listener drift** (`TargetGroup ... does not have an associated load balancer`): run `aws elbv2 describe-listeners` — if empty, recreate via `aws elbv2 create-listener`. See `docs/runbooks/alb-listener-drift.md`.
- **ROLLBACK_COMPLETE** stuck: `aws cloudformation delete-stack` then redeploy.
- **Docker daemon down**: `sudo systemctl start docker`.
- **Image push permission denied**: re-login to ECR, `aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-northeast-2.amazonaws.com`.
