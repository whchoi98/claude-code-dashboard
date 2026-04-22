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
   node --check server/index.js
   node --check server/aws.js
   node --check server/mock.js
   node --check collector/handler.js
   ```
4. **CDK synth** (requires `--context existingVpcId`):
   ```bash
   cd infra && npx cdk synth --context existingVpcId=vpc-0dfa5610180dfa628 > /dev/null
   ```
5. **Harness tests**:
   ```bash
   bash tests/run-all.sh
   ```

## Recovery

- On TS error: print the first 20 lines of `tsc` output; suggest the file to fix.
- On CDK synth error: check that `cdk.context.json` is up to date (`cdk context`).
- On hook test fail: `bash tests/hooks/test-hooks.sh` for narrower output.
