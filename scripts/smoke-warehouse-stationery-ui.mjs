import puppeteer from 'puppeteer';

const appUrl = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const target = String(process.env.QC_TARGET || 'https://www.warehousestationery.co.nz/back-to-school');
const minimumImages = Number(process.env.QC_MIN_IMAGES || 100);
const siteLabel = /tandemdiabetes/i.test(target) ? 'Tandem Diabetes' : 'Warehouse Stationery';
let browser;

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => localStorage.setItem('vdx.responsibleUseAcknowledged.v1', 'yes'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

  const input = 'input[placeholder^="https://example.com"]';
  await page.waitForSelector(input, { timeout: 30000 });
  await page.type(input, target);
  const started = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Extract from Chrome'));
    button?.click();
    return Boolean(button);
  });
  if (!started) throw new Error('Extract from Chrome button missing');
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((item) => item.textContent?.includes('Extracting')),
    { timeout: 240000, polling: 500 }
  );
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button')].find((item) => /^Images(?:\s+\d+)?$/i.test(item.textContent?.trim() || ''));
    tab?.click();
  });
  await page.waitForSelector('[data-testid="image-card"]', { timeout: 30000 });
  const initialCount = await page.$$eval('[data-testid="image-card"]', (nodes) => nodes.length);
  await page.evaluate(async () => {
    for (let top = 0; top < document.documentElement.scrollHeight; top += 900) {
      window.scrollTo(0, top);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  });
  const previewStartedAt = Date.now();
  await page.waitForFunction(
    () => {
      const cards = document.querySelectorAll('[data-testid="image-card"]').length;
      const ready = document.querySelectorAll('[data-testid="image-card"] [data-thumbnail-phase="ready"]').length;
      return cards > 0 && ready >= cards - 1;
    },
    { timeout: 30000, polling: 250 }
  ).catch(() => undefined);
  const result = await page.evaluate(() => ({
    count: document.querySelectorAll('[data-testid="image-card"]').length,
    ready: document.querySelectorAll('[data-testid="image-card"] [data-thumbnail-phase="ready"]').length,
    urls: [...document.querySelectorAll('[data-testid="image-card"]')].map((node) => node.getAttribute('data-image-url') || ''),
    missing: [...document.querySelectorAll('[data-testid="image-card"]')]
      .filter((node) => node.querySelector('[data-thumbnail-phase="ready"]') === null)
      .map((node) => ({
        url: node.getAttribute('data-image-url') || '',
        phase: node.querySelector('[data-thumbnail-phase]')?.getAttribute('data-thumbnail-phase') || '',
      })),
  }));
  if (initialCount < minimumImages || result.count < minimumImages) {
    throw new Error(`${siteLabel} UI image cards collapsed from ${initialCount} to ${result.count}`);
  }
  if (/warehousestationery/i.test(target) && !result.urls.some((url) => /wsl_logo_desktop\.svg/i.test(url))) {
    throw new Error('Warehouse Stationery logo card is missing');
  }
  if (result.ready < minimumImages) throw new Error(`Only ${result.ready} ${siteLabel} image previews rendered out of ${result.count} cards`);
  if (/tandemdiabetes/i.test(target) && result.ready < result.count - 1) {
    throw new Error(`${siteLabel} left ${result.count - result.ready} image cards without previews: ${JSON.stringify(result.missing)}`);
  }
  console.log(`PASS local UI ${siteLabel} — ${result.count} cards, ${result.ready} rendered previews in ${Date.now() - previewStartedAt}ms`);
} finally {
  await browser?.close().catch(() => undefined);
}
