import React, { useEffect, useMemo, useState } from 'react';
import { Check, Download, Image as ImageIcon, Search, Filter } from 'lucide-react';
import { apiFetch, apiFetchWithTimeout, apiUrl } from '../lib/api';
import {
  buildImagePreviewRequest,
  buildImageZipItem,
  getAvailableImageDownloadFormats,
  getImageAssetKey,
  formatImageMetaLine,
  getImageMetaBadges,
  mergeImageMetaBadges,
  type ImageMetaBadges,
  getImageDisplayName,
  getImageDownloadFormat,
  getOriginalImageDownloadFilename,
  imageDownloadsDirectly,
  imageFilenameBase,
  imageNeedsConversionChoice,
  resolveImageConvertRequestUrl,
  resolveImagePreviewUrl,
  resolveImageTargetFormat,
  resolveZipRasterTargetFormat,
  type ImageDownloadFormat,
} from '../lib/imageAsset';
import { appendSourcePageUrl } from '../lib/creativeAssetsFolder';
import { creativeAssetsFolderLabel } from '../lib/creativeAssetsFolder';
import { getImageDownloadFilename } from '../lib/filename';
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

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const [, base64 = ''] = value.split(',');
      base64 ? resolve(base64) : reject(new Error('Could not encode inline image for saving.'));
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read inline image.'));
    reader.readAsDataURL(blob);
  });

