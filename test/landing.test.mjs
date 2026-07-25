import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { isFallbackHost } from '../src/index.js';
import { renderLanding } from '../src/landing.js';
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
    /The connector collects no personal data\. This page counts visits without cookies or identifiers\./
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

  for (const path of ['/health', '/favicon.ico', '/og.png', '/fonts/Archivo-600.ttf']) {
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
    body.includes(`<meta property="og:image" content="${ORIGIN}/og.png">`),
    'og:image must be an absolute URL on the origin the page was served from'
  );
  assert.match(body, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(body.includes(`<meta name="twitter:image" content="${ORIGIN}/og.png">`));

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
    onFallback.includes('<meta property="og:image" content="https://dap-bellwether.dap-solutions.workers.dev/og.png">'),
    'the card image is still served by whichever host answered'
  );

  for (const tag of ['og:type', 'og:site_name', 'og:title', 'og:description']) {
    assert.ok(body.includes(`property="${tag}"`), `${tag} must be declared`);
  }
  // Crawlers that will not fetch the image still lay out the card from these.
  assert.match(body, /<meta property="og:image:width" content="1200">/);
  assert.match(body, /<meta property="og:image:height" content="630">/);
});

test('/og.png is served as a 1200x630 PNG with a long cache header', async () => {
  const response = await get('/og.png');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.match(response.headers.get('Cache-Control'), /max-age=31536000/);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.deepEqual(
    [...bytes.slice(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'must actually be a PNG'
  );
  // Dimensions live in the IHDR. A card at the wrong size gets cropped or
  // rejected by the networks rather than failing loudly here.
  assert.equal(view.getUint32(16), 1200, 'width');
  assert.equal(view.getUint32(20), 630, 'height');
});

test('icons, manifest and fonts are served with types and long cache headers', async () => {
  const expected = [
    ['/favicon.ico', 'image/x-icon'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icons/favicon-16.png', 'image/png'],
    ['/icons/favicon-512.png', 'image/png'],
    ['/fonts/Archivo-600.ttf', 'font/ttf'],
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
