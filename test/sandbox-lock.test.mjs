// The sandbox lock (Ledger steer of 26 Oct 2026, S7 to S9, D-45), as in
// bsibeth234/dap-bye-saas T-43 to T-45: code in this repo runs only in the
// cloud, CI (GitHub Actions, Vercel, Cloudflare Workers Builds) or the dev
// container, and every commit carries the Sandbox trailer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingTrailer } from '../scripts/check-sandbox-trailers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'bellwether-lock-'));
const MARKER = join(dir, 'ledger-sandbox');
writeFileSync(MARKER, 'test marker\n');
const env = (extra) => ({ PATH: process.env.PATH, HOME: dir, LEDGER_SANDBOX_MARKER: join(dir, 'missing'), ...extra });
const hook = JSON.parse(readFileSync('.claude/settings.json', 'utf8')).hooks.PreToolUse[0];

const CASES = [
  ['a Mac terminal', {}, false, false],
  ['LEDGER_SANDBOX=devcontainer without the marker', { LEDGER_SANDBOX: 'devcontainer' }, false, false],
  ['the dev container', { LEDGER_SANDBOX: 'devcontainer', LEDGER_SANDBOX_MARKER: MARKER }, true, true],
  ['the cloud', { CLAUDE_CODE_REMOTE: 'true' }, true, true],
  ['GitHub Actions', { GITHUB_ACTIONS: 'true' }, true, false],
  ['a Vercel build', { VERCEL: '1' }, true, false],
  ['Cloudflare Workers Builds', { WORKERS_CI: '1' }, true, false],
];

for (const [name, extra, runs, commits] of CASES) {
  test(`sandbox lock: ${name}: code ${runs ? 'runs' : 'refused'}, commits ${commits ? 'made' : 'refused'}`, () => {
    assert.equal(spawnSync('sh', ['scripts/require-sandbox.sh'], { env: env(extra) }).status, runs ? 0 : 2);
    assert.equal(spawnSync('sh', ['-c', hook.hooks[0].command], { env: env(extra), input: '{}' }).status, runs ? 0 : 2);
    const msg = join(dir, `msg-${name.replace(/\W+/g, '-')}`);
    writeFileSync(msg, 'Test commit\n');
    assert.equal(spawnSync('sh', ['.githooks/prepare-commit-msg', msg], { env: env(extra) }).status, commits ? 0 : 1);
  });
}

test('sandbox lock: the hook covers every tool, and every npm script starts with the lock', () => {
  assert.equal(hook.matcher, '*');
  for (const [k, v] of Object.entries(JSON.parse(readFileSync('package.json', 'utf8')).scripts)) {
    if (k !== 'sandbox:check') assert.ok(v.startsWith('sh scripts/require-sandbox.sh && '), k);
  }
});

test('sandbox lock: a commit without the trailer fails the check', () => {
  const out = missingTrailer([{ sha: 'a', message: 'x\n\nSandbox: cloud' }, { sha: 'b', message: 'from a Mac' }]);
  assert.deepEqual(out.map((c) => c.sha), ['b']);
});

test('sandbox lock: the dev container mounts only volumes, forwards no SSH agent and has no production host on its firewall list', () => {
  const dc = JSON.parse(readFileSync('.devcontainer/devcontainer.json', 'utf8'));
  assert.equal(dc.workspaceMount, undefined);
  for (const m of dc.mounts) assert.match(m, /type=volume/);
  assert.doesNotMatch(JSON.stringify(dc), /docker\.sock|privileged/);
  assert.equal(dc.containerEnv.SSH_AUTH_SOCK, '');
  assert.equal(dc.containerEnv.PYTHONSAFEPATH, '1');
  const fw = readFileSync('.devcontainer/init-firewall.sh', 'utf8');
  const list = fw.match(/ALLOWED_DOMAINS=\(([\s\S]*?)\n\)/)[1];
  assert.doesNotMatch(list, /supabase|vercel|cloudflare|workers\.dev|dap\.solutions/);
  assert.match(fw, /iptables -P OUTPUT DROP/);
});

test('sandbox lock: the lock scripts are executable in git', () => {
  const modes = execFileSync('git', ['ls-files', '-s', '.githooks/prepare-commit-msg', 'scripts/require-sandbox.sh'], { encoding: 'utf8' });
  assert.equal((modes.match(/^100755/gm) || []).length, 2);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
