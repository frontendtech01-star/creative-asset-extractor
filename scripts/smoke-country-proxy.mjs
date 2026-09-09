import assert from 'node:assert/strict';
import { countryProxyStatus, resolveCountryProxy } from '../server/country-proxy.ts';
import { matchesOpenChromeUrl, validateOpenChromeCapture } from '../server/open-chrome-capture.ts';

assert.equal(resolveCountryProxy('', {}), '');
assert.throws(() => resolveCountryProxy('US', {}), /not configured/);
assert.throws(() => resolveCountryProxy('ZZ', {}), /Choose/);
assert.throws(() => resolveCountryProxy('US', { EXTRACTION_PROXY_US: 'dummy' }), /invalid/);
assert.throws(() => resolveCountryProxy('US', { EXTRACTION_PROXY_US: 'socks5://example.test:1080' }), /HTTP/);
const env = { EXTRACTION_PROXY_US: 'http://test-user:test-password@proxy.example.test:8080' };
assert.equal(resolveCountryProxy('US', env), env.EXTRACTION_PROXY_US + '/');
const status = countryProxyStatus(env);
assert.deepEqual(status.map((item) => item.configured), [true, false, false, false]);
assert.ok(!JSON.stringify(status).includes('test-password'));
assert.ok(!JSON.stringify(status).includes('proxy.example.test'));
console.log('PASS country proxies: supported regions, missing/invalid configuration, and credential-free status');
assert.ok(matchesOpenChromeUrl('https://example.com/', 'https://example.com'));
for (const candidate of ['https://example.com/other', 'https://example.com/?region=NZ', 'https://other.example/', 'not a URL']) {
  assert.equal(matchesOpenChromeUrl(candidate, 'https://example.com/'), false);
}
assert.throws(() => validateOpenChromeCapture({ ok: true, url: 'https://example.com/other' }, 'https://example.com/'), /navigated/);
assert.throws(() => validateOpenChromeCapture({ ok: false, url: 'https://example.com/' }, 'https://example.com/'), /could not capture/);
const capture = { ok: true, url: 'https://example.com/', images: [{ url: 'https://example.com/image.png', dataUrl: 'data:image/png;base64,test' }] };
assert.equal(validateOpenChromeCapture(capture, 'https://example.com/'), capture);
console.log('PASS open Chrome capture: exact URL, navigation rejection, failed capture, and retained inline previews');
