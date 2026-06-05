export const decodeUrlEncodedFilename = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw.replace(/\+/g, ' ');
  }
};

export const filenameFromUrlPath = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value || value.startsWith('data:')) return '';
  try {
    const parsed = new URL(value);
    const segment = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodeUrlEncodedFilename(segment.split('?')[0].split('#')[0]);
  } catch {
    const segment = value.split('/').pop() || '';
    return decodeUrlEncodedFilename(segment.split('?')[0].split('#')[0]);
  }
};

export const parseContentDispositionFilename = (header: string | null | undefined) => {
  const value = String(header || '').trim();
  if (!value) return '';
  const encoded = value.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (encoded?.[1]) return decodeUrlEncodedFilename(encoded[1].trim().replace(/^["']|["']$/g, ''));
  const quoted = value.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return decodeUrlEncodedFilename(quoted[1].trim());
  const plain = value.match(/filename=([^;]+)/i);
  if (plain?.[1]) return decodeUrlEncodedFilename(plain[1].trim().replace(/^["']|["']$/g, ''));
  return '';
};

const normalizeExtension = (ext: string) => {
  const cleaned = String(ext || '').toLowerCase().replace(/^\./, '');
  return cleaned === 'jpeg' ? 'jpg' : cleaned;
};

export const getImageDownloadFilename = (
  originalUrl: string,
  targetFormat: string,
  filenameBase = '',
  metadataFilename = ''
) => {
  const ext = normalizeExtension(targetFormat || 'jpg');
  const fromUrl = filenameFromUrlPath(originalUrl);
  const base =
    String(filenameBase || '').trim().replace(/\.[^/.]+$/, '') ||
    (fromUrl || '').replace(/\.[^/.]+$/, '') ||
    'image';
  const meta = decodeUrlEncodedFilename(metadataFilename);
  if (meta) {
    const metaBase = meta.replace(/\.[^/.]+$/, '') || meta;
    return `${metaBase}.${ext}`;
  }
  return `${base}.${ext}`;
};

export const getFontDownloadFilename = (
  originalUrl: string,
  format: string,
  filenameBase = '',
  metadataFilename = ''
) => {
  const ext = normalizeExtension(format || 'ttf');
  const base =
    String(filenameBase || '').trim().replace(/\.[^/.]+$/, '') ||
    filenameFromUrlPath(originalUrl)?.replace(/\.[^/.]+$/, '') ||
    'font';
  const meta = decodeUrlEncodedFilename(metadataFilename);
  if (meta) {
    const metaBase = meta.replace(/\.[^/.]+$/, '') || meta;
    return `${metaBase}.${ext}`;
  }
  return `${base}.${ext}`;
};
