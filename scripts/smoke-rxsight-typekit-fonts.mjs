import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import extractZip from 'extract-zip';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const PAGE = 'https://rxsight.com/patients/';
const TYPEKIT_CSS = 'https://use.typekit.net/krd2clb.css';
const headers = { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' };

const apiFetch = async (route, init = {}, timeoutMs = 240000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API}${route}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

const jsonRequest = async (route, body, timeoutMs) => {
  const response = await apiFetch(route, { method: 'POST', body: JSON.stringify(body) }, timeoutMs);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `${route} failed (${response.status})`);
  }
  return payload;
};

const normalizedFamily = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const safeName = (value, fallback = 'font') =>
  String(value || fallback).replace(/[^a-z0-9 ._-]/gi, '').trim().replace(/\s+/g, '-') || fallback;
const weightName = (value) => ({
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
})[Number(value)] || 'Regular';
const canonicalFamily = (value) => String(value || '')
  .replace(/[- ](?:Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black)$/i, '')
  .trim();

const sfntTables = (buffer) => {
  if (buffer.length < 12 || buffer.readUInt32BE(0) !== 0x00010000) throw new Error('Not a TrueType SFNT');
  const count = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const entry = 12 + index * 16;
    const tag = buffer.toString('latin1', entry, entry + 4);
    const offset = buffer.readUInt32BE(entry + 8);
    const length = buffer.readUInt32BE(entry + 12);
    if (offset > buffer.length || length > buffer.length - offset) throw new Error(`Invalid ${tag} table bounds`);
    tables.set(tag, buffer.subarray(offset, offset + length));
  }
  return tables;
};

const decodeUtf16Be = (bytes) => {
  let output = '';
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) output += String.fromCharCode(bytes.readUInt16BE(offset));
  return output.trim();
};

const readIdentity = (buffer) => {
  const tables = sfntTables(buffer);
  const name = tables.get('name');
  if (!name || name.length < 6) throw new Error('Missing name table');
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const names = new Map();
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 12;
    const platform = name.readUInt16BE(entry);
    const language = name.readUInt16BE(entry + 4);
    const id = name.readUInt16BE(entry + 6);
    const length = name.readUInt16BE(entry + 8);
    const offset = strings + name.readUInt16BE(entry + 10);
    if (platform !== 3 || offset + length > name.length) continue;
    if (language === 0x0409 || !names.has(id)) names.set(id, decodeUtf16Be(name.subarray(offset, offset + length)));
  }
  const os2 = tables.get('OS/2');
  return {
    family: names.get(16) || names.get(1) || '',
    subfamily: names.get(17) || names.get(2) || '',
    fullName: names.get(4) || '',
    postScriptName: names.get(6) || '',
    coreNamesPresent: [1, 2, 4, 6].every((id) => Boolean(names.get(id))),
    fsType: os2 && os2.length >= 10 ? os2.readUInt16BE(8) : 0xffff,
  };
};

const assertIdentity = (label, buffer, expectedFamily, expectedWeight, expectedStyle) => {
  const identity = readIdentity(buffer);
  const expectedSubfamily = [
    weightName(expectedWeight),
    /italic|oblique/i.test(String(expectedStyle || '')) ? 'Italic' : '',
  ].filter(Boolean).join(' ');
  if (!identity.coreNamesPresent) throw new Error(`${label}: missing Windows name records`);
  if (!expectedFamily || normalizedFamily(identity.family) !== normalizedFamily(expectedFamily)) {
    throw new Error(`${label}: family "${identity.family}" != "${expectedFamily}"`);
  }
  if (identity.subfamily.toLowerCase() !== expectedSubfamily.toLowerCase()) {
    throw new Error(`${label}: subfamily "${identity.subfamily}" != "${expectedSubfamily}"`);
  }
  if (!identity.postScriptName || /^fontcae-/i.test(identity.postScriptName)) {
    throw new Error(`${label}: generic PostScript identity "${identity.postScriptName}"`);
  }
  if ((identity.fsType & 0x000f) !== 0) throw new Error(`${label}: non-installable fsType ${identity.fsType}`);
  return identity;
};

const pagePayload = await jsonRequest('/api/extract', { url: PAGE }, 180000);
const pageFonts = (Array.isArray(pagePayload.fonts) ? pagePayload.fonts : [])
  .filter((font) => /use\.typekit\.net/i.test(String(font?.url || '')));
if (pageFonts.length !== 5) throw new Error(`Expected 5 RxSight Typekit faces from webpage, got ${pageFonts.length}`);

const cssPayload = await jsonRequest('/api/resolve-font-links', { urls: [TYPEKIT_CSS], sourcePageUrl: PAGE }, 60000);
const cssFonts = Array.isArray(cssPayload.fonts) ? cssPayload.fonts : [];
if (cssFonts.length !== 5) throw new Error(`Expected 5 RxSight Typekit faces from CSS, got ${cssFonts.length}`);

