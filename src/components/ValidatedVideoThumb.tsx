import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Video as VideoIcon } from 'lucide-react';
import { loadRemoteValidatedThumb } from '../lib/thumbnailLoader';

type VideoThumbPhase = 'idle' | 'loading' | 'ready' | 'failed';

type ValidatedVideoThumbProps = {
  thumbnail?: string;
  title?: string;
  provider?: string;
  className?: string;
  compact?: boolean;
};

export default function ValidatedVideoThumb({
  thumbnail = '',
  title = '',
  provider = '',
  className = '',
  compact = false,
}: ValidatedVideoThumbProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<VideoThumbPhase>('idle');
  const [src, setSrc] = useState('');
  const cancelledRef = useRef(false);
  const thumbUrl = String(thumbnail || '').trim();

  useEffect(() => {
    cancelledRef.current = false;
    setVisible(false);
    setPhase('idle');
    setSrc('');

    const node = rootRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' }
    );
    observer.observe(node);
    return () => {
      cancelledRef.current = true;
      observer.disconnect();
    };
  }, [thumbUrl]);

  useEffect(() => {
    if (!visible) return;
    cancelledRef.current = false;

    if (!thumbUrl) {
      setPhase('failed');
      return;
    }

    setPhase('loading');
    setSrc('');

    void loadRemoteValidatedThumb(thumbUrl)
      .then((validated) => {
        if (cancelledRef.current) return;
        setSrc(validated.src);
        setPhase('ready');
      })
      .catch(() => {
        if (cancelledRef.current) return;
        setPhase('failed');
      });

    return () => {
      cancelledRef.current = true;
    };
  }, [visible, thumbUrl]);

  const providerLabel = String(provider || 'Video').trim() || 'Video';
  const titleLabel = String(title || '').trim();

  return (
    <div ref={rootRef} className={`relative overflow-hidden ${className}`}>
      {phase === 'ready' && src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover object-center opacity-100 transition-opacity duration-300"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : phase === 'failed' ? (
        <div className="flex h-full w-full flex-col items-center justify-center bg-zinc-100 px-3 text-center">
          <VideoIcon className={`text-zinc-400 ${compact ? 'h-5 w-5' : 'mb-2 h-10 w-10'}`} aria-hidden />
          {!compact ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{providerLabel}</p>
              {titleLabel ? (
                <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500" title={titleLabel}>
                  {titleLabel}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 bg-zinc-100 px-2 text-center">
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-100 via-zinc-200/60 to-zinc-100" />
          {phase === 'loading' ? (
            <>
              <Loader2 className="relative z-[1] h-5 w-5 animate-spin text-zinc-400" />
              {!compact ? (
                <p className="relative z-[1] text-[11px] font-medium text-zinc-500">Loading thumbnail...</p>
              ) : null}
            </>
          ) : (
            !compact ? <p className="relative z-[1] text-[11px] font-medium text-zinc-400">Waiting...</p> : null
          )}
        </div>
      )}
    </div>
  );
}
