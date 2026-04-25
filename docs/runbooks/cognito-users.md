# Runbook: Cognito user management

Day-to-day Cognito admin for the dashboard user pool. Use this for: onboarding a new admin, resetting a forgotten password, deactivating a departed user, rotating the app client secret.

All commands assume `AWS_REGION=ap-northeast-2` (or `--region ap-northeast-2`). Pool id + app client id are the canonical identifiers stored in Secrets Manager (`ccd/cognito-config`) — read them from there rather than hardcoding in scripts.

```bash
POOL=$(aws secretsmanager get-secret-value --secret-id ccd/cognito-config \
  --region ap-northeast-2 --query SecretString --output text | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['userPoolId'])")
echo "pool: $POOL"
```

## Add a new admin

Precondition: the email address should match the org's identity provider (for future SSO). Passwords must satisfy the pool policy (≥8 chars, upper + lower + digit + symbol).

```bash
EMAIL=new.admin@example.com
PW='StrongPa$$w0rd'

# Create in SUPPRESS mode (no Cognito-default invite email — Cognito's
# sandbox email often does not deliver reliably).
aws cognito-idp admin-create-user \
  --region ap-northeast-2 --user-pool-id "$POOL" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

# Set a known permanent password so the first login does NOT hit the
# FORCE_CHANGE_PASSWORD state. Relay the credentials to the user via a
# secure channel (1Password / Keybase), then ask them to change it from
# the Cognito Hosted UI `forgotPassword` flow.
aws cognito-idp admin-set-user-password \
  --region ap-northeast-2 --user-pool-id "$POOL" \
  --username "$EMAIL" --password "$PW" --permanent
```

Verify:

```bash
aws cognito-idp admin-get-user --region ap-northeast-2 \
  --user-pool-id "$POOL" --username "$EMAIL" \
  --query '{Status:UserStatus,Enabled:Enabled}' --output table
# Expected: Status=CONFIRMED, Enabled=true
```

## Reset a forgotten password

```bash
EMAIL=existing.admin@example.com
NEW_PW='NewStrongPa$$w0rd'

aws cognito-idp admin-set-user-password \
  --region ap-northeast-2 --user-pool-id "$POOL" \
  --username "$EMAIL" --password "$NEW_PW" --permanent
```

Or trigger the self-service flow (user gets an email via Cognito's default sender — may not deliver if the pool hasn't been connected to SES):

```bash
aws cognito-idp admin-reset-user-password \
  --region ap-northeast-2 --user-pool-id "$POOL" \
  --username "$EMAIL"
```

## Deactivate / remove a user

`admin-disable-user` is reversible (keeps audit trail); `admin-delete-user` is permanent. Default to disable.

```bash
# Disable (reversible)
aws cognito-idp admin-disable-user --region ap-northeast-2 \
  --user-pool-id "$POOL" --username "$EMAIL"

# Re-enable later
aws cognito-idp admin-enable-user --region ap-northeast-2 \
  --user-pool-id "$POOL" --username "$EMAIL"

# Delete (permanent — use for confirmed offboarding)
aws cognito-idp admin-delete-user --region ap-northeast-2 \
  --user-pool-id "$POOL" --username "$EMAIL"
```

Existing sessions survive disable/delete until their access token expires (1h default) or the refresh token is revoked. To force-revoke:

```bash
aws cognito-idp admin-user-global-sign-out --region ap-northeast-2 \
  --user-pool-id "$POOL" --username "$EMAIL"
```

## Rotate the OAuth client secret

Cognito's `update-user-pool-client` does not support rotating an existing secret. The pattern is delete + recreate with identical config.

```bash
# Describe the current client so the new one mirrors it exactly
aws cognito-idp describe-user-pool-client --region ap-northeast-2 \
  --user-pool-id "$POOL" \
  --client-id $(aws secretsmanager get-secret-value --secret-id ccd/cognito-config \
    --region ap-northeast-2 --query SecretString --output text | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['clientId'])") \
  --output json > /tmp/current-client.json
```

Then re-create (manually or via a short script) with `--generate-secret`, update `ccd/cognito-config` in Secrets Manager with the new `clientId` + `clientSecret`, rebuild the edge bundle, and redeploy:

```bash
npm run build:edge               # regenerates infra/edge/dist/_shared.js
cd infra && npx cdk deploy ccd-compute \
  --require-approval never \
  --context existingVpcId=vpc-0dfa5610180dfa628
```

Finally, delete the old client once the new one is verified working.

## Password policy tuning

`admin-set-user-password` enforces the pool's current policy. If a password you intend to set is shorter than the policy allows, the command errors with `InvalidPasswordException`. Read the current policy:

```bash
aws cognito-idp describe-user-pool --region ap-northeast-2 \
  --user-pool-id "$POOL" \
  --query 'UserPool.Policies.PasswordPolicy' --output json
```

To change it (note `update-user-pool` is a full replace — pass through other fields or they will reset to defaults):

```bash
# Use the existing Python helper pattern in CHANGELOG/Unreleased context.
# A minimal safe change: only touch MinimumLength.
# See the user-replacement commit history for a reference script.
```

## Related

- [ADR-0001](../decisions/0001-cognito-lambda-edge-auth.md) — why Cognito + Lambda@Edge.
- Secrets Manager: `ccd/cognito-config` holds `userPoolId`, `clientId`, `clientSecret`, `domain`, `region`.
- Hosted UI: `https://ccd-dashboard-061525506239.auth.ap-northeast-2.amazoncognito.com` (login, forgot password).
