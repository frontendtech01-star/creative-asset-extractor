import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { buildImagePreviewRequest, buildImageThumbRequest, getImageAssetKey } from '../lib/imageAsset';

type ThumbPhase = 'idle' | 'loading' | 'ready' | 'failed';

type LazyCachedImageThumbProps = {
  img: { url?: string; cachedUrl?: string };
  sourcePageUrl?: string;
  alt: string;
  fallbackLabel?: string;
  className?: string;
  onDimensions?: (width: number, height: number) => void;
  onReady?: () => void;
  onFailed?: () => void;
};

const buildThumbCandidates = (
  img: { url?: string; cachedUrl?: string },
  _sourcePageUrl: string
) => {
  const candidates: string[] = [];
  const addCandidate = (url: string) => {
    const normalized = String(url || '').trim();
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };
  const cached = String(img?.cachedUrl || '').trim();
  const originalUrl = getImageAssetKey(img);

  if (cached.startsWith('data:image/')) {
    addCandidate(cached);
  }
  if (cached.startsWith('/cached-images-original/')) {
    addCandidate(apiUrl(cached));
  }
  if (originalUrl.startsWith('data:')) {
    addCandidate(originalUrl);
    return candidates;
  }

  // Keep the older fast path first: let the browser show the discovered asset
  // directly. If that fails because the asset host blocks localhost hotlinks,
  // fall back to the cached/proxied preview with the original page referer.
  if (originalUrl.startsWith('http')) {
    const isSequenceOrToyotaAsset =
      String((img as any)?.source || '').includes('360-sequence') ||
      /\/jellies\/(?:max|relative)\//i.test(originalUrl);
    const thumbPreview = buildImageThumbRequest(img, _sourcePageUrl);
    const fallbackPreview = buildImagePreviewRequest(img, _sourcePageUrl);
    if (isSequenceOrToyotaAsset && thumbPreview) addCandidate(apiUrl(thumbPreview));
    addCandidate(originalUrl);
    if (!isSequenceOrToyotaAsset && thumbPreview) addCandidate(apiUrl(thumbPreview));
    if (fallbackPreview) addCandidate(apiUrl(fallbackPreview));
  }
  return candidates.filter(Boolean);
};

export default function LazyCachedImageThumb({
  img,
  sourcePageUrl = '',
  alt,
  fallbackLabel = '',
  className = '',
  onDimensions,
  onReady,
  onFailed,
}: LazyCachedImageThumbProps) {
  const [phase, setPhase] = useState<ThumbPhase>('idle');
  const [candidateIndex, setCandidateIndex] = useState(0);
  const assetKey = getImageAssetKey(img);
  const cachedPath = String(img?.cachedUrl || '').trim();
  const reportedReadyRef = useRef(false);
  const reportedFailedRef = useRef(false);
  const candidates = useMemo(
    () => buildThumbCandidates(img, sourcePageUrl),
    [assetKey, sourcePageUrl, cachedPath]
  );
  const src = candidates[candidateIndex] || '';

  const advanceCandidateOrFail = () => {
    if (candidateIndex + 1 < candidates.length) {
      setCandidateIndex((prev) => prev + 1);
      return;
    }
    setPhase('failed');
    if (!reportedFailedRef.current) {
      reportedFailedRef.current = true;
      onFailed?.();
    }
  };

  useEffect(() => {
    setPhase(src ? 'idle' : 'failed');
  }, [src]);

  useEffect(() => {
    if (!src || phase === 'ready' || phase === 'failed') return;
    setPhase('loading');
    const timeout = window.setTimeout(() => {
      advanceCandidateOrFail();
    }, 4500);
    return () => window.clearTimeout(timeout);
  }, [src, phase, candidateIndex, candidates.length]);

  useEffect(() => {
    reportedReadyRef.current = false;
    reportedFailedRef.current = false;
    setCandidateIndex(0);
    setPhase(candidates.length ? 'idle' : 'failed');
  }, [candidates]);

  const label = fallbackLabel || alt;

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-100">
      {src && phase !== 'failed' ? (
        <img
          src={src}
          alt={alt}
          className={`${className} h-full w-full`}
          decoding="async"
          loading="lazy"
          onLoad={(event) => {
            setPhase('ready');
            if (!reportedReadyRef.current) {
              reportedReadyRef.current = true;
              onReady?.();
            }
            const el = event.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              onDimensions?.(el.naturalWidth, el.naturalHeight);
            }
          }}
          onError={() => {
            advanceCandidateOrFail();
          }}
        />
      ) : null}
      {src && phase !== 'ready' && phase !== 'failed' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-50 p-3 text-center">
          <ImageIcon className="h-7 w-7 animate-pulse text-zinc-300" />
          <p className="text-xs font-medium leading-snug text-zinc-500">
            Loading thumbnail…
          </p>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-50 p-3 text-center">
          <ImageIcon className="h-7 w-7 text-zinc-300" />
          <p className="text-xs font-medium leading-snug text-zinc-600 line-clamp-4" title={label}>
            {label}
          </p>
        </div>
      ) : null}
    </div>
  );
}
