// The sandbox lock's CI check (steer of 26 Oct 2026, S7). Every commit a pull
// request adds must carry the trailer "Sandbox: devcontainer" or
// "Sandbox: cloud", written by .githooks/prepare-commit-msg inside a sandbox.
// A commit made anywhere else lacks it and the pull request goes red.
// Usage: node scripts/check-sandbox-trailers.mjs <base sha> <head sha>
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const TRAILER_RE = /^Sandbox: (devcontainer|cloud)\s*$/m;

// commits: [{ sha, message }] -> the ones without the trailer.
export function missingTrailer(commits) {
  return commits.filter((c) => !TRAILER_RE.test(c.message));
}

export function commitsBetween(base, head, git = (args) => execFileSync('git', args, { encoding: 'utf8' })) {
  const out = git(['log', '--format=%H%x00%B%x01', `${base}..${head}`]);
  return out.split('\x01').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sha, message] = s.split('\x00');
    return { sha: sha.trim(), message: message || '' };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) { console.error('usage: check-sandbox-trailers.mjs <base> <head>'); process.exit(2); }
  const missing = missingTrailer(commitsBetween(base, head));
  if (missing.length) {
    console.error(`${missing.length} commit(s) made outside the sandbox (no "Sandbox:" trailer):`);
    for (const c of missing) console.error(`  ${c.sha.slice(0, 7)} ${c.message.split('\n')[0]}`);
    console.error('Ledger commits are made only in the dev container or the cloud. See bsibeth234/dap-bye-saas docs/STEER_2026-10-26-untrusted-content.md.');
    process.exit(1);
  }
  console.log('Every commit carries the Sandbox trailer.');
}
