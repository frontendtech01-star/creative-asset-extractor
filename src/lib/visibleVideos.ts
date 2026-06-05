import { isExpiredStreamUrl, sanitizeStreamUrl } from './streamUrl';

export const normalizeYouTubeWatchUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      const embedMatch = parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (embedMatch?.[1]) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};

export const isYouTubeWatchUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  } catch {
    return /youtube\.com|youtu\.be/i.test(String(rawUrl || ''));
  }
};

export const isGoogleVideoPlaybackUrl = (rawUrl: string) =>
  /googlevideo\.com\/videoplayback|\/videoplayback\?/i.test(String(rawUrl || ''));

export const extractYouTubeVideoIdFromThumbnail = (thumbnail?: string) => {
  const match = String(thumbnail || '').match(
    /(?:i\.ytimg\.com|yt3(?:\.ggpht)?(?:\.com)?(?:\/googleusercontent)?)\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})(?:\/|[?#]|$)/i
  );
  return match?.[1] || '';
};

export const resolveYouTubeWatchUrlFromItem = (item: any, seedUrl = '') => {
  const candidates = [
    item?.watchUrl,
    item?.youtubeWatchUrl,
    item?.sourceUrl,
    item?.pageUrl,
    item?.originalUrl,
    item?.url,
    seedUrl,
  ]
    .map((candidate) => normalizeMediaUrl(String(candidate || ''), seedUrl))
    .filter(Boolean);
  const fromUrl = candidates.find((candidate) => isYouTubeWatchUrl(candidate));
  if (fromUrl) return normalizeYouTubeWatchUrl(fromUrl);

  const fromThumb = extractYouTubeVideoIdFromThumbnail(item?.thumbnail);
  if (fromThumb) return `https://www.youtube.com/watch?v=${fromThumb}`;

  return '';
};

