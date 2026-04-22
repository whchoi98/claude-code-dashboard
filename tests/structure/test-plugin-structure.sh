#!/usr/bin/env bash
# Validate project structure — required docs, module CLAUDE.md files, CDK layout.

assert_file_exists "CLAUDE.md"
assert_file_exists "README.md"
assert_file_exists "CHANGELOG.md"
assert_file_exists "package.json"
assert_file_exists ".gitignore"
assert_file_exists ".env.example"

# Module CLAUDE.md files
assert_file_exists "src/CLAUDE.md"
assert_file_exists "server/CLAUDE.md"
assert_file_exists "collector/CLAUDE.md"
assert_file_exists "infra/CLAUDE.md"

# Docs
assert_file_exists "docs/architecture.md"
assert_file_exists "docs/onboarding.md"
assert_file_exists "docs/api-reference.md"
assert_file_exists "docs/decisions/.template.md"
assert_file_exists "docs/runbooks/.template.md"

# CDK entrypoints
assert_file_exists "infra/bin/app.ts"
assert_file_exists "infra/lib/network-stack.ts"
assert_file_exists "infra/lib/storage-stack.ts"
assert_file_exists "infra/lib/compute-stack.ts"
assert_file_exists "infra/lib/collector-stack.ts"

# Server + collector entrypoints
assert_file_exists "server/index.js"
assert_file_exists "server/aws.js"
assert_file_exists "collector/handler.js"

# CLAUDE.md freshness checks
assert_contains "root CLAUDE.md lists tech stack" "Tech Stack" "CLAUDE.md"
assert_contains "architecture.md has diagram"     "CloudFront" "docs/architecture.md"
assert_contains "CHANGELOG has 0.1.0"             "0.1.0"     "CHANGELOG.md"
