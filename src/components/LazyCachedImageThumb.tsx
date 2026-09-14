import { resolveSvgVariables, previewBackground } from '../lib/svgPreview';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { buildImagePreviewRequest, buildImageThumbRequest, getImageAssetKey } from '../lib/imageAsset';
import { loadPreviewImageThumb } from '../lib/thumbnailLoader';

type ThumbPhase = 'idle' | 'loading' | 'ready' | 'failed';

type LazyCachedImageThumbProps = {
  img: { url?: string; cachedUrl?: string; dataUrl?: string; thumbnailUrl?: string; type?: string; mimeType?: string; filename?: string; source?: string };
  sourcePageUrl?: string;
  alt: string;
  fallbackLabel?: string;
  className?: string;
  onDimensions?: (width: number, height: number) => void;
  onReady?: () => void;
  onFailed?: () => void;
};

const getSafeInlineSvgMarkup = (url: string) => {
  if (!/^data:image\/svg\+xml/i.test(url)) return url;
  try {
    const commaIndex = url.indexOf(',');
    if (commaIndex < 0) return url;
    const meta = url.slice(0, commaIndex);
    const payload = url.slice(commaIndex + 1);
    const isBase64 = /;base64/i.test(meta);
    const svgText = isBase64 ? atob(payload) : decodeURIComponent(payload);
    let sanitized = svgText
      .replace(/^\uFEFF/, '')
      .trim()
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(?:href|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
      .replace(/\sserif:[\w.-]+=(?:"[^"]*"|'[^']*')/gi, '');
    sanitized = resolveSvgVariables(sanitized);
    const tagMatch = sanitized.match(/<svg\b[^>]*>/i);
    if (tagMatch) {
      let tag = tagMatch[0];
      if (!/\sxmlns=/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      if (!/\sxml:space=/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xml:space="preserve"');
      sanitized = sanitized.replace(tagMatch[0], tag);
    }
    return sanitized;
  } catch {
    return '';
  }
};

const sanitizeInlineSvgDataUrl = (url: string) => {
  const markup = getSafeInlineSvgMarkup(url);
  return markup && markup !== url
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    : url;
};

export const buildThumbCandidates = (
  img: { url?: string; cachedUrl?: string; dataUrl?: string; thumbnailUrl?: string; type?: string; mimeType?: string; filename?: string; source?: string },
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
  const embeddedDataUrl = String(img?.dataUrl || '').trim();
  const generatedThumbnail = String(img?.thumbnailUrl || '').trim();
  const originalUrl = getImageAssetKey(img);
  const source = String((img as any)?.source || '').toLowerCase();
  const isSvgAsset =
    /\.svg(?:$|[?#])/i.test(originalUrl) ||
    /\.svg(?:$|[?#])/i.test(cached) ||
    String((img as any)?.type || '').toLowerCase() === 'svg' ||
    String((img as any)?.mimeType || '').toLowerCase().includes('svg');
  const isGeneratedFontAwesomeSvg =
    source.includes('font-awesome-icon-svg') ||
    (String((img as any)?.filename || '').toLowerCase().endsWith('.svg') && source.includes('font-awesome'));

  // Generated previews apply to inline/data assets as well as remote URLs.
  if (generatedThumbnail) {
    addCandidate(/^(?:https?:|data:|blob:)/i.test(generatedThumbnail) ? generatedThumbnail : apiUrl(generatedThumbnail));
  }

  if (embeddedDataUrl.startsWith('data:image/')) {
    addCandidate(sanitizeInlineSvgDataUrl(embeddedDataUrl));
  }
  if (isGeneratedFontAwesomeSvg && originalUrl.startsWith('data:image/svg+xml')) {
    addCandidate(sanitizeInlineSvgDataUrl(originalUrl));
    return candidates;
  }
  if (isGeneratedFontAwesomeSvg && cached.startsWith('data:image/svg+xml')) {
    addCandidate(sanitizeInlineSvgDataUrl(cached));
    return candidates;
  }

  if (cached.startsWith('data:image/')) {
    addCandidate(sanitizeInlineSvgDataUrl(cached));
  }
  if (cached.startsWith('/cached-images-original/')) {
    const previewRequest = isSvgAsset ? buildImagePreviewRequest(img, _sourcePageUrl) : '';
    if (previewRequest) addCandidate(apiUrl(previewRequest));
    addCandidate(apiUrl(cached));
  }
  if (originalUrl.startsWith('data:')) {
    addCandidate(sanitizeInlineSvgDataUrl(originalUrl));
    return candidates;
  }

  // Prefer the server-generated thumbnail. Remote CDNs frequently reject
  // localhost hotlinks even after the extraction itself succeeded.
  if (originalUrl.startsWith('http')) {
    const isSequenceOrToyotaAsset =
      String((img as any)?.source || '').includes('360-sequence') ||
      /\/jellies\/(?:max|relative)\//i.test(originalUrl);
    const thumbPreview = buildImageThumbRequest(img, _sourcePageUrl);
    const fallbackPreview = buildImagePreviewRequest(img, _sourcePageUrl);
    if (!isSvgAsset && thumbPreview) addCandidate(apiUrl(thumbPreview));
    if (isSvgAsset && fallbackPreview) addCandidate(apiUrl(fallbackPreview));
    addCandidate(originalUrl);
    if (isSequenceOrToyotaAsset && fallbackPreview) addCandidate(apiUrl(fallbackPreview));
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
  const [background, setBackground] = useState('#f4f4f5');
  const [phase, setPhase] = useState<ThumbPhase>('idle');
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [validatedPreview, setValidatedPreview] = useState('');
  const assetKey = getImageAssetKey(img);
  const cachedPath = String(img?.cachedUrl || '').trim();
  const embeddedDataUrl = String(img?.dataUrl || '').trim();
  const generatedThumbnail = String(img?.thumbnailUrl || '').trim();
  const typeKey = `${String(img?.type || '')}:${String(img?.mimeType || '')}:${String(img?.source || '')}:${String(img?.filename || '')}:${generatedThumbnail}`;
  const reportedReadyRef = useRef(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const reportedFailedRef = useRef(false);
  const candidates = useMemo(() => {
    const fallbackCandidates = buildThumbCandidates(img, sourcePageUrl);
    if (generatedThumbnail) return fallbackCandidates;
    return validatedPreview
      ? [validatedPreview, ...fallbackCandidates.filter((candidate) => candidate !== validatedPreview)]
      : fallbackCandidates;
  }, [assetKey, sourcePageUrl, cachedPath, embeddedDataUrl, generatedThumbnail, typeKey, validatedPreview]);
  const src = candidates[candidateIndex] || '';
  const inlineSvgFallback = useMemo(() => {
    const directSvg = [String(img?.dataUrl || ''), assetKey, String(img?.cachedUrl || '')]
      .find((value) => /^data:image\/svg\+xml/i.test(value));
    return directSvg ? getSafeInlineSvgMarkup(directSvg) : '';
  }, [assetKey, img?.cachedUrl, img?.dataUrl]);

  useEffect(() => {
    let cancelled = false;
    setValidatedPreview('');
    if (!assetKey || generatedThumbnail || assetKey.startsWith('data:') || embeddedDataUrl.startsWith('data:image/')) return () => {
      cancelled = true;
    };

    void loadPreviewImageThumb(img, sourcePageUrl)
      .then((preview) => {
        if (!cancelled) setValidatedPreview(preview.src);
      })
      .catch(() => {
        // The component's ordered candidates retain direct and proxy fallbacks.
      });

    return () => {
      cancelled = true;
    };
  }, [assetKey, sourcePageUrl, cachedPath, embeddedDataUrl, generatedThumbnail, typeKey]);

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
    // Inline and cached images can finish before passive effects run. Do not
    // overwrite that completion with a timer that later marks them failed.
    if (imageRef.current?.complete && imageRef.current.naturalWidth > 0) {
      setPhase('ready');
      return;
    }
    setPhase('loading');
    const timeout = window.setTimeout(() => {
      advanceCandidateOrFail();
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [src, phase, candidateIndex, candidates.length]);

  useEffect(() => {
    reportedReadyRef.current = false;
    reportedFailedRef.current = false;
    setCandidateIndex(0);
    setPhase(candidates.length ? 'idle' : 'failed');
  }, [candidates]);

  const label = fallbackLabel || alt;
  // An inline SVG fallback is a rendered preview, even if the browser refuses
  // to decode its data URL as an <img> source. Report it as ready so callers
  // do not treat a visible vector thumbnail as blank.
  const thumbnailPhase = phase === 'failed' && inlineSvgFallback ? 'ready' : phase;

  return (
    <div data-thumbnail-phase={thumbnailPhase} className="relative h-full w-full overflow-hidden" style={{ background }}>
      {src && phase !== 'failed' ? (
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          className={`${className} h-full w-full`}
          decoding="async"
          loading="eager"
          onLoad={(event) => {
            setPhase('ready');
            if (!reportedReadyRef.current) {
              reportedReadyRef.current = true;
              onReady?.();
            }
            const el = event.currentTarget;
            try {
              const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (ctx) { ctx.drawImage(el, 0, 0, 40, 40); setBackground(previewBackground(ctx.getImageData(0, 0, 40, 40).data)); }
            } catch { /* Remote images may disallow pixel inspection. */ }
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
        inlineSvgFallback ? (
          <div
            className="absolute inset-0 flex items-center justify-center bg-zinc-50 p-3 [&_svg]:max-h-full [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:w-auto"
            role="img"
            aria-label={alt}
            dangerouslySetInnerHTML={{ __html: inlineSvgFallback }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-50 p-3 text-center">
            <ImageIcon className="h-7 w-7 text-zinc-300" />
            <p className="text-xs font-medium leading-snug text-zinc-600 line-clamp-4" title={label}>
              {label}
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}
