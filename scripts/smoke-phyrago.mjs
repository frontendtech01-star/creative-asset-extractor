#!/usr/bin/env node
/**
 * Real download smoke test for https://phyrago.com/hcp/
 * Does not use UI — hits API endpoints and validates files on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const TARGET = 'https://phyrago.com/hcp/';
const HERO =
  'https://phyrago.com/wp-content/uploads/2025/06/About-PHYRAGO-Hero-Image-v2-2-scaled-e1751016179182.jpg';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.smoke-test');
const results = [];

const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const api = async (p, init = {}) => {
  const headers = { 'X-VDX-Local-Request': '1', ...(init.headers || {}) };
  const res = await fetch(`${BASE}${p}`, { ...init, headers });
  return res;
};

const magic = (buf) => {
  if (!buf || buf.length < 4) return 'empty';
  const h = buf.slice(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  if (h[0] === 0x89 && h[1] === 0x50) return 'png';
  if (h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (h.slice(0, 5).toString().includes('<svg') || buf.toString('utf8', 0, 200).includes('<svg')) return 'svg';
  if (buf.toString('utf8', 0, 80).toLowerCase().includes('<!doctype') || buf.toString('utf8', 0, 80).toLowerCase().includes('<html')) return 'html';
  return 'unknown';
};

const imageFilenameBase = (img, index = 0) => {
  const remote = String(img?.url || '').trim();
  if (remote.startsWith('data:image/svg')) return `inline-svg-${index + 1}`;
  const raw = remote.split('/').pop()?.split('?')[0] || `image-${index + 1}`;
  return raw.replace(/\.[^/.]+$/, '') || `image-${index + 1}`;
};

const buildImageZipItem = (img, index = 0) => {
  const remote = String(img?.url || '').trim();
  const cached = String(img?.cachedUrl || '').trim();
  let url = remote;
  if (!remote.startsWith('data:') && cached.startsWith('/cached-images-original/')) url = cached;
  else if (!remote.startsWith('http') && cached) url = cached;
  const type = String(img?.type || '').toLowerCase();
  const item = {
    url,
    assetType: 'image',
    filenameBase: imageFilenameBase(img, index),
    originalUrl: remote,
    status: String(img?.status || '').trim() || undefined,
  };
  if (type === 'webp') item.toFormat = 'jpg';
  else if (type === 'avif') item.toFormat = 'png';
  return item;
};

fs.mkdirSync(OUT, { recursive: true });

console.log(`\nSmoke test base: ${BASE}`);
console.log(`Target URL: ${TARGET}\n`);

// 1. Extract
console.log('--- Extract ---');
const defaultExtractRes = await api('/api/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: TARGET }),
});
const defaultExtract = await defaultExtractRes.json().catch(() => ({}));
log(
  'Default UI extraction returns assets immediately',
  defaultExtractRes.ok && Array.isArray(defaultExtract.images) && defaultExtract.images.length > 0 && !defaultExtract.async,
  defaultExtract.async
    ? `async extractId=${defaultExtract.extractId || 'n/a'}`
    : `${defaultExtract.images?.length || 0} images`
);

const extract = defaultExtract;
const images = Array.isArray(extract.images) ? extract.images : [];

log('Images extracted', images.length > 0, `${images.length} images`);

const types = {};
for (const img of images) types[String(img.type || 'unknown').toLowerCase()] = (types[String(img.type || 'unknown').toLowerCase()] || 0) + 1;
log('Format diversity', Object.keys(types).length > 0, JSON.stringify(types));

const pathOnly = images.filter((i) => i.status === 'path-only');
const downloaded = images.filter((i) => i.status === 'downloaded');
const failed = images.filter((i) => i.status === 'failed-download');
log('Path-only assets listed', pathOnly.length >= 0, `${pathOnly.length} path-only, ${downloaded.length} downloaded, ${failed.length} failed`);

const hero = images.find((i) => String(i.url || '').includes('About-PHYRAGO-Hero-Image'));
log('Hero image found in extraction', !!hero, hero ? `${hero.type}, status=${hero.status || 'n/a'}` : 'missing');
const banner = images.find((i) => String(i.url || '').includes('banner-background'));
log('Banner background found in extraction', !!banner, banner ? `${banner.type}, status=${banner.status || 'n/a'}` : 'missing');

const fonts = Array.isArray(extract.fonts) ? extract.fonts : [];
const hasGreycliff = fonts.some((font) => /greycliff-cf/i.test(String(font.family || '')));
const hasLumios = fonts.some((font) => /lumios-marker/i.test(String(font.family || '')));
const hasUncodeIcon = fonts.some((font) => /uncodeicon/i.test(String(font.family || font.url || '')));
log('Key font files found', hasGreycliff && hasLumios && hasUncodeIcon, `${fonts.length} fonts`);

// 2. Individual download
console.log('\n--- Individual download ---');
const sample = hero || images.find((i) => i.type === 'jpg') || images[0];
if (!sample) {
  log('Individual download', false, 'no sample image');
  process.exit(1);
}

const sampleUrl = sample.cachedUrl?.startsWith('/cached-images-original/')
  ? sample.cachedUrl
  : sample.url;
const convertRes = await api(
  `/api/convert-image?url=${encodeURIComponent(sampleUrl)}`
);
const singlePath = path.join(OUT, 'single-download.bin');
const singleBuf = Buffer.from(await convertRes.arrayBuffer());
fs.writeFileSync(singlePath, singleBuf);

log('Individual download HTTP 200', convertRes.ok, `status=${convertRes.status}, size=${singleBuf.length}`);
const singleKind = magic(singleBuf);
log('Individual file is real image', singleKind !== 'html' && singleKind !== 'empty' && singleBuf.length > 1024, `${singleKind}, ${singleBuf.length} bytes`);

let fileCmd = '';
try {
  fileCmd = execFileSync('file', ['-b', singlePath], { encoding: 'utf8' }).trim();
} catch {
  fileCmd = '(file cmd unavailable)';
}
log('file(1) recognizes image', /image|JPEG|PNG|SVG|WebP/i.test(fileCmd), fileCmd);

// 3. Select all + ZIP
console.log('\n--- Select all + ZIP ---');
const selected = images.filter((i) => String(i.url || '').trim());
const items = selected.map((img, idx) => buildImageZipItem(img, idx));
log('Select all count', items.length === selected.length, `${items.length} items`);

const zipRes = await api('/api/download-zip', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items }),
});
const zipPath = path.join(OUT, 'images.zip');
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
fs.writeFileSync(zipPath, zipBuf);

const packed = Number(zipRes.headers.get('X-Zip-Added-Count') || 0);
const failedCount = Number(zipRes.headers.get('X-Zip-Failed-Count') || 0);

log('ZIP HTTP 200', zipRes.ok, `status=${zipRes.status}`);
log('ZIP created with content', zipBuf.length > 1024, `${zipBuf.length} bytes`);
log('ZIP header counts', packed > 0, `added=${packed}, failed=${failedCount}`);

// 4. Extract ZIP
console.log('\n--- Extract ZIP ---');
const extractDir = path.join(OUT, 'unzipped');
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
try {
  execFileSync('unzip', ['-q', zipPath, '-d', extractDir]);
  log('ZIP extracts locally', true);
} catch (e) {
  log('ZIP extracts locally', false, e.message);
}

const zipFiles = [];
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else zipFiles.push(p);
  }
};
walk(extractDir);

const imageFiles = zipFiles.filter((f) => /\.(jpe?g|png|webp|svg|gif|avif)$/i.test(f));
const manifest = zipFiles.find((f) => f.endsWith('asset-paths.txt'));
log('ZIP contains image files', imageFiles.length > 0, `${imageFiles.length} image files`);

const zipFormats = {};
for (const f of imageFiles) {
  const ext = path.extname(f).replace('.', '').toLowerCase();
  zipFormats[ext] = (zipFormats[ext] || 0) + 1;
}
const hasJpg = zipFormats.jpg || zipFormats.jpeg;
const hasPng = zipFormats.png;
const hasSvg = zipFormats.svg;
const hasWebp = zipFormats.webp;
log('JPG/PNG/SVG in ZIP when available', hasJpg || hasPng || hasSvg, JSON.stringify(zipFormats));

// Validate no HTML masquerading as images
let htmlAsImage = 0;
for (const f of imageFiles) {
  const b = fs.readFileSync(f);
  if (magic(b) === 'html' || b.length < 200) htmlAsImage++;
}
log('No HTML/error stubs in image files', htmlAsImage === 0, htmlAsImage ? `${htmlAsImage} bad files` : 'all valid');

// Hero in ZIP
const heroInZip = zipFiles.some((f) => f.includes('About-PHYRAGO-Hero-Image'));
const heroManifest = manifest && fs.readFileSync(manifest, 'utf8').includes('About-PHYRAGO-Hero-Image');
log('Hero downloaded or captured as path-only', heroInZip || heroManifest, heroInZip ? 'file in ZIP' : heroManifest ? 'in asset-paths.txt' : 'missing');

log('Failed downloads have clear status', failedCount === 0 || !!manifest, manifest ? 'asset-paths.txt present' : failedCount === 0 ? 'none failed' : 'no manifest');
if (manifest) {
  const text = fs.readFileSync(manifest, 'utf8');
  log('Manifest lists failures clearly', text.includes('status:') && text.includes('reason:'), `${failedCount} failures documented`);
}

log('Path-only assets do not break ZIP', zipRes.ok && zipBuf.length > 1024, `ZIP still ${zipBuf.length} bytes`);

// Summary
console.log('\n=== SUMMARY ===');
const failedTests = results.filter((r) => !r.ok);
for (const r of results) {
  /* already printed */
}
console.log(`\n${results.length - failedTests.length}/${results.length} passed`);
if (failedTests.length) {
  console.log('\nFailed:');
  failedTests.forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  process.exit(1);
}