export const isPlatformHostedUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return (
      host.includes('youtube.com') ||
      host === 'youtu.be' ||
      host.includes('vimeo.com') ||
      host.includes('wistia.com') ||
      host.includes('wistia.net') ||
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

export const normalizeMediaUrl = (rawUrl: string, baseUrl?: string) => {
  const value = String(rawUrl || '').trim();
  const appBase = typeof window !== 'undefined' ? window.location.origin : undefined;
  const usesAppBase = /^\/(?:api|converted-videos|converted-audio|cached-images|cached-fonts)\//i.test(value);
  const fallbackBase = usesAppBase ? appBase : (baseUrl || appBase);
  const normalized = sanitizeStreamUrl(value, fallbackBase);
  if (!normalized || isExpiredStreamUrl(normalized)) return '';
  return isYouTubeWatchUrl(normalized) ? normalizeYouTubeWatchUrl(normalized) : normalized;
};

export const toCanonicalVideoKey = (item: any, seedUrl = '') => {
  const rawUrl = normalizeMediaUrl(
    String(item?.url || item?.sourceStreamUrl || item?.originalUrl || item?.pageUrl || item?.sourceUrl || '').trim(),
    item?.sourceUrl || item?.pageUrl || seedUrl
  );
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('vimeo.com')) {
      const idMatch =
        parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/) ||
        parsed.pathname.match(/\/video\/(\d+)/) ||
        parsed.pathname.match(/\/videos\/(\d+)/) ||
        parsed.pathname.match(/\/(\d+)/);
      if (idMatch?.[1]) return `vimeo:${idMatch[1]}`;
      if (item?.vimeoId) return `vimeo:${item.vimeoId}`;
      return `vimeo:${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
    }
    if (host.includes('wistia.com') || host.includes('wistia.net')) {
      if (item?.wistiaHashedId) return `wistia:${item.wistiaHashedId}:${item?.height || item?.displayQualityKey || 'stream'}`;
      const idMatch = parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
      if (idMatch?.[1]) return `wistia:${idMatch[1]}:${item?.height || item?.displayQualityKey || 'stream'}`;
      if (parsed.pathname.includes('/deliveries/')) {
        return `wistia-delivery:${parsed.pathname.split('/deliveries/')[1]?.split(/[/?#]/)[0] || parsed.pathname}:${item?.height || 'stream'}`;
      }
    }
    if (
      host.includes('youtube.com') ||
      host === 'youtu.be' ||
      host === 'x.com' ||
      host.includes('twitter.com') ||
      host.includes('facebook.com') ||
      host === 'fb.watch' ||
      host.includes('instagram.com') ||
      host.includes('tiktok.com') ||
      host.includes('brightcove.net')
    ) {
      parsed.hash = '';
      if (host.includes('brightcove.net')) {
        return `${host}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}:${parsed.searchParams.get('videoId') || parsed.searchParams.get('playlistId') || ''}:${item?.height || item?.displayQualityKey || item?.qualityRequested || 'stream'}`;
      }
      return `${host}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
    }
    parsed.hash = '';
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

export const isDirectVideoAssetUrl = (rawUrl: string) =>
  /\/api\/(?:youtube-merged-stream|download|download-local-video)(?:\?|$)/i.test(String(rawUrl || '')) ||
  /\/converted-videos\//i.test(String(rawUrl || '')) ||
  /\.(mp4|webm|mov|mkv|m4v|m3u8|mpd)(\?|$)/i.test(String(rawUrl || '')) ||
  /wistia\.com\/deliveries\//i.test(String(rawUrl || '')) ||
  /vimeo\.com\/progressive_redirect|vimeocdn\.com|vod-adaptive\.akamaized\.net/i.test(String(rawUrl || ''));

export const isDirectProgressiveVideoUrl = (rawUrl: string) =>
  /\/api\/(?:youtube-merged-stream|download|download-local-video)(?:\?|$)/i.test(String(rawUrl || '')) ||
  /\/converted-videos\//i.test(String(rawUrl || '')) ||
  /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(rawUrl || ''));

export const filenameFromAssetUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'video.mp4');
    return name.replace(/[\\/:*?"<>|]/g, '_') || 'video.mp4';
  } catch {
    return 'video.mp4';
  }
};

export const isFalseVimeoUtilityUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host !== 'vimeo.com' && host !== 'player.vimeo.com' && !host.endsWith('.vimeo.com')) return false;
    if (/\.(ico|js|css|json)(\?|$)/i.test(path)) return true;
    return /^\/(?:api|add|ablincoln|favicon)\b/.test(path);
  } catch {
    return /vimeo\.com\/(?:api\/|add\/|ablincoln\/|favicon)|player\.js/i.test(String(rawUrl || ''));
  }
};

export const videoPriority = (item: any) => {
  const url = String(item?.url || '');
  if (item?.isVimeoDirect || item?.isYouTubeDirect || item?.isWistiaDirect || item?.isDirect) return 4;
  if (isDirectVideoAssetUrl(url) || url.includes('googlevideo.com/videoplayback') || url.includes('vimeo.com/progressive_redirect')) return 3;
  if (isPlatformHostedUrl(url) && !isFalseVimeoUtilityUrl(url)) return 2;
  return 1;
};

export const streamHasAudio = (item: any) => {
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

export const getStreamHeight = (item: any) => {
  const direct = Number(item?.height);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = `${item?.resolution || ''} ${item?.formatNote || ''} ${item?.format || ''}`.toLowerCase();
  const match = text.match(/(\d{3,4})p/);
  return match?.[1] ? Number(match[1]) : undefined;
};

export const getCleanQualityKey = (item: any) => {
  const videoCodec = String(item?.vcodec || item?.videoCodec || '').toLowerCase();
  if (videoCodec === 'none') return 'audio';
  const height = getStreamHeight(item);
  if (!height || height <= 0) return 'best';
  if (height >= 2160) return '4k';
  if (height >= 1440) return '2k';
  if (height >= 1080) return 'fhd';
  if (height >= 720) return 'hd';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return 'best';
};

export const getCleanQualityLabel = (key: string) => {
  if (key === '4k') return '4K';
  if (key === '2k') return '2K';
  if (key === 'fhd') return 'FHD';
  if (key === 'hd') return 'HD';
  if (key === '480p') return 'SD';
  if (key === '360p') return '360p';
  if (key === 'audio') return 'Audio Only';
  return 'Best Quality';
};

export const qualityTierOptions = [
  { key: 'fhd', label: 'FHD', detail: '1080p with audio' },
  { key: 'hd', label: 'HD', detail: '720p with audio' },
] as const;

export const isTechnicalStream = (item: any) => {
  const value = `${item?.url || ''} ${item?.type || ''} ${item?.formatNote || ''} ${item?.format || ''}`.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif|js|css|json)(\?|$)/i.test(value)) return true;
  return /storyboard|thumbnail|sprite|dash fragment|fragmented|metadata|manifest|m3u8|mpd|\.m3u8|\.mpd/.test(value);
};

export const streamRank = (item: any) => {
  const url = String(item?.url || '');
  const lowered = url.toLowerCase();
  const mp4Score = /\.mp4(\?|$)/i.test(lowered) || /\/api\/youtube-merged-stream|\/api\/download|\/api\/download-local-video|\/converted-videos\/|googlevideo\.com\/videoplayback|vimeo\.com\/progressive_redirect|wistia\.com\/deliveries\//i.test(lowered) ? 10000 : 0;
  const audioScore = streamHasAudio(item) ? 4000 : 0;
  const directScore = item?.isDirect || item?.isVimeoDirect || item?.isWistiaDirect || item?.isYouTubeDirect || isDirectVideoAssetUrl(url) ? 1000 : 0;
  const sizeScore = Math.min(900, Number(item?.filesize || item?.filesize_approx || 0) / 100000);
  return mp4Score + audioScore + directScore + sizeScore;
};

const unwrapProxyMediaUrl = (rawUrl: string, baseUrl?: string) => {
  const normalized = normalizeMediaUrl(rawUrl, baseUrl);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    if (/\/api\/download$/i.test(parsed.pathname)) {
      const nested = parsed.searchParams.get('url');
      if (nested) {
        const nestedNormalized = normalizeMediaUrl(nested, baseUrl);
        if (nestedNormalized) return nestedNormalized;
      }
    }
  } catch {
    // Fall back to the normalized candidate URL.
  }
  return normalized;
};

export const sourceIdentityForStream = (item: any, seedUrl = '') => {
  const baseUrl = item?.sourceUrl || item?.pageUrl || seedUrl;
  const candidateRaw = String(item?.url || '');
  const underlyingUrl = unwrapProxyMediaUrl(candidateRaw, baseUrl) || candidateRaw;

  if (item?.wistiaHashedId) return `wistia:${item.wistiaHashedId}`;

  if (item?.vimeoId) return `vimeo:${item.vimeoId}`;

  if (
    item?.isVimeoDirect ||
    item?.isYouTubeDirect ||
    item?.isWistiaDirect ||
    item?.isDirect ||
    isDirectVideoAssetUrl(underlyingUrl)
  ) {
    try {
      const parsed = new URL(underlyingUrl);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (host.includes('vimeo.com')) {
        const match =
          parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/) ||
          parsed.pathname.match(/\/video\/(\d+)/) ||
          parsed.pathname.match(/\/videos\/(\d+)/) ||
          parsed.pathname.match(/\/(\d+)/);
        if (match?.[1]) return `vimeo:${match[1]}`;
      }
      if (host.includes('wistia.com') || host.includes('wistia.net')) {
        const match = parsed.pathname.match(/\/deliveries\/([^/?#]+)/i);
        if (match?.[1]) return `wistia-delivery:${match[1]}`;
      }
      parsed.search = '';
      parsed.hash = '';
      return `${host}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
    } catch {
      return underlyingUrl;
    }
  }

  const sourceRaw = String(item?.sourceUrl || item?.pageUrl || item?.originalUrl || seedUrl || '');
  const raw = sourceRaw && isPlatformHostedUrl(sourceRaw) ? sourceRaw : (candidateRaw || sourceRaw);
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (item?.wistiaHashedId) return `wistia:${item.wistiaHashedId}`;
    if (host.includes('wistia.com') || host.includes('wistia.net')) {
      const match = parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
      if (match?.[1]) return `wistia:${match[1]}`;
    }
    if (host.includes('vimeo.com')) {
      const match = parsed.pathname.match(/\/(?:video\/)?(\d+)/) || parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/);
      return `vimeo:${match?.[1] || parsed.pathname.replace(/\/+$/, '')}`;
    }
    if (host === 'x.com' || host.includes('twitter.com')) {
      const match = parsed.pathname.match(/\/status(?:es)?\/(\d+)/);
      return `x:${match?.[1] || parsed.pathname}`;
    }
    if (host.includes('facebook.com') || host === 'fb.watch') return `facebook:${parsed.pathname.replace(/\/+$/, '')}`;
    if (host.includes('youtube.com') || host === 'youtu.be') return `youtube:${parsed.searchParams.get('v') || parsed.pathname}`;
    if (host.includes('brightcove.net')) return `brightcove:${parsed.pathname}:${parsed.searchParams.get('videoId') || parsed.searchParams.get('playlistId') || ''}`;
    parsed.search = '';
    parsed.hash = '';
    return `${host}${parsed.pathname}`;
  } catch {
    return raw;
  }
};

