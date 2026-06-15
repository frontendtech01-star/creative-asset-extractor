export type VideoPlatform = 'youtube' | 'vimeo' | 'instagram' | 'facebook' | 'x' | 'tiktok' | 'ispot';

export const VIDEO_PLATFORMS: Array<{
  id: VideoPlatform;
  label: string;
  exampleUrl: string;
}> = [
  { id: 'youtube', label: 'YouTube', exampleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { id: 'vimeo', label: 'Vimeo', exampleUrl: 'https://vimeo.com/76979871' },
  { id: 'instagram', label: 'Instagram', exampleUrl: 'https://www.instagram.com/reel/DZK34RqhrSr/' },
  { id: 'facebook', label: 'Facebook', exampleUrl: 'https://www.facebook.com/facebook/videos/grandpas-have-the-best-life-hacks-tbh-video-by-life-with-wes-alison-comedy-sketc/454290807152360/' },
  { id: 'x', label: 'X.com', exampleUrl: 'https://x.com/LetsXOtt/status/1991751366520500536' },
  { id: 'ispot', label: 'iSpot.tv', exampleUrl: 'https://www.ispot.tv/ad/gejf/burger-king-loaded-jalapeno-whopper-you-tell-us' },
];

const parseUrlParts = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl.trim());
    return {
      host: parsed.hostname.replace(/^www\./, '').toLowerCase(),
      path: parsed.pathname,
      searchParams: parsed.searchParams,
    };
  } catch {
    return null;
  }
};

/** True when the URL points at a single video, not a homepage/channel/catalog page. */
export const isDirectVideoPlatformUrl = (rawUrl: string) => {
  const parts = parseUrlParts(rawUrl);
  if (!parts) return false;
  const { host, path, searchParams } = parts;
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl)) return true;
  if (host === 'youtu.be') return path.replace(/^\/+/, '').length > 0;
  if (host.includes('youtube.com')) {
    return Boolean(searchParams.get('v')) || /\/(?:embed|shorts|live)\//.test(path);
  }
  if (host === 'player.vimeo.com') return /\/video\/\d+/.test(path);
  if (host.includes('vimeo.com')) {
    if (/^\/\d+(?:\/|$)/.test(path)) return true;
    if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/.test(path)) return false;
    return path.split('/').filter(Boolean).length >= 2;
  }
  if (host.includes('facebook.com') || host === 'fb.watch') {
    return host === 'fb.watch' || /\/(?:watch|reel|videos?)\b|\/videos\//.test(path);
  }
  if (host === 'x.com' || host.includes('twitter.com')) return /\/status(?:es)?\//.test(path);
  if (host.includes('tiktok.com')) return /\/video\/\d+/.test(path) || /^\/t\//.test(path);
  if (host.includes('instagram.com')) return /\/(?:reel|reels|p|tv)\//.test(path);
  if (host === 'ispot.tv' || host.endsWith('.ispot.tv')) return /^\/ad\/[^/]+\/[^/]+/.test(path);
  return false;
};

export const describeDirectVideoPlatformUrlIssue = (rawUrl: string) => {
  const parts = parseUrlParts(rawUrl);
  if (!parts) return 'Paste a valid video URL.';
  const { host, path } = parts;
  if (host.includes('vimeo.com')) {
    if (!path || path === '/') {
      return 'That link is the Vimeo homepage. Paste a direct video URL like https://vimeo.com/123456789.';
    }
    if (path.startsWith('/ondemand/')) {
      return 'That is a Vimeo On Demand catalog page. Open a video and copy its direct link.';
    }
    if (path.startsWith('/channels/') || path.startsWith('/groups/')) {
      return 'That is a Vimeo browse page. Paste the URL of a specific video instead.';
    }
    if (!/^\/\d+/.test(path) && path.split('/').filter(Boolean).length < 2) {
      return 'Paste a direct Vimeo video link (e.g. https://vimeo.com/123456789).';
    }
  }
  return 'Paste a direct video link for this platform — not a homepage, channel, or catalog page.';
};

export const isPlaceholderVideoPlatformUrl = (rawUrl: string) => {
  const parts = parseUrlParts(rawUrl);
  if (!parts) return false;
  const { host, path, searchParams } = parts;
  if ((host.includes('facebook.com') || host === 'fb.watch') && searchParams.get('v') === '123456789') return true;
  if ((host === 'x.com' || host.includes('twitter.com')) && /\/status(?:es)?\/1234567890\b/.test(path)) return true;
  if (host.includes('instagram.com') && /\/(?:reel|reels|p|tv)\/example\/?$/i.test(path)) return true;
  return false;
};

export const detectVideoPlatform = (rawUrl: string): VideoPlatform | null => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('vimeo.com')) return 'vimeo';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('facebook.com') || host === 'fb.watch') return 'facebook';
    if (host === 'x.com' || host.includes('twitter.com')) return 'x';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host === 'ispot.tv' || host.endsWith('.ispot.tv')) return 'ispot';
    return null;
  } catch {
    return null;
  }
};

export const videoExtractApiPath = (platform?: VideoPlatform | 'universal') => {
  if (!platform || platform === 'universal') return '/api/video-extract/universal';
  return `/api/video-extract/${platform}`;
};
