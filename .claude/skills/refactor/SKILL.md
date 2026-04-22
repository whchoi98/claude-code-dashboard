---
name: refactor
description: Refactor existing code to improve clarity, remove duplication, and apply SRP without changing behavior. Use when the user asks to refactor, clean up, or simplify code.
---

# refactor

## Principles

- **Preserve behavior**. No feature changes, no scope creep. Run the affected tests before and after.
- **One axis per pass**. Don't rename + restructure + retype in the same commit.
- **Delete > add**. Prefer removing code over adding abstractions. Three similar lines beat a premature helper.
- **Leave the file better than you found it**. Fix a nearby lint warning or missing type while you're there — but keep the diff focused.

## Steps

1. Read the target file(s) and their callers (`grep -R '<symbol>'`).
2. Identify the refactor type: **Extract** / **Rename** / **Replace conditional** / **Introduce type** / **Delete dead code**.
3. Apply the change in small, verifiable steps.
4. Run the relevant test/build: `npm run build` for frontend, `node --check` for server JS, `npx cdk synth` for infra.
5. If you touched types, run `npx tsc --noEmit`.
6. Update any `CLAUDE.md` that describes moved/renamed modules.

## Anti-patterns to avoid

- Adding error handling that swallows the error (`try {...} catch { return null }`).
- Creating a new abstraction layer to "make it easier to add X later" when X isn't on the roadmap.
- Renaming public exports without updating callers.
- Converting sequential async loops to `Promise.all` without checking rate limits or ordering guarantees.

## Output

Produce a diff summary:

```
## Refactor: <short description>

### Files touched
- <list>

### Behavior preserved
- <evidence: tests passed / build green / manual check>

### Follow-up (optional)
- <anything deliberately left for a next pass>
```
