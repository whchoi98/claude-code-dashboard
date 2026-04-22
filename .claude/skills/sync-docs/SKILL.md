---
name: sync-docs
description: Run a full documentation freshness check — score every CLAUDE.md, architecture.md, and README against the current codebase, then propose patches. Use when the user asks to sync docs, audit docs, or check documentation staleness.
---

# sync-docs

## What to sync

1. **Root `CLAUDE.md`** — Tech Stack, Project Structure, Key Commands reflect `package.json`, actual directories, and scripts.
2. **Module `CLAUDE.md`s** — each top-level source dir (`src/`, `server/`, `collector/`, `infra/`) has one and it describes the current files.
3. **`docs/architecture.md`** — the ASCII diagram matches deployed resources; deployed stacks section matches `aws cloudformation list-stacks`.
4. **`README.md`** — installation steps work; feature list matches actual pages.
5. **`docs/api-reference.md`** — lists every route in `server/index.js` and `server/aws.js`.

## Process

For each document:

1. **Scan** — read the doc, extract the claims it makes (stack versions, file paths, commands, endpoints).
2. **Verify** — check each claim against the real codebase.
3. **Score 0-100** — points deducted for each stale / missing / incorrect claim. Show the score and top 3 gaps.
4. **Propose patches** — produce a unified diff per file. Don't apply without user confirmation.

## Output

```
## Doc sync report

| Document | Score | Top issue |
|----------|-------|-----------|
| CLAUDE.md | 85/100 | Tech Stack missing react-markdown |
| docs/architecture.md | 70/100 | Cost stack not documented |
| ...

## Proposed patches
<unified diff blocks, one per file>

Apply all? [y/n]
```
