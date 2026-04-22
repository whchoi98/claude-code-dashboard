---
name: code-review
description: Review the changed code in the working tree against project conventions and common bug patterns. Use when the user asks for a code review, before committing, or before opening a PR.
---

# code-review

## When to use

- Before committing a logical unit of work
- Before opening a PR
- When asked to review specific files or the current diff

## What to do

1. Determine the review target:
   - If the user named files, use those.
   - Otherwise, `git diff --staged` first; if empty, `git diff`.
2. Read each changed file and the surrounding context (at least the enclosing function/class).
3. Check for, in order:
   - **Correctness** — off-by-one, null/undefined handling, async/await misuse, error suppression.
   - **Security** — hardcoded secrets (key shapes `sk-ant-*`, `AKIA*`), SQL injection, XSS, path traversal.
   - **Claude Code dashboard conventions** (see `CLAUDE.md`):
     - Emails always pass through `maskEmail()` before rendering.
     - AWS SDK calls use `@aws-sdk/client-*` (v3), never v2.
     - Secrets read from `process.env.*`, never literals.
     - CDK constructs reference the existing VPC via `existingVpcId` context.
   - **Performance** — N+1 API calls, synchronous `for...await` loops that can be `Promise.all`, missing caching.
   - **Types** — any `any`, missing return types on exported functions, non-null assertions without justification.
4. Score each finding **Critical / Major / Minor / Nit**. Only report Critical + Major inline with suggested fixes. Summarize Minor/Nit at the end.

## Output format

```
## Code review for <path(s)>

### 🔴 Critical (blocks merge)
- <file:line> — <issue> — <suggested fix>

### 🟠 Major (should fix before merge)
- <file:line> — <issue> — <suggested fix>

### 🟡 Minor / Nit
- <short list>

### ✅ LGTM
- <things the author got right — be specific, not generic>
```

Never rewrite files; only suggest.
