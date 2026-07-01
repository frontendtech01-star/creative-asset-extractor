import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const TARGET_URL = process.env.SMOKE_VIDEO_UI_URL || 'https://exxuahcp.com/savings';
const projectRoot = process.cwd();

const fail = (message, details) => {
  console.error(`FAIL: ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
  process.exit(1);
};

const waitForText = async (page, text, timeout = 90000) => {
  try {
    await page.waitForFunction(
      (needle) => document.body?.innerText?.includes(needle),
      { timeout },
      text
    );
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    fail(`Timed out waiting for "${text}"`, { bodyText });
  }
};

const clickButtonByText = async (page, text) => {
  const clicked = await page.evaluate((needle) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((candidate) => candidate.textContent?.includes(needle));
    if (!button) return false;
    button.click();
    return true;
  }, text);
  if (!clicked) fail(`Could not click button containing "${text}"`);
};

const findExecutable = (root) => {
  if (!fs.existsSync(root)) return '';
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findExecutable(full);
      if (nested) return nested;
    } else if (
      entry.name === 'Google Chrome for Testing' ||
      entry.name === 'Google Chrome' ||
      entry.name === 'Chromium' ||
      entry.name === 'chrome' ||
      entry.name === 'chrome.exe'
    ) {
      return full;
    }
  }
  return '';
};

const executablePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  findExecutable(path.join(projectRoot, 'vendor', 'chromium-pack')),
  findExecutable(path.join(projectRoot, 'vendor', 'chromium')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((candidate) => candidate && fs.existsSync(candidate));

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  ...(executablePath ? { executablePath } : {}),
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('vdx.responsibleUseAcknowledged.v1', 'yes');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

  const websiteUrlInputSelector = 'input[placeholder^="https://example.com"]';
  await page.waitForSelector(websiteUrlInputSelector, { timeout: 30000 });
  await page.click(websiteUrlInputSelector);
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.type(websiteUrlInputSelector, TARGET_URL);
  await clickButtonByText(page, 'Extract From Open Website');
  await page.waitForFunction(
    () =>
      document.body?.innerText?.includes('Extract complete') ||
      document.body?.innerText?.includes('Bulk Download Extracted Videos') ||
      /Videos\s+\d+/i.test(document.body?.innerText || ''),
    { timeout: 120000 }
  ).catch(async () => {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
    fail('Timed out waiting for extraction UI to finish', { bodyText });
  });

  await clickButtonByText(page, 'Videos');
  await waitForText(page, 'Bulk Download Extracted Videos', 30000);

  const result = await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const cards = Array.from(document.querySelectorAll('[data-testid="video-card"]'))
      .filter(visible)
      .map((card) => ({
        title: card.getAttribute('data-video-title') || '',
        embedded: card.getAttribute('data-video-embedded') || '',
        text: card.textContent || '',
      }));
    const bodyText = document.body?.innerText || '';
    return { cards, bodyText };
  });

  const unwantedPattern = /(?:\bswatch\b|publicApi|captions\.js|interFontFace|playPauseLoadingControl|hls_video|\/assets\/external\/x\b|^x$|\bmput\b|193d1b85787a70c44f4b0ede1967e369|b2sw1djdxd\.m3u8)/i;
  const unwantedCards = result.cards.filter((card) => unwantedPattern.test(`${card.title}\n${card.text}`));
  if (unwantedCards.length > 0) fail('Unwanted player cards are visible in the UI', unwantedCards);

  const realCards = result.cards.filter((card) => /Aytu-Rebrand_Patients_Epipheo_FINAL/i.test(card.title));
  if (result.cards.length !== 2 || realCards.length !== 2) {
    fail('Expected exactly 2 visible real Wistia video cards in the UI', result.cards);
  }
  if (result.cards.some((card) => card.embedded === 'true')) {
    fail('Unexpected embedded placeholder card is visible in the UI', result.cards);
  }

  console.log(`OK: UI video grid shows ${result.cards.length} real Wistia cards and no unwanted players`);
} finally {
  await browser.close().catch(() => undefined);
}
