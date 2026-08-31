#!/usr/bin/env node
/**
 * QC packaged macOS app: verify ASAR deps, server startup, extract + ZIP.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

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

const waitForAsyncExtract = (serverUrl, extractId) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${serverUrl.replace(/^http/i, 'ws')}/ws/extract?extractId=${encodeURIComponent(extractId)}`);
  const timeout = setTimeout(() => {
    ws.terminate();
    reject(new Error('Packaged browser extraction timed out'));
  }, 180000);
  ws.on('message', (raw) => {
    const event = JSON.parse(String(raw));
    if (event.type === 'complete') {
      clearTimeout(timeout);
      ws.close();
      resolve(event.result || {});
    } else if (event.type === 'error') {
      clearTimeout(timeout);
      ws.close();
      reject(new Error(event.message || 'Packaged browser extraction failed'));
    }
  });
  ws.on('error', reject);
});

const appPath = path.resolve(process.env.QC_APP_PATH || findPackagedApp());
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const asarPath = path.join(resourcesPath, 'app.asar');
const serverBundle = path.join(appPath, 'Contents', 'Resources', 'app.asar', 'desktop', 'server.mjs');
const appExecutable = path.join(appPath, 'Contents', 'MacOS', 'Creative Asset Extractor');
const packagedFfprobe = path.join(resourcesPath, 'bin', 'ffprobe');
const packagedKrogerSnapshot = path.join(resourcesPath, 'site-snapshots', 'kroger-full-live-assets.json');

const probeVideoTracks = (filePath) => {
  try {
    const output = execFileSync(packagedFfprobe, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height',
      '-of', 'json',
      filePath,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const streams = JSON.parse(output)?.streams || [];
    return {
      hasVideo: streams.some((stream) => stream.codec_type === 'video'),
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    };
  } catch {
    return { hasVideo: false, hasAudio: false };
  }
};

const skipDmgArtifact = process.env.QC_SKIP_DMG_ARTIFACT === '1';
const qcLabel = skipDmgArtifact ? 'Packaged app QC' : 'DMG QC';
console.log(`\n${qcLabel} → ${appPath}\n`);

if (!fs.existsSync(asarPath)) {
  fail(`Missing app.asar at ${asarPath}`);
  process.exit(1);
}
pass('app.asar present');
if (fs.existsSync(packagedKrogerSnapshot)) {
  const snapshot = JSON.parse(fs.readFileSync(packagedKrogerSnapshot, 'utf8'));
  if ((snapshot.images || []).length >= 300) pass(`bundled full Kroger catalog (${snapshot.images.length} live images)`);
  else fail(`bundled Kroger catalog is too small (${(snapshot.images || []).length} images)`);
} else {
  fail('bundled full Kroger catalog missing');
}

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

for (const youtubePotAsset of [
  path.join(resourcesPath, 'bin', 'youtube-pot', 'provider', 'build', 'generate_once.js'),
  path.join(resourcesPath, 'bin', 'youtube-pot', 'plugins', 'bgutil-ytdlp-pot-provider.zip'),
]) {
  if (fs.existsSync(youtubePotAsset)) pass(`bundled YouTube POT ${path.basename(youtubePotAsset)}`);
  else fail(`missing bundled YouTube POT asset: ${youtubePotAsset}`);
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
    const isolatedUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-dmg-qc-user-data-'));
    process.env.VDX_USER_DATA = isolatedUserDataDir;
    const qcDownloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-dmg-qc-downloads-'));
    process.env.CAE_DOWNLOADS_DIR = qcDownloadsDir;
    process.chdir(extractDir);

    let serverHandle = null;
    try {
      const serverModule = await import(pathToFileURL(serverPath).href);
      serverHandle = await serverModule.startServer();
      const serverUrl = serverHandle.url;
      pass(`bundled server started at ${serverUrl}`);

      const health = await fetch(`${serverUrl}/`, { headers: { 'X-VDX-Local-Request': '1' } });
      const frontendHtml = await health.text();
      if (health.ok) pass('server serves frontend');
      else fail(`frontend HTTP ${health.status}`);

      const frontendScript = frontendHtml.match(/<script[^>]+src=["']([^"']+)["']/i)?.[1] || '';
      const frontendBundle = frontendScript
        ? await fetch(new URL(frontendScript, serverUrl), { headers: { 'X-VDX-Local-Request': '1' } }).then((response) => response.text())
        : '';
      if (frontendBundle.includes('viewBox="0 0 500 394"')) pass('inline greeting illustration packaged');
      else fail('inline greeting illustration missing from packaged frontend');

      if (frontendBundle.includes('fill="#2563EB"') && frontendBundle.includes('aria-label="Hello"')) pass('inline Hello wordmark SVG packaged');
      else fail('Hello wordmark SVG missing from packaged frontend');

      const profileRes = await fetch(`${serverUrl}/api/system-profile`, { headers: { 'X-VDX-Local-Request': '1' } });
      const profile = await profileRes.json().catch(() => ({}));
      if (profileRes.ok && (profile?.displayName || profile?.username)) pass('system profile name available');
      else fail(`system profile name unavailable: HTTP ${profileRes.status}`);

      if (process.env.QC_KROGER === '1') {
        const krogerRes = await fetch(`${serverUrl}/api/browser-tabs/chrome/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
          body: JSON.stringify({ url: 'https://www.kroger.com/' }),
          signal: AbortSignal.timeout(240000),
        });
        const kroger = await krogerRes.json().catch(() => ({}));
        const krogerImages = [...(kroger?.images || []), ...(kroger?.icons || [])];
        const krogerFonts = Array.isArray(kroger?.fonts) ? kroger.fonts : [];
        const krogerColors = Array.isArray(kroger?.colors) ? kroger.colors : [];
        const livePreview = kroger?.extractionMeta?.websitePreview !== 'recovered';
        const fullCatalogSource = String(kroger?.extractionMeta?.fullLiveAssetsSource || '');
        if (
          krogerRes.ok && kroger?.ok && fullCatalogSource !== 'recovery-only' &&
          krogerImages.length >= 300 && krogerFonts.length === 13 && krogerColors.length >= 33
        ) {
          pass(`packaged Chromium full Kroger output ${krogerImages.length} images / ${krogerFonts.length} fonts / ${krogerColors.length} colors (${livePreview ? 'live page' : 'bundled live catalog'})`);
        } else {
          fail(`packaged Kroger mismatch: HTTP ${krogerRes.status}, source=${fullCatalogSource}, images=${krogerImages.length}, fonts=${krogerFonts.length}, colors=${krogerColors.length}`);
        }
      }

      const brightcoveUrl = String(process.env.QC_BRIGHTCOVE_URL || '').trim();
      if (brightcoveUrl) {
        const inspectRes = await fetch(`${serverUrl}/api/downloader/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
          body: JSON.stringify({ url: brightcoveUrl }),
          signal: AbortSignal.timeout(60000),
        });
        const inspection = await inspectRes.json().catch(() => ({}));
        const brightcoveCard = inspection?.videos?.[0];
        if (inspectRes.ok && brightcoveCard?.thumbnail && brightcoveCard?.maxHeight > 0) {
          pass(`Brightcove thumbnail + metadata OK (${brightcoveCard.maxHeight}p)`);
        } else {
          fail(`Brightcove inspection failed: ${inspection?.error || inspectRes.status}`);
        }

        const previewRes = await fetch(`${serverUrl}/api/video-preview?url=${encodeURIComponent(brightcoveUrl)}`, {
          headers: { 'X-VDX-Local-Request': '1' },
          signal: AbortSignal.timeout(60000),
        });
        const previewPayload = await previewRes.json().catch(() => ({}));
        if (previewRes.ok && previewPayload?.preview?.thumbnail) {
          pass('Website card Brightcove thumbnail OK');
        } else {
          fail(`Website card Brightcove thumbnail failed: ${previewPayload?.error || previewRes.status}`);
        }

        const downloadRes = await fetch(`${serverUrl}/api/downloader/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
          body: JSON.stringify({ url: brightcoveUrl, quality: 'hd', title: 'brightcove-qc' }),
          signal: AbortSignal.timeout(30000),
        });
        const queued = await downloadRes.json().catch(() => ({}));
        const jobId = queued?.job?.id;
        let completedJob = queued?.job;
        for (let attempt = 0; jobId && attempt < 90; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const jobRes = await fetch(`${serverUrl}/api/downloader/jobs/${jobId}`, {
            headers: { 'X-VDX-Local-Request': '1' },
            signal: AbortSignal.timeout(10000),
          });
          const jobPayload = await jobRes.json().catch(() => ({}));
          completedJob = jobPayload?.job;
          if (['completed', 'error', 'cancelled'].includes(completedJob?.status)) break;
        }
        const downloadedPath = String(completedJob?.result?.filePath || '');
        const downloadedSize = downloadedPath && fs.existsSync(downloadedPath) ? fs.statSync(downloadedPath).size : 0;
        const downloadedTracks = downloadedPath ? probeVideoTracks(downloadedPath) : { hasVideo: false, hasAudio: false };
        if (completedJob?.status === 'completed' && downloadedSize > 1024 && downloadedTracks.hasVideo && downloadedTracks.hasAudio) {
          pass(`Brightcove HLS→MP4 download OK with video + audio (${downloadedSize}b)`);
        } else {
          fail(`Brightcove download failed or is missing a media track: ${completedJob?.error || completedJob?.status || 'timed out'}`);
        }

        const platformDownloadRes = await fetch(`${serverUrl}/api/platform-video-download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
          body: JSON.stringify({
            url: brightcoveUrl,
            quality: 'hd',
            title: 'brightcove-website-card-qc',
            sourcePageUrl: 'https://www.bathandbodyworks.com/',
          }),
          signal: AbortSignal.timeout(120000),
        });
        const platformDownload = await platformDownloadRes.json().catch(() => ({}));
        const platformPath = String(platformDownload?.filePath || '');
        const platformSize = platformPath && fs.existsSync(platformPath) ? fs.statSync(platformPath).size : 0;
        const platformTracks = platformPath ? probeVideoTracks(platformPath) : { hasVideo: false, hasAudio: false };
        if (platformDownloadRes.ok && platformSize > 1024 && platformDownload?.thumbnail && platformTracks.hasVideo && platformTracks.hasAudio) {
          pass(`Website card Brightcove HLS→MP4 download OK with video + audio (${platformSize}b)`);
        } else {
          fail(`Website card Brightcove download failed or is missing a media track: ${platformDownload?.error || platformDownloadRes.status}`);
        }
      }

      const invalidBrightcoveUrls = String(process.env.QC_INVALID_BRIGHTCOVE_URLS || '')
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean);
      for (const invalidUrl of invalidBrightcoveUrls) {
        const beforeJobsRes = await fetch(`${serverUrl}/api/downloader/jobs`, {
          headers: { 'X-VDX-Local-Request': '1' },
          signal: AbortSignal.timeout(10000),
        });
        const beforeJobs = await beforeJobsRes.json().catch(() => ({}));
        const rejectedRes = await fetch(`${serverUrl}/api/downloader/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
          body: JSON.stringify({ url: invalidUrl, quality: 'hd' }),
          signal: AbortSignal.timeout(60000),
        });
        const rejected = await rejectedRes.json().catch(() => ({}));
        const afterJobsRes = await fetch(`${serverUrl}/api/downloader/jobs`, {
          headers: { 'X-VDX-Local-Request': '1' },
          signal: AbortSignal.timeout(10000),
        });
        const afterJobs = await afterJobsRes.json().catch(() => ({}));
        if (
          rejectedRes.status === 400 &&
          /Brightcove video was not found/i.test(String(rejected?.error || '')) &&
          Number(afterJobs?.count || 0) === Number(beforeJobs?.count || 0)
        ) {
          pass(`invalid Brightcove rejected before queue (${new URL(invalidUrl).searchParams.get('videoId') || 'unknown id'})`);
        } else {
          fail(`invalid Brightcove was not rejected cleanly: ${rejected?.error || rejectedRes.status}`);
        }
      }

      const extractTargetUrl = String(process.env.QC_EXTRACT_URL || 'https://www.posluma.com/').trim();
      const extractMode = String(process.env.QC_EXTRACT_MODE || 'static').trim().toLowerCase();
      const extractRes = await fetch(`${serverUrl}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
        body: JSON.stringify({ url: extractTargetUrl, ...(extractMode === 'full' ? {} : { mode: extractMode }) }),
        signal: AbortSignal.timeout(extractMode === 'full' ? 240000 : 120000),
      });
      let extract = await extractRes.json().catch(() => ({}));
      if (extractRes.ok && extract?.async && extract?.extractId) {
        extract = await waitForAsyncExtract(serverUrl, String(extract.extractId));
      }
      if (extractRes.ok && extract.images?.length > 0) {
        pass(`extract OK (${extract.images.length} images)`);
      } else {
        fail(`extract failed: ${extract?.error || extractRes.status}`);
      }

      const minimumFonts = Math.max(0, Number(process.env.QC_MIN_FONTS || 0));
      if (minimumFonts > 0) {
        const extractedFonts = Array.isArray(extract?.fonts) ? extract.fonts : [];
        if (extractedFonts.length >= minimumFonts) pass(`font extract OK (${extractedFonts.length} fonts)`);
        else fail(`font extract failed: expected at least ${minimumFonts}, got ${extractedFonts.length}`);
      }

      if (process.env.QC_REQUIRE_VIDEO_CARDS === '1' || process.env.QC_REQUIRE_CLEAN_VIDEO_CARDS === '1') {
        const videoCards = Array.isArray(extract?.videos) ? extract.videos : [];
        const junkCards = videoCards.filter((video) =>
          /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(String(video?.url || video?.src || video?.title || ''))
        );
        const missingThumbs = videoCards.filter((video) => !String(video?.thumbnail || video?.poster || '').trim());
        const requiresAtLeastOne = process.env.QC_REQUIRE_VIDEO_CARDS === '1';
        if ((!requiresAtLeastOne || videoCards.length > 0) && junkCards.length === 0 && missingThumbs.length === 0) {
          pass(`website video cards + thumbnails OK (${videoCards.length})`);
        } else {
          fail(`website video card QC failed: ${videoCards.length} cards, ${junkCards.length} image-like, ${missingThumbs.length} missing thumbnails`);
          console.log('  video card diagnostics:', JSON.stringify(videoCards.map((video) => ({
            url: video?.url,
            sourceStreamUrl: video?.sourceStreamUrl,
            sourceUrl: video?.sourceUrl,
            pageUrl: video?.pageUrl,
            provider: video?.provider,
            type: video?.type,
            title: video?.title,
            thumbnail: video?.thumbnail,
          })), null, 2));
        }
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
      fs.rmSync(qcDownloadsDir, { recursive: true, force: true });
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

if (!skipDmgArtifact) {
  const dmgCandidates = fs.readdirSync(releaseDir).filter((name) => name.endsWith('-universal.dmg') || name.endsWith('.dmg'));
  const latestDmg = dmgCandidates
    .map((name) => ({ name, mtime: fs.statSync(path.join(releaseDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (latestDmg) {
    const sizeMb = (fs.statSync(path.join(releaseDir, latestDmg.name)).size / (1024 * 1024)).toFixed(0);
    pass(`DMG artifact: ${latestDmg.name} (${sizeMb} MB)`);
  } else {
    fail('DMG artifact is missing');
  }
}

console.log(`\n=== ${qcLabel} ${issues.length === 0 ? 'PASS' : 'FAIL'} (${issues.length} issues) ===\n`);
if (issues.length) {
  issues.forEach((issue) => console.log(`  - ${issue}`));
  process.exit(1);
}
process.exit(0);
