import React, { useState } from 'react';
import { CheckCircle2, Download, Music, Video as VideoIcon, Search, Globe } from 'lucide-react';
import { apiFetch, apiFetchWithTimeout, apiUrl, isApiPathOrUrl, normalizeYouTubeMergedStreamPath, resolveApiRequestPath } from '../lib/api';
import { readResponseBlobWithProgress, saveBlob, triggerNativeDownload, type DownloadProgress } from '../lib/download';
import { isExpiredStreamUrl, sanitizeStreamUrl } from '../lib/streamUrl';
import {
  getCleanQualityKey,
  getCleanQualityLabel,
  getVisibleVideoCards,
  isDirectProgressiveVideoUrl,
  isDirectVideoAssetUrl,
  filenameFromAssetUrl,
  isGoogleVideoPlaybackUrl,
  isPlatformHostedUrl,
  isYouTubeWatchUrl,
  normalizeMediaUrl,
  normalizeYouTubeWatchUrl,
  qualityTierOptions,
  resolveYouTubeWatchUrlFromItem,
  toCanonicalVideoKey,
} from '../lib/visibleVideos';
import { CompletionCard, SmartProgressPanel, audioMessages, conversionMessages, downloadMessages } from './ProgressExperience';

type AudioQualityMode = 'turbo' | 'hq' | 'original';

