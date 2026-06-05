import React, { Suspense, lazy, useState } from 'react';
import { FileText, MessageSquare, Search, Image as ImageIcon, Video, Type, Palette, Sparkles } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { apiFetch } from './lib/api';
import { type DownloadProgress } from './lib/download';
import { CompletionCard, FriendlyError, SmartProgressPanel, downloadMessages, extractionMessages } from './components/ProgressExperience';
import { ResponsibleUseModal } from './components/ResponsibleUseNotice';
import { buildImageZipItem, imageNeedsConversionChoice, resolveZipRasterTargetFormat } from './lib/imageAsset';
import { buildFontZipItems } from './lib/fontAsset';
import { getVisibleVideoCount } from './lib/visibleVideos';
import { buildCreativeAssetsFolderName, creativeAssetsFolderLabel } from './lib/creativeAssetsFolder';
import {
  clearPersistedClipboardUrl,
  parseClipboardUrl,
  readPersistedClipboardUrl,
  writePersistedClipboardUrl,
} from './lib/clipboardUrl';
import { getDesktopBridge } from './lib/desktopBridge';
import { fetchAppMeta } from './lib/appVersion';
import {
  fetchLatestGithubRelease,
  getSessionDismissedRelease,
  resolveReleaseDownloadUrl,
  setSessionDismissedRelease,
  shouldPromptForRelease,
  type GithubReleaseInfo,
} from './lib/githubRelease';
import { openExternalUrl } from './lib/openExternal';
import { FeedbackModal } from './components/FeedbackModal';
import { LatestReleaseModal } from './components/LatestReleaseModal';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const FontExtractor = lazy(() => import('./components/FontExtractor'));
const ImageExtractor = lazy(() => import('./components/ImageExtractor'));
const VideoExtractor = lazy(() => import('./components/VideoExtractor'));
const ColorExtractor = lazy(() => import('./components/ColorExtractor'));
const AiInsights = lazy(() => import('./components/AiInsights'));

const EXTRACT_SESSION_KEY = 'vdx.extractSession.v2';
/** Re-enable when Creative Brief is ready to ship. */
const SHOW_CREATIVE_BRIEF = false;

type ExtractSession = {
  url: string;
  extractedUrl: string;
  assets: {
    fonts: any[];
    images: any[];
    videos: any[];
    colors: string[];
  };
  activeTab?: 'fonts' | 'images' | 'videos' | 'colors' | 'insights';
  completion?: { title: string; detail?: string; size?: number; folderTarget?: string } | null;
  savedAt: number;
};

