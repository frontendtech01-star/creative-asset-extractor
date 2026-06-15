import React, { useState } from 'react';
import { Check, Copy, Download, ExternalLink, Video as VideoIcon, Youtube, Search, Globe } from 'lucide-react';
import { apiFetchWithTimeout, MERGE_PREP_TIMEOUT_MS } from '../lib/api';
import { getDesktopBridge } from '../lib/desktopBridge';
import { isDirectVideoAssetUrl, isPlatformHostedUrl } from '../lib/visibleVideos';

type WebsiteBulkDownloadJob = {
  id: string;
  title: string;
  url: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  progress: number;
  message: string;
  error?: string;
};

const isSupportedBulkDownloaderUrl = (rawUrl: string) => {
  if (isDirectVideoAssetUrl(rawUrl)) return true;
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return (
      host.includes('youtube.com') ||
      host === 'youtu.be' ||
      host.includes('vimeo.com') ||
      host.includes('instagram.com') ||
      host.includes('facebook.com') ||
      host === 'fb.watch' ||
      host === 'x.com' ||
      host.includes('twitter.com') ||
      host === 'ispot.tv' ||
      host.endsWith('.ispot.tv')
    );
  } catch {
    return false;
  }
};

const resolvePlatformVideoUrl = (video: any) => {
  const candidates = [
    video?.embedUrl,
    video?.url,
    video?.sourceStreamUrl,
    video?.originalUrl,
    video?.sourceUrl,
    video?.pageUrl,
  ];
  const platformUrl = candidates.find(
    (candidate) => typeof candidate === 'string' && isPlatformHostedUrl(candidate)
  );
  if (platformUrl) return String(platformUrl);
  if (video?.vimeoId) return `https://vimeo.com/${video.vimeoId}`;
  if (video?.wistiaHashedId) return `https://fast.wistia.net/embed/iframe/${video.wistiaHashedId}`;
  return '';
};

const resolveVideoDownloadRequest = (video: any, seedUrl: string) => {
  const directCandidates = [
    video?.sourceStreamUrl,
    video?.downloadUrl,
    video?.originalUrl,
    video?.url,
  ];
  const directUrl = directCandidates.find(
    (candidate) => typeof candidate === 'string' && isDirectVideoAssetUrl(candidate)
  );
  if (directUrl) {
    const isManifest = /\.(?:m3u8|mpd)(?:\?|$)/i.test(String(directUrl));
    return {
      endpoint: isManifest ? '/api/platform-video-download' : '/api/direct-video-download',
      url: String(directUrl),
      sourcePageUrl: String(video?.sourceUrl || video?.pageUrl || seedUrl || directUrl),
    };
  }

  const platformUrl = resolvePlatformVideoUrl(video) || (isPlatformHostedUrl(seedUrl) ? seedUrl : '');
  if (platformUrl) {
    return {
      endpoint: '/api/platform-video-download',
      url: String(platformUrl),
      sourcePageUrl: String(video?.sourceUrl || video?.pageUrl || seedUrl || platformUrl),
    };
  }

  return {
    endpoint: '/api/direct-video-download',
    url: String(video?.url || ''),
    sourcePageUrl: String(video?.sourceUrl || video?.pageUrl || seedUrl || video?.url || ''),
  };
};

const resolveEmbeddedVideoLink = (video: any) => {
  return resolvePlatformVideoUrl(video) || String([video?.embedUrl, video?.url, video?.sourceUrl, video?.pageUrl].find((candidate) => typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) || '');
};

const resolveBulkDownloadUrls = (videos: any[], seedUrl: string) =>
  Array.from(
    new Set(
      videos
        .map((video) => resolveVideoDownloadRequest(video, seedUrl).url)
        .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url) && isSupportedBulkDownloaderUrl(url))
    )
  );

const isEmbeddedVideo = (video: any) => {
  const url = String(video?.url || '');
  if (video?.isDirect || video?.isVimeoDirect || video?.isWistiaDirect || video?.isYouTubeDirect) return false;
  return !isDirectVideoAssetUrl(url);
};

