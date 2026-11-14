# Runbook: organization IP allowlist blocks the dashboard

Since 2026-11-05 (beta) an owner can restrict a Claude Enterprise organization to a list of IP ranges in **claude.ai > Organization settings > Organization and access**. The list covers the apps and also the **Compliance API** and the **Admin API** called with a key for that organization. The dashboard reads the Compliance API from two places, so both must be on the list before it is turned on.

## Symptom

- An amber banner on every page: **"Anthropic is refusing the IP address of this server."**
- `GET /api/health` returns a non-null `ipAllowlistBlockedAt`.
- Audit, the member directory, Security posture, the plugin catalog and group names stop refreshing. Group tabs fall back to the spend-derived map.
- The collector's 00:30 UTC run records `compliance_error` with `blocked by the organization's IP allowlist`, and `compliance_daily` stops gaining partitions.
- Upstream body: HTTP 403, `error.type: "permission_error"`, message `Your IP address isn't in this organization's allowed range.`

## Impact

Compliance-backed data goes stale; nothing is lost. The feed keeps recording upstream, so the archive can be backfilled once access returns. Engagement and cost data (`/v1/organizations/analytics/*`) are not in the documented coverage of the allowlist; if they start returning the same 403, treat it the same way.

## Addresses to allow

Both callers leave through the NAT gateways of the dashboard VPC:

| Caller | Network | Leaves from |
|---|---|---|
| Dashboard server (ECS Fargate, `ccd-compute`) | private subnets, no public IP | the NAT gateway addresses |
| Collector (Lambda, `ccd-collector`) | the same private subnets while `collectorFixedEgress` is `true` in `infra/cdk.json` | the NAT gateway addresses |

List the current addresses (do not copy them from a document; they change if a NAT gateway is replaced):

```bash
aws ec2 describe-nat-gateways --region ap-northeast-2 \
  --filter Name=vpc-id,Values=vpc-0dfa5610180dfa628 Name=state,Values=available \
  --query 'NatGateways[].NatGatewayAddresses[].PublicIp' --output text
```

Add each address as a single-address entry. The second organization (`org2`) has its own allowlist; add the same addresses there.

## Diagnose

```bash
# 1. Is the server being refused right now?
curl -s https://<dashboard>/api/health | jq '.ipAllowlistBlockedAt'

# 2. Is the collector inside the VPC? (empty SubnetIds = dynamic AWS addresses, cannot be allowlisted)
aws lambda get-function-configuration --region ap-northeast-2 \
  --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 --query 'VpcConfig.SubnetIds'

# 3. Do the task subnets still route through the NAT gateways?
aws ec2 describe-route-tables --region ap-northeast-2 \
  --filters Name=association.subnet-id,Values=<task subnet ids> \
  --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId'

# 4. Who changed the allowlist, and when? (Audit page, or Athena)
#    activity types: org_ip_restriction_created / _updated / _deleted
```

## Fix

1. An owner (admins cannot edit the list) adds the NAT gateway addresses in claude.ai. If the owner is locked out too, they can still reach the settings page when **Allow owners to access this settings page from any IP address** was selected; otherwise Anthropic support turns the list off.
2. Changes take up to 15 minutes to apply. The banner clears on the next successful Compliance call (the audit prewarm runs every 5 minutes) or 15 minutes after the last refusal.
3. If the collector reports empty `SubnetIds` in step 2 of Diagnose, set `"collectorFixedEgress": true` in `infra/cdk.json` and deploy the collector stack:

   ```bash
   cd infra && npx cdk deploy ccd-collector --context existingVpcId=vpc-0dfa5610180dfa628
   ```

4. Backfill the audit days the collector missed (each day is a bounded query):

   ```bash
   aws lambda invoke --region ap-northeast-2 --function-name ccd-collector-Fn9270CBC0-DAPvUci8ngg6 \
     --cli-binary-format raw-in-base64-out \
     --payload '{"complianceOnly":true,"complianceStart":"YYYY-MM-DD","complianceEnd":"YYYY-MM-DD"}' /tmp/out.json
   ```

## Before the allowlist is turned on

- Confirm step 2 of Diagnose lists subnets.
- Give the owner the addresses from "Addresses to allow" and ask them to keep the "access this settings page from any IP address" box selected.
- Local development and probes run from a workstation address. With the list on, they need that address listed as well, or they get the same 403.

## Verify recovery

- [ ] `ipAllowlistBlockedAt` is `null` and the banner is gone.
- [ ] The Audit page shows events newer than the block.
- [ ] The next 00:30 UTC collector run writes `compliance/date=…` for the previous day without `compliance_error`.

## Notes

- Last verified: 2026-11-14. No allowlist was on at the time; the detection path is covered by `tests/server/test-ip-allowlist.mjs`, not by a live block.
- NAT addresses and the Fargate task subnets' default routes were read from the account on 2026-11-14: two NAT gateways, one per task subnet.
- Limits upstream: up to 1,000 entries, IPv4 no broader than `/8`. Claude Design, Claude in Slack and Claude Academy are not covered by the Enterprise allowlist.
- Reference: <https://platform.claude.com/docs/en/manage-claude/ip-allowlist>
