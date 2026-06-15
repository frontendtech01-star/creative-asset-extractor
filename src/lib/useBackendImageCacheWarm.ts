import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import { getImageAssetKey } from './imageAsset';

export const useBackendImageCacheWarm = (
  images: Array<{ url?: string; cachedUrl?: string; [key: string]: unknown }>,
  sourcePageUrl = ''
) => {
  const [cacheByKey, setCacheByKey] = useState<Record<string, string>>({});
  const [isWarming, setIsWarming] = useState(false);
  const [warmProgress, setWarmProgress] = useState({ warmed: 0, total: 0 });

  const imagesKey = useMemo(
    () => images.map((img) => getImageAssetKey(img)).join('|'),
    [images]
  );

  useEffect(() => {
    setCacheByKey({});
    if (!images.length) {
      setIsWarming(false);
      setWarmProgress({ warmed: 0, total: 0 });
      return;
    }

    let cancelled = false;
    setIsWarming(true);
    setWarmProgress({ warmed: 0, total: images.length });

    void apiFetch('/api/warm-image-cache-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePageUrl: sourcePageUrl || undefined,
        items: images.map((img) => {
          const originalUrl = getImageAssetKey(img);
          const cached = String(img?.cachedUrl || '').trim();
          return {
            url: cached.startsWith('/cached-images-original/') ? cached : originalUrl,
            originalUrl,
          };
        }),
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const results = (data?.results || {}) as Record<string, { ok?: boolean; cachedUrl?: string }>;
        const next: Record<string, string> = {};
        for (const img of images) {
          const key = getImageAssetKey(img);
          if (!key) continue;
          const existing = String(img?.cachedUrl || '').trim();
          if (existing.startsWith('/cached-images-original/')) {
            next[key] = existing;
            continue;
          }
          const warmed = results[key]?.cachedUrl;
          if (results[key]?.ok && warmed) next[key] = warmed;
        }
        setCacheByKey(next);
        setWarmProgress({
          warmed: Number(data?.warmed || Object.values(next).length),
          total: Number(data?.total || images.length),
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsWarming(false);
      });

    return () => {
      cancelled = true;
    };
  }, [imagesKey, sourcePageUrl, images.length]);

  const displayImages = useMemo(
    () =>
      images.map((img) => {
        const key = getImageAssetKey(img);
        const patched = key ? cacheByKey[key] : '';
        const existing = String(img?.cachedUrl || '').trim();
        const cachedUrl = patched || existing;
        return cachedUrl ? { ...img, cachedUrl } : img;
      }),
    [images, cacheByKey]
  );

  return { displayImages, cacheByKey, isWarming, warmProgress };
};
