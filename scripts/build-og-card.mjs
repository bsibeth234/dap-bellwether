#!/usr/bin/env node
/**
 * Render the 1200x630 social card to public/og.jpg.
 *
 * Run when the card design, the photograph or the brand assets change, then
 * run npm run build:assets so the Worker serves the new bytes:
 *
 *   node scripts/build-og-card.mjs
 *
 * Needs Playwright with Chromium (npx playwright install chromium). The output
 * is committed, so nobody needs this to deploy.
 *
 * DAP 2026 brand, one-screen language: the Bellwether photograph under a flat
 * carbon scrim, the name in JetBrains Mono, the product line in Raleway Light,
 * the positioning in Archivo. The photograph's own vermilion line is the card's
 * one red line, so nothing else on it is vermilion.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pub = join(root, 'public');
const outFile = join(pub, 'og.jpg');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const b64 = (file) => readFileSync(join(pub, file)).toString('base64');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Raleway";src:url(data:font/woff2;base64,${b64('fonts/Raleway-300.woff2')}) format("woff2");font-weight:300}
@font-face{font-family:"Archivo";src:url(data:font/woff2;base64,${b64('fonts/Archivo-400.woff2')}) format("woff2");font-weight:400}
@font-face{font-family:"JetBrains Mono";src:url(data:font/woff2;base64,${b64('fonts/JBMono-400.woff2')}) format("woff2");font-weight:400}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:#111517}
.card{position:relative;width:1200px;height:630px;color:#F8F9FA}
.card img.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:62% 50%}
.scrim{position:absolute;inset:0;background:rgba(17,21,23,.40)}
.inner{position:absolute;inset:0;padding:56px 64px;display:flex;flex-direction:column}
.logo{width:220px;height:auto}
.copy{margin-top:auto;max-width:640px}
.name{font-family:"JetBrains Mono";font-size:16px;letter-spacing:.12em;text-transform:uppercase;color:rgba(248,249,250,.80)}
h1{margin-top:18px;font-family:"Raleway";font-weight:300;font-size:58px;line-height:1.06;letter-spacing:-.01em}
.line{margin-top:20px;font-family:"Archivo";font-size:26px;line-height:1.35;color:rgba(248,249,250,.88)}
.url{margin-top:28px;font-family:"JetBrains Mono";font-size:16px;letter-spacing:.06em;color:rgba(248,249,250,.72)}
</style></head><body><div class="card">
<img class="photo" src="data:image/webp;base64,${b64('media/bellwether-1440.webp')}" alt="">
<div class="scrim"></div>
<div class="inner">
<img class="logo" src="data:image/svg+xml;base64,${b64('brand/dap-logo-horizontal-carbon.svg')}" alt="">
<div class="copy">
<p class="name">DAP Bellwether</p>
<h1>Regulator updates from four jurisdictions, in one feed.</h1>
<p class="line">Free for people. Agents pay per call.</p>
<p class="url">bellwether.dap.solutions</p>
</div></div></div></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  // JPEG: the card is a photograph, and a PNG of it is six times the size.
  await page.screenshot({ path: outFile, type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 1200, height: 630 } });
} finally {
  await browser.close();
}
console.log(`public/og.jpg written, 1200x630, ${readFileSync(outFile).length} bytes`);