for (const pageFont of pageFonts) {
  const cssFont = cssFonts.find((font) => String(font.url) === String(pageFont.url));
  if (!cssFont) throw new Error(`Bulk CSS omitted ${pageFont.url}`);
  if (normalizedFamily(cssFont.family) !== normalizedFamily(pageFont.family)) {
    throw new Error(`Path disagreement for ${pageFont.url}: webpage=${pageFont.family}, CSS=${cssFont.family}`);
  }
}

const shelbyRegular = pageFonts.find((font) => normalizedFamily(font.family) === 'shelby' && String(font.weight) === '400');
if (!shelbyRegular) throw new Error('RxSight Shelby Regular was not extracted');
const poisonParams = new URLSearchParams({
  url: String(shelbyRegular.url),
  originalUrl: String(shelbyRegular.url),
  cssSource: TYPEKIT_CSS,
  toFormat: 'ttf',
  originalFormat: String(shelbyRegular.format || 'woff2'),
  filenameBase: 'Font',
  metadataFilename: 'Regular',
  fontWeight: '400',
  fontStyle: 'normal',
});
const poisonResponse = await apiFetch(`/api/convert-font?${poisonParams}`, {}, 180000);
const poisonBuffer = Buffer.from(await poisonResponse.arrayBuffer());
if (!poisonResponse.ok) throw new Error(`Generic conversion request failed (${poisonResponse.status})`);
const recovered = assertIdentity('generic request recovery', poisonBuffer, 'shelby', '400', 'normal');
console.log(`OK generic request recovered ${recovered.family} / ${recovered.subfamily} / ${recovered.postScriptName}`);

const embeddedFallbackParams = new URLSearchParams(poisonParams);
embeddedFallbackParams.delete('cssSource');
const embeddedFallbackResponse = await apiFetch(`/api/convert-font?${embeddedFallbackParams}`, {}, 180000);
const embeddedFallbackBuffer = Buffer.from(await embeddedFallbackResponse.arrayBuffer());
if (!embeddedFallbackResponse.ok) throw new Error(`Embedded family fallback failed (${embeddedFallbackResponse.status})`);
const embeddedFallback = assertIdentity('direct URL embedded-name recovery', embeddedFallbackBuffer, 'shelby', '400', 'normal');
console.log(`OK direct URL recovered ${embeddedFallback.family} / ${embeddedFallback.subfamily} / ${embeddedFallback.postScriptName}`);

const createItems = (fonts, bulkPath) => fonts.map((font) => {
  const family = String(font.family || '').trim();
  const filenameBase = safeName(`${family}-${weightName(font.weight)}${/italic|oblique/i.test(String(font.style || '')) ? '-Italic' : ''}`);
  return {
    url: String(font.cachedUrl || font.url),
    cachedPath: String(font.cachedUrl || '') || undefined,
    originalUrl: String(font.url),
    cssSource: String(font.cssSource || TYPEKIT_CSS),
    ...(bulkPath ? { family: family, familyFolder: family } : { fontFamily: family, familyFolder: family }),
    fontWeight: String(font.weight || ''),
    fontStyle: String(font.style || ''),
    originalFormat: String(font.format || 'woff2'),
    filenameBase,
    metadataFilename: bulkPath ? `${filenameBase}.ttf` : filenameBase,
    zipEntryName: `fonts/${filenameBase}.ttf`,
    assetType: 'font',
    toFormat: 'ttf',
    status: String(font.status || 'path-only'),
    fixVerticalMetrics: true,
  };
});

const verifyZipPath = async (label, fonts, bulkPath) => {
  const items = createItems(fonts, bulkPath);
  const response = await apiFetch('/api/download-zip', {
    method: 'POST',
    body: JSON.stringify({ items, sourcePageUrl: PAGE }),
  }, 600000);
  const zip = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${label} ZIP failed (${response.status}): ${zip.toString('utf8').slice(0, 300)}`);
  const added = Number(response.headers.get('x-zip-added-count') || 0);
  const failed = Number(response.headers.get('x-zip-failed-count') || 0);
  if (added !== items.length || failed !== 0) throw new Error(`${label} ZIP partial: ${added}/${items.length}, failed=${failed}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cae-rxsight-${label}-`));
  try {
    const zipPath = path.join(root, 'fonts.zip');
    const output = path.join(root, 'output');
    await fs.writeFile(zipPath, zip);
    await fs.mkdir(output);
    await extractZip(zipPath, { dir: output });
    const postScriptNames = new Set();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const file = path.join(output, ...item.zipEntryName.split('/'));
      const buffer = await fs.readFile(file);
      const identity = assertIdentity(`${label}:${item.zipEntryName}`, buffer, canonicalFamily(fonts[index].family), fonts[index].weight, fonts[index].style);
      const psKey = identity.postScriptName.toLowerCase();
      if (postScriptNames.has(psKey)) throw new Error(`${label}: duplicate PostScript name ${identity.postScriptName}`);
      postScriptNames.add(psKey);
      console.log(`OK ${label} ${identity.family} / ${identity.subfamily} / ${identity.postScriptName}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

await verifyZipPath('webpage', pageFonts, false);
await verifyZipPath('bulk-css', cssFonts, true);
console.log('PASS: RxSight webpage and Typekit CSS produced 5/5 correctly named, installable TTF faces');
