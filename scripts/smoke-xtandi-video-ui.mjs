import puppeteer from 'puppeteer';

const appUrl = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const target = 'https://www.xtandi.com/patient-videos/jims-journey';
let browser;

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
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
    const tab = [...document.querySelectorAll('button')].find((item) => /^Videos(?:\s+\d+)?$/i.test(item.textContent?.trim() || ''));
    tab?.click();
  });
  await page.waitForSelector('[data-testid="video-card"]', { timeout: 30000 });
  const cards = await page.$$eval('[data-testid="video-card"]', (nodes) => nodes.map((node) => ({
    url: node.getAttribute('data-video-url') || '',
    title: node.getAttribute('data-video-title') || '',
    embedded: node.getAttribute('data-video-embedded') || '',
  })));
  if (cards.length !== 1) throw new Error(`Expected one Xtandi video card, got ${JSON.stringify(cards)}`);
  if (!/streams\.bitmovin\.com\/cvrub3qpb3clk0so01n0\/manifest\.m3u8/i.test(cards[0].url)) {
    throw new Error(`Xtandi UI card did not use the master manifest: ${JSON.stringify(cards)}`);
  }
  if (cards[0].embedded !== 'false') throw new Error(`Xtandi HLS card was incorrectly treated as embedded: ${JSON.stringify(cards)}`);
  console.log(`PASS local UI Xtandi — one direct Bitmovin HLS card (${cards[0].url})`);
} finally {
  await browser?.close().catch(() => undefined);
}
