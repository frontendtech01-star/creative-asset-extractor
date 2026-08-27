import React, { Suspense, lazy, useState } from 'react';
import { CheckCircle2, Image as ImageIcon, Type, Palette, Sparkles, Download, Globe, Video, FolderOpen, RotateCcw, X } from 'lucide-react';
import { WebsiteExtracterToolbar } from './components/WebsitePreviewPanel';
import VideoDownloaderPage from './components/VideoDownloaderPage';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { apiFetch } from './lib/api';
import { type DownloadProgress } from './lib/download';
import { FriendlyError, SmartProgressPanel, downloadMessages } from './components/ProgressExperience';
import {
  WebsiteExtractProgressPanel,
  type WebsiteCrawlMode,
  type WebsiteExtractPhase,
} from './components/WebsiteExtractProgressPanel';
import { ResponsibleUseModal } from './components/ResponsibleUseNotice';
import { useExtractionProgress } from './lib/extractionWs';
import { type ExtractionProfile, type ExtractionProfileHint } from './lib/extractionProfile';
import {
  buildImageZipItem,
  getImageDedupeKey,
  imageNeedsConversionChoice,
  resolveZipRasterTargetFormat,
} from './lib/imageAsset';
import {
  buildFontZipItems,
  getFontLogicalKey,
  getFontSelectionKey,
  scoreFontRecord,
} from './lib/fontAsset';
import {
  isUsableExtractedVideo,
  isYouTubeExtractUrl,
} from './lib/visibleVideos';
import { detectVideoPlatform, isDirectVideoPlatformUrl } from './lib/videoPlatform';
import { buildCreativeAssetsFolderName, creativeAssetsFolderLabel } from './lib/creativeAssetsFolder';
import {
  clearPersistedClipboardUrl,
  parseClipboardUrl,
} from './lib/clipboardUrl';
import { getDesktopBridge } from './lib/desktopBridge';
import { resolveWebsitePreviewUrl } from './lib/websitePreview';
import { fetchAppMeta } from './lib/appVersion';
import { clearDownloaderJobs } from './lib/videoDownloader';
import {
  fetchLatestGithubRelease,
  fetchReleaseNotes,
  getReleaseNotificationKey,
  getSeenReleaseNotification,
  getSessionDismissedRelease,
  resolveReleaseDownloadUrl,
  setSeenReleaseNotification,
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
  AppMenu,
  AutocompletePanel,
  BookmarkManagerModal,
  BookmarkSearchModal,
  BookmarkStarButton,
  KeyboardShortcutsModal,
  PinnedBookmarks,
  isEditableTarget,
} from './components/BookmarkWidgets';
import {
  BookmarkItem,
  BookmarkStore,
  emptyBookmarkStore,
  fetchBookmarkStore,
  markBookmarkUsed,
  recordBookmarkHistory,
  saveBookmark,
  titleFromUrl,
} from './lib/bookmarkStore';
import {
  clearAppSessionState,
  type MainSection,
} from './lib/appSessions';
import greetingIllustration from '../user.svg';
import vdxLogo from './assets/vdx-logo.png';
import creativeExtractorLogo from './assets/creative-extractor-logo.png';

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

type DownloadReadyNotice = {
  title: string;
  detail?: string;
  target: string;
  sourcePageUrl?: string;
  folderPath?: string;
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

const formatSystemName = (value: string) => {
  const cleaned = String(value || '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!cleaned) return 'there';
  return cleaned.split(' ').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
};

const cleanUrlToken = (value: string) =>
  String(value || '').trim().replace(/[),\].;]+$/g, '');

const parseWebsiteExtractionInput = (value: string) => {
  const raw = String(value || '').trim();
  const tokens = raw.match(/(?:https?|socks4?|socks5):\/\/[^\s|]+/gi)?.map(cleanUrlToken).filter(Boolean) || [];
  let targetUrl = '';
  let proxyUrl = '';

  tokens.forEach((token, index) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(token);
    } catch {
      parsed = null;
    }
    if (!parsed) return;

    const protocol = parsed.protocol.toLowerCase();
    if (/^socks[45]?:$/.test(protocol)) {
      if (!proxyUrl) proxyUrl = token;
      return;
    }

    const normalizedTarget = resolveWebsitePreviewUrl(token);
    if (!targetUrl && normalizedTarget) {
      targetUrl = normalizedTarget;
      return;
    }

    // One visible input can carry a proxy after the website URL:
    // https://site.com | http://user:pass@proxy.example:8080
    if (!proxyUrl && index > 0 && (protocol === 'http:' || protocol === 'https:')) {
      proxyUrl = token;
    }
  });

  if (!targetUrl) targetUrl = resolveWebsitePreviewUrl(raw);
  return { targetUrl, proxyUrl };
};

const preloadExtractorChunks = () => {
  void import('./components/ImageExtractor');
  void import('./components/FontExtractor');
  void import('./components/ColorExtractor');
  if (SHOW_CREATIVE_BRIEF) void import('./components/AiInsights');
};