export const normalizeVisibleStreams = (items: any[], seedUrl = '') => {
  const qualityOrder: Record<string, number> = { best: 0, '4k': 1, '2k': 2, fhd: 3, hd: 4, '480p': 5, '360p': 6, audio: 7 };
  const candidates = items.filter((item) => {
    const itemUrl = String(item?.url || '');
    if (!itemUrl) return false;
    // Keep explicit "unresolvable" placeholders so users still see every video tile.
    if (item?.unresolvable) return true;
    if (item?.isVimeo && !item?.isVimeoDirect) return false;
    const isPagePlaceholder = isPlatformHostedUrl(itemUrl) && !isDirectVideoAssetUrl(itemUrl);
    if (isTechnicalStream(item) && !isPagePlaceholder) return false;
    if (!streamHasAudio(item) && String(item?.vcodec || item?.videoCodec || '').toLowerCase() !== 'none') {
      return isPagePlaceholder;
    }
    return true;
  });

  const grouped = new Map<string, any>();
  candidates.forEach((item) => {
    const qualityKey = item.displayQualityKey || getCleanQualityKey(item);
    const qualityLabel = item.displayQualityLabel || getCleanQualityLabel(qualityKey);
    const normalized = {
      ...item,
      displayQualityKey: qualityKey,
      displayQualityLabel: qualityLabel,
      streamLabel: item.streamLabel || qualityLabel,
      audioAvailable: streamHasAudio(item),
      availableFormats: Number(item.availableFormats || candidates.length),
    };
    const key = `${sourceIdentityForStream(item, seedUrl)}:${qualityKey}`;
    const current = grouped.get(key);
    if (!current || streamRank(normalized) > streamRank(current)) grouped.set(key, normalized);
  });

  return Array.from(grouped.values()).sort(
    (a, b) =>
      (qualityOrder[a.displayQualityKey] ?? 99) - (qualityOrder[b.displayQualityKey] ?? 99) ||
      streamRank(b) - streamRank(a)
  );
};

