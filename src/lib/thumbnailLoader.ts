import { apiFetch, apiUrl } from './api';
import {
  buildImageThumbRequest,
  getImageAssetKey,
  getImageSourceFormat,
  resolveImagePreviewUrl,
  resolveImageThumbUrl,
} from './imageAsset';

export type ValidatedThumb = {
  src: string;
  width: number;
  height: number;
  lqip?: string;
};

type CacheEntry =
  | { ok: true; value: ValidatedThumb }
  | { ok: false; error: string };

const resultCache = new Map<string, CacheEntry>();
const inflightLoads = new Map<string, Promise<ValidatedThumb>>();

const MAX_CONCURRENT = 12;
let activeLoads = 0;
const waitQueue: Array<() => void> = [];

const acquireSlot = () =>
  new Promise<void>((resolve) => {
    if (activeLoads < MAX_CONCURRENT) {
      activeLoads += 1;
      resolve();
      return;
    }
    waitQueue.push(() => {
      activeLoads += 1;
      resolve();
    });
  });

const releaseSlot = () => {
  activeLoads = Math.max(0, activeLoads - 1);
  const next = waitQueue.shift();
  if (next) next();
};

export const preloadValidatedImage = (src: string) =>
  new Promise<ValidatedThumb>((resolve, reject) => {
    const trimmed = String(src || '').trim();
    if (!trimmed) {
      reject(new Error('Missing image URL'));
      return;
    }
    const probe = new Image();
    probe.decoding = 'async';
    probe.onload = () => {
      const width = probe.naturalWidth;
      const height = probe.naturalHeight;
      if (width <= 0 || height <= 0) {
        reject(new Error('Invalid image dimensions'));
        return;
      }
      resolve({ src: trimmed, width, height });
    };
    probe.onerror = () => reject(new Error('Image failed to load'));
    probe.src = trimmed;
  });

const isSvgAsset = (img: { url?: string; type?: string; mimeType?: string }) =>
  getImageSourceFormat(img) === 'svg';

