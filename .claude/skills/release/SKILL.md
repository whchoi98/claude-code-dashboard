---
name: release
description: Cut a new release — bump version, update CHANGELOG, tag, and (optionally) deploy. Use when the user says "release", "cut a version", "bump to X.Y.Z", or "ship".
---

# release

## Inputs

- Version bump type: `patch` / `minor` / `major` — or explicit semver.
- Optional: release notes additions beyond what's in Unreleased.

## Steps

1. **Verify clean tree**: `git status --porcelain` must be empty. Fail fast otherwise.
2. **Determine version**:
   - Read `package.json` current version.
   - Apply bump per [SemVer](https://semver.org/) rules.
3. **Update CHANGELOG.md** (English + 한국어 blocks, both):
   - Move everything under `[Unreleased]` into a new `[X.Y.Z] - YYYY-MM-DD` section.
   - Leave `[Unreleased]` empty.
   - Update reference links at the bottom of each language section.
4. **Bump `package.json`** version (and `infra/package.json`, `collector/package.json` if they track the same version).
5. **Commit**: `chore(release): vX.Y.Z`.
6. **Tag**: `git tag -a vX.Y.Z -m "Release X.Y.Z"`.
7. **Push**: `git push && git push --tags` (only after confirming with the user).
8. **Deploy** (on request): `cd infra && npx cdk deploy ccd-compute --context existingVpcId=vpc-0dfa5610180dfa628`.

## Safety

- Never push `--force`.
- Never amend a published tag.
- Pause before `git push` to show the planned commit and tag, and ask the user to confirm.
