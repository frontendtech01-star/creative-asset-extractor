import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Search, Type } from 'lucide-react';
import { apiFetch, apiUrl } from '../lib/api';
import {
  buildFontDisplayName,
  buildFontZipItem,
  getFontFilenameBase,
  getFontLogicalKey,
  getFontSelectionKey,
  isJunkFontLabel,
  normalizeFontStyleKey,
  normalizeFontWeightKey,
  resolveFontIdentityFields,
  resolveFontAssetUrl,
  resolveFontSourceFormat,
  scoreFontRecord,
  type FontZipOutputFormat,
} from '../lib/fontAsset';

const DEFAULT_PREVIEW_TEXT = "Rome wasn't built in a day, but they were laying bricks every hour";
const FONT_DOWNLOAD_FORMATS = ['woff', 'ttf'] as FontZipOutputFormat[];

const previewFamily = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return `font-preview-${Math.abs(hash)}`;
};

const getReadableFontLabel = (font: any) => {
  const display = buildFontDisplayName(font);
  if (display) return display;
  const family = String(font?.family || '').trim();
  if (family && !isJunkFontLabel(family)) return family;
  const filename = getFontFilenameBase(font);
  if (filename && !isJunkFontLabel(filename)) return filename;
  return 'Website Font';
};

const isIconFont = (font: any) => {
  const label = `${getReadableFontLabel(font)} ${font?.family || ''} ${font?.name || ''} ${font?.url || ''}`;
  return /material\s*icons|font\s*awesome|fontawesome|glyphicons?|icomoon|bootstrap[- ]icons|icon[-_ ]?font/i.test(label);
};

const getOriginalFontFilename = (font: any) => {
  const explicit = String(font?.originalFilename || '').trim();
  if (explicit) return explicit;
  const url = String(font?.url || font?.cachedUrl || '').trim();
  try {
    const pathname = new URL(url).pathname;
    const filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    if (filename) return filename;
  } catch {
    const filename = url.split(/[?#]/)[0]?.split('/').filter(Boolean).pop() || '';
    if (filename) return filename;
  }
  return String(font?.filename || font?.name || '').trim() || 'font';
};

const getFontSourceLabel = (font: any) => {
  const source = String(font?.source || '').trim();
  if (source === '@font-face' || source === 'CSS') return '@font-face';
  if (source) return source;
  if (font?.cssSource) return '@font-face';
  if (font?.fontMetadata) return 'Font metadata';
  if (font?.computedFamily) return 'Computed';
  return 'Network';
};

const getFontSourceVerifier = (font: any) => {
  const source = `${font?.url || ''} ${font?.cssSource || ''}`.toLowerCase();
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(source)) {
    return {
      label: 'Google Fonts',
      className: 'border-blue-100 bg-blue-50 text-blue-700',
      hint: 'Google font source detected',
    };
  }
  if (/typekit\.net|fonts\.adobe\.com|use\.typekit\.net/.test(source)) {
    return {
      label: 'Adobe Typekit',
      className: 'border-purple-100 bg-purple-50 text-purple-700',
      hint: 'Adobe/Typekit font source detected',
    };
  }
  return {
    label: 'Client font',
    className: 'border-zinc-200 bg-zinc-50 text-zinc-700',
    hint: 'Client-hosted font source detected',
  };
};

function FontPreview({ font, text, sourcePageUrl }: { font: any; text: string; sourcePageUrl?: string }) {
  const sourceUrl = String(font?.url || '').trim();
  const fallbackUrl = resolveFontAssetUrl(font);
  const sourceFormat = resolveFontSourceFormat(font);
  const proxyUrl = useMemo(() => {
    if (!fallbackUrl) return '';
    const params = new URLSearchParams({
      url: fallbackUrl,
      originalUrl: sourceUrl || fallbackUrl,
      toFormat: sourceFormat,
      originalFormat: sourceFormat,
      filenameBase: getFontFilenameBase(font),
    });
    if (sourcePageUrl) params.set('sourcePageUrl', sourcePageUrl);
    return apiUrl(`/api/convert-font?${params.toString()}`);
  }, [fallbackUrl, font, sourceFormat, sourcePageUrl, sourceUrl]);
  const urls = useMemo(
    () => Array.from(new Set([proxyUrl, fallbackUrl, sourceUrl].filter(Boolean))),
    [proxyUrl, fallbackUrl, sourceUrl]
  );
  const family = useMemo(() => previewFamily(getFontSelectionKey(font) || getFontFilenameBase(font)), [font]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let disposed = false;
    let active: FontFace | null = null;
    void (async () => {
      for (const url of urls) {
        try {
          const face = await new FontFace(family, `url("${url.replace(/"/g, '\\"')}")`).load();
          if (disposed) return;
          active = face;
          document.fonts.add(face);
          setLoaded(true);
          return;
        } catch {
          // Try the next exact/cached source.
        }
      }
    })();
    return () => {
      disposed = true;
      if (active) document.fonts.delete(active);
    };
  }, [family, urls]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-2.5">
      <p
        className="min-h-12 text-base leading-5 text-zinc-900"
        style={loaded ? {
          fontFamily: `"${family}"`,
          fontWeight: String(font?.variationWeight || font?.weight || '400'),
          fontVariationSettings: font?.variationWeight ? `'wght' ${font.variationWeight}` : undefined,
        } : undefined}
      >
        {text || DEFAULT_PREVIEW_TEXT}
      </p>
    </div>
  );
}