const parseSvgDimensions = (svgText: string) => {
  const viewBoxMatch = svgText.match(/viewBox=["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
    }
  }
  const widthMatch = svgText.match(/\bwidth=["']([\d.]+)/i);
  const heightMatch = svgText.match(/\bheight=["']([\d.]+)/i);
  const width = Number(widthMatch?.[1] || 0);
  const height = Number(heightMatch?.[1] || 0);
  if (width > 0 && height > 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  return null;
};

const preloadValidatedSvg = async (src: string) => {
  const response = await fetch(src, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('SVG failed to load');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) throw new Error('SVG response was HTML');
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith('<svg') && !/<svg[\s>]/i.test(trimmed)) {
    throw new Error('Invalid SVG content');
  }
  const parsed = parseSvgDimensions(trimmed);
  try {
    const validated = await preloadValidatedImage(src);
    return validated;
  } catch {
    if (!parsed) throw new Error('SVG preview unavailable');
    return { src, width: parsed.width, height: parsed.height };
  }
};

const warmImageCache = async (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl: string
) => {
  const originalUrl = getImageAssetKey(img);
  if (!originalUrl) throw new Error('Missing image URL');
  if (originalUrl.startsWith('data:')) return originalUrl;

  const existing = String(img?.cachedUrl || '').trim();
  if (existing.startsWith('/cached-images-original/')) return existing;

  const response = await apiFetch('/api/warm-image-cache', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: existing || originalUrl,
      originalUrl,
      sourcePageUrl: sourcePageUrl || undefined,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.cachedUrl) {
    throw new Error(String(data?.error || 'Image could not be cached'));
  }
  return String(data.cachedUrl);
};

const resolveCachedDisplayUrl = (cachedUrl: string, originalUrl: string) => {
  if (originalUrl.startsWith('data:')) return originalUrl;
  if (cachedUrl.startsWith('/cached-') || cachedUrl.startsWith('/api/')) {
    return cachedUrl.startsWith('http') ? cachedUrl : apiUrl(cachedUrl);
  }
  return apiUrl(cachedUrl);
};

const cacheKeyFor = (img: { url?: string; cachedUrl?: string }, sourcePageUrl: string) =>
  `${getImageAssetKey(img)}|${sourcePageUrl}`;

type ServerThumbMeta = {
  ok?: boolean;
  thumbUrl?: string;
  lqip?: string;
  width?: number;
  height?: number;
  error?: string;
};

const fetchServerThumbMeta = async (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl: string
): Promise<ValidatedThumb | null> => {
  const originalUrl = getImageAssetKey(img);
  if (!originalUrl || originalUrl.startsWith('data:')) return null;

  const metaRequest = buildImageThumbRequest(img, sourcePageUrl, { meta: true });
  if (!metaRequest) return null;

  const response = await apiFetch(metaRequest);
  const data = (await response.json().catch(() => ({}))) as ServerThumbMeta;
  if (!response.ok || !data?.ok || !data.thumbUrl) return null;

  const thumbSrc = String(data.thumbUrl).startsWith('http')
    ? String(data.thumbUrl)
    : apiUrl(String(data.thumbUrl));

  const validated = await preloadValidatedImage(thumbSrc);
  return {
    src: validated.src,
    width: Number(data.width || validated.width || 0),
    height: Number(data.height || validated.height || 0),
    lqip: String(data.lqip || '').trim() || undefined,
  };
};

const buildFallbackPreviewCandidates = (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl: string
) => {
  const candidates: string[] = [];
  const originalUrl = getImageAssetKey(img);
  const cached = String(img?.cachedUrl || '').trim();

  if (originalUrl.startsWith('data:')) return [originalUrl];

  const thumbUrl = resolveImageThumbUrl(img, sourcePageUrl);
  if (thumbUrl) candidates.push(thumbUrl);

  if (cached.startsWith('/cached-images-original/')) {
    candidates.push(resolveCachedDisplayUrl(cached, originalUrl));
  }

  const previewUrl = resolveImagePreviewUrl(img, sourcePageUrl);
  if (previewUrl) candidates.push(previewUrl);

  if (originalUrl.startsWith('http') && !candidates.includes(originalUrl)) {
    candidates.push(originalUrl);
  }

  return candidates.filter(Boolean);
};

const validatePreviewCandidate = async (
  img: { url?: string; type?: string; mimeType?: string },
  candidate: string
) => (isSvgAsset(img) ? preloadValidatedSvg(candidate) : preloadValidatedImage(candidate));

export const loadRemoteValidatedThumb = async (url: string) => {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('Missing thumbnail URL');
  const key = `remote|${trimmed}`;
  const cached = resultCache.get(key);
  if (cached) {
    if (cached.ok) return cached.value;
    throw new Error(cached.ok === false ? cached.error : 'Thumbnail failed to load');
  }
  const inflight = inflightLoads.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    await acquireSlot();
    try {
      const validated = await preloadValidatedImage(trimmed);
      resultCache.set(key, { ok: true, value: validated });
      return validated;
    } catch (error: any) {
      const message = error?.message || 'Thumbnail failed to load';
      throw new Error(message);
    } finally {
      releaseSlot();
      inflightLoads.delete(key);
    }
  })();
  inflightLoads.set(key, task);
  return task;
};

/** Fast gallery preview — server WebP thumb first, then lightweight fallbacks. */
export const loadPreviewImageThumb = async (
  img: { url?: string; cachedUrl?: string; type?: string; mimeType?: string },
  sourcePageUrl = ''
): Promise<ValidatedThumb> => {
  const originalUrl = getImageAssetKey(img);
  if (!originalUrl) throw new Error('Missing image URL');

  const key = `preview|${cacheKeyFor(img, sourcePageUrl)}`;
  const cached = resultCache.get(key);
  if (cached) {
    if (cached.ok) return cached.value;
    throw new Error(cached.ok === false ? cached.error : 'Thumbnail failed to load');
  }
  const inflight = inflightLoads.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    await acquireSlot();
    try {
      if (!originalUrl.startsWith('data:')) {
        try {
          const serverThumb = await fetchServerThumbMeta(img, sourcePageUrl);
          if (serverThumb) {
            resultCache.set(key, { ok: true, value: serverThumb });
            return serverThumb;
          }
        } catch {
          // Fall through to direct preview candidates.
        }
      }

      const candidates = buildFallbackPreviewCandidates(img, sourcePageUrl);
      let lastError = 'Thumbnail failed to load';
      for (const candidate of candidates) {
        try {
          const validated = await validatePreviewCandidate(img, candidate);
          resultCache.set(key, { ok: true, value: validated });
          return validated;
        } catch (error: any) {
          lastError = error?.message || lastError;
        }
      }
      throw new Error(lastError);
    } finally {
      releaseSlot();
      inflightLoads.delete(key);
    }
  })();
  inflightLoads.set(key, task);
  return task;
};

/** Download/ZIP path — warm server cache before serving. */
export const loadCachedImageThumb = async (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl = ''
): Promise<ValidatedThumb> => {
  const originalUrl = getImageAssetKey(img);
  if (!originalUrl) throw new Error('Missing image URL');

  const key = cacheKeyFor(img, sourcePageUrl);
  const cached = resultCache.get(key);
  if (cached) {
    if (cached.ok) return cached.value;
    throw new Error(cached.ok === false ? cached.error : 'Thumbnail failed to load');
  }
  const inflight = inflightLoads.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    await acquireSlot();
    try {
      let displayUrl = originalUrl;
      if (!originalUrl.startsWith('data:')) {
        const cachedUrl = await warmImageCache(img, sourcePageUrl);
        displayUrl = resolveCachedDisplayUrl(cachedUrl, originalUrl);
      }
      const validated = isSvgAsset(img)
        ? await preloadValidatedSvg(displayUrl)
        : await preloadValidatedImage(displayUrl);
      resultCache.set(key, { ok: true, value: validated });
      return validated;
    } catch (error: any) {
      const message = error?.message || 'Thumbnail failed to load';
      resultCache.set(key, { ok: false, error: message });
      throw new Error(message);
    } finally {
      releaseSlot();
      inflightLoads.delete(key);
    }
  })();
  inflightLoads.set(key, task);
  return task;
};
