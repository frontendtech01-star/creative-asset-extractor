import React, { useEffect, useMemo, useState } from 'react';
import { Download, Search, Type, Filter } from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  buildFontZipItem,
  getFontFamilyFolderName,
  getFontFilenameBase,
  getFontSelectionKey,
  resolveFontAssetUrl,
  resolveFontSourceFormat,
} from '../lib/fontAsset';

const DEFAULT_PREVIEW_TEXT = "Rome wasn't built in a day, but they were laying bricks every hour";

const previewFamily = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return `font-preview-${Math.abs(hash)}`;
};

function FontPreview({ font, text }: { font: any; text: string }) {
  const sourceUrl = String(font?.url || '').trim();
  const fallbackUrl = resolveFontAssetUrl(font);
  const urls = useMemo(() => Array.from(new Set([sourceUrl, fallbackUrl].filter(Boolean))), [sourceUrl, fallbackUrl]);
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
  const [filterType, setFilterType] = useState('all');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [selectedFormats, setSelectedFormats] = useState<Record<string, string>>({});
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);

  const handleFormatChange = (url: string, format: string) => {
    setSelectedFormats(prev => ({ ...prev, [url]: format }));
  };

  const handleDownload = async (font: any) => {
    const url = getFontSelectionKey(font);
    setDownloading(url);
    const originalFormat = resolveFontSourceFormat(font);
    const toFormat = selectedFormats[url] || originalFormat || 'ttf';

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
    } catch (error: any) {
      console.error('Download error:', error);
      alert(error?.message || 'Failed to download or convert font.');
    } finally {
      setDownloading(null);
    }
  };

  const filteredFonts = fonts.filter(font => {
    const matchesSearch = font.family.toLowerCase().includes(searchTerm.toLowerCase());
    const currentFormat = selectedFormats[font.url] || (['ttf', 'woff', 'woff2', 'eot', 'svg'].includes(font.format) ? font.format : 'ttf');
    const matchesFilter = filterType === 'all' || currentFormat.toLowerCase() === filterType.toLowerCase();
    return matchesSearch && matchesFilter;
  });

  const uniqueTypes = ['ttf', 'woff', 'woff2', 'eot', 'svg'];

  const handleDownloadAll = async () => {
    if (filteredFonts.length === 0) return;
    setDownloadingZip(true);
    try {
      const items = filteredFonts.flatMap((font) =>
        (['ttf', 'woff'] as const).map((toFormat) =>
          buildFontZipItem(font, toFormat, getFontFilenameBase(font))
        )
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
    } catch (error: any) {
      console.error('Download all error:', error);
      alert(error?.message || 'Failed to download fonts as ZIP.');
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
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="pl-9 pr-8 py-2 bg-white border border-zinc-200 rounded-xl text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="all">All Types</option>
              {uniqueTypes.map(type => (
                <option key={type} value={type}>{type.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          onClick={handleDownloadAll}
          disabled={downloadingZip || filteredFonts.length === 0}
          className="w-full sm:w-auto flex items-center justify-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-medium text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {downloadingZip ? (
            <span className="animate-pulse">Creating ZIP...</span>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Download All ({filteredFonts.length})
            </>
          )}
        </button>
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredFonts.map((font, idx) => {
          const selectionKey = getFontSelectionKey(font);
          return (
            <div key={idx} className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-zinc-900 truncate max-w-[200px]" title={font.family}>
                    {font.family}
                  </h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider mt-1">{font.format}</p>
                </div>
                <div className="w-10 h-10 bg-zinc-50 rounded-lg flex items-center justify-center text-zinc-400">
                  <Type className="w-5 h-5" />
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2">
                <FontPreview font={font} text={previewText} />
                <div className="flex gap-2 w-full">
                  <select
                    className="flex-1 bg-zinc-50 border border-zinc-200 text-zinc-700 text-sm rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium appearance-none"
                    value={selectedFormats[font.url] || (['ttf', 'woff', 'woff2', 'eot', 'svg'].includes(font.format) ? font.format : 'ttf')}
                    onChange={(e) => handleFormatChange(font.url, e.target.value)}
                  >
                    <option value="ttf">TTF</option>
                    <option value="woff">WOFF</option>
                    <option value="woff2">WOFF2</option>
                    <option value="eot">EOT</option>
                    <option value="svg">SVG</option>
                  </select>
                  <button
                    onClick={() => handleDownload(font)}
                    disabled={downloading === selectionKey}
                    className="flex-2 flex items-center justify-center flex-grow gap-2 bg-zinc-900 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                  onClick={() => handleSearch(font.family)}
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
