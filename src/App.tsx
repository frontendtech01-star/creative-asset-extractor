import React, { Suspense, lazy, useState } from 'react';
import { FileText, MessageSquare, Image as ImageIcon, Type, Palette, Sparkles, Download, Globe, Video } from 'lucide-react';
import { WebsiteExtracterToolbar } from './components/WebsitePreviewPanel';
import VideoDownloaderPage from './components/VideoDownloaderPage';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { apiFetch } from './lib/api';
import { type DownloadProgress } from './lib/download';
import { CompletionCard, FriendlyError, SmartProgressPanel, downloadMessages } from './components/ProgressExperience';
import {
  WebsiteExtractProgressPanel,
  type WebsiteCrawlMode,
  type WebsiteExtractPhase,
} from './components/WebsiteExtractProgressPanel';
import { ResponsibleUseModal } from './components/ResponsibleUseNotice';
import { useExtractionProgress } from './lib/extractionWs';
import { buildImageZipItem, imageNeedsConversionChoice, resolveZipRasterTargetFormat } from './lib/imageAsset';
import { buildFontZipItems } from './lib/fontAsset';
import {
  isYouTubeExtractUrl,
} from './lib/visibleVideos';
import { buildCreativeAssetsFolderName, creativeAssetsFolderLabel } from './lib/creativeAssetsFolder';
import {
  clearPersistedClipboardUrl,
  parseClipboardUrl,
} from './lib/clipboardUrl';
import { getDesktopBridge } from './lib/desktopBridge';
import { resolveWebsitePreviewUrl } from './lib/websitePreview';
import { fetchAppMeta } from './lib/appVersion';
import {
  fetchLatestGithubRelease,
  fetchReleaseNotes,
  getSessionDismissedRelease,
  resolveReleaseDownloadUrl,
  setSessionDismissedRelease,
  shouldPromptForRelease,
  type GithubReleaseInfo,
} from './lib/githubRelease';
import { openExternalUrl } from './lib/openExternal';
import { FeedbackModal } from './components/FeedbackModal';
import { logActivity, reportOperationFailure } from './lib/activityLog';
import { consumeFeedbackDraft, type FeedbackDraft } from './lib/feedbackContext';
import { LatestReleaseModal } from './components/LatestReleaseModal';
import {
  readMainSection,
  writeMainSection,
  type MainSection,
} from './lib/appSessions';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const FontExtractor = lazy(() => import('./components/FontExtractor'));
const ImageExtractor = lazy(() => import('./components/ImageExtractor'));
const VideoExtractor = lazy(() => import('./components/VideoExtractor'));
const ColorExtractor = lazy(() => import('./components/ColorExtractor'));
const AiInsights = lazy(() => import('./components/AiInsights'));

const EXTRACT_SESSION_KEY = 'vdx.websiteExtractionSession.v1';
/** Re-enable when Creative Brief is ready to ship. */
const SHOW_CREATIVE_BRIEF = false;

