/**
 * Holds .github/workflows/deploy.yml to its rules. Read as text, step by step, because the repo carries no YAML
 * parser and the rules are about where things are written: the token only on wrangler steps, no expression inside
 * a script, every action pinned to a commit, production only on a push to main after the tests pass.
 * Change the workflow and this file together; never loosen a test to fit a workflow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
const lines = text.split('\n');

/** The workflow's jobs, by name, each as its own text. */
function jobs() {
  const start = lines.indexOf('jobs:');
  assert.ok(start > 0, 'the workflow has jobs');
  const out = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^  ([a-z][a-z-]*):$/.exec(line);
    if (m) {
      name = m[1];
      out[name] = [];
      continue;
    }
    if (name) out[name].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
}

/** A job's steps, each as its own text. */
function steps(job) {
  return job.split(/\n(?=      - )/).filter((s) => s.startsWith('      - '));
}

/** The script of a step's run block. */
function runOf(step) {
  const i = step.indexOf('run: ');
  return i < 0 ? '' : step.slice(i + 5);
}

const JOBS = jobs();

test('the workflow has the three jobs, runs on every pull request and push, and reads the repo only', () => {
  assert.deepEqual(Object.keys(JOBS), ['test', 'deploy', 'live-check']);
  assert.match(text, /^on:\n  pull_request:\n  push:\n/m);
  assert.match(text, /^permissions:\n  contents: read\n/m);
  assert.ok(!/:\s*write\b/.test(text), 'no write permission anywhere');
  assert.ok(!/pull_request_target|workflow_run/.test(text), 'no trigger that hands secrets to a fork');
});

test('every action is pinned to a full commit, with its release in a comment', () => {
  const uses = lines.filter((l) => /^\s+(- )?uses: /.test(l));
  assert.ok(uses.length >= 8);
  for (const line of uses) assert.match(line, /uses: [a-z-]+\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line.trim());
});

test('the test job installs, builds the examples from the live feeds, tests, and touches no secret', () => {
  const job = JOBS.test;
  assert.ok(!job.includes('secrets.'), 'no secret in the test job');
  assert.ok(!/wrangler deploy(?! --dry-run)/.test(job), 'the test job never deploys');
  const order = ['npm ci', 'npm run build:bazaar -- --feeds', 'npm test', 'wrangler deploy --dry-run'].map((s) => job.indexOf(s));
  assert.ok(order.every((i) => i > 0), 'every step is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
});

test('production deploys only on a push to main, only after the tests pass, with the examples they tested', () => {
  const job = JOBS.deploy;
  assert.match(job, /^    needs: test$/m);
  assert.match(job, /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
  assert.match(job, /name: bazaar-examples/);
  assert.ok(job.indexOf('check-bazaar-examples.mjs') < job.indexOf('wrangler deploy --tag'), 'the examples are checked before the deploy');
  assert.ok(job.indexOf('wrangler deployments status') < job.indexOf('wrangler deploy --tag'), 'the live version is read before the deploy');
  assert.match(JOBS.test, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n\s+uses: actions\/upload-artifact/);
});

test('the live check runs after every deploy that started, and a failure rolls back and fails the run', () => {
  const job = JOBS['live-check'];
  assert.match(job, /^    needs: deploy$/m);
  assert.match(job, /^    if: always\(\) && needs\.deploy\.outputs\.started == 'true'$/m);
  assert.match(job, /node scripts\/live-check\.mjs https:\/\/bellwether\.dap\.solutions/);
  const rollback = steps(job).find((s) => s.includes('wrangler rollback'));
  assert.ok(rollback, 'a rollback step');
  assert.match(rollback, /if: failure\(\) && steps\.check\.outcome == 'failure'/);
  assert.match(rollback, /PREVIOUS: \$\{\{ needs\.deploy\.outputs\.previous \}\}/);
  assert.match(runOf(rollback), /::error title=Live check failed, rolled back::/);
  assert.match(runOf(rollback), /exit 1\s*$/);
});

test('the Cloudflare secrets are only on wrangler steps, never inside a script, never echoed', () => {
  for (const [name, job] of Object.entries(JOBS)) {
    for (const step of steps(job)) {
      if (!step.includes('secrets.')) continue;
      assert.ok(runOf(step).includes('npx wrangler'), `${name}: a step that reads a secret runs wrangler`);
      for (const line of step.split('\n').filter((l) => l.includes('secrets.'))) {
        assert.match(line, /^          [A-Z_]+: \$\{\{ secrets\.(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID) \}\}$/, line.trim());
      }
    }
    for (const step of steps(job)) {
      const script = runOf(step);
      assert.ok(!script.includes('${{'), `${name}: no expression inside a script (values come in through env)`);
      assert.ok(!/(echo|printf|cat)[^\n]*\$\{?(CLOUDFLARE_API_TOKEN|ACCOUNT|CLOUDFLARE_ACCOUNT_ID)\b/.test(script), `${name}: no secret echoed`);
      assert.ok(!/set -x/.test(script), `${name}: no command tracing beside a secret`);
    }
  }
});

test('two deploys can never overlap, and a deploy is never cancelled', () => {
  assert.match(text, /group: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && 'bellwether-production' \|\|/);
  assert.match(text, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('no account id is written into the workflow or wrangler.toml, and no dash', () => {
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.ok(!/^account_id\s*=/m.test(toml), 'wrangler.toml names no account');
  assert.ok(!/CLOUDFLARE_ACCOUNT_ID:\s*['"]?[0-9a-f]{32}/.test(text), 'the workflow types no account id');
  assert.ok(!/[\u2013\u2014]/.test(text), 'no en or em dash');
});
