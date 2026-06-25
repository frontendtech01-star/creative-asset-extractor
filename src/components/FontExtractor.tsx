import React, { useEffect, useMemo, useState } from 'react';
import { Check, Download, FolderOpen, Search, Type } from 'lucide-react';
import { apiFetch, apiUrl } from '../lib/api';
import {
  buildFontDisplayName,
  buildFontZipItem,
  getFontFamilyFolderName,
  getFontFilenameBase,
  getFontSelectionKey,
  isJunkFontLabel,
  normalizeFontStyleKey,
  normalizeFontWeightKey,
  resolveFontIdentityFields,
  resolveFontAssetUrl,
  resolveFontSourceFormat,
} from '../lib/fontAsset';

const DEFAULT_PREVIEW_TEXT = "Rome wasn't built in a day, but they were laying bricks every hour";

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

const getFontVariantKey = (font: any) => {
  const identity = resolveFontIdentityFields(font);
  return [
    getReadableFontLabel(font),
    normalizeFontWeightKey(identity.weight),
    normalizeFontStyleKey(String(identity.style || '')),
    resolveFontSourceFormat(font),
  ].join('|').toLowerCase();
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
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
      <p className="min-h-16 text-lg leading-6 text-zinc-900" style={loaded ? { fontFamily: `"${family}"` } : undefined}>
        {text || DEFAULT_PREVIEW_TEXT}
      </p>
    </div>
  );
}

export default function FontExtractor({ fonts, sourcePageUrl = '' }: { fonts: any[]; sourcePageUrl?: string }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [downloadResult, setDownloadResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(new Set());
  }, [fonts, sourcePageUrl]);

  const openDownloadFolder = async () => {
    try {
      await apiFetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'fonts',
          sourcePageUrl: sourcePageUrl || undefined,
        }),
      });
    } catch {
      // best-effort local shortcut
    }
  };

  const handleDownload = async (font: any) => {
    const url = getFontSelectionKey(font);
    setDownloading(url);
    const originalFormat = resolveFontSourceFormat(font);
    const toFormat = originalFormat === 'woff2' ? 'woff2' : 'woff';
    setDownloadResult(null);

    try {
      const params = new URLSearchParams({
        url: resolveFontAssetUrl(font),
        originalUrl: url,
        toFormat,
        originalFormat,
        filenameBase: getFontFilenameBase(font),
        familyFolder: getFontFamilyFolderName(font),
        metadataFilename: String(font?.filename || font?.name || font?.family || '').trim(),
        save: '1',
      });
      if (sourcePageUrl) params.set('sourcePageUrl', sourcePageUrl);
      const response = await apiFetch(`/api/convert-font?${params.toString()}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Font save failed');
      setDownloadResult({ ok: true, message: `${getReadableFontLabel(font)} saved to Fonts.` });
    } catch (error: any) {
      console.error('Download error:', error);
      setDownloadResult({ ok: false, message: error?.message || 'Failed to download or convert font.' });
    } finally {
      setDownloading(null);
    }
  };

  const displayFonts = useMemo(() => {
    const seen = new Map<string, any>();
    fonts.forEach((font) => {
      if (!getFontSelectionKey(font)) return;
      const key = getFontVariantKey(font);
      if (!seen.has(key)) seen.set(key, font);
    });
    return Array.from(seen.values());
  }, [fonts]);

  const filteredFonts = displayFonts.filter(font => {
    const label = getReadableFontLabel(font);
    const filename = getOriginalFontFilename(font);
    const matchesSearch = `${label} ${filename}`.toLowerCase().includes(searchTerm.toLowerCase());
    const format = resolveFontSourceFormat(font);
    return matchesSearch && (format === 'woff' || format === 'woff2');
  });

  const selectedFonts = filteredFonts.filter((font) => selected.has(getFontSelectionKey(font)));
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

  const handleDownloadAll = async () => {
    if (selectedFonts.length === 0) return;
    setDownloadingZip(true);
    setDownloadResult(null);
    try {
      const items = selectedFonts.flatMap((font) =>
        [buildFontZipItem(font, resolveFontSourceFormat(font) === 'woff2' ? 'woff2' : 'woff', getFontFilenameBase(font))]
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
      setDownloadResult({ ok: true, message: `${selectedFonts.length} selected font${selectedFonts.length === 1 ? '' : 's'} saved as ${result.filename || 'fonts.zip'}.` });
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
            disabled={downloadingZip || selectedCount === 0}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 sm:flex-none"
          >
            {downloadingZip ? (
              <span className="animate-pulse">Creating ZIP...</span>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Download Selected ({selectedCount})
              </>
            )}
          </button>
        </div>
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
          {downloadResult.ok ? (
            <button
              type="button"
              onClick={() => void openDownloadFolder()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open Folder
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredFonts.map((font, idx) => {
          const selectionKey = getFontSelectionKey(font);
          const identity = resolveFontIdentityFields(font);
          const family = getReadableFontLabel(font);
          const format = resolveFontSourceFormat(font).toUpperCase();
          const weight = normalizeFontWeightKey(identity.weight);
          const style = normalizeFontStyleKey(String(identity.style || ''));
          const isSelected = selected.has(selectionKey);
          return (
            <div
              key={`${selectionKey}-${idx}`}
              onClick={() => toggleSelected(font)}
              className={`group relative cursor-pointer rounded-2xl border p-6 shadow-sm transition-all hover:bg-zinc-100 hover:shadow-md ${
                isSelected ? 'border-blue-600 bg-zinc-100 ring-2 ring-blue-600/20' : 'border-zinc-200 bg-white'
              }`}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelected(font);
                }}
                className={`absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border-2 transition ${
                  isSelected
                    ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
                    : 'border-white bg-zinc-900/25 text-white opacity-0 shadow-sm group-hover:opacity-100'
                }`}
                title={isSelected ? 'Unselect font' : 'Select font'}
                aria-label={isSelected ? 'Unselect font' : 'Select font'}
              >
                <Check className="h-5 w-5 stroke-[2.5]" aria-hidden />
              </button>
              <div className="flex items-start justify-between mb-4">
                <div className="min-w-0 pr-12">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Font Family</p>
                  <h3 className="mt-1 max-w-full truncate font-semibold text-zinc-900" title={family}>
                    {family}
                  </h3>
                  <p className="mt-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {format} · {weight} · {style}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2">
                <div className="block w-full overflow-hidden rounded-xl text-left">
                  <FontPreview font={font} text={previewText} sourcePageUrl={sourcePageUrl} />
                </div>
                <div className="flex gap-2 w-full">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDownload(font);
                    }}
                    disabled={downloading === selectionKey}
                    className="flex w-full items-center justify-center gap-2 bg-zinc-900 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {downloading === selectionKey ? (
                      <span className="animate-pulse">...</span>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Download
                      </>
                    )}
                  </button>
                </div>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSearch(getReadableFontLabel(font));
                  }}
                  className="w-full flex items-center justify-center gap-2 bg-zinc-100 text-zinc-700 px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-200 transition-colors"
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
