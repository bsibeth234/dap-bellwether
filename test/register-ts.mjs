/**
 * Lets Node load the vendored TypeScript in src/x402 on any Node from 22.5 on.
 *
 * Node's own TypeScript support changes between versions: 22 needs a flag for
 * the parameter properties the library uses, and 26 removed that flag. So the
 * tests do not use it. Each .ts file is compiled with esbuild as it is
 * imported, which is what wrangler does when it bundles the Worker, so the
 * tests and production run the same source the same way.
 *
 *   node --import ./test/register-ts.mjs --test test/*.test.mjs
 *
 * Uses registerHooks where Node has it (22.15 and later) and register before
 * that, since newer Node deprecates register.
 */
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const compile = (url) =>
  transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: url })
    .code;

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
      return { format: 'module', source: compile(url), shortCircuit: true };
    },
  });
} else {
  nodeModule.register('./ts-loader.mjs', import.meta.url);
}
