# ADR-0006 — PDF export via browser `window.print()`

**Status**: Accepted
**Date**: 2026-05-09

## Context

Three pages (Analyze, Cost, Executive) needed a "Save as PDF" button so
users can share a static snapshot of an AI analysis or a CFO/CTO
summary without taking screenshots. Common implementations:

1. **Server-side render** — Puppeteer / Playwright in a Lambda renders
   the page to PDF. Pixel-perfect, server-rendered, but adds a Lambda
   stack (~$5/mo idle), a Node 20 + Chromium image, and a contract
   between the SPA route and the renderer.
2. **Client library** — `html2pdf.js`, `jsPDF + html2canvas`, or
   `react-to-pdf`. Bundles 200–500 KB of code, has known issues with
   SVG charts (Recharts) and right-to-left text, and can drift from
   what's rendered on screen.
3. **Browser-native print** — toggle a body class, call
   `window.print()`, the user picks "Save as PDF" in the system
   dialog. Zero deps, zero infra, the printout is exactly what's on
   screen.

## Decision

Use the **browser-native print** path. `src/index.css` defines a
generic `@media print` block keyed off `body.app-print`:

- All `body.app-print *` are hidden via `visibility: hidden`.
- The printable subtree is opted in with `.print-export` (and any
  chrome inside it with `.print-hide`). `.print-export` is
  position-absolute pulled to the page origin so the visibility-hidden
  ancestors don't leak whitespace.
- `<details>` blocks inside `.print-export` auto-expand so SQL +
  query-result tables print without the user clicking through.
- `print-color-adjust: exact` preserves the Claude orange palette on
  paper.

Page handler is six lines:

```ts
function exportPdf() {
  const restore = () => document.body.classList.remove('app-print')
  document.body.classList.add('app-print')
  window.addEventListener('afterprint', restore, { once: true })
  setTimeout(() => window.print(), 50)
}
```

## Trade-offs

- **The print dialog is the user's call.** The browser opens its own
  modal; we can't preset filename, paper size, or margins. Acceptable
  because the audience (CFO/CTO) typically wants to review before
  saving anyway.
- **Recharts SVG renders in print, but legends sometimes overflow.**
  Mitigated by setting `.print-export` to `width: 100% / max-width:
  none` so charts re-flow to paper width.
- **Mobile Safari "Print → Save as PDF" works but is hidden two menus
  deep.** Most enterprise users are on desktop; we don't claim this
  flow is mobile-first.
- **No automated PDF rendering.** Can't generate a PDF from a cron or
  email pipeline. If we ever need that, we'd add Puppeteer in a
  Lambda — the SPA work doesn't lock us in.

## Consequences

- One body class (`app-print`) gates all three pages — adding a fourth
  printable view is just `tagging .print-export` on its container and
  copying the six-line handler.
- No new npm dependencies (~270 KB gzipped bundle stayed flat).
- No new infra (no Puppeteer, no Lambda, no IAM changes).
- The `.dockerignore` had to be updated (separately, in v0.4.0) to
  stop excluding `CHANGELOG.md` because the Changelog page imports it
  with Vite's `?raw` query — see ADR-0008 candidate (not yet written).
