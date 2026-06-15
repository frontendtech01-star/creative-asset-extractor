import { useEffect, useMemo, useState } from 'react';
import { getImageAssetKey } from './imageAsset';
import { loadPreviewImageThumb, type ValidatedThumb } from './thumbnailLoader';

export type VisibleImageCard = {
  img: { url?: string; cachedUrl?: string; type?: string; mimeType?: string; [key: string]: unknown };
  discoveryIndex: number;
  serialNumber: number;
  preview: ValidatedThumb;
};

const CONCURRENCY = 5;
const PREVIEW_TIMEOUT_MS = 20000;

const loadPreviewWithTimeout = (
  img: { url?: string; cachedUrl?: string; [key: string]: unknown },
  sourcePageUrl: string
) =>
  Promise.race([
    loadPreviewImageThumb(img, sourcePageUrl),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('Preview timed out')), PREVIEW_TIMEOUT_MS);
    }),
  ]);

const sortWithSerials = (entries: VisibleImageCard[]) =>
  [...entries]
    .sort((a, b) => a.discoveryIndex - b.discoveryIndex)
    .map((entry, index) => ({ ...entry, serialNumber: index + 1 }));

export const useVisibleImageGallery = (
  discoveredImages: Array<{ url?: string; cachedUrl?: string; [key: string]: unknown }>,
  sourcePageUrl = ''
) => {
  const [visibleImages, setVisibleImages] = useState<VisibleImageCard[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);

  const discoveredKey = useMemo(
    () => discoveredImages.map((img) => `${getImageAssetKey(img)}|${String(img?.cachedUrl || '')}`).join('|'),
    [discoveredImages]
  );

  useEffect(() => {
    let cancelled = false;
    setVisibleImages([]);
    setFailedCount(0);
    setProcessedCount(0);
    setIsComplete(false);

    if (!discoveredImages.length) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    let nextIndex = 0;

    const worker = async () => {
      while (!cancelled) {
        const discoveryIndex = nextIndex;
        nextIndex += 1;
        if (discoveryIndex >= discoveredImages.length) return;

        const img = discoveredImages[discoveryIndex];
        try {
          const preview = await loadPreviewWithTimeout(img, sourcePageUrl);
          if (cancelled) return;
          setVisibleImages((prev) =>
            sortWithSerials([...prev, { img, discoveryIndex, serialNumber: 0, preview }])
          );
        } catch {
          if (!cancelled) setFailedCount((count) => count + 1);
        }

        if (!cancelled) setProcessedCount(discoveryIndex + 1);
      }
    };

    const workerCount = Math.min(CONCURRENCY, discoveredImages.length);
    void Promise.all(Array.from({ length: workerCount }, () => worker())).finally(() => {
      if (!cancelled) {
        setIsLoading(false);
        setIsComplete(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [discoveredKey, sourcePageUrl, discoveredImages.length]);

  return {
    visibleImages,
    failedCount,
    isLoading,
    isComplete,
    processedCount,
    totalDiscovered: discoveredImages.length,
  };
};
