import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import extractZip from 'extract-zip';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const SITE = 'https://www.bauschsurgical.com/refractive/teneo/#VIDEOS';
const headers = {
  'Content-Type': 'application/json',
  'X-VDX-Local-Request': '1',
};

const fetchWithTimeout = async (url, init = {}, timeoutMs = 180000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

const safeName = (value, fallback = 'font') =>
  String(value || fallback).replace(/[^a-z0-9 ._-]/gi, '').trim().replace(/\s+/g, '-') || fallback;

const isInstallableTtf = (buffer) => {
  if (buffer.length < 128) return false;
  const signature = buffer.readUInt32BE(0);
  if (signature !== 0x00010000 && signature !== 0x74727565) return false;
  const tableCount = buffer.readUInt16BE(4);
  if (tableCount < 4 || tableCount > 256 || 12 + tableCount * 16 > buffer.length) return false;
  const tables = new Set();
  for (let index = 0; index < tableCount; index += 1) {
    const offset = 12 + index * 16;
    const tag = buffer.toString('latin1', offset, offset + 4);
    const tableOffset = buffer.readUInt32BE(offset + 8);
    const tableLength = buffer.readUInt32BE(offset + 12);
    if (tableOffset > buffer.length || tableLength > buffer.length - tableOffset) return false;
    tables.add(tag);
  }
  return ['cmap', 'head', 'maxp', 'name'].every((tag) => tables.has(tag)) &&
    ((tables.has('glyf') && tables.has('loca')) || tables.has('CFF ') || tables.has('CFF2'));
};

const extractionResponse = await fetchWithTimeout(`${API}/api/extract`, {
  method: 'POST',
  body: JSON.stringify({ url: SITE }),
});
const extraction = await extractionResponse.json();
if (!extractionResponse.ok) throw new Error(extraction?.error || `Extraction failed (${extractionResponse.status})`);
const fonts = Array.isArray(extraction?.fonts) ? extraction.fonts : [];
if (fonts.length < 2) throw new Error(`Expected multiple TENEO fonts, received ${fonts.length}`);

const items = fonts.flatMap((font) => {
  const family = safeName(font.family || font.title || font.name);
  const variant = [
    String(font.weight || '') !== '400' ? String(font.weight || '') : '',
    String(font.style || '').toLowerCase() !== 'normal' ? String(font.style || '') : '',
  ].filter(Boolean).join('-');
  const filenameBase = safeName(`${family}-${variant || 'Regular'}`);
  const baseItem = {
    url: String(font.cachedUrl || font.url),
    cachedPath: String(font.cachedUrl || '') || undefined,
    originalUrl: String(font.url || ''),
    cssSource: String(font.cssSource || '') || undefined,
    fontFamily: String(font.family || '') || undefined,
    fontWeight: String(font.weight || '') || undefined,
    fontStyle: String(font.style || '') || undefined,
    status: String(font.status || '') || undefined,
    originalFormat: String(font.format || 'woff2'),
    filenameBase,
    familyFolder: family,
    metadataFilename: family,
    assetType: 'font',
    fixVerticalMetrics: true,
  };
  return ['woff', 'ttf'].map((format) => ({
    ...baseItem,
    toFormat: format,
    zipEntryName: `fonts/${family}/${filenameBase}.${format}`,
  }));
});

const zipResponse = await fetchWithTimeout(`${API}/api/download-zip`, {
  method: 'POST',
  body: JSON.stringify({ items, sourcePageUrl: SITE }),
}, 600000);
const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
if (!zipResponse.ok) throw new Error(zipBuffer.toString('utf8').slice(0, 500));
const added = Number(zipResponse.headers.get('x-zip-added-count') || 0);
const failed = Number(zipResponse.headers.get('x-zip-failed-count') || 0);
if (failed !== 0 || added !== items.length) {
  throw new Error(`TTF ZIP was partial: added=${added}/${items.length}, failed=${failed}`);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cae-teneo-font-smoke-'));
try {
  const zipPath = path.join(tempRoot, 'teneo-fonts.zip');
  const outputDir = path.join(tempRoot, 'output');
  await fs.writeFile(zipPath, zipBuffer);
  await fs.mkdir(outputDir);
  await extractZip(zipPath, { dir: outputDir });

  const fontFiles = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:ttf|woff)$/i.test(entry.name)) fontFiles.push(full);
    }
  };
  await walk(outputDir);
  if (fontFiles.length !== items.length) {
    throw new Error(`Expected ${items.length} WOFF/TTF files, extracted ${fontFiles.length}`);
  }
  let ttfCount = 0;
  let woffCount = 0;
  for (const file of fontFiles) {
    const buffer = await fs.readFile(file);
    if (/\.ttf$/i.test(file)) {
      if (!isInstallableTtf(buffer)) throw new Error(`${path.basename(file)} failed SFNT/table validation`);
      ttfCount += 1;
    } else {
      if (buffer.slice(0, 4).toString('latin1') !== 'wOFF') {
        throw new Error(`${path.basename(file)} failed WOFF signature validation`);
      }
      woffCount += 1;
    }
    console.log(`OK ${path.relative(outputDir, file)}: ${buffer.length} bytes`);
  }
  if (ttfCount !== fonts.length || woffCount !== fonts.length) {
    throw new Error(`Expected ${fonts.length} of each format, got WOFF=${woffCount}, TTF=${ttfCount}`);
  }
  console.log(`PASS: ${fonts.length}/${fonts.length} TENEO fonts produced valid WOFF and installable TTF files`);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
