#!/usr/bin/env bash
# One-shot Analytics API key rotation.
#
# The key is read ONLY from a hidden interactive prompt (`read -s`) — never a
# CLI argument, file, env var, or shell history. The script validates it
# against the Analytics API, writes it to the gitignored .env, pushes it to
# Secrets Manager (ccd/analytics-key), and forces an ECS redeploy so the new
# secret is injected. No plaintext key is ever echoed.
#
# Usage (run in an interactive terminal so the hidden prompt works):
#   bash scripts/rotate-analytics-key.sh
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"   # repo root
REGION=ap-northeast-2
SECRET_ID=ccd/analytics-key
VER=2023-06-01

read -rs -p "Paste the new Analytics API key (sk-ant-api01-...): " KEY; echo
[ -n "${KEY:-}" ] || { echo "✗ empty key, aborting"; exit 1; }
case "$KEY" in
  sk-ant-api01-*) : ;;
  *) echo "✗ key does not start with sk-ant-api01- , aborting"; unset KEY; exit 1 ;;
esac

echo "→ validating against the Analytics API…"
code=$(curl -s -o /tmp/rotate-key.json -w "%{http_code}" --max-time 25 \
  "https://api.anthropic.com/v1/organizations/analytics/summaries?starting_date=2026-05-20&ending_date=2026-06-07" \
  -H "x-api-key: $KEY" -H "anthropic-version: $VER")
if [ "$code" != "200" ]; then
  echo "✗ validation failed (HTTP $code): $(head -c 200 /tmp/rotate-key.json)"
  rm -f /tmp/rotate-key.json; unset KEY; exit 1
fi
rm -f /tmp/rotate-key.json
echo "✓ key is valid (analytics/summaries → 200)"

echo "→ updating .env (gitignored)…"
if grep -q '^ANTHROPIC_ANALYTICS_KEY=' .env 2>/dev/null; then
  sed -i.bak "s#^ANTHROPIC_ANALYTICS_KEY=.*#ANTHROPIC_ANALYTICS_KEY=${KEY}#" .env && rm -f .env.bak
else
  printf 'ANTHROPIC_ANALYTICS_KEY=%s\n' "$KEY" >> .env
fi
echo "✓ .env updated"

echo "→ updating Secrets Manager ${SECRET_ID}…"
aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
  --secret-string "$KEY" >/dev/null
echo "✓ Secrets Manager updated (new AWSCURRENT version)"

unset KEY   # drop the plaintext from memory before the (slow) ECS calls

echo "→ forcing ECS redeploy of ccd-compute so tasks pick up the new secret…"
CLUSTER=$(aws ecs list-clusters --region "$REGION" --query "clusterArns[?contains(@,'ccd')]|[0]" --output text)
SVC=$(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" --query "serviceArns[0]" --output text)
aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SVC" \
  --force-new-deployment >/dev/null
echo "✓ redeploy triggered for: ${SVC##*/}"
echo ""
echo "Done. Key stored in .env + Secrets Manager; not in shell history or git."
echo "Tasks roll over in ~2-3 min. Then tell Claude 'rotated' to verify + continue."
