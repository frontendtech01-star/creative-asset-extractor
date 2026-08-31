import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const API = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PAGE = 'https://www.kroger.com/';

const response = await fetch(`${API}/api/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
  body: JSON.stringify({ url: PAGE, mode: 'static' }),
  signal: AbortSignal.timeout(120000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(payload?.error || `Kroger extraction failed (${response.status})`);

const images = Array.isArray(payload?.images) ? payload.images : [];
const fonts = Array.isArray(payload?.fonts) ? payload.fonts : [];
const colors = Array.isArray(payload?.colors) ? payload.colors.map((color) => String(color).toLowerCase()) : [];
const urls = images.map((image) => String(image?.url || '').toLowerCase());
if (images.length !== 17) throw new Error(`Kroger extraction returned ${images.length} images instead of exactly 17`);
if (!urls.some((url) => url.includes('kroger_svg_logo'))) {
  throw new Error('Kroger extraction omitted the first-party Kroger logo');
}
if (!urls.every((url) => url.startsWith('https://www.kroger.com/content/v2/binary/image/'))) {
  throw new Error('Kroger recovery returned an unexpected non-Kroger image URL');
}
if (fonts.length !== 3) throw new Error(`Kroger recovery returned ${fonts.length} fonts instead of the 3 exact declared faces`);
for (const expectedWeight of ['400', '500', '700']) {
  if (!fonts.some((font) => font.family === 'Roboto' && String(font.weight) === expectedWeight)) {
    throw new Error(`Kroger recovery omitted exact Roboto ${expectedWeight} identity`);
  }
}
for (const expectedColor of ['#0068b3', '#003b71', '#e31837']) {
  if (!colors.includes(expectedColor)) throw new Error(`Kroger extraction omitted brand color ${expectedColor}`);
}
if (colors.length !== 20) throw new Error(`Kroger extraction returned ${colors.length} colors instead of exactly 20`);

const colorCss = [
  ':root {',
  ...colors.map((color, index) => `  --kroger-color-${index + 1}: ${color};`),
  '}',
  '',
].join('\n');
const colorDataUrl = `data:text/plain;base64,${Buffer.from(colorCss).toString('base64')}`;
const imageItems = images.map((image, index) => ({
  url: image.url,
  originalUrl: image.url,
  assetType: 'image',
  preserveOriginal: true,
  filenameBase: `kroger-image-${index + 1}`,
  filename: image.filename || `kroger-image-${index + 1}`,
  status: image.status || 'available',
}));
const fontItems = fonts.map((font, index) => ({
  url: font.url,
  originalUrl: font.url,
  assetType: 'font',
  filenameBase: `${font.family || 'Kroger-font'}-${font.weight || index + 1}`,
  filename: `${font.family || 'Kroger-font'}-${font.weight || index + 1}.${font.format || 'ttf'}`,
  fontFamily: font.family || `Kroger font ${index + 1}`,
  fontWeight: font.weight || '400',
  fontStyle: font.style || 'normal',
  status: font.status || 'available',
}));
const colorItem = {
  url: colorDataUrl,
  originalUrl: PAGE,
  assetType: 'color',
  filename: 'kroger-colors.css',
  filenameBase: 'kroger-colors',
  status: 'available',
};

const zipResponse = await fetch(`${API}/api/download-zip`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
  body: JSON.stringify({
    items: [...imageItems, ...fontItems, colorItem],
    save: true,
    filename: 'kroger-all-assets.zip',
    sourcePageUrl: PAGE,
  }),
  signal: AbortSignal.timeout(360000),
});
const zipPayload = await zipResponse.json().catch(() => ({}));
if (!zipResponse.ok) throw new Error(zipPayload?.error || `Kroger all-assets ZIP failed (${zipResponse.status})`);
const zipPath = String(zipPayload?.downloadPath || zipPayload?.localPath || '');
if (!zipPath || !existsSync(zipPath)) throw new Error('Kroger all-assets ZIP was not saved');
if (Number(zipPayload?.failedCount || 0) > 0) {
  throw new Error(`Kroger all-assets ZIP had ${zipPayload.failedCount} failed downloads`);
}
if (Number(zipPayload?.addedCount || 0) !== imageItems.length + fontItems.length + 1) {
  throw new Error(`Kroger ZIP entry count mismatch: expected ${imageItems.length + fontItems.length + 1}, got ${zipPayload?.addedCount}`);
}
const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
if (listing.status !== 0) throw new Error(`Could not inspect Kroger ZIP: ${listing.stderr || listing.stdout}`);
const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
if (!entries.some((entry) => /kroger-colors/i.test(entry))) throw new Error('Kroger ZIP omitted the color palette');
if (entries.filter((entry) => /\.(?:svg|png|jpe?g|webp|gif|avif)$/i.test(entry)).length !== imageItems.length) {
  throw new Error('Kroger ZIP did not contain every extracted image');
}
if (fontItems.length > 0 && entries.filter((entry) => /\.(?:woff2?|ttf|otf|eot)$/i.test(entry)).length < fontItems.length) {
  throw new Error('Kroger ZIP did not contain every extracted font');
}

console.log(`PASS: Kroger extracted and downloaded all assets (${images.length} images, ${fonts.length} fonts, ${colors.length} colors; ${entries.length} ZIP entries)`);
