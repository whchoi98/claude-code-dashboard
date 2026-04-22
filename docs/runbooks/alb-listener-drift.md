# Runbook: ALB listener missing / target group orphaned

## Symptom

- Dashboard returns **HTTP 504** or connection timeout at `https://d3ewilmru2tbq4.cloudfront.net/`.
- `aws elbv2 describe-listeners --load-balancer-arn <alb>` returns an empty array.
- `cdk deploy ccd-compute` fails with `The target group ccd-co-AlbHt-... does not have an associated load balancer`.

## Impact

All dashboard traffic fails. ECS service is healthy internally but has no ingress path.

## Diagnose

```bash
ALB_ARN=$(aws elbv2 describe-load-balancers --region ap-northeast-2 \
  --query 'LoadBalancers[?contains(LoadBalancerName,`ccd`)].LoadBalancerArn|[0]' --output text)

# 1. Confirm no listener
aws elbv2 describe-listeners --region ap-northeast-2 --load-balancer-arn "$ALB_ARN"

# 2. Check CFN drift (expect "DRIFTED")
aws cloudformation detect-stack-drift --region ap-northeast-2 --stack-name ccd-compute
```

## Mitigate (service back in ~30 seconds)

```bash
TG_ARN=$(aws elbv2 describe-target-groups --region ap-northeast-2 \
  --query 'TargetGroups[?contains(TargetGroupArn,`ccd-co-AlbHt`)].TargetGroupArn|[0]' --output text)

aws elbv2 create-listener --region ap-northeast-2 \
  --load-balancer-arn "$ALB_ARN" \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn="$TG_ARN"
```

Verify:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' \
  http://ccd-co-Alb16-xxx.ap-northeast-2.elb.amazonaws.com/api/health
```

## Restore CloudFormation control

After the manual listener is in place, the CFN state still holds the old (nonexistent) listener ARN. Change the listener logical ID in `infra/lib/compute-stack.ts` (e.g., `'Http'` → `'HttpV2'`) and redeploy so CFN creates a new listener it knows about:

```bash
cd infra
npx cdk deploy ccd-compute --context existingVpcId=vpc-0dfa5610180dfa628
```

Then delete the now-duplicate manual listener if one remains.

## Root cause analysis

- **Trigger**: usually an earlier `cdk deploy` that replaced the listener but rolled back partially, leaving the target group orphaned.
- **Prevention**: keep `circuitBreaker: { rollback: true }` on the ECS service, and avoid deploying mid-drift — run `detect-stack-drift` before large changes.
