# Working in this repository

## Project context

- Read [CLAUDE.md](CLAUDE.md) for the application architecture, data contracts and conventions.
- Read the applicable module guide before changing a layer: [frontend](src/CLAUDE.md), [server](server/CLAUDE.md), [collector](collector/CLAUDE.md), [infrastructure](infra/CLAUDE.md).
- Human documentation starts at [docs/README.md](docs/README.md). Preserve dated deployment records, ADR history and published release notes.

## Implementation and verification

- Use the existing React 18, Vite 6, React Router 7 and Node 20-compatible stack.
- Keep user-facing strings in both dictionaries in `src/lib/i18n.tsx`.
- Carry organization scope through API requests and caches. Render/export emails through `maskEmail()` and preserve the identity-aware visibility policy.
- Validate relevant changes with `npm test` and `npm run build`. Run `npm run test:e2e` for browser interaction or routing changes; install Chromium with `npx playwright install chromium` first.
- Browser tests intercept synthetic API responses. Keep their artifacts and local credentials out of commits and container build contexts.

## Git and release conventions

- Use Korean Conventional Commit descriptions; release metadata commits use `chore(release): vX.Y.Z`.
- `package.json` is the application version authority. Update its lockfile, both README version badges, and the English/Korean CHANGELOG entries together; use annotated `vX.Y.Z` tags.
- The independent `infra/` and `collector/` package versions do not track the application version.
- Stage only intended changes. Never commit `.env*`, local tool settings, `_local/`, generated `infra/edge/dist/`, CDK assemblies, browser reports or credentials.
- Follow the user's authorized commit, push, release and deployment scope. Do not force-push or replace published tags.
