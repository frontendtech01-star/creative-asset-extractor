import WebSocket from 'ws';

const API = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PAGE = 'https://www.warehousestationery.co.nz/back-to-school';

const waitForAsyncResult = (extractId) => new Promise((resolve, reject) => {
  const wsUrl = `${API.replace(/^http/i, 'ws')}/ws/extract?extractId=${encodeURIComponent(extractId)}`;
  const ws = new WebSocket(wsUrl, { headers: { 'X-VDX-Local-Request': '1' } });
  const timeout = setTimeout(() => {
    ws.terminate();
    reject(new Error('Warehouse Stationery browser extraction timed out'));
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
      reject(new Error(event.message || 'Warehouse Stationery extraction failed'));
    }
  });
  ws.on('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

const response = await fetch(`${API}/api/extract`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-VDX-Local-Request': '1',
  },
  body: JSON.stringify({ url: PAGE, crawlMode: 'deep' }),
  signal: AbortSignal.timeout(180000),
});

let payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(payload?.error || `Warehouse Stationery extraction failed (${response.status})`);
if (payload?.async) payload = await waitForAsyncResult(String(payload.extractId || ''));

const images = Array.isArray(payload?.images) ? payload.images : [];
const fonts = Array.isArray(payload?.fonts) ? payload.fonts : [];
const videos = Array.isArray(payload?.videos) ? payload.videos : [];
const realImages = images.filter((image) =>
  /^https?:\/\//i.test(String(image?.url || '')) &&
  /(?:warehousestationery\.co\.nz|dynamicyield\.com)/i.test(String(image?.url || ''))
);
const realFonts = fonts.filter((font) =>
  /^https?:\/\//i.test(String(font?.url || '')) &&
  /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(String(font?.url || ''))
);

const requiredAssetPaths = [
  '/on/demandware.static/-/Library-Sites-wsl-shared-library/default/dw33120018/logos/wsl_logo_desktop.svg',
  '/on/demandware.static/-/Library-Sites-wsl-shared-library/default/dw757e8e85/fy-26/MTEs/bts/icons/wsl-bts-nav-exercise-150x150px.png',
];

if (realImages.length < 20) throw new Error(`Expected at least 20 Warehouse Stationery images, got ${realImages.length}`);
if (realFonts.length < 1) throw new Error(`Expected at least one Warehouse Stationery font, got ${realFonts.length}`);
for (const requiredPath of requiredAssetPaths) {
  if (!images.some((image) => String(image?.url || '').includes(requiredPath))) {
    throw new Error(`Missing required Warehouse Stationery asset: ${requiredPath}`);
  }
}
if (videos.some((video) => /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(String(video?.url || '')))) {
  throw new Error('Image assets were incorrectly classified as videos');
}

console.log(`PASS: Warehouse Stationery extracted ${realImages.length} images, ${realFonts.length} fonts, and ${videos.length} videos`);
