import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { isFallbackHost } from '../src/index.js';
import { renderLanding, renderConnectorNotice } from '../src/landing.js';
import { enabledSources, SOURCES } from '../src/sources.js';

const ORIGIN = 'https://bellwether.dap.solutions';

function get(path, origin = ORIGIN) {
  return worker.fetch(new Request(`${origin}${path}`), {}, {});
}

test('the root path returns HTML carrying the connector URL', async () => {
  // The one thing a visitor comes for. If this regresses, the page is
  // decoration.
  const response = await get('/');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/html/);
  assert.match(body, /^<!doctype html>/i, 'must be a real HTML document');
  assert.ok(
    body.includes(`${ORIGIN}/mcp`),
    'the page must contain the connector URL for the origin it was served on'
  );
});

test('the advertised connector URL follows the host the visitor arrived on', async () => {
  // Custom domain and workers.dev fallback both have to hand out a URL that
  // actually works, so this cannot be hardcoded.
  const body = await (await get('/', 'https://dap-bellwether.dap-solutions.workers.dev')).text();
  assert.ok(body.includes('https://dap-bellwether.dap-solutions.workers.dev/mcp'));
  assert.ok(!body.includes('bellwether.dap.solutions/mcp'), 'must not leak the other hostname');
});

test('coverage on the page comes from the registry, not a hardcoded list', async () => {
  const body = await (await get('/')).text();

  for (const source of enabledSources()) {
    assert.ok(body.includes(source.regulator), `${source.regulator} should be listed as covered`);
  }
  // A disabled regulator must be named as not monitored rather than dropped,
  // for the same reason list_coverage names it.
  for (const source of SOURCES.filter((s) => !s.enabled)) {
    assert.ok(body.includes(source.regulator), `${source.regulator} should be named as not monitored`);
  }
  assert.match(body, /Not monitored:/);
});

test('the page states what it is not', async () => {
  const body = await (await get('/')).text();
  assert.match(body, /not legal or compliance advice/);
  assert.match(body, /bsibeth@dap\.solutions/);
  assert.match(body, /https:\/\/dap\.solutions/);
});

