import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, FolderOpen, Link as LinkIcon, Loader2, Pause, Play, XCircle } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { writeVideoDownloaderSession } from '../lib/appSessions';
import {
  VIDEO_PLATFORMS,
  describeDirectVideoPlatformUrlIssue,
  detectVideoPlatform,
  isDirectVideoPlatformUrl,
  isPlaceholderVideoPlatformUrl,
} from '../lib/videoPlatform';
import {
  listDownloaderJobs,
  downloaderFileUrl,
  openDownloaderFile,
  readDownloaderJob,
  revealDownloaderFile,
  cancelDownloaderJob,
  pauseDownloaderJob,
  resolveBrowserBlobVideo,
  resumeDownloaderJob,
  startBulkDownloaderJobs,
  startDownloaderJob,
  waitForDownloaderJob,
  type DownloaderJob,
  type DownloaderQuality,
} from '../lib/videoDownloader';
import { formatBytes } from '../lib/download';
import { logActivity, reportOperationFailure } from '../lib/activityLog';
import { requestOpenFeedback } from '../lib/feedbackContext';
import { buildFontDisplayName, getFontFamilyFolderName, prettifyFontFamilyLabel } from '../lib/fontAsset';
import { FriendlyError } from './ProgressExperience';
import ValidatedVideoThumb from './ValidatedVideoThumb';
import {
  AutocompletePanel,
  BookmarkStarButton,
  PinnedBookmarks,
  RecentRows,
} from './BookmarkWidgets';
import {
  BookmarkItem,
  BookmarkStore,
  clearRecentHistory,
  deleteRecentHistory,
  recordBookmarkHistory,
  saveBookmark,
  titleFromUrl,
} from '../lib/bookmarkStore';

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const isBlobVideoUrl = (value: string) => /^blob:https?:\/\//i.test(String(value || '').trim());

const parseInputUrls = (value: string) =>
  Array.from(new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)));

