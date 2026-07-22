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

export const isYouTubeExtractUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') return Boolean(parsed.pathname.replace(/^\/+/, '').split('/')[0]);
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (/\/watch/i.test(parsed.pathname) && parsed.searchParams.get('v')) return true;
      if (/\/shorts\//i.test(parsed.pathname)) return true;
    }
    return false;
  } catch {
    return /youtube\.com\/(?:watch|shorts)|youtu\.be\//i.test(String(rawUrl || ''));
  }
};

/** True when the URL points at a single video on a supported platform (Direct Video default). */
const VIMEO_WEBSITE_PAGE_PREFIXES = new Set([
  'blog',
  'features',
  'for',
  'help',
  'solutions',
  'upgrade',
  'watch',
]);

const isVimeoWebsitePagePath = (path: string) => {
  const [firstSegment = ''] = path.split('/').filter(Boolean);
  return VIMEO_WEBSITE_PAGE_PREFIXES.has(firstSegment.toLowerCase());
};

type BrightcoveIds = {
  accountId: string;
  playerId: string;
  videoId: string;
};

const normalizeBrightcovePlayerId = (playerId?: string | null) => {
  const clean = String(playerId || '').trim().replace(/^\/+|\/+$/g, '');
  if (!clean || clean === 'default') return 'default_default';
  return clean;
};

const buildBrightcoveCanonicalUrl = ({ accountId, playerId, videoId }: BrightcoveIds) =>
  `https://players.brightcove.net/${accountId}/${normalizeBrightcovePlayerId(playerId)}/index.html?videoId=${videoId}`;

