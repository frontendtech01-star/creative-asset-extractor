#!/usr/bin/env node
/**
 * Smoke test for Creative Brief generation on phyrago.com/hcp/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const TARGET = 'https://phyrago.com/hcp/';
const HERO = 'About-PHYRAGO-Hero-Image';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.smoke-brief');
const FORBIDDEN_SECTIONS = [
  'Creative Strategy Tags',
  'Hero Assets',
  'Main Focus / Value Proposition',
  'Website Content Carousel',
  'Features / Benefits',
  'Testimonials / Reviews',
  'Gallery / Visual Showcase',
  'Recommendations',
  'Key takeaways',
  'Insights',
  'Strategy',
  'Audience',
  'Brand analysis',
  'Summary blocks',
  'Technical notes',
  'Asset reports',
];

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

fs.mkdirSync(OUT, { recursive: true });

console.log(`\nBrief smoke test: ${TARGET}\n`);

// Step 1: extract assets for cache merge
console.log('--- Extract assets ---');
const extractRes = await api('/api/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: TARGET, mode: 'static' }),
});
const extract = await extractRes.json();
const images = extract.images || [];
log('Assets extracted', images.length > 0, `${images.length} images`);

// Step 2: insights/brief with asset cache
console.log('\n--- Brief generation ---');
const briefRes = await api('/api/insights', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: TARGET, assets: { images } }),
});
const brief = await briefRes.json();
fs.writeFileSync(path.join(OUT, 'brief.json'), JSON.stringify(brief, null, 2));

log('Brief API 200', briefRes.ok, `status=${briefRes.status}`);
log('brief_tabs present', Array.isArray(brief.brief_tabs) && brief.brief_tabs.length === 3, `${brief.brief_tabs?.length || 0} tabs`);

const tab1 = brief.brief_tabs?.[0];
log('Tab 1 hero-video layout', tab1?.layout === 'hero-video', tab1?.layout || 'missing');
log('Tab 1 heading', !!tab1?.heading, tab1?.heading?.slice(0, 60) || 'empty');
log('Tab 1 CTA', !!tab1?.cta, tab1?.cta || 'empty');
log('Tab 1 hero image URL', !!(tab1?.hero_image?.url || tab1?.hero_image?.preview_url), tab1?.hero_image?.url?.slice(0, 80) || 'none');
log('Hero image prioritized', String(tab1?.hero_image?.url || '').includes(HERO), tab1?.hero_image?.url?.split('/').pop()?.slice(0, 50) || 'n/a');

const tab2Slides = brief.brief_tabs?.[1]?.slides || [];
const tab3Slides = brief.brief_tabs?.[2]?.slides || [];
log('Tab 2 slides', tab2Slides.length > 0, `${tab2Slides.length} slides`);
log('Tab 3 slides', tab3Slides.length > 0, `${tab3Slides.length} slides`);

const slideWithImage = [...tab2Slides, ...tab3Slides].some((s) => s.image?.url || s.image?.preview_url);
log('Tab 2/3 images assigned', slideWithImage || tab2Slides.some((s) => (s.media_assets || []).length), slideWithImage ? 'image slides found' : 'video gallery or images');

// Step 3: verify hero image loads via preview API
console.log('\n--- Brief image fetch ---');
const heroRemote = tab1?.hero_image?.url || '';
const heroPreview = tab1?.hero_image?.preview_url;
let heroFetchUrl = '';
if (heroPreview?.startsWith('/cached-images-original/')) {
  heroFetchUrl = `${BASE}${heroPreview}`;
} else if (heroRemote) {
  heroFetchUrl = `${BASE}/api/image-preview?url=${encodeURIComponent(heroRemote)}`;
}

if (heroFetchUrl) {
  const heroRes = await api(heroFetchUrl.replace(BASE, ''));
  const heroBuf = Buffer.from(await heroRes.arrayBuffer());
  const isJpeg = heroBuf[0] === 0xff && heroBuf[1] === 0xd8;
  log('Hero image bytes load', heroRes.ok && heroBuf.length > 1000, `${heroBuf.length} bytes, jpeg=${isJpeg}`);
} else {
  log('Hero image bytes load', false, 'no preview URL');
}

// Step 4: ISI + Indication
console.log('\n--- ISI + Indication ---');
log('Indication extracted', !!(brief.indication && brief.indication.length > 20), `${brief.indication?.length || 0} chars`);
log('ISI extracted', !!(brief.important_safety_information && brief.important_safety_information.length > 20), `${brief.important_safety_information?.length || 0} chars`);
log('Indication not summarized', !/\.\.\.|…|\[truncated\]/i.test(brief.indication || ''), 'no truncation markers');
log('ISI not summarized', !/\.\.\.|…|\[truncated\]/i.test(brief.important_safety_information || ''), 'no truncation markers');

// Step 5: forbidden legacy fields should exist in JSON but UI component removed them
// Verify response still has internal fields (ok) - smoke test checks structure not UI
log('Unwanted sections not required in brief_tabs', !brief.brief_tabs?.some((t) => t.keywords), 'brief_tabs clean');

// Step 6: read AiInsights source for forbidden section titles (static check)
const aiSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/AiInsights.tsx'), 'utf8');
for (const section of FORBIDDEN_SECTIONS) {
  const inUi = section === 'Insights'
    ? /<h4[^>]*>[^<]*Insights/i.test(aiSource) || /title="Insights"/i.test(aiSource)
    : aiSource.includes(section);
  log(`UI excludes "${section}"`, !inUi, inUi ? 'still in component' : 'removed');
}

console.log('\n=== SUMMARY ===');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFailed:');
  failed.forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  process.exit(1);
}
