const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const TEST_URL =
  'https://storage.googleapis.com/gweb-uniblog-publish-prod/original_videos/Contextual_Search_on_LR_YT.mp4';
const EXPECTED_FILENAME = 'Contextual_Search_on_LR_YT.mp4';

const headers = { 'X-VDX-Local-Request': '1' };

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const ok = (message) => {
  console.log(`OK: ${message}`);
};

const main = async () => {
  const resolveRes = await fetch(`${BASE}/api/resolve-video?url=${encodeURIComponent(TEST_URL)}`, { headers });
  const resolveData = await resolveRes.json();
  if (!resolveRes.ok || !resolveData?.video?.url) {
    fail(`resolve-video failed (${resolveRes.status}): ${resolveData?.error || 'missing video payload'}`);
  }

  const video = resolveData.video;
  if (String(video.url).includes('localhost') || String(video.url).includes('/api/download?')) {
    fail(`resolve-video exposed proxy URL: ${video.url}`);
  }
  if (video.url !== TEST_URL) {
    fail(`resolve-video did not preserve source URL: ${video.url}`);
  }
  if (video.localFilename !== EXPECTED_FILENAME) {
    fail(`unexpected filename: ${video.localFilename}`);
  }
  if (!video.height || video.height < 720) {
    fail(`expected video height metadata, got ${video.height}`);
  }
  if (video.displayQualityKey !== 'fhd' && video.height >= 1080) {
    fail(`expected FHD quality key for 1080p asset, got ${video.displayQualityKey}`);
  }
  ok(`resolve-video returned direct URL with ${video.height}p (${video.displayQualityLabel})`);

  const fetchRes = await fetch(
    `${BASE}/api/fetch-direct-video?url=${encodeURIComponent(TEST_URL)}&filename=${encodeURIComponent(EXPECTED_FILENAME)}`,
    { headers }
  );
  if (!fetchRes.ok) {
    fail(`fetch-direct-video failed (${fetchRes.status})`);
  }
  const bytes = Buffer.from(await fetchRes.arrayBuffer());
  if (bytes.length < 100 * 1024) {
    fail(`fetch-direct-video returned too few bytes (${bytes.length})`);
  }
  if (bytes.slice(4, 8).toString() !== 'ftyp') {
    fail('fetch-direct-video payload is not a valid MP4');
  }
  ok(`fetch-direct-video returned ${bytes.length} byte MP4`);

  console.log('PASS: direct video smoke test');
};

main().catch((error) => fail(error?.message || String(error)));
