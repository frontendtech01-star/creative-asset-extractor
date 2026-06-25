import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, run } from './lib/setup.mjs';

if (process.platform !== 'win32') {
  console.error('npm run dist:win must run on Windows. Use GitHub Actions windows-latest to generate the EXE.');
  process.exit(1);
}

console.log('Preparing bundled Windows desktop runtime...');
await run('node', ['scripts/prepare-desktop-runtime.mjs'], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: { ...process.env, DESKTOP_PACK_PLATFORM: 'win32', DESKTOP_PACK_ARCH: 'x64' },
});

console.log('Building frontend...');
await run('npm', ['run', 'build'], { stdio: 'inherit', cwd: projectRoot });

console.log('Bundling desktop server...');
await run('npm', ['run', 'build:desktop:server'], { stdio: 'inherit', cwd: projectRoot });

const releaseDir = path.join(projectRoot, 'release');
const releaseEntries = await fs.readdir(releaseDir).catch(() => []);
for (const name of releaseEntries) {
  if (name.endsWith('.exe') || name.endsWith('.exe.blockmap')) {
    await fs.rm(path.join(releaseDir, name), { force: true });
    console.log(`Removed old Windows installer: ${name}`);
  }
}

const electronBuilder = path.join(projectRoot, 'node_modules', '.bin', 'electron-builder.cmd');
console.log('\nPackaging Windows EXE...');
await run(electronBuilder, ['--win', 'nsis', '--x64'], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: { ...process.env, DESKTOP_PACK_PLATFORM: 'win32', DESKTOP_PACK_ARCH: 'x64' },
});

const entries = await fs.readdir(releaseDir).catch(() => []);
const exe = entries.filter((name) => name.endsWith('.exe')).sort().at(-1);
if (!exe) {
  console.error('Windows packaging finished without creating release/*.exe.');
  process.exit(1);
}

console.log('\nWindows EXE ready:');
console.log(path.join(releaseDir, exe));