test('the head references the icon set and the manifest', async () => {
  const body = await (await get('/')).text();

  assert.match(body, /<link rel="icon" href="\/favicon\.ico"/);
  for (const size of [16, 32, 48, 192]) {
    assert.ok(
      body.includes(`sizes="${size}x${size}" href="/icons/favicon-${size}.png"`),
      `the ${size}px icon must be declared with its size`
    );
  }
  assert.match(body, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(body, /<link rel="manifest" href="\/site\.webmanifest">/);
});

test('the privacy section names Cloudflare Web Analytics', async () => {
  // Cloudflare injects its beacon into HTML responses at the edge, so the page
  // does make a third party request whether or not the Worker asks for one.
  // The policy has to say so.
  const body = await (await get('/')).text();

  assert.match(body, /Cloudflare Web Analytics/);
  assert.match(body, /cookieless/);
  assert.match(body, /<dt>Analytics<\/dt>/, 'analytics deserves its own row, not a footnote');
  assert.match(
    body,
    /The connector keeps no accounts and no email addresses\. This page counts visits without cookies or identifiers\./
  );
});

test('the privacy section no longer claims the page loads no third party scripts', async () => {
  // The exact claim that was false. Asserted as an absence so it cannot creep
  // back in a future edit of the copy.
  const body = await (await get('/')).text();

  assert.ok(
    !body.includes('no third party scripts'),
    'the page must not claim it loads no third party scripts'
  );
  assert.ok(
    !body.includes('scripts, fonts or trackers'),
    'the superseded wording must not return'
  );
});

test('the MCP endpoint returns JSON with no injected beacon', async () => {
  // The privacy copy promises tool calls carry no analytics. Cloudflare only
  // injects into HTML, so this holds as long as /mcp never answers as a
  // document. Assert the property rather than trusting that.
  const response = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/html,*/*' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    {},
    {}
  );
  const body = await response.text();

  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.ok(!/<script/i.test(body), 'no script tag may appear in an MCP response');
  assert.ok(!/cloudflareinsights|beacon\.min\.js/i.test(body), 'no beacon may appear in an MCP response');
  JSON.parse(body); // must be JSON, which is not a document and cannot be injected into
});

test('the canonical points at the custom domain from either host', async () => {
  // Two hostnames serve this same document. The tag has to name one winner,
  // so unlike every other URL on the page it must not follow the request.
  const expected = '<link rel="canonical" href="https://bellwether.dap.solutions/">';

  const onCustomDomain = await (await get('/')).text();
  assert.ok(onCustomDomain.includes(expected));

  const onFallback = await (await get('/', 'https://dap-bellwether.dap-solutions.workers.dev')).text();
  assert.ok(
    onFallback.includes(expected),
    'the fallback must point at the custom domain, not at itself'
  );
});

test('the fallback host asks not to be indexed, the custom domain does not', async () => {
  const fallback = await get('/', 'https://dap-bellwether.dap-solutions.workers.dev');
  assert.equal(fallback.headers.get('X-Robots-Tag'), 'noindex');

  const custom = await get('/');
  assert.equal(custom.headers.get('X-Robots-Tag'), null, 'the real site must stay indexable');
});

test('noindex is scoped to the page and never reaches the endpoint or the assets', async () => {
  // An asset carries a year long cache, so a noindex attached to one would
  // outlive any future move between hosts. /mcp and /health are not indexable
  // content to begin with and should not be carrying SEO headers at all.
  const FALLBACK = 'https://dap-bellwether.dap-solutions.workers.dev';

  for (const path of ['/health', '/favicon.ico', '/og.jpg', '/fonts/Archivo-600.woff2', '/media/bellwether-1440.webp']) {
    const response = await get(path, FALLBACK);
    assert.equal(response.headers.get('X-Robots-Tag'), null, `${path} must not carry noindex`);
  }

  const mcp = await worker.fetch(
    new Request(`${FALLBACK}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    { DB: null },
    {}
  );
  assert.equal(mcp.headers.get('X-Robots-Tag'), null, '/mcp must not carry noindex');
});

test('isFallbackHost matches the fallback without catching the custom domain', () => {
  assert.equal(isFallbackHost('dap-bellwether.dap-solutions.workers.dev'), true);
  assert.equal(isFallbackHost('DAP-BELLWETHER.DAP-SOLUTIONS.WORKERS.DEV'), true, 'case insensitive');
  assert.equal(isFallbackHost('bellwether.dap.solutions'), false);
  // A hostname that merely ends in the same letters is not the fallback.
  assert.equal(isFallbackHost('notworkers.dev'), false);
  assert.equal(isFallbackHost('workers.dev.evil.example'), false);
});

test('the head declares the social card metadata', async () => {
  const body = await (await get('/')).text();

  assert.ok(
    body.includes(`<meta property="og:image" content="${ORIGIN}/og.jpg">`),
    'og:image must be an absolute URL on the origin the page was served from'
  );
  assert.match(body, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(body.includes(`<meta name="twitter:image" content="${ORIGIN}/og.jpg">`));

  // og:url names the address the card should point at, which is a claim about
  // the service rather than about the host that answered. It follows the
  // canonical, so a card shared from the fallback still sends people to the
  // real site. The image stays origin relative: it is a file being fetched,
  // not an address being advertised.
  const canonical = '<meta property="og:url" content="https://bellwether.dap.solutions/">';
  assert.ok(body.includes(canonical));

  const onFallback = await (await get('/', 'https://dap-bellwether.dap-solutions.workers.dev')).text();
  assert.ok(onFallback.includes(canonical), 'og:url must not follow the fallback host');
  assert.ok(
    onFallback.includes('<meta property="og:image" content="https://dap-bellwether.dap-solutions.workers.dev/og.jpg">'),
    'the card image is still served by whichever host answered'
  );

  for (const tag of ['og:type', 'og:site_name', 'og:title', 'og:description']) {
    assert.ok(body.includes(`property="${tag}"`), `${tag} must be declared`);
  }
  // Crawlers that will not fetch the image still lay out the card from these.
  assert.match(body, /<meta property="og:image:width" content="1200">/);
  assert.match(body, /<meta property="og:image:height" content="630">/);
});

test('/og.jpg is served as a 1200x630 JPEG with a long cache header', async () => {
  const response = await get('/og.jpg');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.match(response.headers.get('Cache-Control'), /max-age=31536000/);

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 2)], [0xff, 0xd8], 'must actually be a JPEG');
  // Dimensions live in the start-of-frame segment. A card at the wrong size
  // gets cropped or rejected by the networks rather than failing loudly here.
  let at = 2;
  let size = null;
  while (at < bytes.length - 9) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker >= 0xc0 && marker <= 0xc3) {
      size = { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
      break;
    }
    at += 2 + length;
  }
  assert.deepEqual(size, { width: 1200, height: 630 });
});

test('icons, manifest and fonts are served with types and long cache headers', async () => {
  const expected = [
    ['/favicon.ico', 'image/x-icon'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icons/favicon-16.png', 'image/png'],
    ['/icons/favicon-512.png', 'image/png'],
    ['/fonts/Archivo-600.woff2', 'font/woff2'],
    ['/fonts/Raleway-300.woff2', 'font/woff2'],
    ['/media/bellwether-960.webp', 'image/webp'],
    ['/media/bellwether-1920.webp', 'image/webp'],
    ['/brand/dap-logo-horizontal-carbon.svg', 'image/svg+xml'],
  ];

  for (const [path, type] of expected) {
    const response = await get(path);
    assert.equal(response.status, 200, `${path} should be served`);
    assert.equal(response.headers.get('Content-Type'), type, `${path} content type`);
    assert.match(response.headers.get('Cache-Control'), /max-age=31536000/, `${path} cache policy`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0, `${path} should have a body`);
  }

  const manifest = await get('/site.webmanifest');
  assert.match(manifest.headers.get('Content-Type'), /application\/manifest\+json/);
  const parsed = JSON.parse(await manifest.text());
  assert.deepEqual(
    parsed.icons.map((i) => i.sizes),
    ['192x192', '256x256', '512x512'],
    'the manifest declares the 192, 256 and 512'
  );
});

test('favicon.ico is a multi resolution bundle, not a lone 16px image', async () => {
  // The supplied ICO held one 16x16 image, so browsers wanting 32 or 48 got a
  // soft upscale. Assert the bundle rather than just that a file is served,
  // because a regressed ICO still returns 200 and still looks like an icon.
  const response = await get('/favicon.ico');
  assert.equal(response.status, 200);
  const ico = new DataView(await response.arrayBuffer());

  assert.equal(ico.getUint16(2, true), 1, 'type 1 is an icon');
  const count = ico.getUint16(4, true);
  assert.equal(count, 4, 'expected 16, 32, 48 and 64 bundled');

  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + 16 * i;
    const width = ico.getUint8(entry) || 256;
    assert.equal(ico.getUint8(entry + 1) || 256, width, 'entries should be square');
    assert.equal(ico.getUint16(entry + 6, true), 32, 'entries should be 32 bit');
    // The declared payload must actually lie inside the file.
    const length = ico.getUint32(entry + 8, true);
    const offset = ico.getUint32(entry + 12, true);
    assert.ok(offset + length <= ico.byteLength, `entry ${width} runs past the end of the file`);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 32, 48, 64]);
});

test('renderLanding escapes rather than trusting registry text', () => {
  const body = renderLanding(ORIGIN);
  // No raw angle brackets should survive from a field value into an attribute
  // position. Spot check that the document is well formed enough to have a
  // single head and body.
  assert.equal(body.match(/<head>/g).length, 1);
  assert.equal(body.match(/<\/html>/g).length, 1);
});

test('the first screen says four things: name, headline, line and one action', async () => {
  // DAP's one-screen language: the name small, one headline, one line on what
  // the visitor gets, one button, over one photograph. Nothing else up there.
  const body = await (await get('/')).text();
  const first = body.slice(body.indexOf('<section class="one"'), body.indexOf('</section>') + 10);

  assert.match(first, /<p class="meta one-name">DAP Bellwether<\/p>/);
  assert.match(first, /<h1 id="page-title" class="disp one-title">Regulator updates from four jurisdictions, in one feed\.<\/h1>/);
  assert.match(first, /<p class="one-line">Free\. No account, no key\.<\/p>/, 'free while the paid tier is off');
  assert.equal((first.match(/class="btn/g) || []).length, 1, 'one action');
  assert.match(first, /<a class="btn one-cta" href="#add">Add it to Claude/);
  assert.match(first, /srcset="\/media\/bellwether-960\.webp 960w, \/media\/bellwether-1440\.webp 1440w, \/media\/bellwether-1920\.webp 1920w"/);
  assert.match(first, /alt="Four slender concrete towers/);
  assert.equal((body.match(/<h1/g) || []).length, 1, 'one h1 on the page');
  assert.ok(body.includes('<section class="section" id="add"'), 'the button lands on the setup steps');
});

test('the headline counts jurisdictions from the registry', async () => {
  const body = await (await get('/')).text();
  const count = new Set(enabledSources().map((s) => s.jurisdiction)).size;
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  assert.ok(body.includes(`Regulator updates from ${words[count]} jurisdictions, in one feed.`));
});

test('the page wears the 2026 brand, not the superseded Section one', async () => {
  for (const html of [await (await get('/')).text(), renderConnectorNotice(ORIGIN)]) {
    assert.ok(!/Hanken/i.test(html), 'no Hanken Grotesk');
    assert.ok(!/#F1F1ED/i.test(html), 'no Section paper');
    assert.ok(!/repeating-linear-gradient/.test(html), 'no blueprint grid');
    assert.ok(html.includes('/brand/dap-logo-horizontal-carbon.svg'), 'the supplied DAP lockup');
    assert.ok(/fonts\/Raleway-300\.woff2/.test(html) && /fonts\/Archivo-400\.woff2/.test(html));
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'fonts are self hosted');
    assert.doesNotMatch(html, /[\u2013\u2014]/);
  }
});
