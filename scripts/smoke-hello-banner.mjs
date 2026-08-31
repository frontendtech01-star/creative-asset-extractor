import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const baseUrl = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const screenshotPath = path.join(os.tmpdir(), 'creative-asset-extractor-hello-banner.png');
const browser = await puppeteer.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => {
    localStorage.setItem('vdx.responsibleUseAcknowledged.v1', 'yes');
    localStorage.setItem('vdx.extractSession.v1', JSON.stringify({
      url: 'https://example.com/',
      extractedUrl: 'https://example.com/',
      activeTab: 'images',
      assets: { images: [{ url: 'https://example.com/test.png' }], icons: [], fonts: [], videos: [], colors: [] },
      savedAt: Date.now(),
    }));
  });
  await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const result = await page.evaluate(() => {
    const banner = document.querySelector('.material-welcome');
    const wordmark = document.querySelector('.greeting-hello-wordmark svg');
    const rect = banner?.getBoundingClientRect();
    const wordmarkRect = wordmark?.getBoundingClientRect();
    return {
      bannerVisible: Boolean(rect && rect.width > 400 && rect.height > 80),
      wordmarkVisible: Boolean(wordmarkRect && wordmarkRect.width > 80 && wordmarkRect.height > 20),
      hasBluePath: wordmark?.querySelector('path')?.getAttribute('fill') === '#2563EB',
    };
  });
  if (!result.bannerVisible || !result.wordmarkVisible || !result.hasBluePath) {
    throw new Error(`Hello banner failed visual smoke: ${JSON.stringify(result)}`);
  }
  await page.click('button[title^="Menu"]');
  const menuAlignment = await page.evaluate(() => {
    const header = document.querySelector('header');
    const menu = Array.from(document.querySelectorAll('div.absolute')).find((element) =>
      element.textContent?.includes('Latest Release Notes')
    );
    const headerRect = header?.getBoundingClientRect();
    const menuRect = menu?.getBoundingClientRect();
    return {
      edgeDelta: headerRect && menuRect ? Math.abs(menuRect.top - headerRect.bottom) : 999,
      rightInset: menuRect ? Math.round(window.innerWidth - menuRect.right) : -1,
    };
  });
  if (menuAlignment.edgeDelta > 1) {
    throw new Error(`App menu is not flush with the header edge: ${JSON.stringify(menuAlignment)}`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: false });
  if (!fs.existsSync(screenshotPath)) throw new Error('Hello banner screenshot was not written');
  console.log(`PASS: Hello banner visible and app menu aligned to header edge (${screenshotPath})`);
} finally {
  await browser.close();
}
