import fs from 'node:fs/promises';
import path from 'node:path';
import extractZip from 'extract-zip';
import { resolveSmokeOutDir } from './lib/smoke-out-dir.mjs';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const SITE = process.env.QC_SITE || 'https://www.posluma.com/';
const OUT_DIR = resolveSmokeOutDir('posluma-images', SITE);

const fetchWithTimeout = async (url, options = {}, timeoutMs = 120000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const postJson = async (pathName, body, timeoutMs = 120000) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VDX-Local-Request': '1',
    },
    body: JSON.stringify(body),
  }, timeoutMs);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
};

const getBuffer = async (pathName, timeoutMs = 120000) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    headers: { 'X-VDX-Local-Request': '1' },
  }, timeoutMs);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      reason = JSON.parse(buffer.toString('utf8')).error || reason;
    } catch {}
    throw new Error(reason);
  }
  return {
    buffer,
    contentType: response.headers.get('content-type') || '',
    disposition: response.headers.get('content-disposition') || '',
  };
};

const filenameFromUrl = (url = '') => {
  if (url.startsWith('data:image/svg')) return '';
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return path.basename(String(url).split('?')[0]);
  }
};

const baseFromImage = (img, index) => {
  const filename = filenameFromUrl(img.url || '') || img.filename || img.name || `image-${index + 1}`;
  return filename.replace(/\.[^/.]+$/, '') || `image-${index + 1}`;
};

const typeFromImage = (img) => {
  const explicit = String(img?.type || '').toLowerCase().replace('jpeg', 'jpg');
  if (explicit && explicit !== 'img' && explicit !== 'unknown') return explicit;
  const filename = filenameFromUrl(img?.url || img?.cachedUrl || '');
  return path.extname(filename).slice(1).toLowerCase().replace('jpeg', 'jpg');
};

const isSvgFontAsset = (img) => {
  const value = `${img?.url || ''} ${img?.filename || ''} ${img?.name || ''}`.toLowerCase();
  return typeFromImage(img) === 'svg' && /(icomoon|font|glyph|symbol)/i.test(value);
};

const requestUrlForImage = (img) => {
  const cached = String(img?.cachedUrl || '').trim();
  if (cached) return cached;
  return String(img?.url || '').trim();
};

const mimeForType = (type) => {
  if (type === 'jpg') return 'image/jpeg';
  if (type === 'png') return 'image/png';
  if (type === 'webp') return 'image/webp';
  if (type === 'avif') return 'image/avif';
  if (type === 'gif') return 'image/gif';
  if (type === 'svg') return 'image/svg+xml';
  return '';
};

const zipItem = (img, index) => {
  const type = typeFromImage(img);
  const item = {
    id: String(img.id || img.url || img.cachedUrl || `image-${index + 1}`),
    url: requestUrlForImage(img),
    filename: filenameFromUrl(img.url || '') || `${baseFromImage(img, index)}.${type || 'bin'}`,
    filenameBase: baseFromImage(img, index),
    originalUrl: String(img.url || ''),
    metadataFilename: String(img.filename || img.name || '') || undefined,
    mimeType: String(img.mimeType || mimeForType(type) || ''),
    cachedPath: String(img.cachedUrl || '') || undefined,
    status: String(img.status || '') || undefined,
    assetType: 'image',
  };
  if (type === 'webp') {
    item.toFormat = 'png';
    item.selectedFormat = 'png';
  }
  if (type === 'avif') {
    item.toFormat = 'png';
    item.selectedFormat = 'png';
  }
  return item;
};

const assertSignature = (buffer, expected) => {
  if (expected === 'png') return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (expected === 'jpg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (expected === 'gif') return buffer.slice(0, 3).toString('ascii') === 'GIF';
  if (expected === 'svg') return /<svg|<\?xml/i.test(buffer.slice(0, 1024).toString('utf8'));
  if (expected === 'webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  if (expected === 'avif') return buffer.slice(4, 8).toString('ascii') === 'ftyp';
  return buffer.length > 32;
};

const listFiles = async (dir) => {
  const output = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else output.push(full);
    }
  };
  await walk(dir);
  return output;
};

const downloadImage = async (img, index) => {
  const type = typeFromImage(img);
  if (String(img.url || '').startsWith('data:image/svg')) {
    const encoded = String(img.url).match(/^data:image\/svg\+xml;base64,(.+)$/i)?.[1];
    if (!encoded) throw new Error('Inline SVG data URL is not base64 encoded');
    const buffer = Buffer.from(encoded, 'base64');
    if (!assertSignature(buffer, 'svg')) throw new Error('Inline SVG signature failed');
    return { type, bytes: buffer.length, disposition: 'inline-svg' };
  }

  const params = new URLSearchParams({
    url: requestUrlForImage(img),
    originalUrl: String(img.url || ''),
    filenameBase: baseFromImage(img, index),
  });
  if (img.filename || img.name) params.set('metadataFilename', String(img.filename || img.name));
  const downloaded = await getBuffer(`/api/download-image?${params.toString()}`, 120000);
  const expected = type === 'jpeg' ? 'jpg' : type;
  if (!assertSignature(downloaded.buffer, expected)) {
    throw new Error(`${type || 'unknown'} download signature failed`);
  }
  return { type, bytes: downloaded.buffer.length, disposition: downloaded.disposition };
};

