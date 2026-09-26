---
description: Run the full test/validation suite for this project
---

# /test-all

Execute every validation command in order; stop at the first failure and surface the exact error.

## Sequence

1. **TypeScript type check** (frontend):
   ```bash
   npx tsc --noEmit
   ```
2. **Vite production build**:
   ```bash
   npx vite build
   ```
3. **Server syntax check** (ESM, no bundler):
   ```bash
   for f in server/*.js collector/*.js; do node --check "$f" || exit 1; done
   ```
4. **CDK synth** (requires the Lambda@Edge bundle and `--context existingVpcId`):
   ```bash
   npm run build:edge
   cd infra && npx cdk synth --context existingVpcId=vpc-0dfa5610180dfa628 > /dev/null
   ```
5. **Server harness + Vitest frontend suite**:
   ```bash
   npm test
   ```
6. **Browser tests** (for routing or browser-interaction changes; first run `npx playwright install chromium`):
   ```bash
   npm run test:e2e
   ```

## Recovery

- On TS error: print the first 20 lines of `tsc` output; suggest the file to fix.
- On CDK synth error: check that `cdk.context.json` is up to date (`cdk context`).
- On hook test fail: `bash tests/hooks/test-hooks.sh` for narrower output.
