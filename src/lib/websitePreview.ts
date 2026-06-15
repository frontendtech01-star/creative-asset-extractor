import { isDirectVideoPlatformUrl } from './visibleVideos';

const normalizeHost = (hostname: string) =>
  String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .replace(/^www\./, '')
    .toLowerCase();

export const isBlockedWebsitePreviewUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value) return true;
  if (value.startsWith('/') && !value.startsWith('//')) return true;

  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return true;

    const host = normalizeHost(parsed.hostname);
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local')
    ) {
      return true;
    }

    if (typeof window !== 'undefined') {
      const appOrigin = window.location.origin;
      if (value === appOrigin || value.startsWith(`${appOrigin}/`)) return true;
    }

    if (isDirectVideoPlatformUrl(value)) return true;
    return false;
  } catch {
    return true;
  }
};

export const resolveWebsitePreviewUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value || isBlockedWebsitePreviewUrl(value)) return '';
  try {
    return new URL(value).href;
  } catch {
    return '';
  }
};