const getImageDimensionHint = (item: any) => {
  let width = Math.max(0, Number(item?.width || 0));
  let height = Math.max(0, Number(item?.height || 0));
  const rawUrl = String(item?.url || item?.src || '').trim();

  try {
    const parsed = new URL(rawUrl);
    width = width || Math.max(0, Number(parsed.searchParams.get('width') || parsed.searchParams.get('w') || 0));
    height = height || Math.max(0, Number(parsed.searchParams.get('height') || parsed.searchParams.get('h') || 0));

    const sizeMatch = parsed.pathname.match(/[-_](\d{2,5})x(\d{2,5})(?=\.[a-z0-9]+$)/i);
    if (sizeMatch) {
      width = width || Number(sizeMatch[1] || 0);
      height = height || Number(sizeMatch[2] || 0);
    }
  } catch {
    // Extracted width/height remains the fallback.
  }

  return { width, height };
};

const getImageMergeQualityScore = (item: any) => {
  const { width, height } = getImageDimensionHint(item);
  const dimensionScore = width > 0 && height > 0 ? width * height : Math.max(width, height) ** 2;
  const bytes = Math.max(0, Number(item?.bytes || item?.size || 0));
  const cachedBonus = String(item?.cachedUrl || '').trim() ? 10 : 0;
  return dimensionScore * 1000 + bytes + cachedBonus;
};

const mergeImageAssets = (images: any[] = [], icons: any[] = []) => {
  const seen = new Map<string, any>();

  [...images, ...icons].forEach((item) => {
    const rawUrl = String(item?.url || item?.src || '').trim();
    if (!rawUrl) return;

    const key = getImageDedupeKey(item) || `url:${rawUrl}`;
    const current = seen.get(key);

    if (!current || getImageMergeQualityScore(item) > getImageMergeQualityScore(current)) {
      seen.set(key, item);
    }
  });

  return Array.from(seen.values());
};

const normalizeFontUrlKey = (font: any) => {
  const raw = String(font?.url || font?.cachedUrl || '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return raw.split('#')[0];
  }
};

const getFontMergeQualityScore = (font: any) =>
  scoreFontRecord(font) +
  (getFontLogicalKey(font) ? 1000 : 0) +
  (String(font?.family || '').trim() ? 50 : 0) +
  (font?.weight !== undefined && font?.weight !== null ? 10 : 0) +
  (String(font?.style || '').trim() ? 5 : 0);

const expandKnownVariableFontInstances = (fonts: any[] = []) =>
  fonts.flatMap((font) => {
    const source = `${font?.family || ''} ${font?.title || ''} ${font?.name || ''} ${font?.url || ''}`;
    if (!/modern[\s_-]*gothic[\s_-]*variable/i.test(source)) return [font];
    // The Fordham file is one variable WOFF2. Preserve its real named
    // instances as independent selections/downloads even when the page CSS
    // exposes only the currently rendered face.
    return [100, 200, 300, 400, 500, 600, 700, 800, 900].flatMap((weight) =>
      ['normal', 'italic'].map((style) => ({
        ...font,
        family: font.family || 'ModernGothic Variable',
        weight: String(weight),
        style,
        variationWeight: weight,
        variationItalic: style === 'italic',
        variableWeightRange: '100 900',
        variableItalicAxis: true,
        isVariableFont: true,
      }))
    );
  });

