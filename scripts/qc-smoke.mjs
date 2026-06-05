import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import extractZip from 'extract-zip';
import { resolveSmokeOutDir } from './lib/smoke-out-dir.mjs';

const API = process.env.QC_API || 'http://127.0.0.1:3000';
const OUT_DIR = resolveSmokeOutDir('qc', 'https://www.posluma.com/');
const REPORT_PATH = path.join(OUT_DIR, 'report.json');

const allSites = [
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

const onlyPattern = String(process.env.QC_ONLY || '').trim();
const sites = onlyPattern
  ? allSites.filter((site) => site.toLowerCase().includes(onlyPattern.toLowerCase()))
  : allSites;

const platformVideos = [
  { provider: 'youtube', url: 'https://www.youtube.com/watch?v=jhRoOonf58I' },
  { provider: 'vimeo', url: 'https://vimeo.com/76979871' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (url, options = {}, timeoutMs = 60000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const postJson = async (pathName, body, timeoutMs) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VDX-Local-Request': '1',
    },
    body: JSON.stringify(body),
  }, timeoutMs);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text || 'Invalid JSON' };
  }
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
};

const getBuffer = async (pathName, timeoutMs = 60000) => {
  const response = await fetchWithTimeout(`${API}${pathName}`, {
    headers: { 'X-VDX-Local-Request': '1' },
  }, timeoutMs);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      reason = JSON.parse(buffer.toString('utf8')).error || reason;
    } catch {}
    throw new Error(reason);
  }
  return {
    buffer,
    contentType: response.headers.get('content-type') || '',
    disposition: response.headers.get('content-disposition') || '',
  };
};

const extFromUrl = (url = '') => {
  try {
    return path.extname(new URL(url, 'http://localhost').pathname).slice(1).toLowerCase();
  } catch {
    return '';
  }
};

const imageType = (img) => String(img?.type || extFromUrl(img?.url) || '').toLowerCase();

const imageFilenameBase = (img, index = 0) => {
  const rawUrl = String(img?.url || img?.cachedUrl || '');
  const raw = rawUrl.split('/').pop()?.split('?')[0] || `image-${index + 1}`;
  return raw.replace(/\.[^/.]+$/, '') || `image-${index + 1}`;
};

const imageDownloadUrl = (img) => {
  const remote = String(img?.url || '').trim();
  if (remote.startsWith('data:')) return remote;
  const cached = String(img?.cachedUrl || '').trim();
  if (cached) return cached;
  return remote;
};

const imageZipItem = (img, index = 0) => {
  const type = imageType(img);
  const item = {
    url: imageDownloadUrl(img),
    originalUrl: String(img?.url || ''),
    status: String(img?.status || '') || undefined,
    assetType: 'image',
    filenameBase: imageFilenameBase(img, index),
  };
  if (type === 'webp') item.toFormat = 'jpg';
  if (type === 'avif') item.toFormat = 'png';
  return item;
};

