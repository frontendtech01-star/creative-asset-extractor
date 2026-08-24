import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const root = process.cwd();
const appPath = path.resolve(process.env.QC_APP_PATH || path.join(root, 'release/mac-arm64/Creative Asset Extractor.app'));
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-fonts-'));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-font-downloads-'));

const findExecutable = (dir) => {
  if (!fs.existsSync(dir)) return '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const chrome = path.join(full, 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(chrome)) return chrome;
      const nested = findExecutable(full);
      if (nested) return nested;
    }
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
  await page.type(input, 'https://www.tandemdiabetes.com/');
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
    const tab = [...document.querySelectorAll('button')].find((item) => /^Fonts(?:\s+\d+)?$/i.test(item.textContent?.trim() || ''));
    tab?.click();
  });
  await page.waitForSelector('[data-testid="font-card"]', { timeout: 30000 });
  const cards = await page.$$eval('[data-testid="font-card"]', (nodes) => nodes.map((node) => ({
    family: node.getAttribute('data-font-family') || '',
    url: node.getAttribute('data-font-url') || '',
  })));
  if (!cards.some((card) => /montserrat/i.test(card.family))) {
    throw new Error(`Packaged Tandem UI did not identify Montserrat: ${JSON.stringify(cards, null, 2)}`);
  }
  if (cards.some((card) => card.family === 'Website Font')) {
    throw new Error(`Packaged Tandem UI still contains generic font cards: ${JSON.stringify(cards, null, 2)}`);
  }
  if (new Set(cards.map((card) => card.url)).size !== cards.length) {
    throw new Error(`Packaged Tandem UI contains duplicate font URLs: ${JSON.stringify(cards, null, 2)}`);
  }
  console.log(`PASS packaged UI Tandem — ${cards.length} font card(s), Montserrat identified, no generic or duplicate cards`);
  console.log(JSON.stringify(cards, null, 2));
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
