import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, FolderOpen, Loader2, Play, Trash2 } from 'lucide-react';
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
  clearDownloaderFiles,
  startBulkDownloaderJobs,
  startDownloaderJob,
  waitForDownloaderJob,
  type DownloaderJob,
} from '../lib/videoDownloader';
import { formatBytes } from '../lib/download';
import { logActivity, reportOperationFailure } from '../lib/activityLog';
import { requestOpenFeedback } from '../lib/feedbackContext';
import { FriendlyError } from './ProgressExperience';
import ValidatedVideoThumb from './ValidatedVideoThumb';

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const parseInputUrls = (value: string) =>
  Array.from(new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)));

const mergeJobs = (current: DownloaderJob[], updates: DownloaderJob[]) => {
  const byId = new Map(current.map((job) => [job.id, job]));
  updates.forEach((job) => byId.set(job.id, job));
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
};

const jobStatusLabel = (job: DownloaderJob) => {
  if (job.status === 'completed') return 'Complete';
  if (job.status === 'error') return 'Failed';
  if (job.status === 'queued') return 'Queued';
  return `${Math.round(job.progress || 0)}%`;
};

const jobProgressWidth = (job: DownloaderJob) => {
  if (job.status === 'completed') return 100;
  if (job.status === 'error') return 100;
  if (job.status === 'queued') return 5;
  return Math.max(8, Math.min(99, Math.round(job.progress || 0)));
};

const platformLabel = (id: string) => VIDEO_PLATFORMS.find((entry) => entry.id === id)?.label || id;

function DownloadJobCard({ job, compact = false }: { job: DownloaderJob; compact?: boolean }) {
  const isComplete = job.status === 'completed';
  const isError = job.status === 'error';
  const title = job.title || job.result?.title || job.url;
  return (
    <div className={`rounded-xl border p-4 ${isError ? 'border-amber-200 bg-amber-50' : isComplete ? 'border-emerald-200 bg-emerald-50' : 'border-blue-100 bg-blue-50'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-950" title={title}>{title}</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-zinc-600">
            {platformLabel(job.platform)} · {job.quality === 'fhd' ? 'FHD / HD fallback' : job.quality.toUpperCase()}
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

function CompletedDownloadGrid({ jobs, onClearDownloads }: { jobs: DownloaderJob[]; onClearDownloads: () => void }) {
  if (jobs.length === 0) return null;
  return (
    <div className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900">Completed Video{jobs.length === 1 ? '' : 's'}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500">{jobs.length} ready</span>
          <button
            type="button"
            onClick={onClearDownloads}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear Downloads
          </button>
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

export default function VideoDownloaderPage() {
  const [urlInput, setUrlInput] = useState('');
  const [jobs, setJobs] = useState<DownloaderJob[]>([]);
  const [jobErrors, setJobErrors] = useState<Array<{ url: string; error: string }>>([]);
  const [busy, setBusy] = useState(false);

  const inputUrls = useMemo(() => parseInputUrls(urlInput), [urlInput]);
  const detectedPlatform = useMemo(
    () => (inputUrls.length === 1 ? detectVideoPlatform(inputUrls[0]) : null),
    [inputUrls]
  );
  const runningCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const completeCount = jobs.filter((job) => job.status === 'completed').length;
  const failedCount = jobs.filter((job) => job.status === 'error').length;
  const completedJobs = jobs.filter((job) => job.status === 'completed' && job.result);

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
          .filter((job) => job.status === 'queued' || job.status === 'running' || Date.now() - job.updatedAt < 30 * 60 * 1000)
          .slice(0, 12)
          .reverse();
        setJobs(recent);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
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
    urls.forEach((url) => {
      if (!isHttpUrl(url)) {
        errors.push({ url, error: 'Paste a valid public video URL.' });
        return;
      }
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

  const handleClearDownloads = async () => {
    try {
      await clearDownloaderFiles(true);
      setJobs((current) => current.filter((job) => job.status !== 'completed' && job.status !== 'error'));
    } catch (error: any) {
      alert(error?.message || 'Could not clear video downloads.');
    }
  };

  const downloadQueue = async (event: React.FormEvent) => {
    event.preventDefault();
    const urls = inputUrls;
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
    setJobErrors([]);
    setJobs([]);
    void logActivity({
      kind: 'url_entered',
      url: urls[0],
      platform: urls.length === 1 ? detectedPlatform || undefined : undefined,
      message: urls.length === 1 ? 'Video download started' : `${urls.length} video downloads started`,
    });

    try {
      const started =
        urls.length === 1
          ? { jobs: [await startDownloaderJob({ url: urls[0], quality: 'fhd' })], errors: [] as Array<{ url: string; error: string }> }
          : await startBulkDownloaderJobs(urls);
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
      if (!failed) setUrlInput('');
    } catch (error: any) {
      const message = error?.message || 'Download failed.';
      setJobErrors([{ url: urls.length === 1 ? urls[0] : '', error: message }]);
      void reportOperationFailure({
        operation: 'video_download_failure',
        error: message,
        videoUrl: urls[0],
        platform: urls.length === 1 ? detectedPlatform || undefined : undefined,
        openFeedback: false,
      });
    } finally {
      setBusy(false);
    }
  };

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
          <h2 className="text-sm font-semibold text-zinc-900">Single/Bulk Download</h2>
        </div>

        <div className="p-5 sm:p-6">
            <form onSubmit={downloadQueue} className="space-y-4">
              <textarea
                aria-label="Video URL"
                value={urlInput}
                onChange={(event) => {
                  setUrlInput(event.target.value);
                  setJobErrors([]);
                }}
                rows={5}
                placeholder="Paste one or more public video URLs, one per line"
                className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />

              <div className="flex flex-wrap items-center gap-2">
                {detectedPlatform ? (
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
                    {completeCount ? ` · ${completeCount} complete` : ''}
                    {failedCount ? ` · ${failedCount} failed` : ''}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={busy || inputUrls.length === 0}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {busy ? 'Downloading...' : inputUrls.length > 1 ? `Download ${inputUrls.length} Videos` : 'Download'}
              </button>
            </form>

            {jobErrors.length ? (
              <div className="mt-5 space-y-3">
                {jobErrors.map((item, index) => (
                  <FriendlyError
                    key={`${item.url}-${index}`}
                    message={item.url ? `${item.url}: ${item.error}` : item.error}
                    onReportIssue={() => requestOpenFeedback()}
                  />
                ))}
              </div>
            ) : null}

            {jobs.length ? (
              <div className="mt-5 space-y-3">
                {jobs.map((job) => (
                  <DownloadJobCard key={job.id} job={job} compact />
                ))}
              </div>
            ) : (
              <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500">
                Progress and completion will appear here.
              </div>
            )}

            <CompletedDownloadGrid jobs={completedJobs} onClearDownloads={handleClearDownloads} />
        </div>
      </section>
    </div>
  );
}
