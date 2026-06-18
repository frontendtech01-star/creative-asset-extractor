import { apiFetch } from './api';

export type DownloaderQuality = 'fhd' | 'hd' | 'audio';
export type DownloaderJobStatus = 'queued' | 'running' | 'completed' | 'error';

export type DownloaderVideo = {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  provider: string;
  platform: string;
  maxHeight?: number;
  defaultQualityKey: 'fhd' | 'hd';
  displayQualityLabel: 'FHD' | 'HD';
  qualityVariants: {
    fhd: { formatAvailable: boolean };
    hd: { formatAvailable: boolean };
  };
  streams: {
    FHD: { ready: boolean };
    HD: { ready: boolean };
  };
  audioAvailable: boolean;
  noAudio: boolean;
  fallbackMessage?: string;
};

export type DownloaderResult = {
  ok: true;
  filePath: string;
  displayPath: string;
  relativePath: string;
  filename: string;
  size: number;
  quality: DownloaderQuality;
  platform: string;
  title?: string;
  thumbnail?: string;
  zipPath?: string;
  zipDisplayPath?: string;
  zipRelativePath?: string;
};

export type DownloaderJob = {
  id: string;
  url: string;
  title?: string;
  platform: string;
  quality: DownloaderQuality;
  status: DownloaderJobStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes?: number;
  speed?: string;
  eta?: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  result?: DownloaderResult;
  error?: string;
};

export type DownloaderFile = {
  name: string;
  title?: string;
  thumbnail?: string;
  platform: string;
  status?: string;
  size: number;
  modifiedAt: number;
  path: string;
  displayPath: string;
  relativePath: string;
  quality: string;
  zipPath?: string;
  zipDisplayPath?: string;
  zipRelativePath?: string;
};

const readJson = async (response: Response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || 'Unexpected downloader response.' };
  }
};

export const inspectDownloaderUrl = async (url: string) => {
  const response = await apiFetch('/api/downloader/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Video extraction failed.');
  return data as { ok: true; platform: string; videos: DownloaderVideo[]; count: number };
};

export const startDownloaderJob = async (input: {
  url: string;
  quality: DownloaderQuality;
  title?: string;
}) => {
  const response = await apiFetch('/api/downloader/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not start download.');
  return data.job as DownloaderJob;
};

export const startBulkDownloaderJobs = async (urls: string[]) => {
  const response = await apiFetch('/api/downloader/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not start bulk download.');
  return data as { ok: boolean; jobs: DownloaderJob[]; errors: Array<{ url: string; error: string }> };
};

export const readDownloaderJob = async (id: string) => {
  const response = await apiFetch(`/api/downloader/jobs/${encodeURIComponent(id)}`);
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Download job was not found.');
  return data.job as DownloaderJob;
};

export const listDownloaderJobs = async () => {
  const response = await apiFetch('/api/downloader/jobs');
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not load downloader jobs.');
  return (Array.isArray(data?.items) ? data.items : []) as DownloaderJob[];
};

export const waitForDownloaderJob = async (
  initial: DownloaderJob,
  onProgress?: (job: DownloaderJob) => void
) => {
  let job = initial;
  onProgress?.(job);
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    job = await readDownloaderJob(job.id);
    onProgress?.(job);
  }
  return job;
};

export const listDownloaderFiles = async () => {
  const response = await apiFetch('/api/downloader/downloads');
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not load downloads.');
  return (Array.isArray(data?.items) ? data.items : []) as DownloaderFile[];
};

export const clearDownloaderFiles = async (deleteFiles = false) => {
  const response = await apiFetch('/api/downloader/downloads', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteFiles }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not clear downloads.');
  return data as { ok: true; removed: number; mode?: 'history' | 'files' };
};

export const downloaderFileUrl = (file: DownloaderFile | DownloaderResult) =>
  `/api/downloader/file?path=${encodeURIComponent(file.relativePath)}`;

export const openDownloaderFile = async (file: DownloaderFile | DownloaderResult) => {
  const response = await apiFetch('/api/downloader/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file.relativePath }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not open file.');
  return data as { ok: true };
};

export const revealDownloaderFile = async (file: DownloaderFile | DownloaderResult) => {
  const response = await apiFetch('/api/downloader/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file.relativePath }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error || 'Could not open folder.');
  return data as { ok: true };
};
