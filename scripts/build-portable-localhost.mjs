import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { projectRoot } from './lib/setup.mjs';

const releaseDir = path.join(projectRoot, 'release');
const outputPath = path.join(releaseDir, 'Creative-Asset-Extractor-Localhost.zip');
await fsp.mkdir(releaseDir, { recursive: true });
await fsp.rm(outputPath, { force: true });

const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', { zlib: { level: 9 } });
const completed = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
});

archive.pipe(output);
const root = 'Creative Asset Extractor Localhost';
for (const entry of ['dist', 'server', 'scripts', 'src']) {
  archive.directory(path.join(projectRoot, entry), path.join(root, entry));
}
for (const entry of ['server.ts', 'package.json', 'package-lock.json', 'RELEASE_NOTES.md']) {
  archive.file(path.join(projectRoot, entry), { name: path.join(root, entry) });
}
await archive.finalize();
await completed;

console.log(`Portable localhost package: ${outputPath}`);
console.log(`Size: ${(archive.pointer() / 1024 / 1024).toFixed(1)} MB`);