export const getVisibleVideoCards = (videos: any[], seedUrl = '') => {
  const rawVideoCandidates = (Array.isArray(videos) ? videos : [])
    .filter((item) => item && typeof item.url === 'string' && item.url.length > 0)
    .map((item) => {
      const url = normalizeMediaUrl(item.url, item.sourceUrl || item.pageUrl || seedUrl);
      if (!url) return null;
      const sourceStreamUrl = item.sourceStreamUrl ? normalizeMediaUrl(item.sourceStreamUrl, item.sourceUrl || item.pageUrl || seedUrl) : '';
      const sourceUrl = item.sourceUrl ? normalizeMediaUrl(item.sourceUrl, seedUrl) : '';
      return {
        ...item,
        url,
        ...(sourceStreamUrl ? { sourceStreamUrl } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
      };
    })
    .filter(Boolean)
    .filter((item: any) => {
      const url = String(item.url || '');
      if (isFalseVimeoUtilityUrl(url)) return false;
      if (item.isVimeoDirect || item.isYouTubeDirect || item.isWistiaDirect) return true;
      if (item.isDirect || item.isYouTubeMerged || item.isMp4Proxy) return true;
      if (isPlatformHostedUrl(url)) return true;
      return isDirectVideoAssetUrl(url);
    })
    .reduce((acc: any[], item: any) => {
      const key = toCanonicalVideoKey(item, seedUrl);
      if (!key) return acc;
      const existingIndex = acc.findIndex((entry) => toCanonicalVideoKey(entry, seedUrl) === key);
      if (existingIndex === -1) {
        acc.push(item);
      } else if (videoPriority(item) > videoPriority(acc[existingIndex])) {
        acc[existingIndex] = item;
      }
      return acc;
    }, []);

  const normalized = normalizeVisibleStreams(rawVideoCandidates, seedUrl);

  const directCanonicalKeys = new Set(
    normalized
      .filter((item) => item?.isVimeoDirect || item?.isYouTubeDirect || item?.isWistiaDirect || isDirectVideoAssetUrl(String(item?.url || '')))
      .map((item) => toCanonicalVideoKey(item, seedUrl))
      .filter(Boolean)
  );

  const filtered = normalized.filter((item) => {
    // Keep placeholders for unavailable Vimeo clips so the user sees every tile from the page.
    if (item?.unresolvable) return true;
    if (item?.streamsPrepared || item?.vimeoQualityVariants) return true;
    if (item?.isVimeo && !item?.isVimeoDirect) return false;
    const provider = String(item?.provider || '').toLowerCase();
    const url = String(item?.url || '').toLowerCase();
    if (provider === 'vimeo' && !item?.isVimeoDirect && /\/(?:api|add|ablincoln|favicon)\b|\.ico(?:\?|$)|player\.js(?:\?|$)/.test(url)) {
      return false;
    }
    if (provider === 'vimeo' && directCanonicalKeys.has(toCanonicalVideoKey(item, seedUrl)) && !item?.isVimeoDirect && !isDirectVideoAssetUrl(String(item?.url || ''))) {
      return false;
    }
    return true;
  });

  // One card per fetched video source (best quality wins).
  const bySource = new Map<string, any>();
  filtered.forEach((item) => {
    const identity = sourceIdentityForStream(item, seedUrl);
    if (!identity) return;
    const qualityKey = item.displayQualityKey || getCleanQualityKey(item);
    const enriched = {
      ...item,
      displayQualityKey: qualityKey,
      displayQualityLabel: item.displayQualityLabel || getCleanQualityLabel(qualityKey),
      streamLabel: item.streamLabel || getCleanQualityLabel(qualityKey),
    };
    const current = bySource.get(identity);
    if (!current || streamRank(enriched) > streamRank(current)) {
      bySource.set(identity, enriched);
    }
  });

  return Array.from(bySource.values()).sort((a, b) => streamRank(b) - streamRank(a));
};

export const getVisibleVideoCount = (videos: any[], seedUrl = '') => getVisibleVideoCards(videos, seedUrl).length;