const resolveEmbedPreviewUrl = (video: any) => {
  const source = resolveEmbeddedVideoLink(video);
  if (!source) return '';
  try {
    const parsed = new URL(source);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = video?.vimeoId || parsed.pathname.match(/\/(?:video\/)?(\d+)/)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : '';
    }
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const id =
        parsed.searchParams.get('v') ||
        parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] ||
        (host === 'youtu.be' ? parsed.pathname.split('/').filter(Boolean)[0] : '');
      return id ? `https://www.youtube.com/embed/${id}` : '';
    }
    if (host.includes('wistia.com') || host.includes('wistia.net')) {
      const id = video?.wistiaHashedId || parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i)?.[1];
      return id ? `https://fast.wistia.net/embed/iframe/${id}` : '';
    }
    if (host === 'players.brightcove.net') return source;
  } catch {
    return '';
  }
  return '';
};

const resolveEmbeddedThumbnail = (video: any) => {
  const explicit = String(video?.thumbnail || video?.poster || '').trim();
  if (explicit) return explicit;
  const source = resolveEmbeddedVideoLink(video);
  try {
    const parsed = new URL(source);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = video?.vimeoId || parsed.pathname.match(/\/(?:video\/)?(\d+)/)?.[1];
      return id ? `https://vumbnail.com/${id}.jpg` : '';
    }
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const id =
        parsed.searchParams.get('v') ||
        parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] ||
        (host === 'youtu.be' ? parsed.pathname.split('/').filter(Boolean)[0] : '');
      return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
    }
  } catch {
    return '';
  }
  return '';
};

const providerAllowsLocalEmbed = (video: any) => {
  const source = resolveEmbeddedVideoLink(video);
  try {
    const host = new URL(source).hostname.replace(/^www\./, '').toLowerCase();
    return host.includes('youtube.com') || host === 'youtu.be' || host.includes('wistia.com') || host.includes('wistia.net');
  } catch {
    return false;
  }
};

const videoTitleBase = (video: any, idx: number) => {
  const metadataTitle = String(video?.title || video?.name || video?.label || '').trim();
  if (metadataTitle && !/^(?:file|video)(?:\.[a-z0-9]+)?$/i.test(metadataTitle)) return metadataTitle;

  const filename = String(video?.url || '').split('/').pop()?.split('?')[0] || '';
  if (filename && !/^(?:file|video)(?:\.[a-z0-9]+)?$/i.test(filename)) return filename;

  const provider = String(video?.provider || video?.platform || '').trim();
  return `${provider ? `${provider} ` : ''}Video ${idx + 1}`;
};

const videoCardTitle = (video: any, idx: number, videos: any[]) => {
  const base = videoTitleBase(video, idx);
  const duplicatePosition = videos
    .slice(0, idx + 1)
    .filter((candidate, candidateIdx) => videoTitleBase(candidate, candidateIdx).toLowerCase() === base.toLowerCase())
    .length;
  const duplicateCount = videos.filter(
    (candidate, candidateIdx) => videoTitleBase(candidate, candidateIdx).toLowerCase() === base.toLowerCase()
  ).length;
  if (duplicateCount <= 1) return base;

  const quality = String(video?.resolution || video?.formatNote || '').trim();
  const sameQualityCount = videos.filter(
    (candidate, candidateIdx) =>
      videoTitleBase(candidate, candidateIdx).toLowerCase() === base.toLowerCase() &&
      String(candidate?.resolution || candidate?.formatNote || '').trim().toLowerCase() === quality.toLowerCase()
  ).length;
  if (quality && sameQualityCount === 1) return `${base} ${quality}`;
  return `${base} ${duplicatePosition}`;
};

