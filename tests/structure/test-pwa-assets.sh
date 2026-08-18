#!/usr/bin/env bash
# iOS/iPadOS PWA assets (2026-08-18 design) — manifest-only PWA behind the
# Cognito edge gate. Icons must be full-bleed PNGs (iOS blackens transparent
# corners) and the manifest link must carry use-credentials or check-auth
# 302s the manifest fetch to Cognito.

# Icons
assert_file_exists "public/apple-touch-icon.png"
assert_file_exists "public/icon-192.png"
assert_file_exists "public/icon-512.png"
assert_file_exists "public/icon-512-maskable.png"

# Manifest
assert_file_exists "public/manifest.webmanifest"
assert_contains "manifest" '"display": "standalone"' "public/manifest.webmanifest"
assert_contains "manifest" '"start_url": "/"' "public/manifest.webmanifest"
assert_contains "manifest" 'icon-512-maskable.png' "public/manifest.webmanifest"
assert_contains "manifest" '"purpose": "maskable"' "public/manifest.webmanifest"
assert "manifest is valid JSON" node -e "JSON.parse(require('fs').readFileSync('public/manifest.webmanifest','utf8'))"

# index.html wiring
assert_contains "index.html" 'viewport-fit=cover' "index.html"
assert_contains "index.html" 'rel="manifest"' "index.html"
assert_contains "index.html" 'crossorigin="use-credentials"' "index.html"
assert_contains "index.html" 'rel="apple-touch-icon"' "index.html"
assert_contains "index.html" 'apple-mobile-web-app-capable' "index.html"
assert_contains "index.html" 'apple-mobile-web-app-title' "index.html"
assert_contains "index.html" 'name="theme-color"' "index.html"

# Safe-area insets (standalone mode: content extends under the notch/home bar)
assert_contains "Layout safe-area" 'safe-area-inset' "src/components/Layout.tsx"

# Icon generator committed for regeneration (sharp stays OUT of package.json)
assert_file_exists "scripts/generate-pwa-icons.mjs"
assert "sharp not a package.json dependency" bash -c "! grep -q '\"sharp\"' package.json"

# check-auth must allowlist the icon/manifest paths — iOS fetches
# apple-touch-icon outside the page's cookie context; a 302-to-Cognito
# degrades the home-screen icon to a page screenshot.
assert_contains "check-auth static allowlist" 'apple-touch-icon' "infra/edge/check-auth.js"
assert_contains "check-auth static allowlist" 'webmanifest' "infra/edge/check-auth.js"