export default function FontExtractor({
  fonts,
  sourcePageUrl = '',
  onValidCountChange,
  onDownloadReady,
}: {
  fonts: any[];
  sourcePageUrl?: string;
  onValidCountChange?: (count: number) => void;
  onDownloadReady?: (notice: { title: string; detail?: string; target: string; sourcePageUrl?: string; folderPath?: string }) => void;
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingLabel, setDownloadingLabel] = useState('');
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [downloadResult, setDownloadResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zipFormats, setZipFormats] = useState<Set<FontZipOutputFormat>>(new Set(FONT_DOWNLOAD_FORMATS));
  const [fixVerticalMetrics, setFixVerticalMetrics] = useState(true);
  const [fontVerticalMetrics, setFontVerticalMetrics] = useState<Record<string, boolean>>({});
  const [fontFormats, setFontFormats] = useState<Record<string, FontZipOutputFormat[]>>({});
  const [copiedFontUrl, setCopiedFontUrl] = useState('');

  const handleDownload = async (font: any) => {
    const url = getFontSelectionKey(font);
    setDownloading(url);
    const requestedFormats = fontFormats[url] || FONT_DOWNLOAD_FORMATS;
    const shouldFixVerticalMetrics = fontVerticalMetrics[url] ?? true;
    setDownloadingLabel('Downloading...');
    setDownloadResult(null);

    try {
      if (requestedFormats.length === 0) throw new Error('Select at least one download format.');
      const items = requestedFormats.map((format) => ({
        ...buildFontZipItem(font, format, getFontFilenameBase(font)),
        fixVerticalMetrics: shouldFixVerticalMetrics,
      }));
      const response = await apiFetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          save: true,
          filename: `${getFontFilenameBase(font)}.zip`,
          sourcePageUrl: sourcePageUrl || undefined,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Font save failed');
      const expectedOutputCount = requestedFormats.length;
      const addedCount = Number(result?.addedCount ?? expectedOutputCount);
      const failedCount = Number(result?.failedCount ?? 0);
      if (failedCount > 0 || addedCount < expectedOutputCount) {
        throw new Error(
          `Font conversion was incomplete: expected ${expectedOutputCount} output file${expectedOutputCount === 1 ? '' : 's'}, ` +
          `but ${addedCount} succeeded and ${failedCount} failed.`
        );
      }
      const label = getReadableFontLabel(font);
      const formatLabel = requestedFormats.map((format) => format.toUpperCase()).join(', ');
      const message = `${label} saved as ${formatLabel} (${addedCount} file${addedCount === 1 ? '' : 's'}) in ${result.filename || `${getFontFilenameBase(font)}.zip`}.`;
      setDownloadResult({ ok: true, message });
      onDownloadReady?.({
        title: 'Font saved',
        detail: message,
        target: 'fonts',
        sourcePageUrl: sourcePageUrl || undefined,
        folderPath: result?.folderPath,
      });
    } catch (error: any) {
      console.error('Download error:', error);
      setDownloadResult({ ok: false, message: error?.message || 'Failed to download or convert font.' });
    } finally {
      setDownloading(null);
      setDownloadingLabel('');
    }
  };

  const displayFonts = useMemo(() => {
    const byUrl = new Map<string, any>();

    fonts.forEach((font) => {
      const selectionKey = getFontSelectionKey(font);
      if (!selectionKey) return;

      const urlKey = selectionKey.toLowerCase();
      const current = byUrl.get(urlKey);
      const currentScore = current
        ? scoreFontRecord(current) +
          (getFontLogicalKey(current) ? 1000 : 0) +
          (String(current?.family || '').trim() ? 50 : 0)
        : -1;
      const nextScore =
        scoreFontRecord(font) +
        (getFontLogicalKey(font) ? 1000 : 0) +
        (String(font?.family || '').trim() ? 50 : 0);

      if (!current || nextScore > currentScore) {
        byUrl.set(urlKey, font);
      }
    });

    const byLogicalKey = new Map<string, any>();
    const passthrough: any[] = [];

    Array.from(byUrl.values()).forEach((font) => {
      const logicalKey = getFontLogicalKey(font);

      if (!logicalKey) {
        passthrough.push(font);
        return;
      }

      const current = byLogicalKey.get(logicalKey);
      const currentScore = current ? scoreFontRecord(current) : -1;
      const nextScore = scoreFontRecord(font);

      if (!current || nextScore > currentScore) {
        byLogicalKey.set(logicalKey, font);
      }
    });

    return [...byLogicalKey.values(), ...passthrough];
  }, [fonts]);

  useEffect(() => {
    onValidCountChange?.(displayFonts.length);
  }, [displayFonts.length, onValidCountChange]);

  useEffect(() => {
    // Font cards start unselected. Users explicitly tick the fonts they want
    // before creating a WOFF/TTF ZIP.
    setSelected(new Set());
    setZipFormats(new Set(FONT_DOWNLOAD_FORMATS));
    setFixVerticalMetrics(true);
    setFontVerticalMetrics(
      Object.fromEntries(displayFonts.map((font) => [getFontSelectionKey(font), true]).filter(([key]) => Boolean(key)))
    );
    setFontFormats(
      Object.fromEntries(
        displayFonts
          .map((font) => [getFontSelectionKey(font), [...FONT_DOWNLOAD_FORMATS]])
          .filter(([key]) => Boolean(key))
      )
    );
  }, [displayFonts, sourcePageUrl]);

  const filteredFonts = displayFonts.filter(font => {
    const label = getReadableFontLabel(font);
    const filename = getOriginalFontFilename(font);
    const matchesSearch = `${label} ${filename}`.toLowerCase().includes(searchTerm.toLowerCase());
    const format = resolveFontSourceFormat(font);
    return matchesSearch && ['woff', 'woff2', 'ttf'].includes(format);
  });

  const selectedFonts = displayFonts.filter((font) => selected.has(getFontSelectionKey(font)));
  const selectedCount = selectedFonts.length;
  const toggleSelected = (font: any) => {
    const key = getFontSelectionKey(font);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleZipFormat = (format: FontZipOutputFormat) => {
    setZipFormats((current) => {
      const next = new Set(current);
      if (next.has(format)) next.delete(format);
      else next.add(format);
      return next;
    });
  };

  const setGlobalVerticalMetrics = (enabled: boolean) => {
    setFixVerticalMetrics(enabled);
    setFontVerticalMetrics(
      Object.fromEntries(displayFonts.map((font) => [getFontSelectionKey(font), enabled]).filter(([key]) => Boolean(key)))
    );
  };

  const handleDownloadAll = async () => {
    if (selectedFonts.length === 0 || zipFormats.size === 0) return;
    setDownloadingZip(true);
    setDownloadResult(null);
    try {
      const requestedFormats = FONT_DOWNLOAD_FORMATS.filter((format) => zipFormats.has(format));
      const items = selectedFonts.flatMap((font) =>
        requestedFormats.map((format) => ({
          ...buildFontZipItem(font, format, getFontFilenameBase(font)),
          fixVerticalMetrics,
        }))
      );
      const response = await apiFetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          save: true,
          filename: 'fonts.zip',
          sourcePageUrl: sourcePageUrl || undefined,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Font ZIP save failed');
      const expectedOutputCount = selectedFonts.length * requestedFormats.length;
      const addedCount = Number(result?.addedCount ?? expectedOutputCount);
      const failedCount = Number(result?.failedCount ?? 0);
      if (failedCount > 0 || addedCount < expectedOutputCount) {
        throw new Error(
          `Font conversion was incomplete: expected ${expectedOutputCount} output files, ` +
          `but ${addedCount} succeeded and ${failedCount} failed.`
        );
      }
      const formatLabel = requestedFormats.map((format) => format.toUpperCase()).join(', ');
      const message = `${selectedFonts.length} selected font${selectedFonts.length === 1 ? '' : 's'} saved as ${addedCount} files (${formatLabel}) in ${result.filename || 'fonts.zip'}.`;
      setDownloadResult({ ok: true, message });
      onDownloadReady?.({
        title: 'Fonts saved',
        detail: message,
        target: 'fonts',
        sourcePageUrl: sourcePageUrl || undefined,
        folderPath: result?.folderPath,
      });
      setSelected(new Set());
    } catch (error: any) {
      console.error('Download all error:', error);
      setDownloadResult({ ok: false, message: error?.message || 'Failed to download fonts as ZIP.' });
    } finally {
      setDownloadingZip(false);
    }
  };

  const handleSearch = (fontFamily: string) => {
    const query = encodeURIComponent(`${fontFamily} font download`);
    window.open(`https://www.google.com/search?q=${query}`, '_blank');
  };

  const copyOriginalFontUrl = async (font: any) => {
    const originalUrl = String(font?.url || resolveFontAssetUrl(font) || '').trim();
    if (!originalUrl) return;
    await navigator.clipboard?.writeText(originalUrl).catch(() => undefined);
    setCopiedFontUrl(originalUrl);
    window.setTimeout(() => {
      setCopiedFontUrl((current) => (current === originalUrl ? '' : current));
    }, 1400);
  };

  if (fonts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
        <Type className="w-12 h-12 mb-4 text-zinc-300" />
        <p className="text-lg font-medium text-zinc-900">No fonts found</p>
        <p className="text-sm">We couldn't detect any web fonts on this page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-center">
        <div className="flex gap-4 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input
              type="text"
              placeholder="Search fonts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={selectedCount === 0}
            className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 sm:flex-none"
          >
            Clear Selection
          </button>
          <button
            onClick={handleDownloadAll}
            disabled={downloadingZip || selectedCount === 0 || zipFormats.size === 0}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 sm:flex-none"
          >
            {downloadingZip ? (
              <span className="animate-pulse">Creating ZIP...</span>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Download All Selected ({selectedCount})
              </>
            )}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 pb-4">
          <div>
            <p className="text-sm font-semibold text-zinc-900">Fix vertical metrics</p>
            <p className="mt-1 text-xs text-zinc-500">Auto-adjust vertical metrics during conversion.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={fixVerticalMetrics}
            onClick={() => setGlobalVerticalMetrics(!fixVerticalMetrics)}
            className={`inline-flex h-9 w-20 items-center rounded-lg border px-1 transition-colors ${
              fixVerticalMetrics ? 'justify-start border-emerald-600 bg-emerald-600 text-white' : 'justify-end border-zinc-300 bg-white text-zinc-700'
            }`}
          >
            <span className="w-1/2 text-center text-sm font-semibold">{fixVerticalMetrics ? 'On' : 'Off'}</span>
          </button>
        </div>
        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Download formats</p>
        <div className="mt-3 flex flex-wrap gap-5">
          {FONT_DOWNLOAD_FORMATS.map((format) => (
            <label key={format} className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-zinc-800">
              <input
                type="checkbox"
                checked={zipFormats.has(format)}
                onChange={() => toggleZipFormat(format)}
                className="h-5 w-5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
              />
              {format.toUpperCase()}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">Selected formats are created for every ticked font. TTF uses Transfonter conversion.</p>
      </div>

      <div>
        <label htmlFor="font-preview-input" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Font preview text
        </label>
        <input
          id="font-preview-input"
          value={previewText}
          onChange={(event) => setPreviewText(event.target.value)}
          placeholder={DEFAULT_PREVIEW_TEXT}
          className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      {downloadResult ? (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm font-medium ${
            downloadResult.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <p>{downloadResult.message}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filteredFonts.map((font, idx) => {
          const selectionKey = getFontSelectionKey(font);
          const identity = resolveFontIdentityFields(font);
          const family = getReadableFontLabel(font);
          const format = resolveFontSourceFormat(font).toUpperCase();
          const weight = normalizeFontWeightKey(identity.weight);
          const style = normalizeFontStyleKey(String(identity.style || ''));
          const isSelected = selected.has(selectionKey);
          const cardFixVerticalMetrics = fontVerticalMetrics[selectionKey] ?? true;
          const cardFormats = fontFormats[selectionKey] || FONT_DOWNLOAD_FORMATS;
          const sourceVerifier = getFontSourceVerifier(font);
          const iconFont = isIconFont(font);
          return (
            <div
              key={`${selectionKey}-${idx}`}
              onClick={() => toggleSelected(font)}
              className={`group relative cursor-pointer rounded-2xl border p-4 shadow-sm transition-all hover:bg-zinc-100 hover:shadow-md ${
                isSelected ? 'border-blue-600 bg-zinc-100 ring-2 ring-blue-600/20' : 'border-zinc-200 bg-white'
              }`}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelected(font);
                }}
                className={`absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 transition ${
                  isSelected
                    ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
                    : 'border-white bg-zinc-900/25 text-white opacity-0 shadow-sm group-hover:opacity-100'
                }`}
                title={isSelected ? 'Unselect font' : 'Select font'}
                aria-label={isSelected ? 'Unselect font' : 'Select font'}
              >
                <Check className="h-5 w-5 stroke-[2.5]" aria-hidden />
              </button>
              <div className="mb-2 flex items-start justify-between">
                <div className="min-w-0 pr-12">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Font Family</p>
                  <h3 className="mt-1 max-w-full truncate font-semibold text-zinc-900" title={family}>
                    {family}
                  </h3>
                  <p className="mt-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {format} · {weight} · {style}
                  </p>
                  <span
                    className={`mt-1.5 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sourceVerifier.className}`}
                    title={sourceVerifier.hint}
                  >
                    {sourceVerifier.label}
                  </span>
                </div>
              </div>

              <div className="mt-2 flex flex-col gap-1.5">
                {!iconFont ? (
                  <div className="block w-full overflow-hidden rounded-xl text-left">
                    <FontPreview font={font} text={previewText} sourcePageUrl={sourcePageUrl} />
                  </div>
                ) : null}
                <div onClick={(event) => event.stopPropagation()} className="rounded-xl border border-zinc-200 bg-zinc-50 p-2.5">
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-200 pb-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-zinc-900">Fix vertical metrics</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={cardFixVerticalMetrics}
                      onClick={() =>
                        setFontVerticalMetrics((current) => ({
                          ...current,
                          [selectionKey]: !cardFixVerticalMetrics,
                        }))
                      }
                      className={`inline-flex h-7 w-14 shrink-0 items-center rounded-lg border px-1 transition-colors ${
                        cardFixVerticalMetrics
                          ? 'justify-start border-emerald-600 bg-emerald-600 text-white'
                          : 'justify-end border-zinc-300 bg-white text-zinc-700'
                      }`}
                    >
                      <span className="w-1/2 text-center text-xs font-semibold">{cardFixVerticalMetrics ? 'On' : 'Off'}</span>
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Download formats</p>
                  <div className="mt-1.5 flex flex-wrap gap-2.5">
                    {FONT_DOWNLOAD_FORMATS.map((formatOption) => (
                      <label key={formatOption} className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-zinc-800">
                        <input
                          type="checkbox"
                          checked={cardFormats.includes(formatOption)}
                          onChange={() =>
                            setFontFormats((current) => {
                              const active = current[selectionKey] || FONT_DOWNLOAD_FORMATS;
                              const next = active.includes(formatOption)
                                ? active.filter((item) => item !== formatOption)
                                : [...active, formatOption];
                              return { ...current, [selectionKey]: next };
                            })
                          }
                          className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                        />
                        {formatOption.toUpperCase()}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 w-full">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDownload(font);
                    }}
                    disabled={downloading === selectionKey || cardFormats.length === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {downloading === selectionKey ? (
                      <span className="animate-pulse">{downloadingLabel || 'Downloading...'}</span>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Download
                      </>
                    )}
                  </button>
                </div>
                <div
                  onClick={(event) => event.stopPropagation()}
                  className="rounded-xl border border-zinc-200 bg-white p-2.5"
                >
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    Original font URL
                  </p>
                  <div className="flex items-center gap-2">
                    <a
                      href={String(font?.url || resolveFontAssetUrl(font) || '#')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 truncate rounded-lg bg-zinc-50 px-2.5 py-1.5 text-[11px] font-medium text-blue-700 hover:text-blue-800 hover:underline"
                      title={String(font?.url || resolveFontAssetUrl(font) || '')}
                    >
                      {String(font?.url || resolveFontAssetUrl(font) || 'No source URL')}
                    </a>
                    <button
                      type="button"
                      onClick={() => void copyOriginalFontUrl(font)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100"
                      title="Copy original font URL"
                      aria-label="Copy original font URL"
                    >
                      {copiedFontUrl === String(font?.url || '').trim() ? (
                        <Check className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSearch(getReadableFontLabel(font));
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-200"
                >
                  <Search className="w-4 h-4" />
                  Find on Web
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
