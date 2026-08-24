import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import extractZip from 'extract-zip';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const OUTPUT_ROOT = process.env.TYPEKIT_FONT_OUTPUT || path.join(os.homedir(), 'Downloads', 'Typekit_Fonts');
const KITS = ['https://use.typekit.net/tzy4ptk.css', 'https://use.typekit.net/bbu6zls.css'];
const headers = { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' };

const safeName = (value, fallback = 'font') =>
  String(value || fallback).replace(/[^a-z0-9 ._-]/gi, '').trim().replace(/\s+/g, '-') || fallback;
const weightName = (weight) => ({
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
})[Number(weight)] || String(weight || 'Regular');

const resolvedResponse = await fetch(`${API}/api/resolve-font-links`, {
  method: 'POST', headers, body: JSON.stringify({ urls: KITS }),
});
const resolved = await resolvedResponse.json().catch(() => ({}));
if (!resolvedResponse.ok || resolved?.ok === false) throw new Error(resolved?.error || 'Could not resolve Typekit fonts.');
const fonts = Array.isArray(resolved.fonts) ? resolved.fonts : [];
if (fonts.length !== 13) throw new Error(`Expected 13 distinct Typekit faces, found ${fonts.length}.`);

const items = fonts.flatMap((font) => {
  const family = String(font.family || 'font').trim();
  const style = /italic|oblique/i.test(String(font.style || '')) ? 'Italic' : '';
  const basename = safeName([family, weightName(font.weight), style].filter(Boolean).join('-'));
  return ['ttf', 'woff'].map((toFormat) => ({
    url: String(font.url),
    originalUrl: String(font.url),
    cssSource: String(font.cssSource),
    fontFamily: family,
    fontWeight: String(font.weight || '400'),
    fontStyle: String(font.style || 'normal'),
    originalFormat: String(font.format || 'woff2'),
    filenameBase: basename,
    metadataFilename: basename,
    zipEntryName: `fonts/${basename}.${toFormat}`,
    assetType: 'font',
    toFormat,
    fixVerticalMetrics: true,
  }));
});

const zipResponse = await fetch(`${API}/api/download-zip`, {
  method: 'POST', headers, body: JSON.stringify({ items }),
});
if (!zipResponse.ok) throw new Error((await zipResponse.text()).slice(0, 500) || 'Font ZIP conversion failed.');
const added = Number(zipResponse.headers.get('x-zip-added-count') || 0);
const failed = Number(zipResponse.headers.get('x-zip-failed-count') || 0);
if (added !== items.length || failed !== 0) throw new Error(`Converted ${added}/${items.length} fonts; ${failed} failed.`);

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
const zipPath = path.join(OUTPUT_ROOT, 'typekit-fonts-ttf-woff.zip');
await fs.writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()));
const verifyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cae-typekit-flat-fonts-'));
try {
  await extractZip(zipPath, { dir: verifyRoot });
  const fontDir = path.join(verifyRoot, 'fonts');
  const entries = await fs.readdir(fontDir, { withFileTypes: true });
  if (entries.length !== items.length || entries.some((entry) => !entry.isFile())) {
    throw new Error(`Expected ${items.length} flat files in fonts/, found ${entries.length}.`);
  }
} finally {
  await fs.rm(verifyRoot, { recursive: true, force: true });
}
await extractZip(zipPath, { dir: OUTPUT_ROOT });
console.log(`PASS: wrote ${items.length} converted files to ${OUTPUT_ROOT}`);
console.log('PASS: ZIP contains one flat fonts/ folder with every converted face');
console.log(`ZIP: ${zipPath}`);
