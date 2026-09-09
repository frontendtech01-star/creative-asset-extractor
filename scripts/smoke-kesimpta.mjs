import assert from 'node:assert/strict';
import { extractKalturaVideosFromHtml } from '../server/kaltura.ts';

const fixture = (value) => `<script type="application/json">${JSON.stringify(value)}</script>`;
const config = { partnerId: '2076321', id: '1_wcyrxu3j' };
assert.equal(extractKalturaVideosFromHtml(fixture({ references: [config, config] }), '').length, 1);
assert.equal(extractKalturaVideosFromHtml(fixture({ id: '1_wcyrxu3j' }), '').length, 0);
assert.equal(extractKalturaVideosFromHtml(fixture({ ...config, partnerId: '0' }), '').length, 0);
const page = 'https://www.kesimptahcp.com/dosing-and-administration';
const response = await fetch(`${process.env.QC_API || 'http://127.0.0.1:3000'}/api/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
  body: JSON.stringify({ url: page, mode: 'static' }),
  signal: AbortSignal.timeout(180000),
});
assert.ok(response.ok, `Extraction returned ${response.status}`);
const result = await response.json();
const image = result.images?.find((item) => /3\.1-pen_v2_3\.1-pen_xl-desktop_1\.png/.test(item.url));
assert.ok(image, 'Missing full pen image containing the four ticks');
const imageResponse = await fetch(image.url);
assert.ok(imageResponse.ok, 'Pen image is not downloadable');
assert.match(imageResponse.headers.get('content-type'), /image\//);
const video = result.videos?.find((item) => /\/p\/2076321\/.*entryId\/1_wcyrxu3j\//.test(item.sourceStreamUrl || item.url));
assert.ok(video, 'Missing Kaltura dosing video');
assert.ok(video.thumbnail, 'Missing video thumbnail');
const manifestResponse = await fetch(video.sourceStreamUrl || video.url);
assert.ok(manifestResponse.ok, 'Kaltura manifest is unavailable');
const manifest = await manifestResponse.text();
assert.match(manifest, /^#EXTM3U/);
assert.match(manifest, /avc1.*mp4a/, 'Expected video and audio codecs');
console.log('PASS: Kesimpta tick-containing image downloads; dosing video resolves with thumbnail, video and audio.');
