import puppeteer from 'puppeteer';

const appUrl = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const target = 'https://vdx.tv/';
let browser;

const response = await fetch(`${appUrl}/api/extract`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-VDX-Local-Request': '1',
  },
  body: JSON.stringify({ url: target, mode: 'static' }),
});
const assets = await response.json();
if (!response.ok || !Array.isArray(assets?.images) || assets.images.length < 20) {
  throw new Error(`vdx.tv extraction returned ${assets?.images?.length || 0} images`);
}

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((payload) => {
    localStorage.setItem('vdx.responsibleUseAcknowledged.v1', 'yes');
    localStorage.setItem('vdx.websiteExtractionSession.v1', JSON.stringify(payload));
  }, {
    url: target,
    extractedUrl: target,
    assets,
    activeTab: 'images',
    completion: null,
    savedAt: Date.now(),
  });
  await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('[data-testid="image-card"]', { timeout: 30000 });
  await page.evaluate(async () => {
    for (let top = 0; top < document.documentElement.scrollHeight; top += 800) {
      window.scrollTo(0, top);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('[data-testid="image-card"]')];
      return ['svg', 'jpg', 'avif'].every((format) => {
        const card = cards.find((candidate) => new RegExp(`\\.${format}(?:[?#]|$)`, 'i').test(candidate.getAttribute('data-image-url') || ''));
        const image = card?.querySelector('img');
        return card?.querySelector('[data-thumbnail-phase="ready"]') && (image?.naturalWidth || 0) > 0 && (image?.naturalHeight || 0) > 0;
      });
    },
    { timeout: 60000, polling: 250 },
  );

  const result = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="image-card"]')];
    const formats = ['svg', 'jpg', 'avif'];
    const samples = Object.fromEntries(formats.map((format) => {
      const card = cards.find((candidate) => new RegExp(`\\.${format}(?:[?#]|$)`, 'i').test(candidate.getAttribute('data-image-url') || ''));
      const image = card?.querySelector('img');
      return [format, {
        found: Boolean(card),
        phase: card?.querySelector('[data-thumbnail-phase]')?.getAttribute('data-thumbnail-phase') || '',
        width: image?.naturalWidth || 0,
        height: image?.naturalHeight || 0,
      }];
    }));
    return {
      cards: cards.length,
      ready: cards.filter((card) => card.querySelector('[data-thumbnail-phase="ready"]')).length,
      samples,
    };
  });

  for (const [format, sample] of Object.entries(result.samples)) {
    if (!sample.found) throw new Error(`vdx.tv ${format.toUpperCase()} fixture is missing`);
    if (sample.phase !== 'ready' || sample.width <= 0 || sample.height <= 0) {
      throw new Error(`vdx.tv ${format.toUpperCase()} preview is blank: ${JSON.stringify(sample)}`);
    }
  }
  console.log(`PASS vdx.tv thumbnails — ${result.ready}/${result.cards} ready; SVG, JPG, and AVIF previews decoded`);
} finally {
  await browser?.close().catch(() => undefined);
}
