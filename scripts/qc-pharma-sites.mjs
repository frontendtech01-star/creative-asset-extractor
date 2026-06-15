#!/usr/bin/env node
/**
 * Pharma site QC: extract, downloads, brief, ISI, indication, videos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.qc-pharma');
const EXTRACT_MS = Number(process.env.QC_EXTRACT_MS || 120000);
const BRIEF_MS = Number(process.env.QC_BRIEF_MS || 90000);
const ZIP_MS = Number(process.env.QC_ZIP_MS || 180000);

const SITES = [
  'https://phyrago.com/hcp/',
  'https://www.posluma.com/',
  'https://www.wayrilz.com/us',
  'https://www.cosentyx.com/psoriatic-arthritis/index',
  'https://www.toujeo.com/',
  'https://www.iqirvohcp.com/',
  'https://www.duvyzathcp.com/how-duvyzat-works/',
  'https://www.rhapsido.com/',
  'https://www.otezlapro.com/start-today/',
  'https://us.pluvicto.com/',
  'https://www.leqviohcp.com/start-your-patients',
];

const magic = (buf) => {
  if (!buf || buf.length < 4) return 'empty';
  const h = buf.slice(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  if (h[0] === 0x89 && h[1] === 0x50) return 'png';
  if (h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.toString('utf8', 0, 80).toLowerCase().includes('<!doctype') || buf.toString('utf8', 0, 80).toLowerCase().includes('<html')) return 'html';
  if (buf.slice(0, 4).toString() === 'wOFF' || buf.slice(0, 4).toString() === 'wOF2') return 'woff';
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return 'ttf';
  return 'unknown';
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { 'X-VDX-Local-Request': '1', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const imageFilenameBase = (img, index = 0) => {
  const remote = String(img?.url || '').trim();
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

const buildFontZipItem = (font, toFormat, filenameBase) => ({
  url: String(font?.url || '').trim(),
  originalUrl: String(font?.url || '').trim(),
  status: String(font?.status || '').trim() || undefined,
  toFormat,
  originalFormat: String(font?.format || 'unknown').toLowerCase(),
  filenameBase,
  assetType: 'font',
});

const siteSlug = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return 'site';
  }
};

async function qcSite(targetUrl) {
  const slug = siteSlug(targetUrl);
  const row = {
    url: targetUrl,
    slug,
    extract: { ok: false, ms: 0, images: 0, fonts: 0, videos: 0, error: '' },
    imageDownload: { ok: false, detail: 'skipped' },
    fontDownload: { ok: false, detail: 'skipped' },
    zip: { ok: false, detail: 'skipped', added: 0, failed: 0, bytes: 0 },
    brief: { ok: false, ms: 0, tabs: 0, hero: false, error: '' },
    indication: { ok: false, chars: 0 },
    isi: { ok: false, chars: 0 },
    videos: { ok: false, count: 0, detail: '' },
    issues: [],
  };

  let extract = { images: [], fonts: [], videos: [] };

  try {
    const t0 = Date.now();
    const extractRes = await withTimeout(
      api('/api/extract', { method: 'POST', body: JSON.stringify({ url: targetUrl }) }),
      EXTRACT_MS,
      'extract'
    );
    row.extract.ms = Date.now() - t0;
    extract = await extractRes.json().catch(() => ({}));
    if (!extractRes.ok) {
      row.extract.error = extract?.error || `HTTP ${extractRes.status}`;
      row.issues.push(`extract: ${row.extract.error}`);
    } else {
      row.extract.ok = true;
      row.extract.images = extract.images?.length || 0;
      row.extract.fonts = extract.fonts?.length || 0;
      row.extract.videos = extract.videos?.length || 0;
      if (row.extract.images === 0) row.issues.push('extract: no images');
    }
  } catch (e) {
    row.extract.error = e.message;
    row.issues.push(`extract: ${e.message}`);
  }

  const images = extract.images || [];
  const fonts = extract.fonts || [];
  const videos = extract.videos || [];
  row.videos.count = videos.length;
  row.videos.ok = videos.length > 0;
  row.videos.detail = videos.length
    ? videos.slice(0, 3).map((v) => String(v.provider || v.type || 'video')).join(', ')
    : 'none';

  // Sample image download — prefer real CDN/page assets over junk AEM fragments or UI sprites.
  const isBadSampleImage = (i) => {
    const u = String(i?.url || '');
    if (/robot-suspicion|loader\.svg/i.test(u)) return true;
    if (/\/jcr:content\.(?:png|jpe?g|webp)$/i.test(u) && !/\.imaging\//i.test(u)) return true;
    if (/DynamicFormV4|help icon|error icon|sprite|favicon|arrow|chevron|icon-/i.test(u)) return true;
    if (/\.imaging\//i.test(u) && !/\/jcr:content\./i.test(u)) return true;
    return false;
  };
  const imageCandidates = [
    images.find((i) => !isBadSampleImage(i) && /\/(?:efficacy|hero|banner)\/.*\.(?:png|jpe?g)/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i) && /Otezlapro-com-Redesign.*\.(?:png|jpe?g)/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i) && /\/wp-content\/uploads\/.*\.(?:png|jpe?g)/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i) && /\.imaging\/.*jcr:content\.(?:webp|jpe?g|png)/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i) && /\.ashx(?:$|[?#])/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i) && /\.jpe?g|png/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i) && /\.(?:jpe?g|png|webp|gif)/i.test(String(i?.url || ''))),
    images.find((i) => !isBadSampleImage(i)),
    images[0],
  ].filter(Boolean);
  const imgSample = imageCandidates[0];
  if (imgSample?.url) {
    try {
      let lastDetail = '';
      for (const candidate of imageCandidates.slice(0, 5)) {
        const remote = String(candidate.url).trim();
        const cached = String(candidate.cachedUrl || '').trim();
        const downloadUrl = cached.startsWith('/cached-images-original/') ? cached : remote;
        const params = new URLSearchParams({ url: downloadUrl });
        if (remote) params.set('originalUrl', remote);
        const res = await withTimeout(api(`/api/convert-image?${params}`), 30000, 'convert-image');
        const buf = Buffer.from(await res.arrayBuffer());
        const kind = magic(buf);
        lastDetail = res.ok ? `${kind}, ${buf.length}b` : `HTTP ${res.status}`;
        if (res.ok && kind !== 'html' && buf.length > 500) {
          row.imageDownload.ok = true;
          row.imageDownload.detail = lastDetail;
          break;
        }
      }
      if (!row.imageDownload.ok) {
        row.imageDownload.detail = lastDetail || 'no valid sample';
        row.issues.push(`image download: ${row.imageDownload.detail}`);
      }
    } catch (e) {
      row.imageDownload.detail = e.message;
      row.issues.push(`image download: ${e.message}`);
    }
  } else {
    row.imageDownload.detail = 'no images';
    row.issues.push('image download: no sample');
  }

  // Sample font download
  const fontSample = fonts.find((f) => /\.(woff2?|ttf|otf)/i.test(String(f.url || ''))) || fonts[0];
  if (fontSample?.url) {
    try {
      const remote = String(fontSample.url).trim();
      const params = new URLSearchParams({
        url: remote,
        toFormat: 'ttf',
        originalFormat: String(fontSample.format || 'woff2'),
        filenameBase: String(fontSample.family || 'font').replace(/[^\w.-]+/g, '-'),
        originalUrl: remote,
      });
      const res = await withTimeout(api(`/api/convert-font?${params}`), 30000, 'convert-font');
      const buf = Buffer.from(await res.arrayBuffer());
      const kind = magic(buf);
      row.fontDownload.ok = res.ok && kind !== 'html' && buf.length > 500;
      row.fontDownload.detail = res.ok ? `${kind}, ${buf.length}b` : `HTTP ${res.status}`;
      if (!row.fontDownload.ok) row.issues.push(`font download: ${row.fontDownload.detail}`);
    } catch (e) {
      row.fontDownload.detail = e.message;
      row.issues.push(`font download: ${e.message}`);
    }
  } else {
    row.fontDownload.detail = fonts.length === 0 ? 'no fonts extracted' : 'no sample url';
    if (fonts.length === 0) row.issues.push('fonts: none extracted');
  }

  // Mini ZIP (3 images + 1 font pair if available)
  const zipItems = images.slice(0, 3).map((img, idx) => buildImageZipItem(img, idx));
  if (fontSample?.url) {
    const base = String(fontSample.family || 'font').replace(/[^\w.-]+/g, '-');
    zipItems.push(buildFontZipItem(fontSample, 'ttf', base));
  }
  if (zipItems.length > 0) {
    try {
      const zipRes = await withTimeout(
        api('/api/download-zip', { method: 'POST', body: JSON.stringify({ items: zipItems }) }),
        ZIP_MS,
        'download-zip'
      );
      const zipBuf = Buffer.from(await zipRes.arrayBuffer());
      row.zip.bytes = zipBuf.length;
      row.zip.added = Number(zipRes.headers.get('X-Zip-Added-Count') || 0);
      row.zip.failed = Number(zipRes.headers.get('X-Zip-Failed-Count') || 0);
      row.zip.ok = zipRes.ok && zipBuf.length > 64;
      row.zip.detail = zipRes.ok ? `${zipBuf.length}b, added=${row.zip.added}, failed=${row.zip.failed}` : `HTTP ${zipRes.status}`;
      if (!row.zip.ok) row.issues.push(`zip: ${row.zip.detail}`);
      else if (row.zip.failed > 0) row.issues.push(`zip: ${row.zip.failed} failed (see asset-paths.txt)`);
    } catch (e) {
      row.zip.detail = e.message;
      row.issues.push(`zip: ${e.message}`);
    }
  }

  // Brief / ISI / Indication
  try {
    const t0 = Date.now();
    const briefRes = await withTimeout(
      api('/api/insights', {
        method: 'POST',
        body: JSON.stringify({ url: targetUrl, assets: { images } }),
      }),
      BRIEF_MS,
      'insights'
    );
    row.brief.ms = Date.now() - t0;
    const brief = await briefRes.json().catch(() => ({}));
    if (!briefRes.ok) {
      row.brief.error = brief?.error || `HTTP ${briefRes.status}`;
      row.issues.push(`brief: ${row.brief.error}`);
    } else {
      row.brief.ok = true;
      row.brief.tabs = brief.brief_tabs?.length || 0;
      const tab1 = brief.brief_tabs?.[0];
      row.brief.hero = !!(tab1?.hero_image?.url || tab1?.hero_image?.preview_url);
      if (row.brief.tabs !== 3) row.issues.push(`brief: expected 3 tabs, got ${row.brief.tabs}`);
      if (!row.brief.hero) row.issues.push('brief: no hero image');
    }
    row.indication.chars = String(brief.indication || '').length;
    row.indication.ok = row.indication.chars > 40;
    row.isi.chars = String(brief.important_safety_information || '').length;
    row.isi.ok = row.isi.chars > 40;
    if (!row.indication.ok) row.issues.push(`indication: only ${row.indication.chars} chars`);
    if (!row.isi.ok) row.issues.push(`isi: only ${row.isi.chars} chars`);

    fs.writeFileSync(path.join(OUT, `${slug}-brief.json`), JSON.stringify(brief, null, 2));
  } catch (e) {
    row.brief.error = e.message;
    row.issues.push(`brief: ${e.message}`);
  }

  fs.writeFileSync(path.join(OUT, `${slug}-extract.json`), JSON.stringify({
    images: row.extract.images,
    fonts: row.extract.fonts,
    videos: row.extract.videos,
    sampleImages: images.slice(0, 5).map((i) => i.url),
    sampleFonts: fonts.slice(0, 5).map((f) => ({ family: f.family, url: f.url })),
    sampleVideos: videos.slice(0, 5).map((v) => ({ url: v.url, provider: v.provider })),
  }, null, 2));

  return row;
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`QC pharma sites → ${BASE}\n`);

const rows = [];
for (let i = 0; i < SITES.length; i++) {
  const url = SITES[i];
  console.log(`\n[${i + 1}/${SITES.length}] ${url}`);
  const row = await qcSite(url);
  rows.push(row);
  const status = row.issues.length === 0 ? 'PASS' : 'WARN';
  console.log(
    `  ${status}  extract ${row.extract.images}img/${row.extract.fonts}font/${row.extract.videos}vid ${row.extract.ms}ms | ` +
      `imgDL=${row.imageDownload.ok ? 'ok' : 'fail'} fontDL=${row.fontDownload.ok ? 'ok' : 'n/a'} zip=${row.zip.ok ? 'ok' : 'fail'} | ` +
      `brief tabs=${row.brief.tabs} ISI=${row.isi.chars}c IND=${row.indication.chars}c | issues=${row.issues.length}`
  );
  if (row.issues.length) row.issues.forEach((issue) => console.log(`    - ${issue}`));
}

const summary = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  sites: rows,
  totals: {
    sites: rows.length,
    extractOk: rows.filter((r) => r.extract.ok && r.extract.images > 0).length,
    imageDownloadOk: rows.filter((r) => r.imageDownload.ok).length,
    fontDownloadOk: rows.filter((r) => r.fontDownload.ok).length,
    zipOk: rows.filter((r) => r.zip.ok).length,
    briefOk: rows.filter((r) => r.brief.ok && r.brief.tabs === 3).length,
    isiOk: rows.filter((r) => r.isi.ok).length,
    indicationOk: rows.filter((r) => r.indication.ok).length,
    withVideos: rows.filter((r) => r.videos.count > 0).length,
    clean: rows.filter((r) => r.issues.length === 0).length,
  },
};

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));

const md = [
  '# Pharma QC Report',
  '',
  `Generated: ${summary.generatedAt}`,
  '',
  '| Site | Extract | Img DL | Font DL | ZIP | Brief | ISI | Indication | Videos | Issues |',
  '|------|---------|--------|---------|-----|-------|-----|------------|--------|--------|',
  ...rows.map((r) =>
    `| ${r.slug} | ${r.extract.images}img ${Math.round(r.extract.ms / 1000)}s | ${r.imageDownload.ok ? '✓' : '✗'} | ${r.fontDownload.ok ? '✓' : r.fontDownload.detail === 'no fonts extracted' ? '—' : '✗'} | ${r.zip.ok ? '✓' : '✗'} | ${r.brief.tabs === 3 ? '✓' : '✗'} | ${r.isi.ok ? '✓' : '✗'} (${r.isi.chars}) | ${r.indication.ok ? '✓' : '✗'} (${r.indication.chars}) | ${r.videos.count} | ${r.issues.length ? r.issues.slice(0, 2).join('; ') : '—'} |`
  ),
  '',
  `**Clean passes:** ${summary.totals.clean}/${summary.totals.sites}`,
].join('\n');

fs.writeFileSync(path.join(OUT, 'report.md'), md);

console.log('\n=== QC SUMMARY ===');
console.log(`Extract OK: ${summary.totals.extractOk}/${summary.totals.sites}`);
console.log(`Image download: ${summary.totals.imageDownloadOk}/${summary.totals.sites}`);
console.log(`Font download: ${summary.totals.fontDownloadOk}/${summary.totals.sites}`);
console.log(`ZIP: ${summary.totals.zipOk}/${summary.totals.sites}`);
console.log(`Brief (3 tabs): ${summary.totals.briefOk}/${summary.totals.sites}`);
console.log(`ISI: ${summary.totals.isiOk}/${summary.totals.sites}`);
console.log(`Indication: ${summary.totals.indicationOk}/${summary.totals.sites}`);
console.log(`Sites with videos: ${summary.totals.withVideos}/${summary.totals.sites}`);
console.log(`Fully clean: ${summary.totals.clean}/${summary.totals.sites}`);
console.log(`\nReport: ${path.join(OUT, 'report.md')}`);

process.exit(summary.totals.clean === summary.totals.sites ? 0 : 1);