export default function VideoExtractor({
  videos,
  loadingInsights = false,
  seedUrl = '',
  onManualResolvedCountChange,
}: {
  videos: any[];
  loadingInsights?: boolean;
  seedUrl?: string;
  onManualResolvedCountChange?: (count: number) => void;
}) {
  const safeVideos = getVisibleVideoCards(videos, seedUrl);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolvedVimeo, setResolvedVimeo] = useState<Record<string, any>>({});
  const [manualUrl, setManualUrl] = useState('');
  const [activeManualUrl, setActiveManualUrl] = useState('');
  const [manualResolvedByQuality, setManualResolvedByQuality] = useState<Record<string, any>>({});
  const [manualResolvingQuality, setManualResolvingQuality] = useState<string | null>(null);
  const [copiedQuality, setCopiedQuality] = useState<string | null>(null);
  const [manualMessage, setManualMessage] = useState<string>('');
  const [cardResolvingQualityKey, setCardResolvingQualityKey] = useState<string | null>(null);
  const [convertingMp4Key, setConvertingMp4Key] = useState<string | null>(null);
  const [processingAudioKey, setProcessingAudioKey] = useState<string | null>(null);
  const [mediaProgress, setMediaProgress] = useState<DownloadProgress | null>(null);
  const [activeMediaJob, setActiveMediaJob] = useState<{
    key: string;
    mode: 'download' | 'convert' | 'audio';
    title: string;
    detail?: string;
  } | null>(null);
  const [completedMediaJob, setCompletedMediaJob] = useState<{
    title: string;
    detail?: string;
    size?: number;
    folderTarget?: string;
  } | null>(null);
  const [convertedMp4Links, setConvertedMp4Links] = useState<Record<string, string>>({});
  const [resolvedCardByIndex, setResolvedCardByIndex] = useState<Record<number, any>>({});
  const [resolvedCardByQuality, setResolvedCardByQuality] = useState<Record<number, Record<string, any>>>({});
  const [activeQualityByIndex, setActiveQualityByIndex] = useState<Record<number, string>>({});
  const [unavailableQualityByIndex, setUnavailableQualityByIndex] = useState<Record<number, Record<string, boolean>>>({});
  const [qualityMessageByIndex, setQualityMessageByIndex] = useState<Record<number, string>>({});
  const [audioQualityMode, setAudioQualityMode] = useState<AudioQualityMode>('turbo');
  const [copiedCardQuality, setCopiedCardQuality] = useState<string | null>(null);
  const [thumbnailHydrating, setThumbnailHydrating] = useState<Record<number, boolean>>({});
  const [thumbnailAttempted, setThumbnailAttempted] = useState<Record<number, boolean>>({});
  const [directAssetMetaByIndex, setDirectAssetMetaByIndex] = useState<Record<number, any>>({});
  const probedDirectAssets = React.useRef(new Set<string>());
  const bootstrappedYouTubeCards = React.useRef(new Set<number>());
  const bootstrappedVimeoCards = React.useRef(new Set<number>());
  const qualityRequestSeq = React.useRef<Record<number, number>>({});
  const mediaJobSeq = React.useRef(0);

  const getVideoFormat = (item: any) => {
    const primaryUrl = String(item?.url || '').toLowerCase();
    const type = String(item?.type || '').toLowerCase();
    if ((primaryUrl.includes('/converted-videos/') || primaryUrl.includes('/api/download-local-video') || /\.mp4(\?|$)/i.test(primaryUrl)) && type === 'mp4') return 'mp4';
    const url = String(item?.sourceStreamUrl || item?.url || '').toLowerCase();
    const match = url.match(/\.(mp4|webm|mov|mkv|m3u8|mpd)(?:\?|$)/);
    if (match?.[1]) return match[1];
    if (['mp4', 'webm', 'mov', 'mkv', 'm3u8', 'mpd'].includes(type)) return type;
    return type || 'video';
  };

  const isMp4Video = (item: any) => getVideoFormat(item) === 'mp4';

  const isMp4StreamingLink = (rawUrl: string) => {
    const url = String(rawUrl || '');
    return (
      isApiPathOrUrl(url, '/api/download') ||
      isApiPathOrUrl(url, '/api/youtube-merged-stream') ||
      isApiPathOrUrl(url, '/api/download-local-video') ||
      url.includes('/api/download-local-video') ||
      url.includes('/converted-videos/') ||
      /\.mp4(\?|$)/i.test(url) ||
      /googlevideo\.com\/videoplayback|\/videoplayback\?|vimeo\.com\/progressive_redirect|vimeocdn\.com\/.*\.m3u8|video\.twimg\.com|fbcdn\.net|cdninstagram\.com/i.test(url)
    );
  };

  const streamHasAudio = (item: any) => {
    const codec = String(item?.acodec || item?.audioCodec || '').toLowerCase();
    const streamUrl = String(item?.sourceStreamUrl || item?.url || '');
    if (item?.audioAvailable === false || item?.noAudio) return false;
    if (item?.audioAvailable === true) return true;
    if (item?.hasAudio === true) return true;
    if (codec === 'none') return false;
    if (codec && codec !== 'unknown') return true;
    if (/googlevideo\.com\/videoplayback|\/videoplayback\?/i.test(streamUrl)) return false;
    return !item?.isYouTubeDirect;
  };

  const buildYouTubeMergedUrl = (watchUrl: string, titleHint?: string, quality = 'fhd') => {
    const safeBase =
      String(titleHint || 'video')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'video';
    return apiUrl(`/api/youtube-merged-stream?url=${encodeURIComponent(watchUrl)}&quality=${quality}&inline=1&filename=${encodeURIComponent(`${safeBase}.mp4`)}`);
  };

  const buildMp4DownloadUrl = (streamUrl: string, titleHint?: string, quality?: string) => {
    const safeBase =
      String(titleHint || 'video')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'video';
    return apiUrl(`/api/download?url=${encodeURIComponent(streamUrl)}&filename=${encodeURIComponent(`${safeBase}.mp4`)}${quality ? `&quality=${quality}&inline=1` : ''}`);
  };

  const toMp4Filename = (titleHint?: string) => {
    const safeBase =
      String(titleHint || 'video')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'video';
    return `${safeBase}.mp4`;
  };

  const toAudioFilename = (titleHint?: string, extension: 'mp3' | 'm4a' = 'mp3') => {
    const safeBase =
      String(titleHint || 'audio')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'audio';
    return `${safeBase}.${extension}`;
  };

  const getAudioActionLabel = () => {
    if (audioQualityMode === 'original') return 'Extract Original Audio';
    if (audioQualityMode === 'hq') return 'Extract HQ Audio';
    return 'Extract Quick Audio';
  };

  const formatBytes = (value: any) => {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const formatDuration = (value: any) => {
    const total = Number(value || 0);
    if (!Number.isFinite(total) || total <= 0) return '';
    const seconds = Math.round(total);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    saveBlob(blob, filename);
  };

  const toAbsoluteAppUrl = (value: string) => {
    if (!value) return value;
    if (isApiPathOrUrl(value, '/api/youtube-merged-stream') || value.includes('/api/youtube-merged-stream?')) {
      return apiUrl(normalizeYouTubeMergedStreamPath(value));
    }
    try {
      return new URL(value, window.location.origin).href;
    } catch {
      return value;
    }
  };

  const getSourceForMp4 = (itemOrUrl: any) => {
    if (typeof itemOrUrl === 'string') return itemOrUrl;
    return String(itemOrUrl?.sourceStreamUrl || itemOrUrl?.url || '');
  };

  const isSignedPlatformCdnUrl = (rawUrl: string) => {
    try {
      const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
      return (
        host.includes('fbcdn.net') ||
        host.includes('cdninstagram.com') ||
        host.includes('twimg.com') ||
        host.includes('vimeo.com') ||
        host.includes('akamaized.net')
      );
    } catch {
      return /fbcdn\.net|cdninstagram\.com|twimg\.com|vimeo\.com|akamaized\.net/i.test(String(rawUrl || ''));
    }
  };

  const openFolder = async (target = 'downloads') => {
    try {
      await apiFetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
    } catch {
      // Keep this best-effort; browser download locations are controlled by the user agent.
    }
  };

  const resolveYouTubeWatchUrl = (item: any) => resolveYouTubeWatchUrlFromItem(item, seedUrl);

  const isYouTubeCardVideo = (item: any, cardUrl = '') => {
    const normalizedUrl = cardUrl || normalizeMediaUrl(String(item?.url || ''), item?.sourceUrl || item?.pageUrl || seedUrl);
    return (
      Boolean(resolveYouTubeWatchUrlFromItem(item, seedUrl)) ||
      String(item?.provider || '').toLowerCase().includes('youtube') ||
      isYouTubeMediaItem(item, normalizedUrl)
    );
  };

  const getYouTubeDirectStreamUrl = (item: any) => {
    const normalizedSourceUrl = normalizeMediaUrl(String(item?.sourceStreamUrl || ''), item?.sourceUrl || item?.pageUrl || seedUrl);
    const normalizedItemUrl = normalizeMediaUrl(String(item?.url || ''), item?.sourceUrl || item?.pageUrl || seedUrl);
    if (isGoogleVideoPlaybackUrl(normalizedSourceUrl)) return normalizedSourceUrl;
    if (isGoogleVideoPlaybackUrl(normalizedItemUrl) && !isApiPathOrUrl(normalizedItemUrl, '/api/youtube-merged-stream')) {
      return normalizedItemUrl;
    }
    return '';
  };

  const buildYouTubeQualityVideo = (resolved: any, watchUrl: string, quality: string) => {
    const sourceCandidate = normalizeMediaUrl(String(resolved?.sourceStreamUrl || resolved?.url || ''), watchUrl);
    const directUrl =
      isGoogleVideoPlaybackUrl(sourceCandidate) && !isApiPathOrUrl(sourceCandidate, '/api/youtube-merged-stream')
        ? sourceCandidate
        : getYouTubeDirectStreamUrl(resolved);
    const mergedUrl = buildYouTubeMergedUrl(watchUrl, resolved?.title, quality);
    return {
      ...resolved,
      sourceStreamUrl: directUrl || resolved?.sourceStreamUrl || sourceCandidate,
      sourceUrl: watchUrl,
      pageUrl: watchUrl,
      watchUrl,
      url: mergedUrl,
      mp4ConvertUrl: mergedUrl,
      type: 'mp4',
      qualityRequested: quality,
      displayQualityKey: quality,
      displayQualityLabel: getCleanQualityLabel(quality),
      streamLabel: getCleanQualityLabel(quality),
      isYouTubeMerged: true,
      isYouTubeDirect: false,
      audioAvailable: true,
      hasAudio: true,
      noAudio: false,
    };
  };

  const buildDefaultYouTubeMergedVideo = (item: any, quality = 'fhd') => {
    const watchUrl = resolveYouTubeWatchUrlFromItem(item, seedUrl);
    if (!watchUrl) return null;
    const directUrl = getYouTubeDirectStreamUrl(item);
    const mergedUrl = buildYouTubeMergedUrl(watchUrl, item?.title, quality);
    return {
      ...item,
      sourceStreamUrl: directUrl || item?.sourceStreamUrl || item?.url,
      sourceUrl: watchUrl,
      pageUrl: watchUrl,
      watchUrl,
      url: mergedUrl,
      mp4ConvertUrl: mergedUrl,
      type: 'mp4',
      qualityRequested: quality,
      displayQualityKey: quality,
      displayQualityLabel: getCleanQualityLabel(quality),
      streamLabel: getCleanQualityLabel(quality),
      isYouTubeMerged: true,
      isYouTubeDirect: false,
      audioAvailable: true,
      hasAudio: true,
      noAudio: false,
    };
  };

  const isYouTubeMediaItem = (item: any, url = '') => {
    const normalizedUrl = String(url || item?.url || item?.sourceStreamUrl || '');
    return (
      isYouTubeWatchUrl(normalizedUrl) ||
      isGoogleVideoPlaybackUrl(normalizedUrl) ||
      isYouTubeWatchUrl(String(item?.sourceUrl || '')) ||
      isYouTubeWatchUrl(String(item?.pageUrl || '')) ||
      String(item?.provider || '').toLowerCase().includes('youtube')
    );
  };

  const buildYouTubeMergedLink = (item: any, titleHint?: string, quality = 'fhd') => {
    const watchUrl = resolveYouTubeWatchUrl(item);
    if (!watchUrl) return '';
    return buildYouTubeMergedUrl(watchUrl, titleHint, quality);
  };

  const getDirectMp4Link = async (itemOrUrl: any, titleHint?: string) => {
    const primaryUrl = typeof itemOrUrl === 'string' ? itemOrUrl : String(itemOrUrl?.url || '');
    const stableAppUrl = typeof itemOrUrl !== 'string' && (isApiPathOrUrl(primaryUrl, '/api/download') || isApiPathOrUrl(primaryUrl, '/api/youtube-merged-stream') || isApiPathOrUrl(primaryUrl, '/api/download-local-video') || primaryUrl.includes('/api/download-local-video') || primaryUrl.includes('/converted-videos/'))
      ? primaryUrl
      : '';
    const sourceUrl = normalizeMediaUrl(stableAppUrl || getSourceForMp4(itemOrUrl), typeof itemOrUrl === 'string' ? seedUrl : itemOrUrl?.sourceUrl || itemOrUrl?.pageUrl);
    if (!sourceUrl) throw new Error('No video URL available to convert.');
    const absoluteSource = toAbsoluteAppUrl(sourceUrl);
    const sourceFormat = typeof itemOrUrl === 'string' ? getVideoFormat({ url: sourceUrl }) : getVideoFormat(itemOrUrl);
    if (isApiPathOrUrl(sourceUrl, '/api/download') || isApiPathOrUrl(sourceUrl, '/api/youtube-merged-stream') || isApiPathOrUrl(sourceUrl, '/api/download-local-video') || sourceUrl.includes('/api/download-local-video') || sourceUrl.includes('/converted-videos/')) {
      return toAbsoluteAppUrl(sourceUrl);
    }
    if (
      sourceFormat === 'mp4' &&
      isGoogleVideoPlaybackUrl(sourceUrl)
    ) {
      return sourceUrl;
    }
    if (sourceFormat === 'mp4' && /\.mp4(\?|$)/i.test(sourceUrl) && !isSignedPlatformCdnUrl(sourceUrl)) {
      return sourceUrl;
    }
    if (isDirectProgressiveVideoUrl(sourceUrl)) {
      return sourceUrl;
    }
    if (sourceFormat === 'mp4' && /\.mp4(\?|$)/i.test(sourceUrl)) {
      return buildMp4DownloadUrl(sourceUrl, titleHint);
    }

    const filename = toMp4Filename(titleHint);
    const sourceParam = seedUrl ? `&sourcePageUrl=${encodeURIComponent(seedUrl)}` : '';
    const response = await apiFetch(`/api/convert-mp4?url=${encodeURIComponent(absoluteSource)}&filename=${encodeURIComponent(filename)}${sourceParam}`);
    const data = await parseJsonSafe(response);
    if (!response.ok || !data?.url) {
      throw new Error(data?.error || 'Failed to convert this video to MP4.');
    }
    return data.url;
  };

  const convertAndDownloadMp4 = async (streamUrl: string, titleHint: string | undefined, key: string) => {
    if (!streamUrl) return;
    const jobId = mediaJobSeq.current + 1;
    mediaJobSeq.current = jobId;
    const isCurrentJob = () => mediaJobSeq.current === jobId;
    setCompletedMediaJob(null);
    setMediaProgress(null);
    setActiveMediaJob({
      key,
      mode: 'convert',
      title: 'MP4 conversion running',
      detail: 'FFmpeg compatibility pass',
    });
    setConvertingMp4Key(key);
    try {
      let sourceUrl = streamUrl;
      if (!isApiPathOrUrl(String(sourceUrl || ''), '/api/download') && isPlatformHostedUrl(sourceUrl) && !isDirectVideoAssetUrl(sourceUrl)) {
        if (isCurrentJob()) setActiveMediaJob((prev) => prev ? { ...prev, detail: 'Trying alternative video source' } : prev);
        const resolved = await resolveWithFallback(sourceUrl, key.includes('hd') && !key.includes('fhd') ? 'hd' : 'fhd');
        sourceUrl = resolved?.sourceStreamUrl || resolved?.url || sourceUrl;
      }
      const mp4Url = await getDirectMp4Link(sourceUrl, titleHint);
      if (!isCurrentJob()) return;
      setConvertedMp4Links((prev) => ({ ...prev, [key]: mp4Url }));
      setActiveMediaJob((prev) => prev ? { ...prev, mode: 'download', title: 'Preparing MP4 download', detail: 'Streaming converted file' } : prev);
      const response = await fetch(mp4Url);
      if (!response.ok) throw new Error('Converted MP4 could not be downloaded.');
      const blob = await readResponseBlobWithProgress(response, setMediaProgress);
      if (!blob.size) throw new Error('Converted MP4 is empty.');
      downloadBlob(blob, toMp4Filename(titleHint));
      setCompletedMediaJob({
        title: 'MP4 export complete',
        detail: 'Optimized playback-compatible MP4 is ready.',
        size: blob.size,
        folderTarget: 'downloads',
      });
    } catch (error: any) {
      console.error('MP4 conversion failed:', error);
      alert(error?.message || 'Trying alternative video source did not finish. Please retry MP4 conversion.');
    } finally {
      if (isCurrentJob()) {
        setConvertingMp4Key(null);
        setMediaProgress(null);
        setActiveMediaJob(null);
      }
    }
  };

  const parseJsonSafe = async (response: Response) => {
    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(rawText);
      } catch {
        return { error: 'Server returned invalid JSON.' };
      }
    }
    const looksLikeHtml = /<!doctype html>|<html/i.test(rawText);
    if (looksLikeHtml) {
      return { error: 'Video resolver API is not available right now. Please restart backend with `npm run dev` and try again.' };
    }
    return { error: rawText?.slice(0, 240) || 'Server returned non-JSON response.' };
  };

  React.useEffect(() => {
    if (!seedUrl) return;
    setManualUrl(seedUrl);
    setActiveManualUrl(seedUrl);
    setManualResolvedByQuality({});
      setResolvedCardByIndex({});
      setResolvedCardByQuality({});
      setQualityMessageByIndex({});
      setThumbnailHydrating({});
      setThumbnailAttempted({});
      bootstrappedYouTubeCards.current.clear();
      bootstrappedVimeoCards.current.clear();
  }, [seedUrl]);

  React.useEffect(() => {
    const uniqueManual = new Set(
      Object.values(manualResolvedByQuality || {})
        .map((item: any) => item?.url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
    );
    onManualResolvedCountChange?.(uniqueManual.size);
  }, [manualResolvedByQuality, onManualResolvedCountChange]);

  React.useEffect(() => {
    let cancelled = false;

    safeVideos.forEach((video, idx) => {
      const cardUrl = normalizeMediaUrl(String(video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
      const probeKey = `${idx}:${cardUrl}`;
      if (!cardUrl || !isDirectProgressiveVideoUrl(cardUrl) || isYouTubeMediaItem(video, cardUrl) || probedDirectAssets.current.has(probeKey)) return;
      probedDirectAssets.current.add(probeKey);

      void (async () => {
        try {
          const sourceParam = seedUrl ? `&sourcePageUrl=${encodeURIComponent(seedUrl)}` : '';
          const response = await apiFetch(`/api/resolve-video?url=${encodeURIComponent(cardUrl)}${sourceParam}`);
          const data = await parseJsonSafe(response);
          if (!response.ok || !data?.video || cancelled) return;
          setDirectAssetMetaByIndex((prev) => ({ ...prev, [idx]: data.video }));
          setResolvedCardByIndex((prev) => ({ ...prev, [idx]: { ...(prev[idx] || {}), ...data.video } }));
        } catch {
          // Metadata probing is best-effort for direct assets.
        }
      })();
    });

    return () => {
      cancelled = true;
    };
  }, [safeVideos, seedUrl]);

  React.useEffect(() => {
    let cancelled = false;

    safeVideos.forEach((video, idx) => {
      const cardUrl = normalizeMediaUrl(String(video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
      if (!isYouTubeCardVideo(video, cardUrl)) return;
      if (bootstrappedYouTubeCards.current.has(idx)) return;
      bootstrappedYouTubeCards.current.add(idx);

      const fhdVideo = buildDefaultYouTubeMergedVideo(video, 'fhd');
      if (!fhdVideo) return;

      setActiveQualityByIndex((prev) => ({ ...prev, [idx]: prev[idx] || 'fhd' }));
      setResolvedCardByQuality((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          fhd: fhdVideo,
        },
      }));
      setResolvedCardByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          ...fhdVideo,
        },
      }));

      const watchUrl = resolveYouTubeWatchUrlFromItem(video, seedUrl);
      if (watchUrl) {
        void apiFetch(`/api/verify-youtube-merge?url=${encodeURIComponent(watchUrl)}&quality=fhd`).catch(() => {
          // Best-effort cache warm for merged playback.
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [safeVideos, seedUrl]);

  React.useEffect(() => {
    safeVideos.forEach((video, idx) => {
      if (!video?.vimeoQualityVariants || !video?.streamsPrepared) return;
      if (bootstrappedVimeoCards.current.has(idx)) return;
      bootstrappedVimeoCards.current.add(idx);

      const variants = video.vimeoQualityVariants as Record<string, any>;
      const defaultKey = String(video.defaultQualityKey || (variants.fhd ? 'fhd' : variants.hd ? 'hd' : ''));
      if (!defaultKey || !variants[defaultKey]) return;

      setActiveQualityByIndex((prev) => ({ ...prev, [idx]: prev[idx] || defaultKey }));
      setResolvedCardByQuality((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          ...variants,
        },
      }));
      setResolvedCardByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          ...variants[defaultKey],
        },
      }));
      setUnavailableQualityByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          fhd: !variants.fhd,
          hd: !variants.hd,
        },
      }));
    });
  }, [safeVideos]);

  React.useEffect(() => {
    let cancelled = false;

    const hydrateOne = async (idx: number, base: any) => {
      const merged = resolvedCardByIndex[idx] ? { ...base, ...resolvedCardByIndex[idx] } : base;
      if (String(merged?.thumbnail || '').trim()) return;
      const sourceUrl = String(merged?.url || merged?.sourceStreamUrl || merged?.originalUrl || merged?.pageUrl || merged?.sourceUrl || '');
      if (!sourceUrl || !isPlatformHostedUrl(sourceUrl) || thumbnailHydrating[idx] || thumbnailAttempted[idx]) return;

      setThumbnailHydrating((prev) => ({ ...prev, [idx]: true }));
      setThumbnailAttempted((prev) => ({ ...prev, [idx]: true }));
      try {
        const previewRes = await apiFetch(`/api/video-preview?url=${encodeURIComponent(sourceUrl)}`);
        const previewData = await parseJsonSafe(previewRes);
        const previewThumb = String(previewData?.preview?.thumbnail || '').trim();
        if (!cancelled && previewThumb) {
          setResolvedCardByIndex((prev) => ({
            ...prev,
            [idx]: {
              ...merged,
              thumbnail: previewThumb,
              title: previewData?.preview?.title || merged?.title,
              provider: previewData?.preview?.provider || merged?.provider,
            },
          }));
          return;
        }

        const resolved = await resolveWithFallback(sourceUrl, 'hd');
        if (!cancelled && resolved?.thumbnail) {
          setResolvedCardByIndex((prev) => ({ ...prev, [idx]: { ...merged, thumbnail: resolved.thumbnail } }));
        }
      } catch {
        // Keep placeholder when source does not expose preview.
      } finally {
        if (!cancelled) {
          setThumbnailHydrating((prev) => ({ ...prev, [idx]: false }));
        }
      }
    };

    safeVideos.forEach((item, idx) => {
      void hydrateOne(idx, item);
    });

    return () => {
      cancelled = true;
    };
  }, [safeVideos]);

  const downloadDirectAsset = async (sourceUrl: string, filename: string) => {
    const normalizedUrl = normalizeMediaUrl(sourceUrl, seedUrl);
    if (!normalizedUrl) throw new Error('Invalid direct video URL.');
    const saveAs = filename || filenameFromAssetUrl(normalizedUrl);

    try {
      const directResponse = await fetch(normalizedUrl, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (directResponse.ok) {
        const blob = await readResponseBlobWithProgress(directResponse, setMediaProgress);
        if (blob.size > 0) {
          saveBlob(blob, saveAs);
          return blob;
        }
      }
    } catch {
      // Fall back to server-side cache stream when the origin blocks browser fetches.
    }

    const response = await apiFetch(
      `/api/fetch-direct-video?url=${encodeURIComponent(normalizedUrl)}&filename=${encodeURIComponent(saveAs)}`
    );
    if (!response.ok) throw new Error('Download failed');
    const blob = await readResponseBlobWithProgress(response, setMediaProgress);
    if (!blob.size) throw new Error('Download failed');
    saveBlob(blob, saveAs);
    return blob;
  };

  const warmYouTubeMergeCache = async (downloadPath: string) => {
    const normalizedPath = resolveApiRequestPath(downloadPath);
    try {
      const parsed = new URL(normalizedPath, apiUrl('/'));
      if (parsed.pathname !== '/api/youtube-merged-stream') return;
      const watchUrl = parsed.searchParams.get('url');
      const quality = parsed.searchParams.get('quality') || 'fhd';
      if (!watchUrl) return;
      setActiveMediaJob((prev) => (prev ? { ...prev, detail: `Merging ${quality.toUpperCase()} video with audio...` } : prev));
      const response = await apiFetchWithTimeout(
        `/api/verify-youtube-merge?url=${encodeURIComponent(watchUrl)}&quality=${encodeURIComponent(quality)}`,
        undefined,
        90000
      );
      const data = await parseJsonSafe(response);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'Failed to prepare merged YouTube video.');
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error('Failed to prepare merged YouTube video.');
    }
  };

  const downloadViaAppStream = async (downloadPath: string, filename: string) => {
    const normalizedPath = resolveApiRequestPath(downloadPath);
    if (normalizedPath.includes('/api/youtube-merged-stream')) {
      await warmYouTubeMergeCache(normalizedPath);
    }
    const absoluteHref = apiUrl(normalizedPath);
    const headResponse = await apiFetch(normalizedPath, { method: 'HEAD' });
    if (!headResponse.ok) throw new Error('Download failed');
    setActiveMediaJob((prev) => (prev ? { ...prev, detail: 'Saving MP4 to your downloads folder...' } : prev));
    triggerNativeDownload(absoluteHref, filename);
    const contentLength = Number(headResponse.headers.get('content-length') || 0);
    return contentLength > 0 ? contentLength : undefined;
  };

  const handleDownload = async (url: string, filename: string) => {
    const jobId = mediaJobSeq.current + 1;
    mediaJobSeq.current = jobId;
    const isCurrentJob = () => mediaJobSeq.current === jobId;
    setDownloading(url);
    setCompletedMediaJob(null);
    setMediaProgress(null);
    setActiveMediaJob({
      key: `download-${url}`,
      mode: 'download',
      title: 'Downloading video stream',
      detail: 'Reconnecting download stream if needed',
    });
    try {
      const rawUrl = String(url || '').trim();
      const unwrappedUrl = (() => {
        if (isApiPathOrUrl(rawUrl, '/api/download')) {
          try {
            const parsed = new URL(rawUrl, window.location.origin);
            return parsed.searchParams.get('url') || rawUrl;
          } catch {
            return rawUrl;
          }
        }
        return rawUrl;
      })();
      const normalizedDirectUrl = normalizeMediaUrl(unwrappedUrl, seedUrl);
      if (isDirectProgressiveVideoUrl(normalizedDirectUrl)) {
        const saveAs = filename || filenameFromAssetUrl(normalizedDirectUrl);
        const blob = await downloadDirectAsset(normalizedDirectUrl, saveAs);
        if (!isCurrentJob()) return;
        setCompletedMediaJob({
          title: 'Video download complete',
          detail: 'The media stream has been saved.',
          size: blob.size,
          folderTarget: 'downloads',
        });
        return;
      }

      const youtubeWatchUrl = isYouTubeWatchUrl(rawUrl) ? normalizeYouTubeWatchUrl(rawUrl) : '';
      const isMergedStreamUrl =
        isApiPathOrUrl(rawUrl, '/api/youtube-merged-stream') || rawUrl.includes('/api/youtube-merged-stream?');
      const isProxyUrl =
        isApiPathOrUrl(rawUrl, '/api/download') ||
        isMergedStreamUrl ||
        isApiPathOrUrl(rawUrl, '/api/download-local-video') ||
        rawUrl.includes('/api/download-local-video') ||
        rawUrl.includes('/converted-videos/');
      const downloadPath = youtubeWatchUrl
        ? `/api/youtube-merged-stream?url=${encodeURIComponent(youtubeWatchUrl)}&quality=fhd&inline=0&filename=${encodeURIComponent(filename)}`
        : isMergedStreamUrl
        ? normalizeYouTubeMergedStreamPath(rawUrl, filename, { forDownload: true })
        : isProxyUrl
        ? resolveApiRequestPath(rawUrl)
        : `/api/download?url=${encodeURIComponent(rawUrl)}&filename=${encodeURIComponent(filename)}`;

      if (
        isMergedStreamUrl ||
        isApiPathOrUrl(downloadPath, '/api/youtube-merged-stream') ||
        isApiPathOrUrl(downloadPath, '/api/download')
      ) {
        const downloadedSize = await downloadViaAppStream(downloadPath, filename);
        if (!isCurrentJob()) return;
        setCompletedMediaJob({
          title: 'Video download started',
          detail: 'Your browser is saving the MP4 file.',
          size: downloadedSize,
          folderTarget: 'downloads',
        });
        return;
      }

      const response = await apiFetch(downloadPath);
      if (!response.ok) throw new Error('Download failed');
      const blob = await readResponseBlobWithProgress(response, setMediaProgress);
      if (!isCurrentJob()) return;
      saveBlob(blob, filename);
      setCompletedMediaJob({
        title: 'Video download complete',
        detail: 'The media stream has been saved.',
        size: blob.size,
        folderTarget: 'downloads',
      });
    } catch (error) {
      console.error('Download error:', error);
      const rawUrl = String(url || '').trim();
      const fallbackPath = resolveApiRequestPath(
        isApiPathOrUrl(rawUrl, '/api/youtube-merged-stream') || rawUrl.includes('/api/youtube-merged-stream?')
          ? normalizeYouTubeMergedStreamPath(rawUrl, filename, { forDownload: true })
          : isApiPathOrUrl(rawUrl, '/api/download') || rawUrl.includes('/api/')
          ? rawUrl
          : ''
      );
      if (fallbackPath && (fallbackPath.includes('/api/youtube-merged-stream') || fallbackPath.includes('/api/download'))) {
        try {
          const downloadedSize = await downloadViaAppStream(fallbackPath, filename);
          if (isCurrentJob()) {
            setCompletedMediaJob({
              title: 'Video download started',
              detail: 'Your browser is saving the MP4 file.',
              size: downloadedSize,
              folderTarget: 'downloads',
            });
          }
          return;
        } catch (retryError) {
          console.error('Download retry error:', retryError);
        }
      }

      const base = filename.replace(/\.[^/.]+$/, '') || 'video';
      const text = [
        'Video stream could not be downloaded as a file.',
        '',
        `URL: ${url}`,
        error instanceof Error ? `Reason: ${error.message}` : '',
        '',
        'Open the app at http://localhost:3000 and retry the download.',
      ].filter(Boolean).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      saveBlob(blob, `${base}.asset-url.txt`);
      if (isCurrentJob()) {
        setCompletedMediaJob({
          title: 'Video path saved',
          detail: 'The source blocked the stream download, so the asset URL was saved instead.',
          size: blob.size,
          folderTarget: 'downloads',
        });
      }
    } finally {
      if (isCurrentJob()) {
        setDownloading(null);
        setMediaProgress(null);
        setActiveMediaJob(null);
      }
    }
  };

  const handleManualSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeMediaUrl(manualUrl.trim(), seedUrl);
    if (normalized) {
      setActiveManualUrl(normalized);
      setManualResolvedByQuality({});
      setManualMessage('');
    } else {
      setManualMessage('That URL is not a valid HTTPS media or video page link.');
    }
  };

  const isLikelyVideoUrl = (rawUrl: string) => {
    try {
      const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
      return (
        host.includes('youtube.com') ||
        host === 'youtu.be' ||
        host.includes('vimeo.com') ||
        host === 'x.com' ||
        host.includes('twitter.com') ||
        host.includes('facebook.com') ||
        host === 'fb.watch' ||
        host.includes('instagram.com') ||
        host.includes('tiktok.com') ||
        host.includes('dailymotion.com') ||
        host.includes('brightcove.net')
      );
    } catch {
      return false;
    }
  };

  const resolveGenericVideo = async (rawUrl: string, quality = 'fhd') => {
    const normalizedUrl = normalizeMediaUrl(rawUrl, seedUrl);
    if (!normalizedUrl) throw new Error('Invalid or expired video URL.');
    const sourceParam = seedUrl ? `&sourcePageUrl=${encodeURIComponent(seedUrl)}` : '';
    const response = await apiFetch(`/api/resolve-video?url=${encodeURIComponent(normalizedUrl)}&quality=${quality}${sourceParam}`);
    const data = await parseJsonSafe(response);
    if (!response.ok) {
      throw new Error(data.error || 'Could not resolve video');
    }
    if (!data?.video?.url) {
      throw new Error(data?.error || 'No downloadable stream URL returned.');
    }
    return data.video;
  };

  const resolveWithFallback = async (rawUrl: string, quality: string) => {
    try {
      return await resolveGenericVideo(rawUrl, quality);
    } catch (error: any) {
      const isVimeo = /vimeo\.com|player\.vimeo\.com/i.test(rawUrl);
      if (!isVimeo) {
        throw new Error(error?.message || 'Unable to resolve downloadable stream for this link right now.');
      }
      const sourceParam = seedUrl ? `&sourcePageUrl=${encodeURIComponent(seedUrl)}` : '';
      const response = await apiFetch(`/api/resolve-vimeo?url=${encodeURIComponent(rawUrl)}&quality=${quality}${sourceParam}`);
      const data = await parseJsonSafe(response);
      if (!response.ok || !data?.video?.url) {
        throw new Error(data?.error || 'Failed to resolve downloadable stream for this link.');
      }
      return data.video;
    }
  };

  const resolveYouTubeQualityForCard = async (video: any, quality: string) => {
    const watchUrl = resolveYouTubeWatchUrlFromItem(video, seedUrl);
    if (!watchUrl) throw new Error('YouTube watch URL not found.');
    const resolved = await resolveWithFallback(watchUrl, quality);
    return buildYouTubeQualityVideo({ ...video, ...resolved }, watchUrl, quality);
  };

  const handleResolveVimeo = async (video: any, idx: number, quality: string) => {
    const resolveKey = `${video.url}-${quality}`;
    setResolving(resolveKey);
    try {
      const sourceParam = seedUrl ? `&sourcePageUrl=${encodeURIComponent(seedUrl)}` : '';
      const response = await apiFetch(`/api/resolve-vimeo?url=${encodeURIComponent(video.url)}&quality=${quality}${sourceParam}`);
      const data = await parseJsonSafe(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to prepare Vimeo download');
      }
      if (!data?.video?.url) {
        throw new Error(data?.error || 'No downloadable Vimeo stream URL returned.');
      }
      setResolvedVimeo(prev => ({ ...prev, [resolveKey]: data.video }));
      await handleDownload(data.video.url, getDownloadName(data.video, idx));
    } catch (error: any) {
      console.error('Vimeo resolve error:', error);
      alert(error.message || 'Failed to prepare Vimeo download.');
    } finally {
      setResolving(null);
    }
  };

  const isPreparedVimeoCard = (video: any) => Boolean(video?.streamsPrepared && video?.vimeoQualityVariants);

  const handleCardQualitySwitch = async (video: any, idx: number, quality: string) => {
    const variants = video?.vimeoQualityVariants as Record<string, any> | undefined;
    if (variants?.[quality]) {
      setResolvedCardByQuality((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          [quality]: variants[quality],
        },
      }));
      setActiveQualityByIndex((prev) => ({ ...prev, [idx]: quality }));
      setResolvedCardByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          ...variants[quality],
        },
      }));
      setQualityMessageByIndex((prev) => ({
        ...prev,
        [idx]: variants[quality]?.fallbackMessage || variants[quality]?.qualityFallbackMessage || '',
      }));
      return;
    }

    const cached = resolvedCardByQuality[idx]?.[quality];
    if (cached?.url) {
      setActiveQualityByIndex((prev) => ({ ...prev, [idx]: quality }));
      setResolvedCardByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          ...cached,
        },
      }));
      return;
    }

    await handleCardQualityResolve(video, idx, quality);
  };

  const handleCardQualityResolve = async (video: any, idx: number, quality: string) => {
    const key = `${idx}-${quality}`;
    if (cardResolvingQualityKey === key) return;
    const requestId = (qualityRequestSeq.current[idx] || 0) + 1;
    qualityRequestSeq.current[idx] = requestId;

    const isCurrentRequest = () => qualityRequestSeq.current[idx] === requestId;
    const applyResolvedQuality = (resolvedVideo: any) => {
      if (!isCurrentRequest()) return;
      setResolvedCardByQuality((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          [quality]: resolvedVideo,
        },
      }));
      setActiveQualityByIndex((prev) => ({ ...prev, [idx]: quality }));
      setUnavailableQualityByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          [quality]: false,
        },
      }));
      setQualityMessageByIndex((prev) => ({
        ...prev,
        [idx]: resolvedVideo?.fallbackMessage || resolvedVideo?.qualityFallbackMessage || '',
      }));
    };

    const keepExactPathForCard = async (item: any) => {
      const rawUrl = String(item?.url || '').trim();
      if (!rawUrl) return item;
      const mp4Url = await getDirectMp4Link(item, `${item?.title || `video-${idx}`}-${quality}`);
      return {
        ...item,
        sourceStreamUrl: item?.sourceStreamUrl || rawUrl,
        url: mp4Url,
        mp4ConvertUrl: mp4Url,
        type: 'mp4',
        qualityRequested: quality,
      };
    };

    setCardResolvingQualityKey(key);
    try {
      const cardUrl = normalizeMediaUrl(String(video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
      const watchUrl = resolveYouTubeWatchUrl(video);
      const directMeta = directAssetMetaByIndex[idx] || getDisplayVideoForIndex(video, idx);
      if (isDirectProgressiveVideoUrl(cardUrl) && !isYouTubeMediaItem(video, cardUrl)) {
        const availableQuality = getAvailableQualityKey(directMeta, idx);
        if (availableQuality && quality !== availableQuality) {
          setUnavailableQualityByIndex((prev) => ({
            ...prev,
            [idx]: {
              ...(prev[idx] || {}),
              [quality]: true,
            },
          }));
          setQualityMessageByIndex((prev) => ({
            ...prev,
            [idx]: `${quality.toUpperCase()} is unavailable. This file is ${directMeta?.displayQualityLabel || availableQuality.toUpperCase()}.`,
          }));
          return;
        }
        const resolvedDirect = {
          ...directMeta,
          url: cardUrl,
          sourceStreamUrl: cardUrl,
          qualityRequested: quality,
          displayQualityKey: availableQuality || quality,
        };
        applyResolvedQuality(resolvedDirect);
        return;
      }

      if (watchUrl || isYouTubeMediaItem(video, cardUrl)) {
        const mp4Resolved = await resolveYouTubeQualityForCard(video, quality);
        if (!isCurrentRequest()) return;
        applyResolvedQuality(mp4Resolved);
        return;
      }

      const sourceCandidates = [
        isPlatformHostedUrl(cardUrl) && !isDirectVideoAssetUrl(cardUrl) ? cardUrl : '',
        video?.sourceUrl,
        video?.pageUrl,
        video?.originalUrl,
      ]
        .map((candidate) => normalizeMediaUrl(String(candidate || ''), seedUrl))
        .filter(Boolean);
      const sourceUrl = sourceCandidates[0] || cardUrl;
      const isDirectCardUrl =
        isDirectVideoAssetUrl(cardUrl) ||
        isGoogleVideoPlaybackUrl(cardUrl) ||
        cardUrl.includes('video.xx.fbcdn.net') ||
        cardUrl.includes('vimeo.com/progressive_redirect');
      const currentResolution = String(video?.resolution || '').toLowerCase();
      const wantsHd = quality === 'hd';
      const alreadyMatching =
        (wantsHd && (currentResolution.includes('720') || currentResolution === 'hd')) ||
        (!wantsHd && (currentResolution.includes('1080') || currentResolution === 'fhd' || currentResolution === 'full hd'));

      if (sourceUrl && isPlatformHostedUrl(sourceUrl)) {
        const resolved = await resolveWithFallback(sourceUrl, quality);
        if (!isCurrentRequest()) return;
        const mp4Url = await getDirectMp4Link(resolved, `${resolved?.title || video?.title || `video-${idx}`}-${quality}`);
        const mp4Resolved = {
          ...resolved,
          sourceStreamUrl: resolved?.sourceStreamUrl || resolved?.url,
          url: mp4Url,
          mp4ConvertUrl: mp4Url,
          type: 'mp4',
          qualityRequested: quality,
        };
        applyResolvedQuality(mp4Resolved);
        return;
      }

      if (isDirectCardUrl && alreadyMatching && !isGoogleVideoPlaybackUrl(cardUrl)) {
        const exactCard = await keepExactPathForCard(video);
        applyResolvedQuality(exactCard);
        return;
      }

      if (alreadyMatching && video?.url && !isGoogleVideoPlaybackUrl(String(video?.url || ''))) {
        const exactCard = await keepExactPathForCard(video);
        applyResolvedQuality(exactCard);
        return;
      }

      if (sourceUrl && sourceUrl !== cardUrl) {
        const resolved = await resolveWithFallback(sourceUrl, quality);
        if (!isCurrentRequest()) return;
        const mp4Url = await getDirectMp4Link(resolved, `${resolved?.title || video?.title || `video-${idx}`}-${quality}`);
        const mp4Resolved = {
          ...resolved,
          sourceStreamUrl: resolved?.sourceStreamUrl || resolved?.url,
          url: mp4Url,
          mp4ConvertUrl: mp4Url,
          type: 'mp4',
          qualityRequested: quality,
        };
        applyResolvedQuality(mp4Resolved);
        return;
      }

      if (video?.url) {
        const exactCard = await keepExactPathForCard(video);
        applyResolvedQuality(exactCard);
        return;
      }

      throw new Error('No downloadable stream URL available.');
    } catch (error: any) {
      console.error('Card quality download failed:', error);
      setUnavailableQualityByIndex((prev) => ({
        ...prev,
        [idx]: {
          ...(prev[idx] || {}),
          [quality]: true,
        },
      }));
      setQualityMessageByIndex((prev) => ({
        ...prev,
        [idx]: error?.message || 'That format is unavailable; try the nearest quality.',
      }));
    } finally {
      if (isCurrentRequest()) setCardResolvingQualityKey(null);
    }
  };

  const handleAudioDownload = async (video: any, idx: number, key: string) => {
    const jobId = mediaJobSeq.current + 1;
    mediaJobSeq.current = jobId;
    const isCurrentJob = () => mediaJobSeq.current === jobId;
    if (video?.audioAvailable === false || video?.noAudio) {
      alert(video?.provider === 'x' ? 'This X.com video does not contain a separate audio stream.' : 'Audio track unavailable for this video.');
      return;
    }
    const youtubeWatchUrl = resolveYouTubeWatchUrlFromItem(video, seedUrl);
    const primaryVideoUrl = normalizeMediaUrl(String(video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
    const platformVideoUrl = primaryVideoUrl && isPlatformHostedUrl(primaryVideoUrl) && !isDirectVideoAssetUrl(primaryVideoUrl)
      ? primaryVideoUrl
      : '';
    const sourceUrl = normalizeMediaUrl(String(
      youtubeWatchUrl ||
      platformVideoUrl ||
      video?.watchUrl ||
      video?.sourceUrl ||
      video?.pageUrl ||
      video?.originalUrl ||
      video?.sourceStreamUrl ||
      video?.url ||
      ''
    ), video?.sourceUrl || video?.pageUrl || seedUrl);
    if (!sourceUrl) {
      alert('No audio-capable media URL is available for this item.');
      return;
    }

    const titleHint = video?.title || `audio-${idx}`;
    const bitrate = audioQualityMode === 'hq' ? '320k' : '128k';
    const bitrateLabel = audioQualityMode === 'hq' ? '320 kbps' : audioQualityMode === 'original' ? 'source copy' : '128 kbps';
    const filename = toAudioFilename(titleHint, audioQualityMode === 'hq' ? 'mp3' : 'm4a');
    setProcessingAudioKey(key);
    setCompletedMediaJob(null);
    setMediaProgress(null);
    setActiveMediaJob({
      key,
      mode: 'audio',
      title: audioQualityMode === 'original' ? 'Original audio extraction' : audioQualityMode === 'hq' ? 'High quality audio extraction' : 'Quick audio extraction',
      detail: audioQualityMode === 'original'
        ? 'Preserving the best source audio stream when available'
        : audioQualityMode === 'hq' ? `MP3 ${bitrateLabel} - richer export` : `Quick Audio Mode Enabled - 30 sec M4A/MP3 ${bitrateLabel}`,
    });

    try {
      const absoluteSource = toAbsoluteAppUrl(sourceUrl);
      const response = await apiFetch(`/api/convert-audio?url=${encodeURIComponent(absoluteSource)}&filename=${encodeURIComponent(filename)}&bitrate=${encodeURIComponent(bitrate)}&mode=${audioQualityMode}`);
      const data = await parseJsonSafe(response);
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || 'Failed to extract audio.');
      }

      if (!isCurrentJob()) return;
      const durationSuffix = data.durationSeconds ? ` - ${data.durationSeconds}s` : '';
      const outputLabel = data.mode === 'original' ? 'Original Audio' : data.mode === 'hq' ? 'High Quality Audio' : 'Quick Audio';
      const channelSuffix = data.channels ? ` - ${data.channels}ch` : '';
      const codecSuffix = data.codec ? ` - ${data.codec}` : '';
      setActiveMediaJob((prev) => prev ? { ...prev, mode: 'download', title: 'Preparing audio download', detail: `${outputLabel} - ${String(data.format || 'MP3').toUpperCase()} ${data.bitrate || bitrateLabel}${channelSuffix}${codecSuffix}${durationSuffix}` } : prev);
      const audioResponse = await fetch(data.url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (!audioResponse.ok) throw new Error('Audio file could not be downloaded.');
      const blob = await readResponseBlobWithProgress(audioResponse, setMediaProgress);
      if (!isCurrentJob()) return;
      saveBlob(blob, data.filename || filename);
      setCompletedMediaJob({
        title: 'Audio export complete',
        detail: `${outputLabel} ${String(data.format || 'MP3').toUpperCase()} generated at ${data.bitrate || bitrateLabel}${channelSuffix}${codecSuffix}${data.durationSeconds ? ` (${data.durationSeconds}s clip)` : ''}.`,
        size: blob.size || data.size,
        folderTarget: 'downloads',
      });
    } catch (error: any) {
      console.error('Audio extraction failed:', error);
      alert(error?.message || 'Optimizing audio stream did not finish. Please retry audio extraction.');
    } finally {
      if (isCurrentJob()) {
        setProcessingAudioKey(null);
        setMediaProgress(null);
        setActiveMediaJob(null);
      }
    }
  };

  const handleResolveManual = async (quality: string) => {
    if (!activeManualUrl) return;
    if (!isLikelyVideoUrl(activeManualUrl)) {
      setManualMessage('This URL is not a direct video platform link. Use Extract for site assets, or paste a video page URL here.');
      return;
    }
    setManualResolvingQuality(quality);
    setManualMessage('');
    try {
      const video = await resolveWithFallback(activeManualUrl, quality);
      const mp4Url = await getDirectMp4Link(video, `${video?.title || 'video'}-${quality}`);
      const mp4Video = {
        ...video,
        sourceStreamUrl: video?.sourceStreamUrl || video?.url,
        url: mp4Url,
        mp4ConvertUrl: mp4Url,
        type: 'mp4',
        isYouTubeMerged: video?.isYouTubeMerged || isApiPathOrUrl(mp4Url, '/api/youtube-merged-stream'),
        audioAvailable: video?.noAudio ? false : (video?.audioAvailable !== false),
        noAudio: video?.noAudio === true,
      };
      setManualResolvedByQuality(prev => {
        const next = { ...prev, [quality]: mp4Video };
        const count = new Set(
          Object.values(next)
            .map((item: any) => item?.url)
            .filter((u): u is string => typeof u === 'string' && u.length > 0)
        ).size;
        onManualResolvedCountChange?.(count);
        return next;
      });
    } catch (error: any) {
      console.error('Manual resolve failed:', error);
      setManualMessage(error.message || 'Unable to resolve direct download for this link.');
    } finally {
      setManualResolvingQuality(null);
    }
  };

  const getDownloadName = (video: any, idx: number) => {
    const directUrl = normalizeMediaUrl(String(video?.url || video?.sourceStreamUrl || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
    if (isDirectProgressiveVideoUrl(directUrl)) {
      return filenameFromAssetUrl(directUrl);
    }
    const title = video.title
      ? String(video.title).replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
      : `video-${idx}`;
    return `${title || `video-${idx}`}.${video.type || 'mp4'}`;
  };

  const getAvailableQualityKey = (item: any, idx: number) => {
    const meta = directAssetMetaByIndex[idx] || item;
    return String(meta?.displayQualityKey || getCleanQualityKey(meta) || '');
  };

  const isQualityAvailableForCard = (item: any, idx: number, quality: string, sourceVideo?: any) => {
    if (!['fhd', 'hd'].includes(quality)) return false;
    if (item?.unresolvable) return false;
    const base = sourceVideo || item;
    if (base?.vimeoQualityVariants) {
      return Boolean(base.vimeoQualityVariants[quality]);
    }
    const cardUrl = normalizeMediaUrl(String(item?.url || ''), item?.sourceUrl || item?.pageUrl || seedUrl);
    if (isYouTubeCardVideo(item, cardUrl)) return true;
    if (!isDirectProgressiveVideoUrl(cardUrl)) return true;
    const available = getAvailableQualityKey(item, idx);
    if (!available) return quality === 'hd';
    if (available === 'best' || available === 'fhd') return quality === 'fhd' || quality === 'hd';
    if (available === 'hd') return quality === 'hd';
    return available === quality;
  };

  const copyToClipboard = async (value: string, quality: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedQuality(quality);
      setTimeout(() => setCopiedQuality((prev) => (prev === quality ? null : prev)), 1400);
      return;
    } catch {
      try {
        const temp = document.createElement('textarea');
        temp.value = value;
        temp.setAttribute('readonly', '');
        temp.style.position = 'absolute';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        setCopiedQuality(quality);
        setTimeout(() => setCopiedQuality((prev) => (prev === quality ? null : prev)), 1400);
      } catch {
        alert('Copy failed. Please select and copy the link manually.');
      }
    }
  };

  const copyCardQualityLink = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedCardQuality(key);
      setTimeout(() => setCopiedCardQuality((prev) => (prev === key ? null : prev)), 1400);
      return;
    } catch {
      try {
        const temp = document.createElement('textarea');
        temp.value = value;
        temp.setAttribute('readonly', '');
        temp.style.position = 'absolute';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        setCopiedCardQuality(key);
        setTimeout(() => setCopiedCardQuality((prev) => (prev === key ? null : prev)), 1400);
      } catch {
        alert('Copy failed. Please select and copy the link manually.');
      }
    }
  };

  const buildCopyRowsForVideo = (item: any, titleHint: string, keyPrefix: string) => {
    const normalizedItemUrl = normalizeMediaUrl(String(item?.url || ''), item?.sourceUrl || item?.pageUrl || seedUrl);
    const normalizedSourceUrl = normalizeMediaUrl(String(item?.sourceStreamUrl || ''), item?.sourceUrl || item?.pageUrl || seedUrl);
    const localVideoPath = typeof item?.localPath === 'string' && item.localPath ? item.localPath : typeof item?.downloadPath === 'string' ? item.downloadPath : '';
    const youtubeMergedUrl = isYouTubeCardVideo(item, normalizedItemUrl)
      ? buildYouTubeMergedLink(item, titleHint, String(item?.qualityRequested || item?.displayQualityKey || 'fhd'))
      : '';
    const streamingLink = localVideoPath
      || youtubeMergedUrl
      || (normalizedSourceUrl && isMp4StreamingLink(normalizedSourceUrl) && !isApiPathOrUrl(normalizedSourceUrl, '/api/youtube-merged-stream') ? normalizedSourceUrl : '')
      || (normalizedItemUrl && isMp4StreamingLink(normalizedItemUrl) && !isApiPathOrUrl(normalizedItemUrl, '/api/youtube-merged-stream') ? normalizedItemUrl : '');
    const qualityLabel = item?.displayQualityLabel || item?.streamLabel || getCleanQualityLabel(getCleanQualityKey(item));
    const copyLabel = localVideoPath
      ? `Copy ${qualityLabel && qualityLabel !== 'Best Quality' ? `${qualityLabel} ` : ''}Downloads Path`
      : qualityLabel && qualityLabel !== 'Best Quality'
      ? `Copy ${qualityLabel} Streaming Link`
      : 'Copy Streaming Link';

    return [
      (localVideoPath || streamingLink) && {
        label: copyLabel,
        value: localVideoPath || streamingLink,
        key: `${keyPrefix}-streaming-link`,
        action: copyLabel,
      },
    ].filter(Boolean) as Array<{ label: string; value: string; key: string; action: string }>;
  };

  const getDisplayVideoForIndex = (video: any, idx: number) => {
    const cardResolved = resolvedCardByQuality[idx] || {};
    const activeQualityForCard =
      activeQualityByIndex[idx] ||
      video?.defaultQualityKey ||
      (isYouTubeCardVideo(video) ? 'fhd' : '') ||
      '';
    const baseCardVideo = resolvedCardByIndex[idx] ? { ...video, ...resolvedCardByIndex[idx] } : video;
    return activeQualityForCard && cardResolved[activeQualityForCard]
      ? { ...baseCardVideo, ...cardResolved[activeQualityForCard] }
      : baseCardVideo;
  };

  const getVisibleStreamingRows = () =>
    safeVideos
      .map((video, idx) => {
        const displayVideo = getDisplayVideoForIndex(video, idx);
        const rows = buildCopyRowsForVideo(displayVideo, displayVideo?.title || `video-${idx}`, `bulk-${idx}`);
        return rows[0]?.value
          ? {
              url: rows[0].value,
              title: displayVideo?.title || `Video ${idx + 1}`,
              filename: toMp4Filename(displayVideo?.title || `video-${idx + 1}`),
            }
          : null;
      })
      .filter(Boolean) as Array<{ url: string; title: string; filename: string }>;

  const resolveAllStreamingRows = async () => {
    const existing = getVisibleStreamingRows();
    const existingUrls = new Set(existing.map((row) => row.url));
    const unresolved = safeVideos
      .map((video, idx) => ({ video: getDisplayVideoForIndex(video, idx), idx }))
      .filter(({ video }) => {
        const rows = buildCopyRowsForVideo(video, video?.title || 'video', `bulk-check-${video?.url || ''}`);
        return !rows[0]?.value;
      });

    if (unresolved.length === 0) return existing;
    setActiveMediaJob({
      key: 'bulk-stream-resolve',
      mode: 'download',
      title: 'Resolving playlist streams',
      detail: `Preparing ${unresolved.length} HD/FHD links`,
    });

    const resolvedRows: Array<{ url: string; title: string; filename: string }> = [];
    for (let start = 0; start < unresolved.length; start += 3) {
      const batch = unresolved.slice(start, start + 3);
      setActiveMediaJob((prev) => prev ? { ...prev, detail: `Resolving ${Math.min(start + batch.length, unresolved.length)}/${unresolved.length}` } : prev);
      const results = await Promise.all(batch.map(async ({ video, idx }) => {
        const primaryVideoUrl = normalizeMediaUrl(String(video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
        const platformVideoUrl = primaryVideoUrl && isPlatformHostedUrl(primaryVideoUrl) && !isDirectVideoAssetUrl(primaryVideoUrl)
          ? primaryVideoUrl
          : '';
        const sourceUrl = normalizeMediaUrl(String(platformVideoUrl || video?.sourceUrl || video?.pageUrl || video?.originalUrl || video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
        if (!sourceUrl) return null;
        const resolved =
          await resolveWithFallback(sourceUrl, 'fhd').catch(() => resolveWithFallback(sourceUrl, 'hd')).catch(() => null);
        if (!resolved?.url) return null;
        const mp4Url = await getDirectMp4Link(resolved, `${resolved?.title || video?.title || `video-${idx + 1}`}-stream`).catch(() => '');
        if (!mp4Url || existingUrls.has(mp4Url)) return null;
        existingUrls.add(mp4Url);
        return {
          url: mp4Url,
          title: resolved?.title || video?.title || `Video ${idx + 1}`,
          filename: toMp4Filename(resolved?.title || video?.title || `video-${idx + 1}`),
        };
      }));
      resolvedRows.push(...results.filter(Boolean) as Array<{ url: string; title: string; filename: string }>);
    }

    setActiveMediaJob(null);
    return [...existing, ...resolvedRows];
  };

  const copyAllStreamingLinks = async () => {
    const rows = await resolveAllStreamingRows();
    if (rows.length === 0) {
      alert('No direct HD/FHD streaming links could be resolved for this set.');
      return;
    }
    await navigator.clipboard.writeText(rows.map((row) => row.url).join('\n'));
    setCopiedCardQuality('bulk-streaming-links');
    window.setTimeout(() => setCopiedCardQuality(null), 1400);
  };

  const downloadAllVisibleStreams = async () => {
    const rows = await resolveAllStreamingRows();
    if (rows.length === 0) {
      alert('No direct HD/FHD streaming links could be resolved for this set.');
      return;
    }
    const response = await apiFetch('/api/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: rows.map((row) => row.url) }),
    });
    if (!response.ok) {
      alert('Download All could not package these streams yet.');
      return;
    }
    const blob = await readResponseBlobWithProgress(response, setMediaProgress);
    saveBlob(blob, 'playlist-streams.zip');
    setCompletedMediaJob({
      title: 'Playlist download ready',
      detail: `${rows.length} streaming links were bundled.`,
      size: blob.size,
      folderTarget: 'downloads',
    });
  };

  const extractAllVisibleAudio = async () => {
    const rows = safeVideos.slice(0, 24).map((video, idx) => getDisplayVideoForIndex(video, idx));
    if (rows.length === 0) return;
    setActiveMediaJob({
      key: 'bulk-audio',
      mode: 'audio',
      title: 'Extracting playlist audio',
      detail: 'Quick Audio 60 sec clips',
    });
    setMediaProgress(null);
    try {
      for (let idx = 0; idx < rows.length; idx += 1) {
        const video = rows[idx];
        if (video?.audioAvailable === false || video?.noAudio) continue;
        const primaryVideoUrl = normalizeMediaUrl(String(video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
        const platformVideoUrl = primaryVideoUrl && isPlatformHostedUrl(primaryVideoUrl) && !isDirectVideoAssetUrl(primaryVideoUrl)
          ? primaryVideoUrl
          : '';
        const sourceUrl = normalizeMediaUrl(String(platformVideoUrl || video?.sourceUrl || video?.pageUrl || video?.originalUrl || video?.sourceStreamUrl || video?.url || ''), video?.sourceUrl || video?.pageUrl || seedUrl);
        if (!sourceUrl) continue;
        setActiveMediaJob((prev) => prev ? { ...prev, detail: `Quick Audio ${idx + 1}/${rows.length}` } : prev);
        const filename = toAudioFilename(video?.title || `playlist-audio-${idx + 1}`, 'm4a');
        const response = await apiFetch(`/api/convert-audio?url=${encodeURIComponent(toAbsoluteAppUrl(sourceUrl))}&filename=${encodeURIComponent(filename)}&bitrate=128k&mode=turbo`);
        const data = await parseJsonSafe(response);
        if (!response.ok || !data?.url) continue;
        const audioResponse = await fetch(data.url, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        });
        if (!audioResponse.ok) continue;
        const blob = await audioResponse.blob();
        saveBlob(blob, data.filename || filename);
      }
      setCompletedMediaJob({
        title: 'Playlist audio complete',
        detail: 'Quick audio clips were generated for available tracks.',
        folderTarget: 'downloads',
      });
    } finally {
      setActiveMediaJob(null);
      setMediaProgress(null);
    }
  };

  const normalizeComparableUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      parsed.hash = '';
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.protocol}//${host}${path}${parsed.search}`.toLowerCase();
    } catch {
      return String(value || '').trim().toLowerCase();
    }
  };

  const sameSeedTarget = normalizeComparableUrl(activeManualUrl) === normalizeComparableUrl(seedUrl);
  const showManualPanel = !!activeManualUrl && !(safeVideos.length > 0 && sameSeedTarget);
  const activeMediaMessages =
    activeMediaJob?.mode === 'audio'
      ? audioMessages
      : activeMediaJob?.mode === 'convert'
        ? conversionMessages
        : downloadMessages;
  const renderManualQualityResult = (qualityKey: 'hd' | 'fhd', label: string) => {
    const item = manualResolvedByQuality[qualityKey];
    if (!item?.url) return null;

    const titleHint = `${item.title || 'video'}-${qualityKey}`;
    const rows = buildCopyRowsForVideo(item, titleHint, `manual-${qualityKey}`);
    const audioUnavailable = item.audioAvailable === false || item.noAudio;
    const durationLabel = formatDuration(item.duration || item.durationSeconds || item.lengthSeconds);
    const filesizeLabel = formatBytes(item.filesize);
    const isVerified = Boolean(
      item.verifiedPlayable ||
      item.isLocalMerged ||
      item.isYouTubeMerged ||
      isApiPathOrUrl(String(item.url || ''), '/api/download') ||
      isApiPathOrUrl(String(item.url || ''), '/api/youtube-merged-stream') ||
      String(item.url || '').includes('/converted-videos/')
    );

    return (
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-md font-semibold">{label}</span>
          {durationLabel && (
            <span className="text-xs bg-zinc-100 text-zinc-700 px-2 py-1 rounded-md font-medium">{durationLabel}</span>
          )}
          {filesizeLabel && (
            <span className="text-xs bg-orange-50 text-orange-600 px-2 py-1 rounded-md font-medium">{filesizeLabel}</span>
          )}
          {isVerified && (
            <span className="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-md font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Verified Playable
            </span>
          )}
          {audioUnavailable && (
            <span className="text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-md font-medium">No audio</span>
          )}
        </div>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key}>
              <p className="text-xs font-semibold text-zinc-700 mb-1">{row.label}</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input readOnly value={row.value} className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 rounded bg-zinc-50 min-w-0" />
                <button type="button" onClick={() => copyToClipboard(row.value, row.key)} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded whitespace-nowrap">
                  {copiedQuality === row.key ? 'Copied' : row.action}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleDownload(item.mp4ConvertUrl || item.url, toMp4Filename(titleHint))}
            disabled={downloading === (item.mp4ConvertUrl || item.url)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded disabled:opacity-60"
          >
            <Download className="w-3 h-3" />
            {downloading === item.url ? 'Downloading...' : `Download ${label}`}
          </button>
          <button
            type="button"
            onClick={() => handleAudioDownload(item, 0, `manual-${qualityKey}-audio`)}
            disabled={processingAudioKey === `manual-${qualityKey}-audio` || audioUnavailable}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-zinc-900 text-white rounded disabled:opacity-60"
          >
            <Music className="w-3 h-3" />
            {audioUnavailable ? 'Audio unavailable' : processingAudioKey === `manual-${qualityKey}-audio` ? 'Extracting audio...' : getAudioActionLabel()}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* Manual Video Downloader Section */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center">
            <Search className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">Search & Download Any Video</h3>
            <p className="text-sm text-zinc-500">Paste a link from YouTube, Vimeo, TikTok, X.com, Facebook, Instagram, and more</p>
          </div>
        </div>
        
        <form onSubmit={handleManualSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Globe className="w-5 h-5 text-zinc-400" />
            </div>
            <input
              type="url"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="block w-full pl-10 pr-3 py-3 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm bg-zinc-50"
              required
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
        </form>

        {showManualPanel && (
          <div className="mt-6 bg-zinc-50 p-6 border border-zinc-100 rounded-xl animate-in fade-in slide-in-from-top-4 duration-300">
            <h4 className="text-sm font-medium text-zinc-700 mb-4 flex items-center gap-2">
              <Download className="w-4 h-4" />
              Download Options for {(() => {
                try { return new URL(activeManualUrl).hostname.replace('www.', ''); }
                catch { return 'this link'; }
              })()}
            </h4>
            <div className="mb-4">
              <p className="text-xs text-zinc-500 mb-2">Direct extractor (YouTube, Vimeo, TikTok, X.com, Facebook, Instagram, and more supported by source site availability):</p>
              <div className="flex flex-wrap gap-2">
                {qualityTierOptions.map((quality) => (
                  <button
                    key={`manual-${quality.key}`}
                    onClick={() => handleResolveManual(quality.key)}
                    disabled={manualResolvingQuality === quality.key}
                    className="inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
                  >
                    <Download className="w-4 h-4" />
                    {manualResolvingQuality === quality.key ? 'Resolving...' : quality.label}
                  </button>
                ))}
              </div>
              {manualMessage ? (
                <p className="mt-3 text-xs text-amber-700">{manualMessage}</p>
              ) : null}
              {(manualResolvedByQuality.hd?.url || manualResolvedByQuality.fhd?.url) && (
                <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-3">
                  <div className="space-y-3">
                    {renderManualQualityResult('hd', 'HD')}
                    {renderManualQualityResult('fhd', 'FHD')}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-950">
            {audioQualityMode === 'original' ? 'Original Audio Mode Enabled' : audioQualityMode === 'turbo' ? 'Quick Audio Mode Enabled' : 'High Quality Audio Enabled'}
          </p>
          <p className="text-xs text-emerald-700">
            {audioQualityMode === 'original'
              ? 'Copies the best source audio stream, preserving Dolby or multichannel tracks when the source exposes them.'
              : audioQualityMode === 'turbo' ? '60 sec M4A/MP3 128 kbps - optimized for long-video speed.' : 'Full MP3 320 kbps - slower, richer audio export.'}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setAudioQualityMode('turbo')}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${audioQualityMode === 'turbo' ? 'bg-emerald-600 text-white' : 'text-zinc-600 hover:bg-zinc-50'}`}
          >
            Quick Audio
          </button>
          <button
            type="button"
            onClick={() => setAudioQualityMode('hq')}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${audioQualityMode === 'hq' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-50'}`}
          >
            HQ Audio
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <SmartProgressPanel
          active={!!activeMediaJob}
          mode={activeMediaJob?.mode || 'download'}
          title={activeMediaJob?.title || 'Preparing media'}
          detail={activeMediaJob?.detail}
          messages={activeMediaMessages}
          progress={mediaProgress?.percent}
          loadedBytes={mediaProgress?.loaded}
          totalBytes={mediaProgress?.total}
          speedBps={mediaProgress?.speedBps}
          etaSeconds={mediaProgress?.etaSeconds}
        />
        {completedMediaJob && !activeMediaJob ? (
          <CompletionCard
            title={completedMediaJob.title}
            detail={completedMediaJob.detail}
            size={completedMediaJob.size}
            onOpenFolder={completedMediaJob.folderTarget ? () => openFolder(completedMediaJob.folderTarget) : undefined}
          />
        ) : null}
      </div>

      {safeVideos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-500 bg-white border border-zinc-200 rounded-2xl border-dashed">
          <VideoIcon className="w-12 h-12 mb-4 text-zinc-300" />
          <p className="text-lg font-medium text-zinc-900">{loadingInsights ? 'Crawling website videos...' : 'No videos extracted from page'}</p>
          <p className="text-sm text-center max-w-md mt-1">
            {loadingInsights ? 'Analyzing tabs and internal pages to fetch embedded and hero videos.' : "We couldn't detect any direct video links on the extracted page. Use the search bar above to download videos manually."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {safeVideos.length > 1 && safeVideos[0]?.playlistTitle ? (
            <p className="text-sm font-semibold text-zinc-900">{safeVideos[0].playlistTitle}</p>
          ) : null}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {safeVideos.map((video, idx) => {
            const activeQualityForCard = activeQualityByIndex[idx] || video?.defaultQualityKey || '';
            const cardVideo = getDisplayVideoForIndex(video, idx);
            const isVimeoUrl = /vimeo\.com|player\.vimeo\.com/i.test(String(video.url || ''));
            const isVimeoPlaceholder = video.isVimeo && !video.isVimeoDirect && isVimeoUrl;

            const isDirectFile = isDirectVideoAssetUrl(String(cardVideo.url || ''));
            const isDirectResolved = Boolean(cardVideo.isVimeoDirect || cardVideo.isYouTubeDirect || cardVideo.isDirect);
            const needsQualityResolve = !isDirectFile && !isDirectResolved;

            if (!needsQualityResolve && !isDirectFile && !isDirectResolved) {
              return null;
            }

            const filename = cardVideo.url.split('/').pop()?.split('?')[0] || `video-${idx}.${cardVideo.type}`;
            const isYouTubeDirect = cardVideo.isYouTubeDirect;
            const isVimeoDirect = cardVideo.isVimeoDirect;
            const displayTitle = cardVideo.title || (isYouTubeDirect ? `YouTube Video Stream (${cardVideo.resolution || 'Unknown'})` : filename);
            const normalizedCardUrl = normalizeMediaUrl(String(cardVideo.url || ''), cardVideo.sourceUrl || cardVideo.pageUrl || seedUrl);
            const mp4VideoPath = isMp4StreamingLink(normalizedCardUrl) ? normalizedCardUrl : '';
            const exactVideoPath = mp4VideoPath;
            const exactFormat = getVideoFormat(cardVideo);
            const formatBadgeClass = exactFormat === 'mp4'
              ? 'bg-blue-50 text-blue-600'
              : 'bg-amber-50 text-amber-700';
            const activeQuality = activeQualityForCard || (isYouTubeCardVideo(cardVideo, normalizedCardUrl) ? 'fhd' : '') || String(cardVideo.qualityRequested || video.qualityRequested || '');
            const unavailableQuality = unavailableQualityByIndex[idx] || {};
            const qualityStatusMessage = qualityMessageByIndex[idx] || String(cardVideo.fallbackMessage || cardVideo.qualityFallbackMessage || '');
            const cleanLabel = cardVideo.displayQualityLabel || cardVideo.streamLabel || getCleanQualityLabel(getCleanQualityKey(cardVideo));
            const normalizedSourceUrl = normalizeMediaUrl(String(cardVideo.sourceStreamUrl || ''), cardVideo.sourceUrl || cardVideo.pageUrl || seedUrl);
            const isYouTubeCard = isYouTubeCardVideo(cardVideo, normalizedCardUrl);
            const videoOnlyGoogle =
              isGoogleVideoPlaybackUrl(normalizedCardUrl) ||
              (isGoogleVideoPlaybackUrl(normalizedSourceUrl) && !cardVideo.isYouTubeMerged);
            const audioUnavailable = !isYouTubeCard && (cardVideo.audioAvailable === false || cardVideo.noAudio === true);
            const durationLabel = formatDuration(cardVideo.duration || cardVideo.durationSeconds || cardVideo.lengthSeconds);
            const filesizeLabel = formatBytes(cardVideo.filesize);
            const verifiedPlayable = Boolean(
              cardVideo.verifiedPlayable ||
              cardVideo.isLocalMerged ||
              (exactVideoPath && (
                isApiPathOrUrl(exactVideoPath, '/api/download') ||
                exactVideoPath.includes('/converted-videos/') ||
                /googlevideo\.com\/videoplayback|\/videoplayback\?/i.test(exactVideoPath)
              ))
            );
            const copyRows = buildCopyRowsForVideo(cardVideo, displayTitle, `${idx}`);
            const previewVideoUrl =
              videoOnlyGoogle || (isYouTubeCard && !cardVideo.isYouTubeMerged)
                ? ''
                : copyRows[0]?.value && isMp4StreamingLink(copyRows[0].value)
                ? copyRows[0].value
                : exactVideoPath;
            const hasThumbnail = Boolean(String(cardVideo.thumbnail || '').trim());
            const preferImagePreview = hasThumbnail && (
              videoOnlyGoogle ||
              isYouTubeCard ||
              isYouTubeDirect ||
              String(cardVideo.provider || '').toLowerCase().includes('youtube') ||
              String(cardVideo.acodec || cardVideo.audioCodec || '').toLowerCase() === 'none'
            );
            const preparedVimeo = isPreparedVimeoCard(video);
            const renderQualityButtons = () => (
              <div className="grid grid-cols-2 gap-2">
                {qualityTierOptions.map((quality) => {
                  const qualityKey = `${idx}-${quality.key}`;
                  const isBusy = !preparedVimeo && cardResolvingQualityKey === qualityKey;
                  const isUnavailable =
                    Boolean(unavailableQuality[quality.key]) ||
                    !isQualityAvailableForCard(cardVideo, idx, quality.key, video);
                  const isActive = activeQuality === quality.key;
                  const buttonClass = isUnavailable
                    ? 'bg-zinc-200 text-zinc-500 cursor-not-allowed'
                    : isActive
                      ? 'bg-emerald-600 text-white hover:bg-emerald-700 ring-2 ring-emerald-200'
                      : 'bg-blue-600 text-white hover:bg-blue-700';
                  return (
                    <button
                      key={qualityKey}
                      type="button"
                      onClick={() => handleCardQualitySwitch(video, idx, quality.key)}
                      disabled={isBusy || isUnavailable}
                      aria-pressed={isActive}
                      title={isUnavailable ? `${quality.label} is unavailable for this source` : `${quality.label} ${quality.detail}`}
                      className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition ${buttonClass} disabled:opacity-70`}
                    >
                      {isBusy ? 'Resolving...' : isUnavailable ? 'Unavailable' : isActive ? `${quality.label} Active` : quality.label}
                    </button>
                  );
                })}
              </div>
            );
            
            return (
              <div key={idx} className="media-card-enter bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col">
                <div className="h-44 sm:h-52 md:h-56 bg-zinc-900 relative group">
                  {preferImagePreview ? (
                    <img src={cardVideo.thumbnail} alt="" className="w-full h-full object-cover object-center" loading="lazy" referrerPolicy="no-referrer" />
                  ) : previewVideoUrl ? (
                    <video
                      src={previewVideoUrl}
                      poster={cardVideo.thumbnail || undefined}
                      className="w-full h-full object-cover object-center"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : hasThumbnail ? (
                    <img src={cardVideo.thumbnail} alt="" className="w-full h-full object-cover object-center" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="thumb-shimmer w-full h-full flex items-center justify-center">
                      <div className="text-center px-4">
                        <VideoIcon className="w-10 h-10 text-zinc-400 mx-auto mb-2" />
                        <p className="text-xs text-zinc-500">Preview unavailable, generating fallback thumbnail...</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="px-5 py-2 border-b border-zinc-100 bg-white">
                  <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${formatBadgeClass}`}>
                    {cleanLabel}
                  </span>
                </div>
                <div className="p-5 flex-1 flex flex-col justify-between">
                  <div className="mb-4">
                    <h3 className="font-semibold text-zinc-900 truncate" title={displayTitle}>
                      {displayTitle}
                    </h3>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {cardVideo.provider && (
                        <span className="text-xs bg-zinc-100 text-zinc-600 px-2 py-1 rounded-md uppercase tracking-wider font-medium">
                          {cardVideo.provider}
                        </span>
                      )}
                      {cardVideo.resolution && cardVideo.resolution !== 'audio only' && cardVideo.resolution !== 'Unknown' && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-md font-medium">
                          {cleanLabel}
                        </span>
                      )}
                      <span className="text-xs bg-zinc-100 text-zinc-600 px-2 py-1 rounded-md font-medium uppercase">
                        {exactFormat}
                      </span>
                      {cardVideo.fps && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-md font-medium">
                          {cardVideo.fps}fps
                        </span>
                      )}
                      {durationLabel && (
                        <span className="text-xs bg-zinc-100 text-zinc-700 px-2 py-1 rounded-md font-medium">
                          {durationLabel}
                        </span>
                      )}
                      {filesizeLabel && (
                        <span className="text-xs bg-orange-50 text-orange-600 px-2 py-1 rounded-md font-medium">
                          {filesizeLabel}
                        </span>
                      )}
                      {verifiedPlayable && (
                        <span className="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-md font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Verified Playable
                        </span>
                      )}
                      {audioUnavailable && (
                        <span className="text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-md font-medium">
                          No audio
                        </span>
                      )}
                    </div>
                  </div>
                  {renderQualityButtons()}
                  {needsQualityResolve && qualityStatusMessage && (
                    <p className="mt-2 text-xs text-amber-700">
                      {qualityStatusMessage}
                    </p>
                  )}
                  {isYouTubeCard && (
                    <p className="mt-2 text-xs text-emerald-700">
                      FHD and HD downloads merge video + audio automatically.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => handleAudioDownload(cardVideo, idx, `${idx}-audio`)}
                    disabled={processingAudioKey === `${idx}-audio` || audioUnavailable}
                    className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-60"
                  >
                    <Music className="w-4 h-4" />
                    {audioUnavailable ? 'Audio track unavailable' : processingAudioKey === `${idx}-audio` ? 'Extracting audio...' : getAudioActionLabel()}
                  </button>
                  {audioUnavailable && (
                    <p className="mt-2 text-xs text-amber-700">
                      {String(cardVideo.provider || '').toLowerCase() === 'x' ? 'This X.com video does not contain a separate audio stream.' : 'Audio track unavailable for this video.'}
                    </p>
                  )}
                  {copyRows.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {copyRows.map((row) => (
                        <div key={row.key}>
                          <p className="text-xs font-semibold text-zinc-700 mb-1">{row.label}</p>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <input
                              readOnly
                              value={row.value}
                              className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 rounded bg-zinc-50 min-w-0"
                            />
                            <button
                              type="button"
                              onClick={() => copyCardQualityLink(row.value, row.key)}
                              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded whitespace-nowrap"
                            >
                              {copiedCardQuality === row.key ? 'Copied' : row.action}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