const isSupportedBulkImageUrl = (value: string) =>
  /^https?:\/\/.+\.(?:png|jpe?g|webp|avif|gif|svg)(?:[?#].*)?$/i.test(String(value || '').trim());

const isSupportedBulkFontUrl = (value: string) =>
  /^https?:\/\/.+\.(?:woff2?|ttf|otf|eot)(?:[?#].*)?$/i.test(String(value || '').trim()) ||
  /^https?:\/\/use\.typekit\.net\/af\/.+\/(?:\d+\/)?[lda](?:[?#].*)?$/i.test(String(value || '').trim());

const isSupportedBulkFontCssUrl = (value: string) =>
  /^https?:\/\/(?:fonts\.googleapis\.com\/css\S*|.+\.css(?:[?#].*)?)/i.test(String(value || '').trim());

const isSupportedBulkAssetUrl = (value: string) =>
  isSupportedBulkImageUrl(value) || isSupportedBulkFontUrl(value) || isSupportedBulkFontCssUrl(value);

const getBulkAssetKind = (value: string): 'image' | 'font' | 'font-css' => {
  if (isSupportedBulkFontCssUrl(value)) return 'font-css';
  if (isSupportedBulkFontUrl(value)) return 'font';
  return 'image';
};

const getUrlFilename = (url: string, fallback: string) => {
  const clean = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || fallback;
  return clean || fallback;
};

const filenameBaseFromName = (filename: string) =>
  String(filename || 'asset').replace(/\.[^.]+$/, '') || 'asset';

type BulkResolvedAsset = {
  url: string;
  kind: 'image' | 'font';
  filename?: string;
  cssSource?: string;
  family?: string;
  weight?: string;
  style?: string;
};

const normalizeBulkFontFamily = (value: string) =>
  String(value || '')
    .replace(/\+/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const sanitizeBulkPathPart = (value: string, fallback: string) =>
  String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fallback;

const buildBulkFontFilenameBase = (asset: BulkResolvedAsset, fallbackBase: string) => {
  const display = buildFontDisplayName({
    family: normalizeBulkFontFamily(asset.family || ''),
    weight: asset.weight,
    style: asset.style,
    filename: fallbackBase,
  });
  return display || fallbackBase;
};

const extractBulkAssetLinks = (value: string) =>
  Array.from(
    new Set(
      (String(value || '').match(/https?:\/\/[^\s"'<>()[\]]+/gi) || [])
        .map((line) => line.trim().replace(/^<|>$/g, '').replace(/^["']|["']$/g, '').replace(/[),.;]+$/g, ''))
        .filter(isSupportedBulkAssetUrl)
    )
  );

const mergeJobs = (current: DownloaderJob[], updates: DownloaderJob[]) => {
  const byId = new Map(current.map((job) => [job.id, job]));
  updates.forEach((job) => byId.set(job.id, job));
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
};

const jobStatusLabel = (job: DownloaderJob) => {
  if (job.status === 'completed') return 'Complete';
  if (job.status === 'error') return 'Failed';
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'paused') return 'Paused';
  if (job.status === 'cancelled') return 'Cancelled';
  return `${Math.round(job.progress || 0)}%`;
};

const jobProgressWidth = (job: DownloaderJob) => {
  if (job.status === 'completed') return 100;
  if (job.status === 'error') return 100;
  if (job.status === 'cancelled') return 0;
  if (job.status === 'queued') return 5;
  return Math.max(8, Math.min(99, Math.round(job.progress || 0)));
};

const platformLabel = (id: string) => VIDEO_PLATFORMS.find((entry) => entry.id === id)?.label || id;

const YOUTUBE_FALLBACK_URL = 'https://yt5s.in/en271/';

const isYouTubeUrl = (value: string) => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be' || host.endsWith('.youtu.be') || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return /(?:youtube\.com|youtu\.be)/i.test(value);
  }
};

const isInstagramUrl = (value: string) => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return /instagram\.com/i.test(value);
  }
};

const isInstagramCookieError = (message: string) =>
  /instagram.*cookies\.txt|cookies\.txt.*instagram|instagram requires cookies/i.test(message);

const needsCookieFileOption = (platform: string | null) =>
  Boolean(platform && ['instagram', 'facebook', 'x', 'tiktok', 'youtube'].includes(platform));

function YouTubeFallbackLink({ url, compact = false }: { url: string; compact?: boolean }) {
  if (!url || !isYouTubeUrl(url)) return null;

  const copySourceUrl = () => {
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  return (
    <a
      href={YOUTUBE_FALLBACK_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={copySourceUrl}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white font-semibold text-blue-700 transition hover:bg-blue-50 hover:text-blue-800 ${
        compact ? 'px-3 py-1.5 text-xs' : 'px-3 py-2 text-sm'
      }`}
      title="Copies the YouTube URL and opens the backup downloader"
    >
      <ExternalLink className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      Open YT5S backup
    </a>
  );
}

function DownloadJobCard({
  job,
  compact = false,
  onCancel,
  onPause,
  onResume,
}: {
  job: DownloaderJob;
  compact?: boolean;
  onCancel?: (job: DownloaderJob) => void;
  onPause?: (job: DownloaderJob) => void;
  onResume?: (job: DownloaderJob) => void;
}) {
  const isComplete = job.status === 'completed';
  const isError = job.status === 'error';
  const isPaused = job.status === 'paused';
  const title = job.title || job.result?.title || job.url;
  return (
    <div className={`rounded-xl border p-4 ${isError ? 'border-amber-200 bg-amber-50' : isComplete ? 'border-emerald-200 bg-emerald-50' : 'border-blue-100 bg-blue-50'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-950" title={title}>{title}</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-zinc-600">
            {platformLabel(job.platform)} · {job.quality === '4k' ? 'MAX QUALITY · 4K / FHD FALLBACK' : job.quality === 'fhd' ? 'FHD / HD fallback' : job.quality.toUpperCase()}
            {job.startTime || job.endTime ? ` · ${job.startTime || '0'}-${job.endTime || 'end'}` : ''}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${isError ? 'bg-amber-100 text-amber-800' : isComplete ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>
          {isComplete ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          {jobStatusLabel(job)}
        </span>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/70">
        <div
          className={`h-full rounded-full transition-all duration-500 ${isError ? 'bg-amber-500' : isComplete ? 'bg-emerald-600' : 'bg-blue-600'}`}
          style={{ width: `${jobProgressWidth(job)}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-700">
        <span>{job.error || job.message}</span>
        {job.downloadedBytes ? <span>{formatBytes(job.downloadedBytes)}</span> : null}
        {job.totalBytes ? <span>of {formatBytes(job.totalBytes)}</span> : null}
        {job.speed ? <span>{job.speed}</span> : null}
        {job.eta && !isComplete ? <span>ETA {job.eta}</span> : null}
      </div>

      {isError && isYouTubeUrl(job.url) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <YouTubeFallbackLink url={job.url} compact />
          <span className="text-xs text-amber-800">If YouTube blocks this video, the URL is copied before opening the backup page.</span>
        </div>
      ) : null}

      {(job.status === 'queued' || job.status === 'running' || job.status === 'paused') ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {job.status === 'running' && onPause ? (
            <button
              type="button"
              onClick={() => onPause(job)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          ) : null}
          {isPaused && onResume ? (
            <button
              type="button"
              onClick={() => onResume(job)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </button>
          ) : null}
          {onCancel ? (
            <button
              type="button"
              onClick={() => onCancel(job)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
            >
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}

      {isComplete && job.result && !compact ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void openDownloaderFile(job.result!)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
          >
            <Play className="h-3.5 w-3.5" />
            Open File
          </button>
          <button
            type="button"
            onClick={() => void revealDownloaderFile(job.result!)}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open Folder
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CompletedDownloadGrid({ jobs }: { jobs: DownloaderJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <div className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900">Completed Video{jobs.length === 1 ? '' : 's'}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500">{jobs.length} ready</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {jobs.map((job) => {
          const result = job.result!;
          const title = result.title || job.title || result.filename || job.url;
          return (
            <div key={`${job.id}-result`} className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
              <ValidatedVideoThumb
                thumbnail={result.thumbnail}
                title={title}
                provider={result.platform || job.platform}
                className="h-36 w-full"
              />
              <div className="p-4">
                <p className="truncate text-sm font-semibold text-zinc-900" title={title}>
                  {title}
                </p>
                <a
                  href={downloaderFileUrl(result)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block truncate text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline"
                  title={result.displayPath}
                >
                  {result.displayPath}
                </a>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-600">
                  <span className="rounded bg-zinc-100 px-2 py-1 uppercase">{result.platform}</span>
                  <span className="rounded bg-blue-50 px-2 py-1 font-semibold text-blue-700">{result.quality}</span>
                  <span className="rounded bg-green-50 px-2 py-1 font-semibold text-green-700">completed</span>
                  <span className="rounded bg-zinc-100 px-2 py-1">{formatBytes(result.size)}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void openDownloaderFile(result)}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Open File
                  </button>
                  <button
                    type="button"
                    onClick={() => void revealDownloaderFile(result)}
                    className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Open Folder
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type AutoStartRequest = {
  id: number;
  url: string;
  quality?: DownloaderQuality;
  startTime?: string;
  endTime?: string;
  sourcePageUrl?: string;
  saveToWebsiteAssets?: boolean;
};

type VideoDownloaderPageProps = {
  autoStartRequest?: AutoStartRequest | null;
  onDownloadReady?: (notice: { title: string; detail?: string; target: string; sourcePageUrl?: string; folderPath?: string }) => void;
  bookmarkStore?: BookmarkStore | null;
  onBookmarksChanged?: () => void;
  onOpenBookmark?: (bookmark: BookmarkItem) => void;
  registerControls?: (controls: {
    focusUrlInput: () => void;
    startDownload: () => void;
    reset: () => void;
    getCurrentUrl: () => string;
  }) => void;
};

export default function VideoDownloaderPage({
  autoStartRequest = null,
  onDownloadReady,
  bookmarkStore = null,
  onBookmarksChanged,
  onOpenBookmark,
  registerControls,
}: VideoDownloaderPageProps) {
  const [urlInput, setUrlInput] = useState('');
  const [jobs, setJobs] = useState<DownloaderJob[]>([]);
  const [jobErrors, setJobErrors] = useState<Array<{ url: string; error: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [activeQuality, setActiveQuality] = useState<DownloaderQuality | null>(null);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [cookiesFilePath, setCookiesFilePath] = useState('');
  const [bulkImageLinks, setBulkImageLinks] = useState('');
  const [bulkImageDownloading, setBulkImageDownloading] = useState(false);
  const [bulkImageResult, setBulkImageResult] = useState<{ ok: boolean; message: string } | null>(null);
  const handledAutoStartIdRef = React.useRef<number | null>(null);
  const urlInputRef = React.useRef<HTMLTextAreaElement | null>(null);

  const inputUrls = useMemo(() => parseInputUrls(urlInput), [urlInput]);
  const detectedPlatform = useMemo(
    () => (inputUrls.length === 1 ? detectVideoPlatform(inputUrls[0]) : null),
    [inputUrls]
  );
  const runningCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const pausedCount = jobs.filter((job) => job.status === 'paused').length;
  const completeCount = jobs.filter((job) => job.status === 'completed').length;
  const failedCount = jobs.filter((job) => job.status === 'error').length;
  const completedJobs = jobs.filter((job) => job.status === 'completed' && job.result);

  const resetVideoDownloader = React.useCallback(() => {
    setUrlInput('');
    setJobErrors([]);
    setBusy(false);
    setActiveQuality(null);
    setStartTime('');
    setEndTime('');
    setCookiesFilePath('');
    setJobs([]);
    window.setTimeout(() => urlInputRef.current?.focus(), 30);
  }, []);

  useEffect(() => {
    writeVideoDownloaderSession({
      url: '',
      singleUrl: '',
      bulkUrls: '',
      activeTab: 'download',
      video: null,
      videos: [],
      savedAt: Date.now(),
    });
  }, []);

  useEffect(() => {
    void listDownloaderJobs()
      .then((items) => {
        const recent = items
          .filter(
            (job) =>
              job.status !== 'cancelled' &&
              (job.status === 'queued' || job.status === 'running' || Date.now() - job.updatedAt < 30 * 60 * 1000),
          )
          .slice(0, 12)
          .reverse();
        setJobs(recent);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused');
    if (activeJobs.length === 0) return undefined;
    const timer = window.setInterval(() => {
      void Promise.all(
        activeJobs.map((job) =>
          readDownloaderJob(job.id).catch(() => job)
        )
      ).then((updated) => {
        setJobs((current) => mergeJobs(current, updated));
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [jobs]);

  const validateUrls = (urls: string[]) => {
    const errors: Array<{ url: string; error: string }> = [];
    if (urls.length > 1 && urls.some(isBlobVideoUrl)) {
      return [{ url: '', error: 'Download one browser blob video at a time.' }];
    }
    urls.forEach((url) => {
      if (!isHttpUrl(url) && !isBlobVideoUrl(url)) {
        errors.push({ url, error: 'Paste a valid public video URL.' });
        return;
      }
      if (isBlobVideoUrl(url)) return;
      if (isPlaceholderVideoPlatformUrl(url)) {
        errors.push({ url, error: 'That is a sample placeholder URL, not a real public video.' });
        return;
      }
      const platform = detectVideoPlatform(url);
      if (platform && !isDirectVideoPlatformUrl(url)) {
        errors.push({ url, error: describeDirectVideoPlatformUrlIssue(url) });
      }
    });
    return errors;
  };

  const handleCancelJob = async (job: DownloaderJob) => {
    try {
      const cancelled = await cancelDownloaderJob(job.id);
      setJobs((current) => mergeJobs(current, [cancelled]));
    } catch (error: any) {
      setJobErrors([{ url: job.url, error: error?.message || 'Could not cancel download.' }]);
    }
  };

  const handlePauseJob = async (job: DownloaderJob) => {
    try {
      const paused = await pauseDownloaderJob(job.id);
      setJobs((current) => mergeJobs(current, [paused]));
    } catch (error: any) {
      setJobErrors([{ url: job.url, error: error?.message || 'Could not pause download.' }]);
    }
  };

  const handleResumeJob = async (job: DownloaderJob) => {
    try {
      const resumed = await resumeDownloaderJob(job.id);
      setJobs((current) => mergeJobs(current, [resumed]));
    } catch (error: any) {
      setJobErrors([{ url: job.url, error: error?.message || 'Could not resume download.' }]);
    }
  };

  const handleBulkImageLinksDownload = async () => {
    const links = extractBulkAssetLinks(bulkImageLinks);
    if (links.length === 0) {
      setBulkImageResult({
        ok: false,
        message: 'Paste one or more image or font links: JPG, PNG, WEBP, AVIF, GIF, SVG, WOFF2, WOFF, TTF, OTF, EOT, or Google Fonts CSS.',
      });
      return;
    }
    setBulkImageDownloading(true);
    setBulkImageResult(null);
    try {
      const cssLinks = links.filter((url) => getBulkAssetKind(url) === 'font-css');
      const directAssets: BulkResolvedAsset[] = links
        .filter((url) => getBulkAssetKind(url) !== 'font-css')
        .map((url) => ({
          url,
          kind: getBulkAssetKind(url) === 'font' ? 'font' : 'image',
          filename: getUrlFilename(url, getBulkAssetKind(url) === 'font' ? 'font' : 'image'),
        }));

      let resolvedFontAssets: BulkResolvedAsset[] = [];
      if (cssLinks.length > 0) {
        const response = await apiFetch('/api/resolve-font-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: cssLinks }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || 'Could not resolve font CSS links.');
        }
        resolvedFontAssets = Array.isArray(data.fonts)
          ? data.fonts
              .map((font: any) => {
                const url = String(font?.url || '').trim();
                if (!url || !isSupportedBulkFontUrl(url)) return null;
                return {
                  url,
                  kind: 'font' as const,
                  filename: String(font?.originalFilename || '').trim() || getUrlFilename(url, 'font'),
                  cssSource: String(font?.cssSource || '').trim() || undefined,
                  family: String(font?.family || '').trim() || undefined,
                  weight: String(font?.weight || '').trim() || undefined,
                  style: String(font?.style || '').trim() || undefined,
                };
              })
              .filter(Boolean) as BulkResolvedAsset[]
          : [];
      }

      const assets = Array.from(
        new Map([...directAssets, ...resolvedFontAssets].map((asset) => [asset.url, asset])).values()
      );
      if (assets.length === 0) {
        throw new Error('No downloadable image or font files were found in the pasted links.');
      }

      const items = assets.flatMap((asset, index) => {
        const filename = asset.filename || getUrlFilename(asset.url, `${asset.kind}_${String(index + 1).padStart(3, '0')}`);
        const fallbackBase = filenameBaseFromName(filename) || `${asset.kind}_${String(index + 1).padStart(3, '0')}`;
        const filenameBase = asset.kind === 'font'
          ? buildBulkFontFilenameBase(asset, fallbackBase)
          : fallbackBase;
        const folder = asset.kind === 'font' ? 'Fonts' : 'Images';
        const familyFolder = asset.kind === 'font'
          ? sanitizeBulkPathPart(prettifyFontFamilyLabel(normalizeBulkFontFamily(asset.family || '')), 'Bulk Fonts')
          : '';
        const ext = filename.includes('.') ? filename.split('.').pop() || '' : '';
        const normalizedExt = String(ext || '').toLowerCase();
        const preferredFilename = asset.kind === 'font'
          ? `${sanitizeBulkPathPart(filenameBase, 'font')}${normalizedExt ? `.${normalizedExt}` : ''}`
          : filename;
        const originalItem = {
          url: asset.url,
          originalUrl: asset.url,
          assetType: asset.kind,
          status: 'path-only',
          preserveOriginal: true,
          filenameBase,
          filename: preferredFilename,
          metadataFilename: preferredFilename,
          zipEntryName: asset.kind === 'font'
            ? `${folder}/${familyFolder}/${preferredFilename}`
            : `${folder}/${filename}`,
          ...(asset.kind === 'font'
            ? {
                originalFormat: filename.split('.').pop()?.toLowerCase(),
                cssSource: asset.cssSource,
                family: normalizeBulkFontFamily(asset.family || ''),
                familyFolder,
                fontWeight: asset.weight,
                fontStyle: asset.style,
              }
            : {}),
        };
        if (asset.kind !== 'font') return [originalItem];
        return (['woff', 'ttf'] as const).map((format) => ({
          ...originalItem,
          preserveOriginal: normalizedExt === format,
          toFormat: format,
          filename: `${sanitizeBulkPathPart(filenameBase, 'font')}.${format}`,
          metadataFilename: `${sanitizeBulkPathPart(filenameBase, 'font')}.${format}`,
          zipEntryName: `${folder}/${familyFolder}/${sanitizeBulkPathPart(filenameBase, 'font')}.${format}`,
        }));
      });
      const response = await apiFetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          save: true,
          filename: 'bulk-asset-links.zip',
          rootFolderName: 'CreativeAssets',
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Bulk asset ZIP failed');
      const addedCount = Number(result?.addedCount || 0);
      const failedCount = Number(result?.failedCount || 0);
      if (addedCount <= 0) throw new Error('Bulk asset ZIP was created without downloadable files.');
      setBulkImageResult({
        ok: failedCount === 0,
        message:
          failedCount === 0
            ? `${addedCount} asset link${addedCount === 1 ? '' : 's'} saved as ${result.filename || 'bulk-asset-links.zip'}.`
            : `${addedCount} asset link${addedCount === 1 ? '' : 's'} saved; ${failedCount} failed.`,
      });
      onDownloadReady?.({
        title: 'Bulk assets saved',
        detail:
          failedCount === 0
            ? `${addedCount} asset link${addedCount === 1 ? '' : 's'} saved as ${result.filename || 'bulk-asset-links.zip'}.`
            : `${addedCount} asset link${addedCount === 1 ? '' : 's'} saved; ${failedCount} failed.`,
        target: 'downloads',
        folderPath: result?.folderPath,
      });
      setBulkImageLinks('');
    } catch (error: any) {
      setBulkImageResult({ ok: false, message: error?.message || 'Failed to download image/font links as ZIP.' });
    } finally {
      setBulkImageDownloading(false);
    }
  };

  const downloadQueue = async (
    quality: DownloaderQuality = 'fhd',
    overrideUrls?: string[],
    trimOverride?: { startTime?: string; endTime?: string; sourcePageUrl?: string; saveToWebsiteAssets?: boolean }
  ) => {
    const urls = overrideUrls || inputUrls;
    const requestedStartTime = trimOverride?.startTime ?? startTime;
    const requestedEndTime = trimOverride?.endTime ?? endTime;
    const requestedCookiesFilePath = cookiesFilePath.trim();
    if (!urls.length) {
      setJobErrors([{ url: '', error: 'Paste at least one public video URL.' }]);
      return;
    }
    const validationErrors = validateUrls(urls);
    if (validationErrors.length) {
      setJobErrors(validationErrors);
      return;
    }

    setBusy(true);
    setActiveQuality(quality);
    setJobErrors([]);
    setJobs([]);
    const activeDetectedPlatform = urls.length === 1 ? detectVideoPlatform(urls[0]) : null;
    void logActivity({
      kind: 'url_entered',
      url: urls[0],
      platform: activeDetectedPlatform || undefined,
      message: urls.length === 1 ? 'Video download started' : `${urls.length} video downloads started`,
    });
    void Promise.all(urls.map((item) => recordBookmarkHistory(item, 'video', titleFromUrl(item)))).catch(() => undefined);

    try {
      const resolvedSingle =
        urls.length === 1 && isBlobVideoUrl(urls[0])
          ? await resolveBrowserBlobVideo(urls[0])
          : null;
      const resolvedUrl = resolvedSingle?.url || urls[0];
      const started =
        urls.length === 1
          ? {
              jobs: [
                await startDownloaderJob({
                  url: resolvedUrl,
                  quality,
                  title: resolvedSingle?.title,
                  startTime: requestedStartTime,
                  endTime: requestedEndTime,
                  cookiesFilePath: requestedCookiesFilePath,
                  sourcePageUrl: trimOverride?.sourcePageUrl || resolvedSingle?.sourcePageUrl,
                  saveToWebsiteAssets: trimOverride?.saveToWebsiteAssets,
                }),
              ],
              errors: [] as Array<{ url: string; error: string }>,
            }
          : await startBulkDownloaderJobs(urls, quality, {
              startTime: requestedStartTime,
              endTime: requestedEndTime,
              cookiesFilePath: requestedCookiesFilePath,
            });
      const createdJobs = started.jobs || [];
      setJobErrors(started.errors || []);
      setJobs(createdJobs);

      if (!createdJobs.length) {
        setJobErrors(started.errors?.length ? started.errors : [{ url: '', error: 'No downloads could be started.' }]);
        return;
      }

      const completed = await Promise.all(
        createdJobs.map((initial) =>
          waitForDownloaderJob(initial, (updated) => {
            setJobs((current) => mergeJobs(current, [updated]));
          })
        )
      );
      setJobs((current) => mergeJobs(current, completed));
      const failed = completed.find((job) => job.status === 'error');
      if (failed && urls.length === 1) throw new Error(failed.error || 'Download failed.');
      if (!failed && !completed.some((job) => job.status === 'cancelled')) setUrlInput('');
    } catch (error: any) {
      const message = error?.message || 'Download failed.';
      setJobErrors([{ url: urls.length === 1 ? urls[0] : '', error: message }]);
      void reportOperationFailure({
        operation: 'video_download_failure',
        error: message,
        videoUrl: urls[0],
        platform: activeDetectedPlatform || undefined,
        openFeedback: false,
      });
    } finally {
      setBusy(false);
      setActiveQuality(null);
    }
  };

  useEffect(() => {
    if (!autoStartRequest?.url || handledAutoStartIdRef.current === autoStartRequest.id) return;
    handledAutoStartIdRef.current = autoStartRequest.id;
    const nextUrl = autoStartRequest.url.trim();
    const nextStartTime = String(autoStartRequest.startTime || '').trim();
    const nextEndTime = String(autoStartRequest.endTime || '').trim();
    setUrlInput(nextUrl);
    setJobErrors([]);
    setStartTime(nextStartTime);
    setEndTime(nextEndTime);
    void downloadQueue(autoStartRequest.quality || 'fhd', [nextUrl], {
      startTime: nextStartTime,
      endTime: nextEndTime,
      sourcePageUrl: autoStartRequest.sourcePageUrl,
      saveToWebsiteAssets: autoStartRequest.saveToWebsiteAssets,
    });
  }, [autoStartRequest]);

  useEffect(() => {
    registerControls?.({
      focusUrlInput: () => urlInputRef.current?.focus(),
      startDownload: () => void downloadQueue('fhd'),
      reset: resetVideoDownloader,
      getCurrentUrl: () => urlInput,
    });
  }, [downloadQueue, registerControls, resetVideoDownloader, urlInput]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap justify-center gap-2">
        {VIDEO_PLATFORMS.map((platform) => (
          <span
            key={platform.id}
            className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm"
          >
            {platform.label}
          </span>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 bg-zinc-50 px-5 py-3 sm:px-6">
          <h2 className="text-sm font-semibold text-zinc-900">Download Single/Bulk Video(s)</h2>
        </div>

        <div className="p-5 sm:p-6">
            <form onSubmit={(event) => { event.preventDefault(); void downloadQueue('fhd'); }} className="space-y-4">
              <PinnedBookmarks
                store={bookmarkStore}
                category="video"
                onOpen={(bookmark) => onOpenBookmark?.(bookmark)}
              />
              <div className="relative">
              <textarea
                aria-label="Video URL"
                ref={urlInputRef}
                value={urlInput}
                onChange={(event) => {
                  setUrlInput(event.target.value);
                  setJobErrors([]);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void downloadQueue('fhd');
                  }
                }}
                rows={5}
                placeholder="Paste video, m3u8, or browser blob URL (one per line)"
                className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                title="Download Video (Enter)"
              />
              <AutocompletePanel
                query={urlInput}
                store={bookmarkStore}
                category="video"
                onPick={(nextUrl) => {
                  setUrlInput(nextUrl);
                  setJobErrors([]);
                }}
              />
              </div>
              <div className="flex justify-end">
                <BookmarkStarButton
                  url={inputUrls[0] || urlInput}
                  category="video"
                  store={bookmarkStore}
                  onChanged={() => onBookmarksChanged?.()}
                />
              </div>
              <RecentRows
                store={bookmarkStore}
                category="video"
                title="Recent Downloads"
                onOpen={(nextUrl) => {
                  setUrlInput(nextUrl);
                  setJobErrors([]);
                }}
                onBookmark={(nextUrl) => void saveBookmark({ url: nextUrl, category: 'video', title: titleFromUrl(nextUrl), favorite: true, tags: [] }).then(() => onBookmarksChanged?.())}
                onDelete={(nextUrl) => void deleteRecentHistory(nextUrl, 'video').then(() => onBookmarksChanged?.()).catch((error) => setJobErrors([{ url: nextUrl, error: error?.message || 'Could not delete recent download.' }] ))}
                onClear={() => void clearRecentHistory('video').then(() => onBookmarksChanged?.()).catch((error) => setJobErrors([{ url: 'Recent Downloads', error: error?.message || 'Could not clear recent downloads.' }] ))}
              />

              <div className="flex flex-wrap items-center gap-2">
                {inputUrls.length === 1 && isBlobVideoUrl(inputUrls[0]) ? (
                  <p className="rounded-lg border border-violet-100 bg-violet-50 px-3 py-2 text-sm text-violet-900">
                    Browser blob detected · keep its Chrome tab open and playing
                  </p>
                ) : detectedPlatform ? (
                  <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                    Detected: <span className="font-semibold">{platformLabel(detectedPlatform)}</span>
                  </p>
                ) : inputUrls.length > 1 ? (
                  <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                    {inputUrls.length} URLs ready
                  </p>
                ) : null}
                {runningCount || completeCount || failedCount ? (
                  <p className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700">
                    {runningCount ? `${runningCount} active` : 'No active downloads'}
                    {pausedCount ? ` · ${pausedCount} paused` : ''}
                    {completeCount ? ` · ${completeCount} complete` : ''}
                    {failedCount ? ` · ${failedCount} failed` : ''}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Start time
                  <input
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                    placeholder="0:00 or 90"
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </label>
                <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  End time
                  <input
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                    placeholder="2:30 or leave blank"
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </label>
                <p className="text-xs text-zinc-500 sm:col-span-2">
                  Optional. Downloads only this time range so users do not wait for the full video. Use seconds or hh:mm:ss.
                </p>
              </div>

              {needsCookieFileOption(detectedPlatform) ? (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                  <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Cookies.txt file path
                    <input
                      value={cookiesFilePath}
                      onChange={(event) => setCookiesFilePath(event.target.value)}
                      placeholder="Optional: /Users/name/Downloads/cookies.txt"
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </label>
                  <p className="mt-2 text-xs text-zinc-500">
                    Use only when a platform blocks public extraction. This reads a cookies.txt file and never opens Chrome Keychain.
                  </p>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  aria-pressed={busy && activeQuality === 'fhd'}
                  disabled={busy || inputUrls.length === 0}
                  className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed ${busy && activeQuality === 'fhd' ? 'bg-blue-800 ring-2 ring-blue-300' : 'bg-blue-600 hover:bg-blue-700 disabled:opacity-50'}`}
                >
                  {busy && activeQuality === 'fhd' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {busy && activeQuality === 'fhd' ? 'Downloading Video...' : inputUrls.length > 1 ? 'Download All Video' : 'Download Video'}
                </button>
              </div>
            </form>

            {jobErrors.length ? (
              <div className="mt-5 space-y-3">
                {jobErrors.map((item, index) => (
                  <div key={`${item.url}-${index}`} className="space-y-2">
                    <FriendlyError
                      message={item.url ? `${item.url}: ${item.error}` : item.error}
                      onReportIssue={() => requestOpenFeedback()}
                    />
                    {isYouTubeUrl(item.url) ? (
                      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-medium text-blue-950">
                            YouTube blocked this download here. Open the backup page and paste the copied URL.
                          </p>
                          <YouTubeFallbackLink url={item.url} />
                        </div>
                      </div>
                    ) : null}
                    {isInstagramUrl(item.url) && isInstagramCookieError(item.error) ? (
                      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
                        <div className="text-sm text-blue-950">
                          <p className="font-semibold">Instagram blocked public extraction here.</p>
                          <p className="mt-1 text-blue-900">
                            Add a cookies.txt path above and retry. The app will use that file directly and will not open Chrome Keychain.
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {jobs.length ? (
              <div className="mt-5 space-y-3">
                {jobs.map((job) => (
                  <DownloadJobCard
                    key={job.id}
                    job={job}
                    compact
                    onCancel={(item) => void handleCancelJob(item)}
                    onPause={(item) => void handlePauseJob(item)}
                    onResume={(item) => void handleResumeJob(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500">
                Progress and completion will appear here.
              </div>
            )}

            <CompletedDownloadGrid jobs={completedJobs} />
        </div>
      </section>

      <section className="mt-6 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 bg-zinc-50 px-5 py-3 sm:px-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <LinkIcon className="h-4 w-4 text-blue-600" />
            Download Single/Bulk Image(s)
          </h2>
        </div>
        <div className="p-5 sm:p-6">
          <textarea
            aria-label="Bulk image links"
            value={bulkImageLinks}
            onChange={(event) => {
              setBulkImageLinks(event.target.value);
              setBulkImageResult(null);
            }}
            rows={5}
            placeholder="Paste image or font links here, JPG, PNG, WEBP, AVIF, GIF, SVG, WOFF2, WOFF, TTF, OTF, EOT, Google/Typekit/Client Fonts CSS"
            className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleBulkImageLinksDownload()}
              disabled={bulkImageDownloading}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkImageDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {bulkImageDownloading ? 'Creating Assets ZIP...' : `Download Assets ZIP (${extractBulkAssetLinks(bulkImageLinks).length})`}
            </button>
          </div>
          {bulkImageResult ? (
            <div
              role="status"
              className={`mt-4 rounded-xl border px-4 py-3 text-sm font-medium ${
                bulkImageResult.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {bulkImageResult.message}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
