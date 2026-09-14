import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LazyCachedImageThumb, { buildThumbCandidates } from '../src/components/LazyCachedImageThumb.tsx';
import { loadSharp } from '../src/lib/convertRasterImage.ts';
const svg = readFileSync(new URL('./fixtures/pure-inline.svg', import.meta.url), 'utf8');
const inline = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
const base64 = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const generated = 'http://localhost:3018/generated-image-thumbs/test.webp';
for (const img of [
  { url: inline },
  { url: base64, source: 'font-awesome-icon-svg' },
  { url: inline, cachedUrl: '/cached-images-original/inline.svg' },
  { url: 'https://pureforyou.com/inline.svg', dataUrl: inline },
]) {
  const asset = { ...img, type: 'svg', thumbnailUrl: generated };
  assert.equal(buildThumbCandidates(asset, '')[0], generated);
  const html = renderToStaticMarkup(React.createElement(LazyCachedImageThumb, { img: asset, alt: 'inline SVG' }));
  assert.ok(html.includes(`src="${generated}"`), 'Generated thumbnail is the rendered image source');
  assert.ok(html.includes('loading="eager"'));
  assert.ok(buildThumbCandidates(asset, '').length > 1, 'Keep SVG fallback if generated preview fails');
}
const gallery = readFileSync(new URL('../src/components/ImageExtractor.tsx', import.meta.url), 'utf8');
assert.match(gallery, /thumbnailUrl: thumbMetaByKey\[key\]\?\.thumbUrl \|\| img.thumbnailUrl/);
if (process.env.SMOKE_BASE_URL) {
  const base = process.env.SMOKE_BASE_URL;
  const bad = 'data:image/svg+xml,%ZZ';
  const response = await fetch(base + '/api/warm-image-thumbs-batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
    body: JSON.stringify({ items: [inline, base64, bad].map(url => ({ originalUrl: url })) }),
  });
  assert.ok(response.ok, String(response.status));
  const result = await response.json();
  assert.equal(result.warmed, 2);
  assert.equal(result.results[bad].ok, false);
  const sharp = await loadSharp();
  for (const url of [inline, base64]) {
    const meta = result.results[url];
    assert.ok(meta.ok && meta.thumbUrl && meta.width > 0 && meta.height > 0);
    assert.equal(meta.format, 'svg');
    const image = await fetch(base + meta.thumbUrl);
    assert.ok(image.ok);
    const buffer = Buffer.from(await image.arrayBuffer());
    assert.equal((await sharp(buffer).metadata()).format, 'webp');
    const stats = await sharp(buffer).ensureAlpha().stats();
    assert.ok(stats.channels[3].max > 0, 'Thumbnail contains visible pixels');
  }
  console.log('PASS: Pure inline SVG POST generation, retrievable WebP previews, and invalid-input isolation.');
}
console.log('PASS: Generated inline SVG thumbnails take priority in rendered image cards, with fallbacks retained.');
