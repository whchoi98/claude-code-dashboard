---
description: Review the uncommitted diff with confidence-based filtering
argument-hint: "[optional: specific file path]"
---

# /review

Run the `code-review` skill against the current working-tree diff (or a specified path).

## Behavior

1. Default target: `git diff` (unstaged + staged). If the tree is clean, review `git diff HEAD~1..HEAD`.
2. If `$1` is a file path, review only that file.
3. Use the `code-review` skill's format — Critical/Major reported inline with fixes, Minor/Nit summarized.
4. Cross-check project conventions from `CLAUDE.md` (email masking, AWS SDK v3, no hardcoded secrets, existing VPC context).

## Recovery

- If the build/test command fails during review, report the failure without pretending everything is fine.
- If the diff is huge (>500 lines), warn the user and ask whether to batch by directory.
