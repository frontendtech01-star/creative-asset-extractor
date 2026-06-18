import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { getImageAssetKey, resolveImagePreviewUrl, resolveImageThumbUrl } from '../lib/imageAsset';

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
  sourcePageUrl: string
) => {
  const candidates: string[] = [];
  const cached = String(img?.cachedUrl || '').trim();
  const originalUrl = getImageAssetKey(img);

  if (cached.startsWith('data:image/')) {
    candidates.push(cached);
  }
  if (cached.startsWith('/cached-images-original/')) {
    candidates.push(apiUrl(cached));
  }
  if (originalUrl.startsWith('data:')) {
    candidates.push(originalUrl);
    return candidates;
  }
  const thumbUrl = resolveImageThumbUrl(img, sourcePageUrl);
  if (thumbUrl) candidates.push(thumbUrl);
  const previewUrl = resolveImagePreviewUrl(img, sourcePageUrl);
  if (previewUrl) candidates.push(previewUrl);
  if (originalUrl.startsWith('http') && !candidates.includes(originalUrl)) {
    candidates.push(originalUrl);
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<ThumbPhase>('idle');
  const [src, setSrc] = useState('');
  const [candidateIndex, setCandidateIndex] = useState(0);
  const candidatesRef = useRef<string[]>([]);
  const assetKey = getImageAssetKey(img);
  const cachedPath = String(img?.cachedUrl || '').trim();

  useEffect(() => {
    setVisible(false);
    setPhase('idle');
    setSrc('');
    setCandidateIndex(0);
    candidatesRef.current = buildThumbCandidates(img, sourcePageUrl);

    const node = rootRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [assetKey, sourcePageUrl, cachedPath]);

  useEffect(() => {
    if (!visible) return;
    const candidates = candidatesRef.current;
    const nextSrc = candidates[candidateIndex] || '';
    if (!nextSrc) {
      setPhase('failed');
      return;
    }
    setSrc(nextSrc);
    setPhase('loading');
  }, [visible, candidateIndex, assetKey, sourcePageUrl, cachedPath]);

  const label = fallbackLabel || alt;

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-zinc-100">
      {src && phase !== 'failed' ? (
        <img
          src={src}
          alt={alt}
          className={`${className} h-full w-full transition-opacity duration-200 ${
            phase === 'ready' ? 'opacity-100' : 'opacity-0'
          }`}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            setPhase('ready');
            onReady?.();
            const el = event.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              onDimensions?.(el.naturalWidth, el.naturalHeight);
            }
          }}
          onError={() => {
            const candidates = candidatesRef.current;
            if (candidateIndex + 1 < candidates.length) {
              setCandidateIndex((prev) => prev + 1);
              return;
            }
            setPhase('failed');
            onFailed?.();
          }}
        />
      ) : null}
      {phase === 'loading' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center pointer-events-none">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          <p className="text-[11px] font-medium text-zinc-500">Loading thumbnail...</p>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 p-3 text-center">
          <p className="text-xs font-medium leading-snug text-zinc-600 line-clamp-4" title={label}>
            {label}
          </p>
        </div>
      ) : null}
    </div>
  );
}
