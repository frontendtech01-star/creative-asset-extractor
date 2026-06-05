import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './lib/setup.mjs';

const outdir = path.join(projectRoot, 'desktop');
await fs.mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, 'server.ts')],
  outfile: path.join(outdir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
});

console.log('Desktop server bundle ready.');
