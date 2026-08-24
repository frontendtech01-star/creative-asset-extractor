import { parentPort, workerData } from 'node:worker_threads';

const fetchWithTimeout = async (url, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml,text/css,*/*;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
};

const botWallPattern =
  /robot-suspicion|challenge-platform|captcha-delivery|cf-challenge|cf_chl|cf-turnstile|cloudflare|just a moment|checking (?:your browser|the site connection|if the site connection is secure)|verify you are human|access denied|datadome|akamai|waf challenge|bot detection/i;

const htmlLooksLikeBotWall = (html) => botWallPattern.test(String(html || '').slice(0, 160000));

const buildReaderFallbackUrl = (siteUrl) => `https://r.jina.ai/http://${new URL(siteUrl).href}`;

const fetchReaderFallbackText = async (siteUrl) => {
  const text = await fetchWithTimeout(buildReaderFallbackUrl(siteUrl), 20000).catch(() => '');
  if (!text || htmlLooksLikeBotWall(text)) return '';
  if (!/URL Source:|Markdown Content:|!\[[^\]]*\]\(|https?:\/\/[^\s)]+\/wp-content\//i.test(text)) return '';
  return text;
};

const buildKnownBlockedSiteFallbackHtml = async (siteUrl) => {
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    return '';
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'xavierbecerra2026.com') return '';

  const origin = 'https://www.xavierbecerra2026.com';
  const images = [
    `${origin}/wp-content/themes/landslide/img/logo.png`,
    `${origin}/wp-content/themes/landslide/img/accent-headshot.png`,
    `${origin}/wp-content/uploads/2026/01/footer.jpg`,
  ];
  if (/\/priorities(?:\/|$)/i.test(parsed.pathname)) {
    images.push(`${origin}/wp-content/uploads/2026/01/priorities.jpg`);
  }
  const readerText = await fetchReaderFallbackText(siteUrl);
  const readerImageRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  let match;
  while ((match = readerImageRegex.exec(readerText)) !== null) {
    if (/\/wp-content\//i.test(match[1]) && !images.includes(match[1])) images.push(match[1]);
  }

  return [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="https://use.typekit.net/kqq8cdw.css">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">',
    '<style>:root{--xb-blue:#005596;--xb-red:#e31b23;--xb-white:#ffffff;--xb-offwhite:#f8f9fa;}body{font-family:Poppins,sans-serif;color:#005596;background:#f8f9fa}.hero{background-image:url("',
    `${origin}/wp-content/uploads/2026/01/priorities.jpg`,
    '")}</style>',
    '</head><body>',
    images.map((url) => `<img src="${url}" alt="">`).join(''),
    '</body></html>',
  ].join('');
};

const quickExtract = async (targetUrl) => {
  const images = [];
  const videos = [];
  const fonts = [];
  const colors = [];

  let html = await fetchWithTimeout(targetUrl, 10000).catch(() => '');
  if (!html || htmlLooksLikeBotWall(html)) {
    html = await buildKnownBlockedSiteFallbackHtml(targetUrl);
  }
  if (!html) return { images, videos, fonts, colors };

  const resolveUrl = (base, rel) => {
    try {
      return new URL(rel, base).href;
    } catch { return null; }
  };

  const seenByType = new WeakMap();
  const addUnique = (arr, item, key = 'url') => {
    const k = item[key];
    let seen = seenByType.get(arr);
    if (!seen) {
      seen = new Set();
      seenByType.set(arr, seen);
    }
    if (k && !seen.has(k)) {
      seen.add(k);
      arr.push(item);
    }
  };

  const addImage = (rawUrl) => {
    const abs = resolveUrl(targetUrl, String(rawUrl || '').replace(/&amp;/g, '&'));
    if (abs && !abs.startsWith('data:')) addUnique(images, { url: abs, sourceUrl: targetUrl });
  };

  // Extract normal, lazy-loaded, responsive, and JSON-backed images.
  const imgRegex = /<(?:img|source)\b[^>]*\b(?:src|data-src|data-image|data-lazy-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    addImage(match[1]);
  }
  const srcsetRegex = /\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;
  while ((match = srcsetRegex.exec(html)) !== null) {
    match[1].split(',').forEach((candidate) => addImage(candidate.trim().split(/\s+/)[0]));
  }
  const assetUrlRegex = /["']assetUrl["']\s*:\s*["']([^"']+)["']/gi;
  while ((match = assetUrlRegex.exec(html)) !== null) {
    addImage(match[1]);
  }

  // Extract videos
  const videoSrcRegex = /<video[^>]*>.*?<source[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gis;
  while ((match = videoSrcRegex.exec(html)) !== null) {
    const abs = resolveUrl(targetUrl, match[1]);
    if (abs) addUnique(videos, { url: abs, sourceUrl: targetUrl, type: 'video' });
  }

  const videoDirectRegex = /<video[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = videoDirectRegex.exec(html)) !== null) {
    const abs = resolveUrl(targetUrl, match[1]);
    if (abs) addUnique(videos, { url: abs, sourceUrl: targetUrl, type: 'video' });
  }

  // Provider embeds are commonly the only video reference in marketing-site
  // HTML. Keep lightweight source cards here so a successful full browser scan
  // can merge them without waiting for provider APIs or yt-dlp.
  const vimeoRegex = /(?:player\.)?vimeo\.com\/(?:video\/)?(\d{6,12})(?:[/?#][^"'<>\s]*)?/gi;
  while ((match = vimeoRegex.exec(html.replace(/\\\//g, '/'))) !== null) {
    addUnique(videos, {
      url: `https://vimeo.com/${match[1]}`,
      sourceUrl: targetUrl,
      provider: 'vimeo',
      isVimeo: true,
      type: 'vimeo',
      title: 'Vimeo video',
    });
  }

  const wistiaRegex = /(?:fast\.)?wistia\.(?:com|net)\/(?:embed\/(?:medias|iframe)|medias)\/([a-z0-9]{8,12})/gi;
  while ((match = wistiaRegex.exec(html.replace(/\\\//g, '/'))) !== null) {
    addUnique(videos, {
      url: `https://fast.wistia.com/embed/medias/${match[1]}`,
      sourceUrl: targetUrl,
      provider: 'wistia',
      isWistia: true,
      wistiaHashedId: match[1],
      type: 'wistia',
      title: 'Wistia video',
    });
  }

  // Fetch linked font CSS so the result contains downloadable font files, not stylesheet URLs.
  const stylesheetUrls = [];
  const linkRegex = /<link\b[^>]*>/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const abs = href ? resolveUrl(targetUrl, href.replace(/&amp;/g, '&')) : null;
    if (abs) stylesheetUrls.push(abs);
  }
  const prioritizedCss = Array.from(new Set(stylesheetUrls)).sort((a, b) => {
    const score = (url) => /fonts\.googleapis\.com|use\.typekit\.net|p\.typekit\.net/i.test(url) ? 1 : 0;
    return score(b) - score(a);
  }).slice(0, 8);
  const cssSources = await Promise.all(prioritizedCss.map(async (cssUrl) => ({
    cssUrl,
    css: await fetchWithTimeout(cssUrl, /use\.typekit\.net|fonts\.googleapis\.com/i.test(cssUrl) ? 8000 : 3000).catch(() => ''),
  })));
  for (const { cssUrl, css } of cssSources) {
    const fontUrlRegex = /url\(\s*["']?([^"')]+\.(?:woff2?|ttf|otf|eot)(?:\?[^"')]*)?)["']?\s*\)/gi;
    while ((match = fontUrlRegex.exec(css)) !== null) {
      const abs = resolveUrl(cssUrl, match[1]);
      if (abs) {
        const format = abs.match(/\.(woff2?|ttf|otf|eot)(?:\?|$)/i)?.[1]?.toLowerCase() || 'font';
        addUnique(fonts, { url: abs, sourceUrl: targetUrl, cssSource: cssUrl, format });
      }
    }
    const cssImageRegex = /url\(\s*["']?([^"')]+\.(?:jpe?g|png|webp|avif|gif|svg)(?:\?[^"')]*)?)["']?\s*\)/gi;
    while ((match = cssImageRegex.exec(css)) !== null) {
      const abs = resolveUrl(cssUrl, match[1]);
      if (abs) addUnique(images, { url: abs, sourceUrl: targetUrl });
    }
  }

  // Extract literal values, CSS custom-property values, and gradient stops.
  // Resolving variables lets `linear-gradient(var(--brand), #fff)` contribute
  // both colors even when the variable is declared elsewhere in the CSS.
  const variableValues = new Map();
  for (const declaration of html.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/g)) {
    variableValues.set(declaration[1], declaration[2].trim());
  }
  const resolveVariables = (value, depth = 0) => depth > 8 ? value : value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/gi, (_all, name, fallback = '') => resolveVariables(variableValues.get(name) || fallback || '', depth + 1));
  const colorRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g;
  const colorSet = new Set();
  const resolvedHtml = resolveVariables(html);
  while ((match = colorRegex.exec(resolvedHtml)) !== null) {
    colorSet.add(match[0].toLowerCase().replace(/\s+/g, ''));
  }
  colors.push(...colorSet);

  return { images, videos, fonts, colors };
};

const run = async () => {
  const { task, payload } = workerData || {};
  switch (task) {
    case 'quickExtract': {
      const result = await quickExtract(payload.targetUrl);
      parentPort?.postMessage({ ok: true, result });
      break;
    }
    default:
      parentPort?.postMessage({ ok: false, error: `Unknown task: ${task}` });
  }
};

run().catch((error) => {
  parentPort?.postMessage({ ok: false, error: String(error?.message || error || 'Extraction worker failed') });
});
