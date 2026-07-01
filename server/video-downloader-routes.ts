import type { Express } from 'express';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import archiver from 'archiver';
import { resolveCreativeAssetsDir, resolvePlatformVideoAssetsDir } from '../src/lib/projectDownloadsPaths';

const execFileAsync = promisify(execFile);

const writeLog = async (jobId: string | undefined, data: Record<string, unknown>) => {
  try {
    // Diagnostic logs are temporary implementation details. Keep them out of
    // Downloads so a video request creates only its detected platform folder.
    const logsDir = path.join(os.tmpdir(), 'creative-asset-extractor', 'video-downloader-logs');
    await fsp.mkdir(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `${jobId || 'unknown'}-${Date.now()}.log`);
    const entry = {
      ...data,
      timestamp: new Date().toISOString(),
    };
    await fsp.writeFile(logFile, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  } catch {
    // best effort
  }
};

type DownloaderPlatform = 'youtube' | 'vimeo' | 'instagram' | 'facebook' | 'x' | 'tiktok' | 'ispot' | 'brightcove' | 'direct' | 'unknown';
type DownloadQuality = '4k' | 'fhd' | 'hd' | 'audio';
type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'cancelled';

type DownloaderCard = {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  provider: DownloaderPlatform;
  platform: DownloaderPlatform;
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

type DownloadResult = {
  ok: true;
  filePath: string;
  displayPath: string;
  relativePath: string;
  filename: string;
  size: number;
  quality: DownloadQuality;
  platform: DownloaderPlatform;
  title?: string;
  thumbnail?: string;
  duration?: number;
  zipPath?: string;
  zipDisplayPath?: string;
  zipRelativePath?: string;
};

type DownloadJob = {
  id: string;
  url: string;
  title?: string;
  platform: DownloaderPlatform;
  quality: DownloadQuality;
  sourcePageUrl?: string;
  saveToWebsiteAssets?: boolean;
  startTime?: string;
  endTime?: string;
  status: JobStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes?: number;
  speed?: string;
  eta?: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  result?: DownloadResult;
  error?: string;
};

type SpecialInspect = (url: string) => Promise<any>;
type SpecialDownload = (input: {
  url: string;
  quality: DownloadQuality;
  title?: string;
  sourcePageUrl?: string;
  saveToWebsiteAssets?: boolean;
}) => Promise<any>;

export type VideoDownloaderRouteOptions = {
  appRoot: string;
  resourcesPath: string;
  validateUrl?: (url: string) => unknown;
  specialInspect?: SpecialInspect;
  specialDownload?: SpecialDownload;
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SUPPORTED_PLATFORMS = ['youtube', 'vimeo', 'instagram', 'facebook', 'x', 'tiktok', 'ispot', 'brightcove', 'direct'] as const;
const jobs = new Map<string, DownloadJob>();
const pendingJobs: string[] = [];
const cancelledJobs = new Set<string>();
const activeDownloadProcesses = new Map<string, ReturnType<typeof spawn>>();
const inspectCache = new Map<string, { expiresAt: number; payload: any }>();
let activeJobs = 0;
let updatePromise: Promise<boolean> | null = null;
let lastUpdateAttemptAt = 0;

const now = () => Date.now();
const INSPECT_CACHE_TTL_MS = 10 * 60 * 1000;
const binaryName = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

const sanitizeFilenamePart = (value: string, fallback = 'video') =>
  String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 140) || fallback;

const normalizeTrimTime = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d+(?:\.\d+)?$/.test(raw)) return raw;
  const parts = raw.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d{1,2}(?:\.\d+)?$/.test(part))) return '';
  const normalized = parts.map((part, index) => {
    if (index === parts.length - 1 && part.includes('.')) return part.padStart(2, '0');
    return String(Number(part)).padStart(2, '0');
  });
  return normalized.join(':');
};

const trimSeconds = (value = '') => {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
};

const normalizeTrimRange = (startInput: unknown, endInput: unknown) => {
  const startTime = normalizeTrimTime(startInput);
  const endTime = normalizeTrimTime(endInput);
  const startSeconds = trimSeconds(startTime);
  const endSeconds = trimSeconds(endTime);
  if (startTime && startSeconds !== null && startSeconds < 0) return { startTime: '', endTime: '' };
  if (endTime && endSeconds !== null && endSeconds <= 0) return { startTime: '', endTime: '' };
  if (startSeconds !== null && endSeconds !== null && endSeconds <= startSeconds) return { startTime: '', endTime: '' };
  return { startTime, endTime };
};

const trimSectionArgs = (job: Pick<DownloadJob, 'startTime' | 'endTime'>) => {
  const start = normalizeTrimTime(job.startTime);
  const end = normalizeTrimTime(job.endTime);
  if (!start && !end) return [];
  return ['--download-sections', `*${start || '0'}-${end || 'inf'}`];
};

const toDisplayPath = (filePath: string) => {
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
};

const isPathInside = (candidate: string, root: string) => {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

export const detectDownloaderPlatform = (rawUrl: string): DownloaderPlatform => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('vimeo.com') || host.includes('vimeocdn.com')) return 'vimeo';
    if (host.includes('instagram.com') || host.includes('cdninstagram.com')) return 'instagram';
    if (host.includes('facebook.com') || host === 'fb.watch' || host.includes('fbcdn.net')) return 'facebook';
    if (host === 'x.com' || host.includes('twitter.com') || host.includes('twimg.com')) return 'x';
    if (host.includes('tiktok.com') || host.includes('tiktokcdn.com')) return 'tiktok';
    if (host === 'ispot.tv' || host.endsWith('.ispot.tv')) return 'ispot';
    if (host === 'players.brightcove.net' || host.endsWith('.players.brightcove.net') || host.includes('brightcove.net')) return 'brightcove';
    if (/\.(?:mp4|m3u8|mpd|webm|mov)(?:$|\?)/i.test(parsed.href)) return 'direct';
    return 'unknown';
  } catch {
    return 'unknown';
  }
};

const normalizeDownloaderUrl = (rawUrl: string, platform = detectDownloaderPlatform(rawUrl)) => {
  const parsed = new URL(rawUrl.trim());
  parsed.hash = '';
  if (platform === 'x') {
    const match = parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/i);
    if (match) return `https://twitter.com/${match[1]}/status/${match[2]}`;
  }
  if (platform === 'instagram') {
    const match = parsed.pathname.match(/^\/(reel|reels|p|tv)\/([^/]+)/i);
    if (match) return `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/`;
  }
  if (platform === 'facebook' && parsed.hostname === 'fb.watch') return parsed.href;
  if (platform === 'facebook' && parsed.searchParams.get('v')) {
    return `https://www.facebook.com/watch/?v=${parsed.searchParams.get('v')}`;
  }
  if (!['direct', 'youtube', 'facebook', 'brightcove'].includes(platform)) parsed.search = '';
  return parsed.href;
};

const validateDownloaderUrl = (rawUrl: string, validateUrl?: (url: string) => unknown) => {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Paste a valid public video URL.');
  if (/^(?:localhost|127\.|0\.0\.0\.0|::1$)/i.test(parsed.hostname)) {
    throw new Error('Local URLs are not supported in Video Downloader.');
  }
  validateUrl?.(parsed.href);
  const platform = detectDownloaderPlatform(parsed.href);
  if (platform === 'unknown') {
    throw new Error('Supported platforms: YouTube, Vimeo, Instagram, Facebook, X.com, TikTok, Brightcove, and iSpot.tv.');
  }
  return { url: normalizeDownloaderUrl(parsed.href, platform), platform };
};