export default function VideoExtractor({
  videos,
  seedUrl = '',
  hideManualSearch = false,
}: {
  videos: any[];
  seedUrl?: string;
  hideManualSearch?: boolean;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadResult, setDownloadResult] = useState<{ url: string; message: string; error?: boolean } | null>(null);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkJobs, setBulkJobs] = useState<WebsiteBulkDownloadJob[]>([]);
  const [bulkMessage, setBulkMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [copiedEmbeddedLink, setCopiedEmbeddedLink] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState(seedUrl);
  const [activeManualUrl, setActiveManualUrl] = useState('');

  const handleDownload = async (video: any, title: string) => {
    const cardUrl = String(video?.url || '');
    const request = resolveVideoDownloadRequest(video, seedUrl);
    setDownloading(cardUrl);
    setDownloadResult(null);
    try {
      if (!request.url) throw new Error('No downloadable video link was found.');
      const response = await apiFetchWithTimeout(
        request.endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: request.url,
            title,
            sourcePageUrl: request.sourcePageUrl,
            quality: 'fhd',
          }),
        },
        MERGE_PREP_TIMEOUT_MS,
        'Video download timed out. Please retry.'
      );
      const data = await response.json();
      if (!response.ok || !data?.ok || !data?.displayPath) {
        throw new Error(data?.error || 'Download failed');
      }
      setDownloadResult({
        url: cardUrl,
        message: data.reused ? `Already downloaded: ${data.displayPath}` : `Downloaded: ${data.displayPath}`,
      });
    } catch (error: any) {
      console.error('Download error:', error);
      setDownloadResult({ url: cardUrl, message: error?.message || 'Failed to download video.', error: true });
    } finally {
      setDownloading(null);
    }
  };

  const handleBulkDownload = async () => {
    const seen = new Set<string>();
    const items = videos
      .map((video, idx) => {
        const request = resolveVideoDownloadRequest(video, seedUrl);
        const title = videoCardTitle(video, idx, videos);
        return {
          id: `${idx}:${request.url}`,
          title,
          request,
        };
      })
      .filter((item) => {
        const url = String(item.request.url || '');
        if (!/^https?:\/\//i.test(url) || !isSupportedBulkDownloaderUrl(url) || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
    setBulkMessage(null);
    setBulkJobs([]);
    if (items.length === 0) {
      setBulkMessage({ text: 'No supported player links were found for bulk MP4 download.', error: true });
      return;
    }

    setBulkDownloading(true);
    setBulkJobs(
      items.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.request.url,
        status: 'queued',
        progress: 0,
        message: 'Queued',
      }))
    );
    try {
      setBulkMessage({ text: `${items.length} player link${items.length === 1 ? '' : 's'} queued. Saving MP4 files to this website's CreativeAssets/Videos folder...` });
      const completed: WebsiteBulkDownloadJob[] = [];
      for (const item of items) {
        setBulkJobs((current) =>
          current.map((job) =>
            job.id === item.id
              ? { ...job, status: 'running', progress: 15, message: 'Downloading MP4...' }
              : job
          )
        );
        try {
          const response = await apiFetchWithTimeout(
            item.request.endpoint,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: item.request.url,
                title: item.title,
                sourcePageUrl: seedUrl || item.request.sourcePageUrl,
                quality: 'fhd',
                saveToWebsiteAssets: true,
              }),
            },
            MERGE_PREP_TIMEOUT_MS,
            'Bulk MP4 download timed out. Please retry.'
          );
          const data = await response.json();
          if (!response.ok || !data?.ok || !data?.displayPath) throw new Error(data?.error || 'Download failed');
          const done: WebsiteBulkDownloadJob = {
            id: item.id,
            title: item.title,
            url: item.request.url,
            status: 'completed',
            progress: 100,
            message: data.reused ? `Already saved: ${data.displayPath}` : `Saved: ${data.displayPath}`,
          };
          completed.push(done);
          setBulkJobs((current) => current.map((job) => (job.id === item.id ? done : job)));
        } catch (error: any) {
          const failedJob: WebsiteBulkDownloadJob = {
            id: item.id,
            title: item.title,
            url: item.request.url,
            status: 'error',
            progress: 100,
            message: 'Download failed',
            error: error?.message || 'Download failed',
          };
          completed.push(failedJob);
          setBulkJobs((current) => current.map((job) => (job.id === item.id ? failedJob : job)));
        }
      }
      const failed = completed.filter((job) => job.status === 'error').length;
      const succeeded = completed.filter((job) => job.status === 'completed').length;
      setBulkMessage({
        text: failed
          ? `${succeeded} MP4 download${succeeded === 1 ? '' : 's'} saved to this website's CreativeAssets/Videos folder. ${failed} failed.`
          : `${succeeded} MP4 download${succeeded === 1 ? '' : 's'} saved to this website's CreativeAssets/Videos folder.`,
        error: failed > 0 && succeeded === 0,
      });
    } catch (error: any) {
      setBulkMessage({ text: error?.message || 'Bulk MP4 download failed.', error: true });
    } finally {
      setBulkDownloading(false);
    }
  };

  const handleManualSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualUrl.trim()) {
      setActiveManualUrl(manualUrl.trim());
    }
  };

  const handleCopyEmbeddedLink = async (link: string) => {
    try {
      const bridge = getDesktopBridge();
      if (bridge) {
        const copied = await bridge.writeClipboardText(link);
        if (copied !== link) throw new Error('Desktop clipboard verification failed');
      } else {
        const response = await fetch('/api/clipboard/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: link }),
        });
        if (!response.ok) throw new Error('System clipboard write failed');
      }
      setCopiedEmbeddedLink(link);
      window.setTimeout(() => setCopiedEmbeddedLink((current) => (current === link ? null : current)), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = link;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) return;
      setCopiedEmbeddedLink(link);
      window.setTimeout(() => setCopiedEmbeddedLink((current) => (current === link ? null : current)), 2000);
    }
  };

  const handleOpenEmbeddedLink = async (link: string) => {
    const bridge = getDesktopBridge();
    if (bridge) {
      const opened = await bridge.openExternalUrl(link);
      if (opened) return;
    }
    window.location.assign(link);
  };

  const renderExternalOptions = (url: string) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <a
        href={`https://en.savefrom.net/1-youtube-video-downloader-360/?url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col items-center justify-center p-4 border border-zinc-200 rounded-xl bg-white hover:bg-zinc-50 transition-colors shadow-sm"
        title="Open in SaveFrom.net"
      >
        <span className="font-semibold text-zinc-900 mb-1">SaveFrom.net</span>
        <span className="text-xs text-zinc-500 text-center">Video & Audio Download (Fast)</span>
      </a>
      <a
        href={`https://ssyoutube.com/en175/?url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col items-center justify-center p-4 border border-zinc-200 rounded-xl bg-white hover:bg-zinc-50 transition-colors shadow-sm"
        title="Open in SSYouTube"
      >
        <span className="font-semibold text-zinc-900 mb-1">SSYouTube</span>
        <span className="text-xs text-zinc-500 text-center">Video & Audio Download (HD)</span>
      </a>
      <a
        href={`https://www.dirpy.com/studio?url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col items-center justify-center p-4 border border-zinc-200 rounded-xl bg-white hover:bg-zinc-50 transition-colors shadow-sm"
        title="Open in Dirpy"
      >
        <span className="font-semibold text-zinc-900 mb-1">Dirpy Studio</span>
        <span className="text-xs text-zinc-500 text-center">Advanced Audio/Video Converter</span>
      </a>
      <a
        href={`https://cobalt.tools`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col items-center justify-center p-4 border border-zinc-200 rounded-xl bg-white hover:bg-zinc-50 transition-colors shadow-sm"
        title="Open in Cobalt"
      >
        <span className="font-semibold text-zinc-900 mb-1">Cobalt.tools</span>
        <span className="text-xs text-zinc-500 text-center">No-Ads Secure Downloader</span>
      </a>
    </div>
  );

  const bulkDownloadUrls = resolveBulkDownloadUrls(videos, seedUrl);

  return (
    <div className="space-y-8">
      {/* Manual Video Downloader Section */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-indigo-50 rounded-full flex items-center justify-center">
            <Search className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">Search & Download Any Video</h3>
            <p className="text-sm text-zinc-500">Paste a link from YouTube, Vimeo, Twitter, Facebook, Instagram, and more</p>
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
              className="block w-full pl-10 pr-3 py-3 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm bg-zinc-50"
              required
            />
          </div>
          <button
            type="submit"
            className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
        </form>

        {activeManualUrl && (
          <div className="mt-6 bg-zinc-50 p-6 border border-zinc-100 rounded-xl animate-in fade-in slide-in-from-top-4 duration-300">
            <h4 className="text-sm font-medium text-zinc-700 mb-4 flex items-center gap-2">
              <Download className="w-4 h-4" />
              Download Options for {(() => {
                try { return new URL(activeManualUrl).hostname.replace('www.', ''); }
                catch { return 'this link'; }
              })()}
            </h4>

            {renderExternalOptions(activeManualUrl)}
          </div>
        )}
      </div>

      {videos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-500 bg-white border border-zinc-200 rounded-2xl border-dashed">
          <VideoIcon className="w-12 h-12 mb-4 text-zinc-300" />
          <p className="text-lg font-medium text-zinc-900">No videos extracted from page</p>
          <p className="text-sm text-center max-w-md mt-1">We couldn't detect any direct video links on the extracted page. Use the search bar above to download videos manually.</p>
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h4 className="text-sm font-semibold text-zinc-900">Bulk Download Extracted Videos</h4>
                <p className="mt-1 text-xs text-zinc-500">
                  Saves {bulkDownloadUrls.length} resolved player link{bulkDownloadUrls.length === 1 ? '' : 's'} as MP4s in this website's CreativeAssets/Videos folder.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleBulkDownload()}
                disabled={bulkDownloading || bulkDownloadUrls.length === 0}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {bulkDownloading ? 'Downloading All...' : 'Download All MP4'}
              </button>
            </div>
            {bulkJobs.length ? (
              <div className="mt-4 space-y-2">
                {bulkJobs.map((job) => (
                  <div key={job.id} className="rounded-lg bg-zinc-50 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs font-semibold text-zinc-700">
                      <span className="truncate">{job.title || job.url}</span>
                      <span>{job.status === 'completed' ? '100%' : job.status === 'error' ? 'Failed' : `${Math.round(job.progress || 0)}%`}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200">
                      <div
                        className={job.status === 'error' ? 'h-full bg-red-500' : 'h-full bg-zinc-900 transition-all'}
                        style={{ width: `${Math.max(job.status === 'error' ? 100 : 2, job.status === 'completed' ? 100 : job.progress || 0)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">{job.error || job.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
            {bulkMessage ? (
              <p className={`mt-3 text-xs font-medium ${bulkMessage.error ? 'text-red-600' : 'text-emerald-700'}`}>
                {bulkMessage.text}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {videos.map((video, idx) => {
            if (video.isYouTube && !video.isYouTubeDirect) {
              return (
                <div key={idx} className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col col-span-1 md:col-span-2 lg:col-span-3">
                  <div className="p-6 flex flex-col md:flex-row items-center gap-6">
                    <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center flex-shrink-0">
                      <Youtube className="w-8 h-8 text-red-600" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-zinc-900">YouTube Video Detected</h3>
                      <p className="text-zinc-600 mt-1 text-sm">
                        Direct extraction is restricted by YouTube. You can download this video using our integrated third-party downloaders below.
                      </p>
                    </div>
                  </div>
                  <div className="bg-zinc-50 p-6 border-t border-zinc-100">
                    <h4 className="text-sm font-medium text-zinc-700 mb-4">Quick Download Options</h4>
                    {renderExternalOptions(video.url)}
                  </div>
                </div>
              );
            }

            const isYouTubeDirect = video.isYouTubeDirect;
            const displayTitle = isYouTubeDirect
              ? `YouTube Video Stream (${video.resolution || 'Unknown'})`
              : videoCardTitle(video, idx, videos);
            const embedded = isEmbeddedVideo(video);
            const embeddedLink = resolveEmbeddedVideoLink(video);
            const embedPreviewUrl = embedded ? resolveEmbedPreviewUrl(video) : '';
            const embeddedThumbnail = embedded ? resolveEmbeddedThumbnail(video) : '';
            const showLiveEmbed = Boolean(embedPreviewUrl && providerAllowsLocalEmbed(video));

            return (
              <div key={idx} className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col">
                <div className="aspect-video bg-zinc-900 relative group">
                  {showLiveEmbed ? (
                    <iframe
                      src={embedPreviewUrl}
                      title={displayTitle}
                      className="w-full h-full border-0"
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                      loading="lazy"
                    />
                  ) : embedded ? (
                    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
                      {embeddedThumbnail ? (
                        <img
                          src={embeddedThumbnail}
                          alt={`${displayTitle} embedded video preview`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <VideoIcon className="h-10 w-10 text-zinc-600" aria-hidden="true" />
                      )}
                    </div>
                  ) : (
                    <video
                      src={video.url}
                      controls
                      className="w-full h-full object-contain"
                      preload="metadata"
                    />
                  )}
                </div>
                <div className="p-5 flex-1 flex flex-col justify-between">
                  <div className="mb-4">
                    <h3 className="font-semibold text-zinc-900 truncate" title={displayTitle}>
                      {displayTitle}
                    </h3>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className="text-xs bg-zinc-100 text-zinc-600 px-2 py-1 rounded-md uppercase tracking-wider font-medium">
                        {video.type}
                      </span>
                      {embedded ? (
                        <span className="text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-md font-medium">
                          Embedded player
                        </span>
                      ) : null}
                      {video.resolution && video.resolution !== 'audio only' && video.resolution !== 'Unknown' && (
                        <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded-md font-medium">
                          {video.resolution}
                        </span>
                      )}
                      {video.fps && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-md font-medium">
                          {video.fps}fps
                        </span>
                      )}
                      {video.formatNote && (
                        <span className="text-xs bg-emerald-50 text-emerald-600 px-2 py-1 rounded-md font-medium">
                          {video.formatNote}
                        </span>
                      )}
                      {video.filesize && (
                        <span className="text-xs bg-orange-50 text-orange-600 px-2 py-1 rounded-md font-medium">
                          {(video.filesize / 1024 / 1024).toFixed(1)} MB
                        </span>
                      )}
                      {video.vcodec && video.vcodec !== 'none' && (
                        <span className="text-xs bg-purple-50 text-purple-600 px-2 py-1 rounded-md font-medium truncate max-w-[100px]" title={video.vcodec}>
                          {video.vcodec}
                        </span>
                      )}
                    </div>
                  </div>
                  {embedded ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => handleDownload(video, displayTitle)}
                        disabled={downloading === video.url}
                        className="w-full flex items-center justify-center gap-2 bg-zinc-900 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {downloading === video.url ? (
                          <span className="animate-pulse">Downloading MP4...</span>
                        ) : (
                          <>
                            <Download className="w-4 h-4" />
                            Download MP4
                          </>
                        )}
                      </button>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOpenEmbeddedLink(embeddedLink || video.url)}
                          className="min-w-0 flex-1 flex items-center gap-2 border border-zinc-300 bg-white text-zinc-900 px-3 py-2 rounded-xl font-medium text-xs hover:bg-zinc-50 transition-colors"
                          title={embeddedLink || video.url}
                        >
                          <ExternalLink className="w-4 h-4 shrink-0" />
                          <span className="truncate">Open Player</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopyEmbeddedLink(embeddedLink || video.url)}
                          className="shrink-0 rounded-xl border border-zinc-300 bg-white px-3 text-zinc-900 transition-colors hover:bg-zinc-50"
                          title="Copy player link"
                          aria-label="Copy player link"
                        >
                          <span className="flex items-center gap-1.5 text-xs font-semibold">
                            {copiedEmbeddedLink === (embeddedLink || video.url) ? (
                              <>
                                <Check className="h-4 w-4 text-emerald-600" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-4 w-4" />
                                Copy
                              </>
                            )}
                          </span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleDownload(video, displayTitle)}
                      disabled={downloading === video.url}
                      className="w-full flex items-center justify-center gap-2 bg-zinc-900 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {downloading === video.url ? (
                        <span className="animate-pulse">Downloading...</span>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          Download Video
                        </>
                      )}
                    </button>
                  )}
                  {downloadResult?.url === video.url ? (
                    <p className={`mt-2 text-xs font-medium ${downloadResult.error ? 'text-red-600' : 'text-emerald-700'}`}>
                      {downloadResult.message}
                    </p>
                  ) : null}
                </div>
              </div>
            );
            })}
          </div>
        </>
      )}
    </div>
  );
}
