import { useEffect, useMemo, useState } from 'react';
import { getImageAssetKey } from './imageAsset';
import { loadCachedImageThumb, type ValidatedThumb } from './thumbnailLoader';

export type ReadyImageCard = {
  img: { url?: string; cachedUrl?: string; type?: string; mimeType?: string; [key: string]: unknown };
  discoveryIndex: number;
  serialNumber: number;
  preview: ValidatedThumb;
};

const PREFETCH_CONCURRENCY = 8;
const PREVIEW_TIMEOUT_MS = 20000;

const loadPreviewWithTimeout = (
  img: { url?: string; cachedUrl?: string; [key: string]: unknown },
  sourcePageUrl: string
) =>
  Promise.race([
    loadCachedImageThumb(img, sourcePageUrl),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('Preview timed out')), PREVIEW_TIMEOUT_MS);
    }),
  ]);

export const useReadyImageCards = (
  images: Array<{ url?: string; cachedUrl?: string; [key: string]: unknown }>,
  sourcePageUrl = ''
) => {
  const [readyCards, setReadyCards] = useState<ReadyImageCard[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [prefetchDone, setPrefetchDone] = useState(0);

  const imagesKey = useMemo(
    () => images.map((img) => `${getImageAssetKey(img)}|${String(img?.cachedUrl || '')}`).join('|'),
    [images]
  );

  useEffect(() => {
    let cancelled = false;
    setReadyCards([]);
    setSkippedCount(0);
    setPrefetchDone(0);
    setIsComplete(false);
    setIsLoading(images.length > 0);

    if (!images.length) return;

    const slots: Array<'pending' | 'ready' | 'failed'> = images.map(() => 'pending');
    const previews: Array<ValidatedThumb | null> = images.map(() => null);
    let finishedCount = 0;

    const commitReveal = () => {
      const cards: ReadyImageCard[] = [];
      let serial = 0;
      for (let cursor = 0; cursor < images.length; cursor += 1) {
        if (slots[cursor] === 'pending') break;
        if (slots[cursor] === 'failed') continue;
        serial += 1;
        cards.push({
          img: images[cursor],
          discoveryIndex: cursor,
          serialNumber: serial,
          preview: previews[cursor]!,
        });
      }
      setReadyCards(cards);
      setSkippedCount(slots.filter((slot) => slot === 'failed').length);
    };

    const onSlotDone = (index: number, preview: ValidatedThumb | null) => {
      if (cancelled) return;
      slots[index] = preview ? 'ready' : 'failed';
      if (preview) previews[index] = preview;
      finishedCount += 1;
      setPrefetchDone(finishedCount);
      commitReveal();
      if (finishedCount >= images.length) {
        setIsLoading(false);
        setIsComplete(true);
      }
    };

    let nextIndex = 0;
    let active = 0;

    const pump = () => {
      while (!cancelled && active < PREFETCH_CONCURRENCY && nextIndex < images.length) {
        const idx = nextIndex;
        nextIndex += 1;
        active += 1;
        void loadPreviewWithTimeout(images[idx], sourcePageUrl)
          .then((preview) => {
            if (!cancelled) onSlotDone(idx, preview);
          })
          .catch(() => {
            if (!cancelled) onSlotDone(idx, null);
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };

    pump();

    return () => {
      cancelled = true;
    };
  }, [imagesKey, sourcePageUrl, images.length]);

  return {
    readyCards,
    skippedCount,
    isLoading,
    isComplete,
    prefetchDone,
    totalQueued: images.length,
  };
};
