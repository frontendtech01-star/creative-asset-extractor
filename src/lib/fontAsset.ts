import { apiUrl } from './api';
import { filenameFromUrlPath } from './filename';

export const FONT_ZIP_OUTPUT_FORMATS = ['woff2', 'ttf', 'woff', 'otf'] as const;
export type FontZipOutputFormat = (typeof FONT_ZIP_OUTPUT_FORMATS)[number];

/** Conversion outputs for a source format (original + derived targets). */
export const getFontConversionOutputs = (sourceFormat: string): FontZipOutputFormat[] => {
  const source = String(sourceFormat || '').toLowerCase();
  if (source === 'woff2') return ['woff2', 'ttf', 'woff'];
  if (source === 'woff') return ['woff', 'ttf'];
  if (source === 'ttf') return ['ttf', 'woff'];
  if (source === 'otf') return ['otf', 'ttf', 'woff'];
  return ['ttf', 'woff'];
};

export const buildFontZipEntryName = (filenameBase: string, format: string) => {
  const safe = sanitizeFontFilenameBase(filenameBase).replace(/\s+/g, '-').replace(/-+/g, '-') || 'font';
  const ext = String(format || 'ttf').toLowerCase();
  return `fonts/${safe}/${safe}.${ext}`;
};

export type FontDownloadFormat = 'original' | FontZipOutputFormat;

export const FONT_OUTPUT_FORMATS = ['original', 'woff2', 'ttf', 'woff'] as const;

export const resolveFontAssetUrl = (font: { url?: string; cachedUrl?: string }) => {
  const remote = String(font?.url || '').trim();
  const cached = String(font?.cachedUrl || '').trim();
  if (cached.startsWith('/cached-fonts-original/')) return apiUrl(cached);
  if (remote.startsWith('http://') || remote.startsWith('https://')) return remote;
  if (cached) return cached.startsWith('http') ? cached : apiUrl(cached);
  return '';
};

export const getFontSelectionKey = (font: { url?: string }) => String(font?.url || '').trim();

export const normalizeFontStyleKey = (style: string | undefined) => {
  const raw = String(style || '').trim().toLowerCase();
  if (!raw || raw === 'normal') return 'normal';
  if (raw === 'italic' || raw === 'oblique') return 'italic';
  return raw;
};

export const normalizeFontWeightKey = (weight: string | number | undefined) => {
  const raw = String(weight || '').trim().toLowerCase();
  if (!raw || raw === 'normal' || raw === 'regular') return '400';
  if (/^\d+$/.test(raw)) return String(Math.min(900, Math.max(1, Number(raw))));
  if (raw === 'bold' || raw === 'bolder') return '700';
  if (raw === 'lighter') return '300';
  return raw;
};

const WEIGHT_SUFFIX_TO_KEY: Record<string, string> = {
  thin: '100',
  extralight: '200',
  light: '300',
  regular: '400',
  book: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900',
  condbold: '700',
};

