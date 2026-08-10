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

const readSfntTables = (buffer) => {
  const tableCount = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < tableCount; index += 1) {
    const entryOffset = 12 + index * 16;
    const tag = buffer.toString('latin1', entryOffset, entryOffset + 4);
    const offset = buffer.readUInt32BE(entryOffset + 8);
    const length = buffer.readUInt32BE(entryOffset + 12);
    tables.set(tag, buffer.subarray(offset, offset + length));
  }
  return tables;
};

const decodeNameRecord = (bytes, platformId) => {
  if (platformId !== 0 && platformId !== 3) return bytes.toString('latin1').replace(/\0/g, '').trim();
  let output = '';
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    output += String.fromCharCode(bytes.readUInt16BE(offset));
  }
  return output.trim();
};

const readPlatformFontIdentity = (buffer) => {
  const tables = readSfntTables(buffer);
  const name = tables.get('name');
  if (!name || name.length < 6) throw new Error('TTF has no readable name table');
  const count = name.readUInt16BE(2);
  const stringOffset = name.readUInt16BE(4);
  const names = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 12;
    const platformId = name.readUInt16BE(offset);
    const languageId = name.readUInt16BE(offset + 4);
    const nameId = name.readUInt16BE(offset + 6);
    const length = name.readUInt16BE(offset + 8);
    const relativeOffset = name.readUInt16BE(offset + 10);
    const start = stringOffset + relativeOffset;
    if (start + length > name.length) continue;
    // Windows Unicode English is consumed by Windows Fonts and is also
    // understood by CoreText/Font Book on modern macOS.
    if (platformId === 3 && (languageId === 0x0409 || !names.has(nameId))) {
      names.set(nameId, decodeNameRecord(name.subarray(start, start + length), platformId));
    }
  }
  const os2 = tables.get('OS/2');
  const fsType = os2 && os2.length >= 10 ? os2.readUInt16BE(8) : 0xffff;
  return {
    family: names.get(16) || names.get(1) || '',
    subfamily: names.get(17) || names.get(2) || '',
    fullName: names.get(4) || '',
    postScriptName: names.get(6) || '',
    hasWindowsCoreNames: [1, 2, 4, 6].every((nameId) => Boolean(names.get(nameId))),
    fsType,
  };
};

const weightLabel = (value) => {
  const labels = {
    100: 'Thin',
    200: 'ExtraLight',
    300: 'Light',
    400: 'Regular',
    500: 'Medium',
    600: 'SemiBold',
    700: 'Bold',
    800: 'ExtraBold',
    900: 'Black',
  };
  return labels[Number(value)] || 'Regular';
};

const extractionFixture = String(process.env.TENEO_FONT_SMOKE_EXTRACT_JSON || '').trim();
let extraction;
if (extractionFixture) {
  extraction = JSON.parse(await fs.readFile(path.resolve(extractionFixture), 'utf8'));
} else {
  const extractionResponse = await fetchWithTimeout(`${API}/api/extract`, {
    method: 'POST',
    body: JSON.stringify({ url: SITE }),
  });
  extraction = await extractionResponse.json();
  if (!extractionResponse.ok) throw new Error(extraction?.error || `Extraction failed (${extractionResponse.status})`);
}
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
const expectedTtfIdentity = new Map(
  items
    .filter((item) => item.toFormat === 'ttf')
    .map((item) => [
      item.zipEntryName,
      {
        family: String(item.fontFamily || '').trim(),
        subfamily: [
          weightLabel(item.fontWeight),
          /italic|oblique/i.test(String(item.fontStyle || '')) ? 'Italic' : '',
        ].filter(Boolean).join(' '),
      },
    ])
);

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

const requestedOutputRoot = String(process.env.TENEO_FONT_SMOKE_OUTPUT || '').trim();
const tempRoot = requestedOutputRoot
  ? path.resolve(requestedOutputRoot)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'cae-teneo-font-smoke-'));
try {
  if (requestedOutputRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });
  }
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
  const postScriptNames = new Set();
  for (const file of fontFiles) {
    const buffer = await fs.readFile(file);
    if (/\.ttf$/i.test(file)) {
      if (!isInstallableTtf(buffer)) throw new Error(`${path.basename(file)} failed SFNT/table validation`);
      const relativePath = path.relative(outputDir, file).split(path.sep).join('/');
      const expected = expectedTtfIdentity.get(relativePath);
      const identity = readPlatformFontIdentity(buffer);
      if (!expected) throw new Error(`${relativePath} has no expected CSS font identity`);
      if (!identity.hasWindowsCoreNames) throw new Error(`${relativePath} is missing Windows font-name records`);
      const normalizedFamily = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (normalizedFamily(identity.family) !== normalizedFamily(expected.family)) {
        throw new Error(`${relativePath} registered as family "${identity.family}", expected "${expected.family}"`);
      }
      if (identity.subfamily.toLowerCase() !== expected.subfamily.toLowerCase()) {
        throw new Error(`${relativePath} registered as style "${identity.subfamily}", expected "${expected.subfamily}"`);
      }
      if (!identity.postScriptName || postScriptNames.has(identity.postScriptName.toLowerCase())) {
        throw new Error(`${relativePath} has a missing or duplicate PostScript identity`);
      }
      // Bits 0-3 restrict embedding. A desktop-installable result must use
      // installable embedding (zero), not restricted/preview/editable modes.
      if ((identity.fsType & 0x000f) !== 0) {
        throw new Error(`${relativePath} is not desktop-installable (OS/2 fsType=${identity.fsType})`);
      }
      postScriptNames.add(identity.postScriptName.toLowerCase());
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
  if (!requestedOutputRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`Preserved smoke-test fonts at ${tempRoot}`);
  }
}
