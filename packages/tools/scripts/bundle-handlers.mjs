/**
 * Bundles each Lambda handler in handlers-src/ into a self-contained
 * dist/handlers/<name>/index.js via esbuild. Constructs reference these
 * bundles with lambda.Code.fromAsset, so library consumers need no esbuild
 * or docker at synth time.
 */
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'handlers-src');

if (!existsSync(srcDir)) {
  console.log('No handlers-src directory; skipping handler bundling.');
  process.exit(0);
}

const entries = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
for (const entry of entries) {
  const name = entry.replace(/\.ts$/, '');
  await build({
    entryPoints: [path.join(srcDir, entry)],
    outfile: path.join(root, 'dist', 'handlers', name, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'warning',
  });
}
console.log(`Bundled ${entries.length} handler(s) into dist/handlers/.`);