const convertImage = async (img, index, target) => {
  const params = new URLSearchParams({
    url: requestUrlForImage(img),
    originalUrl: String(img.url || ''),
    filenameBase: baseFromImage(img, index),
    toFormat: target,
    selectedFormat: target,
  });
  const converted = await getBuffer(`/api/convert-image?${params.toString()}`, 120000);
  if (!assertSignature(converted.buffer, target)) {
    throw new Error(`${typeFromImage(img)} conversion to ${target} signature failed`);
  }
  return { target, bytes: converted.buffer.length, disposition: converted.disposition };
};

const zipSelected = async (images, count) => {
  const selected = images.slice(0, count).map(zipItem);
  const response = await fetchWithTimeout(`${API}/api/download-zip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VDX-Local-Request': '1',
    },
    body: JSON.stringify({ items: selected }),
  }, 180000);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = buffer.toString('utf8');
    if (/No downloadable assets were found/i.test(text)) throw new Error(`ZIP ${count}: No downloadable assets were found`);
    throw new Error(`ZIP ${count}: ${text.slice(0, 240)}`);
  }
  const zipPath = path.join(OUT_DIR, `posluma-${count}.zip`);
  const dir = path.join(OUT_DIR, `posluma-${count}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(zipPath, buffer);
  await extractZip(zipPath, { dir });
  const files = await listFiles(dir);
  if (files.length === 0) throw new Error(`ZIP ${count}: extracted no files`);
  const inspected = await Promise.all(files.map(async (file) => ({
    name: path.basename(file),
    size: (await fs.stat(file)).size,
  })));
  const realFiles = inspected.filter((file) => file.name !== 'asset-paths.txt' && file.size > 0);
  if (realFiles.length === 0) throw new Error(`ZIP ${count}: no openable files`);
  return {
    requested: count,
    bytes: buffer.length,
    addedHeader: response.headers.get('x-zip-added-count') || '',
    failedHeader: response.headers.get('x-zip-failed-count') || '',
    fileCount: inspected.length,
    sampleNames: inspected.slice(0, 8).map((file) => file.name),
  };
};

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

const extracted = await postJson('/api/extract', { url: SITE, mode: 'static' }, 120000);
const images = Array.isArray(extracted.images) ? extracted.images : [];
const fonts = Array.isArray(extracted.fonts) ? extracted.fonts : [];
if (!images.length) throw new Error('No images extracted from Posluma');

const hasFontFamily = (family) =>
  fonts.some((font) => String(font?.family || font?.title || font?.name || '').toLowerCase() === family.toLowerCase());
const missingFonts = ['Roboto', 'Roboto Condensed', 'Martel Sans'].filter((family) => !hasFontFamily(family));
if (missingFonts.length) {
  throw new Error(`Missing Posluma font families: ${missingFonts.join(', ')}. Found: ${fonts.map((font) => font.family || font.name || font.url).join(', ')}`);
}

const report = {
  site: SITE,
  totalImages: images.length,
  totalFonts: fonts.length,
  fontFamilies: Array.from(new Set(fonts.map((font) => font.family).filter(Boolean))).sort(),
  typeCounts: {},
  individual: {},
  conversions: {},
  zips: {},
  cacheMetadata: {
    withCachedPath: images.filter((img) => String(img.cachedUrl || '').trim()).length,
    withFilename: images.filter((img) => String(img.filename || img.name || filenameFromUrl(img.url || '')).trim()).length,
  },
};

for (const img of images) {
  const type = typeFromImage(img) || 'unknown';
  report.typeCounts[type] = (report.typeCounts[type] || 0) + 1;
}

for (const wanted of ['jpg', 'png', 'webp', 'avif', 'svg', 'gif']) {
  const index = images.findIndex((img) => typeFromImage(img) === wanted && !isSvgFontAsset(img));
  if (index === -1) {
    report.individual[wanted] = 'not-present';
    continue;
  }
  report.individual[wanted] = await downloadImage(images[index], index);
  if (wanted === 'webp' || wanted === 'avif') {
    report.conversions[wanted] = await convertImage(images[index], index, 'png');
  }
  if (wanted === 'svg') {
    report.conversions.svgToPng = await convertImage(images[index], index, 'png');
    report.conversions.svgToJpg = await convertImage(images[index], index, 'jpg');
  }
}

for (const count of [5, 10, 15]) {
  report.zips[count] = await zipSelected(images, Math.min(count, images.length));
}

const reportPath = path.join(OUT_DIR, 'report.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
