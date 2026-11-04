#!/usr/bin/env node
/**
 * Mutation testing on the payment and analytics branches of a change. Each mutant edits the code once and
 * must Deny: with the edit applied, npm test must fail. A mutant that passes is a defect the tests cannot
 * see.
 *
 *   node scripts/mutants/run.mjs
 *
 * Each mutant runs in a copy of the repo in the system temporary directory (node_modules linked, not
 * copied), removed after. A copy with no edit runs first and must pass, or a mutant could Deny for a reason
 * that is not its edit. Writes scripts/mutants/REPORT.md and exits 1 if any mutant survives. The same
 * pattern as dap-solutions-site scripts/mutants/run.mjs and dap-foundry edge/x402/scripts/mutants.ts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
// Everything the tests read: the code, the tests and their fixtures, both schemas, the settings and the
// documents the tests hold word for word.
const COPY = ['src', 'test', 'scripts', 'package.json', 'wrangler.toml', 'schema.sql', 'licences.sql', 'README.md', 'CLAUDE.md', 'server.json'];

const mutants = readdirSync(here)
  .filter((f) => f.endsWith('.mutant.json'))
  .sort((a, b) => Number(a.slice(1).split('.')[0]) - Number(b.slice(1).split('.')[0]))
  .map((f) => JSON.parse(readFileSync(join(here, f), 'utf8')));

const rows = [];
let survived = 0;
for (const m of [{ id: 'baseline', description: 'no edit', edits: [] }, ...mutants]) {
  const work = mkdtempSync(join(tmpdir(), `bellwether-mutant-${m.id}-`));
  try {
    for (const item of COPY) cpSync(join(root, item), join(work, item), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
    for (const e of m.edits) {
      const path = join(work, e.file);
      const text = readFileSync(path, 'utf8');
      const count = text.split(e.find).length - 1;
      if (count !== 1) throw new Error(`${m.id}: ${e.file} holds the text to replace ${count} times, not once`);
      writeFileSync(path, text.replace(e.find, e.replace));
    }
    const run = spawnSync('npm', ['test'], { cwd: work, encoding: 'utf8' });
    const out = `${run.stdout}\n${run.stderr}`;
    const failing = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1]);
    const denied = run.status !== 0;
    if (m.id === 'baseline') {
      if (denied) {
        console.error(`The baseline copy fails its tests, so no mutant result would mean anything:\n${failing.slice(0, 5).join('\n')}`);
        rmSync(work, { recursive: true, force: true });
        process.exit(1);
      }
      process.stdout.write('baseline passes\n');
      continue;
    }
    if (!denied) survived += 1;
    rows.push(`| ${m.id} | ${m.description} | ${denied ? 'Deny' : '**PASSED (defect)**'} | ${failing.slice(0, 2).join('; ').replace(/\|/g, '/')} |`);
    process.stdout.write(`${m.id} ${denied ? 'Deny' : 'PASSED'}  ${failing.slice(0, 1).join('')}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
writeFileSync(
  join(here, 'REPORT.md'),
  `# Mutants: Bellwether\n\nEach mutant edits one payment or analytics branch of the change of 4 November 2026 (Use when descriptions, a Bazaar listing on every price, one Analytics Engine data point per answered call) and must Deny: npm test must fail with the edit applied. A copy with no edit passes first. Run: \`node scripts/mutants/run.mjs\`.\n\n| Mutant | Defect | Result | First failing tests |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n${survived === 0 ? `All ${mutants.length} Deny.` : `${survived} of ${mutants.length} passed: each is a defect the tests cannot see.`}\n`,
);
process.exit(survived === 0 ? 0 : 1);
