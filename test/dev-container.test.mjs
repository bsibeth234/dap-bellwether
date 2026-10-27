// The Ledger dev container, as in bsibeth234/dap-bye-saas T-45 (steer of 26
// Oct 2026, S8, and the fixes of #137): no Mac folder and no Docker socket,
// no SSH agent, Git sign-in or GPG agent forwarded, a non-root user, and a
// firewall that is default deny with no production host on its list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dc = JSON.parse(readFileSync('.devcontainer/devcontainer.json', 'utf8'));
const dockerfile = readFileSync('.devcontainer/Dockerfile', 'utf8');
const firewall = readFileSync('.devcontainer/init-firewall.sh', 'utf8');
const check = readFileSync('scripts/sandbox-check.sh', 'utf8');
const allowed = (firewall.match(/ALLOWED_DOMAINS=\(([\s\S]*?)\n\)/) || [])[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('T-45: only named Docker volumes are mounted: no Mac folder, no Docker socket, no bind mount', () => {
  assert.equal(dc.workspaceMount, undefined, 'the repo lives in a volume (Clone Repository in Container Volume)');
  for (const m of dc.mounts) {
    assert.match(m, /type=volume/, m);
    assert.doesNotMatch(m, /type=bind|docker\.sock|\/Users|\$\{localEnv|\.ssh|\.aws|Keychains/, m);
  }
  const all = JSON.stringify(dc);
  assert.doesNotMatch(all, /docker\.sock|--privileged|"privileged"|docker-in-docker|docker-outside-of-docker/);
  assert.deepEqual(dc.runArgs.sort(), ['--cap-add=NET_ADMIN', '--cap-add=NET_RAW'], 'only the rights the firewall needs');
});

test('T-45: no SSH agent, a non-root user, the sandbox marker, pinned versions', () => {
  assert.equal(dc.containerEnv.SSH_AUTH_SOCK, '');
  assert.equal(dc.remoteEnv.SSH_AUTH_SOCK, '');
  assert.equal(dc.remoteUser, 'node');
  assert.equal(dc.containerUser, 'node');
  assert.equal(dc.containerEnv.LEDGER_SANDBOX, 'devcontainer');
  assert.match(dockerfile, /> \/etc\/ledger-sandbox/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^FROM node:\d+\.\d+\.\d+-bookworm-slim(@sha256:[a-f0-9]{64})?$/m, 'an exact Node release');
  assert.match(dc.build.args.CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/, 'an exact Claude Code version');
  assert.match(dockerfile, /NOPASSWD: \/usr\/local\/bin\/init-firewall\.sh"/, 'sudo only for the firewall');
  assert.doesNotMatch(dockerfile, /NOPASSWD: ALL/);
});

test('T-45: the firewall is default deny, HTTPS only, and lists no production or unknown host', () => {
  assert.match(firewall, /iptables -P OUTPUT DROP/);
  assert.match(firewall, /iptables -P INPUT DROP/);
  assert.match(firewall, /--dport 443 -m set --match-set allowed-domains dst -j ACCEPT/);
  assert.doesNotMatch(firewall, /--dport 22/, 'no outbound SSH');
  assert.doesNotMatch(firewall, /HOST_NETWORK/, 'nothing on the Mac is reachable');
  for (const d of allowed) assert.doesNotMatch(d, /supabase|vercel|cloudflare|workers\.dev|dap\.solutions|amazonaws|169\.254/, d);
  assert.deepEqual(allowed.sort(), [
    'api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'files.pythonhosted.org', 'marketplace.visualstudio.com',
    'platform.claude.com', 'pypi.org', 'registry.npmjs.org', 'sentry.io',
    'update.code.visualstudio.com', 'vscode.blob.core.windows.net',
  ], 'a new host on the list is a reviewed change');
  for (const host of ['example.com', 'api.supabase.com', 'api.cloudflare.com']) assert.match(firewall, new RegExp(`refused https://${host.replace(/\./g, '\\.')}`), `the start-up check proves ${host} is refused`);
});

// Runs a script with stand-ins for the network and firewall tools, so its
// logic is tested without root or a network. STUB_UNRESOLVED names hosts dig
// finds no address for; STUB_UNREACHABLE names hosts curl cannot reach.
const stubDir = mkdtempSync(join(tmpdir(), 'bellwether-dc-'));
const STUBS = {
  'iptables-save': 'exit 0',
  iptables: 'exit 0',
  ipset: '[ "$1" = list ] && printf "1.2.3.4\\n5.6.7.8\\n"; exit 0',
  aggregate: 'cat',
  jq: 'cat >/dev/null; case "$1" in -e) exit 0;; -r) echo 140.82.112.0/20;; esac',
  dig: 'for a; do d=$a; done; case " $STUB_UNRESOLVED " in *" $d "*) exit 0;; esac; echo "$d. 60 IN A 1.2.3.4"',
  curl: 'for a; do u=$a; done; case "$u" in *api.github.com/meta) echo "{}"; exit 0;; *example.com*|*supabase*|*cloudflare*) exit 7;; esac; for h in $STUB_UNREACHABLE; do case "$u" in *"$h"*) exit 7;; esac; done; exit 0',
};
for (const [name, body] of Object.entries(STUBS)) {
  writeFileSync(join(stubDir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(stubDir, name), 0o755);
}
const run = (script, extra = {}) => spawnSync('bash', [script], {
  encoding: 'utf8',
  env: { PATH: `${stubDir}:${process.env.PATH}`, HOME: extra.HOME || stubDir, ...extra },
});

test('T-45: a listed host that does not resolve is skipped with a warning; the firewall still comes up', () => {
  const r = run('.devcontainer/init-firewall.sh', { STUB_UNRESOLVED: 'sentry.io' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WARNING: cannot resolve sentry\.io, skipped/);
  assert.match(r.stdout, /Ledger firewall: default deny/);
});

test('T-45: the firewall refuses to come up half-built: api.anthropic.com and GitHub are required', () => {
  for (const [extra, error] of [
    [{ STUB_UNRESOLVED: 'api.anthropic.com' }, /ERROR: cannot resolve api\.anthropic\.com/],
    [{ STUB_UNREACHABLE: 'api.anthropic.com' }, /ERROR: api\.anthropic\.com unreachable/],
    [{ STUB_UNREACHABLE: 'api.github.com/zen' }, /ERROR: GitHub unreachable/],
  ]) {
    const r = run('.devcontainer/init-firewall.sh', extra);
    assert.equal(r.status, 1, JSON.stringify(extra));
    assert.match(r.stdout, error);
    assert.doesNotMatch(r.stdout, /Ledger firewall: default deny/);
  }
  assert.match(firewall, /iptables -P OUTPUT DROP[\s\S]*refused https:\/\/example\.com/, 'the refusal checks run after default deny');
});

test('T-45: sandbox:check fails on a forwarded Git sign-in or GPG agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'bellwether-dc-home-'));
  mkdirSync(join(home, '.gnupg'));
  writeFileSync(join(home, '.gnupg', 'S.gpg-agent'), '');
  const r = run('scripts/sandbox-check.sh', {
    HOME: home,
    GIT_ASKPASS: '/vscode/askpass.sh',
    VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git-test.sock',
    GPG_AGENT_INFO: '/tmp/gpg:1:1',
  });
  assert.equal(r.status, 1);
  for (const line of [/NOT OK: .*GIT_ASKPASS/, /NOT OK: .*VSCODE_GIT_IPC_HANDLE/, /NOT OK: a GPG agent is forwarded \(GPG_AGENT_INFO/, /NOT OK: .*GPG agent \(.*\.gnupg\/S\.gpg-agent\)/]) assert.match(r.stdout, line);
  assert.doesNotMatch(r.stdout, /Sandbox OK/);
  // The sockets VS Code leaves in /tmp and /run/user are found by these patterns.
  for (const p of ['/tmp/vscode-ssh-auth-*', '/tmp/vscode-git-*.sock', '/tmp/vscode-gpg-*', '/run/user/*/gnupg/S.gpg-agent*']) assert.ok(check.includes(p), p);
});

test('T-45: sandbox:check reports none of those variables when none is set', () => {
  // Only the variables: the socket checks read the real /tmp and /run/user,
  // and a CI runner has its own gpg-agent socket there.
  const r = run('scripts/sandbox-check.sh', { HOME: mkdtempSync(join(tmpdir(), 'bellwether-dc-home-')) });
  assert.doesNotMatch(r.stdout, /GIT_ASKPASS|VSCODE_GIT_IPC_HANDLE|GPG_AGENT_INFO/);
});

test('T-45: every bash in the container clears the Git sign-in and agent variables VS Code adds', () => {
  const vars = ['GIT_ASKPASS', 'VSCODE_GIT_IPC_HANDLE', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN', 'GPG_AGENT_INFO', 'SSH_AUTH_SOCK'];
  const r = spawnSync('bash', ['-c', '. .devcontainer/clear-forwarding.sh; env'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...Object.fromEntries(vars.map((v) => [v, '/tmp/forwarded'])) },
  });
  assert.equal(r.status, 0, r.stderr);
  for (const v of vars) assert.doesNotMatch(r.stdout, new RegExp(`^${v}=`, 'm'), `${v} is cleared`);
  assert.match(dockerfile, /^COPY clear-forwarding\.sh \/etc\/ledger-clear-forwarding\.sh$/m);
  assert.match(dockerfile, />> \/home\/node\/\.bashrc/, "VS Code's terminal reads ~/.bashrc");
});

test('T-45: every start points git at the container\'s gh sign-in, after the firewall, and skips it when gh is not signed in', () => {
  const steps = dc.postStartCommand.split(' && ');
  const step = steps.at(-1);
  assert.equal(step, 'if gh auth status --hostname github.com >/dev/null 2>&1; then gh auth setup-git --hostname github.com; fi', 'the last step');
  assert.equal(steps[0], 'sudo /usr/local/bin/init-firewall.sh');
  const ghDir = mkdtempSync(join(tmpdir(), 'bellwether-dc-gh-'));
  const log = join(ghDir, 'calls');
  writeFileSync(join(ghDir, 'gh'), `#!/bin/sh\necho "$*" >> ${log}\n[ "$2" = status ] && exit "$GH_STATUS"\nexit 0\n`);
  chmodSync(join(ghDir, 'gh'), 0o755);
  for (const [status, expected] of [['0', 'auth status --hostname github.com\nauth setup-git --hostname github.com\n'], ['1', 'auth status --hostname github.com\n']]) {
    writeFileSync(log, '');
    const r = spawnSync('sh', ['-c', step], { encoding: 'utf8', env: { PATH: `${ghDir}:${process.env.PATH}`, GH_STATUS: status } });
    assert.equal(r.status, 0, `gh status ${status}: the start does not fail`);
    assert.equal(readFileSync(log, 'utf8'), expected, `gh status ${status}`);
  }
});

test('T-45: the container runs the firewall at every start, then removes what VS Code forwards, and waits for it', () => {
  const [firewallStep, ...cleanup] = dc.postStartCommand.split(' && ').slice(0, -1);
  assert.equal(firewallStep, 'sudo /usr/local/bin/init-firewall.sh', 'the firewall comes first');
  const removed = cleanup.join(' ');
  for (const p of ['/tmp/vscode-ssh-auth-*', '/tmp/vscode-git-*.sock', '/tmp/vscode-gpg-*', '$HOME/.gnupg/S.gpg-agent*', '/run/user/*/gnupg/S.gpg-agent*']) {
    assert.ok(removed.includes(p), `postStartCommand removes ${p}`);
  }
  assert.equal(dc.waitFor, 'postStartCommand');
  for (const v of ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'VSCODE_GIT_IPC_HANDLE', 'GPG_AGENT_INFO']) assert.equal(dc.remoteEnv[v], '', `remoteEnv clears ${v}`);
  const settings = dc.customizations.vscode.settings;
  assert.equal(settings['git.enabled'], false, "VS Code's Git extension, which opens the /tmp/vscode-git socket, is off");
  assert.equal(settings['git.terminalAuthentication'], false);
});
