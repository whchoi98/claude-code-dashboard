# iOS/iPadOS PWA (manifest-only) — Design

- **Date**: 2026-08-18
- **Status**: Approved (owner, 2026-08-18)
- **Driver**: "아이폰, 아이패드를 위한 PWA를 구현해주세요" — home-screen installable, full-screen dashboard.

## Owner decisions

1. **Scope: install + standalone only — NO service worker.** This is a live-data
   dashboard behind Cognito Lambda@Edge auth; a SW-cached shell would bypass the
   edge `check-auth` on navigation, breaking session refresh (expired cookies →
   every API call silently 302s). iOS needs no SW for A2HS/standalone. Offline =
   normal network error.
2. **Icons generated from the existing `claude.svg`** (orange asterisk mark) on
   the paper background `#FAF9F5` — iOS fills transparency with black, so
   full-bleed background PNGs are required.

## Components

1. **Static icons** (committed to `public/`): `apple-touch-icon.png` (180×180),
   `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` (mark inside the
   central ~70% safe zone). Generator `scripts/generate-pwa-icons.mjs` is
   committed for regeneration; `sharp` is installed ad hoc (`npm i --no-save
   sharp`) and deliberately NOT added to package.json (native module — keeps
   the ARM64 Docker build lean; PNGs are static assets).
2. **`public/manifest.webmanifest`**: name "Claude Code · Enterprise
   Analytics", short_name "CC Analytics", `display: standalone`,
   `start_url: "/"`, `scope: "/"`, `background_color`/`theme_color` `#FAF9F5`,
   icons 192/512/512-maskable.
3. **`index.html`**: viewport gains `viewport-fit=cover`; add
   `<link rel="manifest" crossorigin="use-credentials">` (**the manifest
   request passes the check-auth edge gate — without credentials it 302s to
   Cognito and iOS gets no manifest**); `apple-touch-icon` link;
   `apple-mobile-web-app-capable` + `-title` + status-bar-style `default`;
   `theme-color` meta. The Apple meta tags are the reliable iOS baseline even
   if the manifest fetch fails — deliberate double coverage.
4. **Safe-area insets** (`Layout.tsx`): standalone mode removes browser chrome,
   so content extends under the status bar / home indicator. Mobile sticky top
   bar gets `env(safe-area-inset-top)` padding; sidebar drawer and main pane
   get bottom/left/right insets. All insets are 0 in regular browsers —
   desktop rendering byte-identical.

## Auth interaction (no changes, documented behavior)

Standalone first launch runs the normal Cognito hosted-UI 302 chain inside the
standalone WebKit container. The standalone cookie store is SEPARATE from
Safari's — first launch of the installed app requires one fresh login (then the
30-day refresh cookie applies). No server/edge/infra changes.

## Out of scope (YAGNI)

Service worker & offline page (owner-decided), `apple-touch-startup-image`
splash screens (dozens of per-device sizes), Android install prompt (requires a
SW; Android users keep using the browser).

## Testing

- `tests/structure` harness test: manifest + 4 icons exist, manifest JSON has
  the required fields, `index.html` carries viewport-fit / manifest link with
  `use-credentials` / apple-touch-icon / apple meta tags (written FIRST — TDD).
- `npm run build` + `vite preview` smoke: manifest/icons served, tags present
  in built HTML.
- Real-device check after deploy (owner): Safari 공유 → 홈 화면에 추가 →
  standalone launch + login + safe-area visual.

## Rollout

`ccd-compute` deploy + CloudFront `/*` invalidation (new static assets).
Release: minor (v2.2.0) when the owner asks.