/** Split CSS families like Barlow-Bold or BarlowCondensed-SemiBoldItalic into family + weight + style. */
export const resolveFontIdentityFields = (font: {
  family?: string;
  title?: string;
  name?: string;
  weight?: string | number;
  style?: string;
}) => {
  let family = sanitizeFontFilenameBase(
    String(font?.family || font?.title || font?.name || '')
      .replace(/^["']+|["']+$/g, '')
      .trim()
  );
  let weight = font?.weight;
  let style = font?.style;

  const hyphenated = family.match(
    /^(.+?)[-](Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black|CondBold)(Italic)?$/i
  );
  if (hyphenated) {
    family = sanitizeFontFilenameBase(hyphenated[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
    const suffixKey = hyphenated[2].toLowerCase().replace(/\s+/g, '');
    const mapped = WEIGHT_SUFFIX_TO_KEY[suffixKey];
    if (mapped && (!weight || String(weight).toLowerCase() === 'normal' || String(weight) === '400')) {
      weight = mapped;
    }
    if (hyphenated[3]) style = style || 'italic';
  }

  return { family, weight, style };
};

/** Stable identity for @font-face rows (ignores Google Fonts subset file URLs). */
export const getFontLogicalKey = (font: {
  family?: string;
  title?: string;
  name?: string;
  weight?: string | number;
  style?: string;
}) => {
  const { family, weight, style } = resolveFontIdentityFields(font);
  if (!family || isJunkFontLabel(family)) return '';
  return `${family}|${normalizeFontWeightKey(weight)}|${normalizeFontStyleKey(style)}`;
};

export const scoreFontSubsetUrl = (url: string) => {
  const lower = String(url || '').toLowerCase();
  let score = 0;
  if (/latin-ext|latn-ext/i.test(lower)) score += 8;
  else if (/latin|latn/i.test(lower)) score += 12;
  if (/fonts\.gstatic\.com/i.test(lower)) score += 25;
  if (/fonts\.googleapis\.com/i.test(lower)) score += 5;
  if (/vietnamese|vi_/i.test(lower)) score -= 10;
  if (/cyrillic|cy_/i.test(lower)) score -= 8;
  if (/greek|greek-ext|el_/i.test(lower)) score -= 6;
  const subsetMatch = /[_-]s(\d)w/i.exec(lower) || /(\d)wH8/i.exec(lower);
  if (subsetMatch) score += Number(subsetMatch[1]) / 10;
  return score;
};

export const scoreFontRecord = (font: {
  url?: string;
  cachedUrl?: string;
  format?: string;
  weight?: string | number;
  style?: string;
  status?: string;
}) => {
  let score = 0;
  const format = resolveFontSourceFormat(font);
  if (format === 'woff2') score += 30;
  else if (format === 'woff') score += 20;
  else if (format === 'ttf' || format === 'otf') score += 10;
  const assetUrl = String(font?.url || font?.cachedUrl || '');
  score += scoreFontSubsetUrl(assetUrl);
  if (/-ttf\.ttf(\?|$)/i.test(assetUrl)) score += 18;
  else if (/-woff\.woff(\?|$)/i.test(assetUrl)) score += 12;
  if (/\/fonts\//i.test(assetUrl) && (format === 'ttf' || format === 'woff')) score += 10;
  if (font?.cachedUrl) score += 50;
  if (String(font?.status || '').toLowerCase() === 'downloaded') score += 40;
  return score;
};

export const dedupeFontsByLogicalKey = (fonts: any[]) => {
  const groups = new Map<string, any[]>();
  for (const font of fonts) {
    if (!font?.url || String(font.url).startsWith('data:')) continue;
    const key = getFontLogicalKey(font);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(font);
    groups.set(key, bucket);
  }

  const deduped: any[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => scoreFontRecord(b) - scoreFontRecord(a));
    const best = sorted[0];
    const merged = sorted.reduce((acc, current) => mergeFontRecords(acc, current), null as any) || best;
    deduped.push({
      ...merged,
      url: best.url,
      format: best.format || merged.format,
      cachedUrl: best.cachedUrl || merged.cachedUrl,
    });
  }

  return deduped.sort((a, b) => {
    const familyA = buildFontDisplayName(a) || a.family || '';
    const familyB = buildFontDisplayName(b) || b.family || '';
    return familyA.localeCompare(familyB);
  });
};

export const resolveFontSourceFormat = (font: { url?: string; cachedUrl?: string; format?: string }) => {
  const raw = String(font?.format || '').toLowerCase().trim();
  if (['woff', 'woff2', 'ttf', 'otf', 'eot', 'svg'].includes(raw)) return raw;
  const candidate = String(font?.url || font?.cachedUrl || '');
  if (/\.woff2(\?|$)/i.test(candidate)) return 'woff2';
  if (/\.woff(\?|$)/i.test(candidate)) return 'woff';
  if (/\.ttf(\?|$)/i.test(candidate)) return 'ttf';
  if (/\.otf(\?|$)/i.test(candidate)) return 'otf';
  if (/\.eot(\?|$)/i.test(candidate)) return 'eot';
  if (/\.svg(\?|$)/i.test(candidate)) return 'svg';
  return raw || 'unknown';
};

export const isJunkFontLabel = (value: string) => {
  const base = String(value || '').trim().toLowerCase();
  if (!base) return true;
  if (base === 'unknown' || base === 'font') return true;
  if (base.length <= 2) return true;
  if (/^font-\d+$/i.test(base)) return true;
  if (/^[lda](?:-\d+)?$/i.test(base)) return true;
  if (/^[0-9a-f]{8,}$/i.test(base)) return true;
  return false;
};

export const scoreFontFamilyLabel = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 0;
  if (isJunkFontLabel(trimmed)) return 1;
  if (/^https?:\/\//i.test(trimmed)) return 1;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return 10 + Math.min(words, 4) + Math.min(trimmed.length, 48);
};

export const sanitizeFontFilenameBase = (value: string) =>
  String(value || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w .-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

const FONT_WEIGHT_LABELS: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

export const normalizeFontWeightLabel = (weight: string | number | undefined) => {
  const raw = String(weight || '').trim().toLowerCase();
  if (!raw || raw === 'normal' || raw === 'regular' || raw === '400') return '';
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return FONT_WEIGHT_LABELS[num] || '';
  }
  if (raw === 'bold' || raw === 'bolder') return 'Bold';
  if (raw === 'lighter') return 'Light';
  return sanitizeFontFilenameBase(raw);
};

export const buildFontDisplayName = (font: {
  url?: string;
  cachedUrl?: string;
  family?: string;
  title?: string;
  name?: string;
  filename?: string;
  weight?: string | number;
  style?: string;
}) => {
  const familyCandidates = [
    String(font?.family || '').trim(),
    String(font?.title || '').trim(),
    String(font?.name || '').trim(),
    String(font?.filename || '').trim(),
  ]
    .map((value) => sanitizeFontFilenameBase(value.replace(/^["']+|["']+$/g, '')))
    .filter((value) => value && !isJunkFontLabel(value));

  const family = familyCandidates.sort((a, b) => scoreFontFamilyLabel(b) - scoreFontFamilyLabel(a))[0] || '';
  if (!family) return '';

  const weight = normalizeFontWeightLabel(font?.weight);
  const style = String(font?.style || '').trim().toLowerCase();
  const italic = style === 'italic' || style === 'oblique';
  const suffixes = [weight, italic ? 'Italic' : ''].filter(Boolean);
  return suffixes.length ? `${family} ${suffixes.join(' ')}`.trim() : family;
};

export const mergeFontRecords = (left: any, right: any) => {
  if (!left) return right;
  if (!right) return left;

  const familyCandidates = [left.family, right.family, left.title, right.title, left.name, right.name, left.filename, right.filename];
  const family =
    familyCandidates
      .map((value) => sanitizeFontFilenameBase(String(value || '').replace(/^["']+|["']+$/g, '')))
      .filter((value) => value && !isJunkFontLabel(value))
      .sort((a, b) => scoreFontFamilyLabel(b) - scoreFontFamilyLabel(a))[0] || left.family || right.family || 'Font';

  return {
    ...left,
    ...right,
    family,
    format: right.format || left.format,
    cssSource: right.cssSource || left.cssSource,
    url: left.url || right.url,
    weight: right.weight || left.weight,
    style: right.style || left.style,
    filename: right.filename || left.filename,
    name: right.name || left.name,
  };
};

export const pickBestFontForUrl = (fonts: any[], url: string) =>
  fonts
    .filter((font) => String(font?.url || '') === url)
    .reduce((best, current) => mergeFontRecords(best, current), null as any);

export const getFontFilenameBase = (font: {
  url?: string;
  cachedUrl?: string;
  family?: string;
  title?: string;
  name?: string;
  filename?: string;
  weight?: string | number;
  style?: string;
}) => {
  const display = buildFontDisplayName(font);
  if (display) return display;

  for (const source of [String(font?.url || '').trim(), String(font?.cachedUrl || '').trim()]) {
    if (!source) continue;
    const fromUrl = filenameFromUrlPath(source);
    if (!fromUrl) continue;
    const base = fromUrl.replace(/\.[^/.]+$/, '') || fromUrl;
    if (base && !isJunkFontLabel(base)) return sanitizeFontFilenameBase(base);
  }

  return 'font';
};

export const getAvailableFontDownloadFormats = (font: { url?: string; cachedUrl?: string; format?: string }): FontDownloadFormat[] => {
  const source = resolveFontSourceFormat(font);
  const formats: FontDownloadFormat[] = ['original'];
  for (const fmt of getFontConversionOutputs(source)) {
    if (fmt !== source && !formats.includes(fmt as FontDownloadFormat)) {
      formats.push(fmt as FontDownloadFormat);
    }
  }
  return formats;
};

export const resolveFontTargetFormat = (
  font: { url?: string; cachedUrl?: string; format?: string },
  choice: FontDownloadFormat
): FontZipOutputFormat => {
  const source = resolveFontSourceFormat(font);
  if (choice === 'original') {
    if (FONT_ZIP_OUTPUT_FORMATS.includes(source as FontZipOutputFormat)) return source as FontZipOutputFormat;
    return 'ttf';
  }
  return choice;
};

export const getFontOutputFormat = (
  font: { url?: string; cachedUrl?: string; format?: string },
  selectedFormats: Record<string, string>
): FontDownloadFormat => {
  const options = getAvailableFontDownloadFormats(font);
  const key = getFontSelectionKey(font);
  const chosen = String(selectedFormats[key] || '').toLowerCase() as FontDownloadFormat;
  if (options.includes(chosen)) return chosen;
  return 'original';
};

export const buildFontZipItem = (font: any, toFormat: FontZipOutputFormat, filenameBase: string) => ({
  url: resolveFontAssetUrl(font),
  originalUrl: String(font?.url || '').trim(),
  cssSource: String(font?.cssSource || '').trim() || undefined,
  status: String(font?.status || '').trim() || undefined,
  toFormat,
  originalFormat: resolveFontSourceFormat(font),
  filenameBase,
  zipEntryName: buildFontZipEntryName(filenameBase, toFormat),
  metadataFilename: buildFontDisplayName(font) || String(font?.filename || font?.name || '').trim() || undefined,
  assetType: 'font' as const,
});

/** ZIP includes original + converted targets per source format rules. */
export const buildFontZipItems = (font: any, filenameBase?: string) => {
  const base = filenameBase || getFontFilenameBase(font);
  const source = resolveFontSourceFormat(font);
  const targets = getFontConversionOutputs(source);
  return targets.map((toFormat) => buildFontZipItem(font, toFormat, base));
};