type ExtractSession = {
  url: string;
  extractedUrl: string;
  assets: {
    fonts: any[];
    images: any[];
    icons?: any[];
    videos: any[];
    colors: string[];
    extractionMeta?: { mode?: string; sectionLabel?: string; sectionSelector?: string };
  };
  activeTab?: 'fonts' | 'images' | 'icons' | 'videos' | 'colors' | 'insights';
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

const initialUrl = '';
const preloadExtractorChunks = () => {
  void import('./components/ImageExtractor');
  void import('./components/FontExtractor');
  void import('./components/ColorExtractor');
  if (SHOW_CREATIVE_BRIEF) void import('./components/AiInsights');
};

const mergeImageAssets = (images: any[] = [], icons: any[] = []) => {
  const seen = new Set<string>();
  const merged: any[] = [];
  [...images, ...icons].forEach((item) => {
    const key = String(item?.url || item?.src || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
};

const isTechnicalPlayerResourceUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim().toLowerCase();
  if (!value) return true;
  if (/\.(?:js|mjs|css|json|map|xml|txt|ico)(?:[?#]|$)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (host === 'youtube.com' || host.endsWith('.youtube.com')) && (
      path === '/iframe_api' ||
      path.includes('/www-widgetapi') ||
      path.startsWith('/s/player/') ||
      path.startsWith('/youtubei/') ||
      path.startsWith('/api/')
    );
  } catch {
    return false;
  }
};

const sanitizeVideoAssets = (videos: any[] = []) =>
  videos.filter((video) => {
    const candidates = [
      video?.url,
      video?.embedUrl,
      video?.sourceStreamUrl,
      video?.downloadUrl,
      video?.originalUrl,
      video?.sourceUrl,
      video?.pageUrl,
    ];
    return !candidates.some((candidate) => typeof candidate === 'string' && isTechnicalPlayerResourceUrl(candidate));
  });

const normalizeExtracterTab = (tab?: string): 'fonts' | 'images' | 'videos' | 'colors' => {
  if (tab === 'fonts' || tab === 'videos' || tab === 'colors') return tab;
  return 'images';
};

const hasExtractedAssets = (data: any) => {
  const images = mergeImageAssets(data?.images, data?.icons);
  return (
    images.length > 0 ||
    (Array.isArray(data?.videos) && data.videos.length > 0) ||
    (Array.isArray(data?.fonts) && data.fonts.length > 0) ||
    (Array.isArray(data?.colors) && data.colors.length > 0)
  );
};

const normalizeExtractColors = (colors: unknown) =>
  Array.from(new Set(Array.isArray(colors) ? colors.map((color) => String(color || '').trim()).filter(Boolean) : [])).slice(0, 6);

type PreviewCapturedAsset = {
  url: string;
  dataUrl?: string;
  filename?: string;
  width?: number;
  height?: number;
  type?: string;
  mimeType?: string;
  alt?: string;
};

type PreviewCaptureResult = {
  ok?: boolean;
  url?: string;
  title?: string;
  images?: PreviewCapturedAsset[];
  fonts?: any[];
  videos?: any[];
  colors?: string[];
  error?: string;
};

const buildPreviewCaptureScript = () => `
(async () => {
  const absoluteUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw || raw === 'none') return '';
    try { return new URL(raw, location.href).href; } catch { return ''; }
  };
  const filenameFromUrl = (value, fallback) => {
    try {
      const parsed = new URL(value);
      const leaf = parsed.pathname.split('/').filter(Boolean).pop();
      return leaf || fallback;
    } catch {
      return fallback;
    }
  };
  const typeFromUrl = (value, mime) => {
    const contentType = String(mime || '').toLowerCase();
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('svg')) return 'svg';
    const match = String(value || '').match(/\\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    return (match?.[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
  };
  const blobToDataUrl = (blob) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
  const fetchDataUrl = async (value) => {
    const target = absoluteUrl(value);
    if (!target || target.startsWith('data:')) return target;
    try {
      const response = await fetch(target, { credentials: 'include', cache: 'force-cache' });
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!response.ok || !contentType.startsWith('image/')) return '';
      const blob = await response.blob();
      if (!blob.size || blob.size > 12000000) return '';
      return await blobToDataUrl(blob);
    } catch {
      return '';
    }
  };
  const imageMap = new Map();
  const addImage = (value, meta = {}) => {
    const target = absoluteUrl(value);
    if (!target || imageMap.has(target)) return;
    imageMap.set(target, {
      url: target,
      filename: filenameFromUrl(target, 'preview-image.png'),
      width: Number(meta.width || 0) || undefined,
      height: Number(meta.height || 0) || undefined,
      alt: String(meta.alt || '').trim(),
      type: typeFromUrl(target),
    });
  };
  const readCssUrls = (value) => {
    const urls = [];
    String(value || '').replace(/url\\((['"]?)(.*?)\\1\\)/gi, (_match, _quote, inner) => {
      const target = absoluteUrl(inner);
      if (target) urls.push(target);
      return '';
    });
    return urls;
  };

  Array.from(document.images || []).forEach((img) => {
    addImage(img.currentSrc || img.src, {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      alt: img.alt,
    });
  });

  Array.from(document.querySelectorAll('source[srcset], img[srcset]')).forEach((el) => {
    String(el.getAttribute('srcset') || '').split(',').forEach((part) => {
      addImage(part.trim().split(/\\s+/)[0]);
    });
  });

  Array.from(document.querySelectorAll('*')).forEach((el) => {
    const style = getComputedStyle(el);
    [style.backgroundImage, style.listStyleImage, style.borderImageSource].forEach((value) => {
      readCssUrls(value).forEach((target) => addImage(target));
    });
  });

  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    const name = absoluteUrl(entry.name);
    const initiator = String(entry.initiatorType || '').toLowerCase();
    if (!name) return;
    if (initiator === 'img' || /\\.(png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.test(name)) {
      addImage(name);
    }
  });

  const images = await Promise.all(
    Array.from(imageMap.values()).slice(0, 120).map(async (item) => {
      const dataUrl = await fetchDataUrl(item.url);
      const mimeType = dataUrl.match(/^data:([^;]+);/)?.[1] || '';
      return {
        ...item,
        dataUrl: dataUrl || undefined,
        mimeType,
        type: typeFromUrl(item.url, mimeType),
      };
    })
  );

  const fontUrls = new Set();
  Array.from(document.querySelectorAll('link[href]')).forEach((link) => {
    const rel = String(link.getAttribute('rel') || '').toLowerCase();
    const href = absoluteUrl(link.getAttribute('href'));
    if (!href) return;
    if (rel.includes('stylesheet') || rel.includes('preload') || /fonts|typekit|\\.woff2?|\\.ttf|\\.otf/i.test(href)) {
      fontUrls.add(href);
    }
  });
  Array.from(document.styleSheets || []).forEach((sheet) => {
    const href = absoluteUrl(sheet.href);
    if (href && /fonts|typekit|\\.woff2?|\\.ttf|\\.otf/i.test(href)) fontUrls.add(href);
  });
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    const name = absoluteUrl(entry.name);
    if (/fonts|typekit|\\.woff2?|\\.ttf|\\.otf/i.test(name)) fontUrls.add(name);
  });

  const videoUrls = new Set();
  Array.from(document.querySelectorAll('video[src], video source[src], iframe[src]')).forEach((el) => {
    const src = absoluteUrl(el.getAttribute('src'));
    if (src) videoUrls.add(src);
  });
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    const name = absoluteUrl(entry.name);
    if (/\\.(mp4|m3u8|webm|mov)(?:[?#]|$)|youtube\\.com|vimeo\\.com/i.test(name)) videoUrls.add(name);
  });

  const colorCounts = new Map();
  const addColor = (value) => {
    const match = String(value || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
    if (!match) return;
    const parts = [match[1], match[2], match[3]].map((part) => Math.max(0, Math.min(255, Number(part || 0))));
    if (parts.every((part) => part >= 248) || parts.every((part) => part <= 7)) return;
    const hex = '#' + parts.map((part) => part.toString(16).padStart(2, '0')).join('');
    colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
  };
  Array.from(document.querySelectorAll('*')).slice(0, 1500).forEach((el) => {
    const style = getComputedStyle(el);
    addColor(style.color);
    addColor(style.backgroundColor);
    addColor(style.borderTopColor);
  });

  return {
    ok: true,
    url: location.href,
    title: document.title || location.href,
    images,
    fonts: Array.from(fontUrls).map((url) => ({ url, name: filenameFromUrl(url, 'font'), type: typeFromUrl(url) })),
    videos: Array.from(videoUrls).map((url) => ({ url, title: filenameFromUrl(url, 'video') })),
    colors: Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([color]) => color),
  };
})()
`;

const mergeExtractPayload = (base: any, incoming: any) => {
  const mergeListByUrl = (left: any[] = [], right: any[] = [], key = 'url') => {
    const map = new Map<string, any>();
    [...left, ...right].forEach((item) => {
      const itemKey = String(item?.[key] || item?.src || '').trim();
      if (!itemKey) return;
      map.set(itemKey, item);
    });
    return Array.from(map.values());
  };

  const baseImages = mergeImageAssets(base?.images, base?.icons);
  const incomingImages = mergeImageAssets(incoming?.images, incoming?.icons);

  return {
    images: mergeListByUrl(baseImages, incomingImages),
    videos: sanitizeVideoAssets(mergeListByUrl(base?.videos, incoming?.videos)),
    fonts: mergeListByUrl(base?.fonts, incoming?.fonts),
    colors: normalizeExtractColors(
      Array.isArray(incoming?.colors) && incoming.colors.length > 0 ? incoming.colors : base?.colors
    ),
    icons: [],
    extractionMeta: incoming?.extractionMeta || base?.extractionMeta,
  };
};

const htmlNeedsRenderedRetry = (rawUrl: string, data: any, imageCount: number) => {
  const url = String(rawUrl || '').trim().toLowerCase();
  if (/vimeo\.com\/?$/.test(url) || url === 'https://vimeo.com' || url === 'https://www.vimeo.com') {
    return imageCount < 8;
  }
  if (/fabindia\.com/.test(url)) {
    return imageCount < 35;
  }
  if (/sap-commerce|hybris|medias\/sys_master|data-src/i.test(url)) {
    return imageCount < 25;
  }
  const videoCount = Array.isArray(data?.videos) ? data.videos.length : 0;
  if (/vimeo\.com/.test(url) && videoCount === 0 && imageCount < 12) return true;
  return imageCount > 0 && imageCount < 12;
};

export default function App() {
  const [mainSection, setMainSection] = useState<MainSection>(readMainSection());
  const [url, setUrl] = useState(initialUrl);
  const [extractedUrl, setExtractedUrl] = useState('');
  const [activeTab, setActiveTab] = useState<'fonts' | 'images' | 'videos' | 'colors' | 'insights'>('images');
  const [loading, setLoading] = useState(false);
  const [previewCapturing, setPreviewCapturing] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [downloadAllProgress, setDownloadAllProgress] = useState<DownloadProgress | null>(null);
  const [assetStateVersion, setAssetStateVersion] = useState(0);
  const [retryingExtract, setRetryingExtract] = useState(false);
  const [extractPartial, setExtractPartial] = useState(false);
  const [extractPhase, setExtractPhase] = useState<WebsiteExtractPhase>('loading');
  const [crawlMode, setCrawlMode] = useState<WebsiteCrawlMode>('fast');
  const finishNowRef = React.useRef(false);
  const partialExtractRef = React.useRef<any>(null);
  const extractPhaseTimerRef = React.useRef<number | null>(null);
  const wsProgress = useExtractionProgress(loading);
  const wsProgressRef = React.useRef(wsProgress);
  wsProgressRef.current = wsProgress;
  const [completion, setCompletion] = useState<{ title: string; detail?: string; size?: number; folderTarget?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<{
    fonts: any[];
    images: any[];
    icons: any[];
    videos: any[];
    colors: string[];
    extractionMeta?: { mode?: string; sectionLabel?: string; sectionSelector?: string };
  } | null>(null);
  const [validImageCount, setValidImageCount] = useState(0);
  const [insightsData, setInsightsData] = useState<any | null>(null);
  const [insightsUrl, setInsightsUrl] = useState('');
  const [responsibleUseOpen, setResponsibleUseOpen] = useState(false);
  const [responsibleUseContext, setResponsibleUseContext] = useState<'firstLaunch' | 'about'>('firstLaunch');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft | null>(null);
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

  React.useEffect(() => {
    if (!assets?.videos?.length) return;
    const cleanVideos = sanitizeVideoAssets(assets.videos);
    if (cleanVideos.length === assets.videos.length) return;
    setAssets({ ...assets, videos: cleanVideos });
    setAssetStateVersion((version) => version + 1);
  }, [assets]);
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

  const handleExtractFromOpenWebsite = async () => {
    const target = resolveWebsitePreviewUrl(url);
    if (!target) {
      setError('Enter a public website URL to extract.');
      return;
    }
    setUrl(target);
    lastAutoFilledUrlRef.current = target;
    userEditedUrlRef.current = false;
    setPendingClipboardUrl(null);

    setPreviewCapturing(true);
    setLoading(true);
    setError(null);
    setCompletion(null);
    setExtractPartial(false);
    setExtractPhase('finalizing');
    try {
      const response = await apiFetch('/api/browser-tabs/chrome/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      });
      const data = await parseApiBody(response);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'Unable to fetch assets from the open Chrome tab.');
      }
      const sourceUrl = String(data.pageUrl || data.url || target).trim() || target;
      applyExtractResult(data, sourceUrl, {
        detail: `${mergeImageAssets(data.images, data.icons).length + (data.fonts?.length || 0) + (data.videos?.length || 0) + (data.colors?.length || 0)} assets captured from ${data.source === 'open-chrome-tab' ? 'the open Chrome tab' : 'a controlled browser session'}.`,
      });
    } catch (chromeError: any) {
      console.warn('Open Chrome tab extraction failed:', chromeError?.message || chromeError);
      setError(chromeError?.message || 'Open Chrome tab extraction failed. Try Extract as a fallback.');
    } finally {
      setLoading(false);
      setPreviewCapturing(false);
    }
  };

  const openFeedback = (draft?: FeedbackDraft | null) => {
    setFeedbackDraft(draft || consumeFeedbackDraft());
    setFeedbackOpen(true);
  };

  React.useEffect(() => {
    const onOpenFeedback = (event: Event) => {
      const detail = (event as CustomEvent<FeedbackDraft>).detail;
      openFeedback(detail || null);
    };
    window.addEventListener('vdx:open-feedback', onOpenFeedback);
    return () => window.removeEventListener('vdx:open-feedback', onOpenFeedback);
  }, []);

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem('vdx.responsibleUseAcknowledged.v1') !== 'yes') {
        setResponsibleUseContext('firstLaunch');
        setResponsibleUseOpen(true);
      }
    } catch {
      setResponsibleUseOpen(true);
    }
    clearExtractSession();
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
    void refreshClipboardUrl();
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
      activeTab: normalizeExtracterTab(activeTab),
      completion,
      savedAt: Date.now(),
    });
  }, [assets, extractedUrl, activeTab, completion]);

  React.useEffect(() => {
    if (!loading) return;
    const isYouTube = isYouTubeExtractUrl(url);
    const watchdogMs = isYouTube ? 300000 : 180000;
    const watchdog = window.setTimeout(() => {
      extractAbortRef.current?.abort();
      setLoading(false);
      setRetryingExtract(false);
      setError(
        isYouTube
          ? 'YouTube extraction is taking longer than expected. Try again in a moment.'
          : 'Extraction took too long. Click Extract again.'
      );
    }, watchdogMs);
    return () => window.clearTimeout(watchdog);
  }, [loading, url]);

  const openReleaseNotes = async () => {
    setReleaseViewMode('notes');
    try {
      const release = await fetchReleaseNotes();
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
    setExtractPartial(false);
    setExtractPhase('loading');
    setCrawlMode('fast');
    setPreviewCapturing(false);
    finishNowRef.current = false;
    partialExtractRef.current = null;
    if (extractPhaseTimerRef.current) {
      window.clearInterval(extractPhaseTimerRef.current);
      extractPhaseTimerRef.current = null;
    }
    setDownloadingAll(false);
    setDownloadAllProgress(null);
    setInsightsData(null);
    setInsightsUrl('');
    setPendingClipboardUrl(null);
    setClipboardDetected(false);
    userEditedUrlRef.current = false;
    lastAutoFilledUrlRef.current = '';
    clearExtractSession();
    clearPersistedClipboardUrl();
    void refreshClipboardUrl();
  };

  const handleClearWebsiteDownloads = async () => {
    const sourcePageUrl = extractedUrl || url;
    try {
      if (sourcePageUrl.trim()) {
        const response = await apiFetch('/api/website-downloads', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourcePageUrl,
            deleteFiles: true,
          }),
        });
        const data = await parseApiBody(response);
        if (!response.ok) throw new Error(data?.error || 'Could not clear downloaded files.');
      }
    } catch (error: any) {
      alert(error?.message || 'Could not clear downloaded files.');
    } finally {
      handleNewExtraction();
      window.setTimeout(() => window.location.reload(), 50);
    }
  };

  const friendlyExtractionError = (message: string, isYouTube = false) => {
    const text = String(message || '').trim();
    if (/failed to fetch|network error|connection refused|could not connect|ERR_CONNECTION|load failed/i.test(text)) {
      return 'The app could not reach its local server. Quit and reopen the app (or reinstall from the DMG), then try Extract again.';
    }
    if (/timed out|aborted/i.test(text)) {
      if (isYouTube) {
        return 'YouTube merge is still running or hit a timeout. The app will retry automatically when possible.';
      }
      return 'Extraction took too long. Click Extract again or try a simpler page URL.';
    }
    if (/blocking|403|401|forbidden/i.test(text)) {
      return 'The source appears to be blocking automated requests. Try Video Downloader or paste the media URL there.';
    }
    if (/paused the response|alternate pass|optimized youtube route/i.test(text)) {
      return text;
    }
    if (isYouTube) {
      return text || 'YouTube extraction could not finish. Try Extract again.';
    }
    return text || 'Extraction could not finish. Click Extract again.';
  };

  const clearExtractPhaseTimer = () => {
    if (extractPhaseTimerRef.current) {
      window.clearInterval(extractPhaseTimerRef.current);
      extractPhaseTimerRef.current = null;
    }
  };

  const waitForWsComplete = React.useCallback(async (): Promise<any> => {
    if (wsProgressRef.current.complete) {
      return wsProgressRef.current.result || null;
    }
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (wsProgressRef.current.complete) {
          clearInterval(poll);
          resolve(wsProgressRef.current.result || null);
        }
        if (wsProgressRef.current.error) {
          clearInterval(poll);
          resolve(null);
        }
      }, 300);
    });
  }, []);

  const startBrowserPhaseTimer = () => {
    clearExtractPhaseTimer();
    const phases: WebsiteExtractPhase[] = ['network', 'scroll', 'fonts-colors', 'finalizing'];
    let index = 0;
    extractPhaseTimerRef.current = window.setInterval(() => {
      index = Math.min(index + 1, phases.length - 1);
      setExtractPhase(phases[index]);
    }, 12000);
  };

  const runExtractRequest = async (
    signal?: AbortSignal,
    options?: { mode?: 'quick' | 'static'; crawlMode?: WebsiteCrawlMode; targetUrl?: string }
  ) => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    const requestUrl = options?.targetUrl || url;
    const isYouTube = isYouTubeExtractUrl(requestUrl);
    const timeoutMs = isYouTube
      ? 240000
      : options?.mode === 'quick'
        ? 12000
        : options?.mode === 'static'
          ? 20000
          : options?.crawlMode === 'deep'
            ? 95000
            : 125000; // Extended to allow backend-forced deep crawl (120s) + overhead
    const timeoutId = window.setTimeout(abortRequest, timeoutMs);
    signal?.addEventListener('abort', abortRequest, { once: true });

    try {
      const payload =
        options?.mode === 'quick'
          ? { url: requestUrl, mode: 'quick', extractionMode: 'full' }
          : options?.mode === 'static'
            ? { url: requestUrl, mode: 'static', extractionMode: 'full' }
            : { url: requestUrl, extractionMode: 'full', crawlMode: options?.crawlMode || crawlMode };
      const response = await apiFetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

  const applyExtractResult = (
    data: any,
    sourceUrl: string,
    options?: { partial?: boolean; detail?: string }
  ) => {
    const mergedImages = mergeImageAssets(data?.images, data?.icons);
    const nextTab = normalizeExtracterTab(activeTab);
    const nextAssets = {
      ...data,
      images: mergedImages,
      icons: [],
      videos: sanitizeVideoAssets(Array.isArray(data?.videos) ? data.videos : []),
      fonts: Array.isArray(data?.fonts) ? data.fonts : [],
      colors: normalizeExtractColors(data?.colors),
      extractionMeta: data?.extractionMeta,
    };
    partialExtractRef.current = nextAssets;
    setAssets(nextAssets);
    setExtractedUrl(sourceUrl);
    setInsightsData(null);
    setInsightsUrl('');
    setActiveTab(nextTab);
    preloadExtractorChunks();

    if (options?.partial) {
      setExtractPartial(true);
      return;
    }

    setExtractPartial(false);
    const nextCompletion = {
      title: 'Extract complete',
      detail:
        options?.detail ||
        `${mergedImages.length + (nextAssets.fonts?.length || 0) + (nextAssets.videos?.length || 0) + (nextAssets.colors?.length || 0)} assets in ${buildCreativeAssetsFolderName(sourceUrl)}.`,
      folderTarget: 'downloads' as const,
    };
    writeExtractSession({
      url: sourceUrl,
      extractedUrl: sourceUrl,
      assets: nextAssets,
      activeTab: nextTab,
      completion: nextCompletion,
      savedAt: Date.now(),
    });
    setCompletion(nextCompletion);
  };

  const handleCancelExtract = () => {
    finishNowRef.current = false;
    clearExtractPhaseTimer();
    extractAbortRef.current?.abort();
    extractJobSeq.current += 1;
    setLoading(false);
    setRetryingExtract(false);
    setExtractPartial(false);
    setExtractPhase('loading');
    partialExtractRef.current = null;
    setAssets(null);
    setExtractedUrl('');
    setCompletion(null);
    clearExtractSession();
  };

  const handleFinishExtractNow = () => {
    finishNowRef.current = true;
    clearExtractPhaseTimer();
    extractAbortRef.current?.abort();
  };

  const handleDeepScan = () => {
    if (loading) {
      if (crawlMode !== 'fast') return;
      clearExtractPhaseTimer();
      extractAbortRef.current?.abort();
      finishNowRef.current = false;
      void handleWebsiteExtract(undefined, 'deep');
      return;
    }
    setCrawlMode('deep');
    void handleWebsiteExtract(undefined, 'deep');
  };

  const handleWebsiteExtract = async (event?: React.FormEvent, forcedCrawlMode?: WebsiteCrawlMode, overrideUrl?: string) => {
    event?.preventDefault();
    const targetUrl = String(overrideUrl || url || '').trim();
    if (!targetUrl) return;

    void logActivity({
      kind: 'extraction_start',
      url: targetUrl,
      extractionType: 'full_website',
      message: 'Full website extract started',
    });

    const activeCrawlMode = forcedCrawlMode || crawlMode;
    if (forcedCrawlMode) setCrawlMode(forcedCrawlMode);

    setLoading(true);
    setError(null);
    if (!forcedCrawlMode) {
      setAssets(null);
      clearExtractSession();
    }
    setCompletion(null);
    setRetryingExtract(false);
    setExtractPartial(false);
    setExtractPhase('loading');
    finishNowRef.current = false;
    clearExtractPhaseTimer();
    extractAbortRef.current?.abort();
    const controller = new AbortController();
    extractAbortRef.current = controller;
    const jobId = extractJobSeq.current + 1;
    extractJobSeq.current = jobId;
    const isCurrentJob = () => extractJobSeq.current === jobId;
    const isYouTube = isYouTubeExtractUrl(targetUrl);

    const noAssetsYet = () => !partialExtractRef.current || !hasExtractedAssets(partialExtractRef.current);
    const fallbackTimer = !isYouTube
      ? window.setTimeout(() => {
          if (!isCurrentJob() || controller.signal.aborted || finishNowRef.current) return;
          if (!noAssetsYet()) return;
          void (async () => {
            try {
              setExtractPhase('dom');
              const fallback = await runExtractRequest(controller.signal, { mode: 'quick', targetUrl });
              if (!isCurrentJob() || !hasExtractedAssets(fallback)) return;
              const merged = partialExtractRef.current
                ? mergeExtractPayload(partialExtractRef.current, fallback)
                : fallback;
              applyExtractResult(merged, targetUrl, { partial: true });
            } catch {
              // Best-effort quick fallback.
            }
          })();
        }, 20000)
      : null;

    try {
      let data: any = null;
      let quickData: any = null;
      if (isYouTube) {
        try {
          data = await runExtractRequest(controller.signal, { targetUrl });
        } catch (firstError: any) {
          if (controller.signal.aborted) throw firstError;
          setRetryingExtract(true);
          setExtractPhase('network');
          data = await runExtractRequest(controller.signal, { targetUrl });
        }
      } else {
        setExtractPhase('loading');
        try {
          quickData = await runExtractRequest(controller.signal, { mode: 'quick', targetUrl });
        } catch (firstError: any) {
          if (controller.signal.aborted) throw firstError;
          quickData = null;
        }
        if (quickData && hasExtractedAssets(quickData)) {
          applyExtractResult(quickData, targetUrl, { partial: true });
        }

        setExtractPhase('dom');
        let staticData: any = null;
        const quickFontCount = Array.isArray(quickData?.fonts) ? quickData.fonts.length : 0;
        const needsStaticAssetPass = activeCrawlMode === 'deep' || quickFontCount === 0;
        if (!finishNowRef.current && needsStaticAssetPass) {
          try {
            staticData = await runExtractRequest(controller.signal, { mode: 'static', targetUrl });
          } catch {
            staticData = null;
          }
          if (staticData && hasExtractedAssets(staticData)) {
            const mergedStatic = quickData
              ? mergeExtractPayload(quickData, staticData)
              : staticData;
            applyExtractResult(mergedStatic, targetUrl, { partial: true });
            quickData = mergedStatic;
          }
        }

        const baseData = partialExtractRef.current || quickData || staticData;
        const baseImageCount = mergeImageAssets(baseData?.images, baseData?.icons).length;
        const needsBrowserExtract =
          activeCrawlMode === 'deep' ||
          !baseData ||
          !hasExtractedAssets(baseData) ||
          htmlNeedsRenderedRetry(targetUrl, baseData, baseImageCount);
        if (needsBrowserExtract && !finishNowRef.current) {
          setRetryingExtract(true);
          setExtractPhase('network');
          startBrowserPhaseTimer();
          try {
            const browserData = await runExtractRequest(controller.signal, {
              crawlMode: activeCrawlMode,
              targetUrl,
            });
            if (browserData?.async) {
              // Server returned immediately — browser extraction runs in background.
              // Wait for WebSocket 'complete' event which carries the full results.
              const wsResult = await waitForWsComplete();
              if (wsResult) {
                data = baseData ? mergeExtractPayload(baseData, wsResult) : wsResult;
              } else {
                data = baseData && hasExtractedAssets(baseData) ? baseData : null;
              }
            } else {
              data = baseData ? mergeExtractPayload(baseData, browserData) : browserData;
            }
          } catch (browserError: any) {
            if (finishNowRef.current && partialExtractRef.current) {
              data = partialExtractRef.current;
            } else if (baseData && hasExtractedAssets(baseData)) {
              data = baseData;
            } else {
              throw browserError;
            }
          } finally {
            clearExtractPhaseTimer();
          }
        } else {
          data = baseData;
        }
      }
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      if (!isCurrentJob()) return;
      if (controller.signal.aborted && !finishNowRef.current) return;
      if ((!data || !hasExtractedAssets(data)) && partialExtractRef.current) {
        data = partialExtractRef.current;
      }
      if (!data || !hasExtractedAssets(data)) {
        if (finishNowRef.current) return;
        throw new Error('No assets found on this page.');
      }
      const normalizedExtractUrl = parseClipboardUrl(targetUrl) || targetUrl;
      if (normalizedExtractUrl) {
        lastAutoFilledUrlRef.current = normalizedExtractUrl;
      }
      setExtractPhase('finalizing');
      const finishedEarly = finishNowRef.current;
      const partialDetail = finishedEarly
        ? 'Extraction completed with available assets. Some lazy assets may require scrolling manually.'
        : undefined;
      applyExtractResult(data, targetUrl, partialDetail ? { detail: partialDetail } : undefined);
      void logActivity({
        kind: 'extraction_success',
        url: targetUrl,
        extractionType: 'full_website',
        message: finishedEarly ? 'Full website extract finished early' : 'Full website extract completed',
      });
    } catch (err: any) {
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      if (finishNowRef.current && partialExtractRef.current) {
        applyExtractResult(partialExtractRef.current, targetUrl, {
          detail:
            'Extraction completed with available assets. Some lazy assets may require scrolling manually.',
        });
      } else if (err?.name !== 'AbortError') {
        const message = friendlyExtractionError(err.message, isYouTubeExtractUrl(targetUrl));
        setError(message);
        void reportOperationFailure({
          operation: 'extraction_failure',
          error: message,
          websiteUrl: targetUrl,
          extractionType: 'full_website',
          openFeedback: false,
        });
      }
    } finally {
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      clearExtractPhaseTimer();
      if (isCurrentJob()) {
        finishNowRef.current = false;
        setLoading(false);
        setRetryingExtract(false);
        setExtractPartial(false);
        setExtractPhase('loading');
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
    } catch (error: any) {
      console.error('Download all error:', error);
      const message = 'Reconnecting download stream did not finish. Please try the ZIP download again.';
      setError(message);
      void reportOperationFailure({
        operation: 'zip_creation_failure',
        error: error?.message || message,
        websiteUrl: extractedUrl || url,
        openFeedback: false,
      });
    } finally {
      setDownloadingAll(false);
      setDownloadAllProgress(null);
    }
  };

  const setMainNav = (section: MainSection) => {
    setMainSection(section);
    writeMainSection(section);
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans selection:bg-blue-100 selection:text-blue-900">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 shrink-0">
              <div className="w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center font-bold text-xl shrink-0">
                C
              </div>
              <h1 className="truncate text-xl font-semibold tracking-tight">{productName}</h1>
              <span className="text-xs text-zinc-500">v{appVersion.replace(/^v/i, '')}</span>
            </div>
            <nav className="flex flex-wrap items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => setMainNav('website-extraction')}
                className={cn(
                  'inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition min-w-[9.5rem]',
                  mainSection === 'website-extraction' ? 'bg-blue-600 text-white' : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                )}
              >
                <Globe className="h-3.5 w-3.5" />
                Website Extractor
              </button>
              <button
                type="button"
                onClick={() => setMainNav('video-downloader')}
                className={cn(
                  'inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition min-w-[9.5rem]',
                  mainSection === 'video-downloader' ? 'bg-blue-600 text-white' : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                )}
              >
                <Download className="h-3.5 w-3.5" />
                Video Downloader
              </button>
              <button
                type="button"
                onClick={() => openFeedback()}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50 min-w-[9.5rem]"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Feedback
              </button>
              <button
                type="button"
                onClick={() => void openReleaseNotes()}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50 min-w-[9.5rem]"
              >
                <FileText className="h-3.5 w-3.5" />
                Release Notes
              </button>
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {mainSection === 'video-downloader' ? <VideoDownloaderPage /> : null}

        {mainSection === 'website-extraction' ? (
        <>
        <div className="mx-auto mb-8 max-w-5xl">
          <WebsiteExtracterToolbar
            url={url}
            onUrlChange={handleUrlChange}
            onClearDownloads={handleClearWebsiteDownloads}
            onExtractFromOpenWebsite={handleExtractFromOpenWebsite}
            loading={loading}
            extractFromOpenWebsiteLoading={previewCapturing}
          />

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
            <WebsiteExtractProgressPanel
              active={loading}
              phase={wsProgress.connected ? wsProgress.phase : extractPhase}
              crawlMode={crawlMode}
              partialResults={extractPartial}
              deepScanAvailable={loading && crawlMode === 'fast' && retryingExtract}
              counters={wsProgress.connected ? wsProgress.counters : {
                images: assets?.images?.length || 0,
                videos: assets?.videos?.length || 0,
                fonts: assets?.fonts?.length || 0,
                colors: assets?.colors?.length || 0,
              }}
              onCancel={handleCancelExtract}
              onFinishNow={handleFinishExtractNow}
              onDeepScan={handleDeepScan}
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
            {completion && completion.title !== 'Extract complete' ? (
              <CompletionCard
                title={completion.title}
                detail={completion.detail}
                size={completion.size}
                onOpenFolder={() => void openFolder(completion.folderTarget || 'downloads', extractedUrl || url)}
              />
            ) : null}
          </div>

          {error && (
            <div className="mt-4">
              <FriendlyError
                message={error}
                retrying={retryingExtract}
                title={
                  isYouTubeExtractUrl(url)
                    ? retryingExtract
                      ? 'Trying optimized YouTube route…'
                      : 'YouTube extraction issue'
                    : undefined
                }
                onReportIssue={() => openFeedback()}
              />
            </div>
          )}
        </div>

        {assets && (
          <div className="space-y-8">
            <div className="flex items-center justify-center gap-2 border-b border-zinc-200 pb-px mb-8">
              <TabButton
                active={activeTab === 'images'}
                onClick={() => setActiveTab('images')}
                icon={<ImageIcon className="w-4 h-4" />}
                label="Images"
                count={validImageCount || assets.images.length}
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
                count={assets.videos.length}
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
                  <ImageExtractor
                    key={`images-${assetStateVersion}`}
                    images={assets.images}
                    sourcePageUrl={extractedUrl}
                    title="Images"
                    onValidCountChange={setValidImageCount}
                  />
                </div>
                <div className={activeTab === 'fonts' ? '' : 'hidden'}>
                  <FontExtractor key={`fonts-${assetStateVersion}`} fonts={assets.fonts} sourcePageUrl={extractedUrl} />
                </div>
                <div className={activeTab === 'videos' ? '' : 'hidden'}>
                  <VideoExtractor key={`videos-${assetStateVersion}`} videos={assets.videos} seedUrl={extractedUrl} hideManualSearch />
                </div>
                <div className={activeTab === 'colors' ? '' : 'hidden'}>
                  <ColorExtractor key={`colors-${assetStateVersion}`} colors={assets.colors} sourcePageUrl={extractedUrl} />
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
        </>
        ) : null}
      </main>

      <FeedbackModal
        open={feedbackOpen}
        onClose={() => {
          setFeedbackOpen(false);
          setFeedbackDraft(null);
        }}
        initialDraft={feedbackDraft}
        appVersion={appVersion}
        productName={productName}
      />
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
      {count !== undefined && count > 0 && (
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
