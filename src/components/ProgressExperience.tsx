import React from 'react';
import { Activity, AlertCircle, CheckCircle2, FolderOpen, Radio, Zap } from 'lucide-react';
import { formatBytes, formatEta, formatSpeed } from '../lib/download';

type ProgressMode = 'extract' | 'download' | 'convert' | 'audio' | 'video-discover';

const modeAccent: Record<ProgressMode, string> = {
  extract: 'from-blue-500 via-cyan-400 to-emerald-400',
  download: 'from-emerald-500 via-cyan-400 to-blue-500',
  convert: 'from-violet-500 via-blue-500 to-cyan-400',
  audio: 'from-pink-500 via-orange-400 to-amber-300',
  'video-discover': 'from-blue-500 via-cyan-400 to-emerald-400',
};

const modeLabel: Record<ProgressMode, string> = {
  extract: 'Asset scan',
  download: 'Download',
  convert: 'FFmpeg activity',
  audio: 'Audio engine',
  'video-discover': 'Video scan',
};

export const extractionMessages = [
  'Scanning page HTML and CSS...',
  'Finding images, fonts, and colors...',
  'Checking embedded media sources...',
  'Resolving asset URLs...',
  'Preparing preview list...',
  'Almost ready...',
  'Finalizing extraction results...',
];

export const conversionMessages = [
  'Converting stream to MP4...',
  'Merging audio and video...',
  'Optimizing playback compatibility...',
  'Finalizing export...',
  'Preparing download file...',
];

export const audioMessages = [
  'Audio mode enabled...',
  'Selecting fastest audio-only stream...',
  'Converting lightweight MP3...',
  'Checking audio track availability...',
  'Preparing audio download...',
];

export const downloadMessages = [
  'Reading assets from extraction cache...',
  'Packing cached files into ZIP...',
  'No re-download — using saved originals...',
  'Finalizing ZIP archive...',
  'Almost ready...',
  'Preparing save prompt...',
];

export const videoDownloadMessages = [
  'Starting yt-dlp download...',
  'Fetching video stream...',
  'Merging video + audio...',
  'Optimizing MP4 for QuickTime...',
  'Finalizing download file...',
  'Almost ready...',
];

export const videoDiscoveryMessages = [
  'Scanning page for embedded players...',
  'Finding Vimeo, YouTube, and MP4 sources...',
  'Resolving FHD and HD stream options...',
  'Preparing video preview cards...',
  'Almost ready...',
];

export function useSmoothProgress(active: boolean, actualProgress?: number, ceiling = 94, loadedBytes = 0) {
  const [displayProgress, setDisplayProgress] = React.useState(0);
  const startedRef = React.useRef(0);
  const frameRef = React.useRef<number | null>(null);
  const actualProgressRef = React.useRef(actualProgress);
  const loadedBytesRef = React.useRef(loadedBytes);

  React.useEffect(() => {
    actualProgressRef.current = actualProgress;
  }, [actualProgress]);

  React.useEffect(() => {
    loadedBytesRef.current = loadedBytes;
  }, [loadedBytes]);

  React.useEffect(() => {
    if (!active) {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      setDisplayProgress(0);
      startedRef.current = 0;
      return;
    }

    startedRef.current = performance.now();
    let lastPaint = 0;

    const tick = (now: number) => {
      if (!startedRef.current) startedRef.current = now;
      const elapsed = now - startedRef.current;
      const actual = actualProgressRef.current;
      const hasBytes = loadedBytesRef.current > 0;
      const longWaitBoost =
        actual === undefined && !hasBytes && elapsed > 8000
          ? Math.min(4, (elapsed - 8000) / 15000)
          : 0;
      const effectiveCeiling = Math.min(99.8, ceiling + longWaitBoost);
      const optimistic = 8 + (effectiveCeiling - 8) * (1 - Math.exp(-elapsed / 5200)) + Math.sin(now / 430) * 0.7;
      const byteBoost = hasBytes && actual === undefined
        ? Math.min(99, 12 + (1 - Math.exp(-loadedBytesRef.current / 650000)) * 87)
        : undefined;
      const target = actual === undefined
        ? Math.max(optimistic, byteBoost ?? 0)
        : Math.max(actual, optimistic * 0.25, byteBoost ?? 0);

      if (now - lastPaint > 70) {
        setDisplayProgress((prev) => {
          const cap = actual === 100 ? 100 : effectiveCeiling;
          const next = prev + (Math.min(target, cap) - prev) * (hasBytes ? 0.28 : 0.18);
          return Math.max(prev, Math.min(100, next));
        });
        lastPaint = now;
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [active, ceiling]);

  return actualProgress === 100 ? 100 : active ? displayProgress : 0;
}

function useRotatingStatus(active: boolean, messages: string[], intervalMs = 1450) {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }

    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % messages.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, messages.length]);

  return messages[index] || messages[0] || 'Working...';
}