const parseBrightcoveIdsFromUrl = (rawUrl: string): BrightcoveIds | null => {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname;

    if (host === 'players.brightcove.net' || host.endsWith('.players.brightcove.net')) {
      const match = path.match(/^\/(\d+)\/([^/?#]+)\/index(?:\.min)?\.(?:html|js)$/i);
      const videoId = parsed.searchParams.get('videoId') || parsed.searchParams.get('video_id');
      if (match?.[1] && match?.[2] && videoId) {
        return { accountId: match[1], playerId: match[2], videoId };
      }
    }

    const playbackMatch = path.match(/\/accounts\/(\d+)\/videos\/(\d+)/i);
    if (playbackMatch?.[1] && playbackMatch?.[2]) {
      return { accountId: playbackMatch[1], playerId: 'default_default', videoId: playbackMatch[2] };
    }

    const queryAccount = parsed.searchParams.get('account') || parsed.searchParams.get('accountId') || parsed.searchParams.get('account_id');
    const queryVideo = parsed.searchParams.get('video') || parsed.searchParams.get('videoId') || parsed.searchParams.get('video_id');
    if (queryAccount && queryVideo) {
      const playerParam = parsed.searchParams.get('player') || parsed.searchParams.get('playerUrl') || parsed.searchParams.get('player_url') || '';
      const playerMatch = playerParam.match(/players\.brightcove\.(?:net|com)\/\d+\/([^/?&#]+)/i);
      return {
        accountId: queryAccount,
        playerId: playerMatch?.[1] || 'default_default',
        videoId: queryVideo,
      };
    }
  } catch {
    const match = value.match(/players\.brightcove\.net\/(\d+)\/([^/?#]+)\/index\.html\?[^#]*videoId=(\d+)/i);
    if (match?.[1] && match?.[2] && match?.[3]) {
      return { accountId: match[1], playerId: match[2], videoId: match[3] };
    }
  }
  return null;
};

export const canonicalBrightcovePlayerUrl = (rawUrl: string) => {
  const ids = parseBrightcoveIdsFromUrl(rawUrl);
  return ids ? buildBrightcoveCanonicalUrl(ids) : '';
};

export const canonicalBrightcovePlayerUrlFromItem = (item: any, seedUrl = '') => {
  const primaryCandidates = [
    item?.embedUrl,
    item?.url,
    item?.sourceStreamUrl,
    item?.downloadUrl,
    item?.originalUrl,
  ]
    .map((candidate) => String(candidate || '').trim())
    .filter(Boolean);
  for (const candidate of primaryCandidates) {
    const canonical = canonicalBrightcovePlayerUrl(candidate);
    if (canonical) return canonical;
  }

  const explicitlyBrightcove =
    /brightcove/i.test(String(item?.provider || item?.platform || item?.type || '')) ||
    Boolean(item?.brightcoveAccountId && item?.brightcoveVideoId);
  if (!explicitlyBrightcove) return '';

  const contextCandidates = [item?.sourceUrl, item?.pageUrl, seedUrl]
    .map((candidate) => String(candidate || '').trim())
    .filter(Boolean);
  for (const candidate of contextCandidates) {
    const canonical = canonicalBrightcovePlayerUrl(candidate);
    if (canonical) return canonical;
  }
  return '';
};

export const isBrightcoveNoiseUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === 'metrics.brightcove.com' || host.endsWith('.metrics.brightcove.com')) return true;
    if (/\/(?:v\d+\/)?tracker(?:\/|$)/i.test(path)) return true;
    if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(path) && (
      host.includes('brightcove') ||
      host.includes('bcovlive') ||
      host.includes('boltdns') ||
      host.includes('videocloud') ||
      host.includes('brightcovecdn')
    )) return true;
    return false;
  } catch {
    return /metrics\.brightcove\.com|\/tracker[/?#]|(?:brightcove|bcovlive|boltdns|videocloud|brightcovecdn)[^"'\s]*\.(?:m3u8|mpd)(?:[?#]|\s|$)/i.test(value);
  }
};

export const isTransportStreamSegmentUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.toLowerCase();
    return /(?:^|\/)(?:segment|seg|fragment|chunk)[^/]*\.ts$/i.test(path) || /\.ts$/i.test(path);
  } catch {
    return /(?:^|\/)(?:segment|seg|fragment|chunk)[^"'\s/]*\.ts(?:[?#]|\s|$)|\.ts(?:[?#]|\s|$)/i.test(value);
  }
};

export const isDirectVideoPlatformUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v)(\?|$)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === 'youtu.be') return path.replace(/^\/+/, '').length > 0;
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return Boolean(parsed.searchParams.get('v')) || /\/(?:embed|shorts|live)\//.test(path);
    }
    if (host === 'player.vimeo.com') {
      return /\/video\/\d+/.test(path) || /\/progressive_redirect\/download\/\d+/.test(path);
    }
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      if (/\/progressive_redirect\/download\/\d+/.test(path)) return true;
      if (/^\/\d+(?:\/|$)/.test(path)) return true;
      if (/\.(ico|js|css|json)(\?|$)/i.test(path)) return false;
      if (isVimeoWebsitePagePath(path)) return false;
      if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/.test(path)) return false;
      const segments = path.split('/').filter(Boolean);
      return segments.length >= 2;
    }
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch') {
      return host === 'fb.watch' || /\/(?:watch|reel|videos?)\b|\/videos\//.test(path);
    }
    if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) {
      return /\/status(?:es)?\//.test(path);
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      return /\/(?:reel|reels|p|tv)\//.test(path);
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return /\/video\//.test(path);
    if (host === 'players.brightcove.net' || host.endsWith('.players.brightcove.net')) {
      return /\/index\.html$/i.test(path) && Boolean(parsed.searchParams.get('videoId'));
    }
    if (host === 'metrics.brightcove.com' || host.endsWith('.metrics.brightcove.com')) {
      return Boolean(canonicalBrightcovePlayerUrl(value));
    }
    return false;
  } catch {
    return false;
  }
};

export const resolveDefaultExtractionMode = (rawUrl: string): 'direct' | 'full' =>
  isDirectVideoPlatformUrl(rawUrl) ? 'direct' : 'full';

export const isGoogleVideoPlaybackUrl = (rawUrl: string) =>
  /googlevideo\.com\/videoplayback|\/videoplayback\?/i.test(String(rawUrl || ''));

