import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const root = process.cwd();
const appPath = path.resolve(process.env.QC_APP_PATH || path.join(root, 'release/mac-arm64/Creative Asset Extractor.app'));
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-warehouse-'));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-warehouse-downloads-'));
const target = String(process.env.QC_TARGET || 'https://www.warehousestationery.co.nz/back-to-school');
const minimumImages = Number(process.env.QC_MIN_IMAGES || 100);
const siteLabel = /tandemdiabetes/i.test(target) ? 'Tandem Diabetes' : 'Warehouse Stationery';

const findExecutable = (dir) => {
  if (!fs.existsSync(dir)) return '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const chrome = path.join(full, 'MacOS', 'Google Chrome for Testing');
    if (fs.existsSync(chrome)) return chrome;
    const nested = findExecutable(full);
    if (nested) return nested;
  }
  return '';
};

let serverProcess;
let browser;
try {
  execFileSync(path.join(root, 'node_modules/.bin/asar'), ['extract', path.join(resourcesPath, 'app.asar'), extractDir]);
  const appExecutable = path.join(appPath, 'Contents/MacOS/Creative Asset Extractor');
  serverProcess = spawn(appExecutable, [path.join(extractDir, 'desktop/server.mjs')], {
    cwd: extractDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      VDX_APP_ROOT: extractDir,
      VDX_RESOURCES_PATH: resourcesPath,
      CAE_DOWNLOADS_DIR: downloadsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged server startup timed out')), 30000);
    const onData = (buffer) => {
      const output = String(buffer);
      process.stdout.write(output);
      const match = output.match(/Server running on (http:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', (buffer) => process.stderr.write(String(buffer)));
    serverProcess.on('exit', (code) => reject(new Error(`Packaged server exited during startup (${code})`)));
  });
  browser = await puppeteer.launch({
    headless: true,
    executablePath: findExecutable(path.join(resourcesPath, 'chromium')) || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
  }));
  if (result.count < minimumImages) throw new Error(`Packaged ${siteLabel} UI rendered only ${result.count} image cards`);
  if (result.ready < minimumImages) throw new Error(`Packaged ${siteLabel} UI rendered only ${result.ready} previews out of ${result.count} cards`);
  if (/tandemdiabetes/i.test(target) && result.ready < result.count - 1) {
    throw new Error(`Packaged ${siteLabel} left ${result.count - result.ready} image cards without previews`);
  }
  if (/warehousestationery/i.test(target) && !result.urls.some((url) => /wsl_logo_desktop\.svg/i.test(url))) {
    throw new Error('Warehouse logo card is missing');
  }
  console.log(`PASS packaged UI ${siteLabel} — ${result.count} cards, ${result.ready} rendered previews in ${Date.now() - previewStartedAt}ms`);
} finally {
  await browser?.close().catch(() => undefined);
  if (serverProcess?.pid) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
  }
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
}
