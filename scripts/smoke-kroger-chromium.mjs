const API = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PAGE = 'https://www.kroger.com/';

const response = await fetch(`${API}/api/browser-tabs/chrome/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
  body: JSON.stringify({ url: PAGE }),
  signal: AbortSignal.timeout(240000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || !payload?.ok) {
  throw new Error(payload?.error || `Kroger Chromium extraction failed (${response.status})`);
}
const images = [...(payload.images || []), ...(payload.icons || [])];
const fonts = Array.isArray(payload.fonts) ? payload.fonts : [];
const colors = Array.isArray(payload.colors) ? payload.colors : [];
const previewState = payload?.extractionMeta?.websitePreview === 'recovered' ? 'recovered' : 'live';
if (process.env.QC_REQUIRE_LIVE_KROGER === '1' && previewState !== 'live') {
  throw new Error('Kroger still rate-limited this network address; Chromium rendered the recovered preview instead of the live website');
}
if (images.length < 300) throw new Error(`Kroger Chromium workflow returned only ${images.length} images instead of the full website extraction`);
if (fonts.length !== 13) throw new Error(`Kroger Chromium workflow returned ${fonts.length} fonts instead of exactly 13`);
if (colors.length < 33) throw new Error(`Kroger Chromium workflow returned only ${colors.length} colors instead of the full palette`);
if (!images.some((image) => String(image?.url || '').includes('kroger_svg_logo'))) {
  throw new Error('Kroger Chromium workflow omitted the Kroger logo');
}
for (const image of images) {
  const expectedName = decodeURIComponent(new URL(image.url).pathname.split('/').pop() || '');
  if (String(image.filename || '') !== expectedName) {
    throw new Error(`Kroger image name mismatch: expected ${expectedName}, got ${image.filename || '(empty)'}`);
  }
}
for (const expectedWeight of ['400', '500', '700']) {
  if (!fonts.some((font) => font.family === 'Roboto' && String(font.weight) === expectedWeight)) {
    throw new Error(`Kroger Chromium workflow omitted exact Roboto ${expectedWeight} identity`);
  }
}

console.log(`PASS: Extract from Chrome rendered the ${previewState} Kroger website and returned ${images.length} images, ${fonts.length} fonts, and ${colors.length} colors`);
