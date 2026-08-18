// Regenerate the PWA/home-screen icons from public/claude.svg.
//
//   npm i --no-save sharp && node scripts/generate-pwa-icons.mjs
//
// sharp is deliberately NOT a package.json dependency — it is a native module
// that would bloat the ARM64 Docker build for a one-off asset step. The PNGs
// are committed as static assets; rerun only when claude.svg changes.
//
// Design notes (2026-08-18 spec): iOS fills transparent pixels with BLACK on
// the home screen, so every icon is full-bleed. claude.svg is itself an
// orange rounded tile (#D97757) with a cream asterisk — compositing it over
// a same-color #D97757 square makes the rounded corners blend invisibly,
// giving a full-bleed tile without redrawing the mark. The maskable variant
// shrinks the artwork to ~72% so the asterisk stays inside the central safe
// zone under any platform mask shape.
import sharp from 'sharp'

const SVG = new URL('../public/claude.svg', import.meta.url).pathname
const OUT = (name) => new URL(`../public/${name}`, import.meta.url).pathname
const BG = '#D97757'

async function icon(size, out, scale = 1) {
  const inner = Math.round(size * scale)
  const mark = await sharp(SVG, { density: 300 }).resize(inner, inner).png().toBuffer()
  await sharp({ create: { width: size, height: size, channels: 3, background: BG } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toFile(OUT(out))
  console.log(`✓ ${out} (${size}×${size}${scale !== 1 ? `, artwork ${Math.round(scale * 100)}%` : ''})`)
}

await icon(180, 'apple-touch-icon.png')
await icon(192, 'icon-192.png')
await icon(512, 'icon-512.png')
await icon(512, 'icon-512-maskable.png', 0.72)
