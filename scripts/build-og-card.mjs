#!/usr/bin/env node
/**
 * Render the 1200x630 social card to public/og.png.
 *
 * Run when the card design or the brand assets change:
 *   npm run build:og
 *
 * Requires macOS: there is no ImageMagick, librsvg or cairosvg on this
 * machine, so rendering goes through qlmanage, which is WebKit, and sips.
 * The output is committed, so nobody needs this to deploy.
 *
 * Two quirks of that toolchain drive the shape of this file:
 *
 *   1. qlmanage renders into a square canvas at the requested size and puts
 *      the artwork at the top. So the card is drawn inside a 1200x1200 canvas,
 *      vertically centred, and sips then centre crops back to 1200x630. The
 *      crop lands exactly on the card because both halves of the padding are
 *      equal by construction.
 *   2. The brand faces are not installed system wide, so the fonts are
 *      embedded in the SVG as base64. WebKit honours that, checked before
 *      relying on it.
 *
 * Brand: paper ground, graphite ink, Archivo for the wordmark, Hanken Grotesk
 * for the description, JetBrains Mono for the URL. The icon mark appears once
 * and its own vermilion bar is the single vermilion on the surface, so nothing
 * else here is allowed to be vermilion.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fontsDir = join(root, 'public', 'fonts');
const outFile = join(root, 'public', 'og.png');

const WIDTH = 1200;
const HEIGHT = 630;
const CANVAS = 1200; // square, because qlmanage will pad to it anyway
const PAD = (CANVAS - HEIGHT) / 2; // 285, the vertical offset of the card

const PAPER = '#F1F1ED';
const GRAPHITE = '#23262A';
const STEEL_INK = '#565B61';
const RULE = '#D6D6D0';

const MARGIN = 90;

function font(file) {
  return readFileSync(join(fontsDir, file)).toString('base64');
}

const archivo = font('Archivo-600.ttf');
const hanken = font('Hanken-400.ttf');
const mono = font('JBMono-400.ttf');

/**
 * The icon mark, from logo-svg/favicon.svg, scaled and positioned. Its four
 * bars are reproduced rather than referenced so this file renders standalone.
 * The vermilion bar here is the one vermilion element on the whole card.
 */
function mark(x, y, size) {
  const s = size / 120;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect x="0" y="0" width="120" height="120" rx="24" fill="#15171A"/>
    <g transform="translate(12,12) scale(0.8)">
      <rect x="18" y="15" width="84" height="12" fill="#F1F1ED"/>
      <rect x="18" y="41" width="58" height="12" fill="#D8412F"/>
      <rect x="18" y="67" width="84" height="12" fill="#F1F1ED"/>
      <rect x="18" y="93" width="44" height="12" fill="#F1F1ED"/>
    </g>
  </g>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<style>
@font-face{font-family:"A";src:url("data:font/ttf;base64,${archivo}") format("truetype");font-weight:600}
@font-face{font-family:"H";src:url("data:font/ttf;base64,${hanken}") format("truetype");font-weight:400}
@font-face{font-family:"M";src:url("data:font/ttf;base64,${mono}") format("truetype");font-weight:400}
.wordmark{font-family:"A";font-weight:600;font-size:84px;fill:${GRAPHITE};letter-spacing:-1.2px}
.desc{font-family:"H";font-weight:400;font-size:31px;fill:${GRAPHITE}}
.url{font-family:"M";font-weight:400;font-size:26px;fill:${STEEL_INK}}
</style>

<rect width="${CANVAS}" height="${CANVAS}" fill="${PAPER}"/>

<g transform="translate(0 ${PAD})">
  ${mark(MARGIN, 88, 132)}
  <text class="wordmark" x="${MARGIN}" y="342">DAP Bellwether</text>
  <text class="desc" x="${MARGIN}" y="398">Free for people. Agents pay per call.</text>
  <line x1="${MARGIN}" y1="482" x2="${WIDTH - MARGIN}" y2="482" stroke="${RULE}" stroke-width="1"/>
  <text class="url" x="${MARGIN}" y="536">bellwether.dap.solutions</text>
</g>
</svg>`;

const work = mkdtempSync(join(tmpdir(), 'bellwether-og-'));
try {
  const svgPath = join(work, 'og.svg');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(svgPath, svg);

  execFileSync('qlmanage', ['-t', '-s', String(CANVAS), '-o', work, svgPath], { stdio: 'ignore' });

  const rendered = join(work, 'og.svg.png');
  // Centre crop the square canvas back to the card. Equal padding above and
  // below means this lands exactly on the drawn area.
  execFileSync('sips', ['-c', String(HEIGHT), String(WIDTH), rendered], { stdio: 'ignore' });

  copyFileSync(rendered, outFile);

  const bytes = readFileSync(outFile);
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  if (w !== WIDTH || h !== HEIGHT) {
    throw new Error(`rendered ${w}x${h}, expected ${WIDTH}x${HEIGHT}`);
  }
  console.log(`public/og.png written, ${w}x${h}, ${bytes.length} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
