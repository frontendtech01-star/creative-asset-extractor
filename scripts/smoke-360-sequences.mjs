import { imageSequenceSeedMetadata } from '../server/image-sequence-metadata.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { discoverLexusSequences, verifyLexusSequences } from '../server/lexus-sequences.ts';
import { imageSequenceFolder } from '../src/lib/imageSequenceDownload.ts';

const page = 'https://www.lexus.com/models/NX-hybrid?trim=nxh-1';
const base = 'https://tmna.assetscs.toyota.com/is/image/lexusaemcs/lexus/images/models/nx/2026/visualizer-1/350h/exterior/18-in-15-spoke-alloy-wheels-with-gray-metallic-and-machined-finish/';
const colors = ['Ultra White', 'Atomic Silver', 'Cloudburst Gray', 'Caviar', 'Infrared', 'Copper Crest', 'Nori Green Pearl', 'Grecian Water'];
const image = (frame) => `<img src="${base}ultra-white/large-${frame}.jpg?extend=-17,-585,-17,-585&amp;hei=628&amp;wid=1440&amp;qlt=100">`;
const swatch = (name) => `<label><input type="radio" name="exterior" aria-label="${name}"></label>`;
const fixture = `<section><div>${Array.from({ length: 18 }, (_, i) => image(i + 1)).join('')}</div><div>${colors.map(swatch).join('')}</div></section><section>${swatch('Black NuLuxe')}</section>`;
const rows = discoverLexusSequences(fixture, page);
assert.equal(rows.length, 144);
assert.equal(new Set(rows.map((row) => row.url)).size, 144);
assert.deepEqual(new Set(rows.map((row) => row.sequenceColor)), new Set(colors));
for (const color of colors) assert.deepEqual(rows.filter((row) => row.sequenceColor === color).map((row) => row.sequenceFrame), Array.from({ length: 18 }, (_, i) => i + 1));
assert.ok(rows.every((row) => new URL(row.url).search === '?extend=-17,-585,-17,-585&hei=628&wid=1440&qlt=100'));
assert.equal(discoverLexusSequences(fixture, 'https://notlexus.com').length, 0);
assert.equal(discoverLexusSequences(fixture.replaceAll('tmna.assetscs.toyota.com', 'example.com'), page).length, 0);
assert.equal(discoverLexusSequences(`<section>${image(1)}${colors.map(swatch).join('')}</section>`, page).length, 0);
const sparse = discoverLexusSequences(`<section>${image(1)}${image(3)}${colors.map(swatch).join('')}</section>`, page);
assert.ok(sparse.every((row) => [1, 3].includes(row.sequenceFrame)), 'Do not invent unobserved frames');
const rejected = rows.find((row) => row.sequenceColor === 'Caviar' && row.sequenceFrame === 9).url;
let checks = 0;
const verified = await verifyLexusSequences([...rows, ...rows, { url: 'https://example.com/logo.png', source: 'img' }], async (url) => {
  checks += 1;
  return url !== rejected;
});
assert.equal(checks, 144, 'Check each unique candidate exactly once');
assert.equal(verified.length, 144, '143 working frames plus ordinary image');
assert.ok(!verified.some((row) => row.url === rejected));
assert.equal(verified.filter((row) => row.sequenceVerified).length, 143);
const folders = colors.map((color) => imageSequenceFolder(`${base}${color}/large-.jpg`, `360 ${color}`));
assert.equal(new Set(folders).size, 8);
assert.notEqual(imageSequenceFolder('wheels-a', '360 Ultra White'), imageSequenceFolder('wheels-b', '360 Ultra White'));
assert.ok(!imageSequenceFolder('x', '../../bad/name').includes('/'));
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
assert.match(server, /sequenceHtml:.*document\.body\.outerHTML/);
assert.match(server, /discoverLexusSequences\(String\(raw\?\.sequenceHtml/);
assert.match(server, /sequenceColor: image\.sequenceColor/);
assert.match(server, /items = await verifyLexusSequences/);
if (process.env.QC_LIVE === '1') {
  // Public image requests only; no browser session is needed.
  for (const color of colors) {
    const row = rows.find((item) => item.sequenceColor === color && item.sequenceFrame === 18);
    const response = await fetch(row.url, { signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, `${color}: HTTP ${response.status}`);
    assert.match(response.headers.get('content-type') || '', /image\//);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes[0], 255); assert.equal(bytes[1], 216);
  }
  const hashes = new Set();
  for (const row of rows.filter((item) => item.sequenceColor === 'Atomic Silver')) {
    const response = await fetch(row.url, { signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok);
    hashes.add(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'));
  }
  assert.equal(hashes.size, 18, 'Every rotation frame must contain different image bytes');
  console.log('PASS: All 18 Atomic Silver frames contain different image bytes.');
  console.log('PASS: Final rotation frame downloads as JPEG for all 8 live Lexus colors.');
}
console.log('PASS: 144 color frames, scoped discovery, query preservation, failed-frame filtering, metadata and separate ZIP folders.');

const cleanSeed = imageSequenceSeedMetadata({ url: 'seed.jpg', cachedUrl: '/seed.jpg', dataUrl: 'data:image/jpeg;base64,seed', thumbnailUrl: '/seed.webp', previewUrl: '/seed.png', lqip: 'seed', width: 320, height: 140, size: 123, sequenceColor: 'Caviar' });
assert.deepEqual(cleanSeed, { url: 'seed.jpg', sequenceColor: 'Caviar' });
// Exercise the actual server parser without starting the HTTP server.
const parserSource = server.slice(server.indexOf('const parseExpandableImageSequence ='), server.indexOf('const imageSequenceFrameUrl ='));
const parseSequence = new Function('isLikely360SequenceUrl', 'MAX_IMAGE_SEQUENCE_FRAMES', parserSource.replace(/: string/g, '').replace(/let parsed: URL/g, 'let parsed') + '; return parseExpandableImageSequence;')(() => true, 120);
assert.equal(parseSequence('https://delivery.lcom.assetscs.lexus.com/adobe/assets/urn:aaid:aem:example/as/Lexus-NXH-MY26-0003-1.jpg'), null);
assert.equal(parseSequence(base + 'ultra-white/large-2.jpg').frame, 2);
console.log('PASS: Adobe aliases are not frames; generated frames cannot inherit seed image bytes.');
