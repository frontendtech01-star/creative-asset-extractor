import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const API = process.env.SMOKE_API_URL || 'http://127.0.0.1:3000';
const PAGE = 'https://www.fordham.edu/academics/research/';
const execFileAsync = promisify(execFile);

const extract = await fetch(`${API}/api/extract`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: PAGE, siteProfile: 'normal' }),
});
const payload = await extract.json();
if (!extract.ok) throw new Error(payload?.error || `Fordham extraction failed (${extract.status})`);

const fonts = Array.isArray(payload?.fonts) ? payload.fonts : [];
const expected = [
  ['commuters sans', '600'],
  ['owners narrow', '500'],
  ['owners wide', '900'],
  ['modern gothic', '400'],
  ['modern gothic', '500'],
  ['modern gothic', '600'],
  ['modern gothic', '700'],
];
for (const [family, weight] of expected) {
  if (!fonts.some((font) => String(font?.family || '').toLowerCase() === family && String(font?.weight || '') === weight)) {
    throw new Error(`Missing Fordham font: ${family} (${weight})`);
  }
}

const testConversions = [
  fonts.find((font) => String(font?.family || '').toLowerCase() === 'commuters sans'),
  fonts.find((font) => String(font?.family || '').toLowerCase() === 'modern gothic'),
];
for (const font of testConversions) {
  if (!font?.url) throw new Error('Fordham conversion source was not found');
  const query = new URLSearchParams({
    url: String(font.url),
    toFormat: 'ttf',
    originalFormat: String(font.format || 'woff2'),
    filenameBase: `${font.family}-${font.weight || 'regular'}`,
    fontFamily: String(font.family || ''),
    fontWeight: String(font.weight || ''),
    fontStyle: String(font.style || 'normal'),
    sourcePageUrl: PAGE,
  });
  const response = await fetch(`${API}/api/convert-font?${query}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${font.family} conversion failed (${response.status}): ${buffer.toString('utf8').slice(0, 300)}`);
  const sfnt = buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0;
  const magic = buffer.subarray(0, 4).toString('latin1');
  if (!sfnt && !['OTTO', 'true'].includes(magic)) throw new Error(`${font.family} did not produce a valid TTF`);
}

const safePart = (value) => String(value || 'font').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'font';
const items = fonts.flatMap((font) => ['woff', 'ttf'].map((toFormat) => ({
  url: String(font.url),
  originalUrl: String(font.url),
  cssSource: String(font.cssSource || ''),
  fontFamily: String(font.family || ''),
  fontWeight: String(font.weight || '400'),
  fontStyle: String(font.style || 'normal'),
  toFormat,
  originalFormat: String(font.format || 'woff2'),
  filenameBase: `${safePart(font.family)}-${safePart(font.weight)}-${safePart(font.style || 'normal')}`,
  zipEntryName: `fonts/${safePart(font.family)}-${safePart(font.weight)}-${safePart(font.style || 'normal')}.${toFormat}`,
  assetType: 'font',
})));
const zipResponse = await fetch(`${API}/api/download-zip`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items }),
});
if (!zipResponse.ok) throw new Error(`Font ZIP smoke failed (${zipResponse.status}): ${(await zipResponse.text()).slice(0, 400)}`);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cae-fordham-font-smoke-'));
try {
  const zipPath = path.join(root, 'fonts.zip');
  await fs.writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()));
  const { stdout } = await execFileAsync('unzip', ['-Z', '-1', zipPath]);
  const entries = stdout.split(/\r?\n/).filter(Boolean).filter((name) => /^fonts\/.+\.(woff|ttf)$/i.test(name));
  if (entries.length !== items.length) throw new Error(`Expected ${items.length} font files in the ZIP, got ${entries.length}`);
  if (new Set(entries).size !== entries.length || entries.some((name) => /-\d+\.(woff|ttf)$/i.test(name))) {
    throw new Error(`ZIP contains duplicate/suffixed font exports: ${entries.join(', ')}`);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`PASS: Fordham extracted ${fonts.length} identified fonts and downloaded ${items.length} unique WOFF/TTF files.`);
