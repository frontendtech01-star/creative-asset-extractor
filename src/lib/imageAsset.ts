import { apiUrl } from './api';
import { filenameFromUrlPath } from './filename';

export type ImageDownloadFormat = 'original' | 'png' | 'jpg';
export type RasterZipTargetFormat = 'png' | 'jpg';

/** Download-all ZIP always converts WEBP/AVIF (default PNG). */
export const DEFAULT_ZIP_RASTER_FORMAT: RasterZipTargetFormat = 'png';

const DIRECT_DOWNLOAD_FORMATS = new Set(['png', 'jpg', 'jpeg', 'svg', 'gif']);

/** Stable identity for selection, download state, and format prefs — always the remote/original URL. */
export const getImageAssetKey = (img: { url?: string; cachedUrl?: string }) => String(img?.url || '').trim();

const IMAGE_VARIANT_QUERY_PARAMS = new Set([
  'w',
  'width',
  'h',
  'height',
  'q',
  'quality',
  'fit',
  'crop',
  'dpr',
  'fm',
  'format',
  'auto',
  'v',
  'ver',
  'version',
  'cache',
  'cb',
]);

const IMAGE_SEQUENCE_COUNTS = new Set([4, 18, 24, 36, 72, 120]);

const looksLikeImageSequenceAsset = (img: any, rawUrl: string) => {
  const source = String(img?.source || '').toLowerCase();
  if (source.includes('360-sequence') || Number(img?.sequenceFrame || 0) > 0) return true;

  const explicitCountMatch = rawUrl.match(
    /\/(\d{1,3})\/(\d{1,3})\.(?:png|jpe?g|webp|avif|gif)(?:[?#]|$)/i
  );
  if (explicitCountMatch && IMAGE_SEQUENCE_COUNTS.has(Number(explicitCountMatch[1] || 0))) {
    return true;
  }

  return (
    /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(rawUrl) &&
    /[-_]\d{1,3}\.(?:png|jpe?g|webp|avif|gif)(?:[?#]|$)/i.test(rawUrl)
  );
};

const getGeneratedImageIdentity = (img: any, rawUrl: string) => {
  const urlFilename = (() => {
    try {
      const parsed = new URL(rawUrl);
      return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      return rawUrl.split(/[?#]/)[0]?.split('/').filter(Boolean).pop() || '';
    }
  })();

  const candidates = [
    String(img?.filename || '').trim(),
    String(img?.name || '').trim(),
    urlFilename,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const leaf = candidate.split('/').pop() || candidate;
    const stem = leaf.replace(/\.(?:png|jpe?g|webp|avif|gif|svg|bmp|ico)$/i, '');
    const generatedMatch = stem.match(/^([a-f0-9]{20,})(?:[-_].*)?$/i);
    if (generatedMatch?.[1]) return generatedMatch[1].toLowerCase();
  }

  return '';
};

const normalizeImageVariantPath = (pathname: string) =>
  pathname
    .replace(/[-_]\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i, '')
    .replace(/_(?:\d{2,5}x|x\d{2,5})(?=\.[a-z0-9]+$)/i, '')
    .replace(/\/cdn-cgi\/image\/[^/]+\//i, '/cdn-cgi/image/');

/**
 * Stable identity used to merge duplicate image renditions without collapsing
 * 360 sequence frames.
 */
export const getImageDedupeKey = (img: any) => {
  const rawUrl = String(img?.url || img?.src || img?.originalUrl || '').trim();
  if (!rawUrl) return '';

  if (rawUrl.startsWith('data:')) {
    return `data:${rawUrl}`;
  }

  const isSequence = looksLikeImageSequenceAsset(img, rawUrl);

  if (!isSequence) {
    const generatedIdentity = getGeneratedImageIdentity(img, rawUrl);
    if (generatedIdentity) return `generated:${generatedIdentity}`;
  }

  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';

    Array.from(parsed.searchParams.keys()).forEach((key) => {
      if (IMAGE_VARIANT_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    });

    const remainingParams = Array.from(parsed.searchParams.entries()).sort(([aKey, aValue], [bKey, bValue]) => {
      const keyCompare = aKey.localeCompare(bKey);
      return keyCompare !== 0 ? keyCompare : aValue.localeCompare(bValue);
    });

    parsed.search = '';
    remainingParams.forEach(([key, value]) => parsed.searchParams.append(key, value));

    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = normalizeImageVariantPath(decodeURIComponent(parsed.pathname));
    const prefix = isSequence ? 'sequence' : 'url';

    return `${prefix}:${host}${pathname}${parsed.search}`;
  } catch {
    const clean = rawUrl
      .split('#')[0]
      .replace(/[-_]\d{2,5}x\d{2,5}(?=\.[a-z0-9]+(?:[?#]|$))/i, '');

    return `${isSequence ? 'sequence' : 'url'}:${clean}`;
  }
};

export const resolveImageAssetUrl = (img: { url?: string; cachedUrl?: string }) => {
  const url = String(img?.cachedUrl || img?.url || '').trim();
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/cached-')) return apiUrl(url);
  return url;
};

/** URL sent to /api/convert-image — prefer on-disk cache path when available. */
export const resolveImageConvertRequestUrl = (img: { url?: string; cachedUrl?: string }) => {
  const remote = String(img?.url || '').trim();
  if (remote.startsWith('data:')) return remote;
  const cached = String(img?.cachedUrl || '').trim();
  if (cached.startsWith('/cached-images-original/')) return cached;
  // Browser extraction may rasterize an SVG into a data:image/png preview.
  // Never substitute that preview when the original remote asset is available.
  if (remote) return remote;
  if (cached.startsWith('data:image/')) return cached;
  return cached;
};

export const resolveImageDownloadUrl = resolveImageConvertRequestUrl;

export const buildImagePreviewRequest = (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl = ''
) => {
  const remote = String(img?.url || '').trim();
  const cached = String(img?.cachedUrl || '').trim();
  const requestUrl = cached.startsWith('/cached-images-original/')
    ? cached
    : cached.startsWith('http')
      ? cached
      : remote;
  if (!requestUrl) return '';
  // Inline SVG/data images can exceed the server's request-header limits when
  // shoved into a query string. They are already browser-displayable, so keep
  // them on the direct fast path instead of proxying through /api/image-preview.
  if (requestUrl.startsWith('data:')) return '';
  const params = new URLSearchParams({ url: requestUrl });
  if (remote.startsWith('http')) params.set('originalUrl', remote);
  if (sourcePageUrl) params.set('sourcePageUrl', sourcePageUrl);
  return `/api/image-preview?${params.toString()}`;
};

export const resolveImagePreviewUrl = (img: { url?: string; cachedUrl?: string }, sourcePageUrl = '') => {
  const remote = String(img?.url || '').trim();
  if (remote.startsWith('data:')) return remote;
  const previewRequest = buildImagePreviewRequest(img, sourcePageUrl);
  return previewRequest ? apiUrl(previewRequest) : '';
};

export const buildImageThumbRequest = (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl = '',
  options: { meta?: boolean } = {}
) => {
  const originalUrl = String(img?.url || '').trim();
  if (!originalUrl || originalUrl.startsWith('data:')) return '';
  const params = new URLSearchParams({ originalUrl });
  if (sourcePageUrl) params.set('sourcePageUrl', sourcePageUrl);
  if (options.meta) params.set('meta', '1');
  return `/api/image-thumb?${params.toString()}`;
};

export const resolveImageThumbUrl = (
  img: { url?: string; cachedUrl?: string },
  sourcePageUrl = ''
) => {
  const request = buildImageThumbRequest(img, sourcePageUrl);
  return request ? apiUrl(request) : '';
};

export const getImageSourceFormat = (img: { url?: string; type?: string; mimeType?: string }) => {
  const mime = String(img?.mimeType || '').toLowerCase();
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('avif')) return 'avif';
  const type = String(img?.type || '').toLowerCase().trim();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'].includes(type)) {
    return type === 'jpeg' ? 'jpg' : type;
  }
  const remote = String(img?.url || '');
  if (/\.webp(?:[?#]|$)/i.test(remote) || /\/styles\/webp\//i.test(remote)) return 'webp';
  if (/\.avif(?:[?#]|$)/i.test(remote)) return 'avif';
  const fromUrl = filenameFromUrlPath(remote);
  const ext = fromUrl.split('.').pop()?.toLowerCase() || '';
  if (ext === 'jpeg') return 'jpg';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'].includes(ext)
    ? ext === 'jpeg' ? 'jpg' : ext
    : 'jpg';
};

export const imageDownloadsDirectly = (img: { url?: string; type?: string }) =>
  DIRECT_DOWNLOAD_FORMATS.has(getImageSourceFormat(img));

/** WEBP and AVIF support optional conversion (individual card + bulk ZIP). */
export const imageNeedsConversionChoice = (img: { url?: string; type?: string }) => {
  const source = getImageSourceFormat(img);
  return source === 'webp' || source === 'avif';
};

export const imageSupportsFormatChoice = imageNeedsConversionChoice;

export const getAvailableImageDownloadFormats = (img: { url?: string; type?: string }): ImageDownloadFormat[] => {
  if (!imageNeedsConversionChoice(img)) return [];
  return ['original', 'png', 'jpg'];
};

export const getImageDownloadFormat = (
  img: { url?: string; type?: string },
  selectedFormats: Record<string, string>
): ImageDownloadFormat => {
  if (!imageNeedsConversionChoice(img)) return 'original';
  const key = getImageAssetKey(img);
  const options = getAvailableImageDownloadFormats(img);
  const chosen = String(selectedFormats[key] || '').toLowerCase() as ImageDownloadFormat;
  if (options.includes(chosen)) return chosen;
  return 'png';
};

/** ZIP: auto-convert WEBP/AVIF; honor per-image PNG/JPG when set, else default PNG. */
export const resolveZipRasterTargetFormat = (
  img: { url?: string; type?: string },
  selectedFormats: Record<string, string>
): RasterZipTargetFormat => {
  if (!imageNeedsConversionChoice(img)) return DEFAULT_ZIP_RASTER_FORMAT;
  const choice = getImageDownloadFormat(img, selectedFormats);
  if (choice === 'jpg') return 'jpg';
  return 'png';
};

const looksLikeGeneratedFilename = (name: string) => {
  const base = String(name || '').trim();
  if (!base) return true;
  if (/^image-\d+\./i.test(base)) return true;
  if (/^[a-f0-9]{20,}(\-\d+)?\./i.test(base)) return true;
  return false;
};

/** Human-readable label for cards (prefer original URL filename over cache hash names). */
export const getImageDisplayName = (
  img: { url?: string; cachedUrl?: string; filename?: string; name?: string; alt?: string },
  index = 0
) => {
  const candidates = [
    String(img?.filename || '').trim(),
    String(img?.name || '').trim(),
    String(img?.alt || '').trim(),
    filenameFromUrlPath(String(img?.url || '')),
    filenameFromUrlPath(String(img?.cachedUrl || '').replace(/^\/cached-images-original\//, '')),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const leaf = candidate.split('/').pop() || candidate;
    if (!looksLikeGeneratedFilename(leaf)) return leaf;
  }

  const fromUrl = filenameFromUrlPath(String(img?.url || ''));
  if (fromUrl) return fromUrl;
  return `image-${index + 1}.${getImageSourceFormat(img)}`;
};

export type ImageMetaBadges = {
  format: string;
  dimensions: string;
  size: string;
};

const formatImageByteLabel = (bytes: number) => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes > 0) return `${bytes} B`;
  return '';
};

const estimateDataImageBytes = (dataUrl: string) => {
  const raw = String(dataUrl || '').trim();
  if (!raw.startsWith('data:image/')) return 0;
  const comma = raw.indexOf(',');
  if (comma < 0) return 0;
  const header = raw.slice(0, comma).toLowerCase();
  const payload = raw.slice(comma + 1);
  try {
    if (header.includes(';base64')) {
      const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
      return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
    }
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch {
    return 0;
  }
};

/** Separate pill labels for format, resolution, and file size. */
export const getImageMetaBadges = (img: {
  type?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
  size?: number;
}): ImageMetaBadges => {
  const format = String(getImageSourceFormat(img) || img?.type || 'img').toUpperCase();
  const width = Number(img?.width || 0);
  const height = Number(img?.height || 0);
  const dimensions = width > 0 && height > 0 ? `${width}×${height}` : '';
  const byteCount =
    Number(img?.bytes || img?.size || 0) ||
    estimateDataImageBytes(String(img?.url || ''));
  const size = formatImageByteLabel(byteCount);
  return { format, dimensions, size };
};

export const mergeImageMetaBadges = (
  base: ImageMetaBadges,
  patch?: Partial<ImageMetaBadges> | null
): ImageMetaBadges => ({
  format: patch?.format || base.format,
  dimensions: patch?.dimensions || base.dimensions,
  size: patch?.size || base.size,
});

export const formatImageMetaLine = (img: { width?: number; height?: number; bytes?: number; size?: number }) => {
  const badges = getImageMetaBadges(img);
  return [badges.dimensions, badges.size].filter(Boolean).join(' · ');
};

export const imageFilenameBase = (
  img: { url?: string; cachedUrl?: string; filename?: string; name?: string },
  index = 0
) => {
  const remote = String(img?.url || '').trim();
  if (remote.startsWith('data:image/svg')) return `inline-svg-${index + 1}`;
  const fromUrl = filenameFromUrlPath(remote);
  if (fromUrl) {
    const base = fromUrl.replace(/\.[^/.]+$/, '') || fromUrl;
    if (base) return base;
  }
  const metadata = String(img?.filename || img?.name || '').trim();
  if (metadata) return metadata.replace(/\.[^/.]+$/, '') || metadata;
  return `image-${index + 1}`;
};

export const getOriginalImageDownloadFilename = (
  img: { url?: string; filename?: string; name?: string; type?: string },
  index = 0
) => {
  const fromUrl = filenameFromUrlPath(String(img?.url || '').trim());
  if (fromUrl && fromUrl.includes('.')) return fromUrl;
  const metadata = String(img?.filename || img?.name || '').trim();
  if (metadata && metadata.includes('.')) return metadata;
  const ext = getImageSourceFormat(img);
  return `${imageFilenameBase(img, index)}.${ext}`;
};

export const resolveImageTargetFormat = (
  img: { url?: string; type?: string },
  format: ImageDownloadFormat | RasterZipTargetFormat
) => {
  const source = getImageSourceFormat(img);
  if (!imageNeedsConversionChoice(img)) return source;
  if (format === 'original') return source;
  if (format === 'png' || format === 'jpg') return format;
  return source;
};

export const buildImageZipItem = (
  img: {
    url?: string;
    cachedUrl?: string;
    type?: string;
    mimeType?: string;
    status?: string;
    filename?: string;
    name?: string;
    id?: string;
  },
  index = 0,
  downloadFormat?: ImageDownloadFormat | RasterZipTargetFormat
) => {
  const url = resolveImageConvertRequestUrl(img);
  const originalUrl = String(img?.url || '').trim();
  const id = String(img?.id || getImageAssetKey(img) || url || '').trim();
  const cachedPath = String(img?.cachedUrl || '').trim();
  const metadataFilename = String(img?.filename || img?.name || '').trim() || undefined;
  const source = getImageSourceFormat(img);
  const zipTarget = downloadFormat ?? DEFAULT_ZIP_RASTER_FORMAT;
  const target = imageNeedsConversionChoice(img)
    ? resolveImageTargetFormat(img, zipTarget)
    : source;

  const item: {
    url: string;
    assetType: 'image';
    toFormat?: string;
    selectedFormat?: string;
    filenameBase?: string;
    filename?: string;
    originalUrl?: string;
    metadataFilename?: string;
    mimeType?: string;
    cachedPath?: string;
    status?: string;
    id?: string;
    zipEntryName?: string;
  } = {
    id: id || undefined,
    url,
    assetType: 'image',
    filenameBase: imageFilenameBase(img, index),
    filename: getOriginalImageDownloadFilename(img, index),
    originalUrl: originalUrl || undefined,
    metadataFilename,
    mimeType: String(img?.mimeType || imageContentTypeFromFormat(source)).trim() || undefined,
    cachedPath: cachedPath || undefined,
    status: String(img?.status || '').trim() || undefined,
  };

  if (imageNeedsConversionChoice(img)) {
    item.toFormat = target;
    item.selectedFormat = target;
  }

  return item;
};

const imageContentTypeFromFormat = (format: string) => {
  const normalized = String(format || '').toLowerCase().replace('jpeg', 'jpg');
  if (normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'png') return 'image/png';
  if (normalized === 'webp') return 'image/webp';
  if (normalized === 'avif') return 'image/avif';
  if (normalized === 'gif') return 'image/gif';
  if (normalized === 'svg') return 'image/svg+xml';
  return '';
};
