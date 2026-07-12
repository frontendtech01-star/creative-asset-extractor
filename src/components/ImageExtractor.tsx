import React, { useEffect, useMemo, useState } from 'react';
import { Check, Download, Image as ImageIcon, Search, Filter } from 'lucide-react';
import { apiFetch } from '../lib/api';
import LazyCachedImageThumb from './LazyCachedImageThumb';
import {
  buildImageZipItem,
  getImageAssetKey,
  getImageDisplayName,
  getImageMetaBadges,
  imageNeedsConversionChoice,
  mergeImageMetaBadges,
  resolveImageConvertRequestUrl,
  resolveZipRasterTargetFormat,
  getImageSourceFormat,
} from '../lib/imageAsset';
import { useBackendImageCacheWarm } from '../lib/useBackendImageCacheWarm';
import { useImageThumbWarm } from '../lib/useImageThumbWarm';

const getImageSequenceFrame = (img: any) => {
  const url = String(img?.url || '').trim();
  const source = String(img?.source || '').trim();
  const explicitCountMatch = url.match(/\/(\d{1,3})\/(\d{1,3})\.(?:png|jpe?g|webp|avif|gif)(?:[?#]|$)/i);
  const prefixedFrameMatch = url.match(/[-_](\d{1,3})\.(?:png|jpe?g|webp|avif|gif)(?:[?#]|$)/i);
  const hasSequenceSource = source.includes('360-sequence');
  const commonSequenceCounts = new Set([4, 18, 24, 36, 72, 120]);
  const explicitCount = Number(explicitCountMatch?.[1] || 0);
  const hasExplicitCountPath = Boolean(
    explicitCountMatch &&
      explicitCount >= 2 &&
      (hasSequenceSource || commonSequenceCounts.has(explicitCount))
  );
  const hasPrefixedFrameName = Boolean(prefixedFrameMatch && /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(url));
  if (!hasSequenceSource && !hasExplicitCountPath && !hasPrefixedFrameName) return null;
  const frame = Number(img?.sequenceFrame || explicitCountMatch?.[2] || prefixedFrameMatch?.[1] || 0);
  if (!Number.isFinite(frame) || frame < 1) return null;
  const count = Number(img?.sequenceCount || explicitCountMatch?.[1] || frame) || frame;
  return { frame, count };
};

const padFrame = (frame: number, count = 36) => String(frame).padStart(count >= 100 ? 3 : 2, '0');

const getImageSequenceGroupKey = (img: any) => {
  const url = String(img?.url || '').trim();
  const frameInfo = getImageSequenceFrame(img);
  if (!frameInfo) return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href
      .replace(/^https?:\/\/[^/]+\/content\/dam\/toyota\/(?=jellies\/)/i, 'https://toyota-assets/')
      .replace(/^https?:\/\/[^/]+\/is\/image\/toyota\/toyota\/(?=jellies\/)/i, 'https://toyota-assets/')
      .replace(/\/\d{1,3}\.(?:png|jpe?g|webp|avif|gif)$/i, '/')
      .replace(/\/\d{1,3}\/$/i, '/')
      .replace(/[-_]\d{1,3}\.(?:png|jpe?g|webp|avif|gif)$/i, '.')
      .toLowerCase();
  } catch {
    return url
      .split('?')[0]
      .replace(/\/\d{1,3}\.(?:png|jpe?g|webp|avif|gif)$/i, '/')
      .replace(/\/\d{1,3}\/$/i, '/')
      .replace(/[-_]\d{1,3}\.(?:png|jpe?g|webp|avif|gif)$/i, '.')
      .toLowerCase();
  }
};

const getImageSequenceLabel = (img: any) => {
  const frameInfo = getImageSequenceFrame(img);
  if (!frameInfo) return '';
  const url = String(img?.url || '').trim();
  try {
    const parsed = new URL(url);
    const normalized = parsed.pathname
      .replace(/^\/content\/dam\/toyota\/(?=jellies\/)/i, '/')
      .replace(/^\/is\/image\/toyota\/toyota\/(?=jellies\/)/i, '/')
      .replace(/\/{2,}/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const jelliesIndex = parts.findIndex((part) => part.toLowerCase() === 'jellies');
    const vehicleParts = jelliesIndex >= 0 ? parts.slice(jelliesIndex + 2) : parts;
    const frameLeafIndex = vehicleParts.findIndex((part) => /^\d{1,3}\.(?:png|jpe?g|webp|avif|gif)$/i.test(part));
    const groupParts = (frameLeafIndex >= 0 ? vehicleParts.slice(0, frameLeafIndex) : vehicleParts)
      .filter((part) => !/^\d{1,3}$/.test(part));
    const labelParts = groupParts.slice(-5).map((part) => part
      .replace(/[-_ ]?\d{1,3}\.(?:png|jpe?g|webp|avif|gif)$/i, '')
      .replace(/[-_]+/g, ' ')
    );
    return `360 ${labelParts.join(' ')}`.replace(/\s+/g, ' ').trim();
  } catch {
    return '360 image sequence';
  }
};

type PreviewState = Record<string, {
  status: 'ready' | 'failed';
  src?: string;
  width?: number;
  height?: number;
}>;

const sortImagesForDisplay = (items: any[]) => [...items].sort((a, b) => {
  const aFrame = getImageSequenceFrame(a);
  const bFrame = getImageSequenceFrame(b);
  if (aFrame && bFrame) {
    const groupCompare = getImageSequenceGroupKey(a).localeCompare(getImageSequenceGroupKey(b));
    if (groupCompare !== 0) return groupCompare;
    return aFrame.frame - bFrame.frame;
  }
  if (aFrame) return -1;
  if (bFrame) return 1;
  return 0;
});

const duplicateImageGroupKey = (img: any) => {
  const frameInfo = getImageSequenceFrame(img);
  if (frameInfo) return `${getImageSequenceGroupKey(img)}::frame-${frameInfo.frame}`;
  const filename = getImageDisplayName(img, 0).toLowerCase();
  if (filename && !/^image-\d+\./i.test(filename)) return `file:${filename}`;
  try {
    const parsed = new URL(String(img?.url || ''));
    parsed.search = '';
    parsed.hash = '';
    return `path:${parsed.hostname.replace(/^www\./, '')}:${parsed.pathname.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '')}`.toLowerCase();
  } catch {
    return String(img?.url || '').toLowerCase();
  }
};

const loadedPreviewArea = (preview?: { width?: number; height?: number } | null) =>
  Math.max(0, Number(preview?.width || 0)) * Math.max(0, Number(preview?.height || 0));

const imageAreaScore = (
  img: any,
  previewState: PreviewState,
  fetchedMeta: Record<string, { format?: string; dimensions?: string; size?: string }>,
  thumbMeta: Record<string, { width?: number; height?: number; bytes?: number; format?: string }>
) => {
  const key = getImageAssetKey(img);
  const previewArea = loadedPreviewArea(previewState[key]);
  if (previewArea > 0) return previewArea;
  const thumbArea = loadedPreviewArea(thumbMeta[key]);
  if (thumbArea > 0) return thumbArea;
  const extractedArea = Math.max(0, Number(img?.width || 0)) * Math.max(0, Number(img?.height || 0));
  if (extractedArea > 0) return extractedArea;
  const dims = String(fetchedMeta[key]?.dimensions || '').match(/(\d+)[×x](\d+)/i);
  if (dims) return Math.max(0, Number(dims[1] || 0)) * Math.max(0, Number(dims[2] || 0));
  return 0;
};

const keepLargestVisibleImages = (
  items: any[],
  previewState: PreviewState,
  fetchedMeta: Record<string, { format?: string; dimensions?: string; size?: string }>,
  thumbMeta: Record<string, { width?: number; height?: number; bytes?: number; format?: string }>
) => {
  const chosen = new Map<string, any>();
  const order = new Map<string, number>();
  items.forEach((img, index) => {
    const key = duplicateImageGroupKey(img);
    const current = chosen.get(key);
    if (!order.has(key)) order.set(key, index);
    if (!current) {
      chosen.set(key, img);
      return;
    }
    const nextArea = imageAreaScore(img, previewState, fetchedMeta, thumbMeta);
    const currentArea = imageAreaScore(current, previewState, fetchedMeta, thumbMeta);
    if (nextArea > currentArea) chosen.set(key, img);
  });
  return [...chosen.entries()]
    .sort((a, b) => (order.get(a[0]) || 0) - (order.get(b[0]) || 0))
    .map(([, img]) => img);
};

const hideFailedPreviewImages = (items: any[], previewState: PreviewState) =>
  items.filter((img) => previewState[getImageAssetKey(img)]?.status !== 'failed');

const isSequenceImage = (img: any) => Boolean(getImageSequenceFrame(img));

const groupSequenceDisplayImages = (items: any[]) => {
  const groups = new Map<string, { key: string; label: string; count: number; images: any[] }>();
  items.forEach((img) => {
    const frameInfo = getImageSequenceFrame(img);
    if (!frameInfo) return;
    const key = getImageSequenceGroupKey(img) || getImageAssetKey(img);
    const group = groups.get(key) || {
      key,
      label: getImageSequenceLabel(img) || '360 image sequence',
      count: frameInfo.count,
      images: [],
    };
    group.count = Math.max(group.count, frameInfo.count, frameInfo.frame);
    group.images.push(img);
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    images: [...group.images].sort((a, b) => (getImageSequenceFrame(a)?.frame || 0) - (getImageSequenceFrame(b)?.frame || 0)),
  }));
};

export default function ImageExtractor({
  images,
  sourcePageUrl = '',
  onValidCountChange,
  onDownloadReady,
}: {
  images: any[];
  sourcePageUrl?: string;
  saveKind?: 'image' | 'icon';
  title?: string;
  onValidCountChange?: (count: number) => void;
  onDownloadReady?: (notice: { title: string; detail?: string; target: string; sourcePageUrl?: string; folderPath?: string }) => void;
}) {
  React.useEffect(() => {
    onValidCountChange?.(images.length);
  }, [images.length, onValidCountChange]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloadResult, setDownloadResult] = useState<{ ok: boolean; message: string; url?: string } | null>(null);
  const [zipResult, setZipResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [fetchedMeta, setFetchedMeta] = useState<Record<string, { format?: string; dimensions?: string; size?: string }>>({});
  const [previewState, setPreviewState] = useState<PreviewState>({});
  const [copiedSequenceLabel, setCopiedSequenceLabel] = useState('');

  const orderedImages = useMemo(() => sortImagesForDisplay(images), [images]);
  const { displayImages: warmedImages } = useBackendImageCacheWarm(orderedImages, sourcePageUrl);
  const thumbMetaByKey = useImageThumbWarm(warmedImages, sourcePageUrl);

  const saveDataImage = async (dataUrl: string, filename: string) => {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('Invalid cached image payload.');
    const header = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const extMatch = header.match(/^data:image\/([a-z0-9.+-]+)/i);
    const ext = (extMatch?.[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const saveFilename = filename.replace(/\.[^.]+$/, '') + `.${ext}`;
    const base64 = header.includes(';base64') ? payload : btoa(decodeURIComponent(payload));
    const response = await apiFetch('/api/save-asset-buffer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, filename: saveFilename, kind: 'image', sourcePageUrl: sourcePageUrl || undefined }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error || 'Image save failed');
    return result;
  };

  useEffect(() => {
    setPreviewState({});
    setSelected(new Set());
    setZipResult(null);
    setDownloadResult(null);
  }, [images, sourcePageUrl]);

  const handleDownload = async (img: any, filename: string) => {
    const key = getImageAssetKey(img);
    setDownloading(key);
    setDownloadResult(null);
    try {
      const cachedDataUrl = String(img?.cachedUrl || '').trim();
      if (key.startsWith('data:') || cachedDataUrl.startsWith('data:image/')) {
        const saved = await saveDataImage(key.startsWith('data:') ? key : cachedDataUrl, filename);
        const savedName = saved?.filename || filename;
        setDownloadResult({ ok: true, message: `${savedName} saved to Downloads.`, url: key });
        onDownloadReady?.({
          title: 'Image saved',
          detail: `${savedName} is ready in Downloads.`,
          target: 'images',
          sourcePageUrl: sourcePageUrl || undefined,
          folderPath: saved?.folderPath,
        });
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
      setDownloadResult({ ok: true, message: `${filename} saved to Downloads.`, url: key });
      onDownloadReady?.({
        title: 'Image saved',
        detail: `${filename} is ready in Downloads.`,
        target: 'images',
        sourcePageUrl: sourcePageUrl || undefined,
        folderPath: result?.folderPath,
      });
    } catch (error: any) {
      console.error('Download error:', error);
      const rawMessage = String(error?.message || 'Failed to download image.');
      const blockedMessage = /failed to fetch a valid image|not a valid image|403|forbidden|cloudflare|blocked/i.test(rawMessage)
        ? 'This site blocked the direct image download. Open the source URL in the authenticated browser tab, or use Download Selected after the image has been cached.'
        : rawMessage;
      setDownloadResult({ ok: false, message: blockedMessage, url: key });
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadAll = async () => {
    const selectedImages = displayImages.filter((img) => selected.has(getImageAssetKey(img)));
    if (selectedImages.length === 0) return;
    setDownloadingZip(true);
    setZipResult(null);
    try {
      const items = selectedImages.map((img, index) => {
        const frameInfo = getImageSequenceFrame(img);
        const ext = getImageSourceFormat(img) || 'png';
        const item = buildImageZipItem(
          img,
          index,
          imageNeedsConversionChoice(img) ? resolveZipRasterTargetFormat(img, {}) : undefined
        );
        if (!frameInfo) return item;
        const frameName = `frame_${String(frameInfo.frame).padStart(3, '0')}`;
        return {
          ...item,
          preserveOriginal: true,
          filenameBase: frameName,
          filename: `${frameName}.${ext}`,
          metadataFilename: `${frameName}.${ext}`,
          zipEntryName: `Images/360_Sequence/${frameName}.${ext}`,
        };
      });
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
      onDownloadReady?.({
        title: 'Images saved',
        detail: `${addedCount} selected image${addedCount === 1 ? '' : 's'} saved as ${result.filename || 'selected-images.zip'}.`,
        target: 'images',
        sourcePageUrl: sourcePageUrl || undefined,
        folderPath: result?.folderPath,
      });
      setSelected(new Set());
    } catch (error: any) {
      console.error('Download all error:', error);
      setZipResult({ ok: false, message: error?.message || 'Failed to download selected images as ZIP.' });
    } finally {
      setDownloadingZip(false);
    }
  };

  const filteredImages = useMemo(() => warmedImages.filter(img => {
    const query = searchTerm.toLowerCase().trim();
    const haystack = [
      img.url,
      img.filename,
      img.name,
      img.alt,
      img.type,
      getImageSequenceLabel(img),
      getImageSequenceFrame(img) ? '360 image sequence' : '',
    ].map((value) => String(value || '').toLowerCase()).join(' ');
    const matchesSearch = !query || haystack.includes(query);
    const matchesFilter = filterType === 'all' || String(img?.type || '').toLowerCase() === filterType.toLowerCase();
    return matchesSearch && matchesFilter;
  }), [filterType, warmedImages, searchTerm]);

  const previewableImages = hideFailedPreviewImages(filteredImages, previewState);
  const visibleImages = previewableImages.filter((img) => previewState[getImageAssetKey(img)]?.status === 'ready');
  const displayImages = keepLargestVisibleImages(previewableImages, previewState, fetchedMeta, thumbMetaByKey);
  const sequenceDisplayImages = displayImages.filter(isSequenceImage);
  const sequenceDisplayGroups = groupSequenceDisplayImages(sequenceDisplayImages);
  const sequenceKeys = new Set(sequenceDisplayImages.map(getImageAssetKey));
  const regularDisplayImages = displayImages.filter((img) => !sequenceKeys.has(getImageAssetKey(img)));

  const uniqueTypes = Array.from(new Set(images.map(img => img.type.toLowerCase()))).filter(Boolean);
  const selectedCount = displayImages.filter((img) => selected.has(getImageAssetKey(img))).length;
  const handleToggleImageSelection = (img: any) => {
    const key = getImageAssetKey(img);
    const frameInfo = getImageSequenceFrame(img);
    const sequenceGroupKey = frameInfo ? getImageSequenceGroupKey(img) : '';
    const groupKeys = (() => {
      if (!sequenceGroupKey || !frameInfo) return [];
      const keysByFrame = new Map<number, string>();
      displayImages
        .filter((candidate) => getImageSequenceFrame(candidate) && getImageSequenceGroupKey(candidate) === sequenceGroupKey)
        .forEach((candidate) => {
          const candidateFrame = getImageSequenceFrame(candidate);
          const candidateKey = getImageAssetKey(candidate);
          if (!candidateFrame || !candidateKey) return;
          if (!keysByFrame.has(candidateFrame.frame)) keysByFrame.set(candidateFrame.frame, candidateKey);
        });
      return [...keysByFrame.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, groupKey]) => groupKey)
        .filter(Boolean) as string[];
    })();

    setSelected((current) => {
      const next = new Set(current);
      if (groupKeys.length > 1) {
        const shouldUnselectGroup = groupKeys.every((groupKey) => next.has(groupKey));
        groupKeys.forEach((groupKey) => {
          if (shouldUnselectGroup) next.delete(groupKey);
          else next.add(groupKey);
        });
        return next;
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderImageGrid = (items: any[]) => (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {items.map((img, idx) => {
        const key = getImageAssetKey(img);
        const filename = getImageDisplayName(img, idx);
        const isSelected = selected.has(key);
        const badges = mergeImageMetaBadges(getImageMetaBadges(img), fetchedMeta[key]);
        const frameInfo = getImageSequenceFrame(img);
        const sequenceLabel = getImageSequenceLabel(img);
        return (
          <div key={key || idx} className={`group relative bg-white border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all ${isSelected ? 'border-indigo-600 ring-2 ring-indigo-600/20' : 'border-zinc-200'}`}>
            <div className="aspect-square bg-zinc-100 relative">
              <LazyCachedImageThumb
                img={img}
                sourcePageUrl={sourcePageUrl}
                alt={`Extracted ${idx}`}
                fallbackLabel={filename}
                className="object-contain p-2"
                onDimensions={(width, height) => {
                  setFetchedMeta((current) => ({
                    ...current,
                    [key]: {
                      ...(current[key] || {}),
                      dimensions: `${width}×${height}`,
                    },
                  }));
                  setPreviewState((current) => ({
                    ...current,
                    [key]: {
                      ...(current[key] || {}),
                      status: 'ready',
                      width,
                      height,
                    },
                  }));
                }}
                onReady={() => {
                  if (previewState[key]?.status === 'ready') return;
                  setPreviewState((current) => ({
                    ...current,
                    [key]: {
                      ...(current[key] || {}),
                      status: 'ready',
                    },
                  }));
                }}
                onFailed={() => {
                  if (previewState[key]?.status === 'ready') return;
                  setPreviewState((current) => ({
                    ...current,
                    [key]: { status: 'failed' },
                  }));
                }}
              />
              <button
                type="button"
                onClick={() => handleToggleImageSelection(img)}
                className={`absolute inset-0 flex items-center justify-center transition-colors ${
                  isSelected ? 'bg-indigo-950/30' : 'bg-black/0 hover:bg-black/20'
                }`}
                title={frameInfo ? (isSelected ? 'Unselect 360 sequence' : 'Select 360 sequence') : (isSelected ? 'Unselect image' : 'Select image')}
                aria-label={frameInfo ? (isSelected ? 'Unselect 360 sequence' : 'Select 360 sequence') : (isSelected ? 'Unselect image' : 'Select image')}
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
              {frameInfo ? (
                <div className="mb-2 flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      const label = sequenceLabel || '360 image sequence';
                      void navigator.clipboard?.writeText(label).catch(() => undefined);
                      setCopiedSequenceLabel(label);
                      window.setTimeout(() => {
                        setCopiedSequenceLabel((current) => current === label ? '' : current);
                      }, 1400);
                    }}
                    className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 transition-colors hover:bg-indigo-100"
                    title={`Copy search label: ${sequenceLabel || '360 image sequence'}`}
                  >
                    {copiedSequenceLabel === sequenceLabel ? 'Copied 360 Label' : '360 Image Sequence'}
                  </button>
                  {sequenceLabel ? (
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700">
                      {sequenceLabel}
                    </span>
                  ) : null}
                  <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                    Frame {padFrame(frameInfo.frame, frameInfo.count)}
                  </span>
                </div>
              ) : null}
              <p className="text-xs font-medium text-zinc-900 truncate" title={filename}>
                {frameInfo ? `Frame ${padFrame(frameInfo.frame, frameInfo.count)}` : filename}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {[
                  thumbMetaByKey[key]?.format ? String(thumbMetaByKey[key]?.format).toUpperCase() : badges.format,
                  thumbMetaByKey[key]?.width && thumbMetaByKey[key]?.height
                    ? `${thumbMetaByKey[key]?.width}×${thumbMetaByKey[key]?.height}`
                    : badges.dimensions,
                  badges.size,
                ].filter(Boolean).map((label) => (
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
  );

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
          <p>{zipResult.message}</p>
        </div>
      ) : null}

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
          {!downloadResult.ok && downloadResult.url ? (
            <p className="mt-1 truncate text-xs font-normal opacity-80" title={downloadResult.url}>
              {downloadResult.url}
            </p>
          ) : null}
        </div>
      ) : null}

      {filteredImages.length > 0 && visibleImages.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-3 text-center text-zinc-500">
          <ImageIcon className="mb-3 h-10 w-10 text-zinc-300" />
          <p className="text-sm font-semibold text-zinc-900">Loading image previews in background…</p>
          <p className="mt-1 text-xs text-zinc-500">
            Cards are available now; thumbnails and dimensions will fill in as each preview responds.
          </p>
        </div>
      ) : null}

      {filteredImages.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-white py-16 text-center text-zinc-500">
          <ImageIcon className="mb-3 h-10 w-10 text-zinc-300" />
          <p className="text-sm font-semibold text-zinc-900">No images match your filters</p>
          <p className="mt-1 max-w-lg text-xs text-zinc-500">
            Clear the search or type filter to show extracted images.
          </p>
        </div>
      ) : null}

      {sequenceDisplayImages.length > 0 ? (
        <section className="space-y-4 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4">
          <div>
            <h3 className="text-sm font-bold text-zinc-900">360 Image Sequences</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Grouped by detected color/category when available. Copy a 360 label and paste it in search to isolate that sequence.
            </p>
          </div>
          <div className="space-y-6">
            {sequenceDisplayGroups.map((group) => (
              <div key={group.key} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(group.label).catch(() => undefined);
                      setCopiedSequenceLabel(group.label);
                      window.setTimeout(() => {
                        setCopiedSequenceLabel((current) => current === group.label ? '' : current);
                      }, 1400);
                    }}
                    className="rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white transition-colors hover:bg-indigo-700"
                    title={`Copy search label: ${group.label}`}
                  >
                    {copiedSequenceLabel === group.label ? 'Copied Label' : group.label}
                  </button>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-indigo-700">
                    {group.images.length}/{group.count || group.images.length} frames loaded
                  </span>
                </div>
                {renderImageGrid(group.images)}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {regularDisplayImages.length > 0 ? (
        <section className="space-y-4">
          {sequenceDisplayImages.length > 0 ? (
            <h3 className="text-sm font-bold text-zinc-900">Other Images</h3>
          ) : null}
          {renderImageGrid(regularDisplayImages)}
        </section>
      ) : null}
    </div>
  );
}
