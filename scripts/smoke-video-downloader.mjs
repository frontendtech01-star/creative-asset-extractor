/**
 * Video Downloader QC for the isolated /api/downloader routes.
 *
 * Inspect only:
 *   node scripts/smoke-video-downloader.mjs
 *
 * Inspect and download:
 *   SMOKE_DOWNLOAD=1 node scripts/smoke-video-downloader.mjs
 *
 * Full-length best-original audio:
 *   SMOKE_AUDIO=1 SMOKE_DOWNLOAD=1 node scripts/smoke-video-downloader.mjs
 *
 * Add live public Instagram/Facebook examples with:
 *   SMOKE_INSTAGRAM_REEL_URL=...
 *   SMOKE_INSTAGRAM_POST_URL=...
 *   SMOKE_FACEBOOK_VIDEO_URL=...
 *   SMOKE_FACEBOOK_REEL_URL=...
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const DOWNLOAD = process.env.SMOKE_DOWNLOAD === '1';
const AUDIO = process.env.SMOKE_AUDIO === '1';
const ONLY = String(process.env.SMOKE_ONLY || '').trim().toLowerCase();
const COOKIES_FILE_PATH = String(process.env.SMOKE_COOKIES_FILE_PATH || '').trim();
const MIN_AUDIO_DURATION = Number(process.env.SMOKE_MIN_AUDIO_DURATION || 0);
const headers = { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' };

const platforms = [
  {
    id: 'youtube',
    url: process.env.SMOKE_YOUTUBE_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  },
  {
    id: 'vimeo',
    url: process.env.SMOKE_VIMEO_URL || 'https://vimeo.com/76979871',
  },
  {
    id: 'x',
    url: process.env.SMOKE_X_URL || 'https://x.com/YVindman/status/1725136837495202165?s=20',
  },
  {
    id: 'ispot',
    url:
      process.env.SMOKE_ISPOT_URL ||
      'https://www.ispot.tv/ad/gejf/burger-king-loaded-jalapeno-whopper-you-tell-us',
  },
  { id: 'instagram-reel', url: process.env.SMOKE_INSTAGRAM_REEL_URL || '', optional: true },
  { id: 'instagram-post', url: process.env.SMOKE_INSTAGRAM_POST_URL || '', optional: true },
  { id: 'facebook-video', url: process.env.SMOKE_FACEBOOK_VIDEO_URL || '', optional: true },
  { id: 'facebook-reel', url: process.env.SMOKE_FACEBOOK_REEL_URL || '', optional: true },
  { id: 'tiktok', url: process.env.SMOKE_TIKTOK_URL || '', optional: true },
  { id: 'brightcove', url: process.env.SMOKE_BRIGHTCOVE_URL || '', optional: true },
  { id: 'direct', url: process.env.SMOKE_DIRECT_URL || '', optional: true },
  {
    id: 'm3u8',
    url: process.env.SMOKE_M3U8_URL || '',
    sourcePageUrl: process.env.SMOKE_M3U8_SOURCE_PAGE_URL || '',
    optional: true,
  },
  {
    id: 'website-video',
    url: process.env.SMOKE_WEBSITE_VIDEO_URL || '',
    sourcePageUrl: process.env.SMOKE_WEBSITE_SOURCE_PAGE_URL || '',
    optional: true,
  },
  { id: 'browser-blob', url: process.env.SMOKE_BROWSER_BLOB_URL || '', optional: true, browserBlob: true },
].filter((platform) => !ONLY || platform.id === ONLY);

const fail = (message) => {
  throw new Error(message);
};

const fetchJson = async (route, init = {}, timeoutMs = 180000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${route}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 300) };
    }
    return { response, json };
  } finally {
    clearTimeout(timer);
  }
};

const inspect = async (platform) => {
  const { response, json } = await fetchJson('/api/downloader/inspect', {
    method: 'POST',
    body: JSON.stringify({ url: platform.url }),
  });
  if (!response.ok) fail(`${platform.id} inspect: ${json?.error || response.status}`);
  const videos = Array.isArray(json?.videos) ? json.videos : [];
  if (!videos.length) fail(`${platform.id} inspect returned no cards`);
  const unique = new Set(videos.map((video) => `${video.platform}:${video.id}`));
  if (unique.size !== videos.length) fail(`${platform.id} inspect returned duplicate cards`);
  const video = videos[0];
  if (!video?.qualityVariants?.fhd?.formatAvailable && !video?.qualityVariants?.hd?.formatAvailable) {
    fail(`${platform.id} inspect returned no downloadable quality`);
  }
  console.log(
    `OK inspect ${platform.id}: cards=${videos.length}, default=${video.defaultQualityKey}, audio=${video.audioAvailable}`
  );
  return video;
};

const download = async (platform, video) => {
  const quality = AUDIO ? 'audio' : video?.qualityVariants?.fhd?.formatAvailable ? 'fhd' : 'hd';
  let downloadUrl = video.url || platform.url;
  let sourcePageUrl = platform.sourcePageUrl || '';
  if (platform.browserBlob) {
    const resolved = await fetchJson('/api/browser-tabs/chrome/resolve-blob-video', {
      method: 'POST',
      body: JSON.stringify({ url: platform.url }),
    });
    if (!resolved.response.ok || !resolved.json?.url) {
      fail(`${platform.id} resolve: ${resolved.json?.error || resolved.response.status}`);
    }
    downloadUrl = resolved.json.url;
    sourcePageUrl = resolved.json.sourcePageUrl || sourcePageUrl;
  }
  const started = await fetchJson('/api/downloader/download', {
    method: 'POST',
    body: JSON.stringify({
      url: downloadUrl,
      title: video.title,
      quality,
      sourcePageUrl: sourcePageUrl || undefined,
      cookiesFilePath: COOKIES_FILE_PATH || undefined,
    }),
  });
  if (!started.response.ok || !started.json?.job?.id) {
    fail(`${platform.id} download start: ${started.json?.error || started.response.status}`);
  }
  let job = started.json.job;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await fetchJson(`/api/downloader/jobs/${job.id}`, {}, 30000);
    if (!current.response.ok) fail(`${platform.id} job poll: ${current.json?.error || current.response.status}`);
    job = current.json.job;
  }
  if (job.status !== 'completed' || !job.result?.relativePath || job.result.size < 100000) {
    fail(`${platform.id} download: ${job.error || job.status || 'invalid result'}`);
  }
  const file = await fetch(`${BASE}/api/downloader/file?path=${encodeURIComponent(job.result.relativePath)}`, {
    headers: { 'X-VDX-Local-Request': '1' },
  });
  if (!file.ok) fail(`${platform.id} completed file link returned ${file.status}`);
  await file.body?.cancel();
  const ffprobe = [
    process.env.SMOKE_FFPROBE_PATH,
    path.resolve('vendor/bin-pack/ffprobe'),
    'ffprobe',
  ].find((candidate) => candidate && (candidate === 'ffprobe' || existsSync(candidate)));
  const probe = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', job.result.filePath,
  ], { encoding: 'utf8' });
  const probeResult = JSON.parse(probe.stdout || '{}');
  const streams = probeResult?.streams || [];
  if (probe.status !== 0 || !streams.some((stream) => stream.codec_type === 'audio')) {
    fail(`${platform.id} final file has no decodable audio stream`);
  }
  if (quality === 'audio') {
    if (streams.some((stream) => stream.codec_type === 'video')) {
      fail(`${platform.id} audio result still contains a video stream`);
    }
    const duration = Number(probeResult?.format?.duration || 0);
    if (MIN_AUDIO_DURATION > 0 && duration < MIN_AUDIO_DURATION) {
      fail(`${platform.id} audio duration ${duration.toFixed(1)}s is below ${MIN_AUDIO_DURATION}s`);
    }
    if (MIN_AUDIO_DURATION > 120 && duration <= 120) {
      fail(`${platform.id} audio was truncated at the former 120-second limit`);
    }
  } else {
    if (!streams.some((stream) => stream.codec_type === 'video')) {
      fail(`${platform.id} final file has no decodable video stream`);
    }
  }
  console.log(`OK download ${platform.id}: ${job.result.displayPath} (${Math.round(job.result.size / 1024 / 1024)} MB)`);
};

const main = async () => {
  if (ONLY && platforms.length === 0) fail(`Unknown SMOKE_ONLY platform: ${ONLY}`);
  const health = await fetch(`${BASE}/`, { headers: { 'X-VDX-Local-Request': '1' } }).catch(() => null);
  if (!health?.ok) fail(`Server not reachable at ${BASE}`);
  console.log(`Video Downloader QC -> ${BASE} (${DOWNLOAD ? AUDIO ? 'inspect + audio download' : 'inspect + video download' : 'inspect only'})\n`);

  let tested = 0;
  const failures = [];
  const skipped = [];
  for (const platform of platforms) {
    if (!platform.url) {
      console.log(`SKIP ${platform.id}: provide a live public URL through its SMOKE_* environment variable`);
      skipped.push(platform.id);
      continue;
    }
    try {
      const video = await inspect(platform);
      if (DOWNLOAD) await download(platform, video);
      tested += 1;
    } catch (error) {
      const message = error?.message || String(error);
      failures.push({ id: platform.id, message });
      console.error(`FAIL ${platform.id}: ${message}`);
    }
  }

  const downloads = await fetchJson('/api/downloader/downloads', {}, 30000);
  if (!downloads.response.ok || !Array.isArray(downloads.json?.items)) {
    fail(`downloads history: ${downloads.json?.error || downloads.response.status}`);
  }
  console.log(`\nPlatform summary: ${tested} passed, ${failures.length} failed, ${skipped.length} skipped; history items=${downloads.json.items.length}`);
  if (skipped.length) console.log(`Skipped: ${skipped.join(', ')}`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`- ${failure.id}: ${failure.message}`));
    process.exitCode = 1;
    return;
  }
  console.log('PASS: all configured platform checks completed successfully');
};

main().catch((error) => {
  console.error(`FAIL: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
