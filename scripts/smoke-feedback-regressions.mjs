import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import opentype from 'opentype.js';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const FONT_SITE_URL = process.env.SMOKE_FONT_SITE_URL || 'https://jbpritzker.com/';
const FONT_ZIP_SITE_URL = process.env.SMOKE_FONT_ZIP_SITE_URL || 'https://www.encelto.com/ecp/';
const SVG_MISMATCH_SITE_URL = process.env.SMOKE_SVG_MISMATCH_SITE_URL || 'https://www.encelto.com/ecp/';
const VIMEO_WEBSITE_URL = process.env.SMOKE_VIMEO_WEBSITE_URL || 'https://vimeo.com/features/video-library';
const headers = { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' };

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const ok = (message) => {
  console.log(`OK: ${message}`);
};

const readText = async (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');

const runCommand = (command, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });

const assertIncludes = (label, haystack, needle) => {
  if (!haystack.includes(needle)) fail(`${label} is missing ${needle}`);
};

const sanitizeZipNamePart = (value) =>
  String(value || 'font')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'font';

const resolveFontSourceFormat = (font) => {
  const direct = String(font?.format || '').toLowerCase();
  if (['woff2', 'woff', 'ttf', 'otf'].includes(direct)) return direct;
  const match = String(font?.url || font?.cachedUrl || '').match(/\.(woff2?|ttf|otf)(?:[?#]|$)/i);
  return String(match?.[1] || 'woff2').toLowerCase();
};

const fetchJson = async (route, init = {}, timeoutMs = 90000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${route}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 300) };
    }
    if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const fetchBuffer = async (route, init = {}, timeoutMs = 120000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${route}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(buffer.toString('utf8').slice(0, 300) || `HTTP ${response.status}`);
    return { buffer, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
};

const checkStaticFeedbackContracts = async () => {
  const [app, fontExtractor, imageExtractor, videoDownloader, videoDownloaderPage, videoDownloaderRoutes, server] = await Promise.all([
    readText('src/App.tsx'),
    readText('src/components/FontExtractor.tsx'),
    readText('src/components/ImageExtractor.tsx'),
    readText('src/lib/videoDownloader.ts'),
    readText('src/components/VideoDownloaderPage.tsx'),
    readText('server/video-downloader-routes.ts'),
    readText('server.ts'),
  ]);

  assertIncludes('Reset button UI', app, 'Video Downloader');
  assertIncludes('Reset button UI', app, 'Reset');
  assertIncludes('Reset handler', app, 'handleResetApp');
  assertIncludes('Reset handler', app, 'clearDownloaderJobs');
  assertIncludes('Reset handler', app, 'clearAppSessionState');
  assertIncludes('Close-session reset', app, 'pagehide');
  assertIncludes('Close-session reset', app, 'beforeunload');
  assertIncludes('Download-ready popup', app, 'downloadReadyNotice');
  assertIncludes('Download-ready popup', app, 'Open Downloads');
  assertIncludes('Download-ready popup dismissal', app, 'setDownloadReadyNotice(null)');
  assertIncludes('Website clear downloads confirmation', app, "window.confirm('Delete downloaded files and the extracted website folder?')");
  assertIncludes('Image download popup callback', imageExtractor, 'onDownloadReady');
  assertIncludes('Font download popup callback', fontExtractor, 'onDownloadReady');
  assertIncludes('Font converter controls', fontExtractor, 'Font converter');
  assertIncludes('Font converter controls', fontExtractor, 'getAvailableFontDownloadFormats');
  assertIncludes('Font converter controls', fontExtractor, 'resolveFontTargetFormat');
  assertIncludes('Font converter controls', fontExtractor, 'selectedFormats');
  assertIncludes('Font dropdown format output', fontExtractor, '<select');
  assertIncludes('Font dropdown format output', fontExtractor, 'buildFontZipItem');
  assertIncludes('Font dropdown format output', fontExtractor, 'getInstallableFontFormat(font, selectedFormats)');
  assertIncludes('Font ZIP TTF/WOFF default output', fontExtractor, 'getZipDownloadFormats');
  assertIncludes('Font ZIP TTF/WOFF default output', fontExtractor, 'saved as TTF and WOFF');
  assertIncludes('Font source verifier label', fontExtractor, 'Google Fonts');
  assertIncludes('Font source verifier label', fontExtractor, 'Adobe Typekit');
  assertIncludes('Font source verifier label', fontExtractor, 'Client font');
  assertIncludes('Font original URL copy', fontExtractor, 'Original font URL');
  assertIncludes('Font original URL copy', fontExtractor, 'copyOriginalFontUrl');
  assertIncludes('Native video duplicate download guard', videoDownloaderPage, 'autoStartRequest');
  assertIncludes('Downloader reset API client', videoDownloader, "method: 'DELETE'");
  assertIncludes('Website-to-video handoff', app, 'isDirectVideoPlatformUrl(directVideoTarget)');
  assertIncludes('Website-to-video handoff', app, "setMainNav('video-downloader')");
  assertIncludes('Website-to-video handoff', app, 'setVideoDownloaderAutoStart');
  assertIncludes('Video downloader auto-start', videoDownloaderPage, 'autoStartRequest');
  assertIncludes('Video downloader auto-start', videoDownloaderPage, 'handledAutoStartIdRef');
  assertIncludes('Video downloader auto-start', videoDownloaderPage, "downloadQueue(autoStartRequest.quality || 'fhd'");
  assertIncludes('Video clear downloads confirmation', videoDownloaderPage, "window.confirm('Delete all downloaded videos and extracted platform folders?')");
  assertIncludes('YouTube backup link', videoDownloaderPage, 'https://yt5s.in/en271/');
  assertIncludes('YouTube backup link', videoDownloaderPage, 'Open YT5S backup');
  assertIncludes('YouTube unavailable friendly error', videoDownloaderRoutes, 'isYouTubeUnavailableError');
  assertIncludes('YouTube unavailable friendly error', videoDownloaderRoutes, 'YouTube says this video is unavailable from this connection');
  assertIncludes('Downloader job stores friendly error', videoDownloaderRoutes, 'error: friendly');
  assertIncludes('YouTube false-unavailable retry', videoDownloaderRoutes, 'youtubeClientRetryAttempts');
  assertIncludes('YouTube false-unavailable retry', videoDownloaderRoutes, 'fallback_youtube_client');
  assertIncludes('YouTube false-unavailable retry', videoDownloaderRoutes, 'Refreshing YouTube engine');
  assertIncludes('YouTube geo bypass', videoDownloaderRoutes, '--geo-bypass');
  assertIncludes('YouTube cookies recovery', videoDownloaderRoutes, "platform === 'youtube'");
  assertIncludes('Toyota 360 frame extraction', server, 'extractImageSequencesFromText');
  assertIncludes('Toyota 360 frame extraction', server, 'data-image-count');
  assertIncludes('Toyota 360 frame extraction', server, '360-sequence');
  assertIncludes('Toyota 360 frame extraction', server, 'jellies');
  assertIncludes('Toyota 360 frame extraction', server, 'MAX_IMAGE_SEQUENCE_FRAMES');
  assertIncludes('Lexus 360 frame extraction', server, 'assetscs');
  assertIncludes('Lexus 360 frame extraction', server, 'visualizer');
  assertIncludes('Lexus 360 frame extraction', server, 'defaultImageSequenceCountForUrl');

  const videoExtractor = await readText('src/components/VideoExtractor.tsx');
  assertIncludes('Native video duplicate download guard', videoExtractor, 'const showCardDownloadButton = embedded');
  assertIncludes('Bulk video download popup', videoExtractor, 'onDownloadReady?.({');
  assertIncludes('Bulk video download popup wiring', app, 'onDownloadReady={showDownloadReadyNotice}');
  assertIncludes('Release button highlight', app, 'releaseUpdateAvailable');
  assertIncludes('Release button highlight', app, 'release-blink-once');
  assertIncludes('Release notes manual open', app, 'const openReleaseNotes = async () =>');
  if (/setReleaseViewMode\('update'\)[\s\S]{0,120}setReleaseOpen\(true\)/.test(app)) {
    fail('Release update check must not auto-open the release popup on launch');
  }

  const navStart = app.indexOf("onClick={() => setMainNav('video-downloader')}");
  const resetStart = app.indexOf('onClick={() => void handleResetApp()}', navStart);
  if (navStart === -1 || resetStart === -1 || navStart > resetStart) {
    fail('Reset button must stay after Video Downloader in the header');
  }

  ok('static feedback contracts are still present');
};

const checkVimeoWebsiteClassifier = async () => {
  const [{ isDirectVideoPlatformUrl: isDownloaderDirectVideo }, visibleVideos] = await Promise.all([
    import('../src/lib/videoPlatform.ts'),
    readText('src/lib/visibleVideos.ts'),
  ]);

  if (isDownloaderDirectVideo(VIMEO_WEBSITE_URL)) {
    fail(`${VIMEO_WEBSITE_URL} must stay accepted as a website page, not a direct video URL`);
  }
  if (!isDownloaderDirectVideo('https://vimeo.com/76979871')) {
    fail('Direct numeric Vimeo video URLs must still be recognized for Video Downloader');
  }
  assertIncludes('Visible-video Vimeo classifier', visibleVideos, "'features'");
  assertIncludes('Visible-video Vimeo classifier', visibleVideos, 'isVimeoWebsitePagePath(path)');
  ok('Vimeo website page classifier accepts feature pages');
};

const checkDownloaderResetApi = async () => {
  await fetchJson('/api/downloader/jobs', { method: 'DELETE' }, 30000);
  const jobs = await fetchJson('/api/downloader/jobs', {}, 30000);
  const count = Number(jobs?.count ?? (Array.isArray(jobs?.items) ? jobs.items.length : -1));
  if (count !== 0) fail(`downloader reset API left ${count} job(s) behind`);
  ok('downloader reset API clears job session');
};

const checkFontCardBackfill = async () => {
  const extracted = await fetchJson(
    '/api/browser-tabs/chrome/extract',
    {
      method: 'POST',
      body: JSON.stringify({ url: FONT_SITE_URL }),
    },
    120000
  );
  const fonts = Array.isArray(extracted?.fonts) ? extracted.fonts : [];
  const atcFonts = fonts.filter((font) => {
    const text = `${font?.family || ''} ${font?.title || ''} ${font?.name || ''} ${font?.url || ''}`;
    return /ATC\s+Arquette|atc_arquette/i.test(text) && /^https?:\/\//i.test(String(font?.url || ''));
  });
  const woff2Count = atcFonts.filter((font) => String(font?.format || '').toLowerCase() === 'woff2').length;
  if (atcFonts.length < 8 || woff2Count < 8) {
    fail(`expected 8 ATC Arquette WOFF2 font cards, got ${atcFonts.length} ATC / ${woff2Count} WOFF2`);
  }
  ok(`ATC Arquette font cards found (${atcFonts.length})`);
};

const checkSelectedFontZipConversion = async () => {
  const extracted = await fetchJson(
    '/api/extract',
    {
      method: 'POST',
      body: JSON.stringify({ url: FONT_ZIP_SITE_URL }),
    },
    120000
  );
  const fonts = (Array.isArray(extracted?.fonts) ? extracted.fonts : [])
    .filter((font) => font?.url && !String(font.url).startsWith('data:'))
    .slice(0, 3);
  if (fonts.length === 0) fail(`expected fonts from ${FONT_ZIP_SITE_URL}`);

  const items = fonts.flatMap((font, index) => {
    const family = sanitizeZipNamePart(font.family || font.title || font.name || `font-${index + 1}`);
    const filenameBase = sanitizeZipNamePart(`${family}-${font.weight || 400}-${font.style || 'normal'}`);
    const cached = String(font.cachedUrl || '').trim();
    const assetUrl = cached.startsWith('/') ? `${BASE}${cached}` : cached || font.url;
    const sourceFormat = resolveFontSourceFormat(font);
    return ['ttf', 'woff'].map((format) => ({
      url: assetUrl,
      cachedPath: cached || undefined,
      originalUrl: String(font.url || ''),
      cssSource: String(font.cssSource || ''),
      toFormat: format,
      originalFormat: sourceFormat,
      filenameBase,
      familyFolder: family,
      zipEntryName: `fonts/${family.replace(/\s+/g, '-')}/${filenameBase.replace(/\s+/g, '-')}.${format}`,
      metadataFilename: family,
      assetType: 'font',
    }));
  });

  const { buffer, headers: zipHeaders } = await fetchBuffer(
    '/api/download-zip',
    {
      method: 'POST',
      body: JSON.stringify({ items, sourcePageUrl: FONT_ZIP_SITE_URL }),
    },
    180000
  );
  const added = Number(zipHeaders.get('x-zip-added-count') || 0);
  const failed = Number(zipHeaders.get('x-zip-failed-count') || 0);
  const zipText = buffer.toString('latin1');
  if (failed !== 0) fail(`selected font ZIP conversion reported ${failed} failure(s)`);
  if (added < items.length) fail(`selected font ZIP conversion added ${added}/${items.length} entries`);
  if (/conversion-failed|font-conversion-report/i.test(zipText)) {
    fail('selected font ZIP conversion included a conversion failure report');
  }
  const zipEntryNames = Array.from(
    zipText.matchAll(/fonts\/[A-Za-z0-9._\-\/ ]+\.(?:ttf|woff2?|otf)/gi),
    (match) => match[0]
  );
  if (!zipEntryNames.some((name) => /\.ttf$/i.test(name)) || !zipEntryNames.some((name) => /\.woff$/i.test(name))) {
    fail('selected font ZIP conversion must include both TTF and WOFF files');
  }

  const glyphFont = fonts.find((font) => /Atkinson/i.test(String(font?.family || '')) && String(font?.weight || '') === '700') || fonts[0];
  const cached = String(glyphFont.cachedUrl || '').trim();
  const glyphUrl = cached.startsWith('/') ? `${BASE}${cached}` : cached || glyphFont.url;
  const params = new URLSearchParams({
    url: glyphUrl,
    originalUrl: String(glyphFont.url || ''),
    toFormat: 'ttf',
    originalFormat: resolveFontSourceFormat(glyphFont),
    filenameBase: sanitizeZipNamePart(`${glyphFont.family || 'font'} glyph smoke`),
    familyFolder: sanitizeZipNamePart(glyphFont.family || 'font'),
    metadataFilename: sanitizeZipNamePart(glyphFont.family || 'font'),
    cssSource: String(glyphFont.cssSource || ''),
    fontFamily: String(glyphFont.family || ''),
    fontWeight: String(glyphFont.weight || ''),
    fontStyle: String(glyphFont.style || ''),
  });
  const glyphResult = await fetchBuffer(`/api/convert-font?${params.toString()}`, {}, 120000);
  const parsedFont = opentype.parse(
    glyphResult.buffer.buffer.slice(
      glyphResult.buffer.byteOffset,
      glyphResult.buffer.byteOffset + glyphResult.buffer.byteLength
    )
  );
  for (const char of 'ABCabcRome') {
    if (parsedFont.charToGlyph(char).index === 0) {
      fail(`converted TTF maps ${char} to .notdef; installed font would show boxes`);
    }
  }

  ok(`selected font ZIP converts TTF/WOFF and TTF glyph map works on encelto.com (${added} entries)`);
};

const contentDispositionFilename = (headers) => {
  const disposition = String(headers.get('content-disposition') || '');
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || '';
};

const checkMislabeledSvgDownloads = async () => {
  const extracted = await fetchJson(
    '/api/extract',
    {
      method: 'POST',
      body: JSON.stringify({ url: SVG_MISMATCH_SITE_URL }),
    },
    120000
  );
  const images = Array.isArray(extracted?.images) ? extracted.images : [];
  const mislabeledRasterSvg = images.find((image) => /logo-hero-main\.svg/i.test(`${image?.url || ''} ${image?.src || ''} ${image?.filename || ''}`));
  const realSvg = images.find((image) => /encelto-connect.*\.svg/i.test(`${image?.url || ''} ${image?.src || ''} ${image?.filename || ''}`));
  if (!mislabeledRasterSvg?.url) fail('expected Encelto mislabeled logo-hero-main.svg image card');
  if (!realSvg?.url) fail('expected Encelto real encelto-connect SVG image card');

  const mislabeledParams = new URLSearchParams({
    url: String(mislabeledRasterSvg.cachedUrl || mislabeledRasterSvg.url),
    originalUrl: String(mislabeledRasterSvg.url),
    toFormat: 'svg',
    filenameBase: 'logo-hero-main',
    metadataFilename: 'logo-hero-main.svg',
  });
  const mislabeled = await fetchBuffer(`/api/convert-image?${mislabeledParams.toString()}`, {}, 120000);
  const mislabeledHead = mislabeled.buffer.slice(0, 500).toString('utf8').toLowerCase();
  if (!mislabeledHead.includes('<svg') || !mislabeledHead.includes('<image') || !mislabeledHead.includes('data:image/png;base64')) {
    fail('mislabeled Encelto .svg URL should return a valid SVG wrapper with embedded PNG bytes');
  }
  if (!/\.svg$/i.test(contentDispositionFilename(mislabeled.headers))) {
    fail(`mislabeled Encelto .svg URL must download as .svg, got ${contentDispositionFilename(mislabeled.headers) || 'no filename'}`);
  }

  const realParams = new URLSearchParams({
    url: String(realSvg.cachedUrl || realSvg.url),
    originalUrl: String(realSvg.url),
    toFormat: 'svg',
    filenameBase: 'encelto-connect',
    metadataFilename: 'encelto-connect.svg',
  });
  const real = await fetchBuffer(`/api/convert-image?${realParams.toString()}`, {}, 120000);
  const realHead = real.buffer.slice(0, 300).toString('utf8').toLowerCase();
  if (!realHead.includes('<svg')) fail('real Encelto SVG should return SVG XML');
  if (!/\.svg$/i.test(contentDispositionFilename(real.headers))) {
    fail(`real Encelto SVG must download as .svg, got ${contentDispositionFilename(real.headers) || 'no filename'}`);
  }

  ok('mislabeled SVG URLs download as valid Illustrator-compatible SVG files');
};

const checkWistiaJunkPlayersRemoved = async () => {
  const visibleVideos = await import('../src/lib/visibleVideos.ts');
  const staleUiVideos = [
    { url: 'https://fast.wistia.com/embed/medias/b2sw1djdxd/swatch', title: 'swatch', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/assets/external/publicApi.js@0.3.15', title: 'publicApi.js@0.3.15', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/assets/external/captions.js@0.3.15', title: 'captions.js@0.3.15', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/assets/external/interFontFace.js@0.3.15', title: 'interFontFace.js@0.3.15', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/assets/external/playPauseLoadingControl.js@0.3.15', title: 'playPauseLoadingControl.js@0.3.15', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/assets/external/hls_video.js@0.3.15', title: 'hls_video.js@0.3.15', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/assets/external/x', title: 'x', provider: 'wistia', type: 'wistia' },
    { url: 'https://fast.wistia.com/embed/medias/b2sw1djdxd', title: 'x', provider: 'wistia', type: 'wistia', wistiaHashedId: 'b2sw1djdxd' },
    { url: 'https://fast.wistia.net/embed/iframe/b2sw1djdxd', title: 'x', provider: 'wistia', type: 'wistia', wistiaHashedId: 'b2sw1djdxd' },
    { url: 'https://fast.wistia.com/mput', title: 'mput', provider: 'wistia', type: 'wistia' },
    { url: 'https://embed-ssl.wistia.com/deliveries/193d1b85787a70c44f4b0ede1967e369.bin', title: '193d1b85787a70c44f4b0ede1967e369.webp', provider: 'wistia', type: 'bin' },
    { url: 'https://embed-ssl.wistia.com/deliveries/b2sw1djdxd.m3u8', title: 'b2sw1djdxd.m3u8', provider: 'wistia', type: 'm3u8' },
    {
      url: '/api/download?url=https%3A%2F%2Fembed-ssl.wistia.com%2Fdeliveries%2Fb0e153b2fb8c8f380e8fff9afd890d19880df3f7.bin&filename=aytu-rebrand_patients_epipheo_final-1.mp4',
      title: 'Aytu-Rebrand_Patients_Epipheo_FINAL (1)',
      provider: 'wistia',
      type: 'mp4',
      isWistiaDirect: true,
      wistiaHashedId: 'b2sw1djdxd',
      height: 1080,
      resolution: '1080p',
    },
    {
      url: '/api/download?url=https%3A%2F%2Fembed-ssl.wistia.com%2Fdeliveries%2Fcac707e387a4382df534a384d453707aa63aaa03.bin&filename=aytu-rebrand_patients_epipheo_final-1.mp4',
      title: 'Aytu-Rebrand_Patients_Epipheo_FINAL (1)',
      provider: 'wistia',
      type: 'mp4',
      isWistiaDirect: true,
      wistiaHashedId: 'b2sw1djdxd',
      height: 720,
      resolution: '720p',
    },
  ];
  const visibleFromStaleSession = staleUiVideos.filter((video) => visibleVideos.isUsableExtractedVideo(video, 'https://exxuahcp.com/savings'));
  const staleText = visibleFromStaleSession.map((video) => `${video.title || ''} ${video.url || ''}`).join('\n');
  if (/publicApi|captions\.js|interFontFace|playPauseLoadingControl|hls_video|\/assets\/external\/x\b|(?:^|\n)x(?:\s|$)|\/mput\b|\/swatch\b|193d1b85787a70c44f4b0ede1967e369|b2sw1djdxd\.m3u8/i.test(staleText)) {
    fail('Frontend video filter still exposes stale Wistia helper cards');
  }
  if (visibleFromStaleSession.length !== 2 || !visibleFromStaleSession.every((video) => video.isWistiaDirect)) {
    fail(`expected frontend filter to keep only 2 direct Wistia videos, got ${visibleFromStaleSession.length}`);
  }

  const extracted = await fetchJson(
    '/api/extract',
    {
      method: 'POST',
      body: JSON.stringify({ url: 'https://exxuahcp.com/savings', mode: 'static' }),
    },
    120000
  );
  const videos = Array.isArray(extracted?.videos) ? extracted.videos : [];
  const text = videos
    .map((video) => `${video?.title || ''} ${video?.url || ''} ${video?.sourceUrl || ''}`)
    .join('\n');
  if (/publicApi|captions\.js|interFontFace|playPauseLoadingControl|hls_video|\/mput\b|\/swatch\b/i.test(text)) {
    fail('Wistia helper resources must not appear as video cards');
  }
  const directWistia = videos.filter((video) => video?.provider === 'wistia' && video?.isWistiaDirect);
  if (!directWistia.some((video) => Number(video?.height || 0) >= 1080)) {
    fail(`expected a direct 1080p Wistia video, got ${directWistia.length} direct Wistia video(s)`);
  }
  ok('Wistia junk player cards are removed');
};

const checkBrightcoveTrackerLinksCanonicalized = async () => {
  const visibleVideos = await import('../src/lib/visibleVideos.ts');
  const seedUrl = 'https://www.carvykti.com/receiving-carvykti/#expectCARVYKTIJourney';
  const staleBrightcoveVideos = [
    {
      url: 'https://metrics.brightcove.com/v2/tracker?domain=videocloud&account=4317630935001&video=6394961629112&player=players.brightcove.net%2F4317630935001%2Fdefault_default',
      title: 'tracker 1',
      provider: 'brightcove',
      type: 'brightcove',
    },
    {
      url: 'https://metrics.brightcove.com/v2/tracker?domain=videocloud&account=4317630935001&video=6394961629112&player=players.brightcove.net%2F4317630935001%2Fdefault_default',
      title: 'tracker 2',
      provider: 'brightcove',
      type: 'brightcove',
    },
    {
      url: 'https://videos-cdn.brightcove.net/accounts/4317630935001/videos/6394961629112/master.m3u8',
      title: 'master.m3u8 1',
      provider: 'brightcove',
      type: 'm3u8',
    },
    {
      url: 'https://videos-cdn.brightcove.net/accounts/4317630935001/videos/6394961629112/segment0.ts',
      title: 'segment0.ts 1',
      provider: 'brightcove',
      type: 'ts',
    },
    {
      url: 'https://videos-cdn.brightcove.net/accounts/4317630935001/videos/6389044856112/segment0.ts',
      title: 'segment0.ts 2',
      provider: 'brightcove',
      type: 'ts',
    },
    {
      url: 'https://players.brightcove.net/4317630935001/default_default/index.html?videoId=6389044856112',
      title: '6389044856112',
      provider: 'brightcove',
      type: 'brightcove',
    },
  ];
  const cards = visibleVideos.getVisibleVideoCards(staleBrightcoveVideos, seedUrl);
  const urls = cards.map((video) => String(video?.url || ''));
  if (urls.some((url) => /metrics\.brightcove\.com|master\.m3u8|rendition\.m3u8|segment\d*\.ts/i.test(url))) {
    fail(`Brightcove tracker/manifest junk leaked into visible cards: ${urls.join(', ')}`);
  }
  const expected = [
    'https://players.brightcove.net/4317630935001/default_default/index.html?videoId=6394961629112',
    'https://players.brightcove.net/4317630935001/default_default/index.html?videoId=6389044856112',
  ];
  if (cards.length !== expected.length || !expected.every((url) => urls.includes(url))) {
    fail(`expected canonical Brightcove player URLs only, got ${urls.join(', ')}`);
  }
  ok('Brightcove tracker cards canonicalize to clean player links');
};

const main = async () => {
  const health = await fetch(`${BASE}/`, { headers: { 'X-VDX-Local-Request': '1' } }).catch(() => null);
  if (!health?.ok) fail(`Server not reachable at ${BASE}`);

  console.log(`Feedback regression smoke -> ${BASE}\n`);
  await checkStaticFeedbackContracts();
  await checkVimeoWebsiteClassifier();
  await checkDownloaderResetApi();
  await checkFontCardBackfill();
  await checkSelectedFontZipConversion();
  await checkMislabeledSvgDownloads();
  await checkWistiaJunkPlayersRemoved();
  await checkBrightcoveTrackerLinksCanonicalized();
  await runCommand('node', ['scripts/smoke-video-ui.mjs'], { SMOKE_BASE_URL: BASE });
  console.log('\nPASS: feedback regressions are covered');
};

main().catch((error) => fail(error?.message || String(error)));
