import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import { getImageAssetKey } from './imageAsset';

/** Prime server-side thumbnail cache in the background (non-blocking). */
export const useImageThumbWarm = (
  images: Array<{ url?: string; cachedUrl?: string; [key: string]: unknown }>,
  sourcePageUrl = ''
) => {
  const [metaByKey, setMetaByKey] = useState<Record<string, {
    thumbUrl?: string;
    lqip?: string;
    width?: number;
    height?: number;
    bytes?: number;
    format?: string;
  }>>({});
  const imagesKey = useMemo(
    () => images.map((img) => getImageAssetKey(img)).join('|'),
    [images]
  );

  useEffect(() => {
    if (!images.length) return;

    let cancelled = false;
    const items = images.slice(0, 500).map((img) => ({
      originalUrl: getImageAssetKey(img),
      url: getImageAssetKey(img),
    }));
    void (async () => {
      const batches: typeof items[] = [];
      for (let offset = 0; offset < items.length; offset += 60) {
        batches.push(items.slice(offset, offset + 60));
      }
      await Promise.all(batches.map(async (batch) => {
        if (cancelled) return;
        try {
          const response = await apiFetch('/api/warm-image-thumbs-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourcePageUrl: sourcePageUrl || undefined,
              items: batch,
            }),
          });
          const data = await response.json();
          if (cancelled) return;
          setMetaByKey((prev) => ({ ...prev, ...(data?.results || {}) }));
        } catch {
          // Continue warming later batches when one remote asset fails.
        }
      }));
    })();

    return () => {
      cancelled = true;
      void cancelled;
    };
  }, [imagesKey, sourcePageUrl, images.length]);

  return metaByKey;
};
