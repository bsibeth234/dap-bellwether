/** The load hook for register-ts.mjs: compiles a .ts file with esbuild. */
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: url });
  return { format: 'module', source: code, shortCircuit: true };
}
