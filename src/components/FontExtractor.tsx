import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Search, Type, Filter } from 'lucide-react';
import { apiFetch, apiFetchWithTimeout } from '../lib/api';
import {
  buildFontZipItems,
  getAvailableFontDownloadFormats,
  getFontFilenameBase,
  getFontOutputFormat,
  getFontSelectionKey,
  resolveFontAssetUrl,
  resolveFontSourceFormat,
  resolveFontTargetFormat,
  type FontDownloadFormat,
} from '../lib/fontAsset';
import { appendSourcePageUrl } from '../lib/creativeAssetsFolder';
import { creativeAssetsFolderLabel } from '../lib/creativeAssetsFolder';
import { getFontDownloadFilename } from '../lib/filename';
import { saveBlob } from '../lib/download';
import { CompletionCard } from './ProgressExperience';

type SavedDownloadPayload = {
  ok?: boolean;
  filename?: string;
  downloadPath?: string;
  localPath?: string;
  size?: number;
  addedCount?: number;
  failedCount?: number;
  error?: string;
  warning?: string;
};

const readSavedDownloadPayload = async (response: Response) => {
  const body = await response.json().catch(() => ({} as SavedDownloadPayload));
  if (!response.ok) {
    throw new Error(body?.error || 'The file was not saved to Downloads.');
  }
  if (!body?.downloadPath && !body?.localPath) {
    throw new Error('The file was created but the app did not return a Downloads path.');
  }
  return body;
};

