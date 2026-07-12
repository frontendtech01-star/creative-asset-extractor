import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export type ExtractPhase =
  | 'loading'
  | 'dom'
  | 'network'
  | 'scroll'
  | 'fonts-colors'
  | 'finalizing';

export type ExtractCounters = {
  images: number;
  videos: number;
  fonts: number;
  colors: number;
};

type ProgressEvent =
  | { type: 'phase'; phase: ExtractPhase }
  | { type: 'task'; task: string }
  | { type: 'counters'; counters: ExtractCounters }
  | { type: 'complete'; result: any }
  | { type: 'error'; message: string };

export class ExtractionProgressManager {
  private clients = new Set<WebSocket>();
  private currentPhase: ExtractPhase = 'loading';
  private currentCounters: ExtractCounters = { images: 0, videos: 0, fonts: 0, colors: 0 };
  private terminalEvent: Extract<ProgressEvent, { type: 'complete' | 'error' }> | null = null;

  addClient(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    if (ws.readyState === WebSocket.OPEN) {
      if (this.terminalEvent) {
        ws.send(JSON.stringify({ type: 'counters', counters: this.currentCounters }));
        ws.send(JSON.stringify(this.terminalEvent));
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: 'phase', phase: this.currentPhase }));
      ws.send(JSON.stringify({ type: 'counters', counters: this.currentCounters }));
    }
  }

  private broadcast(event: ProgressEvent) {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  setPhase(phase: ExtractPhase) {
    this.currentPhase = phase;
    this.broadcast({ type: 'phase', phase });
  }

  setTask(task: string) {
    this.broadcast({ type: 'task', task });
  }

  updateCounters(counters: Partial<ExtractCounters>) {
    this.currentCounters = { ...this.currentCounters, ...counters };
    this.broadcast({ type: 'counters', counters: this.currentCounters });
  }

  complete(result: any) {
    // The finalized payload is the source of truth. Live discovery counters can
    // be stale (or still zero for clients that connect during finalization), so
    // publish the exact post-dedupe counts immediately before completion.
    this.updateCounters({
      images: Array.isArray(result?.images) ? result.images.length : 0,
      videos: Array.isArray(result?.videos) ? result.videos.length : 0,
      fonts: Array.isArray(result?.fonts) ? result.fonts.length : 0,
      colors: Array.isArray(result?.colors) ? result.colors.length : 0,
    });
    this.terminalEvent = { type: 'complete', result };
    this.broadcast(this.terminalEvent);
    this.cleanup();
  }

  fail(error: string) {
    this.terminalEvent = { type: 'error', message: error };
    this.broadcast(this.terminalEvent);
    this.cleanup();
  }

  private cleanup() {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }

  static managerByExtractId = new Map<string, ExtractionProgressManager>();
  static globalManager: ExtractionProgressManager | null = null;

  static create(extractId: string): ExtractionProgressManager {
    const manager = new ExtractionProgressManager();
    ExtractionProgressManager.managerByExtractId.set(extractId, manager);
    return manager;
  }

  static get(extractId: string): ExtractionProgressManager | undefined {
    return ExtractionProgressManager.managerByExtractId.get(extractId);
  }

  static remove(extractId: string) {
    ExtractionProgressManager.managerByExtractId.delete(extractId);
  }
}

export function setupExtractProgressWS(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/extract' });

  wss.on('connection', (ws, req) => {
    const reqUrl = new URL(req.url || '', 'http://localhost');
    const extractId = reqUrl.searchParams.get('extractId');

    if (extractId) {
      const manager = ExtractionProgressManager.get(extractId);
      if (manager) {
        manager.addClient(ws);
        return;
      }
    }

    // Fallback: subscribe to the global activeExtractProgress (imported from server.ts)
    // Since ws module can't import from the main server module directly,
    // store a reference on the static class
    const globalMgr = ExtractionProgressManager.globalManager;
    if (globalMgr) {
      globalMgr.addClient(ws);
      return;
    }

    ws.close(4000, 'No active extraction for this ID');
  });

  return wss;
}

export let globalProgressManager: ExtractionProgressManager | null = null;

export function setGlobalProgressManager(mgr: ExtractionProgressManager | null) {
  globalProgressManager = mgr;
  ExtractionProgressManager.globalManager = mgr;
}
