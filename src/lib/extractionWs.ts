import { useEffect, useRef, useState } from 'react';
import type { WebsiteExtractPhase, WebsiteExtractCounters } from '../components/WebsiteExtractProgressPanel';
import { resolveAppOrigin } from './api';

type WsEvent =
  | { type: 'phase'; phase: WebsiteExtractPhase }
  | { type: 'task'; task: string }
  | { type: 'counters'; counters: WebsiteExtractCounters }
  | { type: 'complete'; result: any }
  | { type: 'error'; message: string };

export type ExtractionProgress = {
  phase: WebsiteExtractPhase;
  task: string;
  counters: WebsiteExtractCounters;
  complete: boolean;
  error: string | null;
  connected: boolean;
  result: any;
};

export function useExtractionProgress(active: boolean) {
  const [progress, setProgress] = useState<ExtractionProgress>({
    phase: 'loading',
    task: 'Starting extraction...',
    counters: { images: 0, videos: 0, fonts: 0, colors: 0 },
    complete: false,
    error: null,
    connected: false,
    result: null,
  });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active) {
      wsRef.current?.close();
      wsRef.current = null;
      setProgress({
        phase: 'loading',
        task: 'Starting extraction...',
        counters: { images: 0, videos: 0, fonts: 0, colors: 0 },
        complete: false,
        error: null,
        connected: false,
        result: null,
      });
      return;
    }

    const origin = resolveAppOrigin();
    const wsUrl = `${origin.replace(/^http/, 'ws')}/ws/extract`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let closed = false;

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
              case 'counters':
                next.counters = { ...prev.counters, ...data.counters };
                break;
              case 'complete':
                next.complete = true;
                next.result = data.result;
                break;
              case 'error':
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
        if (!closed) {
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
  }, [active]);

  return progress;
}