export default function FontExtractor({ fonts, sourcePageUrl = '' }: { fonts: any[]; sourcePageUrl?: string }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [completion, setCompletion] = useState<{ title: string; detail?: string; size?: number } | null>(null);
  const [selectedFormats, setSelectedFormats] = useState<Record<string, FontDownloadFormat>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const handleFormatChange = (url: string, format: FontDownloadFormat) => {
    setSelectedFormats((prev) => ({ ...prev, [url]: format }));
  };

  useEffect(() => {
    setSelectedFormats((prev) => {
      const next = { ...prev };
      for (const font of fonts) {
        const key = getFontSelectionKey(font);
        if (!key || next[key]) continue;
        next[key] = 'original';
      }
      return next;
    });
  }, [fonts]);

  const handleDownload = async (font: any) => {
    const assetUrl = resolveFontAssetUrl(font);
    const originUrl = String(font?.url || '').trim();
    const selectionKey = getFontSelectionKey(font);
    if (!assetUrl) {
      alert('Font URL is missing for this item.');
      return;
    }
    setDownloading(selectionKey);
    setCompletion(null);
    try {
      const originalFormat = resolveFontSourceFormat(font);
      const selectedChoice = getFontOutputFormat(font, selectedFormats);
      const toFormat = resolveFontTargetFormat(font, selectedChoice);
      const filenameBase = getFontFilenameBase(font);
      const buildPath = (downloadUrl: string) => {
        const params = new URLSearchParams({
          url: downloadUrl,
          toFormat,
          originalFormat,
          filenameBase: filenameBase,
          save: '1',
        });
        appendSourcePageUrl(params, sourcePageUrl);
        if (originUrl) params.set('originalUrl', originUrl);
        const metadataFilename = String(font?.filename || font?.name || '').trim();
        if (metadataFilename) params.set('metadataFilename', metadataFilename);
        return `/api/convert-font?${params.toString()}`;
      };

      let response = await apiFetch(buildPath(assetUrl));
      if (!response.ok && originUrl && originUrl !== assetUrl) {
        response = await apiFetch(buildPath(originUrl));
      }
      if (!response.ok && originUrl && originUrl !== assetUrl && String(assetUrl).includes('/cached-fonts-original/')) {
        // Cached temp files can be cleaned up by the OS; retry using the original public URL.
        response = await apiFetch(buildPath(originUrl));
      }
      if (!response.ok && originUrl) {
        // Cloudflare-protected assets can return 404/403 to the Node server while the browser can fetch them.
        // As a fallback, fetch in the browser and ask the server to convert provided bytes.
        try {
          const fetched = await fetch(originUrl, { cache: 'no-store', referrerPolicy: 'no-referrer' });
          if (fetched.ok) {
            const arrayBuffer = await fetched.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);
            response = await apiFetch('/api/convert-font-buffer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                base64,
                toFormat,
                originalFormat,
                filenameBase,
                save: true,
                sourcePageUrl: sourcePageUrl || undefined,
                metadataFilename: String(font?.filename || font?.name || '').trim() || undefined,
              }),
            });
          }
        } catch {
          // ignore; surface original failure below
        }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `Download failed (${response.status})`);
      }

      const saved = await readSavedDownloadPayload(response);
      setCompletion({
        title: saved.warning ? 'Font saved (fallback)' : 'Font saved',
        detail:
          saved.warning ||
          `Saved to ${creativeAssetsFolderLabel(sourcePageUrl, 'Fonts')} as ${saved.filename || getFontDownloadFilename(originUrl || assetUrl, toFormat, filenameBase)}.`,
        size: saved.size,
      });
    } catch (error: any) {
      const selectedChoice = getFontOutputFormat(font, selectedFormats);
      const toFormat = resolveFontTargetFormat(font, selectedChoice);
      const assetPath = String(font?.url || assetUrl || '');
      const filenameBase = getFontFilenameBase(font) || 'font';
      const text = [
        `Font could not be prepared as ${toFormat.toUpperCase()}.`,
        '',
        `URL: ${assetPath}`,
        font?.cachedUrl ? `Cached URL: ${font.cachedUrl}` : '',
        font?.status ? `Status: ${font.status}` : '',
        error?.message ? `Reason: ${error.message}` : '',
        '',
      ].filter(Boolean).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      saveBlob(blob, `${filenameBase}.asset-url.txt`);
      setCompletion({
        title: 'Font path saved',
        detail: 'The source blocked the font bytes, so the asset URL was saved instead.',
        size: blob.size,
      });
    } finally {
      setTimeout(() => {
        setDownloading((prev) => (prev === selectionKey ? null : prev));
      }, 700);
    }
  };

  const openDownloads = async () => {
    try {
      await apiFetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'downloads', sourcePageUrl: sourcePageUrl || undefined }),
      });
    } catch {
      // Best-effort local shortcut.
    }
  };

  const filteredFonts = useMemo(() => fonts.filter((font) => {
    const family = String(font.family || '').toLowerCase();
    const urlName = String(font.url || '').toLowerCase();
    const matchesSearch =
      family.includes(searchTerm.toLowerCase()) || urlName.includes(searchTerm.toLowerCase());
    const sourceFormat = resolveFontSourceFormat(font);
    const matchesFilter = filterType === 'all' || sourceFormat === filterType.toLowerCase();
    return matchesSearch && matchesFilter;
  }), [fonts, searchTerm, filterType]);

  useEffect(() => {
    setSelected(new Set());
  }, [fonts]);

  const selectedFonts = filteredFonts.filter((font) => selected.has(getFontSelectionKey(font)));

  const uniqueTypes = Array.from(
    new Set(fonts.map((font) => resolveFontSourceFormat(font)).filter(Boolean))
  );

  const handleDownloadAll = async () => {
    if (selectedFonts.length === 0) return;
    setDownloadingZip(true);
    setCompletion(null);
    try {
      const items = selectedFonts.flatMap((font) => buildFontZipItems(font));
      const response = await apiFetchWithTimeout('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, save: true, filename: 'fonts.zip', sourcePageUrl: sourcePageUrl || undefined }),
      });
      const saved = await readSavedDownloadPayload(response);
      const packedCount = Number(saved.addedCount ?? response.headers.get('X-Zip-Added-Count') ?? 0);
      const failedCount = Number(saved.failedCount ?? response.headers.get('X-Zip-Failed-Count') ?? 0);
      if (packedCount <= 0) {
        throw new Error(
          failedCount > 0
            ? `ZIP contained no fonts (${failedCount} failed). Try downloading individually.`
            : 'ZIP was empty. Try downloading fonts individually.'
        );
      }
      const failedNote =
        failedCount > 0 ? ' Some fonts converted successfully. Check report for skipped files.' : '';
      setCompletion({
        title: 'Fonts ZIP ready',
        detail: `${packedCount} font file${packedCount === 1 ? '' : 's'} saved to ${creativeAssetsFolderLabel(sourcePageUrl, 'Fonts')} as ${saved.filename || 'fonts.zip'}.${failedNote}`,
        size: saved.size,
      });
    } catch (error: any) {
      console.error('Download all error:', error);
      alert(error?.message || 'Failed to download fonts as ZIP.');
    } finally {
      setDownloadingZip(false);
    }
  };

  const copyPath = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedPath(url);
      setTimeout(() => setCopiedPath((prev) => (prev === url ? null : prev)), 1400);
    } catch {
      try {
        const temp = document.createElement('textarea');
        temp.value = url;
        temp.setAttribute('readonly', '');
        temp.style.position = 'absolute';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        setCopiedPath(url);
        setTimeout(() => setCopiedPath((prev) => (prev === url ? null : prev)), 1400);
      } catch {
        window.prompt('Copy font path:', url);
      }
    }
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
      {completion && !downloadingZip && !downloading ? (
        <CompletionCard
          title={completion.title}
          detail={completion.detail}
          size={completion.size}
          onOpenFolder={openDownloads}
        />
      ) : null}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-center">
        <div className="flex gap-4 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input
              type="text"
              placeholder="Search fonts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="pl-9 pr-8 py-2 bg-white border border-zinc-200 rounded-xl text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Types</option>
              {uniqueTypes.map(type => (
                <option key={type} value={type}>{type.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="w-full sm:w-auto flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => setSelected(new Set(filteredFonts.map((f) => getFontSelectionKey(f)).filter(Boolean)))}
            className="w-full sm:w-auto bg-white border border-zinc-200 text-zinc-700 px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-50 transition-colors"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="w-full sm:w-auto bg-white border border-zinc-200 text-zinc-700 px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-50 transition-colors"
          >
            Clear
          </button>
          <button
            onClick={handleDownloadAll}
            disabled={downloadingZip || selectedFonts.length === 0}
            className="w-full sm:w-auto flex items-center justify-center gap-2 bg-blue-600 text-white px-6 py-2.5 rounded-xl font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {downloadingZip ? (
              <span>Creating ZIP</span>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Download Selected ({selectedFonts.length})
              </>
            )}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredFonts.map((font, idx) => {
          const filename = getFontFilenameBase(font);
          const selectionKey = getFontSelectionKey(font);
          const isSelected = selected.has(selectionKey);
          const outputFormat = getFontOutputFormat(font, selectedFormats);
          const outputOptions = getAvailableFontDownloadFormats(font);
          const formatLabel = (fmt: FontDownloadFormat) => {
            if (fmt === 'original') {
              const source = resolveFontSourceFormat(font);
              return `ORIGINAL (${source.toUpperCase()})`;
            }
            return fmt.toUpperCase();
          };
          return (
            <div
              key={selectionKey || `font-${idx}`}
              className={`media-card-enter bg-white border rounded-2xl p-6 shadow-sm hover:shadow-md transition-all ${
                isSelected ? 'border-blue-600 ring-2 ring-blue-600/20' : 'border-zinc-200'
              }`}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-zinc-900 truncate max-w-[200px]" title={filename}>
                    {filename}
                  </h3>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider mt-1">{font.format}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectionKey) return;
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(selectionKey)) next.delete(selectionKey);
                        else next.add(selectionKey);
                        return next;
                      });
                    }}
                    title={isSelected ? 'Unselect' : 'Select'}
                  >
                    <CheckCircle2 className={isSelected ? 'w-6 h-6 text-blue-600' : 'w-6 h-6 text-zinc-300'} />
                  </button>
                  <div className="w-10 h-10 bg-zinc-50 rounded-lg flex items-center justify-center text-zinc-400">
                    <Type className="w-5 h-5" />
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2">
                <div className="flex gap-2 w-full">
                  <select
                    className="flex-1 bg-zinc-50 border border-zinc-200 text-zinc-700 text-sm rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-medium appearance-none"
                    value={outputFormat}
                    onChange={(e) => handleFormatChange(selectionKey, e.target.value as FontDownloadFormat)}
                  >
                    {outputOptions.map((fmt) => (
                      <option key={fmt} value={fmt}>{formatLabel(fmt)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleDownload(font)}
                    disabled={downloading === selectionKey}
                    className="flex-2 flex items-center justify-center flex-grow gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    {downloading === selectionKey ? 'Starting...' : 'Download'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => copyPath(font.url)}
                  className="w-full flex items-center justify-center gap-2 bg-zinc-100 text-zinc-700 px-3 py-2 rounded-xl font-medium text-xs hover:bg-zinc-200 transition-colors"
                >
                  {copiedPath === font.url ? 'Copied Path' : 'Copy Path'}
                </button>
                <p className="text-[11px] text-zinc-500 truncate" title={font.url}>{font.url}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
