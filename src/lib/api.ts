import { rebuildYouTubeMergedStreamUrl } from './streamUrl';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const readRuntimeApiBase = () => {
  const globalConfig = (globalThis as any).__CREATIVE_EXTRACTOR_CONFIG__;
  return typeof globalConfig?.apiBaseUrl === 'string' ? globalConfig.apiBaseUrl : '';
};

const envApiBase = (import.meta as any).env?.VITE_API_BASE_URL || '';

export const API_BASE_URL = trimTrailingSlash(readRuntimeApiBase() || envApiBase || '');

export const resolveAppOrigin = () => {
  if (API_BASE_URL) return API_BASE_URL;
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    if (protocol === 'http:' || protocol === 'https:') {
      return window.location.origin;
    }
  }
  const globalConfig = (globalThis as any).__CREATIVE_EXTRACTOR_CONFIG__;
  const configuredPort = Number(globalConfig?.apiPort || globalConfig?.port || 8080);
  return `http://127.0.0.1:${Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 8080}`;
};

export const apiUrl = (path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
  return `${resolveAppOrigin()}${normalizedPath}`;
};

export const apiFetch = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers || {});
  headers.set('X-VDX-Local-Request', '1');

  return fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
};

export const MERGE_PREP_TIMEOUT_MS = 180000;
export const ZIP_DOWNLOAD_TIMEOUT_MS = 240000;

export const apiFetchWithTimeout = async (
  path: string,
  init: RequestInit = {},
  timeoutMs = MERGE_PREP_TIMEOUT_MS,
  timeoutMessage = 'Request timed out. Please try again.'
) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(path, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

export const isApiPathOrUrl = (value: string, apiPath: string) => {
  if (!value) return false;
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (value.startsWith(normalizedPath)) return true;
  if (API_BASE_URL && value.startsWith(`${API_BASE_URL}${normalizedPath}`)) return true;
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1';
    const parsed = new URL(value, base);
    return parsed.pathname === normalizedPath;
  } catch {
    return /\/api\/download(?:\?|$)/i.test(value) || /\/api\/youtube-merged-stream(?:\?|$)/i.test(value);
  }
};

export const normalizeYouTubeMergedStreamPath = (
  value: string,
  filenameFallback = 'video.mp4',
  options: { forDownload?: boolean } = {}
) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const rebuilt = rebuildYouTubeMergedStreamUrl(raw, typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1');
  const applyInline = (pathOrUrl: string) => {
    try {
      const parsed = new URL(pathOrUrl, typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1');
      if (parsed.pathname !== '/api/youtube-merged-stream') return pathOrUrl;
      if (!parsed.searchParams.get('filename')) {
        parsed.searchParams.set('filename', filenameFallback);
      }
      parsed.searchParams.set('inline', options.forDownload ? '0' : '1');
      return `${parsed.pathname}?${parsed.searchParams.toString()}`;
    } catch {
      return pathOrUrl;
    }
  };
  if (rebuilt) {
    if (rebuilt.startsWith('/api/')) return applyInline(rebuilt);
    try {
      const parsed = new URL(rebuilt);
      if (parsed.pathname === '/api/youtube-merged-stream') {
        return applyInline(`${parsed.pathname}?${parsed.searchParams.toString()}`);
      }
    } catch {
      // Fall through.
    }
    const stripped = rebuilt.startsWith('/') ? rebuilt : rebuilt.replace(/^https?:\/\/[^/]+/i, '');
    return applyInline(stripped);
  }
  return applyInline(resolveApiRequestPath(raw));
};

export const resolveApiRequestPath = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/youtube-merged-stream')) {
    return normalizeYouTubeMergedStreamPath(raw);
  }
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1');
    if (parsed.pathname === '/api/youtube-merged-stream') {
      return normalizeYouTubeMergedStreamPath(raw);
    }
    if (parsed.pathname.startsWith('/api/') || parsed.pathname.startsWith('/converted-')) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Fall through.
  }
  return raw;
};
