// Regenerate the brochure's link-preview card (site/img/og.png, 1200×630).
//
//   node scripts/generate-og-image.mjs
//
// Link previews (Slack, KakaoTalk, LinkedIn, X, Facebook) show og:image at
// about 1.91:1 and crop anything else, so a full-page screenshot loses its
// top and bottom. This card is drawn at exactly 1200×630 with the copy kept
// 64px clear of every edge, which also survives a 2:1 crop.
//
// Uses the Playwright Chromium the E2E suite already installs. The headline
// fonts load from the same CDNs as the brochure and fall back to the system
// Korean font when offline. The screenshot is inlined as a data URI because
// a setContent page cannot read file:// images. The card's copy carries no
// version or counts, so it need not be regenerated on each release (the
// embedded mock screenshot's own dates are fine).
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const SHOT = new URL('../site/img/overview.png', import.meta.url).pathname
const OUT = new URL('../site/img/og.png', import.meta.url).pathname
const shot = `data:image/png;base64,${readFileSync(SHOT).toString('base64')}`

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=JetBrains+Mono:wght@500&display=block" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
  *{box-sizing:border-box; margin:0}
  html,body{width:1200px; height:630px; overflow:hidden}
  body{position:relative; background:#FAF9F5; color:#26231D; word-break:keep-all;
    font-family:Pretendard,"Pretendard Variable","Noto Sans CJK KR",sans-serif; -webkit-font-smoothing:antialiased}
  .glow{position:absolute; right:-200px; top:-260px; width:820px; height:820px; border-radius:50%;
    background:radial-gradient(closest-side, rgba(217,119,87,.22), rgba(217,119,87,0))}
  .grid{position:absolute; inset:0; opacity:.5;
    background-image:linear-gradient(#EDEBE4 1px, transparent 1px), linear-gradient(90deg, #EDEBE4 1px, transparent 1px);
    background-size:40px 40px; -webkit-mask-image:linear-gradient(90deg, transparent 30%, #000 75%)}
  .copy{position:absolute; left:72px; top:64px; bottom:64px; width:560px; display:flex; flex-direction:column}
  .brand{display:flex; align-items:center; gap:14px}
  .brand svg{width:44px; height:44px}
  .brand b{font-family:Fraunces,Georgia,serif; font-weight:600; font-size:27px; letter-spacing:-.02em}
  .eyebrow{margin-top:46px; display:flex; align-items:center; gap:10px; font-family:"JetBrains Mono",monospace;
    font-size:14px; letter-spacing:.12em; color:#94482E}
  .eyebrow i{width:8px; height:8px; border-radius:99px; background:#D97757}
  h1{margin-top:18px; font-weight:800; font-size:60px; line-height:1.14; letter-spacing:-.035em}
  h1 em{font-style:normal; color:#94482E; background:linear-gradient(transparent 64%, #F6E3D6 64%)}
  .sub{margin-top:22px; font-size:22px; line-height:1.5; color:#4E4941}
  .url{margin-top:auto; font-family:"JetBrains Mono",monospace; font-size:16px; color:#6D675A}
  .shot{position:absolute; left:668px; top:84px; width:620px; height:600px; overflow:hidden;
    background:#fff; border:1px solid #DDD9CE; border-radius:16px;
    box-shadow:0 2px 4px rgba(25,23,19,.05), 0 30px 70px rgba(25,23,19,.18)}
  .bar{height:36px; display:flex; align-items:center; gap:7px; padding:0 16px; background:#F7F6F2; border-bottom:1px solid #EDEBE4}
  .bar i{width:10px; height:10px; border-radius:99px; background:#DDD9CE}
  .shot img{display:block; width:880px}
</style></head><body>
  <div class="glow"></div><div class="grid"></div>
  <div class="shot"><div class="bar"><i></i><i></i><i></i></div><img src="${shot}" alt=""></div>
  <div class="copy">
    <div class="brand">
      <svg viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#D97757"/><path d="M32 8 L36 28 L56 32 L36 36 L32 56 L28 36 L8 32 L28 28 Z" fill="#FAF9F5"/></svg>
      <b>Claude Code Dashboard</b>
    </div>
    <div class="eyebrow"><i></i>ANTHROPIC ANALYTICS · COMPLIANCE API</div>
    <h1>조직의 Claude Code를<br><em>하나의 대시보드</em>에서.</h1>
    <p class="sub">도입 현황 · 사용자별 생산성 · 비용 · 감사 로그를<br>AI 자연어 분석과 함께 봅니다.</p>
    <div class="url">whchoi98.github.io/claude-code-dashboard</div>
  </div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
const cdn = await page.evaluate(() => document.fonts.check('800 60px Pretendard') && document.fonts.check('600 27px Fraunces'))
await page.screenshot({ path: OUT, type: 'png' })
await browser.close()
console.log(`✓ site/img/og.png (1200×630${cdn ? '' : ', CDN fonts unavailable — system fallback used'})`)
