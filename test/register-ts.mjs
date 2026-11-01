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
 */
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