export default function ImageExtractor({ images, sourcePageUrl = '' }: { images: any[]; sourcePageUrl?: string }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [completion, setCompletion] = useState<{ title: string; detail?: string; size?: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedFormats, setSelectedFormats] = useState<Record<string, ImageDownloadFormat>>({});
  const [fetchedMeta, setFetchedMeta] = useState<Record<string, Partial<ImageMetaBadges>>>({});

  useEffect(() => {
    const pending = images.filter((img) => {
      const badges = getImageMetaBadges(img);
      return (
        getImageAssetKey(img) &&
        !String(img?.url || '').startsWith('data:') &&
        (!badges.dimensions || !badges.size)
      );
    });
    if (!pending.length) return;

    let cancelled = false;
    void (async () => {
      await Promise.all(
        pending.slice(0, 48).map(async (img) => {
          const key = getImageAssetKey(img);
          if (!key || cancelled) return;
          try {
            const params = new URLSearchParams({ url: key, originalUrl: key });
            appendSourcePageUrl(params, sourcePageUrl);
            const response = await apiFetch(`/api/image-meta?${params.toString()}`);
            const meta = await response.json();
            const patch: Partial<ImageMetaBadges> = {};
            const width = Number(meta?.width || 0);
            const height = Number(meta?.height || 0);
            if (width > 0 && height > 0) patch.dimensions = `${width}×${height}`;
            const sizeLabel = getImageMetaBadges({ bytes: Number(meta?.bytes || 0) }).size;
            if (sizeLabel) patch.size = sizeLabel;
            if (!patch.dimensions && !patch.size) return;
            if (cancelled) return;
            setFetchedMeta((prev) => (prev[key] ? prev : { ...prev, [key]: patch }));
          } catch {
            // Best-effort metadata for cards.
          }
        })
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [images]);

  const handleFormatChange = (assetKey: string, format: ImageDownloadFormat) => {
    setSelectedFormats((prev) => ({ ...prev, [assetKey]: format }));
  };

  useEffect(() => {
    setSelectedFormats((prev) => {
      const next = { ...prev };
      for (const img of images) {
        const key = getImageAssetKey(img);
        if (!key || next[key] || !imageNeedsConversionChoice(img)) continue;
        next[key] = 'png';
      }
      return next;
    });
  }, [images]);

  useEffect(() => {
    const targets = images.filter(
      (img) => imageNeedsConversionChoice(img) && String(img?.cachedUrl || '').trim()
    );
    if (!targets.length) return;
    void apiFetch('/api/warm-image-conversions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: targets.map((img) => ({
          url: resolveImageConvertRequestUrl(img),
          originalUrl: getImageAssetKey(img),
          cachedUrl: String(img?.cachedUrl || '').trim() || undefined,
        })),
      }),
    }).catch(() => undefined);
  }, [images]);

  const downloadsFolderLabel = creativeAssetsFolderLabel(sourcePageUrl, 'Images');

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

  const handleDownload = async (img: any, index = 0) => {
    const assetKey = getImageAssetKey(img);
    const url = resolveImageConvertRequestUrl(img);
    if (!url || !assetKey) {
      alert('Image URL is missing for this item.');
      return;
    }
    setDownloading(assetKey);
    setCompletion(null);
    try {
      const originalUrl = assetKey;
      const filenameBase = imageFilenameBase(img, index);
      const metadataFilename = String(img?.filename || img?.name || '').trim();
      const directFilename = getOriginalImageDownloadFilename(img, index);
      const debugMeta = {
        url: originalUrl,
        mimeType: String(img?.mimeType || img?.type || '').trim(),
        cachePath: String(img?.cachedUrl || '').trim(),
      };
      console.debug('[image-download:selected]', debugMeta);

      if (url.startsWith('data:')) {
        const response = await fetch(url);
        const blob = await response.blob();
        const base64 = await blobToBase64(blob);
        const savedResponse = await apiFetch('/api/save-asset-buffer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64, filename: directFilename, contentType: blob.type, sourcePageUrl: sourcePageUrl || undefined }),
        });
        const saved = await readSavedDownloadPayload(savedResponse);
        setCompletion({ title: 'Image saved', detail: `Saved to ${downloadsFolderLabel} as ${saved.filename || directFilename}.`, size: saved.size || blob.size });
        return;
      }

      if (imageDownloadsDirectly(img)) {
        const downloadParams = new URLSearchParams({
          url: resolveImageConvertRequestUrl(img),
          originalUrl,
          filenameBase,
          save: '1',
        });
        appendSourcePageUrl(downloadParams, sourcePageUrl);
        if (metadataFilename) downloadParams.set('metadataFilename', metadataFilename);
        const response = await apiFetch(`/api/download-image?${downloadParams.toString()}`);
        const saved = await readSavedDownloadPayload(response);
        setCompletion({ title: 'Image saved', detail: `Saved to ${downloadsFolderLabel} as ${saved.filename || directFilename}.`, size: saved.size });
        return;
      }

      const choice = getImageDownloadFormat(img, selectedFormats);
      const targetFormat = resolveImageTargetFormat(img, choice);
      const params = new URLSearchParams({ url, originalUrl, filenameBase, save: '1' });
      appendSourcePageUrl(params, sourcePageUrl);
      if (metadataFilename) params.set('metadataFilename', metadataFilename);

      if (choice === 'png' || choice === 'jpg') {
        params.set('toFormat', targetFormat);
        params.set('selectedFormat', targetFormat);
      } else {
        params.set('toFormat', targetFormat);
      }

      const response = await apiFetch(`/api/convert-image?${params.toString()}`);
      const saved = await readSavedDownloadPayload(response);
      const fallbackName = getImageDownloadFilename(originalUrl, targetFormat, filenameBase, metadataFilename);
      setCompletion({ title: 'Image saved', detail: `Saved to ${downloadsFolderLabel} as ${saved.filename || fallbackName}.`, size: saved.size });
    } catch (error: any) {
      console.error('Download error:', error);
      alert(error?.message || 'Download failed');
    } finally {
      setTimeout(() => {
        setDownloading((prev) => (prev === assetKey ? null : prev));
      }, 700);
    }
  };

  const filteredImages = useMemo(() => images.filter(img => {
    const matchesSearch = String(img.url || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterType === 'all' || String(img.type || '').toLowerCase() === filterType.toLowerCase();
    return matchesSearch && matchesFilter;
  }), [images, searchTerm, filterType]);

  useEffect(() => {
    setSelected(new Set());
  }, [images]);

  const selectedImages = filteredImages.filter((img) => selected.has(getImageAssetKey(img)));

  const handleDownloadAll = async () => {
    if (selectedImages.length === 0) return;
    setDownloadingZip(true);
    setCompletion(null);
    try {
      const items = selectedImages.map((img, idx) => {
        const zipFormat = resolveZipRasterTargetFormat(img, selectedFormats);
        const item = buildImageZipItem(img, idx, imageNeedsConversionChoice(img) ? zipFormat : undefined);
        console.debug('[image-zip:selected]', {
          id: item.id,
          url: item.originalUrl || item.url,
          mimeType: item.mimeType,
          cachePath: item.cachedPath || '',
        });
        return item;
      });
      const response = await apiFetchWithTimeout('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, save: true, filename: 'images.zip', sourcePageUrl: sourcePageUrl || undefined }),
      });
      const saved = await readSavedDownloadPayload(response);
      const packedCount = Number(
        saved.addedCount ?? response.headers.get('X-Zip-Added-Count') ?? 0
      );
      const failedCount = Number(saved.failedCount ?? response.headers.get('X-Zip-Failed-Count') ?? 0);
      if (packedCount <= 0) {
        throw new Error(
          failedCount > 0
            ? `ZIP contained no images (${failedCount} failed). Wait a few seconds after extract, then try again.`
            : 'ZIP was empty. Try downloading images individually.'
        );
      }
      setCompletion({
        title: 'Images ZIP ready',
        detail: `${packedCount} image${packedCount === 1 ? '' : 's'} saved to ${downloadsFolderLabel} as ${saved.filename || 'images.zip'}.`,
        size: saved.size,
      });
    } catch (error: any) {
      console.error('Download all error:', error);
      alert(error?.message || 'Failed to download images as ZIP.');
    } finally {
      setDownloadingZip(false);
    }
  };

  const uniqueTypes = Array.from(
    new Set(images.map((img) => String(img?.type || '').toLowerCase()).filter(Boolean))
  ).filter(Boolean);

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
              placeholder="Search images..."
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
            onClick={() => setSelected(new Set(filteredImages.map((img) => getImageAssetKey(img)).filter(Boolean)))}
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
            disabled={downloadingZip || selectedImages.length === 0}
            className="w-full sm:w-auto flex items-center justify-center gap-2 bg-blue-600 text-white px-6 py-2.5 rounded-xl font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {downloadingZip ? (
              <span>Creating ZIP</span>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Download Selected ({selectedImages.length})
              </>
            )}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {filteredImages.map((img, idx) => {
          const assetKey = getImageAssetKey(img);
          const filename = getImageDisplayName(img, idx);
          const metaBadges = mergeImageMetaBadges(getImageMetaBadges(img), fetchedMeta[assetKey]);
          const isSelected = selected.has(assetKey);
          const showFormatChoice = imageNeedsConversionChoice(img);
          const outputFormat = getImageDownloadFormat(img, selectedFormats);
          const outputOptions = getAvailableImageDownloadFormats(img);
          const sourceLabel = String(img?.type || 'webp').toUpperCase();
          const formatLabel = (fmt: ImageDownloadFormat) => {
            if (fmt === 'original') return `ORIGINAL (${sourceLabel})`;
            return `CONVERT TO ${fmt.toUpperCase()}`;
          };
          return (
            <div
              key={assetKey || `image-${idx}`}
              className={`media-card-enter group relative bg-white border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all ${
                isSelected ? 'border-blue-600 ring-2 ring-blue-600/20' : 'border-zinc-200'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  if (!assetKey) return;
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(assetKey)) next.delete(assetKey);
                    else next.add(assetKey);
                    return next;
                  });
                }}
                className="thumb-shimmer aspect-square bg-zinc-100 relative block w-full text-left"
                title={isSelected ? 'Unselect' : 'Select'}
              >
                <img
                  src={resolveImagePreviewUrl(img)}
                  alt={`Extracted ${idx}`}
                  className="relative w-full h-full object-contain p-2"
                  loading="eager"
                  decoding="async"
                  onLoad={(e) => {
                    if (!assetKey || metaBadges.dimensions) return;
                    const el = e.target as HTMLImageElement;
                    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                      setFetchedMeta((prev) => {
                        if (prev[assetKey]?.dimensions) return prev;
                        return {
                          ...prev,
                          [assetKey]: {
                            ...prev[assetKey],
                            dimensions: `${el.naturalWidth}×${el.naturalHeight}`,
                          },
                        };
                      });
                    }
                  }}
                  onError={(e) => {
                    const el = e.target as HTMLImageElement;
                    const previewFallback = buildImagePreviewRequest(img, sourcePageUrl);
                    if (previewFallback && !el.dataset.previewFallback) {
                      el.dataset.previewFallback = '1';
                      el.src = apiUrl(previewFallback);
                      return;
                    }
                    el.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNkNGRkZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgeD0iMyIgeT0iMyIgcng9IjIiIHJ5PSIyIi8+PGNpcmNsZSBjeD0iOSIgY3k9IjkiIHI9IjIiLz48cGF0aCBkPSJtMjEgMTUtMy4wODYtMy4wODZhMiAyIDAgMCAwLTIuODI4IDBMMCAyMSIvPjwvc3ZnPg==';
                  }}
                />
                {isSelected ? (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <div className="flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-md">
                      <Check className="w-5 h-5 text-blue-600 stroke-[2.5]" aria-hidden />
                    </div>
                  </div>
                ) : null}
              </button>
              <div className="p-3 border-t border-zinc-100 space-y-2">
                <div>
                  <p className="text-xs font-medium text-zinc-900 truncate" title={filename}>
                    {filename}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(
                      [
                        { key: 'format', label: metaBadges.format },
                        { key: 'dimensions', label: metaBadges.dimensions },
                        { key: 'size', label: metaBadges.size },
                      ] as const
                    )
                      .filter((item) => item.label)
                      .map((item) => (
                        <span
                          key={item.key}
                          className="inline-flex items-center rounded-md bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm"
                        >
                          {item.label}
                        </span>
                      ))}
                  </div>
                </div>
                {showFormatChoice ? (
                  <select
                    className="w-full bg-zinc-50 border border-zinc-200 text-zinc-700 text-xs rounded-xl px-2 py-2 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    value={outputFormat}
                    onChange={(e) => handleFormatChange(assetKey, e.target.value as ImageDownloadFormat)}
                  >
                    {outputOptions.map((fmt) => (
                      <option key={fmt} value={fmt}>{formatLabel(fmt)}</option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  onClick={() => handleDownload(img, idx)}
                  disabled={downloading === assetKey}
                  className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  {downloading === assetKey ? 'Starting...' : 'Download'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
