/**
 * Video Downloader QC for the isolated /api/downloader routes.
 *
 * Inspect only:
 *   node scripts/smoke-video-downloader.mjs
 *
 * Inspect and download:
 *   SMOKE_DOWNLOAD=1 node scripts/smoke-video-downloader.mjs
 *
 * Add live public Instagram/Facebook examples with:
 *   SMOKE_INSTAGRAM_REEL_URL=...
 *   SMOKE_INSTAGRAM_POST_URL=...
 *   SMOKE_FACEBOOK_VIDEO_URL=...
 *   SMOKE_FACEBOOK_REEL_URL=...
 */
const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const DOWNLOAD = process.env.SMOKE_DOWNLOAD === '1';
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
];

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
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
  const quality = video?.qualityVariants?.fhd?.formatAvailable ? 'fhd' : 'hd';
  const started = await fetchJson('/api/downloader/download', {
    method: 'POST',
    body: JSON.stringify({ url: video.url || platform.url, title: video.title, quality }),
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
    method: 'HEAD',
    headers: { 'X-VDX-Local-Request': '1' },
  });
  if (!file.ok) fail(`${platform.id} completed file link returned ${file.status}`);
  console.log(`OK download ${platform.id}: ${job.result.displayPath} (${Math.round(job.result.size / 1024 / 1024)} MB)`);
};

const main = async () => {
  const health = await fetch(`${BASE}/`, { headers: { 'X-VDX-Local-Request': '1' } }).catch(() => null);
  if (!health?.ok) fail(`Server not reachable at ${BASE}`);
  console.log(`Video Downloader QC -> ${BASE} (${DOWNLOAD ? 'inspect + download' : 'inspect only'})\n`);

  let tested = 0;
  for (const platform of platforms) {
    if (!platform.url) {
      console.log(`SKIP ${platform.id}: provide a live public URL through its SMOKE_* environment variable`);
      continue;
    }
    const video = await inspect(platform);
    if (DOWNLOAD) await download(platform, video);
    tested += 1;
  }

  const downloads = await fetchJson('/api/downloader/downloads', {}, 30000);
  if (!downloads.response.ok || !Array.isArray(downloads.json?.items)) {
    fail(`downloads history: ${downloads.json?.error || downloads.response.status}`);
  }
  console.log(`\nPASS: ${tested} platform inspections; history items=${downloads.json.items.length}`);
};

main().catch((error) => fail(error?.message || String(error)));
