const htmlEntities: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
};

const isLocalHost = (host: string) =>
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '0.0.0.0' ||
  host === '::1' ||
  host.endsWith('.local');

export const decodeEscapedUrl = (value: string) => {
  let next = String(value || '').trim();
  next = next.replace(/^["'`]+|["'`]+$/g, '');
  next = next.replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/\\u002f/gi, '/');
  next = next.replace(/\\\//g, '/').replace(/\\&/g, '&');
  next = next.replace(/(\.(?:mp4|webm|mov|mkv|m3u8|mpd|m4a|mp3|aac|wav))&(?=[a-z0-9_.-]+=)/i, '$1?');
  next = next.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith('#x')) return String.fromCharCode(parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCharCode(parseInt(key.slice(1), 10));
    return htmlEntities[key] || match;
  });

  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(next);
      if (decoded === next || !/^https?:|^\/|^\/\//i.test(decoded)) break;
      next = decoded;
    } catch {
      break;
    }
  }

  // Ensure any decoded spaces remain URL-safe (some sites embed spaces in asset URLs).
  return next.trim().replace(/ /g, '%20');
};

const normalizeDuplicateQueryMarkers = (value: string) => {
  const firstQuestion = value.indexOf('?');
  if (firstQuestion === -1) return value;
  return `${value.slice(0, firstQuestion + 1)}${value.slice(firstQuestion + 1).replace(/\?/g, '&')}`;
};

const normalizeYouTubeWatchUrlLite = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      const embedMatch = parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (embedMatch?.[1]) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};

export const recoverYouTubeWatchFromMergeQuery = (watchPart: string, looseVideoId?: string | null) => {
  let watchUrl = String(watchPart || '').trim();
  const videoId = String(looseVideoId || '').trim();
  if (watchUrl && videoId && !watchUrl.includes('v=')) {
    watchUrl = `${watchUrl}${watchUrl.includes('?') ? '&' : '?'}v=${videoId}`;
  }
  return normalizeYouTubeWatchUrlLite(watchUrl);
};

export const rebuildYouTubeMergedStreamUrl = (rawUrl: string, baseUrl?: string) => {
  try {
    const parsed = new URL(rawUrl, baseUrl || 'http://127.0.0.1');
    if (!/\/api\/youtube-merged-stream$/i.test(parsed.pathname)) return null;
    const watchUrl = recoverYouTubeWatchFromMergeQuery(
      parsed.searchParams.get('url') || '',
      parsed.searchParams.get('v')
    );
    if (!/youtube\.com|youtu\.be/i.test(watchUrl)) return null;
    const params = new URLSearchParams();
    params.set('url', watchUrl);
    params.set('quality', parsed.searchParams.get('quality') || 'fhd');
    const inline = parsed.searchParams.get('inline');
    if (inline) params.set('inline', inline);
    const filename = parsed.searchParams.get('filename');
    if (filename) params.set('filename', filename);
    const path = `/api/youtube-merged-stream?${params.toString()}`;
    if (isLocalHost(parsed.hostname) || rawUrl.startsWith('/api/')) return path;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
};

export const sanitizeStreamUrl = (rawUrl: string, baseUrl?: string) => {
  const raw = String(rawUrl || '').trim();
  if (/\/api\/youtube-merged-stream(?:\?|$)/i.test(raw)) {
    const rebuilt = rebuildYouTubeMergedStreamUrl(raw, baseUrl);
    if (rebuilt) return rebuilt;
  }

  let value = decodeEscapedUrl(rawUrl);
  if (!value || /^(?:javascript|data|blob):/i.test(value)) return null;
  value = value.replace(/^(https?:)\/{3,}/i, '$1//');
  value = value.replace(/^(https?:\/\/)(https?:\/\/)+/i, '$2');
  value = normalizeDuplicateQueryMarkers(value);

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (/^www\./i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?]|$)/i.test(value)) {
    value = `https://${value}`;
  }

  try {
    const parsed = new URL(value, baseUrl || undefined);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (/\/api\/youtube-merged-stream$/i.test(parsed.pathname)) {
      const rebuilt = rebuildYouTubeMergedStreamUrl(parsed.href, baseUrl);
      if (rebuilt) return rebuilt;
    }
    const nestedStreamUrl = parsed.searchParams.get('url');
    if (!isLocalHost(parsed.hostname) && /\/api\/download$/i.test(parsed.pathname) && nestedStreamUrl && /googlevideo\.com|\/videoplayback(?:\?|\/|$)|\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?:\?|$)/i.test(nestedStreamUrl)) {
      let nestedValue = nestedStreamUrl;
      try {
        const nestedParsed = new URL(nestedValue);
        parsed.searchParams.forEach((paramValue, key) => {
          if (key !== 'url' && !nestedParsed.searchParams.has(key)) {
            nestedParsed.searchParams.append(key, paramValue);
          }
        });
        nestedValue = nestedParsed.href;
      } catch {
        // Let the recursive sanitizer handle relative or partially escaped nested values.
      }
      const unwrapped = sanitizeStreamUrl(nestedValue, baseUrl);
      if (unwrapped) return unwrapped;
    }
    parsed.hash = '';
    if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
      parsed.protocol = 'https:';
    }
    return parsed.href;
  } catch {
    return null;
  }
};

const isAppRelativeMediaPath = (value: string) =>
  /^\/(?:api|converted-videos|converted-audio|cached-images|cached-fonts)\//i.test(String(value || '').trim());

export const isExpiredStreamUrl = (rawUrl: string, graceSeconds = 90, baseUrl?: string) => {
  const raw = String(rawUrl || '').trim();
  if (!raw) return true;

  let parsed: URL;
  try {
    const fallbackBase =
      baseUrl ||
      (typeof window !== 'undefined' ? window.location.origin : undefined) ||
      'http://127.0.0.1';
    parsed = new URL(raw, fallbackBase);
  } catch {
    return isAppRelativeMediaPath(raw) ? false : true;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const keys = ['expire', 'expires', 'exp', 'X-Amz-Date'];

  for (const key of keys) {
    const value = parsed.searchParams.get(key);
    if (!value) continue;
    if (key === 'X-Amz-Date') {
      const ttl = Number(parsed.searchParams.get('X-Amz-Expires') || 0);
      const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (ttl > 0 && match) {
        const [, y, mo, d, h, mi, s] = match;
        const issued = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
        return issued + ttl < nowSeconds + graceSeconds;
      }
      continue;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const seconds = numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
    if (seconds < nowSeconds + graceSeconds) return true;
  }
  return false;
};

export const isLikelyHttpMediaUrl = (rawUrl: string) =>
  /\.(mp4|webm|mov|mkv|m3u8|mpd|m4a|mp3|aac|wav)(?:\?|$)/i.test(rawUrl) ||
  /googlevideo\.com\/videoplayback|video\.xx\.fbcdn\.net|vimeo\.com\/progressive_redirect|\/videoplayback\?/i.test(rawUrl);
