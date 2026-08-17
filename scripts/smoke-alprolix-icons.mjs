const API = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PAGE = 'https://www.alprolix.com/us/safety';

const response = await fetch(`${API}/api/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
  body: JSON.stringify({ url: PAGE, mode: 'static' }),
  signal: AbortSignal.timeout(120000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(payload?.error || `Alprolix extraction failed (${response.status})`);

const icons = Array.isArray(payload?.icons) ? payload.icons : [];
const images = Array.isArray(payload?.images) ? payload.images : [];
const iconUrls = icons.map((icon) => String(icon?.url || '').toLowerCase());
const galleryUrls = images.map((image) => String(image?.url || '').toLowerCase());
const expectedSafetyIcons = ['warning.png0', 'allergic-reaction-hand.png', 'hub.png0', 'water_drop.png0'];
for (const expected of expectedSafetyIcons) {
  if (!iconUrls.some((url) => url.includes(expected))) {
    throw new Error(`Alprolix icon extraction omitted ${expected}`);
  }
  if (!galleryUrls.some((url) => url.includes(expected))) {
    throw new Error(`Alprolix merged image gallery omitted ${expected}`);
  }
}

console.log(`PASS: Alprolix extracted and displayed all ${expectedSafetyIcons.length} safety-card icons (${icons.length} icons total)`);
