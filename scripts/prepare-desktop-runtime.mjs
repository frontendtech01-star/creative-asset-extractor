import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ensureSetup, projectRoot, run } from './lib/setup.mjs';

const chromiumRoot = path.join(projectRoot, 'vendor', 'chromium');
const chromeDir = path.join(chromiumRoot, 'chrome');
const packPlatform = String(process.env.DESKTOP_PACK_PLATFORM || process.platform).trim().toLowerCase();
const requestedArch = String(process.env.DESKTOP_PACK_ARCH || process.env.DMG_PACK_ARCH || '').trim().toLowerCase();
const packArch = ['universal', 'arm64', 'x64'].includes(requestedArch)
  ? requestedArch
  : process.arch === 'arm64'
    ? 'arm64'
    : 'x64';

const chromiumTargetsForPack = () => {
  if (packPlatform === 'darwin') {
    const targets = [];
    if (packArch === 'universal' || packArch === 'x64') {
      targets.push({ platform: 'mac', prefix: 'mac-' });
    }
    if (packArch === 'universal' || packArch === 'arm64') {
      targets.push({ platform: 'mac_arm', prefix: 'mac_arm-' });
    }
    return targets;
  }

  if (packPlatform === 'win32') {
    return [{ platform: 'win64', prefix: 'win64-' }];
  }

  if (packPlatform === 'linux') {
    return [{ platform: 'linux', prefix: 'linux-' }];
  }

  throw new Error(`Unsupported desktop Chromium pack platform: ${packPlatform}`);
};

const chromiumTargets = chromiumTargetsForPack();

const chromiumReady = () => {
  if (!existsSync(chromeDir)) return false;
  const entries = readdirSync(chromeDir);
  return chromiumTargets.every(({ prefix }) => entries.some((name) => name.startsWith(prefix)));
};

await ensureSetup({ repair: true });
await import('./stage-desktop-bin.mjs');

if (!chromiumReady()) {
  console.log(`Downloading bundled Chromium for ${packPlatform}/${packArch}...`);
  for (const target of chromiumTargets) {
    await run('npx', ['puppeteer', 'browsers', 'install', 'chrome', '--platform', target.platform, '--path', chromiumRoot], {
      stdio: 'inherit',
    });
  }
}

console.log('Desktop runtime ready (ffmpeg, yt-dlp, Chromium).');
