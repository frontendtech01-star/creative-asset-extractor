import React, { useMemo, useState } from 'react';
import { Download, Loader2, Music } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatBytes } from '../lib/download';
import {
  downloaderFileUrl,
  startDownloaderJob,
  waitForDownloaderJob,
  type DownloaderJob,
  type DownloaderQuality,
  type DownloaderVideo,
} from '../lib/videoDownloader';
import { reportOperationFailure } from '../lib/activityLog';
import { requestOpenFeedback } from '../lib/feedbackContext';
import ValidatedVideoThumb from './ValidatedVideoThumb';

export type VideoCardData = DownloaderVideo;

const formatDuration = (seconds?: number) => {
  const value = Number(seconds || 0);
  if (!value || !Number.isFinite(value)) return '';
  const hours = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  return hours > 0
    ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${mins}:${String(secs).padStart(2, '0')}`;
};

export const qualityAvailable = (video: VideoCardData, quality: 'fhd' | 'hd') =>
  quality === 'fhd'
    ? Boolean(video.qualityVariants?.fhd?.formatAvailable || video.streams?.FHD?.ready)
    : Boolean(video.qualityVariants?.hd?.formatAvailable || video.streams?.HD?.ready);

export const pickVideoDownloadQuality = (video: VideoCardData): 'fhd' | 'hd' =>
  qualityAvailable(video, 'fhd') ? 'fhd' : 'hd';

export default function VideoDownloaderCard({
  video,
  onDownloadComplete,
}: {
  video: VideoCardData;
  onDownloadComplete?: (job: DownloaderJob) => void;
}) {
  const [job, setJob] = useState<DownloaderJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerLabel = String(video.provider || video.platform || 'video').toUpperCase();
  const fhdAvailable = qualityAvailable(video, 'fhd');
  const hdAvailable = qualityAvailable(video, 'hd');
  const audioAvailable = video.audioAvailable !== false && video.noAudio !== true;
  const durationLabel = formatDuration(video.duration);
  const busy = job?.status === 'queued' || job?.status === 'running';
  const displayTitle = useMemo(() => String(video.title || `${providerLabel} video`).trim(), [providerLabel, video.title]);

  const openFolder = async () => {
    try {
      await apiFetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'video-downloads', sourcePageUrl: video.url }),
      });
    } catch {
      // Best effort.
    }
  };

  const runDownload = async (quality: DownloaderQuality) => {
    if (busy) return;
    setError(null);
    setJob(null);
    try {
      const started = await startDownloaderJob({ url: video.url, quality, title: displayTitle });
      const completed = await waitForDownloaderJob(started, setJob);
      if (completed.status === 'error') throw new Error(completed.error || 'Download failed.');
      onDownloadComplete?.(completed);
    } catch (err: any) {
      const message = err?.message || 'Download failed.';
      setError(message);
      void reportOperationFailure({
        operation: quality === 'audio' ? 'audio_extraction_failure' : 'video_download_failure',
        error: message,
        videoUrl: video.url,
        platform: video.platform,
        assetType: quality === 'audio' ? 'audio' : 'video',
        openFeedback: false,
      });
    }
  };

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="relative bg-zinc-900">
        <ValidatedVideoThumb
          thumbnail={video.thumbnail}
          title={displayTitle}
          provider={providerLabel}
          className="h-44 w-full sm:h-48"
        />
        <span className="absolute left-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-700 shadow-sm">
          {providerLabel}
        </span>
        {durationLabel ? (
          <span className="absolute bottom-3 right-3 rounded-md bg-zinc-950/85 px-2 py-1 text-xs font-semibold text-white">
            {durationLabel}
          </span>
        ) : null}
      </div>

      <div className="p-5">
        <h3 className="line-clamp-2 min-h-10 font-semibold text-zinc-900" title={displayTitle}>
          {displayTitle}
        </h3>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
            {fhdAvailable ? 'FHD available' : 'HD fallback'}
          </span>
          {video.maxHeight ? (
            <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600">
              up to {video.maxHeight}p
            </span>
          ) : null}
          <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600">
            {audioAvailable ? 'Audio available' : 'No separate audio'}
          </span>
        </div>

        {video.fallbackMessage ? (
          <p className="mt-3 text-xs font-medium text-amber-700">{video.fallbackMessage}</p>
        ) : null}

        {job ? (
          <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
            <div className="flex items-center justify-between gap-3 text-xs font-semibold text-blue-800">
              <span>{job.message}</span>
              <span>{Math.round(job.progress || 0)}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-500"
                style={{ width: `${Math.max(2, job.progress || 0)}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-blue-700">
              {job.downloadedBytes ? <span>{formatBytes(job.downloadedBytes)}</span> : null}
              {job.speed ? <span>{job.speed}</span> : null}
              {job.eta ? <span>ETA {job.eta}</span> : null}
            </div>
            {job.status === 'completed' && job.result ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={downloaderFileUrl(job.result)}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Save file
                </a>
                <button
                  type="button"
                  onClick={() => void openFolder()}
                  className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                >
                  Open folder
                </button>
                <span className="self-center text-xs text-blue-700">{job.result.displayPath}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">{error}</p>
            <button
              type="button"
              onClick={() => requestOpenFeedback()}
              className="mt-2 rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-950"
            >
              Report Issue
            </button>
          </div>
        ) : null}

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            disabled={busy || !fhdAvailable}
            onClick={() => void runDownload('fhd')}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && job?.quality === 'fhd' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download FHD
          </button>
          <button
            type="button"
            disabled={busy || !hdAvailable}
            onClick={() => void runDownload('hd')}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-semibold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && job?.quality === 'hd' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download HD
          </button>
          <button
            type="button"
            disabled={busy || !audioAvailable}
            onClick={() => void runDownload('audio')}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-900 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && job?.quality === 'audio' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Music className="h-4 w-4" />}
            Download Audio
          </button>
        </div>
      </div>
    </article>
  );
}
