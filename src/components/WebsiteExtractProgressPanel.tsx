import React from 'react';
import { Activity, Clock, Loader2, Zap } from 'lucide-react';

export type WebsiteExtractPhase =
  | 'loading'
  | 'dom'
  | 'network'
  | 'scroll'
  | 'fonts-colors'
  | 'finalizing';

export type WebsiteExtractCounters = {
  images: number;
  videos: number;
  fonts: number;
  colors: number;
};

export type WebsiteCrawlMode = 'fast' | 'deep';

const PHASE_ORDER: WebsiteExtractPhase[] = [
  'loading',
  'dom',
  'network',
  'scroll',
  'fonts-colors',
  'finalizing',
];

export const PHASE_MAX_SECONDS: Record<WebsiteExtractPhase, number> = {
  loading: 15,
  dom: 10,
  network: 20,
  scroll: 25,
  'fonts-colors': 10,
  finalizing: 5,
};

const PHASE_LABELS: Record<WebsiteExtractPhase, string> = {
  loading: 'Loading website',
  dom: 'Scanning DOM assets',
  network: 'Capturing network assets',
  scroll: 'Scrolling for lazy-loaded assets',
  'fonts-colors': 'Extracting fonts and colors',
  finalizing: 'Finalizing results',
};

const PHASE_TASKS: Record<WebsiteExtractPhase, string[]> = {
  loading: ['Opening page…', 'Fetching initial HTML…', 'Connecting to origin…'],
  dom: [
    'Reading img and picture elements…',
    'Scanning CSS background images…',
    'Collecting SVG and inline assets…',
    'Parsing link preload hints…',
  ],
  network: [
    'Listening for image responses…',
    'Capturing video and font requests…',
    'Reading loaded stylesheets…',
    'Parsing JSON config payloads…',
  ],
  scroll: [
    'Scrolling for lazy-loaded images…',
    'Expanding infinite-scroll sections…',
    'Triggering deferred media loads…',
    'Waiting for layout to stabilize…',
  ],
  'fonts-colors': [
    'Collecting @font-face rules…',
    'Sampling theme colors…',
    'Merging stylesheet fonts…',
    'Deduplicating asset URLs…',
  ],
  finalizing: [
    'Merging discovered assets…',
    'Preparing results for preview…',
    'Wrapping up browser scan…',
  ],
};

export function formatElapsedClock(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function useRotatingTask(active: boolean, phase: WebsiteExtractPhase) {
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const tasks = PHASE_TASKS[phase];
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % tasks.length);
    }, 2400);
    return () => window.clearInterval(timer);
  }, [active, phase]);
  return PHASE_TASKS[phase][index] || PHASE_TASKS[phase][0];
}

export function WebsiteExtractProgressPanel({
  active,
  phase,
  crawlMode,
  counters,
  partialResults,
  deepScanAvailable,
  onCancel,
  onFinishNow,
  onDeepScan,
}: {
  active: boolean;
  phase: WebsiteExtractPhase;
  crawlMode: WebsiteCrawlMode;
  counters: WebsiteExtractCounters;
  partialResults?: boolean;
  deepScanAvailable?: boolean;
  onCancel: () => void;
  onFinishNow: () => void;
  onDeepScan: () => void;
}) {
  const startedRef = React.useRef(0);
  const phaseStartedRef = React.useRef(0);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [phaseElapsedSeconds, setPhaseElapsedSeconds] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      startedRef.current = 0;
      phaseStartedRef.current = 0;
      setElapsedSeconds(0);
      setPhaseElapsedSeconds(0);
      return;
    }
    if (!startedRef.current) {
      startedRef.current = Date.now();
      phaseStartedRef.current = Date.now();
    }
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedRef.current) / 1000));
      setPhaseElapsedSeconds(Math.floor((Date.now() - phaseStartedRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  React.useEffect(() => {
    if (!active) return;
    phaseStartedRef.current = Date.now();
    setPhaseElapsedSeconds(0);
  }, [active, phase]);

  const currentTask = useRotatingTask(active, phase);
  const phaseIndex = PHASE_ORDER.indexOf(phase);
  const phaseMaxSeconds = PHASE_MAX_SECONDS[phase];
  const totalFound =
    counters.images + counters.videos + counters.fonts + counters.colors;

  if (!active) return null;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 via-cyan-400 to-emerald-400 text-white shadow-sm">
            <Activity className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-950">
              {crawlMode === 'deep' ? 'Deep extraction running…' : 'Fast extraction running…'}
            </p>
            {totalFound > 0 ? (
              <p className="mt-1 text-xs font-medium text-emerald-700">
                Found {counters.images} image{counters.images === 1 ? '' : 's'}
                {counters.fonts > 0 ? `, ${counters.fonts} font${counters.fonts === 1 ? '' : 's'}` : ''}
                {counters.videos > 0 ? `, ${counters.videos} video${counters.videos === 1 ? '' : 's'}` : ''}
                {counters.colors > 0 ? `, ${counters.colors} color${counters.colors === 1 ? '' : 's'}` : ''} so far.
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">Scanning for images, videos, fonts, and colors…</p>
            )}
            <p className="mt-1 text-xs text-zinc-600">You can click Finish Now anytime.</p>
            {partialResults ? (
              <p className="mt-1 text-xs text-emerald-700">
                Assets below update as more are discovered.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {deepScanAvailable && crawlMode === 'fast' ? (
            <button
              type="button"
              onClick={onDeepScan}
              className="inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 transition hover:bg-violet-100"
            >
              <Zap className="h-3.5 w-3.5" />
              Deep Scan
            </button>
          ) : null}
          <button
            type="button"
            onClick={onFinishNow}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50"
          >
            Finish Now
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100"
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Clock className="h-3.5 w-3.5 text-zinc-400" />
          Total time: {formatElapsedClock(elapsedSeconds)}
        </span>
        <span className="font-medium text-blue-700">
          Task time: {formatElapsedClock(phaseElapsedSeconds)} / {formatElapsedClock(phaseMaxSeconds)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Images found', value: counters.images },
          { label: 'Videos found', value: counters.videos },
          { label: 'Fonts found', value: counters.fonts },
          { label: 'Colors found', value: counters.colors },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{item.label}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-zinc-900">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">Current task</p>
        <p className="mt-1 flex items-center gap-2 text-sm font-medium text-blue-950">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
          {currentTask}
        </p>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Extraction phases</p>
        <ol className="space-y-1.5">
          {PHASE_ORDER.map((step, index) => {
            const done = index < phaseIndex;
            const current = index === phaseIndex;
            const stepMax = PHASE_MAX_SECONDS[step];
            return (
              <li
                key={step}
                className={`flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${
                  current
                    ? 'bg-blue-50 font-semibold text-blue-800'
                    : done
                      ? 'text-emerald-700'
                      : 'text-zinc-400'
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    current
                      ? 'bg-blue-600 text-white'
                      : done
                        ? 'bg-emerald-500 text-white'
                        : 'bg-zinc-200 text-zinc-500'
                  }`}
                >
                  {done ? '✓' : index + 1}
                </span>
                <span>{PHASE_LABELS[step]}</span>
                {current ? (
                  <span className="ml-auto tabular-nums text-[11px] text-blue-600">
                    {formatElapsedClock(phaseElapsedSeconds)} / {formatElapsedClock(stepMax)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
