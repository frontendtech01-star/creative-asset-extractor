import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, run } from './lib/setup.mjs';

if (process.platform !== 'darwin') {
  console.error('npm run dmg is macOS-only. Use npm run dist:win or npm run dist:linux on other platforms.');
  process.exit(1);
}

console.log('Preparing bundled desktop runtime...');
await run('node', ['scripts/prepare-desktop-runtime.mjs'], { stdio: 'inherit', cwd: projectRoot });

console.log('Building frontend...');
await run('npm', ['run', 'build'], { stdio: 'inherit', cwd: projectRoot });

console.log('Bundling desktop server...');
await run('npm', ['run', 'build:desktop:server'], { stdio: 'inherit', cwd: projectRoot });

const electronBuilder = path.join(projectRoot, 'node_modules', '.bin', 'electron-builder');
const releaseDir = path.join(projectRoot, 'release');
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const packageVersion = String(packageJson.version || '2.0.0').replace(/^v/i, '');
const requestedArch = String(process.env.DMG_PACK_ARCH || '').trim().toLowerCase();
const packArch = ['universal', 'arm64', 'x64'].includes(requestedArch)
  ? requestedArch
  : process.arch === 'arm64'
    ? 'arm64'
    : 'x64';
const archArg = packArch === 'universal' ? '--universal' : `--${packArch}`;

const releaseEntries = await fs.readdir(releaseDir).catch(() => []);
for (const name of releaseEntries) {
  if (name.endsWith('.dmg') || name.endsWith('.dmg.blockmap')) {
    await fs.rm(path.join(releaseDir, name), { force: true });
    console.log(`Removed old installer: ${name}`);
  }
}

console.log(`\nPackaging ${packArch} DMG...`);

await run(electronBuilder, ['--mac', 'dmg', archArg, '--publish', 'never'], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: { ...process.env, DMG_PACK_ARCH: packArch },
});

const candidates = [
  `Creative.Asset.Extractor-${packageVersion}-${packArch}.dmg`,
  `Creative Asset Extractor-${packageVersion}-${packArch}.dmg`,
  `Creative Asset Extractor-${packageVersion}-universal.dmg`,
  `Creative Asset Extractor-${packageVersion}.dmg`,
];
let dmgPath = '';
for (const name of candidates) {
  const candidate = path.join(releaseDir, name);
  try {
    await fs.access(candidate);
    dmgPath = candidate;
    break;
  } catch {
    // try next name
  }
}

if (!dmgPath) {
  const entries = await fs.readdir(releaseDir).catch(() => []);
  const dmg = entries.filter((name) => name.endsWith('.dmg')).sort().at(-1);
  if (dmg) dmgPath = path.join(releaseDir, dmg);
}

console.log(`\n${packArch} DMG ready:`);
console.log(dmgPath || '(build finished — check release/ folder)');
console.log('\nOpen the DMG, drag the app to Applications, and launch it.');

if (dmgPath) {
  const qcDir =
    packArch === 'universal'
      ? 'mac-universal'
      : packArch === 'arm64'
        ? 'mac-arm64'
        : 'mac';
  const qcAppPath = path.join(releaseDir, qcDir, 'Creative Asset Extractor.app');
  console.log('\nRunning DMG QC...');
  await run('node', ['scripts/qc-dmg.mjs'], {
    stdio: 'inherit',
    cwd: projectRoot,
    env: { ...process.env, QC_APP_PATH: qcAppPath },
  });
}
