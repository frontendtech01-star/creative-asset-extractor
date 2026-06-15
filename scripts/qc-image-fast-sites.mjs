#!/usr/bin/env node
/**
 * QC image extraction in fast mode (mode: 'static' → extractStaticAssets fast path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.qc-image-fast');
const EXTRACT_MS = Number(process.env.QC_EXTRACT_MS || 90000);
const WARM_MS = Number(process.env.QC_WARM_MS || 120000);

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
  'https://nestasia.in/products/lemon-drink-dispenser-6000ml',
  'http://vaaree.com/collections/king-size-bedsheets',
];

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

const siteSlug = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0];
  } catch {
    return 'site';
  }
};

const isLikelyHero = (img) => {
  const u = String(img?.url || '').toLowerCase();
  return /hero|banner|logo|product|main|cover|og|featured/.test(u);
};

async function qcSite(targetUrl) {
  const slug = siteSlug(targetUrl);
  const row = {
    url: targetUrl,
    slug,
    extract: { ok: false, ms: 0, images: 0, cached: 0, error: '' },
    warm: { ok: false, ms: 0, warmed: 0, total: 0, error: '' },
    preview: { ok: false, detail: 'skipped' },
    issues: [],
  };

  let images = [];

  try {
    const t0 = Date.now();
    const extractRes = await withTimeout(
      api('/api/extract', {
        method: 'POST',
        body: JSON.stringify({ url: targetUrl, mode: 'static', extractionMode: 'full' }),
      }),
      EXTRACT_MS,
      'extract'
    );
    row.extract.ms = Date.now() - t0;
    const extract = await extractRes.json().catch(() => ({}));
    if (!extractRes.ok) {
      row.extract.error = extract?.error || `HTTP ${extractRes.status}`;
      row.issues.push(`extract: ${row.extract.error}`);
    } else {
      images = Array.isArray(extract.images) ? extract.images : [];
      row.extract.ok = true;
      row.extract.images = images.length;
      row.extract.cached = images.filter((img) =>
        String(img?.cachedUrl || '').startsWith('/cached-images-original/')
      ).length;
      if (images.length === 0) row.issues.push('extract: no images');
    }
  } catch (error) {
    row.extract.error = error.message;
    row.issues.push(`extract: ${error.message}`);
  }

  if (!images.length) return row;

  try {
    const t0 = Date.now();
    const warmRes = await withTimeout(
      api('/api/warm-image-cache-batch', {
        method: 'POST',
        body: JSON.stringify({
          sourcePageUrl: targetUrl,
          items: images.slice(0, 120).map((img) => ({
            url: String(img?.url || '').trim(),
            originalUrl: String(img?.url || '').trim(),
          })),
        }),
      }),
      WARM_MS,
      'warm-batch'
    );
    row.warm.ms = Date.now() - t0;
    const warm = await warmRes.json().catch(() => ({}));
    if (!warmRes.ok) {
      row.warm.error = warm?.error || `HTTP ${warmRes.status}`;
      row.issues.push(`warm: ${row.warm.error}`);
    } else {
      row.warm.ok = true;
      row.warm.warmed = Number(warm?.warmed || 0);
      row.warm.total = Number(warm?.total || images.length);
      if (row.warm.warmed <= 0) row.issues.push('warm: zero images cached');
    }
  } catch (error) {
    row.warm.error = error.message;
    row.issues.push(`warm: ${error.message}`);
  }

  const sample =
    images.find((img) => isLikelyHero(img) && String(img?.url || '').startsWith('http')) ||
    images.find((img) => String(img?.url || '').startsWith('http')) ||
    images[0];

  if (sample?.url) {
    try {
      const remote = String(sample.url).trim();
      const cached = String(sample.cachedUrl || '').trim();
      const warmKey = remote;
      const params = new URLSearchParams({
        url: cached.startsWith('/cached-images-original/') ? cached : remote,
      });
      if (remote.startsWith('http')) params.set('originalUrl', remote);
      params.set('sourcePageUrl', targetUrl);
      const previewRes = await withTimeout(api(`/api/image-preview?${params}`), 30000, 'preview');
      const buf = Buffer.from(await previewRes.arrayBuffer());
      const head = buf.slice(0, 16).toString('hex');
      const isHtml = buf.toString('utf8', 0, 80).toLowerCase().includes('<!doctype');
      const isPng = head.startsWith('89504e47');
      const isJpg = head.startsWith('ffd8ff');
      const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
      const isSvg = buf.toString('utf8', 0, 200).trim().startsWith('<svg');
      row.preview.ok = previewRes.ok && buf.length > 100 && !isHtml && (isPng || isJpg || isWebp || isSvg);
      row.preview.detail = row.preview.ok
        ? `${buf.length}b ${isPng ? 'png' : isJpg ? 'jpg' : isWebp ? 'webp' : isSvg ? 'svg' : 'img'}`
        : previewRes.ok
          ? `bad-bytes ${buf.length}`
          : `HTTP ${previewRes.status}`;
      if (!row.preview.ok) row.issues.push(`preview: ${row.preview.detail}`);
    } catch (error) {
      row.preview.detail = error.message;
      row.issues.push(`preview: ${error.message}`);
    }
  }

  return row;
}

fs.mkdirSync(OUT, { recursive: true });

console.log(`Image fast-mode QC → ${BASE}\n`);

const rows = [];
for (const url of SITES) {
  process.stdout.write(`QC ${siteSlug(url)}… `);
  const row = await qcSite(url);
  rows.push(row);
  const status = row.issues.length === 0 ? 'PASS' : 'FAIL';
  console.log(
    `${status} | ${row.extract.images} img (${row.extract.cached} cached) ${Math.round(row.extract.ms / 1000)}s | warm ${row.warm.warmed}/${row.warm.total} | preview ${row.preview.ok ? '✓' : '✗'}`
  );
  if (row.issues.length) console.log(`       ${row.issues.join('; ')}`);
}

const summary = {
  ranAt: new Date().toISOString(),
  base: BASE,
  totals: {
    sites: rows.length,
    extractOk: rows.filter((r) => r.extract.ok && r.extract.images > 0).length,
    warmOk: rows.filter((r) => r.warm.ok && r.warm.warmed > 0).length,
    previewOk: rows.filter((r) => r.preview.ok).length,
    pass: rows.filter((r) => r.issues.length === 0).length,
  },
  rows,
};

fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

const md = [
  '# Image Fast-Mode QC',
  '',
  `Base: ${BASE}`,
  '',
  '| Site | Images | Cached | Extract | Warm | Preview | Status | Issues |',
  '|------|--------|--------|---------|------|---------|--------|--------|',
  ...rows.map((r) => {
    const status = r.issues.length === 0 ? 'PASS' : 'FAIL';
    return `| ${r.slug} | ${r.extract.images} | ${r.extract.cached} | ${Math.round(r.extract.ms / 1000)}s | ${r.warm.warmed}/${r.warm.total} | ${r.preview.ok ? '✓' : '✗'} | ${status} | ${r.issues.slice(0, 2).join('; ') || '—'} |`;
  }),
  '',
  `**Pass:** ${summary.totals.pass}/${summary.totals.sites} | **Extract:** ${summary.totals.extractOk}/${summary.totals.sites} | **Warm:** ${summary.totals.warmOk}/${summary.totals.sites} | **Preview:** ${summary.totals.previewOk}/${summary.totals.sites}`,
  '',
];

fs.writeFileSync(path.join(OUT, 'REPORT.md'), md.join('\n'));

console.log('\n=== SUMMARY ===');
console.log(`Pass: ${summary.totals.pass}/${summary.totals.sites}`);
console.log(`Extract OK: ${summary.totals.extractOk}/${summary.totals.sites}`);
console.log(`Warm OK: ${summary.totals.warmOk}/${summary.totals.sites}`);
console.log(`Preview OK: ${summary.totals.previewOk}/${summary.totals.sites}`);
console.log(`Report: ${path.join(OUT, 'REPORT.md')}`);

process.exit(summary.totals.pass === summary.totals.sites ? 0 : 1);
