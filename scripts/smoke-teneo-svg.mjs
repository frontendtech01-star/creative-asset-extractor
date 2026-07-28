import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const SITE = 'https://www.bauschsurgical.com/refractive/teneo/#VIDEOS';
const EXPECTED = [
  'teneo-target.svg',
  'teneo-map.svg',
  'teneo-screen-icon.svg',
  'teneo-customer-experience.svg',
];
const headers = {
  'Content-Type': 'application/json',
  'X-VDX-Local-Request': '1',
};

const fail = (message) => {
  throw new Error(message);
};

const fetchJson = async (url, init = {}, timeoutMs = 180000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) fail(json?.error || `HTTP ${response.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const extraction = await fetchJson(`${API}/api/extract`, {
  method: 'POST',
  body: JSON.stringify({ url: SITE, mode: 'static' }),
});
const images = Array.isArray(extraction?.images) ? extraction.images : [];
const selected = EXPECTED.map((filename) => {
  const image = images.find((item) => String(item?.filename || '').toLowerCase() === filename);
  if (!image) fail(`Extraction did not return ${filename}`);
  if (String(image.type || '').toLowerCase() !== 'svg') fail(`${filename} was not classified as SVG`);
  return image;
});

const savedPaths = [];
try {
  for (const image of selected) {
    const originalUrl = String(image.url || '').trim();
    const cachedUrl = String(image.cachedUrl || '').trim();
    const requestUrl = cachedUrl.startsWith('/cached-images-original/') ? cachedUrl : originalUrl;
    const params = new URLSearchParams({
      url: requestUrl,
      originalUrl,
      metadataFilename: String(image.filename),
      sourcePageUrl: SITE,
      save: '1',
    });
    const saved = await fetchJson(`${API}/api/download-image?${params.toString()}`, {}, 90000);
    const savedPath = String(saved?.downloadPath || saved?.localPath || '');
    if (!savedPath) fail(`${image.filename} returned no saved path`);
    savedPaths.push(savedPath);
    if (path.extname(savedPath).toLowerCase() !== '.svg') {
      fail(`${image.filename} was saved with the wrong extension: ${path.basename(savedPath)}`);
    }
    const bytes = await fs.readFile(savedPath);
    if (!/<svg\b/i.test(bytes.slice(0, 2048).toString('utf8'))) {
      fail(`${image.filename} saved bytes are not SVG markup`);
    }
    console.log(`OK ${path.basename(savedPath)}: ${bytes.length} bytes, SVG markup verified`);
  }
  console.log(`PASS: ${savedPaths.length} TENEO SVG cards saved as real .svg files`);
} finally {
  await Promise.all(savedPaths.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
}
