import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveSmokeOutDir } from './lib/smoke-out-dir.mjs';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const SMOKE_SITE = process.env.SMOKE_SITE_URL || 'https://www.youtube.com/watch?v=jhRoOonf58I';
const OUT_DIR = resolveSmokeOutDir('platform-fhd', SMOKE_SITE);
const REPORT_PATH = path.join(OUT_DIR, 'report.json');

const tests = [
  {
    provider: 'youtube',
    url: process.env.SMOKE_YOUTUBE_URL || 'https://www.youtube.com/watch?v=jhRoOonf58I',
  },
  {
    provider: 'vimeo',
    url: process.env.SMOKE_VIMEO_URL || 'https://vimeo.com/946803926',
  },
  {
    provider: 'instagram',
    url: process.env.SMOKE_INSTAGRAM_URL || 'https://www.instagram.com/reel/DN5uoz-CS3g/',
  },
  {
    provider: 'x',
    url: process.env.SMOKE_X_URL || 'https://twitter.com/TwitterDev/status/1671049750519396352',
  },
];

const mkdir = () => fs.mkdir(OUT_DIR, { recursive: true });

const fetchWithTimeout = async (url, options = {}, timeoutMs = 120000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const jsonRequest = async (pathName, timeoutMs = 120000) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    headers: { 'X-VDX-Local-Request': '1' },
  }, timeoutMs);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text || 'Invalid JSON' };
  }
  if (!response.ok) {
    const error = new Error(json.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
};

const postJson = async (pathName, body, timeoutMs = 120000) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VDX-Local-Request': '1',
    },
    body: JSON.stringify(body),
  }, timeoutMs);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text || 'Invalid JSON' };
  }
  if (!response.ok) {
    const error = new Error(json.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
};

const sanitizeName = (value) =>
  String(value || 'video')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'video';

const downloadToFile = async (pathName, filePath, timeoutMs = 420000) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    headers: { 'X-VDX-Local-Request': '1' },
  }, timeoutMs);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let error = text || `HTTP ${response.status}`;
    try {
      error = JSON.parse(text).error || error;
    } catch {}
    throw new Error(error);
  }
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  const buffer = Buffer.concat(chunks);
  await fs.writeFile(filePath, buffer);
  return {
    size: buffer.length,
    contentType: response.headers.get('content-type') || '',
    disposition: response.headers.get('content-disposition') || '',
    mp4Signature: buffer.length > 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp',
  };
};

const ffprobe = (filePath) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });

const probeSummary = async (filePath) => {
  const metadata = await ffprobe(filePath);
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    vcodec: video?.codec_name,
    acodec: audio?.codec_name,
    duration: Number(metadata.format?.duration || 0) || undefined,
  };
};

const resolvePlatformVideo = async (test) => {
  if (test.provider === 'youtube') {
    const verify = await jsonRequest(`/api/verify-youtube-merge?${new URLSearchParams({
      url: test.url,
      quality: 'fhd',
    })}`, 420000);
    return {
      selected: {
        url: verify.mergedUrl,
        sourceUrl: test.url,
        title: 'youtube-fhd',
        height: verify.height,
        resolution: verify.resolution,
        hasAudio: verify.hasAudio,
        audioAvailable: true,
        isYouTubeMerged: true,
      },
      downloadPath: `/api/youtube-merged-stream?${new URLSearchParams({
        url: test.url,
        quality: 'fhd',
        inline: '0',
        filename: 'smoke-youtube-fhd.mp4',
      })}`,
      verify,
    };
  }

  const resolved = await jsonRequest(`/api/resolve-video?${new URLSearchParams({
    url: test.url,
    quality: 'fhd',
  })}`, 240000);
  if (!resolved?.video?.url) throw new Error('No resolved video URL returned');
  return {
    selected: resolved.video,
    downloadPath: `/api/download?${new URLSearchParams({
      url: resolved.video.url,
      filename: `smoke-${test.provider}-fhd.mp4`,
      quality: 'fhd',
    })}`,
    verify: resolved,
  };
};

const runTest = async (test) => {
  const result = {
    provider: test.provider,
    url: test.url,
    ok: false,
    failures: [],
  };

  try {
    const resolved = await resolvePlatformVideo(test);
    result.selected = {
      url: resolved.selected.url,
      sourceUrl: resolved.selected.sourceUrl,
      title: resolved.selected.title,
      provider: resolved.selected.provider,
      type: resolved.selected.type,
      height: resolved.selected.height,
      resolution: resolved.selected.resolution,
      hasAudio: resolved.selected.hasAudio,
      audioAvailable: resolved.selected.audioAvailable,
      qualityExact: resolved.selected.qualityExact,
      qualityFallback: resolved.selected.qualityFallback,
      isYouTubeMerged: resolved.selected.isYouTubeMerged,
    };

    const outputPath = path.join(OUT_DIR, `${test.provider}-fhd.mp4`);
    const downloaded = await downloadToFile(resolved.downloadPath, outputPath, test.provider === 'youtube' ? 480000 : 300000);
    const probe = await probeSummary(outputPath);
    result.download = { ...downloaded, path: outputPath };
    result.probe = probe;

    if (!downloaded.mp4Signature) result.failures.push('Downloaded file is not MP4');
    if (!probe.hasVideo) result.failures.push('ffprobe did not find a video stream');
    if (!probe.hasAudio) result.failures.push('ffprobe did not find an audio stream');
    if (test.provider !== 'instagram' && test.provider !== 'x') {
      if (Number(probe.height || 0) < 1080) result.failures.push(`FHD unavailable; downloaded ${probe.height || 'unknown'}p`);
    }

    const extraction = await postJson('/api/extract', { url: test.url }, 45000)
      .catch((error) => ({ error: error.message, videos: [] }));
    result.extractedCount = Array.isArray(extraction.videos) ? extraction.videos.length : 0;
    if (extraction.error) result.extractionWarning = extraction.error;

    result.ok = result.failures.length === 0;
  } catch (error) {
    result.failures.push(error.message || String(error));
  }

  return result;
};

await mkdir();
await fs.rm(OUT_DIR, { recursive: true, force: true });
await mkdir();

const report = {
  startedAt: new Date().toISOString(),
  api: API,
  tests: [],
};

for (const test of tests) {
  const result = await runTest(test);
  report.tests.push(result);
  console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${test.provider}: ${result.failures.join(' | ') || `${result.probe?.height || result.selected?.height || 'unknown'}p audio=${result.probe?.hasAudio}`}`);
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
}

report.finishedAt = new Date().toISOString();
report.summary = {
  pass: report.tests.filter((test) => test.ok).length,
  total: report.tests.length,
};
await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

console.log(`Report: ${REPORT_PATH}`);
console.log(JSON.stringify(report.summary, null, 2));

if (report.summary.pass !== report.summary.total) process.exit(1);
