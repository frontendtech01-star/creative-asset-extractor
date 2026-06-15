import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSmokeOutDir } from './lib/smoke-out-dir.mjs';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const YOUTUBE_URL = process.env.SMOKE_YOUTUBE_URL || 'https://www.youtube.com/watch?v=jhRoOonf58I';
const OUT_DIR = resolveSmokeOutDir('no-duplicate', YOUTUBE_URL);
const REPORT_PATH = path.join(OUT_DIR, 'report.json');

const fetchJson = async (pathName, init = {}, timeoutMs = 120000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API}${pathName}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-VDX-Local-Request': '1',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const headMerge = async (watchUrl, quality) => {
  const query = new URLSearchParams({
    url: watchUrl,
    quality,
    inline: '0',
    filename: `${quality.toUpperCase()}.mp4`,
  });
  const response = await fetch(`${API}/api/youtube-merged-stream?${query}`, {
    method: 'HEAD',
    headers: { 'X-VDX-Local-Request': '1' },
  });
  return {
    ok: response.ok,
    status: response.status,
    contentLength: Number(response.headers.get('content-length') || 0),
  };
};

const run = async () => {
  const startedAt = Date.now();
  const report = {
    ok: false,
    youtubeUrl: YOUTUBE_URL,
    outDir: OUT_DIR,
    checks: {},
    errors: [],
  };

  try {
    const extractOnce = await fetchJson('/api/extract', {
      method: 'POST',
      body: JSON.stringify({ url: YOUTUBE_URL, extractionMode: 'full' }),
    });
    report.checks.extractVideoCount = Array.isArray(extractOnce.videos) ? extractOnce.videos.length : 0;
    report.checks.extractRoute = extractOnce.extractionMeta?.route || '';
    if (report.checks.extractVideoCount !== 1) {
      throw new Error(`Expected 1 video card, got ${report.checks.extractVideoCount}`);
    }

    const manifest = await fetchJson(
      `/api/video-quality-manifest?url=${encodeURIComponent(YOUTUBE_URL)}`
    );
    report.checks.manifestFhd = Boolean(manifest.fhd);
    report.checks.manifestHd = Boolean(manifest.hd);

    const fhdHead = await headMerge(YOUTUBE_URL, 'fhd');
    report.checks.fhdHeadOk = fhdHead.ok;
    report.checks.fhdContentLength = fhdHead.contentLength;
    if (!fhdHead.ok || fhdHead.contentLength <= 0) {
      throw new Error(`FHD merge HEAD failed (${fhdHead.status})`);
    }

    report.ok = true;
  } catch (error) {
    report.errors.push(error?.message || String(error));
  }

  report.elapsedMs = Date.now() - startedAt;
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    console.error('SMOKE FAIL', report.errors.join('; '));
    process.exit(1);
  }
  console.log('SMOKE PASS', REPORT_PATH);
};

run();