const mergeFontAssets = (left: any[] = [], right: any[] = []) => {
  const byUrl = new Map<string, any>();

  expandKnownVariableFontInstances([...left, ...right]).forEach((font) => {
    // Variable-font instances intentionally share one source URL.  Keep each
    // requested weight/style instance instead of letting the first URL bucket
    // collapse the entire family into one card.
    const urlKey = getFontSelectionKey(font) || normalizeFontUrlKey(font);
    if (!urlKey) return;

    const current = byUrl.get(urlKey);
    if (!current || getFontMergeQualityScore(font) > getFontMergeQualityScore(current)) {
      byUrl.set(urlKey, font);
    }
  });

  const byLogicalKey = new Map<string, any>();
  const passthrough: any[] = [];

  Array.from(byUrl.values()).forEach((font) => {
    const logicalKey = getFontLogicalKey(font);
    if (!logicalKey) {
      passthrough.push(font);
      return;
    }

    const current = byLogicalKey.get(logicalKey);
    if (!current || getFontMergeQualityScore(font) > getFontMergeQualityScore(current)) {
      byLogicalKey.set(logicalKey, font);
    }
  });

  return [...byLogicalKey.values(), ...passthrough];
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

const sanitizeVideoAssets = (videos: any[] = [], seedUrl = '') =>
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
    return (
      !candidates.some((candidate) => typeof candidate === 'string' && isTechnicalPlayerResourceUrl(candidate)) &&
      isUsableExtractedVideo(video, seedUrl)
    );
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
  Array.from(new Set(Array.isArray(colors) ? colors.map((color) => String(color || '').trim()).filter(Boolean) : [])).slice(0, 20);

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
    const dataMatch = String(value || '').match(/^data:image\/([a-z0-9.+-]+)/i);
    if (dataMatch?.[1]) return dataMatch[1].toLowerCase().replace('svg+xml', 'svg').replace('jpeg', 'jpg');
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
    images: mergeImageAssets(baseImages, incomingImages),
    videos: sanitizeVideoAssets(mergeListByUrl(base?.videos, incoming?.videos)),
    fonts: mergeFontAssets(base?.fonts, incoming?.fonts),
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
  const [mainSection, setMainSection] = useState<MainSection>('website-extraction');
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
  const [activeExtractId, setActiveExtractId] = useState('');
  const [extractionProfile, setExtractionProfile] = useState<ExtractionProfile | null>(null);
  const [extractionProfileHint, setExtractionProfileHint] = useState<ExtractionProfileHint>('normal');
  const finishNowRef = React.useRef(false);
  const partialExtractRef = React.useRef<any>(null);
  const extractPhaseTimerRef = React.useRef<number | null>(null);
  const wsProgress = useExtractionProgress(loading, activeExtractId);
  const wsProgressRef = React.useRef(wsProgress);
  wsProgressRef.current = wsProgress;
  const [completion, setCompletion] = useState<{ title: string; detail?: string; size?: number; folderTarget?: string } | null>(null);
  const [downloadReadyNotice, setDownloadReadyNotice] = useState<DownloadReadyNotice | null>(null);
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
  const [validFontCount, setValidFontCount] = useState(0);
  const [insightsData, setInsightsData] = useState<any | null>(null);
  const [insightsUrl, setInsightsUrl] = useState('');
  const [responsibleUseOpen, setResponsibleUseOpen] = useState(false);
  const [responsibleUseContext, setResponsibleUseContext] = useState<'firstLaunch' | 'about'>('firstLaunch');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseViewMode, setReleaseViewMode] = useState<'update' | 'notes'>('update');
  const [latestRelease, setLatestRelease] = useState<GithubReleaseInfo | null>(null);
  const [releaseUpdateAvailable, setReleaseUpdateAvailable] = useState(false);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [productName, setProductName] = useState('Creative Asset Extractor');
  const [systemUserName, setSystemUserName] = useState('there');
  const [bookmarkStore, setBookmarkStore] = useState<BookmarkStore>(emptyBookmarkStore());
  const [menuOpen, setMenuOpen] = useState(false);
  const [bookmarkManagerOpen, setBookmarkManagerOpen] = useState(false);
  const [bookmarkSearchOpen, setBookmarkSearchOpen] = useState(false);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [videoDownloaderAutoStart, setVideoDownloaderAutoStart] = useState<{
    id: number;
    url: string;
    startTime?: string;
    endTime?: string;
    sourcePageUrl?: string;
    saveToWebsiteAssets?: boolean;
  } | null>(null);
  const releaseCheckedRef = React.useRef(false);
  const extractJobSeq = React.useRef(0);
  const extractAbortRef = React.useRef<AbortController | null>(null);
  const userEditedUrlRef = React.useRef(false);
  const lastAutoFilledUrlRef = React.useRef(initialUrl.trim());
  const clipboardAutoFillPausedRef = React.useRef(false);
  const videoDownloaderAutoStartSeq = React.useRef(0);
  const websiteInputRef = React.useRef<HTMLInputElement | null>(null);
  const videoDownloaderFocusRef = React.useRef<(() => void) | null>(null);
  const videoDownloaderDownloadRef = React.useRef<(() => void) | null>(null);
  const videoDownloaderResetRef = React.useRef<(() => void) | null>(null);
  const videoDownloaderCurrentUrlRef = React.useRef<(() => string) | null>(null);

  const reloadBookmarks = React.useCallback(() => {
    void fetchBookmarkStore()
      .then(setBookmarkStore)
      .catch(() => setBookmarkStore(emptyBookmarkStore()));
  }, []);

  React.useEffect(() => {
    const bridge = getDesktopBridge();
    const readSystemName = bridge?.getSystemProfile
      ? bridge.getSystemProfile()
      : apiFetch('/api/system-profile')
          .then((response) => response.ok ? response.json() : null);
    void readSystemName
      .then((profile) => setSystemUserName(formatSystemName(profile?.username || '')))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    reloadBookmarks();
  }, [reloadBookmarks]);

  const recordRecent = React.useCallback(async (targetUrl: string, category: 'website' | 'video', title?: string) => {
    if (!String(targetUrl || '').trim()) return;
    try {
      const store = await recordBookmarkHistory(targetUrl, category, title);
      setBookmarkStore(store || emptyBookmarkStore());
    } catch {
      // Recent history should never block extraction/download.
    }
  }, []);

  const bookmarkCurrentUrl = React.useCallback(async () => {
    const currentUrl = mainSection === 'video-downloader' ? (videoDownloaderCurrentUrlRef.current?.() || '') : url;
    const category = mainSection === 'video-downloader' ? 'video' : 'website';
    if (!currentUrl.trim()) return;
    const existing = bookmarkStore.bookmarks.find((bookmark) => bookmark.normalizedUrl === currentUrl.trim() || bookmark.url === currentUrl.trim());
    if (existing) {
      await markBookmarkUsed(existing.id).then(setBookmarkStore).catch(() => undefined);
      return;
    }
    await saveBookmark({ url: currentUrl, category, title: titleFromUrl(currentUrl), favorite: true, tags: [] }).catch(() => undefined);
    reloadBookmarks();
  }, [bookmarkStore.bookmarks, mainSection, reloadBookmarks, url]);

  React.useEffect(() => {
    if (!assets?.videos?.length) return;
    const cleanVideos = sanitizeVideoAssets(assets.videos, extractedUrl);
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
    if (clipboardAutoFillPausedRef.current) return;
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
    clipboardAutoFillPausedRef.current = false;
    setUrl(pendingClipboardUrl);
    lastAutoFilledUrlRef.current = pendingClipboardUrl;
    userEditedUrlRef.current = false;
    setPendingClipboardUrl(null);
    showClipboardDetectedNotice();
  };

  const handleUrlChange = (value: string) => {
    clipboardAutoFillPausedRef.current = false;
    setUrl(value);
    const trimmed = value.trim();
    if (trimmed !== lastAutoFilledUrlRef.current) {
      userEditedUrlRef.current = true;
      setPendingClipboardUrl(null);
    }
  };

  const handleExtractFromOpenWebsite = async (overrideUrl?: string) => {
    const inputValue = typeof overrideUrl === 'string' ? overrideUrl : url;
    const { targetUrl, proxyUrl } = parseWebsiteExtractionInput(inputValue);
    const rawTarget = targetUrl || String(inputValue || '').trim();
    let directVideoTarget = '';
    try {
      directVideoTarget = new URL(rawTarget).href;
    } catch {
      directVideoTarget = '';
    }
    if (directVideoTarget && detectVideoPlatform(directVideoTarget) && isDirectVideoPlatformUrl(directVideoTarget)) {
      setUrl(directVideoTarget);
      lastAutoFilledUrlRef.current = directVideoTarget;
      userEditedUrlRef.current = false;
      setPendingClipboardUrl(null);
      setError(null);
      setCompletion(null);
      setLoading(false);
      setPreviewCapturing(false);
      setMainNav('video-downloader');
      videoDownloaderAutoStartSeq.current += 1;
      setVideoDownloaderAutoStart({ id: videoDownloaderAutoStartSeq.current, url: directVideoTarget });
      return;
    }

    const target = targetUrl || resolveWebsitePreviewUrl(inputValue);
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
    extractAbortRef.current?.abort();
    const controller = new AbortController();
    extractAbortRef.current = controller;
    try {
      const response = await apiFetch('/api/browser-tabs/chrome/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target, proxyUrl: proxyUrl || undefined }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const data = await parseApiBody(response);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'Unable to fetch assets from the open Chrome tab.');
      }
      const sourceUrl = target;
      const cleanFonts = mergeFontAssets([], Array.isArray(data?.fonts) ? data.fonts : []);
      applyExtractResult(data, sourceUrl, {
        detail: `${mergeImageAssets(data.images, data.icons).length + cleanFonts.length + (data.videos?.length || 0) + (data.colors?.length || 0)} assets captured from ${data.source === 'open-chrome-tab' ? 'the open Chrome tab' : 'a controlled browser session'}.`,
      });
    } catch (chromeError: any) {
      if (controller.signal.aborted || chromeError?.name === 'AbortError') return;
      console.warn('Open Chrome tab extraction failed:', chromeError?.message || chromeError);
      setError(chromeError?.message || 'Open Chrome tab extraction failed. Try Extract as a fallback.');
    } finally {
      if (extractAbortRef.current === controller) {
        extractAbortRef.current = null;
      }
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
    const savedExtraction = readExtractSession();
    if (savedExtraction?.assets && savedExtraction.extractedUrl) {
      const normalizedSavedAssets = {
        ...savedExtraction.assets,
        images: mergeImageAssets(savedExtraction.assets.images, savedExtraction.assets.icons),
        icons: [],
        fonts: mergeFontAssets([], savedExtraction.assets.fonts),
      };
      setUrl(savedExtraction.url || savedExtraction.extractedUrl);
      setExtractedUrl(savedExtraction.extractedUrl);
      setAssets(normalizedSavedAssets as any);
      setActiveTab(normalizeExtracterTab(savedExtraction.activeTab));
      setCompletion(savedExtraction.completion || null);
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
        setLatestRelease(release);
        const shouldNotify = shouldPromptForRelease(release, meta.version, dismissed, getSeenReleaseNotification());
        setReleaseUpdateAvailable(shouldNotify);
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
      setSeenReleaseNotification(release);
      setReleaseUpdateAvailable(false);
    } catch {
      // Release notes are best-effort on launch.
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

  const openFolder = async (target = 'downloads', sourcePageUrl?: string, folderPath?: string) => {
    try {
      const bridge = getDesktopBridge();
      if (bridge && folderPath && await bridge.openFolderPath(folderPath)) return true;
      const response = await apiFetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          sourcePageUrl: sourcePageUrl || extractedUrl || undefined,
          folderPath: folderPath || undefined,
        }),
      });
      if (!response.ok) throw new Error('Folder could not be opened.');
      return true;
    } catch {
      return false;
    }
  };

  const openDownloadsFromNotice = async (notice: DownloadReadyNotice) => {
    const opened = await openFolder(notice.target, notice.sourcePageUrl || extractedUrl || url, notice.folderPath);
    if (opened) {
      setDownloadReadyNotice(null);
      return;
    }
    setDownloadReadyNotice({
      ...notice,
      detail: `${notice.detail ? `${notice.detail} ` : ''}Could not open Finder. The files are still saved in Downloads.`,
    });
  };

  const showDownloadReadyNotice = (notice: DownloadReadyNotice) => {
    setDownloadReadyNotice({
      ...notice,
      sourcePageUrl: notice.sourcePageUrl || extractedUrl || url || undefined,
    });
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
    setPreviewCapturing(false);
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
    clipboardAutoFillPausedRef.current = true;
    clearExtractSession();
    clearPersistedClipboardUrl();
  };

  const handleResetApp = async () => {
    videoDownloaderResetRef.current?.();
    setVideoDownloaderAutoStart(null);
    await clearDownloaderJobs().catch(() => undefined);
    handleNewExtraction();
    setActiveTab('images');
    setValidImageCount(0);
    setValidFontCount(0);
    setDownloadReadyNotice(null);
    clearAppSessionState();
    clearExtractSession();
    clearPersistedClipboardUrl();
    setMainNav('website-extraction');
    window.setTimeout(() => websiteInputRef.current?.focus(), 50);
  };

  const friendlyExtractionError = (message: string, isYouTube = false) => {
    const text = String(message || '').trim();
    if (/captcha|browser verification|verification gate/i.test(text)) {
      return 'This site requires a CAPTCHA or browser verification. Open it in Chrome, complete the check, then retry extraction.';
    }
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

  const waitForWsComplete = React.useCallback(async (extractId: string, timeoutMs = 40_000): Promise<any> => {
    if (wsProgressRef.current.extractId === extractId && wsProgressRef.current.complete) {
      return wsProgressRef.current.result || null;
    }
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        clearInterval(poll);
        resolve(null);
      }, timeoutMs);
      const poll = setInterval(() => {
        if (wsProgressRef.current.extractId !== extractId) return;
        if (wsProgressRef.current.complete) {
          window.clearTimeout(timeout);
          clearInterval(poll);
          resolve(wsProgressRef.current.result || null);
        }
        if (wsProgressRef.current.error) {
          window.clearTimeout(timeout);
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
    const parsedInput = parseWebsiteExtractionInput(options?.targetUrl || url);
    const requestUrl = parsedInput.targetUrl || options?.targetUrl || url;
    const requestProxyUrl = parsedInput.proxyUrl;
    const isYouTube = isYouTubeExtractUrl(requestUrl);
      const timeoutMs = isYouTube
        ? 240000
        : options?.mode === 'quick'
        ? 32000
        : options?.mode === 'static'
          ? 45000
          : options?.crawlMode === 'deep'
            ? 95000
            : 125000;
    const timeoutId = window.setTimeout(abortRequest, timeoutMs);
    signal?.addEventListener('abort', abortRequest, { once: true });

    try {
      const payload =
        options?.mode === 'quick'
          ? { url: requestUrl, mode: 'quick', extractionMode: 'full', proxyUrl: requestProxyUrl || undefined }
          : options?.mode === 'static'
            ? { url: requestUrl, mode: 'static', extractionMode: 'full', proxyUrl: requestProxyUrl || undefined }
            : { url: requestUrl, extractionMode: 'full', crawlMode: options?.crawlMode || crawlMode, siteProfile: extractionProfileHint, proxyUrl: requestProxyUrl || undefined };
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
    const mergedFonts = mergeFontAssets([], Array.isArray(data?.fonts) ? data.fonts : []);
    const nextTab = normalizeExtracterTab(activeTab);
    const nextAssets = {
      ...data,
      images: mergedImages,
      icons: [],
      videos: sanitizeVideoAssets(Array.isArray(data?.videos) ? data.videos : [], sourceUrl),
      fonts: mergedFonts,
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
    void recordRecent(sourceUrl, 'website', titleFromUrl(sourceUrl));
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
    setActiveExtractId('');
    setExtractionProfile(null);
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
    if (loading) return;
    void handleExtractFromOpenWebsite(extractedUrl || url);
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
      partialExtractRef.current = null;
      clearExtractSession();
    }
    setCompletion(null);
    setRetryingExtract(false);
    setExtractPartial(false);
    setExtractPhase('loading');
    setActiveExtractId('');
    setExtractionProfile(null);
    finishNowRef.current = false;
    clearExtractPhaseTimer();
    extractAbortRef.current?.abort();
    const controller = new AbortController();
    extractAbortRef.current = controller;
    const jobId = extractJobSeq.current + 1;
    extractJobSeq.current = jobId;
    const isCurrentJob = () => extractJobSeq.current === jobId;
    const isYouTube = isYouTubeExtractUrl(targetUrl);
    const isKnownProtectedStorefront = /warehousestationery\.co\.nz/i.test(targetUrl);

    const noAssetsYet = () => !partialExtractRef.current || !hasExtractedAssets(partialExtractRef.current);
    const fallbackTimer = !isYouTube && !isKnownProtectedStorefront
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
        if (!isKnownProtectedStorefront) {
          try {
            quickData = await runExtractRequest(controller.signal, { mode: 'quick', targetUrl });
          } catch (firstError: any) {
            if (controller.signal.aborted) throw firstError;
            quickData = null;
          }
        }
        if (quickData && hasExtractedAssets(quickData)) {
          applyExtractResult(quickData, targetUrl, { partial: true });
        }

        setExtractPhase('dom');
        let staticData: any = null;
        const quickFontCount = Array.isArray(quickData?.fonts) ? quickData.fonts.length : 0;
        const needsStaticAssetPass = !isKnownProtectedStorefront && (activeCrawlMode === 'deep' || quickFontCount === 0);
        if (!finishNowRef.current && needsStaticAssetPass) {
          try {
            staticData = await runExtractRequest(controller.signal, { mode: 'static', targetUrl });
          } catch {
            staticData = null;
          }
          if (staticData && hasExtractedAssets(staticData)) {
            const mergedStatic = quickData ? mergeExtractPayload(quickData, staticData) : staticData;
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
              const pendingExtractId = String(browserData.extractId || '');
              const browserProfile = browserData.extractionProfile || null;
              setExtractionProfile(browserProfile);
              setActiveExtractId(pendingExtractId);
              const wsResult = await waitForWsComplete(
                pendingExtractId,
                // A deep scan has already gathered a useful static preview,
                // but its metadata/font finalization can outlive Chromium's
                // navigation budget. Keep the socket open long enough to
                // receive that authoritative result instead of reverting to
                // the early five-font fallback.
                activeCrawlMode === 'deep'
                  ? Math.max(Number(browserProfile?.browserBudgetMs || 10_000) + 10_000, 90_000)
                  : Number(browserProfile?.browserBudgetMs || 10_000) + 10_000,
              );
              if (wsResult) {
                data = baseData ? mergeExtractPayload(baseData, wsResult) : wsResult;
              } else {
                const extractionError = wsProgressRef.current.error;
                if (extractionError) throw new Error(extractionError);
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
      if (normalizedExtractUrl) lastAutoFilledUrlRef.current = normalizedExtractUrl;
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
          detail: 'Extraction completed with available assets. Some lazy assets may require scrolling manually.',
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
        setActiveExtractId('');
        setExtractionProfile(null);
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
      const nextCompletion = {
        title: 'Download package ready',
        detail: `All assets saved to ${creativeAssetsFolderLabel(extractedUrl, 'Images')} as ${saved.filename || 'all-assets.zip'}.`,
        size: saved.size,
        folderTarget: 'downloads',
      };
      setCompletion(nextCompletion);
      showDownloadReadyNotice({
        title: nextCompletion.title,
        detail: nextCompletion.detail,
        target: nextCompletion.folderTarget,
        sourcePageUrl: extractedUrl || url,
        folderPath: saved.folderPath,
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
  };

  const extractWebsiteBookmarkFromChrome = React.useCallback((nextUrl: string) => {
    const cleanUrl = String(nextUrl || '').trim();
    if (!cleanUrl) return;
    setMainNav('website-extraction');
    setUrl(cleanUrl);
    lastAutoFilledUrlRef.current = cleanUrl;
    userEditedUrlRef.current = false;
    setPendingClipboardUrl(null);
    window.requestAnimationFrame(() => {
      websiteInputRef.current?.focus();
      void handleExtractFromOpenWebsite(cleanUrl);
    });
  }, [handleExtractFromOpenWebsite]);

  const openBookmark = React.useCallback((bookmark: BookmarkItem) => {
    void markBookmarkUsed(bookmark.id).then(setBookmarkStore).catch(() => undefined);
    if (bookmark.category === 'video') {
      setMainNav('video-downloader');
      window.requestAnimationFrame(() => {
        videoDownloaderAutoStartSeq.current += 1;
        setVideoDownloaderAutoStart({ id: videoDownloaderAutoStartSeq.current, url: bookmark.url });
      });
      return;
    }
    extractWebsiteBookmarkFromChrome(bookmark.url);
  }, [extractWebsiteBookmarkFromChrome]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      const targetIsEditable = isEditableTarget(event.target);

      if (!targetIsEditable && !isMod && !event.altKey && !event.shiftKey) {
        if (event.key === '?') {
          event.preventDefault();
          setKeyboardShortcutsOpen(true);
          return;
        }
        if (event.key.toLowerCase() === 'w') {
          event.preventDefault();
          setMainNav('website-extraction');
          window.requestAnimationFrame(() => websiteInputRef.current?.focus());
          return;
        }
        if (event.key.toLowerCase() === 'v') {
          event.preventDefault();
          setMainNav('video-downloader');
          window.requestAnimationFrame(() => videoDownloaderFocusRef.current?.());
          return;
        }
      }

      if (!isMod) {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (focusMode && !loading) {
            setFocusMode(false);
            return;
          }
          if (mainSection === 'video-downloader') {
            videoDownloaderResetRef.current?.();
          } else {
            handleCancelExtract();
          }
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'r' && !event.shiftKey) {
        event.preventDefault();
        void handleResetApp();
      } else if (key === 'l' && !event.shiftKey) {
        event.preventDefault();
        if (mainSection === 'video-downloader') videoDownloaderFocusRef.current?.();
        else websiteInputRef.current?.focus();
      } else if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        setBookmarkSearchOpen(true);
      } else if (key === 'd' && !event.shiftKey) {
        event.preventDefault();
        void bookmarkCurrentUrl();
      } else if (key === 'c' && event.shiftKey) {
        event.preventDefault();
        const currentUrl = mainSection === 'video-downloader' ? videoDownloaderCurrentUrlRef.current?.() : url;
        if (currentUrl) void navigator.clipboard?.writeText(currentUrl);
      } else if (key === 'o' && event.shiftKey) {
        event.preventDefault();
        void openFolder('downloads', extractedUrl || url);
      } else if (key === 'r' && event.shiftKey) {
        event.preventDefault();
        if (mainSection === 'video-downloader') videoDownloaderDownloadRef.current?.();
        else void handleExtractFromOpenWebsite(extractedUrl || url);
      } else if (key === '1') {
        event.preventDefault();
        setMainNav('website-extraction');
      } else if (key === '2') {
        event.preventDefault();
        setMainNav('video-downloader');
      } else if (key === '3') {
        event.preventDefault();
        setBookmarkManagerOpen(true);
      } else if (key === '4') {
        event.preventDefault();
        void openFolder('downloads', extractedUrl || url);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bookmarkCurrentUrl, extractedUrl, focusMode, handleResetApp, loading, mainSection, url]);

  return (
    <div className="min-h-screen bg-[#f8fafd] text-[#1f1f1f] font-sans selection:bg-blue-100 selection:text-blue-900">
      <header className="sticky top-0 z-10 border-b border-[#e1e7ee] bg-transparent">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5">
          {focusMode ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <div className="w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center font-bold text-xl shrink-0">
                  C
                </div>
                <h1 className="truncate text-xl font-semibold tracking-tight">{productName}</h1>
                <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">Focus Mode</span>
              </div>
              <button
                type="button"
                onClick={() => setFocusMode(false)}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 transition hover:border-blue-600 hover:bg-blue-600 hover:text-white"
              >
                Exit Focus Mode
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5 shrink-0">
                <img src={vdxLogo} alt="VDX.tv" className="h-8 w-auto shrink-0" />
                <span className="h-6 w-px shrink-0 bg-[#dadce0]" aria-hidden="true" />
                <img
                  src={creativeExtractorLogo}
                  alt="Creative Asset Extractor"
                  className="h-9 w-9 shrink-0 rounded-md object-contain mix-blend-multiply"
                />
                <div className="min-w-0">
                  <h1 className="truncate text-base font-semibold tracking-tight">{productName}</h1>
                  <p className="text-[11px] leading-4 text-[#5f6368]">v{appVersion}</p>
                </div>
              </div>
              <nav className="flex flex-wrap items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setMainNav('website-extraction')}
                  title="Website Extractor · Shortcut: W"
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition min-w-[9.5rem]',
                    mainSection === 'website-extraction' ? 'bg-blue-600 text-white' : 'border border-zinc-200 bg-white text-zinc-700 hover:border-blue-600 hover:bg-blue-600 hover:text-white'
                  )}
                >
                  <Globe className="h-3.5 w-3.5" />
                  Website Extractor
                </button>
                <button
                  type="button"
                  onClick={() => setMainNav('video-downloader')}
                  title="Image/Video Downloader · Shortcut: V"
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition min-w-[9.5rem]',
                    mainSection === 'video-downloader' ? 'bg-blue-600 text-white' : 'border border-zinc-200 bg-white text-zinc-700 hover:border-blue-600 hover:bg-blue-600 hover:text-white'
                  )}
                >
                  <Download className="h-3.5 w-3.5" />
                  Image/Video Downloader
                </button>
                <button
                  type="button"
                  onClick={() => void handleResetApp()}
                  title="Reset App (⌘R / Ctrl+R)"
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition hover:border-blue-600 hover:bg-blue-600 hover:text-white min-w-[9.5rem]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
                <AppMenu
                  open={menuOpen}
                  onToggle={() => setMenuOpen((value) => !value)}
                  onClose={() => setMenuOpen(false)}
                  releaseUpdateAvailable={releaseUpdateAvailable}
                  onFeedback={() => openFeedback()}
                  onBookmarks={() => setBookmarkManagerOpen(true)}
                  onKeyboardShortcuts={() => setKeyboardShortcutsOpen(true)}
                  onReleaseNotesAndUpdates={() => void openReleaseNotes()}
                />
                <div
                  className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0b57d0] text-xs font-semibold text-white shadow-sm ring-2 ring-white"
                  title={`Signed in as ${systemUserName}`}
                  aria-label={`Signed in as ${systemUserName}`}
                >
                  {systemUserName.charAt(0).toUpperCase() || 'U'}
                </div>
              </nav>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {mainSection === 'video-downloader' ? (
          <VideoDownloaderPage
            autoStartRequest={videoDownloaderAutoStart}
            onDownloadReady={showDownloadReadyNotice}
            bookmarkStore={bookmarkStore}
            onBookmarksChanged={reloadBookmarks}
            onOpenBookmark={openBookmark}
            registerControls={(controls) => {
              videoDownloaderFocusRef.current = controls.focusUrlInput;
              videoDownloaderDownloadRef.current = controls.startDownload;
              videoDownloaderResetRef.current = controls.reset;
              videoDownloaderCurrentUrlRef.current = controls.getCurrentUrl;
            }}
          />
        ) : null}

        {mainSection === 'website-extraction' ? (
        <>
        <div className="mx-auto mb-8 max-w-5xl">
          {!assets ? (
            <section className="material-welcome mb-6 overflow-hidden rounded-[24px] border border-[#dbe5f0] bg-white px-5 py-4 shadow-[0_2px_8px_rgba(60,64,67,0.14)] sm:px-7 sm:py-4">
              <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
                <div className="greeting-illustration-shell shrink-0" aria-hidden="true">
                  <img src={greetingIllustration} alt="" className="greeting-illustration h-20 w-20 sm:h-24 sm:w-24" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="greeting-title text-3xl font-semibold tracking-tight text-[#202124] sm:text-4xl">Hello, {systemUserName}!</h2>
                  <p className="mt-2 text-sm leading-6 text-[#5f6368]">What would you like to extract today?</p>
                </div>
              </div>
            </section>
          ) : null}
          <WebsiteExtracterToolbar
            url={url}
            onUrlChange={handleUrlChange}
            onExtractFromOpenWebsite={() => handleExtractFromOpenWebsite()}
            loading={loading}
            extractFromOpenWebsiteLoading={previewCapturing}
            inputRef={websiteInputRef}
            onSubmit={() => void handleExtractFromOpenWebsite()}
            rightSlot={
              <BookmarkStarButton
                url={url}
                category="website"
                store={bookmarkStore}
                onChanged={reloadBookmarks}
              />
            }
          />

          <fieldset className="mt-3 rounded-xl border border-zinc-200 bg-white px-3 py-2" aria-label="Website scan time">
            <legend className="px-1 text-xs font-bold uppercase tracking-wide text-zinc-600">Expected website type</legend>
            <div className="flex flex-wrap gap-2">
              {([
                ['normal', 'Normal'],
                ['heavy', 'Heavy/deep'],
                ['captcha', 'CAPTCHA'],
              ] as const).map(([value, label]) => {
                const checked = extractionProfileHint === value;
                return (
                  <label
                    key={value}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                      checked ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                    } ${loading ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={loading}
                      onChange={() => {
                        setExtractionProfileHint(value);
                        // A user who marks a site as heavy expects the full
                        // Chromium/deep pass, including every font variant.
                        setCrawlMode(value === 'heavy' ? 'deep' : 'fast');
                      }}
                      className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                    />
                    {label}
                  </label>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">Choose the expected site type before extracting.</p>
          </fieldset>

          <div className="mt-3 space-y-3">
            <PinnedBookmarks store={bookmarkStore} category="website" onOpen={openBookmark} />
          </div>

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
              task={wsProgress.connected ? wsProgress.task : undefined}
              extractionProfile={wsProgress.profile || extractionProfile}
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
                count={validImageCount}
              />
              <TabButton
                active={activeTab === 'fonts'}
                onClick={() => setActiveTab('fonts')}
                icon={<Type className="w-4 h-4" />}
                label="Fonts"
                count={validFontCount}
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
                    onDownloadReady={showDownloadReadyNotice}
                  />
                </div>
                <div className={activeTab === 'fonts' ? '' : 'hidden'}>
                  <FontExtractor
                    key={`fonts-${assetStateVersion}`}
                    fonts={assets.fonts}
                    sourcePageUrl={extractedUrl}
                    onValidCountChange={setValidFontCount}
                    onDownloadReady={showDownloadReadyNotice}
                  />
                </div>
                <div className={activeTab === 'videos' ? '' : 'hidden'}>
                  <VideoExtractor
                    key={`videos-${assetStateVersion}`}
                    videos={assets.videos}
                    seedUrl={extractedUrl}
                    hideManualSearch
                    onDownloadReady={showDownloadReadyNotice}
                    onOpenInDownloader={(request) => {
                      setMainNav('video-downloader');
                      window.requestAnimationFrame(() => {
                        videoDownloaderAutoStartSeq.current += 1;
                        setVideoDownloaderAutoStart({
                          id: videoDownloaderAutoStartSeq.current,
                          url: request.url,
                          sourcePageUrl: request.sourcePageUrl,
                          saveToWebsiteAssets: request.saveToWebsiteAssets,
                        });
                      });
                    }}
                  />
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

      {downloadReadyNotice ? (
        <div className="fixed bottom-5 right-5 z-50 w-[calc(100vw-2.5rem)] max-w-sm rounded-xl border border-emerald-200 bg-white p-4 text-zinc-900 shadow-2xl">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-emerald-600 p-1.5 text-white">
              <CheckCircle2 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{downloadReadyNotice.title}</p>
              {downloadReadyNotice.detail ? (
                <p className="mt-1 text-xs leading-5 text-zinc-600">{downloadReadyNotice.detail}</p>
              ) : null}
              <button
                type="button"
                onClick={() => void openDownloadsFromNotice(downloadReadyNotice)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-800"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Open Downloads
              </button>
            </div>
            <button
              type="button"
              onClick={() => setDownloadReadyNotice(null)}
              className="rounded-lg p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Dismiss download notice"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      <BookmarkManagerModal
        open={bookmarkManagerOpen}
        store={bookmarkStore}
        onClose={() => setBookmarkManagerOpen(false)}
        onReload={reloadBookmarks}
        onOpenBookmark={openBookmark}
        onOpenRecent={extractWebsiteBookmarkFromChrome}
      />
      <BookmarkSearchModal
        open={bookmarkSearchOpen}
        store={bookmarkStore}
        onClose={() => setBookmarkSearchOpen(false)}
        onOpenBookmark={openBookmark}
      />
      <KeyboardShortcutsModal
        open={keyboardShortcutsOpen}
        onClose={() => setKeyboardShortcutsOpen(false)}
      />

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
          setSeenReleaseNotification(latestRelease);
          setReleaseUpdateAvailable(false);
          setReleaseOpen(false);
        }}
        onLater={() => {
          if (releaseViewMode === 'update' && latestRelease?.tagName) {
            setSessionDismissedRelease(getReleaseNotificationKey(latestRelease) || latestRelease.tagName);
            setSeenReleaseNotification(latestRelease);
            setReleaseUpdateAvailable(false);
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
