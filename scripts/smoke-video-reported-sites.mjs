import WebSocket from 'ws';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const TIMEOUT_MS = Number(process.env.SMOKE_EXTRACT_MS || 180000);
const SITES = [
  'https://www.brinsupri.com/about-brinsupri/#moa-video',
  'https://www.brinsuprihcp.com/how-brinsupri-works/',
  'https://www.brinsuprihcp.com/efficacy-data/',
  'https://vdx.tv/',
  'https://miplyffa-hcp.com/resources/#video-popup',
  'https://www.massey.ac.nz/',
  'https://www.tandemdiabetes.com/',
];
const EXPECT_VIDEO = new Set([
  'https://www.brinsupri.com/about-brinsupri/#moa-video',
  'https://www.brinsuprihcp.com/how-brinsupri-works/',
  'https://vdx.tv/',
  'https://miplyffa-hcp.com/resources/#video-popup',
]);
const EXPECTED_VIDEO_ID = new Map([
  ['https://www.brinsupri.com/about-brinsupri/#moa-video', '1183479863'],
  ['https://www.brinsuprihcp.com/how-brinsupri-works/', '1097923504'],
]);

const waitForResult = (extractId) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/extract?extractId=${encodeURIComponent(extractId)}`);
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error(`Extraction timed out after ${TIMEOUT_MS}ms`));
  }, TIMEOUT_MS);

  socket.on('message', (buffer) => {
    const event = JSON.parse(String(buffer));
    if (event.type === 'complete') {
      clearTimeout(timer);
      resolve(event.result);
    } else if (event.type === 'error') {
      clearTimeout(timer);
      reject(new Error(event.message));
    }
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

let failed = false;
for (const url of SITES) {
  try {
    const response = await fetch(`${BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
      // Exercise the full-site workflow used by the desktop UI. A videos-only
      // request does not cover provider merging in the packaged application.
      body: JSON.stringify({ url }),
    });
    const initial = await response.json();
    if (!response.ok) throw new Error(initial.error || `HTTP ${response.status}`);
    const result = initial.async ? await waitForResult(initial.extractId) : initial;
    const videos = Array.isArray(result?.videos) ? result.videos : [];
    const invalid = videos.filter((video) => /\.webmanifest(?:[?#]|$)/i.test(String(video?.url || video?.sourceStreamUrl || '')));
    if (invalid.length) throw new Error('A web app manifest was returned as a video');
    const telemetry = videos.filter((video) => /google\.com\/g\/collect|google-analytics|googletagmanager|doubleclick/i.test(String(video?.url || video?.sourceStreamUrl || '')));
    if (telemetry.length) throw new Error('A tracking/telemetry request was returned as a video');
    if (EXPECT_VIDEO.has(url) && videos.length === 0) throw new Error('Expected at least one video');
    const expectedVideoId = EXPECTED_VIDEO_ID.get(url);
    if (expectedVideoId && !videos.some((video) => JSON.stringify(video).includes(expectedVideoId))) {
      throw new Error(`Expected Vimeo video ${expectedVideoId}`);
    }
    console.log(`PASS ${url} — ${videos.length} video(s)`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${url} — ${error.message}`);
  }
}

if (failed) process.exit(1);