export const isCopyableStreamMediaUrl = (rawUrl: string) => {
  const candidate = String(rawUrl || '').trim();
  if (!candidate) return false;
  if (isYouTubeWatchUrl(candidate) && !isGoogleVideoPlaybackUrl(candidate)) return false;
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\/api\/(?:youtube-merged-stream|download)(?:\?|$)/i.test(candidate)) return false;
  if (isGoogleVideoPlaybackUrl(candidate)) return true;
  if (/^~?\//.test(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) return true;
  if (/^https?:\/\//i.test(candidate) && !isYouTubeWatchUrl(candidate)) return true;
  return false;
};

/** Map a ~/Downloads/... display path to /api/download-local-video for instant browser save. */
export const resolveLocalDownloadApiPath = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  const withoutTilde = value.replace(/^~\/Downloads\/?/i, '');
  const withoutHomeDownloads = withoutTilde.replace(/^\/Users\/[^/]+\/Downloads\/?/i, '');
  const relative = withoutHomeDownloads !== value ? withoutHomeDownloads : '';
  if (!relative || !relative.toLowerCase().endsWith('.mp4')) return '';
  if (relative.includes('..') || relative.startsWith('/')) return '';
  return `/api/download-local-video?filename=${encodeURIComponent(relative)}`;
};

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
      host.includes('brightcove.net') ||
      host.includes('brightcove.com')
    );
  } catch {
    return false;
  }
};

export const isWistiaHelperResourceUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!host.includes('wistia.com') && !host.includes('wistia.net')) return false;
    const path = parsed.pathname.toLowerCase();
    if (/\/embed\/medias\/[a-z0-9]{8,12}\/swatch\/?$/i.test(path)) return true;
    if (/\/assets\/external\/(?:publicapi|captions|interfontface|playpauseloadingcontrol|hls_video|x)(?:\.js)?(?:@|\/|$)/i.test(path)) {
      return true;
    }
    if (/\/(?:mput|jsonp|iframe_shim)(?:\/|$)/i.test(path)) return true;
    return /\/embed\/medias\/[a-z0-9]{8,12}\/(?:swatch|seo|jsonp)(?:\/|$)/i.test(path);
  } catch {
    return /fast\.wistia\.(?:com|net)\/embed\/medias\/[a-z0-9]{8,12}\/swatch|wistia\.(?:com|net).*\/assets\/external\/(?:publicapi|captions|interfontface|playpauseloadingcontrol|hls_video|x)|wistia\.(?:com|net).*\/mput\b/i.test(String(rawUrl || ''));
  }
};