export function WaveformMeter({ active = true }: { active?: boolean }) {
  return (
    <div className="flex h-10 items-end gap-1.5" aria-hidden="true">
      {Array.from({ length: 18 }).map((_, index) => (
        <span
          key={index}
          className={`waveform-bar block w-1.5 rounded-full bg-gradient-to-t from-amber-500 to-pink-500 ${active ? '' : 'opacity-40'}`}
          style={{ animationDelay: `${index * 62}ms` }}
        />
      ))}
    </div>
  );
}

export function SmartProgressPanel({
  active,
  mode,
  title,
  detail,
  messages,
  progress,
  loadedBytes = 0,
  totalBytes,
  speedBps,
  etaSeconds,
}: {
  active: boolean;
  mode: ProgressMode;
  title: string;
  detail?: string;
  messages: string[];
  progress?: number;
  loadedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  etaSeconds?: number;
}) {
  const displayProgress = useSmoothProgress(active, progress, 94, loadedBytes);
  const status = useRotatingStatus(active, messages);
  if (!active) return null;

  const percent = Math.round(displayProgress);
  const showTransferStats = loadedBytes > 0 || progress !== undefined;

  return (
    <div className="progress-shell overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`progress-orb bg-gradient-to-br ${modeAccent[mode]} text-white shadow-sm`}>
            {mode === 'audio' ? <Radio className="h-4 w-4" /> : mode === 'convert' ? <Zap className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-950">{title}</p>
            {detail ? <p className="text-xs text-zinc-500">{detail}</p> : null}
            <p className="mt-1 text-xs font-medium text-blue-600">{status}</p>
            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">{modeLabel[mode]}</p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-bold tabular-nums leading-none text-zinc-900">{percent}%</p>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-100">
        <div
          className={`progress-glow h-full rounded-full bg-gradient-to-r ${modeAccent[mode]}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {showTransferStats ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
          {loadedBytes > 0 ? (
            <span>
              {formatBytes(loadedBytes)}
              {totalBytes ? ` / ${formatBytes(totalBytes)}` : ''}
            </span>
          ) : null}
          {speedBps ? <span>{formatSpeed(speedBps)}</span> : null}
          {etaSeconds ? <span>ETA {formatEta(etaSeconds)}</span> : null}
        </div>
      ) : null}

      {mode === 'audio' ? (
        <div className="mt-3">
          <WaveformMeter active={active} />
        </div>
      ) : null}
    </div>
  );
}

export function CompletionCard({
  title,
  detail,
  size,
  onOpenFolder,
}: {
  title: string;
  detail?: string;
  size?: number;
  onOpenFolder?: () => void;
}) {
  return (
    <div className="success-pop flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-emerald-950 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-emerald-500 p-1.5 text-white shadow-sm">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-sm text-emerald-700">
            {detail || 'Ready to use.'}
            {size ? ` Final size: ${formatBytes(size)}.` : ''}
          </p>
          <span className="mt-2 inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 shadow-sm">Completed quality</span>
        </div>
      </div>
      {onOpenFolder ? (
        <button
          type="button"
          onClick={onOpenFolder}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
        >
          <FolderOpen className="h-4 w-4" />
          Open Folder
        </button>
      ) : null}
    </div>
  );
}

export function FriendlyError({
  message,
  retrying,
  title,
  onReportIssue,
}: {
  message: string;
  retrying?: boolean;
  title?: string;
  onReportIssue?: () => void;
}) {
  const heading =
    title ||
    (retrying ? 'Retrying extraction...' : 'Could not extract from this source');
  return (
    <div className="fade-in rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{heading}</p>
          <p className="text-sm text-amber-800">{message}</p>
        </div>
      </div>
      {onReportIssue && !retrying ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onReportIssue}
            className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-950"
          >
            Report Issue
          </button>
        </div>
      ) : null}
    </div>
  );
}