const readExtractSession = (): ExtractSession | null => {
  if (typeof window === 'undefined') return null;
  const stores: Storage[] = [];
  try {
    if (window.localStorage) stores.push(window.localStorage);
  } catch {
    // ignore
  }
  try {
    if (window.sessionStorage) stores.push(window.sessionStorage);
  } catch {
    // ignore
  }
  for (const store of stores) {
    try {
      const raw = store.getItem(EXTRACT_SESSION_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as ExtractSession;
      if (!parsed?.assets || !parsed.extractedUrl) continue;
      return parsed;
    } catch {
      // try next store
    }
  }
  return null;
};

const writeExtractSession = (session: ExtractSession) => {
  const payload = JSON.stringify(session);
  try {
    window.localStorage.setItem(EXTRACT_SESSION_KEY, payload);
  } catch {
    // localStorage may be unavailable in hardened contexts.
  }
  try {
    window.sessionStorage.setItem(EXTRACT_SESSION_KEY, payload);
  } catch {
    // best-effort mirror
  }
};

const clearExtractSession = () => {
  try {
    window.localStorage.removeItem(EXTRACT_SESSION_KEY);
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(EXTRACT_SESSION_KEY);
  } catch {
    // ignore
  }
};

const restoredExtractSession = readExtractSession();
const restoredClipboardUrl = readPersistedClipboardUrl();
const initialUrl =
  restoredExtractSession?.url ||
  restoredExtractSession?.extractedUrl ||
  restoredClipboardUrl ||
  '';

const preloadExtractorChunks = () => {
  void import('./components/ImageExtractor');
  void import('./components/FontExtractor');
  void import('./components/VideoExtractor');
  void import('./components/ColorExtractor');
  if (SHOW_CREATIVE_BRIEF) void import('./components/AiInsights');
};

const isRenderableVideo = (video: any) => {
  const url = String(video?.url || '');
  const type = String(video?.type || '').toLowerCase();
  const provider = String(video?.provider || '').toLowerCase();
  if (!url) return false;
  if (video?.isVimeoDirect || video?.isYouTubeDirect) return true;
  if (video?.isDirect) return true;
  if (provider === 'platform' && type === 'video') return true;
  if (type === 'video') return true;
  if (type === 'mp4' || type === 'webm' || type === 'mov' || type === 'mkv') return true;
  if (provider === 'instagram' || provider === 'facebook' || provider === 'x' || provider === 'twitter' || provider === 'tiktok' || provider === 'vimeo' || provider === 'youtube') return true;
  return /(\.mp4|\.webm|\.mov|\.mkv)(\?|$)/i.test(url);
};

const isSupportedVideoPlatformUrl = (rawUrl: string) => {
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

export default function App() {
  const [url, setUrl] = useState(initialUrl);
  const [extractedUrl, setExtractedUrl] = useState(restoredExtractSession?.extractedUrl || '');
  const [activeTab, setActiveTab] = useState<'fonts' | 'images' | 'videos' | 'colors' | 'insights'>(() => {
    const tab = restoredExtractSession?.activeTab;
    if (tab === 'insights' && !SHOW_CREATIVE_BRIEF) return 'images';
    return tab || 'images';
  });
  const [loading, setLoading] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadAllProgress, setDownloadAllProgress] = useState<DownloadProgress | null>(null);
  const [retryingExtract, setRetryingExtract] = useState(false);
  const [completion, setCompletion] = useState<{ title: string; detail?: string; size?: number; folderTarget?: string } | null>(
    restoredExtractSession?.completion || null
  );
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<{
    fonts: any[];
    images: any[];
    videos: any[];
    colors: string[];
  } | null>(restoredExtractSession?.assets || null);
  const [insightsData, setInsightsData] = useState<any | null>(null);
  const [insightsUrl, setInsightsUrl] = useState('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [manualResolvedVideoCount, setManualResolvedVideoCount] = useState(0);
  const [responsibleUseOpen, setResponsibleUseOpen] = useState(false);
  const [responsibleUseContext, setResponsibleUseContext] = useState<'firstLaunch' | 'about'>('firstLaunch');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseViewMode, setReleaseViewMode] = useState<'update' | 'notes'>('update');
  const [latestRelease, setLatestRelease] = useState<GithubReleaseInfo | null>(null);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [productName, setProductName] = useState('Creative Asset Extractor');
  const releaseCheckedRef = React.useRef(false);
  const extractJobSeq = React.useRef(0);
  const extractAbortRef = React.useRef<AbortController | null>(null);
  const userEditedUrlRef = React.useRef(false);
  const lastAutoFilledUrlRef = React.useRef(initialUrl.trim());
  const [pendingClipboardUrl, setPendingClipboardUrl] = useState<string | null>(null);
  const [clipboardDetected, setClipboardDetected] = useState(false);
  const clipboardNoticeTimerRef = React.useRef<number | null>(null);

  const showClipboardDetectedNotice = React.useCallback(() => {
    setClipboardDetected(true);
    if (clipboardNoticeTimerRef.current) {
      window.clearTimeout(clipboardNoticeTimerRef.current);
    }
    clipboardNoticeTimerRef.current = window.setTimeout(() => {
      setClipboardDetected(false);
      clipboardNoticeTimerRef.current = null;
    }, 5000);
  }, []);

  const applyDetectedClipboardUrl = React.useCallback((raw: string) => {
    const parsed = parseClipboardUrl(raw);
    if (!parsed) return;

    writePersistedClipboardUrl(parsed);

    setUrl((current) => {
      const trimmed = String(current || '').trim();
      if (!trimmed) {
        lastAutoFilledUrlRef.current = parsed;
        userEditedUrlRef.current = false;
        setPendingClipboardUrl(null);
        showClipboardDetectedNotice();
        return parsed;
      }

      if (!userEditedUrlRef.current && (trimmed === lastAutoFilledUrlRef.current || trimmed === parsed)) {
        lastAutoFilledUrlRef.current = parsed;
        setPendingClipboardUrl(null);
        showClipboardDetectedNotice();
        return parsed;
      }

      if (trimmed !== parsed) {
        setPendingClipboardUrl(parsed);
      } else {
        setPendingClipboardUrl(null);
      }
      return current;
    });
  }, [showClipboardDetectedNotice]);

  const refreshClipboardUrl = React.useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    try {
      const text = await bridge.readClipboardText();
      applyDetectedClipboardUrl(text);
    } catch {
      // Clipboard access is best-effort.
    }
  }, [applyDetectedClipboardUrl]);

  const handleUseClipboardUrl = () => {
    if (!pendingClipboardUrl) return;
    setUrl(pendingClipboardUrl);
    lastAutoFilledUrlRef.current = pendingClipboardUrl;
    userEditedUrlRef.current = false;
    writePersistedClipboardUrl(pendingClipboardUrl);
    setPendingClipboardUrl(null);
    showClipboardDetectedNotice();
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    const trimmed = value.trim();
    if (trimmed !== lastAutoFilledUrlRef.current) {
      userEditedUrlRef.current = true;
      setPendingClipboardUrl(null);
    }
  };

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem('vdx.responsibleUseAcknowledged.v1') !== 'yes') {
        setResponsibleUseContext('firstLaunch');
        setResponsibleUseOpen(true);
      }
    } catch {
      setResponsibleUseOpen(true);
    }
    if (restoredExtractSession?.assets) {
      preloadExtractorChunks();
    }
    void refreshClipboardUrl();
    void fetchAppMeta().then((meta) => {
      setAppVersion(meta.version);
      setProductName(meta.productName);
    });
  }, [refreshClipboardUrl]);

  React.useEffect(() => {
    if (releaseCheckedRef.current) return;
    releaseCheckedRef.current = true;

    void (async () => {
      try {
        const meta = await fetchAppMeta();
        setAppVersion(meta.version);
        setProductName(meta.productName);
        const release = await fetchLatestGithubRelease();
        if (!release?.tagName) return;
        const dismissed = getSessionDismissedRelease();
        if (!shouldPromptForRelease(release.tagName, meta.version, dismissed)) return;
        setLatestRelease(release);
        setReleaseViewMode('update');
        setReleaseOpen(true);
      } catch {
        // Release checks are best-effort on launch.
      }
    })();
  }, []);

  React.useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return undefined;
    const unsubscribe = bridge.onClipboardUrl((payload) => {
      if (payload?.url) {
        applyDetectedClipboardUrl(payload.url);
        return;
      }
      void refreshClipboardUrl();
    });
    return unsubscribe;
  }, [applyDetectedClipboardUrl, refreshClipboardUrl]);

  React.useEffect(() => {
    const handleWindowFocus = () => {
      void refreshClipboardUrl();
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [refreshClipboardUrl]);

  React.useEffect(() => {
    return () => {
      if (clipboardNoticeTimerRef.current) {
        window.clearTimeout(clipboardNoticeTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!assets || !extractedUrl) return;
    writeExtractSession({
      url: extractedUrl,
      extractedUrl,
      assets,
      activeTab,
      completion,
      savedAt: Date.now(),
    });
  }, [assets, extractedUrl, activeTab, completion]);

  React.useEffect(() => {
    if (!loading) return;
    const watchdog = window.setTimeout(() => {
      extractAbortRef.current?.abort();
      setLoading(false);
      setRetryingExtract(false);
      setError('Extraction took too long. Click Extract again to retry with the lightweight scan.');
    }, 120000);
    return () => window.clearTimeout(watchdog);
  }, [loading]);

  const openReleaseNotes = async () => {
    setReleaseViewMode('notes');
    try {
      const release = latestRelease || (await fetchLatestGithubRelease());
      setLatestRelease(release);
    } catch {
      // Release notes are best-effort.
    }
    setReleaseOpen(true);
  };

  const closeResponsibleUseNotice = async () => {
    try {
      window.localStorage.setItem('vdx.responsibleUseAcknowledged.v1', 'yes');
    } catch {
      // localStorage may be unavailable in hardened browser contexts.
    }
    try {
      await apiFetch('/api/responsible-use-acknowledgement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: responsibleUseContext }),
      });
    } catch (error) {
      console.warn('Responsible use acknowledgement file could not be saved:', error);
    }
    setResponsibleUseOpen(false);
  };

  const parseApiBody = async (response: Response) => {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        return { error: 'Server returned invalid JSON.' };
      }
    }
    return { error: text || 'Unexpected server response.' };
  };

  const openFolder = async (target = 'downloads', sourcePageUrl?: string) => {
    try {
      await apiFetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          sourcePageUrl: sourcePageUrl || extractedUrl || undefined,
        }),
      });
    } catch {
      // Browsers do not expose download folders directly; keep this as a best-effort local shortcut.
    }
  };

  const handleNewExtraction = () => {
    extractAbortRef.current?.abort();
    extractJobSeq.current += 1;
    setUrl('');
    setExtractedUrl('');
    setAssets(null);
    setCompletion(null);
    setError(null);
    setLoading(false);
    setRetryingExtract(false);
    setDownloadingAll(false);
    setDownloadAllProgress(null);
    setInsightsData(null);
    setInsightsUrl('');
    setManualResolvedVideoCount(0);
    setPendingClipboardUrl(null);
    setClipboardDetected(false);
    userEditedUrlRef.current = false;
    lastAutoFilledUrlRef.current = '';
    clearExtractSession();
    clearPersistedClipboardUrl();
    void refreshClipboardUrl();
  };

  const friendlyExtractionError = (message: string) => {
    const text = String(message || '').trim();
    if (/failed to fetch|network error|connection refused|could not connect|ERR_CONNECTION|load failed/i.test(text)) {
      return 'The app could not reach its local server. Quit and reopen the app (or reinstall from the DMG), then try Extract again.';
    }
    if (/timed out|aborted/i.test(text)) {
      return 'The full browser scan took too long. Click Extract again — the app will use a faster cached HTML pass automatically.';
    }
    if (/blocking|403|401|forbidden/i.test(text)) {
      return 'The source appears to be blocking automated requests. Try the direct video tab or paste the media URL into Search & Download.';
    }
    if (/paused the response|alternate pass/i.test(text)) {
      return text;
    }
    return text || 'Extraction could not finish. Click Extract again to retry with the lightweight scan.';
  };

  const runExtractRequest = async (signal?: AbortSignal, mode?: 'static') => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    const timeoutMs = mode === 'static' ? 45000 : 90000;
    const timeoutId = window.setTimeout(abortRequest, timeoutMs);
    signal?.addEventListener('abort', abortRequest, { once: true });

    try {
      const response = await apiFetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'static' ? { url, mode: 'static' } : { url }),
        signal: requestController.signal,
      });

      const data = await parseApiBody(response);
      if (!response.ok) {
        throw new Error(data.error || 'Failed to extract assets');
      }
      return data;
    } catch (error: any) {
      if (error?.name === 'AbortError' && !signal?.aborted) {
        throw new Error('Extraction timed out. Try again or paste a direct media URL.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortRequest);
    }
  };

  const handleExtract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError(null);
    setAssets(null);
    clearExtractSession();
    setCompletion(null);
    setRetryingExtract(false);
    setManualResolvedVideoCount(0);
    extractAbortRef.current?.abort();
    const controller = new AbortController();
    extractAbortRef.current = controller;
    const jobId = extractJobSeq.current + 1;
    extractJobSeq.current = jobId;
    const isCurrentJob = () => extractJobSeq.current === jobId;

    try {
      let data;
      try {
        data = await runExtractRequest(controller.signal);
      } catch (firstError: any) {
        if (controller.signal.aborted) throw firstError;
        setRetryingExtract(true);
        data = await runExtractRequest(controller.signal, 'static');
      }
      if (!isCurrentJob() || controller.signal.aborted) return;
      const normalizedExtractUrl = parseClipboardUrl(url) || url.trim();
      if (normalizedExtractUrl) {
        writePersistedClipboardUrl(normalizedExtractUrl);
        lastAutoFilledUrlRef.current = normalizedExtractUrl;
      }
      const extractedVideos = Array.isArray(data?.videos) ? data.videos : [];
      const hasRenderableVideo = extractedVideos.some(isRenderableVideo);
      const seededVideos =
        !hasRenderableVideo && isSupportedVideoPlatformUrl(url)
          ? [
              ...extractedVideos,
              {
                url,
                sourceUrl: url,
                provider: 'platform',
                type: 'video',
                title: 'Video link',
              },
            ]
          : extractedVideos;

      const nextTab =
        isSupportedVideoPlatformUrl(url) && seededVideos.length > 0 ? 'videos' : 'images';
      setAssets({
        ...data,
        videos: seededVideos,
      });
      setExtractedUrl(url);
      setInsightsData(null);
      setInsightsUrl('');
      setActiveTab(nextTab);
      preloadExtractorChunks();
      const nextCompletion = {
        title: 'Extraction complete',
        detail: `${(data?.images?.length || 0) + (data?.fonts?.length || 0) + (seededVideos?.length || 0) + (data?.colors?.length || 0)} assets are ready in ${buildCreativeAssetsFolderName(url)}.`,
        folderTarget: 'downloads' as const,
      };
      writeExtractSession({
        url,
        extractedUrl: url,
        assets: {
          ...data,
          videos: seededVideos,
        },
        activeTab: nextTab,
        completion: nextCompletion,
        savedAt: Date.now(),
      });
      setCompletion(nextCompletion);
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(friendlyExtractionError(err.message));
    } finally {
      if (isCurrentJob()) {
        setLoading(false);
        setRetryingExtract(false);
      }
    }
  };

  const handleDownloadAll = async () => {
    if (!assets) return;

    setDownloadingAll(true);
    setDownloadAllProgress(null);
    setCompletion(null);
    try {
      const items = [
        ...assets.images.map((img, idx) =>
          buildImageZipItem(
            img,
            idx,
            imageNeedsConversionChoice(img) ? resolveZipRasterTargetFormat(img, {}) : undefined
          )
        ),
        ...assets.fonts.flatMap((font) => buildFontZipItems(font)),
        ...assets.videos
          .filter((video) => !video.isYouTube && !video.isVimeo)
          .map((video) => ({ url: video.url, assetType: 'video' as const })),
      ];

      if (items.length === 0) {
        alert("No assets found to download.");
        return;
      }

      const response = await apiFetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          save: true,
          filename: 'all-assets.zip',
          sourcePageUrl: extractedUrl || undefined,
        }),
      });

      const saved = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(saved?.error || 'Zip download failed');
      if (!saved?.downloadPath && !saved?.localPath) {
        throw new Error('ZIP was created but the app did not return a Downloads path.');
      }
      setCompletion({
        title: 'Download package ready',
        detail: `All assets saved to ${creativeAssetsFolderLabel(extractedUrl, 'Images')} as ${saved.filename || 'all-assets.zip'}.`,
        size: saved.size,
        folderTarget: 'downloads',
      });
    } catch (error) {
      console.error('Download all error:', error);
      setError('Reconnecting download stream did not finish. Please try the ZIP download again.');
    } finally {
      setDownloadingAll(false);
      setDownloadAllProgress(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans selection:bg-blue-100 selection:text-blue-900">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center font-bold text-xl shrink-0">
                  C
                </div>
                <h1 className="truncate text-xl font-semibold tracking-tight">{productName}</h1>
              </div>
              <span className="text-xs text-zinc-500">v{appVersion.replace(/^v/i, '')}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Send feedback
              </button>
              <button
                type="button"
                onClick={() => void openReleaseNotes()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50"
              >
                <FileText className="h-3.5 w-3.5" />
                Release note
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-3xl mx-auto mb-12">
          <form onSubmit={handleExtract} className="relative">
            <div className="relative flex items-center">
              <Search className="absolute left-4 w-5 h-5 text-zinc-400" />
              <input
                type="url"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="Enter website URL (e.g., https://example.com)"
                className="w-full pl-12 pr-32 py-4 bg-white border border-zinc-200 rounded-2xl shadow-sm text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                required
              />
              <button
                type="submit"
                disabled={loading || !url}
                className={cn(
                  "absolute right-2 top-2 bottom-2 px-6 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2",
                  loading && "bg-blue-500"
                )}
              >
                {loading ? 'Extracting' : 'Extract'}
              </button>
            </div>
          </form>

          {(clipboardDetected || pendingClipboardUrl) ? (
            <div className="mt-3 flex flex-col gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">Copied URL detected</p>
                {pendingClipboardUrl ? (
                  <p className="mt-0.5 truncate text-xs text-blue-700/90" title={pendingClipboardUrl}>
                    {pendingClipboardUrl}
                  </p>
                ) : null}
              </div>
              {pendingClipboardUrl ? (
                <button
                  type="button"
                  onClick={handleUseClipboardUrl}
                  className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700"
                >
                  Use URL
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 space-y-3">
            <SmartProgressPanel
              active={loading}
              mode="extract"
              title={retryingExtract ? 'Retrying with lightweight extraction' : 'Extracting creative assets'}
              detail={retryingExtract ? 'Using cached HTML and CSS scan' : 'Fast scan — previews cache in the background'}
              messages={extractionMessages}
            />
            <SmartProgressPanel
              active={downloadingAll}
              mode="download"
              title="Creating your asset ZIP"
              detail="Packing cached assets from extraction (no re-fetch)"
              messages={downloadMessages}
              progress={downloadAllProgress?.percent}
              loadedBytes={downloadAllProgress?.loaded}
              totalBytes={downloadAllProgress?.total}
              speedBps={downloadAllProgress?.speedBps}
              etaSeconds={downloadAllProgress?.etaSeconds}
            />
            {completion && !loading && !downloadingAll ? (
              <CompletionCard
                title={completion.title}
                detail={completion.detail}
                size={completion.size}
                onOpenFolder={completion.folderTarget ? () => openFolder(completion.folderTarget) : undefined}
              />
            ) : null}
          </div>

          {error && (
            <div className="mt-4">
              <FriendlyError message={error} retrying={retryingExtract} />
            </div>
          )}
        </div>

        {assets && (
          <div className="space-y-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-zinc-600">
                Project folder: <span className="font-medium text-zinc-900">{creativeAssetsFolderLabel(extractedUrl)}</span>
              </p>
              <button
                type="button"
                onClick={handleNewExtraction}
                className="inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
              >
                New Extraction
              </button>
            </div>
            <div className="flex items-center justify-center gap-2 border-b border-zinc-200 pb-px mb-8">
              <TabButton
                active={activeTab === 'images'}
                onClick={() => setActiveTab('images')}
                icon={<ImageIcon className="w-4 h-4" />}
                label="Images"
                count={assets.images.length}
              />
              <TabButton
                active={activeTab === 'fonts'}
                onClick={() => setActiveTab('fonts')}
                icon={<Type className="w-4 h-4" />}
                label="Fonts"
                count={assets.fonts.length}
              />
              <TabButton
                active={activeTab === 'videos'}
                onClick={() => setActiveTab('videos')}
                icon={<Video className="w-4 h-4" />}
                label="Videos"
                count={getVisibleVideoCount(assets.videos, extractedUrl)}
              />
              <TabButton
                active={activeTab === 'colors'}
                onClick={() => setActiveTab('colors')}
                icon={<Palette className="w-4 h-4" />}
                label="Colors"
                count={assets.colors.length}
              />
              {SHOW_CREATIVE_BRIEF ? (
                <TabButton
                  active={activeTab === 'insights'}
                  onClick={() => setActiveTab('insights')}
                  icon={<Sparkles className="w-4 h-4" />}
                  label="Creative Brief"
                />
              ) : null}
            </div>

            <Suspense
              fallback={
                <div className="min-h-[400px] flex items-center justify-center text-zinc-500">
                  Loading section
                </div>
              }
            >
              <div className="min-h-[400px]">
                <div className={activeTab === 'images' ? '' : 'hidden'}>
                  <ImageExtractor images={assets.images} sourcePageUrl={extractedUrl} />
                </div>
                <div className={activeTab === 'fonts' ? '' : 'hidden'}>
                  <FontExtractor fonts={assets.fonts} sourcePageUrl={extractedUrl} />
                </div>
                <div className={activeTab === 'videos' ? '' : 'hidden'}>
                  <VideoExtractor
                    videos={(insightsData?.videos?.length ? insightsData.videos : assets.videos) || []}
                    loadingInsights={insightsLoading}
                    seedUrl={extractedUrl}
                    onManualResolvedCountChange={setManualResolvedVideoCount}
                  />
                </div>
                <div className={activeTab === 'colors' ? '' : 'hidden'}>
                  <ColorExtractor colors={assets.colors} />
                </div>
                {SHOW_CREATIVE_BRIEF ? (
                  <div className={activeTab === 'insights' ? '' : 'hidden'}>
                    <AiInsights
                      url={extractedUrl}
                      preloadedInsights={insightsUrl === extractedUrl ? insightsData : null}
                      fallbackAssets={assets}
                    />
                  </div>
                ) : null}
              </div>
            </Suspense>
          </div>
        )}
      </main>

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <LatestReleaseModal
        open={releaseOpen}
        viewMode={releaseViewMode}
        productName={productName}
        currentVersion={appVersion}
        release={latestRelease}
        onDownload={() => {
          const downloadUrl = resolveReleaseDownloadUrl(latestRelease);
          if (downloadUrl) void openExternalUrl(downloadUrl);
          setReleaseOpen(false);
        }}
        onLater={() => {
          if (releaseViewMode === 'update' && latestRelease?.tagName) {
            setSessionDismissedRelease(latestRelease.tagName);
          }
          setReleaseOpen(false);
        }}
      />
      <ResponsibleUseModal
        open={responsibleUseOpen}
        context={responsibleUseContext}
        onClose={closeResponsibleUseNotice}
      />
    </div>
  );
}

function TabButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-blue-600 text-blue-600"
          : "border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300"
      )}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span className={cn(
          "ml-1.5 py-0.5 px-2 rounded-full text-xs",
          active ? "bg-blue-100 text-blue-700" : "bg-zinc-100 text-zinc-600"
        )}>
          {count}
        </span>
      )}
    </button>
  );
}