const assertImageSignature = (buffer, expected) => {
  if (expected === 'png') return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (expected === 'jpg' || expected === 'jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (expected === 'gif') return buffer.slice(0, 3).toString('ascii') === 'GIF';
  if (expected === 'svg') return /<svg|<\?xml/i.test(buffer.slice(0, 512).toString('utf8'));
  if (expected === 'webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  if (expected === 'avif') return buffer.slice(4, 8).toString('ascii') === 'ftyp';
  return buffer.length > 64;
};

const listFiles = async (dir) => {
  const out = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
};

const extractAndInspectZip = async (zipBuffer, label) => {
  const zipPath = path.join(OUT_DIR, `${label}.zip`);
  const dir = path.join(OUT_DIR, `${label}-unzipped`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(zipPath, zipBuffer);
  await extractZip(zipPath, { dir });
  const files = await listFiles(dir);
  const stats = await Promise.all(files.map(async (file) => ({
    file,
    name: path.basename(file),
    size: (await fs.stat(file)).size,
    head: (await fs.readFile(file)).slice(0, 16).toString('hex'),
  })));
  return { zipPath, dir, files: stats };
};

const findFirstDownloadableImage = (images) =>
  images.find((img) => img?.cachedUrl && imageDownloadUrl(img) && imageType(img) !== 'svg') ||
  images.find((img) => img?.status === 'downloaded' && imageDownloadUrl(img) && imageType(img) !== 'svg') ||
  images.find((img) => imageDownloadUrl(img) && imageType(img) !== 'svg') ||
  images.find((img) => imageDownloadUrl(img));

const runSite = async (site, index) => {
  const id = `site-${String(index + 1).padStart(2, '0')}`;
  const result = { site, ok: false, checks: {}, failures: [] };
  try {
    const extracted = await postJson('/api/extract', { url: site, mode: 'static' }, 90000);
    const images = Array.isArray(extracted.images) ? extracted.images : [];
    const fonts = Array.isArray(extracted.fonts) ? extracted.fonts : [];
    const videos = Array.isArray(extracted.videos) ? extracted.videos : [];
    const colors = Array.isArray(extracted.colors) ? extracted.colors : [];
    result.counts = { images: images.length, fonts: fonts.length, videos: videos.length, colors: colors.length };
    result.checks.extraction = images.length > 0 || fonts.length > 0 || videos.length > 0 || colors.length > 0;
    if (!result.checks.extraction) result.failures.push('No assets extracted');
    result.checks.imagesListed = images.length > 0;
    if (!images.length) result.failures.push('No images listed');

    const image = findFirstDownloadableImage(images);
    if (image) {
      const type = imageType(image);
      const target = type === 'webp' ? 'jpg' : type === 'avif' ? 'png' : '';
      const query = `/api/convert-image?url=${encodeURIComponent(imageDownloadUrl(image))}${target ? `&toFormat=${target}` : ''}`;
      const downloaded = await getBuffer(query, 45000);
      const expected = target || (type === 'jpeg' ? 'jpg' : type);
      result.checks.individualImageDownload = downloaded.buffer.length > 64 && assertImageSignature(downloaded.buffer, expected);
      result.individualImage = { url: image.url, cachedUrl: image.cachedUrl, type, size: downloaded.buffer.length, expected };
      if (!result.checks.individualImageDownload) result.failures.push('Individual image download signature failed');
    } else {
      result.checks.individualImageDownload = false;
      result.failures.push('No image available for individual download');
    }

    const convertible = images.find((img) => ['webp', 'avif'].includes(imageType(img)) && imageDownloadUrl(img));
    if (convertible) {
      const type = imageType(convertible);
      const target = type === 'webp' ? 'jpg' : 'png';
      const converted = await getBuffer(`/api/convert-image?url=${encodeURIComponent(imageDownloadUrl(convertible))}&toFormat=${target}`, 45000);
      result.checks.webpAvifConversion = assertImageSignature(converted.buffer, target);
      result.conversion = { url: convertible.url, type, target, size: converted.buffer.length };
      if (!result.checks.webpAvifConversion) result.failures.push(`${type.toUpperCase()} conversion did not produce ${target.toUpperCase()}`);
    } else {
      result.checks.webpAvifConversion = 'not-present';
    }

    const zipImages = images.map(imageZipItem);
    const zipResponse = await fetchWithTimeout(`${API}/api/download-zip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VDX-Local-Request': '1',
      },
      body: JSON.stringify({ items: zipImages }),
    }, 120000);
    const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
    if (!zipResponse.ok) {
      throw new Error(`ZIP failed: ${zipBuffer.toString('utf8').slice(0, 200)}`);
    }
    const zip = await extractAndInspectZip(zipBuffer, id);
    const names = zip.files.map((file) => file.name);
    const hasFiles = zip.files.some((file) => file.size > 0 && file.name !== 'asset-paths.txt');
    const badConvertedNames = names.filter((name) => /\.(webp|avif)$/i.test(name));
    result.checks.downloadAllZip = zipBuffer.length > 64 && zip.files.length > 0;
    result.checks.zipExtracts = zip.files.length > 0;
    result.checks.zipHasOpenableFiles = hasFiles;
    result.checks.zipNoWebpAvifForConverted = badConvertedNames.length === 0;
    result.zip = {
      size: zipBuffer.length,
      fileCount: zip.files.length,
      sampleNames: names.slice(0, 8),
      pathManifest: names.includes('asset-paths.txt'),
      failedHeader: zipResponse.headers.get('x-zip-failed-count') || '0',
    };
    if (!result.checks.downloadAllZip) result.failures.push('ZIP not created');
    if (!result.checks.zipExtracts) result.failures.push('ZIP did not extract');
    if (!result.checks.zipHasOpenableFiles) result.failures.push('ZIP did not contain downloaded files');
    if (!result.checks.zipNoWebpAvifForConverted) result.failures.push(`ZIP contains WEBP/AVIF names: ${badConvertedNames.join(', ')}`);

    try {
      const insights = await postJson('/api/insights', { url: site, assets: extracted }, 90000);
      const briefTabs = Array.isArray(insights.brief_tabs) ? insights.brief_tabs : [];
      result.checks.briefTabs = briefTabs.length <= 3 && briefTabs.length > 0;
      result.checks.indication = Boolean(String(insights.indication || '').trim());
      result.checks.importantSafetyInformation = Boolean(String(insights.important_safety_information || '').trim());
      result.brief = {
        tabCount: briefTabs.length,
        labels: briefTabs.map((tab) => tab.label),
        hasIndication: result.checks.indication,
        hasIsi: result.checks.importantSafetyInformation,
      };
      if (!result.checks.briefTabs) result.failures.push('Brief tabs missing or too many');
    } catch (error) {
      result.checks.briefTabs = false;
      result.checks.indication = false;
      result.checks.importantSafetyInformation = false;
      result.failures.push(`Brief extraction failed: ${error.message}`);
    }

    result.ok = result.failures.length === 0;
  } catch (error) {
    result.failures.push(error.message || String(error));
  }
  return result;
};

const runPlatformVideo = async ({ provider, url }) => {
  const result = { provider, url, ok: false, failures: [] };
  try {
    const extracted = await postJson('/api/extract', { url }, 90000);
    const videos = Array.isArray(extracted.videos) ? extracted.videos : [];
    result.count = videos.length;
    const best = videos.find((video) => video.url && (video.hasAudio || video.audioAvailable !== false)) || videos[0];
    if (!best?.url) throw new Error('No video URL returned');
    result.selected = {
      url: best.url,
      sourceUrl: best.sourceUrl,
      type: best.type,
      resolution: best.resolution,
      height: best.height,
      hasAudio: best.hasAudio,
      audioAvailable: best.audioAvailable,
      isYouTubeMerged: best.isYouTubeMerged,
    };
    const downloadPath = provider === 'youtube'
      ? `/api/youtube-merged-stream?url=${encodeURIComponent(best.sourceUrl || url)}&filename=${encodeURIComponent(`qc-${provider}.mp4`)}&quality=fhd`
      : `/api/download?url=${encodeURIComponent(best.url)}&filename=${encodeURIComponent(`qc-${provider}.mp4`)}&quality=fhd`;
    const downloaded = await getBuffer(downloadPath, provider === 'youtube' ? 300000 : 180000);
    const isMp4 = downloaded.buffer.slice(4, 8).toString('ascii') === 'ftyp';
    result.download = { size: downloaded.buffer.length, contentType: downloaded.contentType, isMp4 };
    if (!isMp4) result.failures.push('Downloaded video is not MP4');
    if (downloaded.buffer.length < 1024 * 100) result.failures.push('Downloaded video too small');
    result.ok = result.failures.length === 0;
  } catch (error) {
    result.failures.push(error.message || String(error));
  }
  return result;
};

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  api: API,
  sites: [],
  platformVideos: [],
};

for (let index = 0; index < sites.length; index += 1) {
  const result = await runSite(sites[index], index);
  report.sites.push(result);
  console.log(`[site ${index + 1}/${sites.length}] ${result.ok ? 'PASS' : 'FAIL'} ${sites[index]} ${result.failures.join(' | ')}`);
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  await sleep(500);
}

for (const video of platformVideos) {
  const result = await runPlatformVideo(video);
  report.platformVideos.push(result);
  console.log(`[video ${video.provider}] ${result.ok ? 'PASS' : 'FAIL'} ${result.failures.join(' | ')}`);
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
}

report.finishedAt = new Date().toISOString();
report.summary = {
  sitePass: report.sites.filter((site) => site.ok).length,
  siteTotal: report.sites.length,
  videoPass: report.platformVideos.filter((video) => video.ok).length,
  videoTotal: report.platformVideos.length,
};

await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`QC report: ${REPORT_PATH}`);
console.log(JSON.stringify(report.summary, null, 2));
