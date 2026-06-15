import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, Loader2, Play, RefreshCw, Trash2 } from 'lucide-react';
import { readVideoDownloaderSession, writeVideoDownloaderSession } from '../lib/appSessions';
import {
  VIDEO_PLATFORMS,
  describeDirectVideoPlatformUrlIssue,
  detectVideoPlatform,
  isDirectVideoPlatformUrl,
  isPlaceholderVideoPlatformUrl,
} from '../lib/videoPlatform';
import {
  clearDownloaderFiles,
  listDownloaderFiles,
  openDownloaderFile,
  revealDownloaderFile,
  startBulkDownloaderJobs,
  startDownloaderJob,
  waitForDownloaderJob,
  type DownloaderFile,
  type DownloaderJob,
} from '../lib/videoDownloader';
import { formatBytes } from '../lib/download';
import { logActivity, reportOperationFailure } from '../lib/activityLog';
import { requestOpenFeedback } from '../lib/feedbackContext';
import { FriendlyError } from './ProgressExperience';
import ValidatedVideoThumb from './ValidatedVideoThumb';

type DownloaderTab = 'single' | 'bulk' | 'downloads';

const restored = readVideoDownloaderSession();
const restoredTab = ['single', 'bulk', 'downloads'].includes(String(restored?.activeTab || ''))
  ? (restored?.activeTab as DownloaderTab)
  : 'single';

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const formatDate = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export default function VideoDownloaderPage() {
  const [activeTab, setActiveTab] = useState<DownloaderTab>(restoredTab);
  const [singleUrl, setSingleUrl] = useState(restored?.singleUrl || restored?.url || '');
  const [bulkUrls, setBulkUrls] = useState(restored?.bulkUrls || '');
  const [singleJob, setSingleJob] = useState<DownloaderJob | null>(null);
  const [singleBusy, setSingleBusy] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);
  const [bulkJobs, setBulkJobs] = useState<DownloaderJob[]>([]);
  const [bulkErrors, setBulkErrors] = useState<Array<{ url: string; error: string }>>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [downloads, setDownloads] = useState<DownloaderFile[]>([]);
  const [downloadsBusy, setDownloadsBusy] = useState(false);
  const [downloadsError, setDownloadsError] = useState<string | null>(null);
  const detectedPlatform = useMemo(() => detectVideoPlatform(singleUrl.trim()), [singleUrl]);

  useEffect(() => {
    writeVideoDownloaderSession({
      url: singleUrl,
      singleUrl,
      bulkUrls,
      activeTab,
      video: null,
      videos: [],
      savedAt: Date.now(),
    });
  }, [activeTab, bulkUrls, singleUrl]);

  const refreshDownloads = async () => {
    setDownloadsBusy(true);
    setDownloadsError(null);
    try {
      setDownloads(await listDownloaderFiles());
    } catch (error: any) {
      setDownloadsError(error?.message || 'Could not load downloads.');
    } finally {
      setDownloadsBusy(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'downloads') void refreshDownloads();
  }, [activeTab]);

  const downloadSingle = async (event: React.FormEvent) => {
    event.preventDefault();
    const url = singleUrl.trim();
    if (!url || !isHttpUrl(url)) {
      setSingleError('Paste a valid public video URL.');
      return;
    }
    if (isPlaceholderVideoPlatformUrl(url)) {
      setSingleError('That is a sample placeholder URL, not a real public video. Paste the actual Facebook/X/Instagram video link.');
      return;
    }
    if (detectedPlatform && !isDirectVideoPlatformUrl(url)) {
      setSingleError(describeDirectVideoPlatformUrlIssue(url));
      return;
    }

    setSingleBusy(true);
    setSingleError(null);
    setSingleJob(null);
    void logActivity({
      kind: 'url_entered',
      url,
      platform: detectedPlatform || undefined,
      message: 'Video download started',
    });
    try {
      const started = await startDownloaderJob({ url, quality: 'fhd' });
      const completed = await waitForDownloaderJob(started, setSingleJob);
      if (completed.status === 'error') throw new Error(completed.error || 'Download failed.');
      await refreshDownloads();
      setActiveTab('downloads');
    } catch (error: any) {
      const message = error?.message || 'Download failed.';
      setSingleError(message);
      void reportOperationFailure({
        operation: 'video_download_failure',
        error: message,
        videoUrl: url,
        platform: detectedPlatform || undefined,
        openFeedback: false,
      });
    } finally {
      setSingleBusy(false);
    }
  };

  const runBulk = async () => {
    const urls = Array.from(new Set(bulkUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)));
    if (!urls.length) {
      setBulkErrors([{ url: '', error: 'Enter at least one video URL.' }]);
      return;
    }
    setBulkBusy(true);
    setBulkJobs([]);
    setBulkErrors([]);
    try {
      const result = await startBulkDownloaderJobs(urls);
      setBulkErrors(result.errors || []);
      setBulkJobs(result.jobs || []);
      await Promise.all(
        (result.jobs || []).map((initial) =>
          waitForDownloaderJob(initial, (updated) => {
            setBulkJobs((current) => {
              const next = current.filter((job) => job.id !== updated.id);
              return [...next, updated].sort((a, b) => a.createdAt - b.createdAt);
            });
          })
        )
      );
      setBulkUrls('');
    } catch (error: any) {
      setBulkErrors([{ url: '', error: error?.message || 'Bulk download failed.' }]);
    } finally {
      setBulkBusy(false);
    }
  };

  const clearDownloads = async () => {
    if (!window.confirm('Clear all files created by Video Downloader?')) return;
    setDownloadsBusy(true);
    setDownloadsError(null);
    try {
      await clearDownloaderFiles();
      await refreshDownloads();
    } catch (error: any) {
      setDownloadsError(error?.message || 'Could not clear downloads.');
      setDownloadsBusy(false);
    }
  };

  const platformLabel = (id: string) => VIDEO_PLATFORMS.find((entry) => entry.id === id)?.label || id;

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mb-5 text-center text-sm text-zinc-600">
        Download public videos from YouTube, Vimeo, Instagram, Facebook, X.com, and iSpot.tv. FHD is preferred with HD fallback.
      </p>

      <div className="mb-5 flex flex-wrap justify-center gap-2">
        {VIDEO_PLATFORMS.map((platform) => {
          const selected = detectedPlatform === platform.id;
          return (
            <button
              key={platform.id}
              type="button"
              onClick={() => {
                setActiveTab('single');
                setSingleUrl(platform.exampleUrl || '');
                setSingleJob(null);
                setSingleError(platform.exampleUrl ? null : `Paste a public ${platform.label} video URL.`);
              }}
              className={
                selected
                  ? 'rounded-full border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm'
                  : 'rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm hover:border-blue-200 hover:text-blue-700'
              }
            >
              {platform.label}
            </button>
          );
        })}
      </div>

      <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="grid grid-cols-3 border-b border-zinc-200 bg-zinc-50 p-2">
          {(['single', 'bulk', 'downloads'] as DownloaderTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={
                activeTab === tab
                  ? 'rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm'
                  : 'rounded-xl px-4 py-2.5 text-sm font-semibold capitalize text-zinc-600 hover:bg-white hover:text-blue-700'
              }
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === 'single' ? (
          <div className="p-5 sm:p-6">
            <form onSubmit={downloadSingle} className="space-y-4">
              <label className="block text-sm font-medium text-zinc-800">Paste URL</label>
              <input
                type="url"
                value={singleUrl}
                onChange={(event) => {
                  setSingleUrl(event.target.value);
                  setSingleJob(null);
                  setSingleError(null);
                }}
                placeholder="https://www.instagram.com/reel/..."
                className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              {detectedPlatform ? (
                <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  Detected: <span className="font-semibold">{platformLabel(detectedPlatform)}</span>
                </p>
              ) : null}
              <button
                type="submit"
                disabled={singleBusy || !singleUrl.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {singleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {singleBusy ? 'Downloading...' : 'Download'}
              </button>
            </form>

            {singleJob ? (
              <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50 p-4">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-blue-900">
                  <span>{singleJob.message}</span>
                  <span>{singleJob.status === 'completed' ? '100%' : `${Math.round(singleJob.progress || 0)}%`}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-500"
                    style={{ width: `${Math.max(2, singleJob.status === 'completed' ? 100 : singleJob.progress || 0)}%` }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-blue-700">
                  <span>{singleJob.quality === 'fhd' ? 'FHD with HD fallback' : singleJob.quality.toUpperCase()}</span>
                  {singleJob.downloadedBytes ? <span>{formatBytes(singleJob.downloadedBytes)}</span> : null}
                  {singleJob.speed ? <span>{singleJob.speed}</span> : null}
                  {singleJob.eta ? <span>ETA {singleJob.eta}</span> : null}
                </div>
              </div>
            ) : null}

            {singleError ? (
              <div className="mt-5">
                <FriendlyError message={singleError} onReportIssue={() => requestOpenFeedback()} />
              </div>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'bulk' ? (
          <div className="p-5 sm:p-6">
            <label className="block text-sm font-medium text-zinc-800">Multiple URLs, one per line</label>
            <textarea
              value={bulkUrls}
              onChange={(event) => setBulkUrls(event.target.value)}
              rows={7}
              placeholder={'https://www.youtube.com/watch?v=...\nhttps://www.instagram.com/reel/...\nhttps://x.com/user/status/...'}
              className="mt-3 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <button
              type="button"
              disabled={bulkBusy || !bulkUrls.trim()}
              onClick={() => void runBulk()}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {bulkBusy ? 'Downloading queue...' : 'Download All (FHD / HD fallback)'}
            </button>

            {bulkErrors.map((item, index) => (
              <p key={`${item.url}-${index}`} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {item.url ? `${item.url}: ` : ''}{item.error}
              </p>
            ))}

            {bulkJobs.length ? (
              <div className="mt-5 space-y-3">
                {bulkJobs.map((job) => (
                  <div key={job.id} className="rounded-xl border border-zinc-200 bg-white p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="max-w-2xl truncate text-sm font-semibold text-zinc-900">{job.title || job.url}</p>
                        <p className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{job.platform} · {job.quality}</p>
                      </div>
                      <span className={job.status === 'error' ? 'text-sm font-semibold text-amber-700' : 'text-sm font-semibold text-blue-700'}>
                        {job.status === 'completed' ? 'Complete' : job.status === 'error' ? 'Failed' : `${Math.round(job.progress)}%`}
                      </span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className={job.status === 'error' ? 'h-full bg-amber-500' : 'h-full bg-blue-600 transition-all duration-500'}
                        style={{ width: `${Math.max(job.status === 'error' ? 100 : 2, job.progress || 0)}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-zinc-600">{job.error || job.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'downloads' ? (
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={downloadsBusy}
                onClick={() => void refreshDownloads()}
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                <RefreshCw className={downloadsBusy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                Refresh
              </button>
              <button
                type="button"
                disabled={downloadsBusy || downloads.length === 0}
                onClick={() => void clearDownloads()}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Clear All
              </button>
            </div>

            {downloadsError ? <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{downloadsError}</p> : null}

            {!downloadsBusy && downloads.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500">
                No downloads yet. Use Single or Bulk to download a video.
              </div>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {downloads.map((file) => (
                <div key={file.path} className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
                  <ValidatedVideoThumb
                    thumbnail={file.thumbnail}
                    title={file.title || file.name}
                    provider={file.platform}
                    className="h-36 w-full"
                  />
                  <div className="p-4">
                    <p className="truncate text-sm font-semibold text-zinc-900" title={file.title || file.name}>
                      {file.title || file.name}
                    </p>
                    <p className="mt-1 truncate text-xs text-zinc-500" title={file.displayPath}>{file.displayPath}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-600">
                      <span className="rounded bg-zinc-100 px-2 py-1 uppercase">{file.platform}</span>
                      <span className="rounded bg-blue-50 px-2 py-1 font-semibold text-blue-700">{file.quality}</span>
                      <span className="rounded bg-green-50 px-2 py-1 font-semibold text-green-700">{file.status || 'completed'}</span>
                      <span className="rounded bg-zinc-100 px-2 py-1">{formatBytes(file.size)}</span>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">{formatDate(file.modifiedAt)}</p>
                    {file.zipDisplayPath ? (
                      <p className="mt-1 truncate text-xs text-zinc-500" title={file.zipDisplayPath}>
                        ZIP: {file.zipDisplayPath}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void openDownloaderFile(file)}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Open File
                      </button>
                      <button
                        type="button"
                        onClick={() => void revealDownloaderFile(file)}
                        className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        Open Folder
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

    </div>
  );
}
