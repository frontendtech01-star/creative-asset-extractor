import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ensureSetup, projectRoot, run } from './lib/setup.mjs';

const chromiumRoot = path.join(projectRoot, 'vendor', 'chromium');
const chromeDir = path.join(chromiumRoot, 'chrome');
const requestedArch = String(process.env.DMG_PACK_ARCH || '').trim().toLowerCase();
const packArch = ['universal', 'arm64', 'x64'].includes(requestedArch)
  ? requestedArch
  : process.arch === 'arm64'
    ? 'arm64'
    : 'x64';

const chromiumReady = () => {
  if (!existsSync(chromeDir)) return false;
  const entries = readdirSync(chromeDir);
  const hasArm = entries.some((name) => name.startsWith('mac_arm-'));
  const hasIntel = entries.some((name) => name.startsWith('mac-') && !name.startsWith('mac_arm-'));
  if (packArch === 'arm64') return hasArm;
  if (packArch === 'x64') return hasIntel;
  return hasArm && hasIntel;
};

await ensureSetup({ repair: true });

if (!chromiumReady()) {
  console.log(`Downloading bundled Chromium for ${packArch} DMG...`);
  if (packArch === 'universal' || packArch === 'x64') {
    await run('npx', ['puppeteer', 'browsers', 'install', 'chrome', '--platform', 'mac', '--path', chromiumRoot], {
      stdio: 'inherit',
    });
  }
  if (packArch === 'universal' || packArch === 'arm64') {
    await run('npx', ['puppeteer', 'browsers', 'install', 'chrome', '--platform', 'mac_arm', '--path', chromiumRoot], {
      stdio: 'inherit',
    });
  }
}

console.log('Desktop runtime ready (ffmpeg, yt-dlp, Chromium).');