const isBareWistiaDeliveryResource = (item: any) => {
  const candidates = [
    item?.sourceStreamUrl,
    item?.downloadUrl,
    item?.originalUrl,
    item?.embedUrl,
    item?.url,
  ].map((candidate) => String(candidate || '').trim()).filter(Boolean);
  const hasWistiaDelivery = candidates.some((candidate) => /(?:wistia\.com|wistia\.net)\/deliveries\//i.test(candidate));
  if (!hasWistiaDelivery) return false;
  if (item?.isWistiaDirect || item?.height || item?.width || item?.resolution || item?.displayQualityKey) return false;
  if (/^video|mp4$/i.test(String(item?.type || item?.format || ''))) return false;
  return true;
};

const isBareWistiaManifestResource = (item: any) => {
  const candidates = [
    item?.sourceStreamUrl,
    item?.downloadUrl,
    item?.originalUrl,
    item?.embedUrl,
    item?.url,
  ].map((candidate) => String(candidate || '').trim()).filter(Boolean);
  const hasWistiaManifest = candidates.some((candidate) =>
    /(?:wistia\.com|wistia\.net)/i.test(candidate) && /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(candidate)
  );
  if (!hasWistiaManifest) return false;
  if (item?.isWistiaDirect || item?.height || item?.width || item?.resolution || item?.displayQualityKey) return false;
  return true;
};

export const isPlatformWatchPlaceholder = (item: any) => {
  const url = String(item?.url || '').trim();
  if (!url || isDirectVideoAssetUrl(url)) return false;
  if (item?.isVimeoDirect || item?.isYouTubeDirect || item?.isWistiaDirect || item?.isDirect) return false;
  if (item?.isVimeo && !item?.isVimeoDirect && isPlatformHostedUrl(url) && !isFalseVimeoUtilityUrl(url)) return true;
  return isPlatformHostedUrl(url);
};

export const normalizeMediaUrl = (rawUrl: string, baseUrl?: string) => {
  const value = String(rawUrl || '').trim();
  const appBase = typeof window !== 'undefined' ? window.location.origin : undefined;
  const usesAppBase = /^\/(?:api|converted-videos|converted-audio|cached-images|cached-fonts)\//i.test(value);
  const fallbackBase = usesAppBase ? appBase : (baseUrl || appBase);
  const normalized = sanitizeStreamUrl(value, fallbackBase);
  if (!normalized || isExpiredStreamUrl(normalized, 90, fallbackBase)) return '';
  return isYouTubeWatchUrl(normalized) ? normalizeYouTubeWatchUrl(normalized) : normalized;
};

export const toCanonicalVideoKey = (item: any, seedUrl = '') => {
  const rawUrl = normalizeMediaUrl(
    String(item?.url || item?.sourceStreamUrl || item?.originalUrl || item?.pageUrl || item?.sourceUrl || '').trim(),
    item?.sourceUrl || item?.pageUrl || seedUrl
  );
  if (!rawUrl) return '';
  const brightcoveCanonical = canonicalBrightcovePlayerUrlFromItem(item, seedUrl);
  if (brightcoveCanonical) {
    try {
      const parsedBrightcove = new URL(brightcoveCanonical);
      const accountId = parsedBrightcove.pathname.split('/').filter(Boolean)[0] || '';
      const videoId = parsedBrightcove.searchParams.get('videoId') || '';
      return `brightcove:${accountId}:${videoId}`;
    } catch {
      return brightcoveCanonical;
    }
  }
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
    if (host.includes('googlevideo.com')) {
      const watchUrl = resolveYouTubeWatchUrlFromItem(item, seedUrl);
      if (watchUrl) {
        const videoId = new URL(watchUrl).searchParams.get('v');
        if (videoId) return `youtube:${videoId}`;
      }
      return 'youtube:stream';
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
  !isWistiaHelperResourceUrl(String(rawUrl || '')) &&
  (
    /\/api\/(?:youtube-merged-stream|download|download-local-video)(?:\?|$)/i.test(String(rawUrl || '')) ||
    /\/converted-videos\//i.test(String(rawUrl || '')) ||
    /\.(mp4|webm|mov|mkv|m4v|m3u8|mpd)(\?|$)/i.test(String(rawUrl || '')) ||
    /wistia\.com\/deliveries\//i.test(String(rawUrl || '')) ||
    /vimeo\.com\/progressive_redirect|vimeocdn\.com|vod-adaptive\.akamaized\.net/i.test(String(rawUrl || ''))
  );

/**
 * Website crawls can observe analytics/navigation requests on video-platform
 * pages. Only expose an unresolved Vimeo item when it identifies a plausible
 * clip and has an actual preview; resolved media streams are always retained.
 */
export const isUsableExtractedVideo = (item: any, seedUrl = '') => {
  if (!item) return false;
  const candidates = [
    item?.sourceStreamUrl,
    item?.downloadUrl,
    item?.originalUrl,
    item?.embedUrl,
    item?.url,
  ]
    .map((candidate) => String(candidate || '').trim())
    .filter(Boolean);
  const contextCandidates = [
    ...candidates,
    String(item?.sourceUrl || '').trim(),
    String(item?.pageUrl || '').trim(),
    String(seedUrl || '').trim(),
  ].filter(Boolean);
  const itemType = String(item?.mimeType || item?.contentType || item?.type || '').toLowerCase();
  const titleLooksLikeImage = /\.(?:svg|png|jpe?g|gif|webp|avif)(?:\s+\d+)?$/i.test(
    String(item?.title || item?.name || item?.label || '').trim()
  );
  const hasImageAssetCandidate = candidates.some((candidate) =>
    /\.(?:svg|png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(candidate)
  );
  const hasActualVideoCandidate = candidates.some(isDirectVideoAssetUrl) || candidates.some(isPlatformHostedUrl);
  if ((itemType.startsWith('image/') || hasImageAssetCandidate || titleLooksLikeImage) && !hasActualVideoCandidate) {
    return false;
  }
  if (contextCandidates.some(isWistiaHelperResourceUrl)) return false;
  if (isBareWistiaDeliveryResource(item)) return false;
  if (isBareWistiaManifestResource(item)) return false;
  if (contextCandidates.some(isTransportStreamSegmentUrl)) return false;
  const hasBrightcoveCanonical = Boolean(canonicalBrightcovePlayerUrlFromItem(item, seedUrl));
  const isBrightcoveNoise = contextCandidates.some(isBrightcoveNoiseUrl);
  const isVimeoContext = contextCandidates.some((candidate) => {
    try {
      const host = new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
      return host === 'vimeo.com' || host === 'player.vimeo.com' || host.endsWith('.vimeo.com');
    } catch {
      return false;
    }
  });
  const rawTitle = String(item?.title || item?.name || item?.label || '').trim();
  const title = rawTitle.toLowerCase();
  const primaryUrl = String(item?.url || item?.embedUrl || '').trim();
  const hasRealPreview = /^https?:\/\//i.test(String(item?.thumbnail || item?.poster || '').trim());
  const titleLooksEncoded = /^[A-Za-z0-9+/_=-]{24,}\.*$/.test(rawTitle) && !/\s/.test(rawTitle);
  if (isBrightcoveNoise && !hasBrightcoveCanonical) return false;
  if (/^tracker(?:\s*\d+)?$/i.test(title) && !hasBrightcoveCanonical) return false;
  if (hasBrightcoveCanonical) return true;
  if (
    isVimeoContext &&
    (
      /^(?:gtm|info|tr|attribution_trigger|collect(?:\s*\d+)?|0|\d{13,})$/i.test(title) ||
      /\.(?:svg|png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(primaryUrl) ||
      /\/(?:gtm|info|tr|attribution_trigger|collect(?:\/?\d+)?)\/?(?:[?#]|$)/i.test(primaryUrl)
    )
  ) {
    return false;
  }

  if (
    item?.isDirect ||
    item?.isVimeoDirect ||
    item?.isYouTubeDirect ||
    item?.isWistiaDirect ||
    item?.isYouTubeMerged ||
    item?.isMp4Proxy ||
    candidates.some(isDirectVideoAssetUrl)
  ) {
    return true;
  }

  const platformUrl = candidates.find(isPlatformHostedUrl);
  // Preserve real website video candidates, but hide generic iframe/player
  // placeholders observed on sites like Apple where the "title" is only an
  // encoded media-config token and there is no playable media URL/preview.
  if (!platformUrl) {
    const hasHttpCandidate = contextCandidates.some((candidate) => /^https?:\/\//i.test(candidate));
    const looksLikeBlankPlayer =
      titleLooksEncoded ||
      (/(?:embedded\s+player|video\s+player)/i.test(String(item?.type || item?.provider || item?.label || '')) && !hasRealPreview);
    return hasHttpCandidate && !looksLikeBlankPlayer;
  }

  try {
    const parsed = new URL(platformUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname;
    if (host.includes('wistia.com') || host.includes('wistia.net')) {
      if (/^x$/i.test(rawTitle)) return false;
      return false;
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = String(item?.vimeoId || path.match(/\/(?:video\/|videos\/)?(\d+)(?:\/|$)/)?.[1] || '');
      const hasPlausibleId = /^\d{6,12}$/.test(id);
      return hasPlausibleId && hasRealPreview && !item?.unresolvable;
    }
    return true;
  } catch {
    return false;
  }
};

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
  if (isTransportStreamSegmentUrl(String(item?.url || ''))) return true;
  if (isBrightcoveNoiseUrl(String(item?.url || '')) && !canonicalBrightcovePlayerUrlFromItem(item)) return true;
  if (isWistiaHelperResourceUrl(String(item?.url || ''))) return true;
  if (isBareWistiaDeliveryResource(item)) return true;
  if (isBareWistiaManifestResource(item)) return true;
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif|js|css|json)(\?|$)/i.test(value)) return true;
  return /storyboard|thumbnail|sprite|dash fragment|fragmented|metadata|manifest|m3u8|mpd|\.m3u8|\.mpd|\.ts(?:\s|$|\?)/.test(value);
};

export const streamRank = (item: any) => {
  const url = String(item?.url || '');
  const lowered = url.toLowerCase();
  const qualityKey = String(item?.displayQualityKey || item?.qualityRequested || getCleanQualityKey(item) || 'best').toLowerCase();
  const qualityScore: Record<string, number> = {
    '4k': 70000,
    '2k': 60000,
    fhd: 50000,
    best: 45000,
    hd: 40000,
    '480p': 20000,
    '360p': 10000,
    audio: 0,
  };
  const heightScore = Math.min(9000, Number(getStreamHeight(item) || 0) * 6);
  const mp4Score = /\.mp4(\?|$)/i.test(lowered) || /\/api\/youtube-merged-stream|\/api\/download|\/api\/download-local-video|\/converted-videos\/|googlevideo\.com\/videoplayback|vimeo\.com\/progressive_redirect|wistia\.com\/deliveries\//i.test(lowered) ? 10000 : 0;
  const audioScore = streamHasAudio(item) ? 4000 : 0;
  const directScore = item?.isDirect || item?.isVimeoDirect || item?.isWistiaDirect || item?.isYouTubeDirect || isDirectVideoAssetUrl(url) ? 1000 : 0;
  const sizeScore = Math.min(900, Number(item?.filesize || item?.filesize_approx || 0) / 100000);
  return (qualityScore[qualityKey] ?? qualityScore.best) + heightScore + mp4Score + audioScore + directScore + sizeScore;
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
  const brightcoveCanonical = canonicalBrightcovePlayerUrlFromItem(item, seedUrl);
  if (brightcoveCanonical) {
    try {
      const parsed = new URL(brightcoveCanonical);
      return `brightcove:${parsed.pathname.split('/').filter(Boolean)[0] || ''}:${parsed.searchParams.get('videoId') || ''}`;
    } catch {
      return brightcoveCanonical;
    }
  }

  if (item?.wistiaHashedId) return `wistia:${item.wistiaHashedId}`;

  if (item?.vimeoId) return `vimeo:${item.vimeoId}`;

  if (item?.isYouTubeMerged || /\/api\/youtube-merged-stream(?:\?|$)/i.test(underlyingUrl)) {
    const watchUrl = resolveYouTubeWatchUrlFromItem(item, seedUrl);
    if (watchUrl) {
      try {
        const videoId = new URL(watchUrl).searchParams.get('v');
        if (videoId) return `youtube:${videoId}`;
      } catch {
        // Fall through to generic identity handling.
      }
    }
  }

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
      if (host.includes('googlevideo.com')) {
        const watchUrl = resolveYouTubeWatchUrlFromItem(item, seedUrl);
        if (watchUrl) {
          const videoId = new URL(watchUrl).searchParams.get('v');
          if (videoId) return `youtube:${videoId}`;
        }
        return 'youtube:stream';
      }
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
    if (item?.isVimeo && !item?.isVimeoDirect) {
      return isPlatformHostedUrl(itemUrl) && !isFalseVimeoUtilityUrl(itemUrl);
    }
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
      const brightcoveCanonical = canonicalBrightcovePlayerUrlFromItem({ ...item, url, sourceStreamUrl, sourceUrl }, seedUrl);
      return {
        ...item,
        url: brightcoveCanonical || url,
        ...(brightcoveCanonical
          ? {
              embedUrl: brightcoveCanonical,
              provider: 'brightcove',
              type: 'brightcove',
              title: /^tracker(?:\s*\d+)?$/i.test(String(item?.title || item?.name || '').trim())
                ? 'Brightcove video'
                : item?.title || item?.name || 'Brightcove video',
            }
          : {}),
        ...(sourceStreamUrl ? { sourceStreamUrl } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
      };
    })
    .filter(Boolean)
    .filter((item: any) => {
      const url = String(item.url || '');
      if (isTransportStreamSegmentUrl(url)) return false;
      if (isBrightcoveNoiseUrl(url) && !canonicalBrightcovePlayerUrlFromItem(item, seedUrl)) return false;
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
    if (item?.streamsPrepared || item?.vimeoQualityVariants || item?.qualityVariants || item?.isYouTubeMerged || item?.needsYouTubeMerge) return true;
    if (item?.isVimeo && !item?.isVimeoDirect) {
      const url = String(item?.url || '');
      return isPlatformHostedUrl(url) && !isFalseVimeoUtilityUrl(url);
    }
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
