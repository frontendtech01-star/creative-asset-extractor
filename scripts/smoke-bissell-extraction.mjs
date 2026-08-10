const API = process.env.QC_API || 'http://127.0.0.1:3000';
const PAGE = 'https://www.bissell.com/';

const response = await fetch(`${API}/api/extract`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-VDX-Local-Request': '1',
  },
  body: JSON.stringify({ url: PAGE, crawlMode: 'deep' }),
  signal: AbortSignal.timeout(180000),
});

const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(payload?.error || `Bissell extraction failed (${response.status})`);
if (payload?.async) throw new Error('Bissell extraction unexpectedly returned without completed assets');

const images = Array.isArray(payload?.images) ? payload.images : [];
const fonts = Array.isArray(payload?.fonts) ? payload.fonts : [];
const realImages = images.filter((image) =>
  /^https?:\/\//i.test(String(image?.url || '')) &&
  /(?:bissell|contentstack|cloudfront)/i.test(String(image?.url || ''))
);
const fontFamilies = new Set(fonts.map((font) => String(font?.family || '').toLowerCase()));

if (realImages.length < 10) throw new Error(`Expected at least 10 Bissell images, got ${realImages.length}`);
if (fonts.length < 5) throw new Error(`Expected at least 5 Bissell fonts, got ${fonts.length}`);
if (![...fontFamilies].some((family) => family.includes('montserrat'))) {
  throw new Error('Bissell extraction omitted Montserrat');
}
if (![...fontFamilies].some((family) => family.includes('termina'))) {
  throw new Error('Bissell extraction omitted Termina');
}

console.log(`PASS: Bissell extracted ${realImages.length} real images and ${fonts.length} fonts without a false bot-wall error`);
