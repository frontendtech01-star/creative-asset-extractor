#!/usr/bin/env node
/**
 * QC packaged macOS app: verify ASAR deps, server startup, extract + ZIP.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(projectRoot, 'release');

const findPackagedApp = () => {
  const candidates = [
    path.join(releaseDir, 'mac-universal', 'Creative Asset Extractor.app'),
    path.join(releaseDir, 'mac-arm64', 'Creative Asset Extractor.app'),
    path.join(releaseDir, 'mac', 'Creative Asset Extractor.app'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Packaged .app not found. Run npm run dmg first.');
};

const asarList = (asarPath) => {
  const asarBin = path.join(projectRoot, 'node_modules', '.bin', 'asar');
  const out = execFileSync(asarBin, ['list', asarPath], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
};

const issues = [];
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  issues.push(msg);
  console.log(`  ✗ ${msg}`);
};

const appPath = process.env.QC_APP_PATH || findPackagedApp();
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const asarPath = path.join(resourcesPath, 'app.asar');
const serverBundle = path.join(appPath, 'Contents', 'Resources', 'app.asar', 'desktop', 'server.mjs');
const appExecutable = path.join(appPath, 'Contents', 'MacOS', 'Creative Asset Extractor');

console.log(`\nDMG QC → ${appPath}\n`);

if (!fs.existsSync(asarPath)) {
  fail(`Missing app.asar at ${asarPath}`);
  process.exit(1);
}
pass('app.asar present');

const chromiumApps = [];
const collectChromiumApps = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === 'Google Chrome for Testing.app') chromiumApps.push(fullPath);
    else collectChromiumApps(fullPath);
  }
};
collectChromiumApps(path.join(resourcesPath, 'chromium'));
if (chromiumApps.length === 0) {
  fail('bundled Chromium app is missing');
} else {
  for (const chromiumApp of chromiumApps) {
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', chromiumApp], {
        stdio: 'pipe',
      });
      pass('bundled Chromium signature');
    } catch (error) {
      fail(`bundled Chromium signature failed: ${String(error.stderr || error.message).trim()}`);
    }
  }
}

try {
  const nodeVersion = execFileSync(appExecutable, ['-e', 'process.stdout.write(process.versions.node)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  }).trim();
  if (nodeVersion) pass(`embedded Node.js ${nodeVersion}`);
  else fail('embedded Node.js version was empty');
} catch (error) {
  fail(`embedded Node.js runtime failed: ${error.message}`);
}

for (const binary of ['ffmpeg', 'ffprobe', 'yt-dlp', 'aria2c']) {
  const binaryPath = path.join(resourcesPath, 'bin', binary);
  if (fs.existsSync(binaryPath) && (fs.statSync(binaryPath).mode & 0o111)) pass(`bundled vendor ${binary}`);
  else fail(`missing executable vendor binary: ${binaryPath}`);
}

const entries = asarList(asarPath);
const requiredModules = [
  '/node_modules/archiver/index.js',
  '/node_modules/archiver-utils/index.js',
  '/node_modules/zip-stream/index.js',
  '/node_modules/compress-commons/lib',
  '/desktop/server.mjs',
  '/dist/index.html',
];
for (const mod of requiredModules) {
  const found = entries.some((entry) => entry === mod || entry.startsWith(`${mod}/`) || entry.startsWith(mod));
  if (found) pass(`packaged ${mod.replace('/node_modules/', '')}`);
  else fail(`missing in ASAR: ${mod}`);
}

const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-qc-'));
try {
  const asarBin = path.join(projectRoot, 'node_modules', '.bin', 'asar');
  execFileSync(asarBin, ['extract', asarPath, extractDir], { stdio: 'pipe' });

  try {
    execFileSync(
      process.execPath,
      ['-e', "require('archiver-utils'); require('archiver'); require('zip-stream'); console.log('deps-ok')"],
      {
        cwd: extractDir,
        env: { ...process.env, NODE_PATH: path.join(extractDir, 'node_modules') },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    pass('archiver dependency chain resolves in extracted ASAR');
  } catch (e) {
    fail(`archiver dependency chain failed: ${String(e.stderr || e.message).trim()}`);
  }

  const serverPath = path.join(extractDir, 'desktop', 'server.mjs');
  if (!fs.existsSync(serverPath)) {
    fail('desktop/server.mjs missing after extract');
  } else {
    pass('desktop/server.mjs extractable');
    process.env.NODE_ENV = 'production';
    process.env.VDX_SKIP_AUTOSTART = '1';
    process.env.VDX_APP_ROOT = extractDir;
    process.env.VDX_RESOURCES_PATH = resourcesPath;
    process.chdir(extractDir);

    let serverHandle = null;
    try {
      const serverModule = await import(pathToFileURL(serverPath).href);
      serverHandle = await serverModule.startServer();
      const serverUrl = serverHandle.url;
      pass(`bundled server started at ${serverUrl}`);

      const health = await fetch(`${serverUrl}/`, { headers: { 'X-VDX-Local-Request': '1' } });
      if (health.ok) pass('server serves frontend');
      else fail(`frontend HTTP ${health.status}`);

      const extractRes = await fetch(`${serverUrl}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
        body: JSON.stringify({ url: 'https://www.posluma.com/', mode: 'static' }),
        signal: AbortSignal.timeout(120000),
      });
      const extract = await extractRes.json().catch(() => ({}));
      if (extractRes.ok && extract.images?.length > 0) {
        pass(`extract OK (${extract.images.length} images)`);
      } else {
        fail(`extract failed: ${extract?.error || extractRes.status}`);
      }

      const img = extract.images?.find((i) => /\.(?:png|jpe?g|webp)/i.test(String(i.url || ''))) || extract.images?.[0];
      if (img?.url) {
        const zipRes = await fetch(`${serverUrl}/api/download-zip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
          body: JSON.stringify({
            items: [{ url: img.url, assetType: 'image', originalUrl: img.url, filenameBase: 'qc-test' }],
          }),
          signal: AbortSignal.timeout(120000),
        });
        const zipBuf = Buffer.from(await zipRes.arrayBuffer());
        if (zipRes.ok && zipBuf.length > 64) pass(`ZIP OK (${zipBuf.length}b)`);
        else fail(`ZIP failed: HTTP ${zipRes.status}, ${zipBuf.length}b`);
      }
    } catch (e) {
      fail(`runtime API test failed: ${e.message}`);
    } finally {
      if (serverHandle?.server?.close) {
        await new Promise((resolve) => serverHandle.server.close(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
} finally {
  // Keep the extracted app folder on successful QC runs. Puppeteer/fonteditor can
  // still have late ESM work pending while Node is exiting; deleting this folder
  // immediately after a PASS can turn a successful DMG into a false non-zero build.
  if (issues.length > 0) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

const dmgCandidates = fs.readdirSync(releaseDir).filter((name) => name.endsWith('-universal.dmg') || name.endsWith('.dmg'));
const latestDmg = dmgCandidates
  .map((name) => ({ name, mtime: fs.statSync(path.join(releaseDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];
if (latestDmg) {
  const sizeMb = (fs.statSync(path.join(releaseDir, latestDmg.name)).size / (1024 * 1024)).toFixed(0);
  pass(`DMG artifact: ${latestDmg.name} (${sizeMb} MB)`);
}

console.log(`\n=== DMG QC ${issues.length === 0 ? 'PASS' : 'FAIL'} (${issues.length} issues) ===\n`);
if (issues.length) {
  issues.forEach((issue) => console.log(`  - ${issue}`));
  process.exit(1);
}
process.exit(0);