const resolveTool = (options: VideoDownloaderRouteOptions, name: string) => {
  const fileName = binaryName(name);
  const candidates = [
    path.join(options.resourcesPath || '', 'bin', fileName),
    path.join(options.appRoot || '', 'vendor', 'bin-pack', fileName),
    path.join(options.resourcesPath || '', 'vendor', 'bin-pack', fileName),
    path.join(process.cwd(), 'vendor', 'bin-pack', fileName),
    path.join(os.homedir(), '.creative-asset-extractor', 'runtime-bin', fileName),
    path.join(process.cwd(), 'runtime-bin', fileName),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
};

const ensureRuntimeYtDlp = async (options: VideoDownloaderRouteOptions) => {
  const toolPath = resolveTool(options, 'yt-dlp');
  if (!toolPath) throw new Error('Video extractor is missing. Reinstall the app.');
  await fsp.chmod(toolPath, 0o755).catch(() => undefined);
  return toolPath;
};

const platformHeaders = (platform: DownloaderPlatform) => {
  if (platform === 'instagram') return ['--referer', 'https://www.instagram.com/', '--add-header', 'Origin:https://www.instagram.com'];
  if (platform === 'facebook') return ['--referer', 'https://www.facebook.com/', '--add-header', 'Origin:https://www.facebook.com'];
  if (platform === 'x') return ['--referer', 'https://twitter.com/', '--add-header', 'Origin:https://twitter.com'];
  if (platform === 'tiktok') return ['--referer', 'https://www.tiktok.com/', '--add-header', 'Origin:https://www.tiktok.com'];
  if (platform === 'vimeo') return ['--referer', 'https://vimeo.com/'];
  return [];
};

const commonYtDlpArgs = (options: VideoDownloaderRouteOptions, platform: DownloaderPlatform) => {
  const ffmpegPath = resolveTool(options, 'ffmpeg');
  return [
    '--no-warnings',
    '--no-check-certificates',
    '--no-playlist',
    '--force-ipv4',
    '--socket-timeout',
    '25',
    '--retries',
    '3',
    '--extractor-retries',
    '3',
    '--user-agent',
    USER_AGENT,
    ...(ffmpegPath ? ['--ffmpeg-location', path.dirname(ffmpegPath)] : []),
    ...platformHeaders(platform),
  ];
};

const aria2cAvailable = (options: VideoDownloaderRouteOptions) => {
  const aria2Path = resolveTool(options, 'aria2c');
  return aria2Path ? aria2Path : '';
};

const ytDlpDownloadAccelerationArgs = (options: VideoDownloaderRouteOptions, quality: DownloadQuality) => {
  if (quality === 'audio') return [];
  const aria2 = aria2cAvailable(options);
  const args: string[] = [];
  if (aria2) {
    args.push('--downloader', 'aria2c');
    args.push('--downloader-args', 'aria2c:-x 32 -s 32 -k 2M');
  }
  args.push('--concurrent-fragments', '32');
  args.push('--buffer-size', '128K');
  return args;
};

const toolPathEnv = (options: VideoDownloaderRouteOptions) => {
  const dirs = ['ffmpeg', 'ffprobe', 'yt-dlp', 'aria2c', 'deno']
    .map((tool) => resolveTool(options, tool))
    .filter(Boolean)
    .map((toolPath) => path.dirname(toolPath));
  const commonToolDirs =
    process.platform === 'win32'
      ? []
      : ['/opt/homebrew/bin', '/usr/local/bin'];
  return Array.from(new Set([...dirs, ...commonToolDirs])).join(path.delimiter);
};

const cookieAttempts = (platform: DownloaderPlatform) => {
  const attempts: string[][] = [];
  const cookiesFile = String(process.env.VDX_YTDLP_COOKIES_FILE || '').trim();
  if (cookiesFile && fs.existsSync(cookiesFile)) attempts.push(['--cookies', cookiesFile]);
  if (platform === 'instagram' || platform === 'facebook' || platform === 'x' || platform === 'tiktok') {
    attempts.push(['--cookies-from-browser', 'chrome']);
    if (process.platform === 'darwin') attempts.push(['--cookies-from-browser', 'safari']);
    attempts.push(['--cookies-from-browser', 'firefox']);
  }
  return attempts;
};

const errorText = (error: any) =>
  [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n').trim();

const parseYtDlpProgressLine = (line: string) => {
  if (line.startsWith('__VDX_PROGRESS__|')) {
    const [, percentText, downloadedText, totalText, speed, eta] = line.split('|');
    return {
      percent: Number(String(percentText || '').replace('%', '').trim()),
      downloadedBytes: Number(downloadedText || 0) || undefined,
      totalBytes: Number(totalText || 0) || undefined,
      speed: String(speed || '').trim() || undefined,
      eta: String(eta || '').trim() || undefined,
    };
  }
  const percentMatch =
    line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i) ||
    line.match(/\((\d+(?:\.\d+)?)%\)/);
  if (!percentMatch?.[1]) return null;
  const speedMatch = line.match(/\b(?:at|DL:)\s*([0-9.]+\s*[KMGT]?i?B\/s)/i);
  const etaMatch = line.match(/\bETA\s*([0-9:]+|[0-9]+s)/i);
  return {
    percent: Number(percentMatch[1]),
    speed: speedMatch?.[1]?.trim(),
    eta: etaMatch?.[1]?.trim(),
  };
};

const isXGuestTokenError = (message: string) =>
  /bad guest token|guest token|twitter.*querying api|x\.com.*extract/i.test(message);

const isAuthLikeError = (message: string) =>
  /login|cookie|private|sign in|authentication|not available|rate.?limit|guest token|requested content is not available/i.test(message);

const isYouTubeUnavailableError = (message: string) =>
  /(?:\[youtube\].*)?(?:this video is not available|video unavailable|private video|members-only|sign in to confirm|not available in your country|copyright|removed by the uploader)/i.test(
    message
  );

const friendlyDownloaderError = (platform: DownloaderPlatform, message: string) => {
  if (
    /X\.com extraction needs updated engine|Instagram could not refresh|Facebook could not access|No downloadable video stream|Video extraction failed/i.test(
      message
    )
  ) {
    return message;
  }
  if (platform === 'x' && isXGuestTokenError(message)) {
    return 'X.com extraction needs updated engine. Updating extractor or trying fallback route...';
  }
  if (platform === 'instagram' && isAuthLikeError(message)) {
    return 'Instagram could not refresh this public post or reel. The post may require a signed-in browser session.';
  }
  if (platform === 'facebook' && isAuthLikeError(message)) {
    return 'Facebook could not access this public video. Confirm the video is public, then retry.';
  }
  if (platform === 'youtube' && isYouTubeUnavailableError(message)) {
    return 'YouTube says this video is unavailable from this connection. It may be private, removed, region-blocked, age-restricted, or temporarily blocked. Use the YT5S backup button below, or try again with a different network/VPN.';
  }
  if (/unsupported url/i.test(message)) return 'This link is not supported by the current video extractor.';
  if (/no video formats|no formats|no downloadable/i.test(message)) return 'No downloadable video stream was found for this link.';
  if (/ffmpeg.*not found|ffprobe.*not found|--ffmpeg-location/i.test(message)) return 'Video processing tools are not available. Reinstall the app.';
  if (/permission denied|operation not permitted|errno 1/i.test(message)) return 'Video tools permission error. Try reinstalling the DMG.';
  if (/no such file|ENOENT|spawn/i.test(message)) return 'Video engine failed to launch. Missing binary in app bundle.';
  // Return the first line of the real error for debugging
  const short = message.split('\n')[0].slice(0, 150);
  if (short.length > 10) return short;
  return 'Video download failed. Please try again or report the issue from the app.';
};

const updateYtDlp = async (options: VideoDownloaderRouteOptions) => {
  if (updatePromise) return updatePromise;
  if (now() - lastUpdateAttemptAt < 10 * 60 * 1000) return false;
  lastUpdateAttemptAt = now();
  updatePromise = (async () => {
    try {
      const ytdlp = await ensureRuntimeYtDlp(options);
      await execFileAsync(ytdlp, ['--update-to', 'stable'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      return true;
    } catch (error) {
      console.warn('[video-downloader] yt-dlp update skipped:', errorText(error).slice(0, 400));
      return false;
    } finally {
      updatePromise = null;
    }
  })();
  return updatePromise;
};

const runYtDlpJson = async (
  options: VideoDownloaderRouteOptions,
  url: string,
  platform: DownloaderPlatform,
  extraArgs: string[] = []
) => {
  const ytdlp = await ensureRuntimeYtDlp(options);
  const args = [
    ...commonYtDlpArgs(options, platform),
    '--dump-single-json',
    '--skip-download',
    ...extraArgs,
    url,
  ];
  const { stdout } = await execFileAsync(ytdlp, args, {
    timeout: platform === 'vimeo' ? 130000 : 75000,
    maxBuffer: 80 * 1024 * 1024,
  });
  return JSON.parse(String(stdout || '').trim());
};

const extractViaVxTwitter = async (url: string) => {
  const parsed = new URL(url);
  const response = await fetch(`https://vxtwitter.com${parsed.pathname}`, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!response.ok) throw new Error(`X fallback returned ${response.status}`);
  const html = await response.text();
  const pick = (...patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1].replace(/&amp;/g, '&');
    }
    return '';
  };
  const videoUrl = pick(
    /<meta\s+property=["']og:video(?::url)?["']\s+content=["']([^"']+)/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:video(?::url)?["']/i
  );
  if (!videoUrl) throw new Error('X fallback did not expose a public video.');
  return {
    id: parsed.pathname.match(/\/status\/(\d+)/)?.[1] || crypto.randomUUID(),
    title: pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || 'X video',
    thumbnail: pick(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i),
    webpage_url: url,
    url: videoUrl,
    ext: 'mp4',
    formats: [{ url: videoUrl, ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 720 }],
  };
};

const inspectWithFallbacks = async (
  options: VideoDownloaderRouteOptions,
  rawUrl: string,
  platform: DownloaderPlatform
) => {
  const url = normalizeDownloaderUrl(rawUrl, platform);
  let lastError: any;
  const urls = platform === 'x'
    ? Array.from(new Set([url, url.replace('twitter.com', 'x.com')]))
    : [url];

  for (const candidate of urls) {
    try {
      return await runYtDlpJson(options, candidate, platform);
    } catch (error) {
      lastError = error;
    }
  }

  const firstMessage = errorText(lastError);
  if (platform === 'x' && isXGuestTokenError(firstMessage)) {
    await updateYtDlp(options);
    for (const candidate of urls) {
      try {
        return await runYtDlpJson(options, candidate, platform);
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (isAuthLikeError(errorText(lastError))) {
    for (const cookies of cookieAttempts(platform)) {
      for (const candidate of urls) {
        try {
          return await runYtDlpJson(options, candidate, platform, cookies);
        } catch (error) {
          lastError = error;
        }
      }
    }
  }

  if (platform === 'x') {
    try {
      return await extractViaVxTwitter(url);
    } catch (error) {
      lastError = error;
    }
  }

  void writeLog(undefined, {
    event: 'inspect_failed',
    platform,
    url: rawUrl,
    last_error: errorText(lastError),
  });
  throw new Error(friendlyDownloaderError(platform, errorText(lastError)));
};

const bestThumbnail = (info: any) => {
  const thumbnails = Array.isArray(info?.thumbnails) ? info.thumbnails : [];
  return String(
    thumbnails
      .filter((item: any) => item?.url)
      .sort((a: any, b: any) => Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0]?.url ||
      info?.thumbnail ||
      ''
  );
};

const infoToCards = (info: any, sourceUrl: string, platform: DownloaderPlatform): DownloaderCard[] => {
  const rawEntries = Array.isArray(info?.entries) && info.entries.length > 0 ? info.entries : [info];
  const seen = new Set<string>();
  const cards: DownloaderCard[] = [];
  for (const entry of rawEntries.filter(Boolean)) {
    const formats = Array.isArray(entry?.formats) ? entry.formats : [];
    const videoFormats = formats.filter((format: any) => String(format?.vcodec || '') !== 'none');
    const audioFormats = formats.filter((format: any) => String(format?.acodec || '') !== 'none');
    const maxHeight = Math.max(
      Number(entry?.height || 0),
      ...videoFormats.map((format: any) => Number(format?.height || 0))
    );
    const id = String(entry?.id || entry?.display_id || entry?.webpage_url || sourceUrl);
    const cardUrl = String(entry?.webpage_url || entry?.original_url || sourceUrl);
    const key = `${platform}:${id}:${cardUrl.replace(/[?#].*$/, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hasVideo = videoFormats.length > 0 || Boolean(entry?.url);
    const fhdAvailable = hasVideo;
    const hdAvailable = hasVideo;
    const audioAvailable = audioFormats.length > 0 || String(entry?.acodec || '') !== 'none';
    cards.push({
      id,
      url: cardUrl,
      title: String(entry?.title || entry?.fulltitle || `${platform} video`).trim(),
      thumbnail: bestThumbnail(entry),
      duration: Number(entry?.duration || 0) || undefined,
      provider: platform,
      platform,
      maxHeight: maxHeight || undefined,
      defaultQualityKey: fhdAvailable ? 'fhd' : 'hd',
      displayQualityLabel: fhdAvailable ? 'FHD' : 'HD',
      qualityVariants: {
        fhd: { formatAvailable: fhdAvailable },
        hd: { formatAvailable: hdAvailable },
      },
      streams: {
        FHD: { ready: fhdAvailable },
        HD: { ready: hdAvailable },
      },
      audioAvailable,
      noAudio: !audioAvailable,
      fallbackMessage:
        maxHeight > 0 && maxHeight < 1000
          ? `Best available quality is ${maxHeight}p. The FHD download will use the best available MP4.`
          : undefined,
    });
  }
  return cards;
};

const specialPayloadToCards = (payload: any, sourceUrl: string, platform: DownloaderPlatform) => {
  const videos = Array.isArray(payload?.videos) ? payload.videos : [];
  const seen = new Set<string>();
  return videos
    .map((video: any, index: number) => {
      const id = String(video?.id || video?.formatId || video?.url || index);
      const key = `${platform}:${id}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const hasVideo = Boolean(
        video?.qualityVariants?.fhd?.formatAvailable ??
          video?.qualityVariants?.hd?.formatAvailable ??
          video?.streams?.FHD?.ready ??
          video?.streams?.HD?.ready ??
          video?.url
      );
      const maxHeight = Number(video?.height || video?.maxHeight || 0) || 0;
      const fhdAvailable = hasVideo;
      const hdAvailable = hasVideo && Boolean(video?.qualityVariants?.hd?.formatAvailable ?? video?.streams?.HD?.ready ?? true);
      const audioAvailable = video?.audioAvailable !== false && video?.noAudio !== true;
      return {
        id,
        url: sourceUrl,
        title: String(video?.title || `${platform} video`),
        thumbnail: String(video?.thumbnail || ''),
        duration: Number(video?.duration || video?.durationSeconds || 0) || undefined,
        provider: platform,
        platform,
        maxHeight: maxHeight || undefined,
        defaultQualityKey: fhdAvailable ? 'fhd' : 'hd',
        displayQualityLabel: fhdAvailable ? 'FHD' : 'HD',
        qualityVariants: {
          fhd: { formatAvailable: fhdAvailable },
          hd: { formatAvailable: hdAvailable },
        },
        streams: {
          FHD: { ready: fhdAvailable },
          HD: { ready: hdAvailable },
        },
        audioAvailable,
        noAudio: !audioAvailable,
        fallbackMessage:
          video?.fallbackMessage ||
          (maxHeight > 0 && maxHeight < 1000
            ? `Best available quality is ${maxHeight}p. The FHD download will use the best available MP4.`
            : undefined),
      } satisfies DownloaderCard;
    })
    .filter(Boolean) as DownloaderCard[];
};

const updateJob = (job: DownloadJob, patch: Partial<DownloadJob>) => {
  Object.assign(job, patch, { updatedAt: now() });
};

const isJobCancelled = (job: DownloadJob) => cancelledJobs.has(job.id) || job.status === 'cancelled';

const throwIfJobCancelled = (job: DownloadJob) => {
  if (isJobCancelled(job)) throw new Error('Download cancelled by user.');
};

const formatSelector = (platform: DownloaderPlatform, quality: DownloadQuality, fallback = false) => {
  if (quality === 'audio') return 'bestaudio/best';
  const height = quality === '4k' ? 2160 : quality === 'fhd' ? 1080 : 720;
  if (platform === 'youtube') {
    if (!fallback) {
      if (quality === '4k') {
        return [
          `bestvideo[height<=${height}][vcodec^=vp9]+bestaudio[ext=m4a]`,
          `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
          `bestvideo[height<=${height}]+bestaudio`,
          `best[height<=${height}][ext=mp4][vcodec!=none][acodec!=none]`,
          `best[height<=${height}][vcodec!=none][acodec!=none]`,
          'best',
        ].join('/');
      }
      return [
        `bestvideo[height<=${height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio`,
        `best[height<=${height}][ext=mp4][vcodec!=none][acodec!=none]`,
        `best[height<=${height}][vcodec!=none][acodec!=none]`,
        `bestvideo[height<=${height}]+bestaudio`,
        'best',
      ].join('/');
    }
    return `best[height<=${height}]/bestvideo[height<=${height}]+bestaudio/best`;
  }
  if (platform === 'vimeo' || platform === 'brightcove') {
    return `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`;
  }
  if (platform === 'instagram' || platform === 'facebook' || platform === 'x' || platform === 'tiktok') {
    return 'best[ext=mp4]/best';
  }
  return `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`;
};

const runToolJson = async (toolPath: string, args: string[]) => {
  const { stdout } = await execFileAsync(toolPath, args, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(String(stdout || '{}'));
};

const probeMedia = async (options: VideoDownloaderRouteOptions, filePath: string) => {
  const ffprobePath = resolveTool(options, 'ffprobe');
  if (!ffprobePath) throw new Error('ffprobe is missing. Run npm install, then restart the app.');
  return runToolJson(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
};

const isQuickTimeCompatible = (probe: any) => {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream: any) => stream?.codec_type === 'video');
  const audio = streams.find((stream: any) => stream?.codec_type === 'audio');
  const formatNames = String(probe?.format?.format_name || '').toLowerCase().split(',');
  const videoCodec = String(video?.codec_name || video?.codec_tag_string || '').toLowerCase();
  const audioCodec = String(audio?.codec_name || audio?.codec_tag_string || '').toLowerCase();
  const pixFmt = String(video?.pix_fmt || '').toLowerCase();
  return (
    formatNames.includes('mp4') &&
    (videoCodec === 'h264' || videoCodec === 'avc1') &&
    (!audio || audioCodec === 'aac') &&
    (!pixFmt || pixFmt === 'yuv420p')
  );
};

const replaceFile = async (source: string, target: string) => {
  await fsp.rm(target, { force: true }).catch(() => undefined);
  await fsp.rename(source, target);
};

const encodeQuickTimeMp4 = async (
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
  jobId?: string,
  fast4k = false
) => {
  const videoArgs = fast4k
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
  const args = [
    '-y', '-i', inputPath,
    ...videoArgs,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    if (jobId) activeDownloadProcesses.set(jobId, child);
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/out_time_us=(\d+)/);
      if (!match || !jobId || durationSeconds <= 0) return;
      const currentSeconds = Number(match[1]) / 1_000_000;
      const job = jobs.get(jobId);
      if (!job || job.status !== 'running') return;
      const phaseStart = fast4k ? 86 : 95;
      const phaseSpan = fast4k ? 11.8 : 2.8;
      updateJob(job, {
        progress: Math.min(97.8, phaseStart + (currentSeconds / durationSeconds) * phaseSpan),
        message: fast4k ? 'Converting 4K to Mac-compatible MP4...' : 'Optimizing for QuickTime...',
      });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (jobId) activeDownloadProcesses.delete(jobId);
      const job = jobId ? jobs.get(jobId) : undefined;
      if (job && isJobCancelled(job)) {
        reject(new Error('Download cancelled by user.'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `QuickTime conversion exited with code ${code}.`));
      }
    });
  });
};

const ensureQuickTimeMp4 = async (
  options: VideoDownloaderRouteOptions,
  inputPath: string,
  jobId?: string,
  fast4k = false
) => {
  const ffmpegPath = resolveTool(options, 'ffmpeg');
  if (!ffmpegPath) throw new Error('ffmpeg is missing. Run npm install, then restart the app.');
  // Probe once
  const probeStart = Date.now();
  const probe = await probeMedia(options, inputPath);
  const probeMs = Date.now() - probeStart;
  void writeLog(jobId, { event: 'qt_probe', probe_ms: probeMs });
  const quickTimeOk = isQuickTimeCompatible(probe);
  if (quickTimeOk) {
    void writeLog(jobId, { event: 'qt_skip', reason: 'already_compatible' });
    return inputPath;
  }
  const outputPath = /\.mp4$/i.test(inputPath) ? inputPath : inputPath.replace(/\.[^.]+$/, '') + '.mp4';
  const tempOutput = path.join(path.dirname(outputPath), `.${path.basename(outputPath, path.extname(outputPath))}.${crypto.randomUUID()}.mp4`);
  const encodeStart = Date.now();
  const durationSeconds = Number(probe?.format?.duration || 0);
  await encodeQuickTimeMp4(ffmpegPath, inputPath, tempOutput, durationSeconds, jobId, fast4k);
  void writeLog(jobId, { event: 'qt_encode', encode_ms: Date.now() - encodeStart });
  await replaceFile(tempOutput, outputPath);
  if (path.resolve(inputPath) !== path.resolve(outputPath)) await fsp.rm(inputPath, { force: true }).catch(() => undefined);
  return outputPath;
};

const runDownloadAttempt = async (
  options: VideoDownloaderRouteOptions,
  job: DownloadJob,
  url: string,
  extraArgs: string[] = []
) => {
  throwIfJobCancelled(job);
  const attemptStart = Date.now();
  const ytdlp = await ensureRuntimeYtDlp(options);
  const platformDir = job.saveToWebsiteAssets && job.sourcePageUrl
    ? resolveCreativeAssetsDir(job.sourcePageUrl, 'Videos')
    : resolvePlatformVideoAssetsDir(job.platform);
  const timestamp = new Date(job.createdAt).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  await fsp.mkdir(platformDir, { recursive: true });
  const outputTemplate = path.join(platformDir, `${timestamp}_${job.platform}_${job.quality}_%(title).140B [%(id)s].%(ext)s`);
  const ffmpegPath = resolveTool(options, 'ffmpeg');
  const aria2Path = aria2cAvailable(options);
  // Googlevideo URLs frequently reject aria2's segmented requests with HTTP
  // 403. That left YouTube jobs showing synthetic 35% progress until the
  // watchdog triggered the native yt-dlp fallback. Use yt-dlp's fragment
  // downloader immediately for YouTube; keep aria2 acceleration elsewhere.
  const hasAria2 = extraArgs.includes('--no-aria2') || job.platform === 'youtube'
    ? false
    : Boolean(aria2Path);

  void writeLog(job.id, {
    event: 'download_start',
    ytdlp_path: ytdlp,
    ffmpeg_path: ffmpegPath || 'not found',
    aria2c_path: aria2Path || 'not found (disabled)',
    platform: job.platform,
    quality: job.quality,
    url,
  });

  const args = [
    ...commonYtDlpArgs(options, job.platform),
    '--newline',
    '--progress',
    '--progress-template',
    '__VDX_PROGRESS__|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print',
    'after_move:__VDX_FILE__:%(filepath)s',
    '--print',
    'after_move:__VDX_TITLE__:%(title)s',
    '--print',
    'before_dl:__VDX_THUMB__:%(thumbnail)s',
    '--windows-filenames',
    '--trim-filenames',
    '180',
    '--force-overwrites',
    '--no-part',
    '--output',
    outputTemplate,
    '--format',
    formatSelector(job.platform, job.quality, Boolean(extraArgs.includes('--quality-fallback'))),
    ...(hasAria2 ? ['--downloader', 'aria2c', '--downloader-args', 'aria2c:-x 32 -s 32 -k 2M'] : []),
    '--concurrent-fragments', '32',
    '--buffer-size', '128K',
    ...trimSectionArgs(job),
    ...(job.quality === 'audio'
      ? ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K', '--postprocessor-args', 'ffmpeg:-t 120']
      : ['--merge-output-format', 'mp4', '--remux-video', 'mp4', '--postprocessor-args', 'ffmpeg:-c copy -movflags +faststart']),
    ...extraArgs.filter(a => !a.startsWith('--no-aria2') && !a.startsWith('--quality-fallback')),
    url,
  ];

  return new Promise<{ filePath: string; title?: string; thumbnail?: string }>((resolve, reject) => {
    updateJob(job, {
      progress: 5,
      message: 'Starting download...',
    });
    const extraPath = toolPathEnv(options);
    const child = spawn(ytdlp, args, {
      env: { ...process.env, PATH: extraPath ? `${extraPath}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    activeDownloadProcesses.set(job.id, child);
    let stdout = '';
    let stderr = '';
    let filePath = '';
    let resolvedTitle = '';
    let thumbnail = '';

    // Stalled progress watchdog: first data starts the clock; 10s → message update, 120s → kill
    let lastProgressTime: number | null = null;
    const softProgressForElapsed = () =>
      Math.min(35, Math.max(job.progress, 6 + Math.floor((Date.now() - attemptStart) / 4000) * 2));
    const watchdogInterval = setInterval(() => {
      if (job.status === 'paused') return;
      if (lastProgressTime === null) {
        if (Date.now() - attemptStart > 4000 && job.status === 'running' && job.progress < 35) {
          updateJob(job, {
            progress: softProgressForElapsed(),
            message: 'Preparing video stream...',
          });
        }
        return;
      }
      const elapsed = Date.now() - lastProgressTime;
      if (elapsed > 120000) {
        child.kill();
        clearInterval(watchdogInterval);
        reject(new Error('Download took too long. The video may be unavailable or very large.'));
        return;
      }
      if (elapsed > 5000 && job.status === 'running' && job.progress < 85) {
        updateJob(job, {
          progress: softProgressForElapsed(),
          message: elapsed > 30000 ? 'Still downloading...' : 'Downloading...',
        });
      }
    }, 5000);

    const consume = (chunk: Buffer, isError: boolean) => {
      const text = chunk.toString();
      if (isError) stderr += text;
      else stdout += text;
      // Any output from process means it's past Gatekeeper verification
      if (lastProgressTime === null) lastProgressTime = Date.now();
      for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        const parsedProgress = parseYtDlpProgressLine(line);
        if (parsedProgress) {
          const ytProgress = parsedProgress.percent;
          // Map yt-dlp 0-100% → download phase 5-85%
          const mapped = Number.isFinite(ytProgress) ? 5 + ytProgress * 0.80 : job.progress;
          lastProgressTime = Date.now();
          updateJob(job, {
            progress: Math.max(5, Math.min(mapped, 85)),
            downloadedBytes: parsedProgress.downloadedBytes || job.downloadedBytes,
            totalBytes: parsedProgress.totalBytes || job.totalBytes,
            speed: parsedProgress.speed || job.speed,
            eta: parsedProgress.eta || job.eta,
            message: 'Downloading video stream...',
          });
        }
        // Merge phase
        if (/^\[Merger\]/i.test(line)) {
          updateJob(job, {
            progress: Math.max(job.progress, 85),
            message: 'Merging video + audio...',
          });
        }
        if (line.startsWith('__VDX_FILE__:')) filePath = line.slice('__VDX_FILE__:'.length).trim();
        if (line.startsWith('__VDX_TITLE__:')) resolvedTitle = line.slice('__VDX_TITLE__:'.length).trim();
        if (line.startsWith('__VDX_THUMB__:')) thumbnail = line.slice('__VDX_THUMB__:'.length).trim();
      }
    };
    child.stdout.on('data', (chunk) => consume(chunk, false));
    child.stderr.on('data', (chunk) => consume(chunk, true));
    child.on('error', (error) => {
      clearInterval(watchdogInterval);
      activeDownloadProcesses.delete(job.id);
      void writeLog(job.id, { event: 'spawn_error', error: (error as Error).message });
      reject(error);
    });
    child.on('close', async (code) => {
      clearInterval(watchdogInterval);
      activeDownloadProcesses.delete(job.id);

      if (isJobCancelled(job)) {
        reject(new Error('Download cancelled by user.'));
        return;
      }

      void writeLog(job.id, {
        event: 'download_exit',
        exit_code: code,
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 10000),
        ytdlp_path: ytdlp,
        ffmpeg_path: ffmpegPath || 'not found',
        aria2c_path: aria2Path || 'not found',
        command: `yt-dlp ${args.slice(0, 20).join(' ')} ...`,
      });

      if (code !== 0) {
        reject(Object.assign(new Error(stderr || stdout || `yt-dlp exited with ${code}`), { stderr, stdout }));
        return;
      }
      if (!filePath || !fs.existsSync(filePath)) {
        const files = await listFilesRecursive(platformDir).catch(() => []);
        filePath = files.sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.path || '';
      }
      if (!filePath || !fs.existsSync(filePath)) {
        reject(new Error('Download finished but no output file was found.'));
        return;
      }
      const downloadMs = Date.now() - attemptStart;
      void writeLog(job.id, { event: 'download_ok', download_ms: downloadMs, file_path: filePath });
      resolve({ filePath, title: resolvedTitle, thumbnail });
    });
  });
};

const runDownloadWithFallbacks = async (options: VideoDownloaderRouteOptions, job: DownloadJob) => {
  throwIfJobCancelled(job);
  const normalizedUrl = normalizeDownloaderUrl(job.url, job.platform);
  const urls = job.platform === 'x'
    ? Array.from(new Set([normalizedUrl, normalizedUrl.replace('twitter.com', 'x.com')]))
    : [normalizedUrl];
  let lastError: any;
  const aria2 = aria2cAvailable(options);

  // A. Try with aria2c
  if (aria2) {
    for (const url of urls) {
      throwIfJobCancelled(job);
      try {
        return await runDownloadAttempt(options, job, url);
      } catch (error) {
        lastError = error;
        void writeLog(job.id, { event: 'fallback_no_aria2', error: errorText(error) });
      }
    }
  }

  // B. Try without aria2c
  for (const url of urls) {
    throwIfJobCancelled(job);
    try {
      return await runDownloadAttempt(options, job, url, ['--no-aria2']);
    } catch (error) {
      lastError = error;
    }
  }

  // C. Try with cookies if auth-like error
  if (isAuthLikeError(errorText(lastError))) {
    updateJob(job, { message: 'Trying with browser cookies...' });
    for (const cookies of cookieAttempts(job.platform)) {
      for (const url of urls) {
        throwIfJobCancelled(job);
        try {
          return await runDownloadAttempt(options, job, url, [...cookies, '--no-aria2']);
        } catch (error) {
          lastError = error;
          void writeLog(job.id, { event: 'fallback_cookies', error: errorText(error) });
        }
      }
    }
  }

  // D. Lower quality fallback
  if (job.quality === '4k' || job.quality === 'fhd') {
    updateJob(job, { message: 'Retrying with best available quality...' });
    for (const url of urls) {
      throwIfJobCancelled(job);
      try {
        return await runDownloadAttempt(options, job, url, ['--no-aria2', '--quality-fallback']);
      } catch (error) {
        lastError = error;
        void writeLog(job.id, { event: 'fallback_best_available_quality', error: errorText(error) });
      }
    }
  }

  if (job.platform === 'x' && isXGuestTokenError(errorText(lastError))) {
    updateJob(job, { message: 'X.com extraction needs updated engine. Updating extractor or trying fallback route...' });
    await updateYtDlp(options);
    for (const url of urls) {
      try {
        return await runDownloadAttempt(options, job, url, ['--no-aria2']);
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (job.platform === 'x') {
    const fallbackInfo = await extractViaVxTwitter(normalizedUrl).catch(() => null);
    const fallbackUrl = String(fallbackInfo?.url || '');
    if (fallbackUrl) {
      updateJob(job, { message: 'Using X.com fallback route...' });
      try {
        return await runDownloadAttempt(options, job, fallbackUrl, ['--no-aria2']);
      } catch (error) {
        lastError = error;
      }
    }
  }

  // Log final error before throwing
  const finalMessage = errorText(lastError);
  void writeLog(job.id, {
    event: 'all_fallbacks_exhausted',
    final_error: finalMessage,
  });

  throw new Error(friendlyDownloaderError(job.platform, finalMessage));
};

type ListedFile = {
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
  sourcePageUrl?: string;
  saveToWebsiteAssets?: boolean;
};

const sidecarPathFor = (filePath: string) => `${filePath}.creative-assets.json`;

const readSidecar = async (filePath: string) => {
  const raw = await fsp.readFile(sidecarPathFor(filePath), 'utf8').catch(() => '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const writeSidecar = async (filePath: string, metadata: Record<string, unknown>) => {
  await fsp.writeFile(sidecarPathFor(filePath), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8').catch(() => undefined);
};

const createZipForDownload = async (filePath: string, metadata: Record<string, unknown>) => {
  const platform = String(metadata.platform || 'video');
  const title = sanitizeFilenamePart(String(metadata.title || path.basename(filePath, path.extname(filePath))), 'video');
  const platformRoot = path.dirname(resolvePlatformVideoAssetsDir(platform));
  await fsp.mkdir(platformRoot, { recursive: true });
  const zipPath = path.join(platformRoot, `${title}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(filePath, { name: path.basename(filePath) });
    archive.append(`${JSON.stringify(metadata, null, 2)}\n`, { name: 'metadata.json' });
    void archive.finalize();
  });
  return zipPath;
};

const openLocalPath = async (filePath: string) => {
  if (process.platform === 'darwin') return execFileAsync('open', [filePath]);
  if (process.platform === 'win32') return execFileAsync('cmd', ['/c', 'start', '', filePath]);
  return execFileAsync('xdg-open', [filePath]);
};

const revealLocalPath = async (filePath: string) => {
  if (process.platform === 'darwin') return execFileAsync('open', ['-R', filePath]);
  if (process.platform === 'win32') return execFileAsync('explorer.exe', ['/select,', filePath]);
  return openLocalPath(path.dirname(filePath));
};

const listFilesRecursive = async (root: string): Promise<ListedFile[]> => {
  const output: ListedFile[] = [];
  const walk = async (directory: string) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.creative-assets.json')) continue;
      if (/\.zip$/i.test(entry.name)) continue;
      const stat = await fsp.stat(fullPath).catch(() => null);
      if (!stat) continue;
      const relativePath = path.relative(path.join(os.homedir(), 'Downloads'), fullPath);
      const metadata: any = await readSidecar(fullPath);
      output.push({
        name: entry.name,
        title: metadata.title || path.basename(entry.name, path.extname(entry.name)),
        thumbnail: metadata.thumbnail || '',
        platform: metadata.platform || path.basename(path.dirname(root)).replace(/_CreativeAssets$/i, ''),
        status: metadata.status || 'completed',
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        path: fullPath,
        displayPath: toDisplayPath(fullPath),
        relativePath,
        quality: metadata.quality || (/audio|\.m4a$|\.mp3$/i.test(fullPath)
          ? 'Audio'
          : /1080|fhd/i.test(fullPath)
            ? 'FHD'
            : /720|hd/i.test(fullPath)
              ? 'HD'
              : 'Video'),
        zipPath: metadata.zipPath || '',
        zipDisplayPath: metadata.zipDisplayPath || '',
        zipRelativePath: metadata.zipRelativePath || '',
        sourcePageUrl: metadata.sourcePageUrl || '',
        saveToWebsiteAssets: metadata.saveToWebsiteAssets === true,
      });
    }
  };
  await walk(root);
  return output;
};

const listDownloaderFiles = async () => {
  const output: ListedFile[] = [];
  for (const platform of SUPPORTED_PLATFORMS) {
    const videosDir = resolvePlatformVideoAssetsDir(platform);
    output.push(...(await listFilesRecursive(videosDir)));
  }
  output.push(...(await listCompletedJobFiles()));
  const seen = new Set<string>();
  return output
    .filter((item) => {
      const key = path.resolve(item.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
};

const listCompletedJobFiles = async () => {
  const downloadsRoot = path.join(os.homedir(), 'Downloads');
  const output: ListedFile[] = [];
  for (const job of jobs.values()) {
    if (job.status !== 'completed') continue;
    const result: any = job.result || {};
    const filePath = String(result.filePath || '');
    if (!filePath || !isPathInside(filePath, downloadsRoot)) continue;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const metadata: any = await readSidecar(filePath);
    output.push({
      name: path.basename(filePath),
      title: metadata.title || result.title || job.title || path.basename(filePath, path.extname(filePath)),
      thumbnail: metadata.thumbnail || result.thumbnail || '',
      platform: metadata.platform || result.platform || job.platform,
      status: metadata.status || 'completed',
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      path: filePath,
      displayPath: metadata.displayPath || result.displayPath || toDisplayPath(filePath),
      relativePath: path.relative(downloadsRoot, filePath),
      quality: metadata.quality || result.quality || job.quality,
      zipPath: metadata.zipPath || '',
      zipDisplayPath: metadata.zipDisplayPath || '',
      zipRelativePath: metadata.zipRelativePath || '',
      sourcePageUrl: metadata.sourcePageUrl || job.sourcePageUrl || '',
      saveToWebsiteAssets: metadata.saveToWebsiteAssets === true || job.saveToWebsiteAssets === true,
    });
  }
  return output;
};

const removeEmptyParents = async (directory: string, stopAt: string) => {
  let current = directory;
  while (isPathInside(current, stopAt) && path.resolve(current) !== path.resolve(stopAt)) {
    const entries = await fsp.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) break;
    await fsp.rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
};

const removeDirectoryIfEmpty = async (directory: string) => {
  const entries = await fsp.readdir(directory).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (entry === '.DS_Store') {
      await fsp.unlink(path.join(directory, entry)).catch(() => undefined);
    }
  }
  await fsp.rmdir(directory).catch(() => undefined);
};

const removePlatformDownloadFolder = async (platform: string) => {
  const videosDir = resolvePlatformVideoAssetsDir(platform);
  const platformRoot = path.dirname(videosDir);
  // Platform CreativeAssets folders are owned by the downloader. Removing the
  // complete managed root also clears ZIPs, sidecars, .DS_Store files and
  // abandoned empty subfolders that would otherwise leave the main folder.
  await fsp.rm(platformRoot, { recursive: true, force: true });
};

const cleanupListedDownloadParents = async (item: ListedFile) => {
  if (item.saveToWebsiteAssets && item.sourcePageUrl) {
    const websiteVideosDir = resolveCreativeAssetsDir(item.sourcePageUrl, 'Videos');
    const websiteRoot = resolveCreativeAssetsDir(item.sourcePageUrl);
    await removeEmptyParents(path.dirname(item.path), websiteVideosDir);
    await removeEmptyParents(websiteVideosDir, websiteRoot);
    await removeDirectoryIfEmpty(websiteRoot);
    return;
  }
  const root = resolvePlatformVideoAssetsDir(item.platform);
  await removeEmptyParents(path.dirname(item.path), root);
};

const completeJob = async (
  options: VideoDownloaderRouteOptions,
  job: DownloadJob,
  downloaded: { filePath: string; title?: string } | any
) => {
  const initialPath = String(downloaded?.filePath || downloaded?.downloadPath || downloaded?.localPath || '');
  if (isJobCancelled(job)) {
    if (initialPath) await fsp.rm(initialPath, { force: true }).catch(() => undefined);
    return;
  }
  // Convert VP9 4K to broadly playable H.264 while reporting meaningful
  // progress. VideoToolbox rejects 4K encoding sessions on some Macs, so the
  // fast software preset is the reliable cross-Mac path.
  const preserveOriginal = job.quality === 'audio';
  updateJob(job, {
    progress: job.quality === '4k' ? 86 : 95,
    message: job.quality === '4k' ? 'Converting 4K to Mac-compatible MP4...' : 'Optimizing for QuickTime...',
  });
  const filePath = preserveOriginal
    ? initialPath
    : await ensureQuickTimeMp4(options, initialPath, job.id, job.quality === '4k');
  updateJob(job, { progress: 98, message: 'Finalizing file...' });
  const stat = await fsp.stat(filePath);
  const downloadsRoot = path.join(os.homedir(), 'Downloads');
  const title = downloaded?.title || job.title || path.basename(filePath, path.extname(filePath));
  const metadata = {
    title,
    thumbnail: downloaded?.thumbnail || '',
    platform: job.platform,
    quality: job.quality === '4k' ? '4K / Best' : job.quality === 'fhd' ? 'FHD' : job.quality === 'hd' ? 'HD' : 'Audio',
    status: 'completed',
    filePath,
    displayPath: downloaded?.displayPath || toDisplayPath(filePath),
    relativePath: path.relative(downloadsRoot, filePath),
    size: stat.size,
    completedAt: new Date().toISOString(),
    sourceUrl: job.url,
    sourcePageUrl: job.sourcePageUrl || '',
    saveToWebsiteAssets: job.saveToWebsiteAssets === true,
  };
  // Mark complete immediately
  updateJob(job, {
    status: 'completed',
    progress: 100,
    message: 'Download complete',
    result: {
      ok: true,
      filePath,
      displayPath: downloaded?.displayPath || toDisplayPath(filePath),
      relativePath: path.relative(downloadsRoot, filePath),
      filename: path.basename(filePath),
      size: stat.size,
      quality: job.quality,
      platform: job.platform,
      title,
      thumbnail: downloaded?.thumbnail || '',
    },
  });
  // Sidecar is written in the background. Keep videos as a single MP4 artifact;
  // automatic ZIP copies create duplicate-looking downloads and waste disk space.
  void (async () => {
    try {
      await writeSidecar(filePath, metadata);
    } catch {
      // best effort
    }
  })();
};

const processJob = async (options: VideoDownloaderRouteOptions, job: DownloadJob) => {
  if (isJobCancelled(job)) return;
  const startTime = Date.now();
  updateJob(job, { status: 'running', progress: 2, message: 'Preparing downloader...' });
  void writeLog(job.id, {
    event: 'process_start',
    ytdlp_path: resolveTool(options, 'yt-dlp'),
    ffmpeg_path: resolveTool(options, 'ffmpeg'),
    aria2c_path: resolveTool(options, 'aria2c'),
  });
  try {
    if (job.platform === 'ispot' && options.specialDownload) {
      updateJob(job, { progress: 12, message: 'Resolving iSpot.tv stream...' });
      const special = await options.specialDownload({
        url: job.url,
        quality: job.quality,
        title: job.title,
        sourcePageUrl: job.sourcePageUrl,
        saveToWebsiteAssets: job.saveToWebsiteAssets,
      });
      await completeJob(options, job, special);
      return;
    }
    const downloaded = await runDownloadWithFallbacks(options, job);
    await completeJob(options, job, downloaded);
    const totalTime = Date.now() - startTime;
    void writeLog(job.id, { event: 'download_complete', total_ms: totalTime });
  } catch (error: any) {
    if (isJobCancelled(job)) return;
    const rawError = errorText(error);
    const friendly = friendlyDownloaderError(job.platform, rawError);
    const totalTime = Date.now() - startTime;
    void writeLog(job.id, {
      event: 'download_failed',
      raw_error: rawError,
      friendly_error: friendly,
      total_ms: totalTime,
    });
    updateJob(job, {
      status: 'error',
      progress: 0,
      error: friendly,
      message: 'Download failed',
    });
  }
};

const pumpQueue = (options: VideoDownloaderRouteOptions) => {
  while (activeJobs < 2 && pendingJobs.length > 0) {
    const id = pendingJobs.shift()!;
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    activeJobs += 1;
    void processJob(options, job).finally(() => {
      activeJobs -= 1;
      pumpQueue(options);
    });
  }
};

const runningJobKey = (platform: string, url: string, quality: string, sourcePageUrl = '', startTime = '', endTime = '') =>
  `${platform}:${url}:${quality}:${sourcePageUrl}:${startTime}-${endTime}`;

const createJob = (
  options: VideoDownloaderRouteOptions,
  input: {
    url: string;
    quality?: string;
    title?: string;
    sourcePageUrl?: string;
    saveToWebsiteAssets?: boolean;
    startTime?: string;
    endTime?: string;
  }
) => {
  const validated = validateDownloaderUrl(input.url, options.validateUrl);
  const quality: DownloadQuality = input.quality === 'audio'
    ? 'audio'
    : input.quality === 'hd'
      ? 'hd'
      : input.quality === 'fhd'
        ? 'fhd'
        : '4k';
  // Dedup: if same platform+url+quality is already running or completed, return existing
  const sourcePageUrl = String(input.sourcePageUrl || '').trim();
  const saveToWebsiteAssets = input.saveToWebsiteAssets === true && Boolean(sourcePageUrl);
  const { startTime, endTime } = normalizeTrimRange(input.startTime, input.endTime);
  const key = runningJobKey(validated.platform, validated.url, quality, saveToWebsiteAssets ? sourcePageUrl : '', startTime, endTime);
  for (const existing of jobs.values()) {
    if (existing.status === 'queued' || existing.status === 'running') {
      if (runningJobKey(
        existing.platform,
        existing.url,
        existing.quality,
        existing.saveToWebsiteAssets ? existing.sourcePageUrl : '',
        existing.startTime,
        existing.endTime
      ) === key) {
        return existing;
      }
    }
  }
  const job: DownloadJob = {
    id: crypto.randomUUID(),
    url: validated.url,
    title: sanitizeFilenamePart(input.title || '', ''),
    platform: validated.platform,
    quality,
    sourcePageUrl,
    saveToWebsiteAssets,
    startTime,
    endTime,
    status: 'queued',
    progress: 0,
    downloadedBytes: 0,
    message: 'Queued',
    createdAt: now(),
    updatedAt: now(),
  };
  jobs.set(job.id, job);
  pendingJobs.push(job.id);
  pumpQueue(options);
  return job;
};

const publicJob = (job: DownloadJob) => ({ ...job });

const trimJobs = () => {
  const sorted = Array.from(jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const job of sorted.slice(100)) jobs.delete(job.id);
};

export const registerVideoDownloaderRoutes = (app: Express, options: VideoDownloaderRouteOptions) => {
  app.post('/api/downloader/inspect', async (req, res) => {
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'URL is required.' });
    try {
      const validated = validateDownloaderUrl(rawUrl, options.validateUrl);
      if (validated.platform === 'ispot' && options.specialInspect) {
        const payload = await options.specialInspect(validated.url);
        const videos = specialPayloadToCards(payload, validated.url, validated.platform);
        return res.json({ ok: true, platform: validated.platform, videos, count: videos.length });
      }
      const cacheKey = `${validated.platform}:${validated.url}`;
      const cached = inspectCache.get(cacheKey);
      if (cached && cached.expiresAt > now()) {
        return res.json(cached.payload);
      }
      const info = await inspectWithFallbacks(options, validated.url, validated.platform);
      const videos = infoToCards(info, validated.url, validated.platform);
      if (videos.length === 0) throw new Error('No downloadable video was found for this URL.');
      const payload = { ok: true, platform: validated.platform, videos, count: videos.length };
      inspectCache.set(cacheKey, { expiresAt: now() + INSPECT_CACHE_TTL_MS, payload });
      if (inspectCache.size > 60) {
        const expiredOrOldest = Array.from(inspectCache.entries())
          .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
          .slice(0, 20);
        expiredOrOldest.forEach(([key]) => inspectCache.delete(key));
      }
      return res.json(payload);
    } catch (error: any) {
      const platform = detectDownloaderPlatform(rawUrl);
      return res.status(400).json({ error: friendlyDownloaderError(platform, errorText(error)) });
    }
  });

  app.post('/api/downloader/download', (req, res) => {
    try {
      const job = createJob(options, {
        url: String(req.body?.url || '').trim(),
        quality: String(req.body?.quality || 'fhd').toLowerCase(),
        title: String(req.body?.title || '').trim(),
        sourcePageUrl: String(req.body?.sourcePageUrl || '').trim(),
        saveToWebsiteAssets: req.body?.saveToWebsiteAssets === true,
        startTime: String(req.body?.startTime || '').trim(),
        endTime: String(req.body?.endTime || '').trim(),
      });
      trimJobs();
      return res.status(202).json({ ok: true, job: publicJob(job) });
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'Could not start download.' });
    }
  });

  app.post('/api/downloader/bulk', (req, res) => {
    const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const urls: string[] = Array.from(
      new Set<string>(rawUrls.map((value: unknown) => String(value || '').trim()).filter(Boolean))
    ).slice(0, 20);
    const quality = String(req.body?.quality || 'fhd').toLowerCase();
    const trimRange = normalizeTrimRange(req.body?.startTime, req.body?.endTime);
    if (urls.length === 0) return res.status(400).json({ error: 'Enter at least one video URL.' });
    const created: DownloadJob[] = [];
    const errors: Array<{ url: string; error: string }> = [];
    for (const url of urls) {
      try {
        created.push(createJob(options, { url, quality, ...trimRange }));
      } catch (error: any) {
        errors.push({ url, error: error?.message || 'Invalid URL' });
      }
    }
    trimJobs();
    return res.status(202).json({ ok: created.length > 0, jobs: created.map(publicJob), errors });
  });

  app.get('/api/downloader/jobs/:id', (req, res) => {
    const job = jobs.get(String(req.params.id || ''));
    if (!job) return res.status(404).json({ error: 'Download job was not found.' });
    return res.json({ ok: true, job: publicJob(job) });
  });

  app.post('/api/downloader/jobs/:id/cancel', (req, res) => {
    const id = String(req.params.id || '');
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Download job was not found.' });
    if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
      return res.json({ ok: true, job: publicJob(job) });
    }
    cancelledJobs.add(id);
    const pendingIndex = pendingJobs.indexOf(id);
    if (pendingIndex >= 0) pendingJobs.splice(pendingIndex, 1);
    const child = activeDownloadProcesses.get(id);
    if (child && job.status === 'paused' && process.platform !== 'win32') {
      child.kill('SIGCONT');
    }
    child?.kill('SIGTERM');
    updateJob(job, {
      status: 'cancelled',
      progress: 0,
      message: 'Download cancelled',
      error: undefined,
    });
    return res.json({ ok: true, job: publicJob(job) });
  });

  app.post('/api/downloader/jobs/:id/pause', (req, res) => {
    const id = String(req.params.id || '');
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Download job was not found.' });
    if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
      return res.json({ ok: true, job: publicJob(job) });
    }
    if (job.status === 'paused') {
      return res.json({ ok: true, job: publicJob(job) });
    }

    const pendingIndex = pendingJobs.indexOf(id);
    if (pendingIndex >= 0) pendingJobs.splice(pendingIndex, 1);

    const child = activeDownloadProcesses.get(id);
    if (child && process.platform !== 'win32') {
      try {
        child.kill('SIGSTOP');
      } catch (error: any) {
        return res.status(500).json({ error: error?.message || 'Could not pause download.' });
      }
    } else if (child && process.platform === 'win32') {
      return res.status(400).json({ error: 'Pause is not supported for active downloads on Windows. Cancel and restart the selected time range instead.' });
    }

    updateJob(job, {
      status: 'paused',
      message: 'Download paused',
    });
    return res.json({ ok: true, job: publicJob(job) });
  });

  app.post('/api/downloader/jobs/:id/resume', (req, res) => {
    const id = String(req.params.id || '');
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Download job was not found.' });
    if (job.status !== 'paused') {
      return res.json({ ok: true, job: publicJob(job) });
    }

    const child = activeDownloadProcesses.get(id);
    if (child && process.platform !== 'win32') {
      try {
        child.kill('SIGCONT');
        updateJob(job, {
          status: 'running',
          message: 'Download resumed',
        });
      } catch (error: any) {
        return res.status(500).json({ error: error?.message || 'Could not resume download.' });
      }
    } else {
      updateJob(job, {
        status: 'queued',
        message: 'Queued',
      });
      if (!pendingJobs.includes(id)) pendingJobs.push(id);
      pumpQueue(options);
    }

    return res.json({ ok: true, job: publicJob(job) });
  });

  app.get('/api/downloader/jobs', (_req, res) => {
    const items = Array.from(jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt).map(publicJob);
    return res.json({ items, count: items.length });
  });

  app.delete('/api/downloader/jobs', (_req, res) => {
    for (const id of pendingJobs.splice(0)) {
      cancelledJobs.add(id);
    }
    for (const [id, child] of activeDownloadProcesses.entries()) {
      const job = jobs.get(id);
      cancelledJobs.add(id);
      if (job?.status === 'paused' && process.platform !== 'win32') {
        child.kill('SIGCONT');
      }
      child.kill('SIGTERM');
    }
    const removed = jobs.size;
    jobs.clear();
    activeDownloadProcesses.clear();
    cancelledJobs.clear();
    return res.json({ ok: true, removed });
  });

  app.get('/api/downloader/downloads', async (_req, res) => {
    try {
      const items = await listDownloaderFiles();
      return res.json({ items, count: items.length });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Failed to list downloads.' });
    }
  });

  app.delete('/api/downloader/downloads', async (req, res) => {
    try {
      const deleteFiles = Boolean(req.body?.deleteFiles);
      const items = await listDownloaderFiles();
      const completedIds = new Set(
        Array.from(jobs.values())
          .filter((job) => job.status === 'completed' || job.status === 'error' || job.status === 'cancelled')
          .map((job) => job.id)
      );
      completedIds.forEach((id) => jobs.delete(id));
      if (!deleteFiles) {
        return res.json({ ok: true, mode: 'history', removed: completedIds.size });
      }
      for (const item of items) {
        await fsp.unlink(item.path).catch(() => undefined);
        await fsp.unlink(sidecarPathFor(item.path)).catch(() => undefined);
        if (item.zipPath && isPathInside(item.zipPath, path.join(os.homedir(), 'Downloads'))) {
          await fsp.unlink(item.zipPath).catch(() => undefined);
        }
        await cleanupListedDownloadParents(item);
      }
      for (const platform of SUPPORTED_PLATFORMS) {
        await removePlatformDownloadFolder(platform);
      }
      return res.json({ ok: true, mode: 'files', removed: items.length });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Failed to clear downloads.' });
    }
  });

  app.post('/api/downloader/open', async (req, res) => {
    const relativePath = String(req.body?.path || '');
    const downloadsRoot = path.join(os.homedir(), 'Downloads');
    const filePath = path.resolve(downloadsRoot, relativePath);
    if (!relativePath || !isPathInside(filePath, downloadsRoot)) {
      return res.status(400).json({ error: 'Invalid download path.' });
    }
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a file');
      await openLocalPath(filePath);
      return res.json({ ok: true, path: filePath });
    } catch (error: any) {
      return res.status(404).json({ error: error?.message || 'Downloaded file was not found.' });
    }
  });

  app.post('/api/downloader/reveal', async (req, res) => {
    const relativePath = String(req.body?.path || '');
    const downloadsRoot = path.join(os.homedir(), 'Downloads');
    const filePath = path.resolve(downloadsRoot, relativePath);
    if (!relativePath || !isPathInside(filePath, downloadsRoot)) {
      return res.status(400).json({ error: 'Invalid download path.' });
    }
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a file');
      await revealLocalPath(filePath);
      return res.json({ ok: true, path: filePath });
    } catch (error: any) {
      return res.status(404).json({ error: error?.message || 'Downloaded file was not found.' });
    }
  });

  app.get('/api/downloader/file', async (req, res) => {
    const relativePath = String(req.query?.path || '');
    const downloadsRoot = path.join(os.homedir(), 'Downloads');
    const filePath = path.resolve(downloadsRoot, relativePath);
    if (!relativePath || !isPathInside(filePath, downloadsRoot)) {
      return res.status(400).json({ error: 'Invalid download path.' });
    }
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a file');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilenamePart(path.basename(filePath))}"`);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'no-store, private');
      return fs.createReadStream(filePath).pipe(res);
    } catch {
      return res.status(404).json({ error: 'Downloaded file was not found.' });
    }
  });
};
