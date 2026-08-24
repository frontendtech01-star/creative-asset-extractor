import { useEffect, useRef, useState } from 'react';
import type { WebsiteExtractPhase, WebsiteExtractCounters } from '../components/WebsiteExtractProgressPanel';
import type { ExtractionProfile } from './extractionProfile';
import { resolveAppOrigin } from './api';

type WsEvent =
  | { type: 'phase'; phase: WebsiteExtractPhase }
  | { type: 'task'; task: string }
  | { type: 'profile'; profile: ExtractionProfile }
  | { type: 'counters'; counters: WebsiteExtractCounters }
  | { type: 'complete'; result: any }
  | { type: 'error'; message: string };

export type ExtractionProgress = {
  extractId: string;
  phase: WebsiteExtractPhase;
  task: string;
  profile: ExtractionProfile | null;
  counters: WebsiteExtractCounters;
  complete: boolean;
  error: string | null;
  connected: boolean;
  result: any;
};

export function useExtractionProgress(active: boolean, extractId = '') {
  const [progress, setProgress] = useState<ExtractionProgress>({
    extractId: '',
    phase: 'loading',
    task: 'Starting extraction...',
    profile: null,
    counters: { images: 0, videos: 0, fonts: 0, colors: 0 },
    complete: false,
    error: null,
    connected: false,
    result: null,
  });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active || !extractId) {
      wsRef.current?.close();
      wsRef.current = null;
      setProgress({
        extractId: '',
        phase: 'loading',
        task: 'Starting extraction...',
        profile: null,
        counters: { images: 0, videos: 0, fonts: 0, colors: 0 },
        complete: false,
        error: null,
        connected: false,
        result: null,
      });
      return;
    }

    const origin = resolveAppOrigin();
    const wsUrl = `${origin.replace(/^http/, 'ws')}/ws/extract?extractId=${encodeURIComponent(extractId)}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closed = false;
    let finished = false;

    setProgress({
      extractId,
      phase: 'loading',
      task: 'Starting extraction...',
      profile: null,
      counters: { images: 0, videos: 0, fonts: 0, colors: 0 },
      complete: false,
      error: null,
      connected: false,
      result: null,
    });

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setProgress((prev) => ({ ...prev, connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const data: WsEvent = JSON.parse(event.data);
          setProgress((prev) => {
            const next = { ...prev };
            switch (data.type) {
              case 'phase':
                next.phase = data.phase;
                break;
              case 'task':
                next.task = data.task;
                break;
              case 'profile':
                next.profile = data.profile;
                break;
              case 'counters':
                next.counters = { ...prev.counters, ...data.counters };
                break;
              case 'complete':
                finished = true;
                next.complete = true;
                next.result = data.result;
                // A client may connect after scanning has finished and receive
                // only the terminal result. Always derive the displayed final
                // counts from that authoritative payload.
                next.counters = {
                  images: Array.isArray(data.result?.images) ? data.result.images.length : 0,
                  videos: Array.isArray(data.result?.videos) ? data.result.videos.length : 0,
                  fonts: Array.isArray(data.result?.fonts) ? data.result.fonts.length : 0,
                  colors: Array.isArray(data.result?.colors) ? data.result.colors.length : 0,
                };
                break;
              case 'error':
                finished = true;
                next.error = data.message;
                next.complete = true;
                break;
            }
            return next;
          });
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setProgress((prev) => ({ ...prev, connected: false }));
        if (!closed && !finished) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, [active, extractId]);

  return progress;
}
