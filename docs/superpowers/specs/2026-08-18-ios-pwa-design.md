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
2. **Icons generated from the existing `claude.svg`** — iOS fills transparency
   with black, so full-bleed background PNGs are required. Implementation
   note: claude.svg is itself an orange rounded tile (`#D97757`) with a cream
   asterisk, so the icons composite it over a same-color `#D97757` square
   (corners blend invisibly) — the tile look, full-bleed. The manifest's
   `background_color`/`theme_color` stay paper `#FAF9F5` (app UI colors).

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

## Review amendments (adversarial review, 2026-08-18)

The find→verify review confirmed four defects, all fixed pre-ship:

1. **Safe-area split settled**: `main` keeps ONLY the bottom inset; the SIDE
   insets live on the sticky top bar (its background must paint full-bleed
   under the notch — side padding on main stopped it `env()` short of the
   display edge) and on a new `<Outlet>` wrapper (protects scrolled page
   content). The first cut double-counted the right inset (main + top bar)
   and missed the left entirely — and since `viewport-fit=cover` applies to
   REGULAR mobile Safari too (not just standalone), the missing left inset
   was a landscape regression for existing browser users.
2. **Fixed overlays covered**: FloatingChat pill/panel move to
   `calc(1.5rem+env(...))` offsets (portrait home-indicator inset ~34px >
   the old 24px offset); UserDetailPanel pads its scroll box top/bottom/right.
3. **check-auth allowlists the icon/manifest paths** (exact-match regex,
   non-sensitive brand assets only): iOS fetches `apple-touch-icon` outside
   the page's cookie context during add-to-home-screen, and a 302-to-Cognito
   would degrade the icon to a page screenshot. Requires `npm run build:edge`
   before the deploy (Lambda@Edge new version).

## Rollout

`ccd-compute` deploy + CloudFront `/*` invalidation (new static assets).
Release: minor (v2.2.0) when the owner asks.
