import React, { useEffect, useState } from 'react';
import { Check, Download, Image as ImageIcon, Search, Filter } from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  buildImageZipItem,
  getImageAssetKey,
  getImageDisplayName,
  getImageMetaBadges,
  imageNeedsConversionChoice,
  mergeImageMetaBadges,
  resolveImageConvertRequestUrl,
  resolveZipRasterTargetFormat,
} from '../lib/imageAsset';

export default function ImageExtractor({
  images,
  sourcePageUrl = '',
  onValidCountChange,
}: {
  images: any[];
  sourcePageUrl?: string;
  saveKind?: 'image' | 'icon';
  title?: string;
  onValidCountChange?: (count: number) => void;
}) {
  React.useEffect(() => {
    onValidCountChange?.(images.length);
  }, [images.length, onValidCountChange]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zipResult, setZipResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [fetchedMeta, setFetchedMeta] = useState<Record<string, { format?: string; dimensions?: string; size?: string }>>({});

  useEffect(() => {
    if (!images.length) return;
    let cancelled = false;
    void apiFetch('/api/image-meta-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePageUrl: sourcePageUrl || undefined,
        items: images.map((img) => ({ originalUrl: getImageAssetKey(img) })),
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const next: Record<string, { format?: string; dimensions?: string; size?: string }> = {};
        for (const [key, meta] of Object.entries(data?.results || {}) as Array<[string, any]>) {
          const badges = getImageMetaBadges(meta);
          next[key] = {
            ...badges,
            format: String(meta?.format || badges.format).toUpperCase(),
          };
        }
        setFetchedMeta(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [images, sourcePageUrl]);

  const handleDownload = async (img: any, filename: string) => {
    const key = getImageAssetKey(img);
    setDownloading(key);
    try {
      if (key.startsWith('data:')) {
        const comma = key.indexOf(',');
        const payload = comma >= 0 ? key.slice(comma + 1) : '';
        const base64 = key.slice(0, comma).includes(';base64') ? payload : btoa(decodeURIComponent(payload));
        const response = await apiFetch('/api/save-asset-buffer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64, filename, kind: 'image', sourcePageUrl: sourcePageUrl || undefined }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result?.error || 'Image save failed');
        return;
      }

      const params = new URLSearchParams({
        url: resolveImageConvertRequestUrl(img),
        originalUrl: key,
        metadataFilename: filename,
        save: '1',
      });
      if (sourcePageUrl) params.set('sourcePageUrl', sourcePageUrl);
      const response = await apiFetch(`/api/download-image?${params.toString()}`);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Image save failed');
    } catch (error: any) {
      console.error('Download error:', error);
      alert(error?.message || 'Failed to download image.');
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadAll = async () => {
    const selectedImages = filteredImages.filter((img) => selected.has(getImageAssetKey(img)));
    if (selectedImages.length === 0) return;
    setDownloadingZip(true);
    setZipResult(null);
    try {
      const items = selectedImages.map((img, index) =>
        buildImageZipItem(
          img,
          index,
          imageNeedsConversionChoice(img) ? resolveZipRasterTargetFormat(img, {}) : undefined
        )
      );
      const response = await apiFetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          save: true,
          filename: 'selected-images.zip',
          sourcePageUrl: sourcePageUrl || undefined,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'ZIP save failed');
      const addedCount = Number(result?.addedCount || 0);
      if (addedCount <= 0 || (!result?.downloadPath && !result?.localPath)) {
        throw new Error('Selected images ZIP was created without downloadable images.');
      }
      setZipResult({
        ok: true,
        message: `${addedCount} selected image${addedCount === 1 ? '' : 's'} saved as ${result.filename || 'selected-images.zip'}.`,
      });
      setSelected(new Set());
    } catch (error: any) {
      console.error('Download all error:', error);
      setZipResult({ ok: false, message: error?.message || 'Failed to download selected images as ZIP.' });
    } finally {
      setDownloadingZip(false);
    }
  };

  const filteredImages = images.filter(img => {
    const matchesSearch = img.url.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterType === 'all' || img.type.toLowerCase() === filterType.toLowerCase();
    return matchesSearch && matchesFilter;
  });

  const uniqueTypes = Array.from(new Set(images.map(img => img.type.toLowerCase()))).filter(Boolean);
  const selectedCount = filteredImages.filter((img) => selected.has(getImageAssetKey(img))).length;

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
        <ImageIcon className="w-12 h-12 mb-4 text-zinc-300" />
        <p className="text-lg font-medium text-zinc-900">No images found</p>
        <p className="text-sm">We couldn't detect any images on this page.</p>
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
              placeholder="Search images..."
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

      {zipResult ? (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm font-medium ${
            zipResult.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {zipResult.message}
        </div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {filteredImages.map((img, idx) => {
          const key = getImageAssetKey(img);
          const filename = getImageDisplayName(img, idx);
          const isSelected = selected.has(key);
          const badges = mergeImageMetaBadges(getImageMetaBadges(img), fetchedMeta[key]);
          return (
            <div key={key || idx} className={`group relative bg-white border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all ${isSelected ? 'border-indigo-600 ring-2 ring-indigo-600/20' : 'border-zinc-200'}`}>
              <div className="aspect-square bg-zinc-100 relative">
                <img
                  src={img.url}
                  alt={`Extracted ${idx}`}
                  className="w-full h-full object-contain p-2"
                  loading="lazy"
                  onLoad={(event) => {
                    const target = event.currentTarget;
                    if (!key || target.naturalWidth <= 0 || target.naturalHeight <= 0) return;
                    setFetchedMeta((current) => ({
                      ...current,
                      [key]: {
                        ...(current[key] || {}),
                        dimensions: `${target.naturalWidth}×${target.naturalHeight}`,
                      },
                    }));
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNkNGRkZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgeD0iMyIgeT0iMyIgcng9IjIiIHJ5PSIyIi8+PGNpcmNsZSBjeD0iOSIgY3k9IjkiIHI9IjIiLz48cGF0aCBkPSJtMjEgMTUtMy4wODYtMy4wODZhMiAyIDAgMCAwLTIuODI4IDBMMCAyMSIvPjwvc3ZnPg==';
                  }}
                />
                <button
                  type="button"
                  onClick={() => setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })}
                  className={`absolute inset-0 flex items-center justify-center transition-colors ${
                    isSelected ? 'bg-indigo-950/30' : 'bg-black/0 hover:bg-black/20'
                  }`}
                  title={isSelected ? 'Unselect image' : 'Select image'}
                  aria-label={isSelected ? 'Unselect image' : 'Select image'}
                >
                  <span
                    className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full border-2 shadow-sm transition-all ${
                      isSelected
                        ? 'border-indigo-600 bg-indigo-600 text-white opacity-100'
                        : 'border-white bg-white/90 text-zinc-500 opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <Check className="h-4 w-4" />
                  </span>
                </button>
              </div>
              <div className="p-3 border-t border-zinc-100">
                <p className="text-xs font-medium text-zinc-900 truncate" title={filename}>
                  {filename}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {[badges.format, badges.dimensions, badges.size].filter(Boolean).map((label) => (
                    <span key={label} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                      {label}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => handleDownload(img, filename)}
                  disabled={downloading === key}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {downloading === key ? 'Downloading...' : 'Download'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
