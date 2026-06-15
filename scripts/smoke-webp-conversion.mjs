#!/usr/bin/env node
/**
 * Real WEBP/AVIF conversion smoke test — writes files to disk and verifies binary signatures.
 * Usage: SMOKE_BASE_URL=http://localhost:3000 node scripts/smoke-webp-conversion.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const WEBP_URL = process.env.SMOKE_WEBP_URL || 'https://www.gstatic.com/webp/gallery/1.webp';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.smoke-test/webp-conversion');
const results = [];

const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { 'X-VDX-Local-Request': '1', ...(init.headers || {}) },
  });

const sniff = (buf) => {
  if (!buf?.length) return 'empty';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
  }
  return 'unknown';
};

const writeAndVerify = async (label, url, expectedExt, expectedMagic, { allowRasterSource = false } = {}) => {
  const res = await api(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const cd = res.headers.get('content-disposition') || '';
  const filePath = path.join(OUT, `${label}.${expectedExt}`);
  fs.writeFileSync(filePath, buf);

  const magic = sniff(buf);
  const extOk = cd.includes(`.${expectedExt}`) || filePath.endsWith(`.${expectedExt}`);
  const magicOk = magic === expectedMagic;
  const ctOk =
    expectedMagic === 'png'
      ? ct.includes('image/png')
      : expectedMagic === 'jpg'
        ? ct.includes('image/jpeg')
        : expectedMagic === 'webp'
          ? ct.includes('image/webp')
          : true;
  const notMislabeled = allowRasterSource || (magic !== 'webp' && magic !== 'avif');

  log(
    label,
    res.ok && extOk && magicOk && ctOk && notMislabeled,
    `status=${res.status} ct=${ct} magic=${magic} size=${buf.length} cd=${cd.slice(0, 80)}`
  );
  return res.ok && magicOk && notMislabeled;
};

const testZip = async (label, toFormat) => {
  const res = await api('/api/download-zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        {
          url: WEBP_URL,
          assetType: 'image',
          toFormat,
          selectedFormat: toFormat,
          filenameBase: 'hero',
          originalUrl: WEBP_URL,
        },
      ],
    }),
  });
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const zipPath = path.join(OUT, `${label}.zip`);
  fs.writeFileSync(zipPath, zipBuf);
  const extractDir = path.join(OUT, label);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('unzip', ['-q', zipPath, '-d', extractDir]);

  const files = fs.readdirSync(extractDir, { recursive: true }).filter((f) => {
    const full = path.join(extractDir, String(f));
    return fs.statSync(full).isFile() && !String(f).endsWith('.txt');
  });

  const raster = files.filter((f) => /\.(png|jpg|jpeg|webp|avif)$/i.test(String(f)));
  const webpLeft = raster.filter((f) => /\.webp$/i.test(String(f)));
  const avifLeft = raster.filter((f) => /\.avif$/i.test(String(f)));
  const converted = raster.filter((f) => new RegExp(`\\.${toFormat}$`, 'i').test(String(f)));

  let magicOk = false;
  if (converted.length === 1) {
    const full = path.join(extractDir, String(converted[0]));
    magicOk = sniff(fs.readFileSync(full)) === toFormat;
  }

  log(
    label,
    res.ok && webpLeft.length === 0 && avifLeft.length === 0 && converted.length >= 1 && magicOk,
    `files=${raster.join(',')} webp=${webpLeft.length} avif=${avifLeft.length}`
  );
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log(`\nWEBP conversion smoke — ${BASE}`);
console.log(`Asset: ${WEBP_URL}\n`);

await writeAndVerify(
  'individual-webp-original',
  `/api/convert-image?${new URLSearchParams({ url: WEBP_URL, toFormat: 'webp', originalUrl: WEBP_URL, filenameBase: 'hero' })}`,
  'webp',
  'webp',
  { allowRasterSource: true }
);

await writeAndVerify(
  'individual-webp-png',
  `/api/convert-image?${new URLSearchParams({ url: WEBP_URL, toFormat: 'png', selectedFormat: 'png', originalUrl: WEBP_URL, filenameBase: 'hero' })}`,
  'png',
  'png'
);

await writeAndVerify(
  'individual-webp-jpg',
  `/api/convert-image?${new URLSearchParams({ url: WEBP_URL, toFormat: 'jpg', selectedFormat: 'jpg', originalUrl: WEBP_URL, filenameBase: 'hero' })}`,
  'jpg',
  'jpg'
);

await testZip('zip-webp-png', 'png');
await testZip('zip-webp-jpg', 'jpg');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`Artifacts: ${OUT}\n`);

if (failed.length) {
  process.exit(1);
}
