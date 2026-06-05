export type DownloadProgress = {
  loaded: number;
  total?: number;
  percent?: number;
  speedBps: number;
  etaSeconds?: number;
};

export const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const formatSpeed = (bytesPerSecond?: number) =>
  bytesPerSecond && bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : 'warming up';

export const formatEta = (seconds?: number) => {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return 'almost there';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.ceil(seconds / 60)}m`;
};

export const triggerNativeDownload = (href: string, filename?: string) => {
  const anchor = document.createElement('a');
  anchor.href = href;
  if (filename) anchor.download = filename;
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
};

export const saveBlob = (blob: Blob, filename: string) => {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

export const readResponseBlobWithProgress = async (
  response: Response,
  onProgress?: (progress: DownloadProgress) => void
) => {
  const total = Number(response.headers.get('content-length')) || undefined;
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const startedAt = performance.now();

  const estimatePercent = (loaded: number, knownTotal?: number) => {
    if (knownTotal && knownTotal > 0) return Math.min(100, (loaded / knownTotal) * 100);
    // Chunked ZIP streams omit Content-Length — derive a smooth estimate from bytes received.
    return Math.min(99, 12 + (1 - Math.exp(-loaded / 650000)) * 87);
  };

  if (!response.body) {
    const blob = await response.blob();
    onProgress?.({
      loaded: blob.size,
      total: total || blob.size,
      percent: 100,
      speedBps: blob.size / Math.max((performance.now() - startedAt) / 1000, 0.1),
      etaSeconds: 0,
    });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPaint = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    chunks.push(value);
    loaded += value.byteLength;

    const now = performance.now();
    if (now - lastPaint > 80 || (total && loaded >= total)) {
      const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.1);
      const speedBps = loaded / elapsedSeconds;
      const remaining = total ? Math.max(total - loaded, 0) : undefined;
      onProgress?.({
        loaded,
        total,
        percent: estimatePercent(loaded, total),
        speedBps,
        etaSeconds: remaining !== undefined && speedBps > 0 ? remaining / speedBps : undefined,
      });
      lastPaint = now;
    }
  }

  onProgress?.({
    loaded,
    total: total || loaded,
    percent: 100,
    speedBps: loaded / Math.max((performance.now() - startedAt) / 1000, 0.1),
    etaSeconds: 0,
  });

  const blobParts = chunks.map((chunk) =>
    chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
  );
  return new Blob(blobParts, { type: contentType });
};
