import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const root = process.cwd();
const appPath = path.resolve(process.env.QC_APP_PATH || path.join(root, 'release/mac-arm64/Creative Asset Extractor.app'));
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const asarPath = path.join(resourcesPath, 'app.asar');
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-ui-'));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-ui-downloads-'));
const targets = process.env.QC_TARGET
  ? [{
      url: process.env.QC_TARGET,
      minimumVideos: Number(process.env.QC_MIN_VIDEOS || 1),
      exactVideos: process.env.QC_EXACT_VIDEOS ? Number(process.env.QC_EXACT_VIDEOS) : undefined,
      expectedUrl: process.env.QC_EXPECTED_VIDEO_URL || '',
    }]
  : [
      { url: 'https://vdx.tv/', minimumVideos: 1 },
      { url: 'https://miplyffa-hcp.com/resources/#video-popup', minimumVideos: 1 },
    ];

const findExecutable = (dir) => {
  if (!fs.existsSync(dir)) return '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'MacOS') {
        const chrome = path.join(full, 'Google Chrome for Testing');
        if (fs.existsSync(chrome)) return chrome;
      }
      const nested = findExecutable(full);
      if (nested) return nested;
    }
  }
  return '';
};

let serverProcess;
let browser;
try {
  execFileSync(path.join(root, 'node_modules/.bin/asar'), ['extract', asarPath, extractDir]);
  const appExecutable = path.join(appPath, 'Contents/MacOS/Creative Asset Extractor');
  const serverPath = path.join(extractDir, 'desktop/server.mjs');
  serverProcess = spawn(appExecutable, [serverPath], {
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
      const text = String(buffer);
      process.stdout.write(text);
      const match = text.match(/Server running on (http:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', (buffer) => process.stderr.write(String(buffer)));
    serverProcess.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Packaged server exited during startup (${code})`));
    });
  });
  const executablePath = findExecutable(path.join(resourcesPath, 'chromium')) || undefined;
  browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  for (const target of targets) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1200 });
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => {
      localStorage.setItem('vdx.responsibleUseAcknowledged.v1', 'yes');
      sessionStorage.clear();
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

    const input = 'input[placeholder^="https://example.com"]';
    await page.waitForSelector(input, { timeout: 30000 });
    await page.click(input);
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.type(input, target.url);
    const started = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Extract from Chrome'));
      button?.click();
      return Boolean(button);
    });
    if (!started) throw new Error(`Extract button missing for ${target.url}`);

    await page.waitForFunction(
      () => ![...document.querySelectorAll('button')].some((item) => item.textContent?.includes('Extracting')),
      { timeout: 240000, polling: 500 }
    );
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('button')].find((item) => /^Videos(?:\s+\d+)?$/i.test(item.textContent?.trim() || ''));
      tab?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const result = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('[data-testid="video-card"]')].map((card) => ({
        title: card.getAttribute('data-video-title'),
        embedded: card.getAttribute('data-video-embedded'),
        url: card.getAttribute('data-video-url'),
        hasPreview: Boolean(card.querySelector('img[alt$="video preview"]')),
        hasDownloadButton: Boolean([...card.querySelectorAll('button')].find((button) => /Download MP4/i.test(button.textContent || ''))),
        text: card.textContent?.trim().slice(0, 300),
      })),
      body: document.body?.innerText?.slice(-2500),
    }));
    if (result.cards.length < target.minimumVideos) {
      throw new Error(`${target.url} rendered ${result.cards.length} video cards\n${result.body}`);
    }
    if (target.exactVideos !== undefined && result.cards.length !== target.exactVideos) {
      throw new Error(`${target.url} rendered ${result.cards.length} video cards; expected exactly ${target.exactVideos}\n${JSON.stringify(result.cards, null, 2)}`);
    }
    if (target.expectedUrl && !result.cards.some((card) => card.url === target.expectedUrl)) {
      throw new Error(`${target.url} did not render expected video ${target.expectedUrl}\n${JSON.stringify(result.cards, null, 2)}`);
    }
    if (target.expectedUrl && !result.cards.some((card) => card.url === target.expectedUrl && card.hasPreview && card.hasDownloadButton)) {
      throw new Error(`${target.url} did not render the expected thumbnail and Download MP4 button\n${JSON.stringify(result.cards, null, 2)}`);
    }
    console.log(`PASS packaged UI ${target.url} — ${result.cards.length} visible video card(s)`);
    console.log(JSON.stringify(result.cards, null, 2));
    await page.close();
  }
} finally {
  await browser?.close().catch(() => undefined);
  serverProcess?.kill('SIGTERM');
  fs.rmSync(downloadsDir, { recursive: true, force: true });
}
