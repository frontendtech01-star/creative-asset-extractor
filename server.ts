import express from 'express';
import path from 'path';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import * as cheerio from 'cheerio';
import archiver from 'archiver';
import extractZip from 'extract-zip';
import { URL } from 'url';
import puppeteer from 'puppeteer';
import youtubedlModule from 'youtube-dl-exec';
import ytdl from '@distube/ytdl-core';
import { parseSrcset } from 'srcset';
import { Font, woff2 } from 'fonteditor-core';
import opentype from 'opentype.js';
import { Client as FtpClient } from 'basic-ftp';
import { Readable } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import https from 'https';
import net from 'net';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { promisify } from 'util';
import { createRequire } from 'module';
import { setupExtractProgressWS, ExtractionProgressManager, setGlobalProgressManager } from './server/extract-progress-ws';
import { registerVideoDownloaderRoutes } from './server/video-downloader-routes';
import { isExpiredStreamUrl, isLikelyHttpMediaUrl, recoverYouTubeWatchFromMergeQuery, sanitizeStreamUrl } from './src/lib/streamUrl';
import {
  convertRasterImageBuffer,
  detectRasterFormatFromBuffer,
  isValidRasterOutputBuffer,
  loadSharp,
  supportedRasterConversionTargets,
  type RasterOutputFormat,
} from './src/lib/convertRasterImage';
import { generateImageThumbArtifacts } from './src/lib/generateImageThumb';
import { compressScreenshotBufferForSheet, compressScreenshotDataUrlForSheet } from './src/lib/compressFeedbackScreenshotForSheet';
import {
  buildFontDisplayName,
  buildFontZipEntryName,
  dedupeFontsByLogicalKey,
  getFontConversionOutputs,
  isJunkFontLabel,
  pickBestFontForUrl,
  resolveFontIdentityFields,
  scoreFontRecord,
} from './src/lib/fontAsset';
import {
  CREATIVE_ASSET_SUBFOLDERS,
  ensurePlatformVideoFolderOnly,
  removeEmptyCreativeAssetFolders,
  resolveCreativeAssetsDir,
  resolveCreativeAssetsRoot,
  resolvePlatformVideoAssetsDir,
  VIDEO_ASSET_SUBFOLDER,
  type CreativeAssetSubfolder,
} from './src/lib/projectDownloadsPaths';

const require = createRequire(import.meta.url);
const getAppRoot = () => process.env.VDX_APP_ROOT || process.cwd();
const insightsPageEvaluate = require(path.join(getAppRoot(), 'scripts', 'insights-page-evaluate.cjs')) as (
  pageUrl: string,
  keywordList: string[]
) => Record<string, unknown>;

const execFileAsync = promisify(execFile);

const clearMacQuarantine = async (filePath: string) => {
  if (process.platform !== 'darwin' || !filePath) return;
  await execFileAsync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', filePath]).catch(() => undefined);
};

const getResourcesPath = () => process.env.VDX_RESOURCES_PATH || getAppRoot();

const getUnpackedModulePath = (...segments: string[]) => {
  const resources = process.env.VDX_RESOURCES_PATH;
  if (resources) {
    const unpacked = path.join(resources, 'app.asar.unpacked', ...segments);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(getAppRoot(), ...segments);
};

const resolveBundledBinPath = (binaryName: string) => {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const fileName = `${binaryName}${ext}`;
  const candidates = [
    path.join(getResourcesPath(), 'bin', fileName),
    path.join(getAppRoot(), 'vendor', 'bin-pack', fileName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
};

const resolveFfprobePath = (ffmpegBinaryPath = '') => {
  const bundled = resolveBundledBinPath('ffprobe');
  if (bundled) return bundled;
  try {
    const installer = require('@ffprobe-installer/ffprobe') as { path?: string };
    if (installer?.path && fs.existsSync(String(installer.path))) return String(installer.path);
  } catch {
    // Optional dev dependency path.
  }
  const ffmpegDir = ffmpegBinaryPath ? path.dirname(ffmpegBinaryPath) : '';
  if (ffmpegDir) {
    const sibling = path.join(ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) return sibling;
  }
  return '';
};

const resolveFfmpegBinaryPath = () => {
  const bundled = resolveBundledBinPath('ffmpeg');
  if (bundled) return bundled;
  if (ffmpegPath && fs.existsSync(String(ffmpegPath))) return String(ffmpegPath);
  const unpacked = getUnpackedModulePath('node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(unpacked)) return unpacked;
  return ffmpegPath ? String(ffmpegPath) : '';
};

const isPythonScriptBinary = (filePath: string) => {
  try {
    const head = fs.readFileSync(filePath, { encoding: 'utf8' }).slice(0, 128);
    return /^#!.*python/i.test(head);
  } catch {
    return false;
  }
};

const isAcceptableYtDlpBinary = (filePath: string) => {
  const candidate = String(filePath || '').trim();
  if (!candidate || !fs.existsSync(candidate) || isPythonScriptBinary(candidate)) return false;
  return true;
};

const resolveYtDlpPath = () => {
  const candidates = [
    resolveBundledBinPath('yt-dlp'),
    path.join(getAppRoot(), 'vendor', 'bin-pack', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    path.join(os.homedir(), '.creative-asset-extractor', 'runtime-bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ];
  return candidates.find((candidate) => isAcceptableYtDlpBinary(candidate)) || '';
};

const resolveAria2BinaryPath = () => {
  const candidates = [
    resolveBundledBinPath('aria2c'),
    path.join(getAppRoot(), 'vendor', 'bin-pack', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'),
    path.join(getResourcesPath(), 'vendor', 'aria2', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'),
    path.join(os.homedir(), '.creative-asset-extractor', 'runtime-bin', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
};

let resolvedFfmpegPath = resolveFfmpegBinaryPath();
let resolvedFfprobePath = resolveFfprobePath(resolvedFfmpegPath);
let resolvedYtDlpPath = resolveYtDlpPath();
let resolvedAria2Path = resolveAria2BinaryPath();

const logYouTubeMerge = (stage: string, details: Record<string, unknown> = {}) => {
  console.log(
    `[youtube-merge:${stage}]`,
    JSON.stringify({
      ...details,
      ffmpegPath: resolvedFfmpegPath,
      ffprobePath: resolvedFfprobePath,
      ytdlpPath: resolvedYtDlpPath,
      resourcesPath: getResourcesPath(),
      tempDir: path.join(os.tmpdir(), 'creative-asset-extractor-mp4'),
      ts: new Date().toISOString(),
    })
  );
};

const findBundledChromiumExecutable = () => {
  const chromeCacheRoot = path.join(getResourcesPath(), 'chromium', 'chrome');
  if (!fs.existsSync(chromeCacheRoot)) return '';
  const variants =
    process.platform === 'win32'
      ? [{ prefix: 'win64-', segments: ['chrome-win64', 'chrome.exe'] }]
      : process.platform === 'linux'
        ? [{ prefix: 'linux-', segments: ['chrome-linux64', 'chrome'] }]
        : process.arch === 'arm64'
          ? [{ prefix: 'mac_arm-', segments: ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'] }]
          : [{ prefix: 'mac-', segments: ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'] }];
  try {
    const entries = fs.readdirSync(chromeCacheRoot);
    for (const variant of variants) {
      const versionDir = entries.find((name) => {
        if (variant.prefix === 'mac-') return name.startsWith('mac-') && !name.startsWith('mac_arm-');
        return name.startsWith(variant.prefix);
      });
      if (!versionDir) continue;
      const executable = path.join(chromeCacheRoot, versionDir, ...variant.segments);
      if (fs.existsSync(executable)) return executable;
    }
    return '';
  } catch {
    return '';
  }
};

if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
}
if (resolvedFfprobePath) {
  ffmpeg.setFfprobePath(resolvedFfprobePath);
}

const ytDlpCookieAccessDenied = (message: string) =>
  /cookies|operation not permitted|errno 1/i.test(message);

const wrapYtDlpWithCookieFallback = (impl: (...args: any[]) => Promise<any>) =>
  (async (url: string, options: Record<string, unknown> = {}) => {
    try {
      return await impl(url, options as any);
    } catch (error: any) {
      const message = String(error?.message || error || '');
      if (options.cookiesFromBrowser && ytDlpCookieAccessDenied(message)) {
        const { cookiesFromBrowser: _ignored, ...withoutCookies } = options;
        return await impl(url, withoutCookies as any);
      }
      throw error;
    }
  }) as (...args: any[]) => Promise<any>;

let youtubedl = wrapYtDlpWithCookieFallback(
  youtubedlModule as unknown as (...args: any[]) => Promise<any>
);

const stageRuntimeBinary = async (sourcePath: string, binaryName: string) => {
  const source = String(sourcePath || '').trim();
  if (!source || !fs.existsSync(source)) return '';
  if (!source.includes(' ')) {
    await clearMacQuarantine(source);
    return source;
  }
  const destDir = path.join(os.homedir(), '.creative-asset-extractor', 'runtime-bin');
  const destName = process.platform === 'win32' ? `${binaryName}.exe` : binaryName;
  const dest = path.join(destDir, destName);
  await fsp.mkdir(destDir, { recursive: true });
  try {
    const [srcStat, destStat] = await Promise.all([fsp.stat(source), fsp.stat(dest).catch(() => null)]);
    if (!destStat || destStat.size !== srcStat.size || destStat.mtimeMs < srcStat.mtimeMs) {
      await fsp.copyFile(source, dest);
      await fsp.chmod(dest, 0o755);
    }
  } catch {
    await fsp.copyFile(source, dest);
    await fsp.chmod(dest, 0o755);
  }
  await clearMacQuarantine(dest);
  logYouTubeMerge('stage-runtime-binary', { source, dest, binaryName });
  return dest;
};

const refreshResolvedMediaTools = async () => {
  const ffmpegSource = resolveFfmpegBinaryPath();
  const ytdlpSource = resolveYtDlpPath();
  const aria2Source = resolveAria2BinaryPath();
  resolvedFfmpegPath = await stageRuntimeBinary(ffmpegSource, 'ffmpeg');
  resolvedFfprobePath = await stageRuntimeBinary(resolveFfprobePath(ffmpegSource), 'ffprobe');
  resolvedYtDlpPath = await stageRuntimeBinary(ytdlpSource, 'yt-dlp');
  resolvedAria2Path = aria2Source ? await stageRuntimeBinary(aria2Source, 'aria2c') : '';
  if (resolvedFfmpegPath) {
    ffmpeg.setFfmpegPath(resolvedFfmpegPath);
    await fsp.chmod(resolvedFfmpegPath, 0o755).catch(() => undefined);
  }
  if (resolvedFfprobePath) {
    ffmpeg.setFfprobePath(resolvedFfprobePath);
    await fsp.chmod(resolvedFfprobePath, 0o755).catch(() => undefined);
  }
  if (resolvedYtDlpPath) {
    if (isPythonScriptBinary(resolvedYtDlpPath)) {
      throw new Error('Bundled yt-dlp is a Python script. Rebuild the desktop app to bundle the standalone yt-dlp binary.');
    }
    await fsp.chmod(resolvedYtDlpPath, 0o755).catch(() => undefined);
    await clearMacQuarantine(resolvedYtDlpPath);
  }
  if (resolvedAria2Path) await fsp.chmod(resolvedAria2Path, 0o755).catch(() => undefined);
  aria2Path = resolvedAria2Path;
  try {
    const { create: createYtDlp } = require('youtube-dl-exec') as { create?: (binaryPath: string) => typeof youtubedl };
    if (resolvedYtDlpPath && typeof createYtDlp === 'function') {
      youtubedl = wrapYtDlpWithCookieFallback(createYtDlp(resolvedYtDlpPath));
    }
  } catch {
    // Fall back to default youtube-dl-exec export.
  }
  logYouTubeMerge('runtime-tools', {
    ffmpegReady: Boolean(resolvedFfmpegPath),
    ffprobeReady: Boolean(resolvedFfprobePath),
    ytdlpReady: Boolean(resolvedYtDlpPath),
    aria2Ready: Boolean(resolvedAria2Path),
    ytdlpStandalone: resolvedYtDlpPath ? !isPythonScriptBinary(resolvedYtDlpPath) : false,
  });
};

let aria2Path = resolvedAria2Path;

let woff2Ready: Promise<void> | null = null;
const ensureWoff2Ready = async () => {
  if (!woff2Ready) {
    woff2Ready = import('fonteditor-core')
      .then(({ woff2 }) => woff2.init())
      .then(() => undefined)
      .catch((error) => {
        woff2Ready = null;
        throw error;
      });
  }
  await woff2Ready;
};

const resolveAppDataDir = () =>
  String(process.env.VDX_USER_DATA || '').trim() || path.join(os.homedir(), '.creative-asset-extractor');

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || 3000);
let activePort = DEFAULT_PORT;
const appCacheRoot = path.join(resolveAppDataDir(), 'cache');
const convertedVideoDir = path.join(os.tmpdir(), 'creative-asset-extractor-mp4');
const convertedAudioDir = path.join(os.tmpdir(), 'creative-asset-extractor-audio');
const generatedThumbnailDir = path.join(appCacheRoot, 'thumbnails');
const generatedImageThumbDir = path.join(appCacheRoot, 'image-thumbs');
const cachedImageDir = path.join(appCacheRoot, 'images');
const cachedFontDir = path.join(appCacheRoot, 'fonts');
const cachedImageOriginalDir = path.join(appCacheRoot, 'images-original');
const cachedFontOriginalDir = path.join(appCacheRoot, 'fonts-original');
const downloadsDir =
  String(process.env.CAE_DOWNLOADS_DIR || '').trim() ||
  path.join(os.homedir(), 'Downloads');
let lastExtractedSourceUrl = '';
let activeExtractProgress: ExtractionProgressManager | null = null;

const looksLikeStandaloneAssetSourceUrl = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (/\.(?:svg|png|jpe?g|webp|gif|avif|mp4|webm|mov|m3u8|mpd|woff2?|ttf|otf|eot)(?:$|[?#])/i.test(pathAndSearch)) {
      return true;
    }
    if (/\/(?:assets?|static|images?|img|media|content\/dam|is\/image|_next\/image|cdn-cgi\/image)\//i.test(pathAndSearch)) {
      return true;
    }
    if (/[?&](?:url|src|image|asset|assetid|fmt|format|fm|wid|width|hei|height|qlt|quality)=/i.test(pathAndSearch)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

const normalizeProjectSourcePageUrl = (candidate: string, fallback = lastExtractedSourceUrl) => {
  const raw = String(candidate || '').trim();
  const fallbackUrl = String(fallback || '').trim();
  if (raw && !looksLikeStandaloneAssetSourceUrl(raw)) return raw;
  if (fallbackUrl && fallbackUrl !== raw && !looksLikeStandaloneAssetSourceUrl(fallbackUrl)) return fallbackUrl;
  return raw || fallbackUrl;
};

const readSourcePageUrl = (req?: express.Request, explicit?: string) => {
  const direct = String(explicit || '').trim();
  if (direct) return normalizeProjectSourcePageUrl(direct);
  if (!req) return normalizeProjectSourcePageUrl(lastExtractedSourceUrl);
  const fromQuery = typeof req.query?.sourcePageUrl === 'string' ? req.query.sourcePageUrl.trim() : '';
  const fromBody = typeof req.body?.sourcePageUrl === 'string' ? req.body.sourcePageUrl.trim() : '';
  return normalizeProjectSourcePageUrl(fromQuery || fromBody || lastExtractedSourceUrl);
};

type DownloadSaveKind = 'font' | 'image' | 'icon' | 'color' | 'video' | 'audio' | 'brief' | 'isi' | 'zip' | 'default';

let lastExtractionSectionMode = false;

const resolveDownloadSaveDir = (kind: DownloadSaveKind = 'default', sourcePageUrl?: string) => {
  const pageUrl = String(sourcePageUrl || lastExtractedSourceUrl || '').trim();
  const pathOptions = { sectionMode: lastExtractionSectionMode };
  if (kind === 'font') return resolveCreativeAssetsDir(pageUrl, 'Fonts', pathOptions);
  if (kind === 'icon') return resolveCreativeAssetsDir(pageUrl, 'Images', pathOptions);
  if (kind === 'color') return resolveCreativeAssetsDir(pageUrl, 'Colors', pathOptions);
  if (kind === 'image') return resolveCreativeAssetsDir(pageUrl, 'Images', pathOptions);
  if (kind === 'zip') return resolveCreativeAssetsRoot(pageUrl, pathOptions);
  if (kind === 'video' || kind === 'audio') {
    const platform = platformProviderFromUrl(pageUrl) || 'video';
    return resolvePlatformVideoAssetsDir(platform);
  }
  return resolveCreativeAssetsRoot(pageUrl, pathOptions);
};

const resolveVideoDownloadTargetDir = (sourcePageUrl?: string, saveToWebsiteAssets = false) =>
  saveToWebsiteAssets
    ? resolveCreativeAssetsDir(String(sourcePageUrl || lastExtractedSourceUrl || '').trim(), 'Videos')
    : resolveDownloadSaveDir('video', String(sourcePageUrl || lastExtractedSourceUrl || '').trim());

const resolveDownloadsTargetDir = (sourcePageUrl?: string) =>
  resolveVideoDownloadTargetDir(String(sourcePageUrl || lastExtractedSourceUrl || '').trim());

const assertPathInsideDownloads = (filePath: string) => {
  const resolved = path.resolve(filePath);
  const root = path.resolve(downloadsDir);
  if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  throw new Error('Download path resolved outside Downloads.');
};
const appDataDir = resolveAppDataDir();
const feedbackInboxPath = path.join(appDataDir, 'feedback', 'inbox.jsonl');
const feedbackConfigPath = path.join(appDataDir, 'feedback-config.json');
const activityLogPath = path.join(appDataDir, 'logs', 'activity.jsonl');
const feedbackScreenshotDir = path.join(appDataDir, 'feedback', 'screenshots');
const MAX_ACTIVITY_LOG_ENTRIES = 100;
const bookmarksDir = path.join(appDataDir, 'bookmarks');
const bookmarksPath = path.join(bookmarksDir, 'bookmarks.json');
const bookmarkBackupsDir = path.join(bookmarksDir, 'backups');
// Prefer IPv4 because some media CDNs (notably videos-cdn.ispot.tv) publish an
// IPv6 route that is unreachable on otherwise healthy local networks.
const relaxedHttpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
let activeExtractionProxyUrl = '';

const normalizeExtractionProxyUrl = (rawProxyUrl: unknown) => {
  const value = String(rawProxyUrl || '').trim();
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Proxy URL must include protocol, host, and port. Example: http://user:pass@host:port');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error('Proxy protocol must be http, https, socks4, or socks5.');
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('Proxy URL must include host and port. Example: http://user:pass@host:port');
  }
  return parsed.href;
};

const axiosProxyOptions = (rawProxyUrl = activeExtractionProxyUrl) => {
  const proxyUrl = String(rawProxyUrl || '').trim();
  if (!proxyUrl) return {};
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {};
    return {
      proxy: {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port: Number(parsed.port),
        ...(parsed.username || parsed.password
          ? {
              auth: {
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
              },
            }
          : {}),
      },
    };
  } catch {
    return {};
  }
};

const proxyServerArg = (rawProxyUrl = activeExtractionProxyUrl) => {
  const proxyUrl = String(rawProxyUrl || '').trim();
  if (!proxyUrl) return '';
  try {
    const parsed = new URL(proxyUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
};

const applyProxyAuthToPage = async (page: any, rawProxyUrl = activeExtractionProxyUrl) => {
  const proxyUrl = String(rawProxyUrl || '').trim();
  if (!proxyUrl) return;
  try {
    const parsed = new URL(proxyUrl);
    if (!parsed.username && !parsed.password) return;
    await page.authenticate({
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  } catch {
    // Browser proxy auth is best-effort; unauthenticated proxies still work.
  }
};

const loadProjectEnvFile = () => {
  const candidates = [
    path.join(process.cwd(), '.env'),
    ...(process.env.VDX_APP_ROOT ? [path.join(String(process.env.VDX_APP_ROOT), '.env')] : []),
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const text = fs.readFileSync(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator <= 0) continue;
        const key = trimmed.slice(0, separator).trim();
        const rawValue = trimmed.slice(separator + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, '');
        if (key && process.env[key] === undefined) process.env[key] = value;
      }
      return;
    } catch {
      // try next candidate
    }
  }
};

loadProjectEnvFile();

const DEFAULT_FEEDBACK_SHEET_ID = '1dxhHtdi06oOwh-9d-ZdMxo8Wa7LIYJBu7lWXTsaP2xI';
const DEFAULT_FEEDBACK_SHEET_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbzLhhL_vAF3coBLJXMKlKLe4JpRPp05f8JwRSgaUxD6luz315Z6RHFwN9mtALhNCSSgFQ/exec';
const EXPECTED_FEEDBACK_SHEET_WEBHOOK_VERSION = 6;

type FeedbackFormConfig = {
  actionUrl: string;
  nameEntryId: string;
  suggestionsEntryId: string;
  appVersionEntryId?: string;
  platformEntryId?: string;
};

type FeedbackPayload = {
  name: string;
  category: string;
  suggestions: string;
  submittedAt: string;
  appVersion: string;
  platform: string;
  architecture: string;
  osLabel: string;
  websiteUrl: string;
  videoUrl: string;
  fontName: string;
  screenshotUrl: string;
  lastError: string;
};

type FeedbackSheetConfig = {
  webhookUrl: string;
  sheetId: string;
};

type FeedbackRemoteTarget =
  | { mode: 'sheet'; config: FeedbackSheetConfig }
  | { mode: 'google-form'; config: FeedbackFormConfig };

let cachedFeedbackTarget: FeedbackRemoteTarget | null | undefined;

const readFeedbackConfigJson = async (): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fsp.readFile(feedbackConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const resolveFeedbackSheetConfig = async (): Promise<FeedbackSheetConfig | null> => {
  const fromFile = await readFeedbackConfigJson();
  const webhookUrl = String(
    fromFile?.sheetWebhookUrl ||
    process.env.GOOGLE_SHEET_FEEDBACK_WEBHOOK_URL ||
    DEFAULT_FEEDBACK_SHEET_WEBHOOK_URL ||
    ''
  ).trim();
  if (!webhookUrl) return null;
  const sheetId = String(
    fromFile?.sheetId ||
    process.env.GOOGLE_SHEET_ID ||
    DEFAULT_FEEDBACK_SHEET_ID
  ).trim();
  return { webhookUrl, sheetId };
};

const resolveFeedbackFormConfig = async (): Promise<FeedbackFormConfig | null> => {
  const fromFile = await readFeedbackConfigJson();
  const actionUrl = String(
    fromFile?.actionUrl ||
    process.env.GOOGLE_FORM_ACTION_URL ||
    process.env.VITE_GOOGLE_FORM_ACTION_URL ||
    ''
  ).trim();
  const nameEntryId = String(
    fromFile?.nameEntryId ||
    process.env.GOOGLE_FORM_NAME_ENTRY ||
    process.env.VITE_GOOGLE_FORM_NAME_ENTRY ||
    ''
  ).trim();
  const suggestionsEntryId = String(
    fromFile?.suggestionsEntryId ||
    process.env.GOOGLE_FORM_SUGGESTIONS_ENTRY ||
    process.env.VITE_GOOGLE_FORM_SUGGESTIONS_ENTRY ||
    ''
  ).trim();
  const appVersionEntryId = String(
    fromFile?.appVersionEntryId ||
    process.env.GOOGLE_FORM_APP_VERSION_ENTRY ||
    process.env.VITE_GOOGLE_FORM_APP_VERSION_ENTRY ||
    ''
  ).trim();
  const platformEntryId = String(
    fromFile?.platformEntryId ||
    process.env.GOOGLE_FORM_PLATFORM_ENTRY ||
    process.env.VITE_GOOGLE_FORM_PLATFORM_ENTRY ||
    ''
  ).trim();
  if (!actionUrl || !nameEntryId || !suggestionsEntryId) return null;
  return {
    actionUrl,
    nameEntryId,
    suggestionsEntryId,
    ...(appVersionEntryId ? { appVersionEntryId } : {}),
    ...(platformEntryId ? { platformEntryId } : {}),
  };
};

const resolveFeedbackTarget = async (): Promise<FeedbackRemoteTarget | null> => {
  if (cachedFeedbackTarget !== undefined) return cachedFeedbackTarget;
  const sheet = await resolveFeedbackSheetConfig();
  if (sheet) {
    cachedFeedbackTarget = { mode: 'sheet', config: sheet };
    return cachedFeedbackTarget;
  }
  const googleForm = await resolveFeedbackFormConfig();
  if (googleForm) {
    cachedFeedbackTarget = { mode: 'google-form', config: googleForm };
    return cachedFeedbackTarget;
  }
  cachedFeedbackTarget = null;
  return null;
};

const appendLocalFeedbackInbox = async (payload: FeedbackPayload) => {
  await fsp.mkdir(path.dirname(feedbackInboxPath), { recursive: true });
  const entry = {
    ...payload,
    destination: 'frontendtech01@gmail.com',
  };
  await fsp.appendFile(feedbackInboxPath, `${JSON.stringify(entry)}\n`, 'utf8');
};

const appendActivityLogEntry = async (entry: Record<string, unknown>) => {
  await fsp.mkdir(path.dirname(activityLogPath), { recursive: true });
  const sanitized = {
    ...entry,
    timestamp: String(entry.timestamp || new Date().toISOString()),
  };
  let lines: string[] = [];
  try {
    const raw = await fsp.readFile(activityLogPath, 'utf8');
    lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(sanitized));
  if (lines.length > MAX_ACTIVITY_LOG_ENTRIES) {
    lines = lines.slice(-MAX_ACTIVITY_LOG_ENTRIES);
  }
  await fsp.writeFile(activityLogPath, `${lines.join('\n')}\n`, 'utf8');
};

const readRecentActivityLogs = async (limit = 20) => {
  try {
    const raw = await fsp.readFile(activityLogPath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const submitFeedbackToGoogleForm = async (config: FeedbackFormConfig, payload: FeedbackPayload) => {
  const body = new URLSearchParams();
  body.set(config.nameEntryId, payload.name);
  const enrichedSuggestions = [
    payload.suggestions,
    payload.category && payload.category !== 'Suggestion' ? `Category: ${payload.category}` : '',
    payload.lastError ? `Last error: ${payload.lastError}` : '',
    payload.websiteUrl ? `Website URL: ${payload.websiteUrl}` : '',
    payload.videoUrl ? `Video URL: ${payload.videoUrl}` : '',
    payload.fontName ? `Font: ${payload.fontName}` : '',
    payload.screenshotUrl ? `Screenshot: ${payload.screenshotUrl}` : '',
    `OS: ${payload.osLabel}`,
    `Platform: ${payload.platform} · ${payload.architecture}`,
    `Submitted: ${payload.submittedAt}`,
  ]
    .filter(Boolean)
    .join('\n');
  body.set(config.suggestionsEntryId, enrichedSuggestions);
  if (config.appVersionEntryId) body.set(config.appVersionEntryId, payload.appVersion);
  if (config.platformEntryId) {
    body.set(config.platformEntryId, `${payload.platform} · ${payload.architecture}`);
  }
  await axios.post(config.actionUrl, body.toString(), {
    timeout: 12000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  });
};

const probeFeedbackSheetWebhook = async (webhookUrl: string) => {
  try {
    const response = await axios.get(webhookUrl, {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const data = response.data;
    if (!data || typeof data !== 'object') {
      return { ok: false, version: 0, columns: 0, service: '' };
    }
    return {
      ok: Boolean((data as { ok?: boolean }).ok),
      version: Number((data as { version?: number }).version) || 0,
      columns: Number((data as { columns?: number }).columns) || 0,
      service: String((data as { service?: string }).service || ''),
    };
  } catch {
    return { ok: false, version: 0, columns: 0, service: '' };
  }
};

const resolveFeedbackScreenshotPath = (screenshotUrl: string) => {
  const raw = String(screenshotUrl || '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  return path.resolve(raw);
};

const attachScreenshotToSheetPayload = async (
  sheetPayload: Record<string, unknown>,
  screenshotUrl: string,
  screenshotDataUrl = ''
) => {
  const dataUrl = String(screenshotDataUrl || '').trim();
  if (dataUrl) {
    const compressed = await compressScreenshotDataUrlForSheet(dataUrl);
    if (compressed) {
      Object.assign(sheetPayload, compressed);
      return;
    }
  }
  const attachment = await readScreenshotAttachmentForWebhook(screenshotUrl);
  if (attachment) Object.assign(sheetPayload, attachment);
};

const readScreenshotAttachmentForWebhook = async (screenshotUrl: string) => {
  const filePath = resolveFeedbackScreenshotPath(screenshotUrl);
  if (!filePath) return null;
  try {
    const buffer = await fsp.readFile(filePath);
    if (!buffer.length) return null;
    return await compressScreenshotBufferForSheet(buffer);
  } catch {
    return null;
  }
};

const persistFeedbackConfigPatch = async (patch: Record<string, unknown>) => {
  const existing = (await readFeedbackConfigJson()) || {};
  await fsp.mkdir(path.dirname(feedbackConfigPath), { recursive: true });
  await fsp.writeFile(
    feedbackConfigPath,
    `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`,
    'utf8'
  );
};

const submitFeedbackToGoogleSheet = async (
  config: FeedbackSheetConfig,
  payload: FeedbackPayload,
  screenshotDataUrl = ''
) => {
  const sheetPayload: Record<string, unknown> = { ...payload };
  await attachScreenshotToSheetPayload(sheetPayload, payload.screenshotUrl, screenshotDataUrl);
  const response = await axios.post(config.webhookUrl, sheetPayload, {
    timeout: 45000,
    headers: { 'Content-Type': 'application/json' },
    maxRedirects: 5,
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const data = response.data;
  if (data && typeof data === 'object' && data.ok === false) {
    throw new Error(String(data.error || 'Google Sheet feedback webhook rejected the submission.'));
  }
  const webhookVersion = Number((data as { version?: number })?.version) || 0;
  if (webhookVersion > 0) {
    await persistFeedbackConfigPatch({
      sheetWebhookVersion: webhookVersion,
      sheetWebhookVersionCheckedAt: new Date().toISOString(),
    });
  }
};

const submitFeedbackRemote = async (
  target: FeedbackRemoteTarget,
  payload: FeedbackPayload,
  options: { screenshotDataUrl?: string } = {}
) => {
  if (target.mode === 'sheet') {
    await submitFeedbackToGoogleSheet(target.config, payload, options.screenshotDataUrl);
    return 'sheet' as const;
  }
  await submitFeedbackToGoogleForm(target.config, payload);
  return 'google-form' as const;
};

app.set('trust proxy', 1);
app.disable('x-powered-by');

const isPrivateAssetHost = (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/^www\./, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIP(host)) {
    if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^fc|^fd|^fe80:/i.test(host)) return true;
  }
  return false;
};

const assertPublicAssetUrl = (rawUrl: string) => {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) asset URLs are allowed.');
  }
  if (isPrivateAssetHost(parsed.hostname)) {
    throw new Error('Private or local asset URLs are blocked.');
  }
};

const normalizeLocalHost = (value = '') =>
  (() => {
    const raw = String(value).trim().toLowerCase();
    if (raw.startsWith('[')) {
      const end = raw.indexOf(']');
      return end > 0 ? raw.slice(1, end) : raw.replace(/^\[/, '');
    }
    return raw.split(':')[0];
  })();

const isLoopbackHost = (value = '') => {
  const host = normalizeLocalHost(value);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

const normalizeRemoteAddress = (value = '') =>
  String(value)
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');

const isLoopbackRemote = (value = '') => {
  const normalized = normalizeRemoteAddress(value);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
};

const isSameAppOrigin = (req: express.Request, rawOrigin = '') => {
  if (!rawOrigin) return true;
  try {
    const origin = new URL(rawOrigin);
    const requestHost = req.get('host') || `localhost:${activePort || DEFAULT_PORT}`;
    return origin.protocol === `${req.protocol}:` && origin.host === requestHost && isLoopbackHost(origin.hostname);
  } catch {
    return false;
  }
};

const localOnlyGuard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const remoteAddress = req.socket.remoteAddress || req.ip || '';
  if (!isLoopbackRemote(remoteAddress)) {
    return res.status(403).json({ error: 'This local app only accepts requests from this computer.' });
  }

  if (!isLoopbackHost(req.hostname)) {
    return res.status(403).json({ error: 'This local app is locked to localhost.' });
  }

  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'Cross-site access is blocked.' });
  }

  const origin = req.get('origin') || '';
  if (origin && !isSameAppOrigin(req, origin)) {
    return res.status(403).json({ error: 'Only the local app can access this data.' });
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
};

const privateStaticOptions: Parameters<typeof express.static>[1] = {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
};

const formatDisplayName = (raw: string) => {
  const cleaned = String(raw || '').trim().replace(/[._-]+/g, ' ');
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const extractUsernameFromPath = (value: string) => {
  const match = String(value || '').match(/(?:\/Users\/|\/home\/|C:\\Users\\)([^/\\]+)/i);
  return match?.[1] || '';
};

const getSuggestedDisplayName = () => {
  const osUsername = (() => {
    try {
      return String(os.userInfo().username || '').trim();
    } catch {
      return '';
    }
  })();
  const homeFolder = extractUsernameFromPath(os.homedir());
  const downloadsFolder = extractUsernameFromPath(downloadsDir);
  return formatDisplayName(downloadsFolder || homeFolder || osUsername);
};

const getCurrentUserName = () => {
  return getSuggestedDisplayName() || 'user';
};

const getMacOsFriendlyName = (darwinMajor: number) => {
  const names: Record<number, string> = {
    24: 'Sequoia',
    23: 'Sonoma',
    22: 'Ventura',
    21: 'Monterey',
    20: 'Big Sur',
  };
  return names[darwinMajor] || '';
};

const getFeedbackPlatformMeta = () => {
  const platformRaw = process.platform;
  const archRaw = process.arch;
  const platform =
    platformRaw === 'darwin' ? 'macOS' :
    platformRaw === 'win32' ? 'Windows' :
    platformRaw === 'linux' ? 'Linux' : platformRaw;

  let osLabel = platform;
  if (platformRaw === 'darwin') {
    const darwinMajor = Number(String(os.release() || '').split('.')[0] || 0);
    const friendly = getMacOsFriendlyName(darwinMajor);
    osLabel = friendly ? `macOS ${friendly}` : `macOS ${os.release()}`;
  } else if (platformRaw === 'win32') {
    osLabel = `Windows ${os.release()}`;
  } else if (platformRaw === 'linux') {
    osLabel = `Linux ${os.release()}`;
  }

  const architecture =
    archRaw === 'arm64' ? 'Apple Silicon' :
    archRaw === 'x64' ? 'Intel/AMD64' :
    archRaw;

  return { platform, architecture, osLabel, platformRaw, archRaw };
};

const toSafeUserFilePart = (value: string) =>
  String(value || 'user').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'user';

const toLocalVideoDownloadUrl = (req: express.Request, filename: string, sourcePageUrl?: string) => {
  const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
  const relative = path.relative(downloadsDir, path.join(targetDir, filename));
  return toAbsoluteAppUrl(req, `/api/download-local-video?filename=${encodeURIComponent(relative)}`);
};

const fileExists = async (filePath: string) => {
  if (!filePath) return false;
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (req.path.startsWith('/api/') || req.path.startsWith('/converted-') || req.path.startsWith('/generated-thumbnails') || req.path.startsWith('/cached-')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
  next();
});

app.use('/api', localOnlyGuard);
app.use(express.json({ limit: '15mb' }));
app.use('/converted-videos', localOnlyGuard, express.static(convertedVideoDir, privateStaticOptions));
app.use('/converted-audio', localOnlyGuard, express.static(convertedAudioDir, privateStaticOptions));
app.use('/generated-thumbnails', localOnlyGuard, express.static(generatedThumbnailDir, privateStaticOptions));
app.use('/generated-image-thumbs', localOnlyGuard, express.static(generatedImageThumbDir, privateStaticOptions));
app.use('/cached-images', localOnlyGuard, express.static(cachedImageDir, privateStaticOptions));
app.use('/cached-fonts', localOnlyGuard, express.static(cachedFontDir, privateStaticOptions));
app.use('/cached-images-original', localOnlyGuard, express.static(cachedImageOriginalDir, privateStaticOptions));
app.use('/cached-fonts-original', localOnlyGuard, express.static(cachedFontOriginalDir, privateStaticOptions));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 400, // higher ceiling for local iterative use
  skip: (req) => {
    const ip = String(req.ip || '');
    return ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
  },
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});
app.use('/api/', limiter);

type BookmarkCategory = 'website' | 'video';
type BookmarkFolderRecord = {
  id: string;
  title: string;
  parentId?: string | null;
  createdAt: string;
  sortIndex: number;
};
type BookmarkRecord = {
  id: string;
  title: string;
  url: string;
  normalizedUrl: string;
  category: BookmarkCategory;
  folderId?: string | null;
  createdAt: string;
  lastUsed?: string | null;
  notes?: string;
  tags: string[];
  favorite: boolean;
  faviconUrl?: string;
  extraction?: {
    imageCount?: number;
    videoCount?: number;
    fontCount?: number;
    colorCount?: number;
    extractionDate?: string;
    outputFolder?: string;
  };
  sortIndex: number;
};
type RecentRecord = {
  id: string;
  title: string;
  url: string;
  normalizedUrl: string;
  category: BookmarkCategory;
  lastUsed: string;
  faviconUrl?: string;
};
type BookmarkStoreFile = {
  version: number;
  bookmarks: BookmarkRecord[];
  folders: BookmarkFolderRecord[];
  history: RecentRecord[];
  updatedAt: string;
  lastBackupDate?: string;
};

const nowIso = () => new Date().toISOString();
const bookmarkId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

const normalizeBookmarkUrlServer = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    parsed.hash = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString().replace(/\/$/g, '');
  } catch {
    return raw.replace(/\/+$/g, '');
  }
};

const titleFromBookmarkUrl = (value: string) => {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return String(value || '').trim() || 'Untitled';
  }
};

const faviconForUrl = (value: string) => {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(parsed.origin)}&sz=64`;
  } catch {
    return '';
  }
};

const emptyBookmarkStore = (): BookmarkStoreFile => ({
  version: 1,
  bookmarks: [],
  folders: [],
  history: [],
  updatedAt: nowIso(),
});

const readBookmarkStore = async (): Promise<BookmarkStoreFile> => {
  try {
    const raw = await fsp.readFile(bookmarksPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...emptyBookmarkStore(),
      ...parsed,
      bookmarks: Array.isArray(parsed?.bookmarks) ? parsed.bookmarks : [],
      folders: Array.isArray(parsed?.folders) ? parsed.folders : [],
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    };
  } catch {
    return emptyBookmarkStore();
  }
};

const rotateBookmarkBackups = async () => {
  await fsp.mkdir(bookmarkBackupsDir, { recursive: true });
  const backups = (await fsp.readdir(bookmarkBackupsDir).catch(() => []))
    .filter((name) => /^bookmarks-\d{4}-\d{2}-\d{2}\.json$/i.test(name))
    .sort()
    .reverse();
  await Promise.all(backups.slice(10).map((name) => fsp.rm(path.join(bookmarkBackupsDir, name), { force: true }).catch(() => undefined)));
};

const writeBookmarkStore = async (store: BookmarkStoreFile) => {
  await fsp.mkdir(bookmarksDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const previous = await readBookmarkStore();
  if (previous.bookmarks.length || previous.history.length || previous.folders.length) {
    const backupPath = path.join(bookmarkBackupsDir, `bookmarks-${today}.json`);
    if (previous.lastBackupDate !== today && !fs.existsSync(backupPath)) {
      await fsp.mkdir(bookmarkBackupsDir, { recursive: true });
      await fsp.writeFile(backupPath, JSON.stringify(previous, null, 2));
      await rotateBookmarkBackups();
    }
  }
  const normalized: BookmarkStoreFile = {
    ...emptyBookmarkStore(),
    ...store,
    lastBackupDate: today,
    updatedAt: nowIso(),
  };
  await fsp.writeFile(bookmarksPath, JSON.stringify(normalized, null, 2));
  return normalized;
};

const normalizeBookmarkRecord = (payload: any, existing?: BookmarkRecord): BookmarkRecord => {
  const url = String(payload?.url ?? existing?.url ?? '').trim();
  const normalizedUrl = normalizeBookmarkUrlServer(url);
  if (!normalizedUrl) throw new Error('Bookmark URL is required.');
  const category = String(payload?.category ?? existing?.category ?? 'website') === 'video' ? 'video' : 'website';
  const title = String(payload?.title ?? existing?.title ?? titleFromBookmarkUrl(url)).trim() || titleFromBookmarkUrl(url);
  const tags = Array.isArray(payload?.tags)
    ? payload.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
    : Array.isArray(existing?.tags)
      ? existing.tags
      : [];
  return {
    id: existing?.id || bookmarkId(),
    title,
    url,
    normalizedUrl,
    category,
    folderId: payload?.folderId ?? existing?.folderId ?? null,
    createdAt: existing?.createdAt || nowIso(),
    lastUsed: payload?.lastUsed ?? existing?.lastUsed ?? null,
    notes: String(payload?.notes ?? existing?.notes ?? ''),
    tags,
    favorite: Boolean(payload?.favorite ?? existing?.favorite ?? false),
    faviconUrl: String(payload?.faviconUrl ?? existing?.faviconUrl ?? faviconForUrl(url)),
    extraction: payload?.extraction ?? existing?.extraction,
    sortIndex: Number.isFinite(Number(payload?.sortIndex ?? existing?.sortIndex))
      ? Number(payload?.sortIndex ?? existing?.sortIndex)
      : Date.now(),
  };
};

const buildChromeBookmarksHtml = (store: BookmarkStoreFile) => {
  const esc = (value: string) =>
    String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = store.bookmarks
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((bookmark) => {
      const addDate = Math.floor(Date.parse(bookmark.createdAt || nowIso()) / 1000);
      const lastVisit = bookmark.lastUsed ? Math.floor(Date.parse(bookmark.lastUsed) / 1000) : addDate;
      return `        <DT><A HREF="${esc(bookmark.url)}" ADD_DATE="${addDate}" LAST_VISIT="${lastVisit}" TAGS="${esc((bookmark.tags || []).join(','))}">${esc(bookmark.title)}</A>`;
    })
    .join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${Math.floor(Date.now() / 1000)}">Creative Asset Extractor</H3>
    <DL><p>
${rows}
    </DL><p>
</DL><p>
`;
};

const parseChromeBookmarksHtml = (content: string): Partial<BookmarkRecord>[] => {
  const html = String(content || '');
  const results: Partial<BookmarkRecord>[] = [];
  const linkRegex = /<A\b([^>]*)>([\s\S]*?)<\/A>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html))) {
    const attrs = match[1] || '';
    const href = attrs.match(/\bHREF=["']([^"']+)["']/i)?.[1] || '';
    if (!href) continue;
    const title = (match[2] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    const tagsRaw = attrs.match(/\bTAGS=["']([^"']*)["']/i)?.[1] || '';
    results.push({
      url: href,
      title: title || titleFromBookmarkUrl(href),
      category: /(?:youtu\.be|youtube|vimeo|instagram|facebook|x\.com|tiktok|ispot|brightcove)/i.test(href) ? 'video' : 'website',
      tags: tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean),
    });
  }
  return results;
};

app.get('/api/bookmarks', async (_req, res) => {
  try {
    return res.json({ ok: true, store: await readBookmarkStore() });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to read bookmarks.' });
  }
});

app.post('/api/bookmarks', async (req, res) => {
  try {
    const store = await readBookmarkStore();
    const next = normalizeBookmarkRecord(req.body);
    const existingIndex = store.bookmarks.findIndex((bookmark) => bookmark.normalizedUrl === next.normalizedUrl && bookmark.category === next.category);
    if (existingIndex >= 0) {
      store.bookmarks[existingIndex] = normalizeBookmarkRecord({ ...store.bookmarks[existingIndex], ...req.body }, store.bookmarks[existingIndex]);
    } else {
      store.bookmarks.push(next);
    }
    const saved = await writeBookmarkStore(store);
    const bookmark = saved.bookmarks.find((item) => item.normalizedUrl === next.normalizedUrl && item.category === next.category) || next;
    return res.json({ ok: true, bookmark, store: saved });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to save bookmark.' });
  }
});

app.put('/api/bookmarks/:id', async (req, res) => {
  try {
    const store = await readBookmarkStore();
    const index = store.bookmarks.findIndex((bookmark) => bookmark.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Bookmark not found.' });
    store.bookmarks[index] = normalizeBookmarkRecord({ ...store.bookmarks[index], ...req.body }, store.bookmarks[index]);
    const saved = await writeBookmarkStore(store);
    return res.json({ ok: true, bookmark: saved.bookmarks[index], store: saved });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to update bookmark.' });
  }
});

app.delete('/api/bookmarks/:id', async (req, res, next) => {
  if (req.params.id === 'history') return next();
  const store = await readBookmarkStore();
  store.bookmarks = store.bookmarks.filter((bookmark) => bookmark.id !== req.params.id);
  return res.json({ ok: true, store: await writeBookmarkStore(store) });
});

app.post('/api/bookmarks/:id/duplicate', async (req, res) => {
  const store = await readBookmarkStore();
  const source = store.bookmarks.find((bookmark) => bookmark.id === req.params.id);
  if (!source) return res.status(404).json({ error: 'Bookmark not found.' });
  const copy = { ...source, id: bookmarkId(), title: `${source.title} copy`, createdAt: nowIso(), normalizedUrl: `${source.normalizedUrl}#copy-${Date.now()}`, sortIndex: Date.now() };
  store.bookmarks.push(copy);
  const saved = await writeBookmarkStore(store);
  return res.json({ ok: true, bookmark: copy, store: saved });
});

app.post('/api/bookmarks/:id/use', async (req, res) => {
  const store = await readBookmarkStore();
  const bookmark = store.bookmarks.find((item) => item.id === req.params.id);
  if (!bookmark) return res.status(404).json({ error: 'Bookmark not found.' });
  bookmark.lastUsed = nowIso();
  const recent: RecentRecord = {
    id: bookmarkId(),
    title: bookmark.title,
    url: bookmark.url,
    normalizedUrl: bookmark.normalizedUrl,
    category: bookmark.category,
    lastUsed: bookmark.lastUsed,
    faviconUrl: bookmark.faviconUrl,
  };
  store.history = [recent, ...store.history.filter((item) => !(item.normalizedUrl === recent.normalizedUrl && item.category === recent.category))].slice(0, 100);
  return res.json({ ok: true, store: await writeBookmarkStore(store) });
});

app.post('/api/bookmarks/history', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    const normalizedUrl = normalizeBookmarkUrlServer(url);
    if (!normalizedUrl) return res.status(400).json({ error: 'URL is required.' });
    const category = String(req.body?.category || 'website') === 'video' ? 'video' : 'website';
    const store = await readBookmarkStore();
    const title = String(req.body?.title || '').trim() || titleFromBookmarkUrl(url);
    const lastUsed = nowIso();
    const bookmark = store.bookmarks.find((item) => item.normalizedUrl === normalizedUrl && item.category === category);
    if (bookmark) bookmark.lastUsed = lastUsed;
    const recent: RecentRecord = {
      id: bookmarkId(),
      title,
      url,
      normalizedUrl,
      category,
      lastUsed,
      faviconUrl: bookmark?.faviconUrl || faviconForUrl(url),
    };
    store.history = [recent, ...store.history.filter((item) => !(item.normalizedUrl === normalizedUrl && item.category === category))].slice(0, 100);
    return res.json({ ok: true, store: await writeBookmarkStore(store) });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to save history.' });
  }
});

const deleteBookmarkHistoryEntries = async (payload: any) => {
  const { url, category = 'website', clearAll = false } = payload || {};
  const store = await readBookmarkStore();
  if (clearAll || !url) {
    store.history = store.history.filter((item) => item.category !== category);
  } else {
    const normalizedUrl = normalizeBookmarkUrlServer(url);
    if (!normalizedUrl) throw new Error('URL is required.');
    store.history = store.history.filter((item) => !(item.normalizedUrl === normalizedUrl && item.category === category));
  }
  return writeBookmarkStore(store);
};

app.post('/api/bookmarks/history/delete', async (req, res) => {
  try {
    const store = await deleteBookmarkHistoryEntries(req.body);
    return res.json({ ok: true, store });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to delete history.' });
  }
});

app.post('/api/bookmarks/history/clear', async (req, res) => {
  try {
    const store = await deleteBookmarkHistoryEntries({ ...req.body, clearAll: true });
    return res.json({ ok: true, store });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to clear history.' });
  }
});

app.delete('/api/bookmarks/history', async (req, res) => {
  try {
    const store = await deleteBookmarkHistoryEntries(req.body);
    return res.json({ ok: true, store });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to delete history.' });
  }
});

app.post('/api/bookmarks/import', async (req, res) => {
  try {
    const content = String(req.body?.content || '');
    const format = String(req.body?.format || 'json').toLowerCase();
    const store = await readBookmarkStore();
    const incoming = format === 'html'
      ? parseChromeBookmarksHtml(content)
      : (() => {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) return parsed;
          if (Array.isArray(parsed?.bookmarks)) return parsed.bookmarks;
          return [];
        })();
    for (const item of incoming) {
      const next = normalizeBookmarkRecord(item);
      if (!store.bookmarks.some((bookmark) => bookmark.normalizedUrl === next.normalizedUrl && bookmark.category === next.category)) {
        store.bookmarks.push(next);
      }
    }
    return res.json({ ok: true, store: await writeBookmarkStore(store) });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to import bookmarks.' });
  }
});

app.get('/api/bookmarks/export.json', async (_req, res) => {
  const store = await readBookmarkStore();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="creative-asset-extractor-bookmarks.json"');
  return res.send(JSON.stringify(store, null, 2));
});

app.get('/api/bookmarks/export.html', async (_req, res) => {
  const store = await readBookmarkStore();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="creative-asset-extractor-bookmarks.html"');
  return res.send(buildChromeBookmarksHtml(store));
});

const resolvePackageMeta = async () => {
  const candidates = [
    path.join(process.cwd(), 'package.json'),
    path.join(getAppRoot(), 'package.json'),
    ...(process.env.VDX_APP_ROOT ? [path.join(String(process.env.VDX_APP_ROOT), 'package.json')] : []),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, 'utf8');
      const pkg = JSON.parse(raw);
      return {
        version: String(pkg?.version || '1.0.0'),
        productName: String(pkg?.build?.productName || pkg?.name || 'Creative Asset Extractor'),
      };
    } catch {
      // try next candidate
    }
  }
  return { version: '1.0.0', productName: 'Creative Asset Extractor' };
};

app.get('/api/feedback/profile', async (_req, res) => {
  const pkg = await resolvePackageMeta();
  const platformMeta = getFeedbackPlatformMeta();
  res.json({
    suggestedName: getSuggestedDisplayName(),
    appVersion: pkg.version,
    productName: pkg.productName,
    ...platformMeta,
  });
});

app.get('/api/feedback/status', async (_req, res) => {
  const target = await resolveFeedbackTarget();
  const sheet = await resolveFeedbackSheetConfig();
  const googleForm = await resolveFeedbackFormConfig();
  const fromFile = await readFeedbackConfigJson();
  const cachedWebhookVersion = Number(fromFile?.sheetWebhookVersion) || 0;
  const webhookHealth = sheet?.webhookUrl
    ? await probeFeedbackSheetWebhook(sheet.webhookUrl)
    : null;
  const sheetWebhookVersion = Math.max(cachedWebhookVersion, webhookHealth?.version || 0);
  const sheetWebhookNeedsUpdate = Boolean(
    sheetWebhookVersion > 0 &&
    sheetWebhookVersion < EXPECTED_FEEDBACK_SHEET_WEBHOOK_VERSION
  );
  res.json({
    ready: true,
    mode: target?.mode || 'local',
    contactEmail: 'frontendtech01@gmail.com',
    googleSheetConfigured: Boolean(sheet),
    googleFormConfigured: Boolean(googleForm),
    sheetId: sheet?.sheetId || DEFAULT_FEEDBACK_SHEET_ID,
    sheetWebhookVersion,
    sheetWebhookColumns: webhookHealth?.columns || 0,
    sheetWebhookNeedsUpdate,
    expectedSheetWebhookVersion: EXPECTED_FEEDBACK_SHEET_WEBHOOK_VERSION,
    localInboxPath: feedbackInboxPath,
  });
});

app.post('/api/activity-log', async (req, res) => {
  try {
    const kind = String(req.body?.kind || 'activity').trim();
    const entry = {
      kind,
      message: String(req.body?.message || '').trim(),
      url: String(req.body?.url || '').trim(),
      platform: String(req.body?.platform || '').trim(),
      extractionType: String(req.body?.extractionType || '').trim(),
      assetType: String(req.body?.assetType || '').trim(),
      outputPath: String(req.body?.outputPath || '').trim(),
      error: String(req.body?.error || '').trim(),
      stack: String(req.body?.stack || '').trim(),
      meta: req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : undefined,
      timestamp: String(req.body?.timestamp || new Date().toISOString()),
    };
    await appendActivityLogEntry(entry);
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'Activity log failed.' });
  }
});

const isLocalAppUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
};

const readChromeClientTab = async (preferredUrl = '') => {
  if (process.platform !== 'darwin') {
    throw new Error('Chrome tab detection is currently available on macOS only.');
  }
  const scriptLines = [
    'tell application "Google Chrome"',
    'if it is not running then return ""',
    'if (count of windows) = 0 then return ""',
    'set fieldSep to "|||VDX_TAB|||"',
    'set tabRows to ""',
    'repeat with windowIndex from 1 to count of windows',
    'set activeTabIndex to active tab index of window windowIndex',
    'repeat with tabIndex from 1 to count of tabs of window windowIndex',
    'set tabUrl to URL of tab tabIndex of window windowIndex',
    'set tabTitle to title of tab tabIndex of window windowIndex',
    'set tabRows to tabRows & windowIndex & fieldSep & tabIndex & fieldSep & activeTabIndex & fieldSep & tabUrl & fieldSep & tabTitle & linefeed',
    'end repeat',
    'end repeat',
    'return tabRows',
    'end tell',
  ];
  const { stdout } = await execFileAsync(
    'osascript',
    scriptLines.flatMap((line) => ['-e', line]),
    { timeout: 8000, maxBuffer: 1024 * 1024 }
  );
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const tabs = lines
    .map((line) => {
      const [windowValue = '', indexValue = '', activeIndexValue = '', url = '', ...titleParts] = line.split('|||VDX_TAB|||');
      return {
        windowIndex: Number(windowValue),
        index: Number(indexValue),
        activeIndex: Number(activeIndexValue),
        url: url.trim(),
        title: titleParts.join('\t').trim(),
      };
    })
    .filter((tab) => Number.isFinite(tab.windowIndex) && Number.isFinite(tab.index) && /^https?:\/\//i.test(tab.url));

  if (!tabs.length) throw new Error('Chrome is open, but no website tabs were available.');

  const frontTabs = tabs.filter((tab) => tab.windowIndex === 1);
  const frontActive = frontTabs.find((tab) => tab.index === tab.activeIndex);
  const candidates = tabs
    .filter((tab) => !isLocalAppUrl(tab.url))
    .sort((a, b) => {
      const windowDistance = a.windowIndex - b.windowIndex;
      if (windowDistance !== 0) return windowDistance;
      const activeDistance = Math.abs(a.index - a.activeIndex) - Math.abs(b.index - b.activeIndex);
      if (activeDistance !== 0) return activeDistance;
      return a.index - b.index;
    });
  const preferredOrigin = (() => {
    try {
      return preferredUrl ? new URL(preferredUrl).origin : '';
    } catch {
      return '';
    }
  })();
  const preferredTab = preferredOrigin
    ? candidates.find((tab) => {
        try {
          return new URL(tab.url).origin === preferredOrigin;
        } catch {
          return false;
        }
      })
    : undefined;
  const selected = preferredTab || (frontActive && !isLocalAppUrl(frontActive.url) ? frontActive : candidates[0]);

  if (!selected?.url) {
    throw new Error('Only local app tabs were found in Chrome. Open the client website in Chrome beside the localhost app tab.');
  }
  return {
    url: new URL(selected.url).href,
    title: selected.title,
    browser: 'Google Chrome',
    source: frontActive?.url && isLocalAppUrl(frontActive.url) ? 'nearest-client-tab' : 'active-tab',
    windowIndex: selected.windowIndex,
    tabIndex: selected.index,
  };
};

const buildChromeTabAssetCaptureScript = () => `
(() => {
  const absoluteUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw || raw === 'none' || raw.startsWith('blob:')) return '';
    if (raw.startsWith('data:image/')) return raw;
    try { return new URL(raw, location.href).href; } catch { return /^https?:\\/\\//i.test(raw) ? raw : ''; }
  };
  const filenameFromUrl = (value, fallback) => {
    try {
      const parsed = new URL(value);
      return parsed.pathname.split('/').filter(Boolean).pop() || fallback;
    } catch {
      return fallback;
    }
  };
  const typeFromUrl = (value, mime) => {
    const contentType = String(mime || '').toLowerCase();
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('svg')) return 'svg';
    const dataMatch = String(value || '').match(/^data:image\\/([a-z0-9.+-]+)/i);
    if (dataMatch?.[1]) return dataMatch[1].toLowerCase().replace('svg+xml', 'svg').replace('jpeg', 'jpg');
    const match = String(value || '').match(/\\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    return (match?.[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
  };
  const imageMap = new Map();
  const isJpeg2000Variant = (value) => {
    const raw = String(value || '').replace(/&amp;/g, '&');
    if (/\\.(?:jp2|j2k|jpf|jpx)(?:$|[?#])/i.test(raw)) return true;
    try {
      const parsed = new URL(raw);
      const fmt = String(parsed.searchParams.get('fmt') || parsed.searchParams.get('format') || parsed.searchParams.get('fm') || '').toLowerCase();
      return /^(?:jp2|j2k|jpf|jpx|jpeg2000|jpeg2000-alpha)$/.test(fmt);
    } catch {
      return /[?&](?:fmt|format|fm)=(?:jp2|j2k|jpf|jpx|jpeg2000|jpeg2000-alpha)(?:&|$)/i.test(raw);
    }
  };
  const isLikelyImageCandidate = (value) => {
    const raw = String(value || '').replace(/&amp;/g, '&').trim();
    if (!raw || /%7b|%7d|[{}]/i.test(raw)) return false;
    if (/^data:image\\//i.test(raw)) return true;
    if (/\\.(?:css|js|json|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|mkv|m3u8|mpd|html?)(?:[?#]|$)/i.test(raw)) return false;
    try {
      const parsed = new URL(raw);
      const path = parsed.pathname.replace(/\\/{2,}/g, '/');
      const hasImageExt = /\\.(?:svg|png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(parsed.href);
      const hasImageFormat = /[?&](?:fmt|format|fm|output)=(?:svg|png|jpe?g|webp|gif|avif|png-alpha|webp-alpha)/i.test(parsed.search);
      const isImageService = /\\/is\\/image\\/|\\/image\\/|\\/images?\\/|\\/img\\/|\\/media\\/|\\/assets?\\/|\\/content\\/dam\\/|\\/\\.imaging\\//i.test(path);
      if (!hasImageExt && !hasImageFormat && !isImageService) return false;
      if (!hasImageExt && /\\/\\d{1,3}(?:&|$)/.test(path)) return false;
      return true;
    } catch {
      return false;
    }
  };
  const sequenceImageKey = (value) => {
    try {
      const parsed = new URL(String(value || '').replace(/&amp;/g, '&'));
      const path = parsed.pathname
        .replace(/^\\/content\\/dam\\/toyota\\/(?=jellies\\/)/i, '/')
        .replace(/^\\/is\\/image\\/toyota\\/toyota\\/(?=jellies\\/)/i, '/')
        .replace(/\\/{2,}/g, '/');
      if (/\\/\\d{1,3}\\/\\d{1,3}\\.(?:png|jpe?g|webp|avif)$/i.test(path)) return 'sequence:' + path.toLowerCase();
      if (/(?:lexus|assetscs|visualizer|threesixty|360)/i.test(parsed.href) && /[-_]\\d{1,3}\\.(?:png|jpe?g|webp|avif)$/i.test(path)) {
        return 'sequence:' + path.toLowerCase();
      }
    } catch {
      // Ignore malformed values.
    }
    return '';
  };
  const imageVariantScore = (value) => {
    try {
      const parsed = new URL(String(value || '').replace(/&amp;/g, '&'));
      const width = Number(parsed.searchParams.get('wid') || parsed.searchParams.get('width') || parsed.searchParams.get('w') || 0);
      const height = Number(parsed.searchParams.get('hei') || parsed.searchParams.get('height') || parsed.searchParams.get('h') || 0);
      const quality = Number(parsed.searchParams.get('qlt') || parsed.searchParams.get('quality') || parsed.searchParams.get('q') || 0);
      const fmt = String(parsed.searchParams.get('fmt') || parsed.searchParams.get('format') || '').toLowerCase();
      const formatPenalty = /jp2|j2k|jpf|jpx|jpeg2000/.test(fmt) || /\\.(?:jp2|j2k|jpf|jpx)(?:$|[?#])/i.test(parsed.href)
        ? -100000
        : 0;
      return width + height + quality + (/png|jpe?g/.test(fmt) ? 50 : /webp|avif/.test(fmt) ? 25 : 0) + formatPenalty;
    } catch {
      return 0;
    }
  };
  const addImage = (value, meta = {}) => {
    const target = absoluteUrl(value);
    if (!target) return;
    if (isJpeg2000Variant(target)) return;
    if (!isLikelyImageCandidate(target)) return;
    const key = sequenceImageKey(target) || target;
    const existing = imageMap.get(key);
    if (existing && imageVariantScore(existing.url) >= imageVariantScore(target)) return;
    imageMap.set(key, {
      url: target,
      filename: String(meta.filename || '').trim() || filenameFromUrl(target, 'preview-image.png'),
      width: Number(meta.width || 0) || undefined,
      height: Number(meta.height || 0) || undefined,
      alt: String(meta.alt || '').trim(),
      type: typeFromUrl(target),
      source: String(meta.source || '').trim() || undefined,
      dataUrl: String(meta.dataUrl || '').trim() || undefined,
      isInlineSvg: Boolean(meta.isInlineSvg),
      assetCategory: meta.assetCategory,
    });
  };
  const addSrcset = (value) => {
    String(value || '').split(',').forEach((part) => addImage(part.trim().split(/\\s+/)[0]));
  };
  const dataUrlFromImage = (img) => {
    try {
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) return '';
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(img.naturalWidth, 2400);
      canvas.height = Math.max(1, Math.round(img.naturalHeight * (canvas.width / img.naturalWidth)));
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png', 0.92);
    } catch {
      return '';
    }
  };
  const decodeCssContent = (value) => {
    let text = String(value || '').trim();
    if (!text || text === 'none' || text === 'normal') return '';
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1);
    }
    text = text.replace(/\\\\([0-9a-fA-F]{1,6})\\s?/g, (_match, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    });
    text = text.replace(/\\\\(["'\\\\])/g, '$1');
    return text;
  };
  const fontAwesomeNameFromElement = (el, index) => {
    const classText = String(el.getAttribute('class') || '');
    const namedClass = (classText.match(/\\bfa-[a-z0-9-]+\\b/gi) || [])
      .map((name) => name.replace(/^fa-/i, ''))
      .find((name) => !/^(?:solid|regular|brands|light|duotone|thin|sharp|classic|fw|lg|xs|sm|[1-9]x|10x|spin|pulse|border|pull-left|pull-right|inverse|rotate-90|rotate-180|rotate-270|flip-horizontal|flip-vertical|stack|stack-1x|stack-2x)$/.test(name));
    const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
    const raw = namedClass || label || el.id || ('font-awesome-icon-' + (index + 1));
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('font-awesome-icon-' + (index + 1));
  };
  const resolveFontAwesomeGlyph = (el, style, baseStyle, initialGlyph) => {
    const candidates = [
      initialGlyph,
      style.getPropertyValue('--fa'),
      baseStyle.getPropertyValue('--fa'),
      style.getPropertyValue('--fa-primary'),
      baseStyle.getPropertyValue('--fa-primary'),
      style.content,
    ];
    for (const candidate of candidates) {
      const glyph = decodeCssContent(candidate);
      if (glyph && !/^var\\(/i.test(glyph) && glyph !== 'none' && glyph !== 'normal') return glyph;
    }
    return '';
  };
  const fontIconSvgDataUrl = (glyph, family, fontPx, color, size) => {
    try {
      const escapeXml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const svgText =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ' +
        'font-family="' + escapeXml(family || 'Font Awesome 6 Free, Font Awesome 5 Free, sans-serif') + '" ' +
        'font-size="' + Math.round(fontPx) + '" fill="' + escapeXml(color || '#000') + '">' +
        escapeXml(glyph) +
        '</text></svg>';
      const bytes = new TextEncoder().encode(svgText);
      let binary = '';
      const chunkSize = 8192;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.slice(offset, offset + chunkSize)));
      }
      return 'data:image/svg+xml;base64,' + btoa(binary);
    } catch {
      return '';
    }
  };
  const renderFontIconToPng = (el, pseudo, glyph, index) => {
    try {
      const style = getComputedStyle(el, pseudo || null);
      const baseStyle = getComputedStyle(el);
      const parentStyle = el.parentElement ? getComputedStyle(el.parentElement) : baseStyle;
      const family = String(style.fontFamily || baseStyle.fontFamily || parentStyle.fontFamily || '');
      const classText = String(el.getAttribute('class') || '');
      const looksLikeFontAwesome =
        /font awesome|fontawesome/i.test(family) ||
        /(?:^|\\s)(?:fa|fas|far|fab|fal|fad|fa-[a-z0-9-]+)/i.test(classText);
      const resolvedGlyph = resolveFontAwesomeGlyph(el, style, baseStyle, glyph);
      if (!looksLikeFontAwesome || !resolvedGlyph || resolvedGlyph.length > 4) return;
      const rect = el.getBoundingClientRect();
      const fontPx = Math.max(14, Number.parseFloat(style.fontSize || baseStyle.fontSize || parentStyle.fontSize || '') || rect.height || 24);
      const cssSize = Math.min(256, Math.max(64, Math.ceil(Math.max(rect.width || 0, rect.height || 0, fontPx) + 24)));
      const safeName = fontAwesomeNameFromElement(el, index);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = cssSize * scale;
      canvas.height = cssSize * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.clearRect(0, 0, cssSize, cssSize);
      ctx.fillStyle = style.color || baseStyle.color || '#000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = [
        style.fontStyle || baseStyle.fontStyle || 'normal',
        style.fontWeight || baseStyle.fontWeight || '400',
        fontPx + 'px',
        family || 'Font Awesome 6 Free, Font Awesome 5 Free, sans-serif',
      ].join(' ');
      ctx.fillText(resolvedGlyph, cssSize / 2, cssSize / 2);
      const pngDataUrl = canvas.toDataURL('image/png');
      addImage(pngDataUrl, {
        filename: safeName + '.png',
        width: cssSize,
        height: cssSize,
        alt: safeName.replace(/-/g, ' '),
        source: 'font-awesome-icon',
        dataUrl: pngDataUrl,
        assetCategory: 'icon',
        fontGlyph: resolvedGlyph,
        fontFamily: family,
        fontSize: fontPx,
        fill: style.color || baseStyle.color || '#000',
      });
      const svgDataUrl = fontIconSvgDataUrl(resolvedGlyph, family, fontPx, style.color || baseStyle.color || '#000', cssSize);
      if (svgDataUrl) {
        addImage(svgDataUrl, {
          filename: safeName + '.svg',
          width: cssSize,
          height: cssSize,
          alt: safeName.replace(/-/g, ' '),
          source: 'font-awesome-icon-svg',
          dataUrl: svgDataUrl,
          isInlineSvg: true,
          assetCategory: 'icon',
          fontGlyph: resolvedGlyph,
          fontFamily: family,
          fontSize: fontPx,
          fill: style.color || baseStyle.color || '#000',
        });
      }
    } catch {
      // Ignore icons that cannot be rendered to canvas.
    }
  };
  const collectFontAwesomeIcons = () => {
    const selector = [
      '[class~="fa"]',
      '[class~="fas"]',
      '[class~="far"]',
      '[class~="fab"]',
      '[class~="fal"]',
      '[class~="fad"]',
      '[class*=" fa-"]',
      '[class^="fa-"]',
    ].join(',');
    Array.from(document.querySelectorAll(selector)).slice(0, 500).forEach((el, index) => {
      const before = decodeCssContent(getComputedStyle(el, '::before').content);
      const after = decodeCssContent(getComputedStyle(el, '::after').content);
      const own = decodeCssContent(el.textContent);
      renderFontIconToPng(el, '::before', before, index);
      renderFontIconToPng(el, '::after', after, index);
      renderFontIconToPng(el, null, own, index);
    });
  };
  const readCssUrls = (value) => {
    const urls = [];
    String(value || '').replace(/url\\((['"]?)(.*?)\\1\\)/gi, (_match, _quote, inner) => {
      const target = absoluteUrl(inner);
      if (target) urls.push(target);
      return '';
    });
    return urls;
  };
  const expand360Sequence = (raw, countHint) => {
    const target = absoluteUrl(raw);
    if (!target) return [];
    let parsed;
    try { parsed = new URL(target); } catch { return []; }
    if (!/(?:threesixty|360|jellies|vehicle|toyota|lexus|aemassets|assetscs|visualizer)/i.test(parsed.href)) return [];
    if (parsed.pathname.includes('//')) return [];
    const numericLeafMatch = parsed.pathname.match(/^(.*\\/)(\\d{1,3})(\\.(?:png|jpe?g|webp|avif))$/i);
    const prefixedLeafMatch = parsed.pathname.match(/^(.*[-_])(\\d{1,3})(\\.(?:png|jpe?g|webp|avif))$/i);
    const match = numericLeafMatch || prefixedLeafMatch;
    if (!match) return [];
    const frame = Number(match[2]);
    if (!Number.isFinite(frame) || frame < 1) return [];
    const parts = match[1].split('/').filter(Boolean);
    const pathCount = Number(parts[parts.length - 1] || 0);
    const hinted = Number(countHint || 0);
    const commonSequenceCounts = new Set([4, 18, 24, 36, 72, 120]);
    const hasExplicitFrameCountPath = Boolean(
      numericLeafMatch &&
        pathCount >= 2 &&
        pathCount <= 120 &&
        ((hinted >= 2 && hinted <= 120 && pathCount === hinted) || commonSequenceCounts.has(pathCount))
    );
    const hasPrefixedFrameName = Boolean(prefixedLeafMatch && /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(parsed.href));
    if (!hasExplicitFrameCountPath && !hasPrefixedFrameName) return [];
    const count = hasExplicitFrameCountPath ? pathCount : Number(countHint || 0);
    if (!count || count > 120 || frame > count) return [];
    return Array.from({ length: count }, (_, index) => {
      const clone = new URL(parsed.href);
      clone.pathname = match[1] + (index + 1) + match[3];
      return { url: clone.href, frame: index + 1, count };
    });
  };
  const collect360FromRoot = (root) => {
    const count = Number(root?.getAttribute?.('data-image-count') || root?.querySelector?.('[data-image-count]')?.getAttribute('data-image-count') || 0);
    const candidates = [];
    const nodes = root?.querySelectorAll?.('img, source, picture, [src], [srcset], [data-src], [data-srcset], [data-image], [data-lazy-src]') || [];
    nodes.forEach((node) => {
      ['currentSrc', 'src'].forEach((key) => {
        if (node[key]) candidates.push(node[key]);
      });
      ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-image', 'data-url'].forEach((attr) => {
        const value = node.getAttribute?.(attr);
        if (!value) return;
        String(value).split(',').forEach((part) => candidates.push(part.trim().split(/\\s+/)[0]));
      });
    });
    candidates.forEach((candidate) => {
      expand360Sequence(candidate, count).forEach((frame) => addImage(frame.url, {
        source: '360-sequence',
        alt: '360 frame ' + frame.frame,
        sequenceFrame: frame.frame,
        sequenceCount: frame.count,
      }));
    });
  };
  const collectToyotaColorizerSwatchSequences = (root) => {
    const countHint = Number(root?.getAttribute?.('data-image-count') || root?.querySelector?.('[data-image-count]')?.getAttribute('data-image-count') || 0);
    if (!countHint || countHint > 120) return;
    const activeSwatch = root.querySelector?.('.color-selector__swatch[data-active="true"][data-model-grade]');
    const activeGrade = String(activeSwatch?.getAttribute?.('data-model-grade') || '').trim().toLowerCase();
    const activeModel = String(activeSwatch?.getAttribute?.('data-model-code') || '').trim().toLowerCase();
    const activeYear = String(activeSwatch?.getAttribute?.('data-model-year') || '').trim();
    const activeColor = String(activeSwatch?.getAttribute?.('data-color-code') || '').trim().toLowerCase();
    const activeColorName = String(
      activeSwatch?.getAttribute?.('data-color-name') ||
      activeSwatch?.getAttribute?.('aria-label') ||
      activeColor
    ).trim();
    const mediaUrls = [];
    root.querySelectorAll?.('.threesixty-media img, .threesixty-media source, .threesixty-media [src], .threesixty-media [srcset]').forEach((node) => {
      ['currentSrc', 'src'].forEach((key) => {
        if (node[key]) mediaUrls.push(node[key]);
      });
      ['src', 'srcset', 'data-src', 'data-srcset'].forEach((attr) => {
        const value = node.getAttribute?.(attr);
        if (!value) return;
        String(value).split(',').forEach((part) => mediaUrls.push(part.trim().split(/\\s+/)[0]));
      });
    });
    const template = mediaUrls
      .map((raw) => absoluteUrl(raw))
      .filter(Boolean)
      .map((raw) => {
        try {
          const parsed = new URL(raw.replace(/&amp;/g, '&'));
          const match = parsed.pathname.replace(/\\/{2,}/g, '/').match(/^(.*\\/jellies\\/max\\/(\\d{4})\\/([^/]+)\\/)(?:(?!\\d+\\/)[^/]+\\/)?(\\d+)\\/([^/]+)\\/(\\d+)\\/(\\d+)(\\.(?:png|jpe?g|webp|avif))$/i);
          if (!match) return null;
          return {
            href: parsed.href,
            prefix: match[1],
            year: match[2],
            model: match[3],
            style: match[4],
            count: Number(match[6]),
            suffix: match[8],
          };
        } catch {
          return null;
        }
      })
      .find((item) => item && item.count >= 2 && item.count <= 120 && (!activeYear || item.year === activeYear) && (!activeModel || item.model.toLowerCase() === activeModel));
    if (!template || !activeGrade || !activeColor) return;
    for (let frame = 1; frame <= template.count; frame += 1) {
      try {
        const clone = new URL(template.href);
        clone.pathname =
          template.prefix +
          activeGrade +
          '/' +
          template.style +
          '/' +
          activeColor +
          '/' +
          template.count +
          '/' +
          frame +
          template.suffix;
        addImage(clone.href, {
          source: '360-sequence',
          alt: activeColorName + ' 360 frame ' + frame,
          sequenceFrame: frame,
          sequenceCount: template.count,
        });
      } catch {
        // Ignore malformed generated frame URLs.
      }
    }
  };

  Array.from(document.images || []).forEach((img) => {
    addImage(img.currentSrc || img.src || img.getAttribute('data-src'), {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      alt: img.alt,
      source: 'img',
      dataUrl: dataUrlFromImage(img),
    });
    ['srcset', 'data-srcset', 'data-lazy-srcset'].forEach((attr) => addSrcset(img.getAttribute(attr)));
    ['data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-image', 'data-thumb', 'data-poster'].forEach((attr) => addImage(img.getAttribute(attr)));
  });
  Array.from(document.querySelectorAll('picture source, source[srcset], source[src]')).forEach((el) => {
    addImage(el.getAttribute('src'));
    addSrcset(el.getAttribute('srcset') || el.getAttribute('data-srcset'));
  });
  Array.from(document.querySelectorAll('svg image')).forEach((el) => {
    addImage(el.getAttribute('href') || el.getAttribute('xlink:href'));
  });
  Array.from(document.querySelectorAll('svg use')).forEach((el) => {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href');
    if (href && !href.startsWith('#')) addImage(href, { source: 'external-svg-symbol' });
  });
  Array.from(document.querySelectorAll('svg')).forEach((svg, index) => {
    try {
      const externalUse = Array.from(svg.querySelectorAll('use')).some((use) => {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        return href && !href.startsWith('#');
      });
      if (externalUse) return;
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const svgText = new XMLSerializer().serializeToString(clone);
      const bytes = new TextEncoder().encode(svgText);
      let binary = '';
      const chunkSize = 8192;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.slice(offset, offset + chunkSize)));
      }
      const title = String(svg.querySelector('title')?.textContent || svg.getAttribute('aria-label') || svg.getAttribute('id') || '').trim();
      const safeName = (title || 'inline-svg-' + (index + 1)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('inline-svg-' + (index + 1));
      addImage('data:image/svg+xml;base64,' + btoa(binary), {
        filename: safeName + '.svg',
        alt: title,
        type: 'svg',
        source: 'inline-svg',
        isInlineSvg: true,
        assetCategory: /logo|brand/i.test(title + ' ' + safeName) ? 'icon' : undefined,
      });
    } catch {
      // Ignore SVG serialization failures.
    }
  });
  collectFontAwesomeIcons();
  Array.from(document.querySelectorAll('link[rel="preload"][as="image"], meta[property="og:image"], meta[name="twitter:image"]')).forEach((el) => {
    addImage(el.getAttribute('href') || el.getAttribute('content'));
  });
  Array.from(document.querySelectorAll('*')).forEach((el) => {
    const style = getComputedStyle(el);
    [style.backgroundImage, style.listStyleImage, style.borderImageSource].forEach((value) => {
      readCssUrls(value).forEach((target) => addImage(target, { source: 'computed-style' }));
    });
    for (let i = 0; i < el.attributes.length; i += 1) {
      const attr = el.attributes[i];
      if (!/^data-/i.test(attr.name)) continue;
      if (/image|img|photo|thumb|poster|bg|background|src|lazy|icon|avatar|banner|hero/i.test(attr.name)) {
        if (/\\d+w|\\dx/.test(attr.value) && attr.value.includes(',')) addSrcset(attr.value);
        else addImage(attr.value);
      }
    }
  });
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    const name = absoluteUrl(entry.name);
    const initiator = String(entry.initiatorType || '').toLowerCase();
    if (!name) return;
    if (initiator === 'img' || /\\.(png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.test(name)) addImage(name, { source: initiator || 'performance' });
  });
  Array.from(document.querySelectorAll('[data-image-count], .threesixty, [class*="threesixty"], [class*="360"]')).forEach(collect360FromRoot);
  Array.from(document.querySelectorAll('.colorizer, [class*="colorizer"]')).forEach(collectToyotaColorizerSwatchSequences);
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    expand360Sequence(entry.name, 0).forEach((frame) => addImage(frame.url, {
      source: '360-sequence',
      alt: '360 frame ' + frame.frame,
      sequenceFrame: frame.frame,
      sequenceCount: frame.count,
    }));
  });

  const fontUrls = new Set();
  const fontUsage = new Map();
  const rememberFont = (font) => {
    const family = String(font?.family || '').replace(/^["']|["']$/g, '').trim();
    if (!family) return;
    const weight = String(font?.weight || 'normal').trim() || 'normal';
    const style = String(font?.style || 'normal').trim() || 'normal';
    const status = String(font?.status || '').trim() || undefined;
    const key = [family, weight, style].join('::');
    fontUsage.set(key, { family, weight, style, status });
  };
  if (document.fonts?.forEach) {
    document.fonts.forEach(rememberFont);
  }
  Array.from(document.querySelectorAll('link[href]')).forEach((link) => {
    const rel = String(link.getAttribute('rel') || '').toLowerCase();
    const href = absoluteUrl(link.getAttribute('href'));
    if (href && (rel.includes('stylesheet') || rel.includes('preload') || /fonts|typekit|\\.woff2?|\\.ttf|\\.otf/i.test(href))) {
      fontUrls.add(href);
    }
  });
  Array.from(document.styleSheets || []).forEach((sheet) => {
    const href = absoluteUrl(sheet.href);
    if (href) fontUrls.add(href);
    try {
      Array.from(sheet.cssRules || []).forEach((rule) => {
        const css = String(rule.cssText || '');
        if (/font-family/i.test(css)) {
          const family = css.match(/font-family\\s*:\\s*([^;}]+)/i)?.[1];
          if (family) rememberFont({ family: family.split(',')[0], status: 'referenced' });
        }
        readCssUrls(css).forEach((url) => {
          if (/\\.woff2?|\\.ttf|\\.otf|fonts|typekit/i.test(url)) fontUrls.add(url);
        });
      });
    } catch {
    }
  });
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    const name = absoluteUrl(entry.name);
    if (/fonts|typekit|\\.woff2?|\\.ttf|\\.otf/i.test(name)) fontUrls.add(name);
  });

  const videoUrls = new Set();
  Array.from(document.querySelectorAll('video[src], video source[src], iframe[src], embed[src], object[data]')).forEach((el) => {
    const src = absoluteUrl(el.getAttribute('src') || el.getAttribute('data'));
    if (src && (/video|youtube|youtu\\.be|vimeo|brightcove|wistia|\\.mp4|\\.m3u8|\\.webm/i.test(src))) videoUrls.add(src);
  });
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
    const name = absoluteUrl(entry.name);
    if (/\\.(mp4|m3u8|mpd|webm|mov)(?:[?#]|$)|youtube\\.com|vimeo\\.com|brightcove|wistia/i.test(name)) videoUrls.add(name);
  });

  const colorCounts = new Map();
  const addColor = (value, weight = 1) => {
    const match = String(value || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
    if (!match) return;
    const parts = [match[1], match[2], match[3]].map((part) => Math.max(0, Math.min(255, Number(part || 0))));
    if (parts.every((part) => part >= 248) || parts.every((part) => part <= 7)) return;
    const hex = '#' + parts.map((part) => part.toString(16).padStart(2, '0')).join('');
    colorCounts.set(hex, (colorCounts.get(hex) || 0) + weight);
  };
  Array.from(document.querySelectorAll('body, body *')).slice(0, 2000).forEach((el) => {
    const tag = (el.tagName || '').toLowerCase();
    const cls = String(el.getAttribute('class') || '').toLowerCase();
    const weight = tag.startsWith('h') || /btn|button|cta|logo|nav|hero|title/.test(cls) ? 4 : 1;
    const style = getComputedStyle(el);
    addColor(style.color, weight);
    addColor(style.backgroundColor, Math.max(1, weight - 1));
    addColor(style.borderTopColor, 1);
    addColor(style.fill, weight);
    addColor(style.stroke, weight);
  });

  const images = Array.from(imageMap.values())
    .sort((a, b) => {
      const aSequence = String(a?.source || '').includes('360-sequence') ? 1 : 0;
      const bSequence = String(b?.source || '').includes('360-sequence') ? 1 : 0;
      if (aSequence !== bSequence) return bSequence - aSequence;
      const aFrame = Number(a?.sequenceFrame || 0);
      const bFrame = Number(b?.sequenceFrame || 0);
      if (aSequence && bSequence && aFrame !== bFrame) return aFrame - bFrame;
      return 0;
    })
    .slice(0, 1600);
  return JSON.stringify({
    ok: true,
    url: location.href,
    title: document.title || location.href,
    images,
	    fonts: [
	      ...Array.from(fontUrls).map((url) => ({ url, name: filenameFromUrl(url, 'font'), format: typeFromUrl(url), source: 'stylesheet-or-network' })),
	      ...Array.from(fontUsage.values()).map((font) => ({ ...font, url: '', format: 'computed', source: 'FontFaceSet' })),
	    ],
    videos: Array.from(videoUrls).map((url) => ({ url, title: filenameFromUrl(url, 'video') })),
    colors: Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([color]) => color),
  });
})()
`;

const executeJavascriptInChromeTab = async (
  tab: { windowIndex: number; tabIndex: number },
  scriptSource: string
) => {
  if (process.platform !== 'darwin') {
    throw new Error('Chrome tab extraction is currently available on macOS only.');
  }
  const appleScript = [
    'on run argv',
    'set jsSource to item 1 of argv',
    'tell application "Google Chrome"',
    'if it is not running then error "Google Chrome is not running."',
    `return execute tab ${Math.max(1, Number(tab.tabIndex || 1))} of window ${Math.max(1, Number(tab.windowIndex || 1))} javascript jsSource`,
    'end tell',
    'end run',
  ];
  const { stdout } = await execFileAsync(
    'osascript',
    [...appleScript.flatMap((line) => ['-e', line]), scriptSource],
    { timeout: 30000, maxBuffer: 80 * 1024 * 1024 }
  );
  return String(stdout || '').trim();
};

const buildChromeTabVideoCaptureScript = () => `
(() => {
  const urls = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('blob:')) return;
    try {
      const absolute = new URL(raw, location.href).href;
      if (/\\.(?:m3u8|mpd|mp4|webm|mov)(?:[?#]|$)|brightcove|vimeo|wistia/i.test(absolute)) urls.add(absolute);
    } catch {}
  };
  document.querySelectorAll('video, video source, iframe[src], embed[src], object[data]').forEach((node) => {
    add(node.currentSrc);
    add(node.src);
    add(node.getAttribute && (node.getAttribute('src') || node.getAttribute('data')));
  });
  Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => add(entry.name));
  return JSON.stringify({
    ok: true,
    url: location.href,
    title: document.title || location.href,
    videos: Array.from(urls).map((url) => ({ url })),
  });
})()
`;

const fetchBrowserSessionFontFaces = async (rawFonts: any[], targetUrl: string) => {
  const cssUrls = Array.from(
    new Set(
      rawFonts
        .map((font) => String(font?.url || '').trim())
        .filter((url) => /^https?:\/\//i.test(url))
        .filter((url) => /\.css(?:[?#]|$)/i.test(url) || /fonts\.googleapis\.com|use\.typekit\.net|cloud\.typography|fonts\.adobe/i.test(url))
    )
  ).slice(0, 24);
  if (cssUrls.length === 0) return [];

  const results = await mapWithConcurrency(cssUrls, 5, async (cssUrl) => {
    try {
      assertPublicAssetUrl(cssUrl);
      const response = await withTimeout(
        axios.get(cssUrl, {
          timeout: 8000,
          responseType: 'text',
          maxContentLength: 3 * 1024 * 1024,
          httpsAgent: relaxedHttpsAgent,
          headers: {
            'User-Agent': PAGE_FETCH_USER_AGENTS[0],
            Accept: 'text/css,*/*;q=0.1',
            Referer: targetUrl,
          },
        }),
        9000,
        `Browser session font CSS fetch for ${cssUrl}`
      );
      return extractFontsFromCss(String(response.data || ''), cssUrl);
    } catch {
      return [];
    }
  });

  return results.flat();
};

const normalizeBrowserSessionExtraction = async (raw: any, sourceUrl: string, source: string) => {
  const pageUrl = String(raw?.url || sourceUrl || '').trim();
  const rawFonts = Array.isArray(raw?.fonts) ? raw.fonts : [];
  const cssFonts = await fetchBrowserSessionFontFaces(rawFonts, pageUrl || sourceUrl);
  const fontCandidates = rawFonts
    .filter((font: any) => font?.url && isSupportedFontAsset(font))
    .map((font: any) => ({
      ...font,
      source: font?.source || 'Network',
      originalFilename: filenameFromUrlPath(String(font?.url || '')),
    }))
    .concat(cssFonts);
  const imageRows = Array.isArray(raw?.images) ? raw.images : [];
  const images = await Promise.all(
    imageRows
      .filter((image: any) => String(image?.url || '').trim())
      .map(async (image: any, index: number) => {
      const url = String(image.url || '').trim();
      let type = String(image.type || '').trim() || getAssetTypeFromUrl(url, 'png');
      const filename = String(image.filename || '').trim() || `browser-image-${index + 1}.${type}`;
      const dataUrl = String(image.dataUrl || '').startsWith('data:image/') ? String(image.dataUrl) : '';
      const sourceKind = String(image.source || '');
      const pathSvgDataUrl =
        dataUrl && sourceKind === 'font-awesome-icon-svg'
          ? await convertFontIconTextSvgToPathSvg(dataUrl, image, fontCandidates, pageUrl || sourceUrl).catch(() => '')
          : '';
      const fontAwesomePngDataUrl =
        sourceKind === 'font-awesome-icon'
          ? await (async () => {
            const textSvgDataUrl = buildFontIconTextSvgDataUrlFromMeta(image);
            if (!textSvgDataUrl) return '';
            const pathSvg = await convertFontIconTextSvgToPathSvg(textSvgDataUrl, image, fontCandidates, pageUrl || sourceUrl).catch(() => '');
            return pathSvg ? await rasterizeSvgDataUrlToPngDataUrl(pathSvg) : '';
          })()
          : '';
      const finalDataUrl = fontAwesomePngDataUrl || pathSvgDataUrl || dataUrl;
      if (pathSvgDataUrl) type = 'svg';
      if (fontAwesomePngDataUrl) type = 'png';
      let cachedUrl = finalDataUrl || undefined;
      if (finalDataUrl) {
        const buffer = decodeDataImageBuffer(finalDataUrl);
        const contentType = finalDataUrl.match(/^data:([^;,]+)/i)?.[1] || 'image/png';
        if (buffer?.length) {
          cachedUrl = await writeCachedOriginalImageFromBuffer(url, buffer, contentType, type, filename).catch(() => '') || cachedUrl;
        }
      }
      return {
        url: pathSvgDataUrl || url,
        cachedUrl,
        filename,
        name: filename,
        alt: String(image.alt || filename).trim(),
        type,
        mimeType: fontAwesomePngDataUrl ? 'image/png' : (String(image.mimeType || '').trim() || undefined),
        width: Number(image.width || 0) || undefined,
        height: Number(image.height || 0) || undefined,
        source: String(image.source || '').trim() || source,
        status: DEFAULT_ASSET_STATUS,
      };
      })
  );
  const sequenceReadyImages = shouldSuppressToyotaSequenceAutoExpansion(pageUrl || sourceUrl)
    ? await repairMalformedToyotaCountedSequences(images, pageUrl || sourceUrl)
    : images.filter((image: any) => !hasMalformedImageSequencePath(String(image?.url || '').trim()));
  const skipToyotaSequenceExpansion =
    shouldSuppressToyotaSequenceAutoExpansion(pageUrl || sourceUrl) &&
    sequenceReadyImages.some((image: any) => String(image?.source || '').includes('360-sequence') && Number(image?.sequenceCount || 0) >= 8);
  const expandedImages = skipToyotaSequenceExpansion
    ? sequenceReadyImages
    : await expandAvailableImageSequences(sequenceReadyImages, pageUrl || sourceUrl);
  const fontUsage = rawFonts
    .filter((font: any) => !String(font?.url || '').trim() && String(font?.family || '').trim())
    .map((font: any) => ({
      family: String(font.family || '').replace(/^["']|["']$/g, '').trim(),
      weight: String(font.weight || '').trim() || undefined,
      style: String(font.style || '').trim() || undefined,
      status: String(font.status || '').trim() || undefined,
      source: String(font.source || '').trim() || 'FontFaceSet',
    }));
  const fontUsageByKey = new Map<string, any>();
  fontUsage.forEach((font: any) => {
    const key = `${font.family}|${font.weight || ''}|${font.style || ''}|${font.status || ''}`;
    if (!fontUsageByKey.has(key)) fontUsageByKey.set(key, font);
  });
  const metadataFonts = await enrichFontsWithMetadata(fontCandidates, pageUrl || sourceUrl, { fast: true });
  const fonts = dedupeFontsByLogicalKey(
    Array.from(new Set(metadataFonts.map((font) => String(font?.url || ''))))
      .map((fontUrl) => pickBestFontForUrl(metadataFonts, fontUrl))
      .filter(Boolean)
      .filter(isSupportedFontAsset)
  );

  return {
    images: expandedImages,
    icons: [],
    fonts,
    fontUsage: Array.from(fontUsageByKey.values()),
    videos: Array.isArray(raw?.videos) ? raw.videos : [],
    colors: Array.isArray(raw?.colors) ? raw.colors : [],
    extractionMeta: {
      mode: source,
      sectionLabel: raw?.title || 'Open Chrome Tab',
    },
    pageUrl,
    title: raw?.title || '',
  };
};

const extractAssetsFromControlledBrowserSession = async (targetUrl: string, userExploreWaitMs = 18000) => {
  const initialWaitMs = Math.min(180000, Math.max(8000, Number(userExploreWaitMs || 18000)));
  const executablePath = resolvePuppeteerExecutablePath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-asset-extractor-browser-profile-'));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir,
      executablePath: executablePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const page = await acquireSingleWebsitePage(browser);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
    await waitForPageContentSettle(page, {
      minWaitMs: initialWaitMs,
      readinessTimeoutMs: Math.min(12000, Math.max(4000, Math.round(initialWaitMs * 0.35))),
    });
    const firstHtml = await page.content().catch(() => '');
    if (pageHtmlLooksBlocked(firstHtml)) {
      const solved = await waitForManualCaptchaResolution(page, { timeoutMs: 180000 });
      if (!solved) {
        throw new Error('Captcha was not cleared in time. Complete the captcha in the opened browser window, then click Extract From Open Website again.');
      }
    }
    await performLazyLoadScroll(page, { stepDelayMs: 600, maxStableRounds: 3, maxDurationMs: 22000 }).catch(() => undefined);
    await waitForPageContentSettle(page, { minWaitMs: 8000, readinessTimeoutMs: 4000 });
    const rawText = await page.evaluate(buildChromeTabAssetCaptureScript() as any);
    const raw = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
    const missingPreviewUrls = (Array.isArray(raw?.images) ? raw.images : [])
      .filter((image: any) => image?.url && !String(image?.dataUrl || '').startsWith('data:image/'))
      .map((image: any) => String(image.url))
      .filter((url: string) => /^https?:\/\//i.test(url))
      .slice(0, 80);
    if (missingPreviewUrls.length > 0) {
      const dataUrlsByUrl = await page.evaluate(`
        (async () => {
          const urls = ${JSON.stringify(missingPreviewUrls)};
          const blobToDataUrl = (blob) => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
          });
          const entries = await Promise.all(urls.map(async (url) => {
            try {
              const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
              const contentType = String(response.headers.get('content-type') || '').toLowerCase();
              if (!response.ok || !contentType.startsWith('image/')) return [url, ''];
              const blob = await response.blob();
              if (!blob.size || blob.size > 12000000) return [url, ''];
              return [url, await blobToDataUrl(blob)];
            } catch {
              return [url, ''];
            }
          }));
          return Object.fromEntries(entries.filter((entry) => String(entry[1] || '').startsWith('data:image/')));
        })()
      `);
      raw.images = (Array.isArray(raw.images) ? raw.images : []).map((image: any) => ({
        ...image,
        dataUrl: image.dataUrl || dataUrlsByUrl[String(image.url || '')] || undefined,
      }));
    }
    await page.close().catch(() => undefined);
    return await normalizeBrowserSessionExtraction(raw, targetUrl, 'controlled-browser-session');
  } finally {
    await browser?.close().catch(() => undefined);
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

app.get('/api/browser-tabs/chrome/active', async (_req, res) => {
  try {
    const tab = await readChromeClientTab();
    return res.json({ ok: true, ...tab });
  } catch (error: any) {
    return res.status(400).json({
      ok: false,
      error: error?.message || 'Unable to read Chrome active tab.',
    });
  }
});

app.post('/api/browser-tabs/chrome/resolve-blob-video', async (req, res) => {
  const blobUrl = String(req.body?.url || '').trim();
  if (!/^blob:https?:\/\//i.test(blobUrl)) {
    return res.status(400).json({ ok: false, error: 'Paste a valid browser blob video URL.' });
  }

  try {
    const blobPageUrl = blobUrl.slice(5);
    const blobOrigin = new URL(blobPageUrl).origin;
    const tab = await readChromeClientTab(blobPageUrl);
    const tabUrl = String(tab.url || '').trim();
    if (!tabUrl || new URL(tabUrl).origin !== blobOrigin) {
      throw new Error('Open the page that created this blob video in the active Chrome tab, play the video, then try again.');
    }

    const rawText = await executeJavascriptInChromeTab(tab, buildChromeTabVideoCaptureScript());
    const raw = JSON.parse(rawText || '{}');
    const pageUrl = String(raw?.url || tabUrl).trim();
    const candidates: string[] = Array.from(
      new Set<string>(
        (Array.isArray(raw?.videos) ? raw.videos : [])
          .map((video: any) => String(video?.url || '').trim())
          .filter((url: string) => /^https?:\/\//i.test(url))
          .filter((url: string) => /\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$)|\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url))
      )
    ).sort((left, right) => {
      const score = (url: string) =>
        (/\.m3u8(?:[?#]|$)/i.test(url) ? 100 : 0) +
        (/master|playlist|index/i.test(url) ? 30 : 0) +
        (/\.mpd(?:[?#]|$)/i.test(url) ? 10 : 0);
      return score(right) - score(left);
    });

    for (const candidate of candidates.slice(0, 16)) {
      const validation = await validateStreamUrl(candidate, pageUrl).catch(() => null);
      if (!validation?.ok) continue;
      return res.json({
        ok: true,
        url: validation.url || candidate,
        sourcePageUrl: pageUrl,
        title: String(raw?.title || 'Captured browser video').trim(),
        type: /\.m3u8(?:[?#]|$)/i.test(candidate) ? 'm3u8' : /\.mpd(?:[?#]|$)/i.test(candidate) ? 'mpd' : 'video',
      });
    }

    throw new Error('No downloadable HLS stream was captured. Keep the Chrome tab open, press play, wait a few seconds, and try again.');
  } catch (error: any) {
    const rawMessage = String(error?.message || error || '');
    const friendlyMessage = /Application isn.t running|Google Chrome got an error.*isn.t running|\(-600\)/i.test(rawMessage)
      ? 'Open the source page in Google Chrome, start video playback, then try the blob URL again.'
      : /Executing JavaScript through AppleScript is turned off/i.test(rawMessage)
        ? 'In Chrome, enable View > Developer > Allow JavaScript from Apple Events, keep the source video playing, then try again.'
        : rawMessage;
    return res.status(400).json({
      ok: false,
      error: friendlyMessage || 'Could not resolve the browser blob video.',
    });
  }
});

const normalizeFontFamilyForStaticBackfill = (value = '') => {
  const family = String(value || '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!family) return '';
  const lower = family.toLowerCase();
  if (
    !lower ||
    isJunkFontLabel(lower) ||
    ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(lower)
  ) {
    return '';
  }
  return lower;
};

const getFontCardFamilyForStaticBackfill = (font: any) => {
  const identity = resolveFontIdentityFields(font || {});
  return normalizeFontFamilyForStaticBackfill(
    identity.family || font?.family || font?.title || font?.name || buildFontDisplayName(font || {})
  );
};

const hasRenderedFontFamilyWithoutCard = (extracted: any) => {
  const renderedFamilies = new Set(
    (Array.isArray(extracted?.fontUsage) ? extracted.fontUsage : [])
      .map((font: any) => normalizeFontFamilyForStaticBackfill(font?.family))
      .filter(Boolean)
  );
  if (!renderedFamilies.size) return false;

  const cardFamilies = new Set(
    (Array.isArray(extracted?.fonts) ? extracted.fonts : [])
      .map((font: any) => getFontCardFamilyForStaticBackfill(font))
      .filter(Boolean)
  );
  return Array.from(renderedFamilies).some((family) => !cardFamilies.has(family));
};

const isImageSequenceCandidateUrl = (value: string) =>
  /(?:threesixty|360|jellies|vehicle|lexus|aemassets|assetscs|visualizer)/i.test(String(value || ''));

const imageSequenceMergeKey = (item: any) => {
  const raw = String(item?.url || item?.src || '').trim();
  if (!raw || !isImageSequenceCandidateUrl(raw)) return raw;
  try {
    const parsed = new URL(raw);
    const normalizedPath = parsed.pathname
      .replace(/^\/content\/dam\/toyota\/(?=jellies\/)/i, '/')
      .replace(/^\/is\/image\/toyota\/toyota\/(?=jellies\/)/i, '/')
      .replace(/\/{2,}/g, '/');
    const hostKey = /\/jellies\/(?:max|relative)\//i.test(normalizedPath)
      ? 'toyota-assets'
      : parsed.hostname.replace(/^www\./, '').toLowerCase();
    const countedFrame = normalizedPath.match(/^(.*\/)(\d{1,3})\/(\d{1,3})\.(?:png|jpe?g|webp|avif)(?:$)/i);
    if (countedFrame && Number(countedFrame[2]) >= 2 && Number(countedFrame[2]) <= MAX_IMAGE_SEQUENCE_FRAMES) {
      return `sequence:${hostKey}:${countedFrame[1].toLowerCase()}:${Number(countedFrame[3])}`;
    }
    const leafFrame = normalizedPath.match(/^(.*\/)(\d{1,3})\.(?:png|jpe?g|webp|avif)(?:$)/i);
    if (leafFrame) {
      return `sequence:${hostKey}:${leafFrame[1].toLowerCase()}:${Number(leafFrame[2])}`;
    }
    const prefixedFrame = normalizedPath.match(/^(.*[-_])(\d{1,3})\.(?:png|jpe?g|webp|avif)(?:$)/i);
    if (prefixedFrame && /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(raw)) {
      return `sequence:${hostKey}:${prefixedFrame[1].toLowerCase()}:${Number(prefixedFrame[2])}`;
    }
  } catch {
    return raw;
  }
  return raw;
};

const imageCandidateScore = (item: any) => {
  const width = Number(item?.width || 0) || 0;
  const height = Number(item?.height || 0) || 0;
  const area = width * height;
  if (area > 0) return area;
  try {
    const parsed = new URL(String(item?.url || item?.src || ''));
    const wid = Number(parsed.searchParams.get('wid') || parsed.searchParams.get('width') || 0) || 0;
    const hei = Number(parsed.searchParams.get('hei') || parsed.searchParams.get('height') || 0) || 0;
    if (wid > 0 && hei > 0) return wid * hei;
    return wid || hei || 0;
  } catch {
    return 0;
  }
};

const mergeImageRowsByBestSequenceFrame = (left: any[] = [], right: any[] = []) => {
  const rows = new Map<string, any>();
  [...left, ...right].forEach((item) => {
    const key = imageSequenceMergeKey(item);
    if (!key) return;
    const current = rows.get(key);
    if (!current || imageCandidateScore(item) >= imageCandidateScore(current)) {
      rows.set(key, item);
    }
  });
  return Array.from(rows.values());
};

const browserTabMatchesRequestedUrl = (tabUrl: string, requestedUrl: string) => {
  const requested = String(requestedUrl || '').trim();
  const current = String(tabUrl || '').trim();
  if (!requested) return true;
  if (!current) return false;
  try {
    const requestedParsed = new URL(requested);
    const currentParsed = new URL(current);
    return (
      requestedParsed.hostname.replace(/^www\./, '').toLowerCase() === currentParsed.hostname.replace(/^www\./, '').toLowerCase() &&
      requestedParsed.pathname.replace(/\/+$/, '') === currentParsed.pathname.replace(/\/+$/, '')
    );
  } catch {
    return current === requested;
  }
};

async function fillEmptyBrowserExtractionFromStatic(extracted: any, fallbackUrl: string) {
  const hasAssets =
    (extracted?.images?.length || 0) ||
    (extracted?.icons?.length || 0) ||
    (extracted?.fonts?.length || 0) ||
    (extracted?.videos?.length || 0);
  const hasDownloadableFonts = (extracted?.fonts?.length || 0) > 0;
  const needsRenderedFontBackfill = hasRenderedFontFamilyWithoutCard(extracted);
  const browserImages = [
    ...(Array.isArray(extracted?.images) ? extracted.images : []),
    ...(Array.isArray(extracted?.icons) ? extracted.icons : []),
  ];
  const hasImageSequenceCandidate = browserImages.some((item: any) =>
    isImageSequenceCandidateUrl(String(item?.url || item?.src || ''))
  );
  const hasCompleteToyotaSequence =
    isToyotaVehicleExtractionTarget(fallbackUrl) &&
    browserImages.filter((item: any) =>
      String(item?.source || '').includes('360-sequence') &&
      Number(item?.sequenceFrame || 0) >= 1 &&
      Number(item?.sequenceFrame || 0) <= 36
    ).length >= 36;
  const needsImageSequenceBackfill = hasImageSequenceCandidate && !hasCompleteToyotaSequence;
  if ((hasAssets && hasDownloadableFonts && !needsRenderedFontBackfill && !needsImageSequenceBackfill) || !fallbackUrl) return extracted;

  const staticAssets = await withTimeout(
    extractStaticAssets(fallbackUrl, '', { fast: true }),
    35000,
    `Browser-tab static fallback for ${fallbackUrl}`
  ).catch(() => null) as any;
  if (!staticAssets || !isUsableStaticExtract(staticAssets)) return extracted;

  const mergeByUrl = (left: any[] = [], right: any[] = []) => {
    const rows = new Map<string, any>();
    [...left, ...right].forEach((item) => {
      const key = String(item?.url || item?.src || '').trim();
      if (key) rows.set(key, item);
    });
    return Array.from(rows.values());
  };

  return {
    ...extracted,
    images: mergeImageRowsByBestSequenceFrame(extracted?.images, staticAssets?.images),
    icons: mergeImageRowsByBestSequenceFrame(extracted?.icons, staticAssets?.icons),
    videos: mergeByUrl(extracted?.videos, staticAssets?.videos),
    fonts: mergeByUrl(extracted?.fonts, staticAssets?.fonts),
    colors: Array.from(new Set([...(extracted?.colors || []), ...(staticAssets?.colors || [])])),
    extractionMeta: {
      ...extracted?.extractionMeta,
      mode: hasAssets || needsRenderedFontBackfill ? 'browser-static-font-fallback' : 'browser-static-fallback',
      sectionLabel: extracted?.title || 'Static fallback',
    },
    pageUrl: extracted?.pageUrl || fallbackUrl,
    title: extracted?.title || '',
  };
}

app.post('/api/browser-tabs/chrome/extract', async (req, res) => {
  const requestedUrl = String(req.body?.url || '').trim();
  const previousProxyUrl = activeExtractionProxyUrl;
  try {
    activeExtractionProxyUrl = normalizeExtractionProxyUrl(req.body?.proxyUrl);
    const tab = await readChromeClientTab();
    try {
      if (requestedUrl && !browserTabMatchesRequestedUrl(tab.url || '', requestedUrl)) {
        throw new Error('Active Chrome tab does not match the pasted URL.');
      }
      const rawText = await executeJavascriptInChromeTab(tab, buildChromeTabAssetCaptureScript());
      const raw = JSON.parse(rawText || '{}');
      const fallbackUrl = raw?.url || tab.url || requestedUrl;
      const extracted = await fillEmptyBrowserExtractionFromStatic(
        await normalizeBrowserSessionExtraction(raw, fallbackUrl, 'open-chrome-tab'),
        fallbackUrl
      );
      return res.json({
        ok: true,
        source: 'open-chrome-tab',
        chromeTab: tab,
        ...extracted,
      });
    } catch (chromeScriptError: any) {
      if (!requestedUrl && !tab.url) throw chromeScriptError;
      const fallbackUrl = requestedUrl || tab.url;
      const extracted = await fillEmptyBrowserExtractionFromStatic(
        await extractAssetsFromControlledBrowserSession(fallbackUrl),
        fallbackUrl
      );
      return res.json({
        ok: true,
        source: 'controlled-browser-session',
        chromeTab: tab,
        warning:
          'Chrome did not allow direct active-tab scripting. Used a controlled browser session fallback.',
        chromeError: String(chromeScriptError?.message || chromeScriptError || '').slice(0, 300),
        ...extracted,
      });
    }
  } catch (error: any) {
    if (/proxy url|proxy protocol/i.test(String(error?.message || ''))) {
      return res.status(400).json({
        ok: false,
        error: error?.message || 'Invalid proxy URL.',
      });
    }
    const fallbackUrl = requestedUrl;
    if (fallbackUrl) {
      try {
        const extracted = await fillEmptyBrowserExtractionFromStatic(
          await extractAssetsFromControlledBrowserSession(fallbackUrl),
          fallbackUrl
        );
        return res.json({
          ok: true,
          source: 'controlled-browser-session',
          warning: 'Open Chrome tab extraction was unavailable. Used a controlled browser session fallback.',
          ...extracted,
        });
      } catch (fallbackError: any) {
        return res.status(400).json({
          ok: false,
          error: fallbackError?.message || error?.message || 'Unable to extract assets from Chrome.',
        });
      }
    }
    return res.status(400).json({
      ok: false,
      error: error?.message || 'Unable to extract assets from Chrome.',
    });
  } finally {
    activeExtractionProxyUrl = previousProxyUrl;
  }
});

app.post('/api/resolve-font-links', async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const pageUrl = String(req.body?.sourcePageUrl || '').trim();
  const cssUrls = Array.from(new Set<string>(
    urls
      .map((url: any) => String(url || '').trim())
      .filter((url: string) => /^https?:\/\//i.test(url))
      .filter((url: string) =>
        /\.css(?:[?#]|$)/i.test(url) ||
        /fonts\.googleapis\.com\/css/i.test(url) ||
        /use\.typekit\.net\/[^/?#]+\.css(?:[?#]|$)/i.test(url) ||
        /p\.typekit\.net\/p\.css/i.test(url)
      )
  )).slice(0, 20);

  if (cssUrls.length === 0) {
    return res.json({ ok: true, fonts: [] });
  }

  try {
    const resolved = await mapWithConcurrency(cssUrls, 4, async (cssUrl: string) => {
      try {
        assertPublicAssetUrl(cssUrl);
        const response = await withTimeout(
          axios.get(cssUrl, {
            timeout: 12000,
            responseType: 'text',
            maxContentLength: 4 * 1024 * 1024,
            httpsAgent: relaxedHttpsAgent,
            headers: {
              'User-Agent': PAGE_FETCH_USER_AGENTS[0],
              Accept: 'text/css,*/*;q=0.1',
              Referer: pageUrl || cssUrl,
            },
          }),
          14000,
          `Resolve font CSS ${cssUrl}`
        );
        return extractFontsFromCss(String(response.data || ''), cssUrl).map((font: any) => ({
          ...font,
          cssSource: cssUrl,
          originalFilename: filenameFromUrlPath(String(font?.url || '')),
        }));
      } catch (error: any) {
        return [{
          cssSource: cssUrl,
          error: String(error?.message || error || 'Font CSS fetch failed'),
        }];
      }
    });
    const flat = resolved.flat();
    const fonts = flat.filter((font: any) => font?.url && isSupportedFontAsset(font));
    const uniqueFonts = Array.from(new Map(fonts.map((font: any) => [String(font.url), font])).values());
    const failures = flat.filter((entry: any) => entry?.error);
    return res.json({ ok: true, fonts: uniqueFonts, failures });
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: error?.message || 'Unable to resolve font links.' });
  }
});

app.get('/api/activity-log/recent', async (_req, res) => {
  const entries = await readRecentActivityLogs(20);
  res.json({ ok: true, entries, logPath: activityLogPath });
});

const writeSystemClipboard = (value: string) =>
  new Promise<void>((resolve, reject) => {
    const command =
      process.platform === 'darwin'
        ? { bin: 'pbcopy', args: [] as string[] }
        : process.platform === 'win32'
          ? { bin: 'clip', args: [] as string[] }
          : { bin: 'xclip', args: ['-selection', 'clipboard'] };
    const child = spawn(command.bin, command.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', (chunk) => {
      errorText += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim() || `Clipboard command exited with code ${code}`));
    });
    child.stdin.end(value);
  });

app.post('/api/clipboard/write', async (req, res) => {
  const value = String(req.body?.text || '');
  if (!value || value.length > 100000) {
    return res.status(400).json({ ok: false, error: 'Valid clipboard text is required.' });
  }
  try {
    await writeSystemClipboard(value);
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'Clipboard write failed.' });
  }
});

app.post('/api/feedback/screenshot', async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || '').trim();
    const filenameHint = String(req.body?.filename || 'screenshot.jpg').trim();
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!match) {
      return res.status(400).json({ ok: false, error: 'Invalid screenshot payload.' });
    }
    const compressed = await compressScreenshotDataUrlForSheet(dataUrl);
    if (!compressed) {
      return res.status(400).json({ ok: false, error: 'Invalid screenshot payload.' });
    }
    const baseName = filenameHint.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 48) || 'screenshot';
    const safeName = /\.(png|jpe?g|webp)$/i.test(baseName)
      ? `${Date.now()}-${baseName.replace(/\.(png|webp)$/i, '.jpg')}`
      : `${Date.now()}-${baseName}.jpg`;
    const sourcePageUrl = readSourcePageUrl(req);
    const screenshotDir = feedbackScreenshotDir;
    await fsp.mkdir(screenshotDir, { recursive: true });
    const filePath = path.join(screenshotDir, safeName);
    await fsp.writeFile(filePath, Buffer.from(compressed.screenshotBase64, 'base64'));
    return res.json({
      ok: true,
      filePath,
      displayPath: toDisplayFilePath(filePath),
      screenshotUrl: toDisplayFilePath(filePath),
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'Screenshot save failed.' });
  }
});

app.post('/api/feedback', async (req, res) => {
  const name = getSuggestedDisplayName() || String(req.body?.name || '').trim();
  const suggestions = String(req.body?.suggestions || '').trim();
  if (!name || !suggestions) {
    return res.status(400).json({ error: 'Name and suggestions are required.' });
  }

  const pkg = await resolvePackageMeta();
  const platformMeta = getFeedbackPlatformMeta();
  const recentLogs = await readRecentActivityLogs(5);
  const logSummary = recentLogs
    .map((entry: any) => `${entry.timestamp || ''} ${entry.kind || ''} ${entry.error || entry.message || ''}`.trim())
    .filter(Boolean)
    .join('\n');
  const payload: FeedbackPayload = {
    name,
    category: String(req.body?.category || 'Suggestion').trim() || 'Suggestion',
    suggestions: logSummary ? `${suggestions}\n\n--- Recent activity ---\n${logSummary}` : suggestions,
    submittedAt: new Date().toISOString(),
    appVersion: String(req.body?.appVersion || pkg.version || '1.0.0').trim() || pkg.version,
    platform: String(req.body?.platform || platformMeta.platform).trim() || platformMeta.platform,
    architecture: String(req.body?.architecture || platformMeta.architecture).trim() || platformMeta.architecture,
    osLabel: String(req.body?.osLabel || platformMeta.osLabel).trim() || platformMeta.osLabel,
    websiteUrl: String(req.body?.websiteUrl || '').trim(),
    videoUrl: String(req.body?.videoUrl || '').trim(),
    fontName: String(req.body?.fontName || '').trim(),
    screenshotUrl: String(req.body?.screenshotUrl || '').trim(),
    lastError: String(req.body?.lastError || '').trim(),
  };

  try {
    const target = await resolveFeedbackTarget();
    if (target) {
      const screenshotDataUrl = String(req.body?.screenshotDataUrl || '').trim();
      const mode = await submitFeedbackRemote(target, payload, { screenshotDataUrl });
      return res.json({
        ok: true,
        mode,
        appVersion: payload.appVersion,
        message: 'Thanks! Your feedback has been submitted.',
      });
    }

    await appendLocalFeedbackInbox(payload);
    return res.json({
      ok: true,
      mode: 'local',
      appVersion: payload.appVersion,
      message: 'Thanks! Your feedback has been submitted.',
      inboxPath: feedbackInboxPath,
    });
  } catch (error: any) {
    console.error('Feedback submit failed:', error?.message || error);
    try {
      await appendLocalFeedbackInbox(payload);
      return res.json({
        ok: true,
        mode: 'local',
        appVersion: payload.appVersion,
        message: 'Thanks! Your feedback has been submitted.',
        inboxPath: feedbackInboxPath,
        fallback: true,
      });
    } catch (fallbackError: any) {
      console.error('Feedback local fallback failed:', fallbackError?.message || fallbackError);
      return res.status(503).json({
        error: 'Unable to submit right now. Please try again.',
      });
    }
  }
});

app.post('/api/responsible-use-acknowledgement', async (req, res) => {
  try {
    const userName = getCurrentUserName();
    const safeUserName = toSafeUserFilePart(userName);
    const acknowledgedAt = new Date().toISOString();
    const filePath = path.join(appDataDir, `${safeUserName}-responsible-use.json`);
    const payload = {
      userName,
      acknowledged: true,
      acknowledgedAt,
      app: 'Creative Asset Extractor',
      version: '1',
      context: typeof req.body?.context === 'string' ? req.body.context : 'firstLaunch',
    };

    await fsp.mkdir(appDataDir, { recursive: true });
    await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    res.json({
      ok: true,
      userName,
      filePath,
      acknowledgedAt,
    });
  } catch (error: any) {
    console.error('Responsible use acknowledgement write failed:', error?.message || error);
    res.status(500).json({ error: 'Failed to save acknowledgement file.' });
  }
});

const DEFAULT_GITHUB_OWNER = 'frontendtech01-star';
const DEFAULT_GITHUB_REPO = 'creative-asset-extractor';

const resolveGithubRepoConfig = () => {
  const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
  if (repository.includes('/')) {
    const [owner, repo] = repository.split('/');
    return { githubOwner: owner, githubRepo: repo };
  }
  return {
    githubOwner: String(
      process.env.GITHUB_OWNER || process.env.VITE_GITHUB_OWNER || DEFAULT_GITHUB_OWNER
    ).trim(),
    githubRepo: String(
      process.env.GITHUB_REPO || process.env.VITE_GITHUB_REPO || DEFAULT_GITHUB_REPO
    ).trim(),
  };
};

const normalizeReleaseTag = (version: string) => {
  const trimmed = String(version || '').trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
};

const normalizeAssetVersion = (version: string) => {
  const cleanVersion = String(version || '').replace(/^v/i, '');
  return /^\d+\.\d+$/.test(cleanVersion) ? `${cleanVersion}.0` : cleanVersion;
};

const buildDmgAssetName = (productName: string, version: string) => {
  const cleanVersion = normalizeAssetVersion(version);
  return `Creative.Asset.Extractor-${cleanVersion}-arm64.dmg`;
};

const buildGithubReleaseLinks = (
  githubOwner: string,
  githubRepo: string,
  version: string,
  productName: string
) => {
  const tagName = normalizeReleaseTag(version);
  const dmgName = buildDmgAssetName(productName, version);
  const repoUrl = `https://github.com/${githubOwner}/${githubRepo}`;
  return {
    tagName,
    htmlUrl: `${repoUrl}/releases/tag/${tagName}`,
    releasesUrl: `${repoUrl}/releases`,
    repoUrl,
    dmgDownloadUrl: `${repoUrl}/releases/latest/download/${encodeURIComponent(dmgName)}`,
    dmgAssetName: dmgName,
  };
};

const parseGithubReleasePayload = (data: any) => {
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const dmgAsset = assets
    .filter((asset: any) => /\.dmg$/i.test(String(asset?.name || '')))
    .sort((left: any, right: any) => {
      const rightTime = Date.parse(String(right?.updated_at || right?.created_at || '')) || 0;
      const leftTime = Date.parse(String(left?.updated_at || left?.created_at || '')) || 0;
      return rightTime - leftTime;
    })[0];
  return {
    tagName: String(data?.tag_name || ''),
    name: String(data?.name || data?.tag_name || 'Latest release'),
    body: String(data?.body || ''),
    publishedAt: String(data?.published_at || ''),
    htmlUrl: String(data?.html_url || ''),
    packageDownloadUrl: String(dmgAsset?.browser_download_url || ''),
    packageAssetName: String(dmgAsset?.name || 'Mac DMG'),
    dmgDownloadUrl: String(dmgAsset?.browser_download_url || ''),
    dmgAssetName: String(dmgAsset?.name || ''),
    dmgAssetUpdatedAt: String(dmgAsset?.updated_at || ''),
    dmgAssetSize: Number(dmgAsset?.size || 0),
    dmgAssetDigest: String(dmgAsset?.digest || ''),
  };
};

const readProjectReleaseNotes = async () => {
  const candidates = [
    path.join(getAppRoot(), 'RELEASE_NOTES.md'),
    path.join(process.cwd(), 'RELEASE_NOTES.md'),
  ];
  for (const notesPath of candidates) {
    try {
      const raw = await fsp.readFile(notesPath, 'utf8');
      const text = String(raw || '').trim();
      if (!text) continue;
      const currentSection = text.split(/## Current Release/i)[1];
      if (currentSection) {
        return currentSection.split(/## /)[0].trim();
      }
      return text.replace(/^#\s*Release Notes\s*/i, '').trim();
    } catch {
      // try next candidate
    }
  }
  return '';
};

app.get('/api/app-meta', async (_req, res) => {
  const pkg = await resolvePackageMeta();
  const github = resolveGithubRepoConfig();
  res.json({
    version: pkg.version,
    productName: pkg.productName,
    githubOwner: github.githubOwner,
    githubRepo: github.githubRepo,
  });
});

app.get('/api/github-latest-release', async (_req, res) => {
  const { githubOwner, githubRepo } = resolveGithubRepoConfig();
  if (!githubOwner || !githubRepo) {
    return res.json({ available: false, error: 'GitHub repository is not configured.' });
  }

  try {
    const response = await axios.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`, {
      timeout: 12000,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Creative-Asset-Extractor',
      },
    });
    const release = parseGithubReleasePayload(response.data || {});
    const links = buildGithubReleaseLinks(githubOwner, githubRepo, release.tagName, (await resolvePackageMeta()).productName);
    return res.json({
      available: true,
      release: {
        ...release,
        repoUrl: links.repoUrl,
        releasesUrl: links.releasesUrl,
        packageDownloadUrl: release.dmgDownloadUrl || links.dmgDownloadUrl,
        packageAssetName: release.dmgAssetName || links.dmgAssetName || 'Mac DMG',
        dmgDownloadUrl: release.dmgDownloadUrl || links.dmgDownloadUrl,
        dmgAssetName: release.dmgAssetName || links.dmgAssetName,
        dmgAssetUpdatedAt: release.dmgAssetUpdatedAt || '',
        dmgAssetSize: release.dmgAssetSize || 0,
        dmgAssetDigest: release.dmgAssetDigest || '',
      },
    });
  } catch (error: any) {
    const status = Number(error?.response?.status || 0);
    if (status === 404) {
      return res.json({ available: false, error: 'No published GitHub release found yet.' });
    }
    return res.status(502).json({
      available: false,
      error: 'Unable to check GitHub releases right now.',
    });
  }
});

app.get('/api/release-notes', async (_req, res) => {
  const pkg = await resolvePackageMeta();
  const { githubOwner, githubRepo } = resolveGithubRepoConfig();
  const links = buildGithubReleaseLinks(githubOwner, githubRepo, pkg.version, pkg.productName);
  const localNotes = await readProjectReleaseNotes();

  let release = {
    tagName: links.tagName,
    name: `${pkg.productName} ${links.tagName}`,
    body: localNotes,
    htmlUrl: links.htmlUrl,
    repoUrl: links.repoUrl,
    releasesUrl: links.releasesUrl,
    packageDownloadUrl: links.dmgDownloadUrl,
    packageAssetName: links.dmgAssetName,
    dmgDownloadUrl: links.dmgDownloadUrl,
    dmgAssetName: links.dmgAssetName,
    dmgAssetUpdatedAt: '',
    dmgAssetSize: 0,
    dmgAssetDigest: '',
    source: 'local' as 'local' | 'github',
  };

  try {
    const response = await axios.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`, {
      timeout: 12000,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Creative-Asset-Extractor',
      },
    });
    const githubRelease = parseGithubReleasePayload(response.data || {});
    release = {
      ...release,
      body: localNotes || githubRelease.body || '',
      htmlUrl: githubRelease.htmlUrl || links.htmlUrl,
      packageDownloadUrl: githubRelease.dmgDownloadUrl || links.dmgDownloadUrl,
      packageAssetName: githubRelease.dmgAssetName || links.dmgAssetName,
      dmgDownloadUrl: githubRelease.dmgDownloadUrl || links.dmgDownloadUrl,
      dmgAssetName: githubRelease.dmgAssetName || links.dmgAssetName,
      dmgAssetUpdatedAt: githubRelease.dmgAssetUpdatedAt || '',
      dmgAssetSize: githubRelease.dmgAssetSize || 0,
      dmgAssetDigest: githubRelease.dmgAssetDigest || '',
      source: 'github',
    };
  } catch (error: any) {
    const status = Number(error?.response?.status || 0);
    if (status !== 404) {
      return res.status(502).json({
        available: false,
        error: 'Unable to load release notes right now.',
      });
    }
  }

  return res.json({ available: true, release });
});

app.get('/api/system-check', async (_req, res) => {
  const ytdlpPath = resolvedYtDlpPath || resolveYtDlpPath();
  const ffmpegReady = Boolean(resolvedFfmpegPath && await fileExists(String(resolvedFfmpegPath)));
  const ffprobeReady = Boolean(resolvedFfprobePath && await fileExists(String(resolvedFfprobePath)));
  const ytdlpReady = Boolean(ytdlpPath && await fileExists(String(ytdlpPath)));
  const aria2Ready = Boolean(resolvedAria2Path && await fileExists(String(resolvedAria2Path)));
  const ytdlpStandalone = ytdlpPath ? !isPythonScriptBinary(String(ytdlpPath)) : false;
  const downloadsReady = await fsp.mkdir(downloadsDir, { recursive: true }).then(() => true).catch(() => false);
  const appDataReady = await fsp.mkdir(appDataDir, { recursive: true }).then(() => true).catch(() => false);

  res.json({
    ok: ffmpegReady && ytdlpReady && ytdlpStandalone && downloadsReady && appDataReady,
    platform: process.platform,
    arch: process.arch,
    userName: getCurrentUserName(),
    downloadsDir,
    appDataDir,
    tools: {
      ffmpeg: { ready: ffmpegReady, path: resolvedFfmpegPath ? String(resolvedFfmpegPath) : '' },
      ffprobe: { ready: ffprobeReady, path: resolvedFfprobePath ? String(resolvedFfprobePath) : '' },
      ytdlp: { ready: ytdlpReady, standalone: ytdlpStandalone, path: String(ytdlpPath || '') },
      aria2: { ready: aria2Ready, path: resolvedAria2Path ? String(resolvedAria2Path) : '' },
      resourcesBin: path.join(getResourcesPath(), 'bin'),
      chromium: {
        ready: Boolean(warmedPuppeteerBrowser?.connected),
        warming: Boolean(puppeteerWarmupInFlight),
        state: puppeteerWarmupStatus.state,
        updatedAt: puppeteerWarmupStatus.updatedAt,
        path: puppeteerWarmupStatus.executablePath || resolvePuppeteerExecutablePath(),
        error: puppeteerWarmupStatus.error || '',
      },
    },
    writable: {
      downloads: downloadsReady,
      appData: appDataReady,
    },
  });
});

// Helper to resolve URLs
const resolveUrl = (base: string, relative: string) => {
  try {
    const url = new URL(relative, base);
    // SVG fragments address individual symbols inside sprite files. Preserve
    // them so each referenced icon can be extracted as standalone artwork.
    if (!/\.svg$/i.test(url.pathname)) url.hash = '';
    return url.href;
  } catch (e) {
    return null;
  }
};

const PAGE_FETCH_USER_AGENTS = [
  'Mozilla/5.0',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const BOT_WALL_HTML_PATTERN =
  /robot-suspicion|challenge-platform|captcha-delivery|cf-challenge|cf_chl|cf-turnstile|cloudflare(?:\s+challenge|\s+turnstile|\s+ray|\s+error)|just a moment|checking (?:your browser|the site connection|if the site connection is secure)|verify you are human|access denied|datadome|akamai(?:.*(?:bot|deny|challenge|waf))|waf challenge|bot detection/i;

const htmlLooksLikeBotWall = (html: string) => {
  const sample = String(html || '').slice(0, 160000);
  if (/important safety information|full prescribing information|indicated for|wp-content\/uploads|\/\.imaging\//i.test(sample)) {
    return false;
  }
  return BOT_WALL_HTML_PATTERN.test(sample);
};

const scoreSiteHtml = (html: string, status: number) => {
  const text = String(html || '');
  if (htmlLooksLikeBotWall(text)) return -100;
  let score = text.length / 1000;
  if (status >= 200 && status < 300) score += 50;
  score += (text.match(/\/wp-content\/uploads/gi) || []).length * 5;
  score += (text.match(/<img\b/gi) || []).length * 2;
  score += (text.match(/background-image\s*:\s*url/gi) || []).length * 3;
  score += (text.match(/\.(?:png|jpe?g|webp|gif|avif)/gi) || []).length;
  return score;
};

const isSparseSiteHtml = (html: string) => {
  const text = String(html || '');
  if (htmlLooksLikeBotWall(text)) return true;
  if (text.length < 2048) return true;
  if (/\/wp-content\/uploads/i.test(text) && text.length > 8000) return false;
  if (text.length < 90000 && !/\/wp-content\/uploads|<img\b|background-image\s*:\s*url/i.test(text)) return true;
  const rasterHints = (text.match(/\.(?:png|jpe?g|webp|gif|avif)(?:[^\w]|$)/gi) || []).length;
  const svgCount = (text.match(/<svg\b/gi) || []).length;
  return rasterHints < 2 && svgCount > 0 && text.length < 120000;
};

const fetchQuickSiteHtml = async (siteUrl: string) => {
  assertPublicAssetUrl(siteUrl);
  let best = { html: '', score: -1 };

  for (const userAgent of PAGE_FETCH_USER_AGENTS.slice(0, 2)) {
    try {
      const response = await axios.get(siteUrl, {
        timeout: 6000,
        maxRedirects: 5,
        validateStatus: () => true,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
      });
      const html = String(response.data || '');
      const score = scoreSiteHtml(html, response.status);
      if (score > best.score) best = { html, score };
      if (response.status >= 200 && response.status < 300 && !isSparseSiteHtml(html)) break;
    } catch {
      // Try the next user agent.
    }
  }

  if (isSparseSiteHtml(best.html)) {
    const curlHtml = await withTimeout(fetchSiteHtmlViaCurl(siteUrl), 6000, `Quick curl HTML fetch for ${siteUrl}`).catch(
      () => ''
    );
    const curlScore = scoreSiteHtml(curlHtml, 200);
    if (curlScore > best.score) best = { html: curlHtml, score: curlScore };
  }

  return best.html;
};

const fetchSiteHtml = async (siteUrl: string) => {
  assertPublicAssetUrl(siteUrl);
  let best = { html: '', score: -1 };

  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await axios.get(siteUrl, {
        timeout: 8000,
        maxRedirects: 5,
        validateStatus: () => true,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
      });
      const html = String(response.data || '');
      const score = scoreSiteHtml(html, response.status);
      if (score > best.score) best = { html, score };
      if (response.status >= 200 && response.status < 300 && !isSparseSiteHtml(html)) break;
    } catch {
      // Try the next user agent.
    }
  }

  if (isSparseSiteHtml(best.html)) {
    const curlHtml = await withTimeout(fetchSiteHtmlViaCurl(siteUrl), 8000, `curl HTML fetch for ${siteUrl}`).catch(() => '');
    const curlScore = scoreSiteHtml(curlHtml, 200);
    if (curlScore > best.score) best = { html: curlHtml, score: curlScore };
  }

  if (isSparseSiteHtml(best.html)) {
    const browserHtml = await withTimeout(fetchSiteHtmlViaBrowser(siteUrl), 28000, `browser HTML fetch for ${siteUrl}`).catch(() => '');
    const browserScore = scoreSiteHtml(browserHtml, 200);
    if (browserScore > best.score) best = { html: browserHtml, score: browserScore };
  }

  return best.html;
};

const SYSTEM_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const resolvePuppeteerExecutablePath = () => {
  const bundled = findBundledChromiumExecutable();
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    bundled,
    ...(bundled ? [] : SYSTEM_CHROME_PATHS),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable paths.
    }
  }
  return '';
};

const applyPuppeteerStealth = async (page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>) => {
  // tsx's keepNames:true wraps const/var fn = ()=>{} with __name(fn, "name").
  // Puppeteer serializes callbacks via toString() which leaks transpiled __name calls
  // into the browser context. Polyfill __name globally so those calls don't throw.
  await page.evaluateOnNewDocument(`var __name=function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true})}catch(e){}return t};`);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
  });
};

const pageHtmlLooksBlocked = (html: string) => htmlLooksLikeBotWall(html);

const pageHtmlLooksRenderable = (html: string) => {
  const text = String(html || '');
  return /\/wp-content\/uploads|<img\b|background-image\s*:\s*url/i.test(text) && text.length > 12000;
};

const waitForRenderedSiteHtml = async (page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>) => {
  let html = await page.content().catch(() => '');
  if (!pageHtmlLooksRenderable(html) || pageHtmlLooksBlocked(html)) {
    await page.goto(page.url(), { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    html = await page.content().catch(() => '');
  }
  await page
    .waitForFunction(
      `(() => {
        const html = document.documentElement?.innerHTML || '';
        return /\\/wp-content\\/uploads|<img\\b|background-image\\s*:\\s*url/i.test(html) && html.length > 12000;
      })()`,
      { timeout: 15000 }
    )
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return page.content();
};

const waitForChallengeOrLoaderSettle = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>,
  options: { timeoutMs?: number; minAssetWaitMs?: number } = {}
) => {
  const timeoutMs = Math.max(2500, Number(options.timeoutMs || 10000));
  const minAssetWaitMs = Math.max(1200, Number(options.minAssetWaitMs || 3200));
  const started = Date.now();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  while (Date.now() - started < timeoutMs) {
    const state = await page
      .evaluate(() => {
        const bodyText = String(document.body?.innerText || '').slice(0, 6000);
        const html = String(document.documentElement?.innerHTML || '').slice(0, 160000);
        const hasAssets =
          document.querySelectorAll('img, picture source, video, source, svg, link[rel="stylesheet"], style').length > 0 ||
          /\.(?:png|jpe?g|webp|gif|avif|svg|woff2?|ttf|otf|eot|mp4|m3u8)(?:[?#"')\s]|$)/i.test(html);
        const hasChallengeText =
          /captcha|verify you are human|checking (?:your browser|the site connection)|just a moment|cloudflare|turnstile|datadome|akamai|challenge|enable javascript/i.test(
            bodyText + '\n' + html.slice(0, 12000)
          );
        const hasChallengeFrame = Boolean(
          document.querySelector(
            'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="cloudflare" i], iframe[src*="challenge" i], [class*="captcha" i], [id*="captcha" i], [class*="loader" i], [id*="loader" i]'
          )
        );
        const readyState = document.readyState;
        return {
          hasAssets,
          hasChallenge: hasChallengeText || hasChallengeFrame,
          readyState,
        };
      })
      .catch(() => ({ hasAssets: false, hasChallenge: false, readyState: 'unknown' }));

    const elapsed = Date.now() - started;
    if (state.hasAssets && !state.hasChallenge && elapsed > minAssetWaitMs) return true;
    if (state.hasAssets && elapsed > Math.min(Math.max(6500, minAssetWaitMs), timeoutMs)) return true;
    if (!state.hasChallenge && state.readyState === 'complete' && elapsed > Math.max(2600, minAssetWaitMs - 400)) return true;
    await delay(750);
  }

  return false;
};

const waitForPageContentSettle = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>,
  options: { minWaitMs?: number; readinessTimeoutMs?: number } = {}
) => {
  const minWaitMs = Math.max(0, Number(options.minWaitMs || 2500));
  const readinessTimeoutMs = Math.max(500, Number(options.readinessTimeoutMs || 2000));
  await new Promise((resolve) => setTimeout(resolve, minWaitMs));
  await page
    .evaluate(async (timeoutMs) => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitForFonts = async () => {
        try {
          if ((document as any).fonts?.ready) await Promise.race([(document as any).fonts.ready, delay(timeoutMs)]);
        } catch {
          // FontFaceSet can reject on cross-origin or cancelled loads; continue with best-effort assets.
        }
      };
      const waitForImages = async () => {
        const started = Date.now();
        let lastPendingCount = Number.POSITIVE_INFINITY;
        let stableRounds = 0;
        while (Date.now() - started < timeoutMs) {
          const pending = Array.from(document.images || []).filter((img) => {
            if (!img) return false;
            if (img.complete && img.naturalWidth > 0) return false;
            const rect = img.getBoundingClientRect();
            const hasSource = Boolean(img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('srcset'));
            return hasSource && rect.width > 0 && rect.height > 0;
          }).length;
          if (pending === 0) return;
          if (pending === lastPendingCount) stableRounds += 1;
          else stableRounds = 0;
          if (stableRounds >= 2) return;
          lastPendingCount = pending;
          await delay(350);
        }
      };
      await Promise.race([Promise.allSettled([waitForFonts(), waitForImages()]), delay(timeoutMs)]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, readinessTimeoutMs)
    .catch(() => undefined);
};

const waitForManualCaptchaResolution = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>,
  options: { timeoutMs?: number } = {}
) => {
  const timeoutMs = Math.max(15000, Number(options.timeoutMs || 120000));
  const started = Date.now();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await page.bringToFront?.().catch(() => undefined);

  while (Date.now() - started < timeoutMs) {
    const html = await page.content().catch(() => '');
    if (html && !pageHtmlLooksBlocked(html)) {
      await waitForPageContentSettle(page, { minWaitMs: 2200, readinessTimeoutMs: 2200 });
      return true;
    }
    await delay(2000);
  }

  return false;
};

const PUPPETEER_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--ignore-certificate-errors',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--mute-audio',
  '--hide-scrollbars',
];

let sharedPuppeteerBrowser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
let sharedPuppeteerBrowserLeases = 0;
let sharedPuppeteerBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;

let warmedPuppeteerBrowser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
let puppeteerWarmupInFlight: Promise<void> | null = null;
let puppeteerWarmupStatus: {
  state: 'idle' | 'warming' | 'ready' | 'failed' | 'consumed';
  updatedAt: string;
  executablePath?: string;
  error?: string;
} = {
  state: 'idle',
  updatedAt: new Date().toISOString(),
};

const launchFreshPuppeteerBrowser = async (proxyUrl = '') => {
  const executablePath = resolvePuppeteerExecutablePath();
  const proxyArg = proxyServerArg(proxyUrl);
  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: proxyArg ? [...PUPPETEER_BROWSER_ARGS, `--proxy-server=${proxyArg}`] : PUPPETEER_BROWSER_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
    ...(executablePath ? { executablePath } : {}),
  };
  return puppeteer.launch(launchOptions);
};

const scheduleSharedPuppeteerBrowserIdleClose = () => {
  if (sharedPuppeteerBrowserIdleTimer) clearTimeout(sharedPuppeteerBrowserIdleTimer);
  sharedPuppeteerBrowserIdleTimer = setTimeout(() => {
    if (sharedPuppeteerBrowserLeases > 0) return;
    void sharedPuppeteerBrowser?.close().catch(() => undefined);
    sharedPuppeteerBrowser = null;
    puppeteerWarmupStatus = {
      ...puppeteerWarmupStatus,
      state: 'idle',
      updatedAt: new Date().toISOString(),
    };
  }, 90000);
};

const acquireSharedPuppeteerBrowser = async () => {
  if (sharedPuppeteerBrowser?.connected) {
    sharedPuppeteerBrowserLeases += 1;
    if (sharedPuppeteerBrowserIdleTimer) clearTimeout(sharedPuppeteerBrowserIdleTimer);
    return sharedPuppeteerBrowser;
  }
  if (warmedPuppeteerBrowser?.connected) {
    sharedPuppeteerBrowser = warmedPuppeteerBrowser;
    warmedPuppeteerBrowser = null;
    sharedPuppeteerBrowserLeases = 1;
    puppeteerWarmupStatus = {
      ...puppeteerWarmupStatus,
      state: 'ready',
      updatedAt: new Date().toISOString(),
    };
    return sharedPuppeteerBrowser;
  }
  sharedPuppeteerBrowser = await launchFreshPuppeteerBrowser();
  sharedPuppeteerBrowserLeases = 1;
  puppeteerWarmupStatus = {
    state: 'ready',
    updatedAt: new Date().toISOString(),
    executablePath: resolvePuppeteerExecutablePath(),
  };
  return sharedPuppeteerBrowser;
};

const releaseSharedPuppeteerBrowser = async (options: { forceClose?: boolean } = {}) => {
  sharedPuppeteerBrowserLeases = Math.max(0, sharedPuppeteerBrowserLeases - 1);
  if (options.forceClose || sharedPuppeteerBrowserLeases === 0) {
    if (options.forceClose) {
      await sharedPuppeteerBrowser?.close().catch(() => undefined);
      sharedPuppeteerBrowser = null;
      sharedPuppeteerBrowserLeases = 0;
      puppeteerWarmupStatus = {
        ...puppeteerWarmupStatus,
        state: 'idle',
        updatedAt: new Date().toISOString(),
      };
      return;
    }
    scheduleSharedPuppeteerBrowserIdleClose();
  }
};

const launchPuppeteerBrowser = async (proxyUrl = '') =>
  proxyUrl ? launchFreshPuppeteerBrowser(proxyUrl) : acquireSharedPuppeteerBrowser();

const acquireSingleWebsitePage = async (browser: any) => {
  const pages = await browser.pages().catch(() => []);
  const page = pages.find((candidate: any) => {
    try {
      const url = String(candidate.url?.() || '');
      return !url || url === 'about:blank';
    } catch {
      return false;
    }
  }) || await browser.newPage();

  await Promise.all(
    pages
      .filter((candidate: any) => candidate !== page)
      .filter((candidate: any) => {
        try {
          const url = String(candidate.url?.() || '');
          return !url || url === 'about:blank';
        } catch {
          return false;
        }
      })
      .map((candidate: any) => candidate.close().catch(() => undefined))
  );

  return page;
};

const prewarmPuppeteerBrowser = () => {
  if (sharedPuppeteerBrowser?.connected || puppeteerWarmupInFlight) return puppeteerWarmupInFlight;
  const executablePath = resolvePuppeteerExecutablePath();
  puppeteerWarmupStatus = {
    state: 'warming',
    updatedAt: new Date().toISOString(),
    ...(executablePath ? { executablePath } : {}),
  };

  puppeteerWarmupInFlight = (async () => {
    try {
      await acquireSharedPuppeteerBrowser();
      await releaseSharedPuppeteerBrowser();
      puppeteerWarmupStatus = {
        state: 'ready',
        updatedAt: new Date().toISOString(),
        ...(executablePath ? { executablePath } : {}),
      };
    } catch (error: any) {
      puppeteerWarmupStatus = {
        state: 'failed',
        updatedAt: new Date().toISOString(),
        ...(executablePath ? { executablePath } : {}),
        error: String(error?.message || error || 'Chromium warmup failed').slice(0, 260),
      };
      console.warn('Background browser warmup failed:', error?.message || error);
    } finally {
      puppeteerWarmupInFlight = null;
    }
  })();

  return puppeteerWarmupInFlight;
};

const closePuppeteerBrowser = async (browser: Awaited<ReturnType<typeof puppeteer.launch>> | null) => {
  if (browser && browser === sharedPuppeteerBrowser) {
    await releaseSharedPuppeteerBrowser();
    return;
  }
  await browser?.close().catch(() => undefined);
};

const recoverExtractWhenEmpty = async (
  targetUrl: string,
  assets: { images: any[]; videos: any[]; fonts: any[]; colors: string[] }
) => {
  const total =
    (assets.images?.length || 0) +
    (assets.fonts?.length || 0) +
    (assets.videos?.length || 0) +
    (assets.colors?.length || 0);
  if (total > 0) return assets;
  console.warn('Extract returned zero assets, attempting HTML recovery:', targetUrl);
  const recoveryHtml = await withTimeout(fetchSiteHtml(targetUrl), 45000, `Recovery HTML for ${targetUrl}`).catch(() => '');
  if (!recoveryHtml || htmlLooksLikeBotWall(recoveryHtml) || scoreSiteHtml(recoveryHtml, 200) < 20) {
    const readerAssets = await extractReaderFallbackAssets(targetUrl).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
    const readerTotal =
      (readerAssets.images?.length || 0) +
      (readerAssets.fonts?.length || 0) +
      (readerAssets.videos?.length || 0) +
      (readerAssets.colors?.length || 0);
    return readerTotal > 0 ? readerAssets : assets;
  }
  return extractStaticAssets(targetUrl, recoveryHtml, { fast: false });
};

const fetchSiteHtmlViaCurl = async (siteUrl: string) => {
  let best = { html: '', score: -1 };
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const proxyUrl = activeExtractionProxyUrl;
      const { stdout } = await execFileAsync(
        'curl',
        [
          '-k',
          '-sL',
          '--max-time',
          '8',
          ...(proxyUrl ? ['--proxy', proxyUrl] : []),
          '-A',
          userAgent,
          '-H',
          'Accept: text/html,application/xhtml+xml',
          siteUrl,
        ],
        { maxBuffer: 25 * 1024 * 1024 }
      );
      const html = String(stdout || '');
      const score = scoreSiteHtml(html, 200);
      if (score > best.score) best = { html, score };
      if (!isSparseSiteHtml(html)) break;
    } catch {
      // Try the next user agent.
    }
  }
  return best.html;
};

const buildReaderFallbackUrl = (siteUrl: string) => {
  const normalized = new URL(siteUrl).href;
  return `https://r.jina.ai/http://${normalized}`;
};

const fetchReaderFallbackText = async (siteUrl: string) => {
  assertPublicAssetUrl(siteUrl);
  const readerUrl = buildReaderFallbackUrl(siteUrl);
  const response = await axios.get(readerUrl, {
    timeout: 20000,
    maxRedirects: 3,
    validateStatus: () => true,
    headers: {
      'User-Agent': PAGE_FETCH_USER_AGENTS[2],
      Accept: 'text/plain, text/markdown, */*',
    },
  });
  if (response.status < 200 || response.status >= 300) return '';
  const text = String(response.data || '');
  if (htmlLooksLikeBotWall(text)) return '';
  if (!/URL Source:|Markdown Content:|!\[[^\]]*\]\(|https?:\/\/[^\s)]+\/wp-content\//i.test(text)) return '';
  return text;
};

const buildKnownBlockedSiteFallbackHtml = (siteUrl: string, readerText = '') => {
  try {
    const parsed = new URL(siteUrl);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host !== 'xavierbecerra2026.com') return '';

    const origin = 'https://www.xavierbecerra2026.com';
    const images = new Set<string>([
      `${origin}/wp-content/themes/landslide/img/logo.png`,
      `${origin}/wp-content/themes/landslide/img/accent-headshot.png`,
      `${origin}/wp-content/uploads/2026/01/footer.jpg`,
    ]);
    if (/\/priorities(?:\/|$)/i.test(path)) {
      images.add(`${origin}/wp-content/uploads/2026/01/priorities.jpg`);
    }

    const readerAssets = extractAssetsFromRawText(readerText, siteUrl);
    (readerAssets.images || []).forEach((asset) => {
      const url = String(asset?.url || '');
      if (url && !isBotWallImageUrl(url)) images.add(url);
    });

    const escapeHtml = (value: string) =>
      String(value || '').replace(/[<&>"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char] || char));
    const markdownStart = readerText.split(/Markdown Content:\s*/i)[1] || readerText;
    const intro =
      markdownStart
        .split(/\n+/)
        .map((line) => line.trim())
        .find((line) => line && !/^Priorities$/i.test(line) && !/^\[/.test(line) && !/^!\[/.test(line)) ||
      'We have to fight to make it possible for all of us to have the California Dream.';
    const priorityCards = [
      ['Care for All. Care We Can Afford.', 'Health care is a human right.'],
      ['Fighting Donald Trump', 'Protect and lead California against attacks.'],
      ['Housing', 'Build more affordable housing and make the California Dream possible.'],
      ['Economy and Affordability', 'Lower costs, raise stability, and put families first.'],
      ['Energy and Utilities', 'Clean energy, lower bills, shared benefits.'],
      ['Disaster Preparedness & Resilience', 'Protect people, prevent harm, recover fairly and fast.'],
      ['Innovation That Works for Everyone', 'Artificial Intelligence should broaden opportunity.'],
      ['Homelessness', 'A moral emergency and policy failure that needs different governing.'],
    ];
    const imageList = Array.from(images);
    const heroImage = imageList.find((url) => /priorities\.jpg/i.test(url)) || imageList[0] || '';
    const logoImage = imageList.find((url) => /logo\.png/i.test(url)) || '';
    const accentImage = imageList.find((url) => /accent-headshot\.png/i.test(url)) || '';

    return [
      '<!doctype html><html><head>',
      '<meta charset="utf-8"><base href="https://www.xavierbecerra2026.com/priorities/">',
      '<title>Xavier Becerra 2026 fallback assets</title>',
      '<link rel="stylesheet" href="https://use.typekit.net/kqq8cdw.css">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">',
      '<style>:root{--xb-blue:#005596;--xb-red:#e31b23;--xb-white:#ffffff;--xb-offwhite:#f8f9fa}*{box-sizing:border-box}body{margin:0;font-family:Poppins,system-ui,sans-serif;color:#123;background:#f8f9fa}.top{display:flex;align-items:center;justify-content:space-between;padding:22px 40px;background:white;border-bottom:1px solid #dfe5ec}.logo{max-height:54px;max-width:250px}.hero{min-height:360px;display:grid;align-items:end;padding:56px 40px;color:white;background:#005596;background-size:cover;background-position:center}.hero h1{margin:0;font-size:clamp(48px,9vw,112px);line-height:.9;font-weight:800;text-transform:uppercase}.hero p{max-width:820px;font-size:22px;line-height:1.45;font-weight:600}.wrap{max-width:1180px;margin:0 auto;padding:44px 24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}.card{min-height:180px;border-radius:18px;background:white;border:1px solid #dfe5ec;padding:24px;box-shadow:0 10px 28px rgba(0,0,0,.06)}.card h2{margin:0 0 12px;color:#005596;font-size:25px;line-height:1.05}.card p{margin:0;color:#334155;line-height:1.45}.accent{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,360px);gap:32px;align-items:center;margin-top:36px;padding:28px;border-radius:22px;background:white;border:1px solid #dfe5ec}.accent img{width:100%;height:auto;border-radius:18px}@media(max-width:760px){.top{padding:18px 20px}.hero{padding:42px 22px}.accent{grid-template-columns:1fr}}</style>',
      '</head><body>',
      '<header class="top">',
      logoImage ? `<img class="logo" src="${escapeHtml(logoImage)}" alt="Xavier Becerra 2026">` : '<strong>Xavier Becerra 2026</strong>',
      '<strong style="color:#e31b23">Governor</strong>',
      '</header>',
      `<section class="hero" style="background-image:linear-gradient(90deg,rgba(0,85,150,.9),rgba(0,85,150,.45)),url('${escapeHtml(heroImage)}')"><div><h1>Priorities</h1><p>${escapeHtml(intro)}</p></div></section>`,
      '<main class="wrap"><section class="grid">',
      priorityCards.map(([title, body]) => `<article class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></article>`).join(''),
      '</section>',
      '<section class="accent"><div><h2 style="margin:0 0 12px;color:#005596;font-size:38px">California Dream</h2><p style="margin:0;color:#334155;font-size:18px;line-height:1.55">Fallback preview generated from public reader content and known loaded assets because the live page blocks automated HTML fetches.</p></div>',
      accentImage ? `<img src="${escapeHtml(accentImage)}" alt="Campaign accent">` : '',
      '</section></main>',
      '</body></html>',
    ].join('');
  } catch {
    return '';
  }
};

const extractReaderFallbackAssets = async (targetUrl: string, options: { videosOnly?: boolean } = {}) => {
  const readerText = await withTimeout(
    fetchReaderFallbackText(targetUrl),
    24000,
    `Reader fallback for ${targetUrl}`
  ).catch(() => '');
  const fallbackHtml = buildKnownBlockedSiteFallbackHtml(targetUrl, readerText);
  const sourceText = fallbackHtml || readerText;
  if (!sourceText) return { images: [], videos: [], fonts: [], colors: [] };
  return extractStaticAssets(targetUrl, sourceText, { fast: true, videosOnly: options.videosOnly });
};

const fetchSiteHtmlViaBrowser = async (siteUrl: string) => {
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  let page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>> | null = null;
  try {
    browser = await launchPuppeteerBrowser(activeExtractionProxyUrl);
    page = await acquireSingleWebsitePage(browser);
    await applyProxyAuthToPage(page);
    await applyPuppeteerStealth(page);
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => undefined);
    return await waitForRenderedSiteHtml(page);
  } finally {
    await page?.close().catch(() => undefined);
    await closePuppeteerBrowser(browser);
  }
};

const DEFAULT_ASSET_STATUS = 'path-only';

const withAssetStatus = (asset: any, status = DEFAULT_ASSET_STATUS) =>
  asset?.url ? { ...asset, status: asset.status || status } : asset;

const normalizeCssFontFamilyName = (family: string) => {
  const raw = String(family || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\\\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const nextFont = raw.match(/^__([A-Za-z0-9_]+?)_[a-f0-9]+$/i);
  if (nextFont?.[1]) {
    return nextFont[1].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const nextFallback = raw.match(/^__([A-Za-z0-9_]+?)_Fallback_[a-f0-9]+$/i);
  if (nextFallback?.[1]) {
    return nextFallback[1].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return raw;
};

const extractFontsFromCss = (cssText: string, baseUrl: string) => {
  const fonts: any[] = [];
  const fontFaceRegex = /@font-face\s*\{([^}]+)\}/gi;
  let match;

  while ((match = fontFaceRegex.exec(cssText)) !== null) {
    const block = match[1];
    const fontFamilyMatch = block.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/i);
    const srcMatches = Array.from(block.matchAll(/src\s*:\s*([^;]+)/gi));

    if (fontFamilyMatch && srcMatches.length > 0) {
      const fontFamily = normalizeCssFontFamilyName(fontFamilyMatch[1]);
      const fontWeightMatch = block.match(/font-weight\s*:\s*([^;]+)/i);
      const fontStyleMatch = block.match(/font-style\s*:\s*([^;]+)/i);
      const unicodeRange = block.match(/unicode-range\s*:\s*([^;]+)/i)?.[1]?.trim() || '';
      const candidates: any[] = [];
      for (const srcMatch of srcMatches) {
        const srcPartRegex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)\s*(?:format\(\s*['"]?([^'")]+?)['"]?\s*\))?/gi;
        let srcPart: RegExpExecArray | null;
        while ((srcPart = srcPartRegex.exec(srcMatch[1])) !== null) {
          const urlStr = srcPart[1];
          const formatHint = srcPart[2] || '';
          const absoluteUrl = resolveUrl(baseUrl, urlStr);
          if (!absoluteUrl || absoluteUrl.startsWith('data:')) continue;
          const format = inferFontFormatFromCssSrc(absoluteUrl, formatHint);
          if (!isSupportedFontFormat(format)) continue;
          candidates.push({
            family: fontFamily,
            url: absoluteUrl,
            format,
            cssSource: baseUrl,
            weight: fontWeightMatch?.[1]?.trim() || undefined,
            style: fontStyleMatch?.[1]?.trim() || undefined,
            unicodeRange,
            source: '@font-face',
            status: DEFAULT_ASSET_STATUS,
          });
        }
      }
      if (candidates.length > 0) {
        const gstatic = candidates.find((candidate) => /fonts\.gstatic\.com/i.test(String(candidate?.url || '')));
        const best =
          gstatic ||
          candidates.sort((a, b) => scoreFontCssCandidate(b) - scoreFontCssCandidate(a))[0];
        const familyLabel = String(best?.family || '');
        const bestUrl = String(best?.url || '');
        if (/BarlowCondensed/i.test(familyLabel) && !/fonts\.gstatic\.com/i.test(bestUrl)) {
          continue;
        }
        if (/Dobra/i.test(familyLabel) && !/fonts\.gstatic\.com/i.test(bestUrl)) {
          continue;
        }
        fonts.push(best);
      }
    }
  }
  return fonts;
};

const inferFontFormatFromCssSrc = (url: string, formatHint = '', contentType = '') => {
  const hinted = String(formatHint || contentType || '').toLowerCase().replace(/['"]/g, '');
  if (hinted.includes('woff2')) return 'woff2';
  if (hinted.includes('woff')) return 'woff';
  if (hinted.includes('opentype') || hinted.includes('otf')) return 'otf';
  if (hinted.includes('truetype') || hinted.includes('ttf')) return 'ttf';
  return getFontFormatFromUrlOrType(url, contentType);
};

const getFontFormatFromUrlOrType = (url: string, contentType = '') => {
  const value = `${url} ${contentType}`.toLowerCase();
  if (value.includes('.woff2') || value.includes('font/woff2')) return 'woff2';
  if (value.includes('.woff') || value.includes('font/woff')) return 'woff';
  if (value.includes('.ttf') || value.includes('font/ttf')) return 'ttf';
  if (value.includes('.otf') || value.includes('font/otf')) return 'otf';
  if (value.includes('.eot') || value.includes('vnd.ms-fontobject')) return 'eot';
  if (/use\.typekit\.net\/af\/.+\/(?:\d+\/)?l(?:\?|$)/i.test(url)) return 'woff2';
  if (/use\.typekit\.net\/af\/.+\/(?:\d+\/)?d(?:\?|$)/i.test(url)) return 'woff';
  if (/use\.typekit\.net\/af\/.+\/(?:\d+\/)?a(?:\?|$)/i.test(url)) return 'otf';
  return 'unknown';
};

const SUPPORTED_FONT_FORMATS = new Set(['woff2', 'woff', 'ttf', 'otf']);

const FONT_FORMAT_PRIORITY: Record<string, number> = {
  woff2: 3,
  woff: 2,
  otf: 2,
  ttf: 1,
};

const scoreFontCssCandidate = (candidate: any) => {
  let score = FONT_FORMAT_PRIORITY[String(candidate?.format || '').toLowerCase()] || 0;
  const url = String(candidate?.url || '').toLowerCase();
  const family = String(candidate?.family || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
  const familySlug = family.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  const urlBase = (url.split('/').pop() || '').replace(/\.[^.]+$/, '').toLowerCase();
  const urlSlug = urlBase.replace(/[^a-z0-9]+/g, '');

  if (familySlug && (urlSlug.includes(familySlug) || familySlug.includes(urlSlug))) score += 24;
  else {
    const familyTokens = family
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    const matchedTokens = familyTokens.filter((token) => urlBase.includes(token)).length;
    score += matchedTokens * 7;
  }

  const familyItalic = /italic/i.test(family);
  const urlItalic = /italic/i.test(urlBase);
  if (familyItalic !== urlItalic) score -= 18;

  if (/fonts\.gstatic\.com/i.test(url)) score += 22;
  if (/-ttf\.ttf(\?|$)/i.test(url)) score += 10;
  else if (/-woff\.woff(\?|$)/i.test(url)) score += 6;
  else if (/-woff2\.woff2(\?|$)/i.test(url)) score += 4;
  return score;
};

const isSupportedFontFormat = (format: string) => SUPPORTED_FONT_FORMATS.has(String(format || '').toLowerCase());

const isSupportedFontAsset = (font: any) => {
  if (!font?.url || String(font.url).startsWith('data:')) return false;
  const format = getFontFormatFromUrlOrType(String(font.url), String(font.format || ''));
  return isSupportedFontFormat(format);
};

const getVideoFormatFromUrlOrType = (url: string, contentType = '') => {
  const value = `${url} ${contentType}`.toLowerCase();
  if (/\.mp4(\?|$)/i.test(value) || value.includes('video/mp4')) return 'mp4';
  if (/\.webm(\?|$)/i.test(value) || value.includes('video/webm')) return 'webm';
  if (/\.mov(\?|$)/i.test(value) || value.includes('quicktime')) return 'mov';
  if (/\.m3u8(\?|$)/i.test(value) || value.includes('mpegurl')) return 'm3u8';
  if (/\.mpd(\?|$)/i.test(value) || value.includes('dash+xml')) return 'mpd';
  if (/\.mkv(\?|$)/i.test(value) || value.includes('matroska')) return 'mkv';
  return getAssetTypeFromUrl(url, 'video');
};

const extractCssImports = (cssText: string, baseUrl: string) => {
  const imports: string[] = [];
  const importRegex = /@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi;
  let match;
  while ((match = importRegex.exec(cssText)) !== null) {
    const absolute = resolveUrl(baseUrl, match[1]);
    if (absolute) imports.push(absolute);
  }
  return imports;
};

const prioritizeFontCssCandidates = (cssUrls: string[]) => {
  const score = (url: string) => {
    const lowered = String(url || '').toLowerCase();
    if (/use\.typekit\.net|p\.typekit\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(lowered)) return 100;
    if (/\/themes\/custom\//.test(lowered)) return 80;
    if (/\/_next\/static\/css\//.test(lowered)) return 70;
    if (/en-main|main\.css|typography|\/font/.test(lowered)) return 60;
    if (/\/themes\//.test(lowered)) return 40;
    return 0;
  };
  return Array.from(new Set(cssUrls)).sort((a, b) => score(b) - score(a));
};

const extractExternalFontCssUrls = (text: string, baseUrl: string) => {
  const urls = new Set<string>();
  const normalizedText = String(text || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const patterns = [
    /https?:\/\/use\.typekit\.net\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/p\.typekit\.net\/[^"'()\s<>]+/gi,
    /https?:\/\/fonts\.googleapis\.com\/[^"'()\s<>]+/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/fonts\/[^"'()\s<>]+/gi,
  ];
  patterns.forEach((pattern) => {
    (normalizedText.match(pattern) || []).forEach((raw) => {
      const resolved = resolveUrl(baseUrl, raw);
      if (resolved) urls.add(resolved);
    });
  });
  return Array.from(urls);
};

const fetchCssSourceCandidates = async (siteUrl: string, preloadedHtml = '', options: { fast?: boolean } = {}) => {
  assertPublicAssetUrl(siteUrl);
  const cssUrls = new Set<string>();
  const inlineStyles: Array<{ css: string; source: string }> = [];
  const visitedCss = new Set<string>();
  const queue: string[] = [];

  const html = preloadedHtml || await fetchSiteHtml(siteUrl);
  const $ = cheerio.load(html);

  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    const abs = href ? resolveUrl(siteUrl, href) : null;
    if (abs) {
      try {
        assertPublicAssetUrl(abs);
        cssUrls.add(abs);
      } catch {
        // Ignore private/local stylesheet references.
      }
    }
  });

  $('style').each((_, el) => {
    const cssText = $(el).html();
    if (cssText && cssText.trim()) {
      inlineStyles.push({ css: cssText, source: siteUrl });
    }
  });

  extractExternalFontCssUrls(html, siteUrl).forEach((fontCssUrl) => {
    try {
      assertPublicAssetUrl(fontCssUrl);
      cssUrls.add(fontCssUrl);
    } catch {
      // Ignore private/local stylesheet references.
    }
  });

  queue.push(...prioritizeFontCssCandidates(Array.from(cssUrls)).slice(0, options.fast ? 20 : 36));

  const fetchedCss: Array<{ css: string; source: string }> = [];
  const fetchOneStylesheet = async (current: string) => {
    try {
      assertPublicAssetUrl(current);
      const cssResponse = await axios.get(current, {
        timeout: options.fast ? 6000 : 8000,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/css,*/*;q=0.1',
        },
      });
      const cssText = String(cssResponse.data || '');
      if (!cssText || !cssText.trim()) return null;
      return {
        css: cssText,
        source: current,
        imports: extractCssImports(cssText, current),
      };
    } catch {
      return null;
    }
  };

  if (options.fast) {
    const targets = queue.filter((url) => !visitedCss.has(url)).slice(0, 8);
    targets.forEach((url) => visitedCss.add(url));
    const results = await mapWithConcurrency(targets, 6, (url) => fetchOneStylesheet(url));
    const priorityImports = new Set<string>();
    results.filter(Boolean).forEach((entry) => {
      if (!entry) return;
      entry.imports.forEach((importUrl) => {
        if (/use\.typekit\.net|p\.typekit\.net|fonts\.googleapis\.com/i.test(importUrl)) {
          priorityImports.add(importUrl);
        }
      });
      if (entry.css.length <= 2_000_000) fetchedCss.push({ css: entry.css, source: entry.source });
    });
    const importedResults = await mapWithConcurrency(
      Array.from(priorityImports).filter((url) => !visitedCss.has(url)).slice(0, 12),
      6,
      (url) => fetchOneStylesheet(url)
    );
    importedResults.filter(Boolean).forEach((entry) => {
      if (entry?.css) fetchedCss.push({ css: entry.css, source: entry.source });
    });
    return { inlineStyles, fetchedCss };
  }

  let hops = 0;
  while (queue.length > 0 && hops < 18) {
    const current = queue.shift()!;
    if (visitedCss.has(current)) continue;
    visitedCss.add(current);
    hops++;
    const entry = await fetchOneStylesheet(current);
    if (!entry) continue;
    fetchedCss.push({ css: entry.css, source: entry.source });
    entry.imports.forEach((importUrl) => {
      try {
        assertPublicAssetUrl(importUrl);
        if (!visitedCss.has(importUrl)) queue.push(importUrl);
      } catch {
        // Ignore private/local CSS imports.
      }
    });
  }

  return { inlineStyles, fetchedCss };
};

const fetchImportedFontProviderFonts = async (siteUrl: string, html: string) => {
  const $ = cheerio.load(html);
  const stylesheetUrls = new Set<string>();
  const providerUrls = new Set<string>(extractExternalFontCssUrls(html, siteUrl));

  $('link[href]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    const href = $(el).attr('href');
    const absoluteUrl = href ? resolveUrl(siteUrl, href) : null;
    if (!absoluteUrl) return;
    if (!rel.includes('stylesheet') && !/\/_next\/static\/css\/|\.css(?:[?#]|$)/i.test(absoluteUrl)) return;
    if (absoluteUrl) stylesheetUrls.add(absoluteUrl);
  });

  const fetchCss = async (url: string) => {
    try {
      assertPublicAssetUrl(url);
      const response = await axios.get(url, {
        timeout: 8000,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        validateStatus: (status) => status === 200,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/css,*/*;q=0.1',
          Referer: siteUrl,
        },
      });
      return String(response.data || '');
    } catch {
      return '';
    }
  };

  const likelyFontStylesheets = prioritizeFontCssCandidates(Array.from(stylesheetUrls)).slice(0, 8);
  const linkedCss = await mapWithConcurrency(likelyFontStylesheets, 6, fetchCss);
  linkedCss.forEach((cssText, index) => {
    if (!cssText) return;
    const source = likelyFontStylesheets[index] || siteUrl;
    extractCssImports(cssText, source).forEach((importUrl) => {
      if (/use\.typekit\.net|p\.typekit\.net|fonts\.googleapis\.com/i.test(importUrl)) providerUrls.add(importUrl);
    });
    extractExternalFontCssUrls(cssText, source).forEach((fontCssUrl) => providerUrls.add(fontCssUrl));
  });

  const linkedFonts = linkedCss.flatMap((cssText, index) =>
    cssText ? extractFontsFromCss(cssText, likelyFontStylesheets[index] || siteUrl) : []
  );

  const providerCssUrls = Array.from(providerUrls).slice(0, 16);
  const providerCss = await mapWithConcurrency(providerCssUrls, 8, fetchCss);
  return linkedFonts.concat(providerCss.flatMap((cssText, index) =>
    cssText ? extractFontsFromCss(cssText, providerCssUrls[index] || siteUrl) : []
  ));
};

// Helper to extract colors from CSS
const extractColorsFromCss = (cssText: string) => {
  const colors: string[] = [];
  const hexRegex = /#(?:[0-9a-fA-F]{3}){1,2}\b|#(?:[0-9a-fA-F]{4}){1,2}\b/g;
  const rgbRegex = /(?:rgb|rgba)\([^)]+\)/gi;
  const hslRegex = /(?:hsl|hsla)\([^)]+\)/gi;

  let match;
  while ((match = hexRegex.exec(cssText)) !== null) {
    colors.push(match[0].toLowerCase());
  }
  while ((match = rgbRegex.exec(cssText)) !== null) {
    colors.push(match[0].toLowerCase().replace(/\s+/g, ''));
  }
  while ((match = hslRegex.exec(cssText)) !== null) {
    colors.push(match[0].toLowerCase().replace(/\s+/g, ''));
  }
  return colors;
};

const normalizeColorToHex = (raw: string) => {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'transparent' || value === 'inherit' || value === 'currentcolor' || value === 'none' || value.startsWith('var(')) {
    return null;
  }

  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{8}$/.test(value)) return value.slice(0, 7);

  const rgbMatch = value.match(/^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (rgbMatch) {
    const r = Math.min(255, Number(rgbMatch[1]));
    const g = Math.min(255, Number(rgbMatch[2]));
    const b = Math.min(255, Number(rgbMatch[3]));
    if (![r, g, b].every((channel) => Number.isFinite(channel))) return null;
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  const named: Record<string, string> = {
    white: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    blue: '#0000ff',
    green: '#008000',
  };
  return named[value] || null;
};

const getPrimaryExtractedColors = (colors: string[]) => {
  const counts = new Map<string, number>();
  colors.forEach((raw) => {
    const hex = normalizeColorToHex(String(raw || '').trim().toLowerCase().replace(/\s+/g, ''));
    if (hex) counts.set(hex, (counts.get(hex) || 0) + 1);
  });

  const ranked = Array.from(counts.entries())
    .map(([hex, count]) => {
      const rgb = {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
      };
      const max = Math.max(rgb.r, rgb.g, rgb.b);
      const min = Math.min(rgb.r, rgb.g, rgb.b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
      const neutral = saturation < 0.12;
      const extremeNeutral = neutral && (luminance < 0.08 || luminance > 0.92);
      const score =
        Math.log2(count + 1) * 40 +
        saturation * 35 +
        (extremeNeutral ? 24 : 0) -
        (neutral && !extremeNeutral ? 10 : 0);
      return { hex, rgb, count, saturation, luminance, neutral, score };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count);

  const distance = (left: (typeof ranked)[number], right: (typeof ranked)[number]) =>
    Math.sqrt(
      (left.rgb.r - right.rgb.r) ** 2 +
      (left.rgb.g - right.rgb.g) ** 2 +
      (left.rgb.b - right.rgb.b) ** 2
    );
  const selectDistinct = (pool: typeof ranked, limit: number, threshold: number) => {
    const selected: typeof ranked = [];
    for (const candidate of pool) {
      if (selected.every((existing) => distance(existing, candidate) >= threshold)) selected.push(candidate);
      if (selected.length >= limit) break;
    }
    return selected;
  };

  const chromatic = selectDistinct(ranked.filter((color) => !color.neutral), 7, 52);
  const neutrals = selectDistinct(ranked.filter((color) => color.neutral), 3, 48);
  return [...chromatic, ...neutrals]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((color) => color.hex);
};

const SUPPORTED_IMAGE_EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] as const;

const IMAGE_CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const normalizeImageExtension = (ext: string) => {
  const value = String(ext || '').toLowerCase();
  if (value === 'jpeg') return 'jpg';
  if (value === 'svg+xml') return 'svg';
  return value;
};

const isSupportedImageExtension = (ext: string) => {
  const normalized = normalizeImageExtension(ext);
  return SUPPORTED_IMAGE_EXTENSIONS.includes(normalized as (typeof SUPPORTED_IMAGE_EXTENSIONS)[number]);
};

const decodeCssUrlValue = (value: string) =>
  String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\(.)/g, '$1')
    .trim();

const PRESERVE_IMAGE_QUERY_KEYS =
  /[?&](?:context|id|mediaid|assetid|uuid|hash|token|sig|signature|expires|exp|key|fmt|format|fm|wid|width|w|hei|height|h|qlt|quality|q|bg|extend|crop|fit|resize)=/i;

const sanitizeExtractedImageUrl = (value: string) => {
  const cleaned = decodeCssUrlValue(value).trim();
  const extMatch = cleaned.match(/^([^"'()<>\s;]+(?:\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'()<>\s;?]+)*)?)(\?[^"'()\s;>]*)?/i);
  if (extMatch?.[1]) {
    const base = extMatch[1].split('#')[0];
    const query = extMatch[2] || '';
    if (!/\.(?:svg|png|jpe?g|webp|gif|avif)(?:$|[/?#])/i.test(base)) {
      return cleaned.replace(/[);,\s]+$/g, '');
    }
    const svgFragment = /\.svg(?:$|[/?#])/i.test(base)
      ? cleaned.match(/(#[A-Za-z_][\w:.-]*)\s*$/)?.[1] || ''
      : '';
    if (query && PRESERVE_IMAGE_QUERY_KEYS.test(query)) {
      return `${base}${query}${svgFragment}`;
    }
    return `${base}${svgFragment}`;
  }
  return cleaned.replace(/[);,\s]+$/g, '');
};

const extensionFromPathname = (urlOrPath: string) => {
  const match = String(urlOrPath || '').match(/\.(svg|png|jpe?g|webp|gif|avif)(?:$|[?#])/i);
  return match ? normalizeImageExtension(match[1]) : '';
};

const inferImageTypeFromUrl = (url: string, contentType = '') => {
  const lowered = String(url || '').toLowerCase();
  const pathExt = extensionFromPathname(lowered);
  if (pathExt && isSupportedImageExtension(pathExt)) return pathExt;

  const queryMatch = lowered.match(/[?&](?:format|fm|ext|type|output)=(svg|png|jpe?g|webp|gif|avif)/i);
  if (queryMatch?.[1]) return normalizeImageExtension(queryMatch[1]);

  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (IMAGE_CONTENT_TYPE_TO_EXT[ct]) return IMAGE_CONTENT_TYPE_TO_EXT[ct];

  if (/^data:image\/([a-z0-9.+-]+)/i.test(lowered)) {
    const dataMatch = lowered.match(/^data:image\/([a-z0-9.+-]+)/i);
    return normalizeImageExtension(dataMatch?.[1] || '');
  }

  return '';
};

const inferImageTypeFromContentType = (contentType: string) => {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  return IMAGE_CONTENT_TYPE_TO_EXT[ct] || '';
};

const detectImageFormatFromBuffer = (buffer: Buffer) => {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  const gifHead = buffer.slice(0, 6).toString('ascii');
  if (gifHead === 'GIF87a' || gifHead === 'GIF89a') return 'gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp' && buffer.slice(8, 12).toString('ascii').includes('avif')) return 'avif';
  const head = buffer.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.includes('<svg')) return 'svg';
  return '';
};

const normalizeSvgBufferForIllustrator = (buffer: Buffer) => {
  if (!buffer?.length || detectImageFormatFromBuffer(buffer) !== 'svg') return buffer;
  let svg = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  const svgStart = svg.search(/<svg\b/i);
  if (svgStart > 0) {
    const prefix = svg.slice(0, svgStart).trim();
    // Preserve valid XML declarations/comments, but remove accidental text before <svg>.
    if (!/^<\?xml\b|^<!--/i.test(prefix)) svg = svg.slice(svgStart).trim();
  }
  svg = svg.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  // Some sites export Illustrator/Serif metadata such as `serif:id` without
  // declaring the `xmlns:serif` namespace. Browsers then reject the SVG as
  // invalid XML. The metadata is not required for rendering, so remove it.
  svg = svg.replace(/\sserif:[\w.-]+=(?:"[^"]*"|'[^']*')/gi, '');
  // CSS variables are also fragile in Illustrator and standalone SVG viewers.
  // Keep the fallback color from `var(--token,#hex)` so the artwork remains
  // self-contained after download.
  svg = svg.replace(/var\(\s*--[^,\)]+,\s*([^)]+?)\s*\)/gi, (_match, fallback) => String(fallback || '#000000').trim());
  svg = svg.replace(/var\(\s*--[^)]+\)/gi, '#000000');
  const tagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!tagMatch) return buffer;
  let tag = tagMatch[0];
  if (!/\sxmlns=/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/\bxlink:href=/i.test(svg) && !/\sxmlns:xlink=/.test(tag)) {
    tag = tag.replace(/<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  if (!/\sxml:space=/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xml:space="preserve"');
  svg = svg.replace(tagMatch[0], tag);
  if (!/^<\?xml\b/i.test(svg)) {
    svg = `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`;
  }
  return Buffer.from(`${svg.trim()}\n`, 'utf8');
};

/** Turn an external SVG sprite reference (`sprite.svg#symbol-id`) into a
 * self-contained SVG. Browsers resolve fragment references automatically, but
 * Illustrator and downloaded files do not render a sprite's <symbol> by itself.
 */
const materializeSvgFragmentForIllustrator = (buffer: Buffer, sourceUrl = '') => {
  if (!buffer?.length || detectImageFormatFromBuffer(buffer) !== 'svg') return buffer;
  let fragment = '';
  try {
    fragment = decodeURIComponent(new URL(String(sourceUrl || '')).hash.slice(1));
  } catch {
    fragment = String(sourceUrl || '').match(/#([^#?]+)$/)?.[1] || '';
  }
  if (!fragment) return normalizeSvgBufferForIllustrator(buffer);

  try {
    const $ = cheerio.load(buffer.toString('utf8'), { xmlMode: true });
    const target = $('[id]').filter((_: number, el: any) => String($(el).attr('id') || '') === fragment).first();
    if (!target.length) return normalizeSvgBufferForIllustrator(buffer);

    const root = $('svg').first();
    const viewBox = target.attr('viewBox') || root.attr('viewBox') || '';
    const width = target.attr('width') || root.attr('width') || '';
    const height = target.attr('height') || root.attr('height') || '';
    const presentationAttrs = ['fill', 'stroke', 'color', 'preserveAspectRatio']
      .map((name) => target.attr(name) ? ` ${name}="${escapeXmlAttribute(String(target.attr(name)))}"` : '')
      .join('');
    const shared = root.children('defs, style').map((_: number, el: any) => $.html(el)).get().join('');
    const content = target.is('symbol') ? target.html() || '' : $.html(target);
    const title = target.find('title').first().text().trim() || fragment.replace(/^sprite-/, '');
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve"${viewBox ? ` viewBox="${escapeXmlAttribute(viewBox)}"` : ''}${width ? ` width="${escapeXmlAttribute(width)}"` : ''}${height ? ` height="${escapeXmlAttribute(height)}"` : ''}${presentationAttrs}>` +
      `${title && !/<title\b/i.test(content) ? `<title>${escapeXmlAttribute(title)}</title>` : ''}${shared}${content}</svg>\n`;
    return normalizeSvgBufferForIllustrator(Buffer.from(svg.replace(/currentColor/gi, '#000000'), 'utf8'));
  } catch {
    return normalizeSvgBufferForIllustrator(buffer);
  }
};

const isLikelyImageAssetUrl = (url: string, contentType = '') => {
  const lowered = String(url || '').toLowerCase();
  if (!lowered || lowered.startsWith('blob:') || lowered.startsWith('javascript:')) return false;
  if (lowered.startsWith('data:')) return /^data:image\//i.test(lowered);
  if (/\/wp-content\/uploads\//i.test(lowered)) return true;
  if (/\.(?:svg|png|jpe?g|webp|gif|avif|ashx)(?:$|[?#])/i.test(lowered)) return true;
  if (/\/\.imaging\/|\/dam\/jcr:/i.test(lowered)) return true;
  if (inferImageTypeFromUrl(url, contentType)) return true;
  if (/^image\//i.test(contentType)) return true;
  if (/(?:^|[/?])(?:images?|img|photos?|media|assets|static|uploads|thumbnails?|backgrounds?|banners?|avatars?|icons?)(?:\/|$)/i.test(lowered)) {
    if (!/\.(?:mp4|webm|mov|m3u8|mpd|css|js|woff2?|ttf|otf|eot|html?)(\?|$)/i.test(lowered)) return true;
  }
  if (/-\d+x\d+\.(?:jpe?g|png|webp|gif|avif)/i.test(lowered)) return true;
  return false;
};

const getAssetTypeFromUrl = (url: string, fallback = 'unknown') => {
  const imageType = inferImageTypeFromUrl(url);
  if (imageType) return imageType;
  let type = url.split('.').pop()?.split('?')[0].toLowerCase() || fallback;
  if (type.length > 5 || !/^[a-z0-9]+$/.test(type)) type = fallback;
  return type;
};

const isObviousNonImageUrl = (url: string) =>
  /\.(?:css|js|json|woff2?|ttf|otf|eot|mp4|webm|mov|m3u8|mpd|html?)(\?|$)/i.test(String(url || ''));

const isMalformedImageCandidateUrl = (url: string) => {
  const raw = String(url || '').replace(/&amp;/g, '&').trim();
  if (!raw) return true;
  const lowered = raw.toLowerCase();
  if (/%7b|%7d|[{}]/i.test(raw)) return true;
  if (/\.(?:mp4|webm|mov|m4v|mkv|m3u8|mpd)(?:[?#]|$)/i.test(lowered)) return true;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/{2,}/g, '/');
    const hasImageType = Boolean(inferImageTypeFromUrl(raw));
    const looksLikeImageService =
      /\/is\/image\/|\/image\/|\/images?\/|\/img\/|\/media\/|\/assets?\/|\/content\/dam\/|\/\.imaging\//i.test(path) ||
      /[?&](?:fmt|format|fm|output)=(?:svg|png|jpe?g|webp|gif|avif|png-alpha|webp-alpha)/i.test(parsed.search);
    if (!hasImageType && !looksLikeImageService) return true;
    // Srcset parsing can accidentally turn width descriptors or JSON fragments
    // into page-relative URLs like /tacoma/3&wid=1024. Those are not images.
    if (!hasImageType && /\/\d{1,3}(?:&|$)/.test(path)) return true;
    return false;
  } catch {
    return true;
  }
};

const createImageAsset = (
  urlStr: string | undefined,
  baseUrl: string,
  meta: Record<string, any> = {},
  options: { permissive?: boolean } = {}
) => {
  if (!urlStr) return null;
  const trimmed = sanitizeExtractedImageUrl(urlStr);
  if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:') || trimmed.startsWith('#')) return null;

  if (trimmed.startsWith('data:')) {
    if (!/^data:image\//i.test(trimmed)) return null;
    const type = inferImageTypeFromUrl(trimmed) || 'unknown';
    return { url: trimmed, type, status: DEFAULT_ASSET_STATUS, ...meta };
  }

  const absoluteUrl = resolveUrl(baseUrl, trimmed);
  if (!absoluteUrl) return null;
  if (isObviousNonImageUrl(absoluteUrl)) return null;
  if (isMalformedImageCandidateUrl(absoluteUrl)) return null;
  if (isJunkImageUrl(absoluteUrl)) return null;
  if (hasMalformedImageSequencePath(absoluteUrl)) return null;
  if (!isLikelyImageAssetUrl(absoluteUrl)) return null;

  const type = inferImageTypeFromUrl(absoluteUrl) || getAssetTypeFromUrl(absoluteUrl, 'img');
  let filename = filenameFromUrlPath(absoluteUrl);
  if (type === 'svg') {
    try {
      const fragment = decodeURIComponent(new URL(absoluteUrl).hash.slice(1));
      if (fragment) filename = `${sanitizeFilenameBase(fragment.replace(/^sprite-/, '')) || 'svg-symbol'}.svg`;
    } catch {
      // Keep the path-derived filename.
    }
  }
  return {
    url: absoluteUrl,
    type,
    status: DEFAULT_ASSET_STATUS,
    ...(filename ? { filename } : {}),
    ...meta,
  };
};

const pushImageAsset = (images: any[], asset: any | null) => {
  if (asset?.url) images.push(asset);
};

const addImageCandidate = (
  images: any[],
  urlStr: string | undefined,
  baseUrl: string,
  meta?: Record<string, any>,
  options?: { permissive?: boolean }
) => {
  pushImageAsset(images, createImageAsset(urlStr, baseUrl, meta || {}, options));
};

const addSrcsetCandidates = (images: any[], srcset: string | undefined, baseUrl: string) => {
  if (!srcset) return;
  try {
    parseSrcset(srcset).forEach((part) => addImageCandidate(images, part.url, baseUrl, undefined, { permissive: true }));
  } catch {
    srcset.split(/,\s+/).forEach((part) => addImageCandidate(images, part.trim().split(/\s+/)[0], baseUrl, undefined, { permissive: true }));
  }
};

const MAX_IMAGE_SEQUENCE_FRAMES = 120;

const isLikely360SequenceUrl = (value: string) =>
  /(?:threesixty|360|jellies|vehicle|lexus|aemassets|assetscs|visualizer)/i.test(String(value || ''));

const isToyotaVehicleExtractionTarget = (value: string) => {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return host.endsWith('toyota.com') && /\/(?:espanol\/)?tacoma\/?$/i.test(path);
  } catch {
    return /toyota\.com\/(?:espanol\/)?tacoma\/?$/i.test(String(value || '').trim());
  }
};

const shouldSuppressToyotaSequenceAutoExpansion = (targetUrl: string) =>
  isToyotaVehicleExtractionTarget(targetUrl);

const hasMalformedImageSequencePath = (value: string) => {
  const raw = String(value || '').replace(/&amp;/g, '&').trim();
  if (!raw || !isLikely360SequenceUrl(raw)) return false;
  try {
    const parsed = new URL(raw);
    return /\/{2,}/.test(parsed.pathname);
  } catch {
    return /\/{2,}/.test(raw.split('?')[0] || '');
  }
};

const defaultImageSequenceCountForUrl = (value: string) => {
  String(value || '');
  return 0;
};

const expandImageSequenceUrl = (rawUrl: string, baseUrl: string, hintedCount = 0) => {
  const absolute = resolveUrl(baseUrl, String(rawUrl || '').replace(/&amp;/g, '&').trim());
  if (!absolute || !isLikely360SequenceUrl(absolute)) return [];
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return [];
  }
  if (parsed.pathname.includes('//')) return [];
  const numericLeafMatch = parsed.pathname.match(/^(.*\/)(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const prefixedLeafMatch = parsed.pathname.match(/^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const match = numericLeafMatch || prefixedLeafMatch;
  if (!match) return [];
  const frame = Number(match[2]);
  if (!Number.isFinite(frame) || frame < 1) return [];
  const pathParts = match[1].split('/').filter(Boolean);
  const pathCount = Number(pathParts[pathParts.length - 1] || 0);
  const commonSequenceCounts = new Set([4, 18, 24, 36, 72, 120]);
  const hasExplicitFrameCountPath = Boolean(
    numericLeafMatch &&
      pathCount >= 2 &&
      pathCount <= MAX_IMAGE_SEQUENCE_FRAMES &&
      ((hintedCount >= 2 && hintedCount <= MAX_IMAGE_SEQUENCE_FRAMES && pathCount === hintedCount) ||
        commonSequenceCounts.has(pathCount))
  );
  const hasPrefixedFrameName = Boolean(
    prefixedLeafMatch &&
      /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(absolute)
  );
  // Do not infer a full Toyota/Lexus 360 sequence from ordinary jelly
  // product images like /limited/7582/3u5/1.png. Toyota often exposes only
  // frames 1-4 at that path, while generated /5.png.../36.png URLs 404 and
  // create blank thumbnail cards. Only expand when the URL itself carries the
  // explicit count segment (/36/1.png) or a true prefixed frame name
  // (for example Lexus large-1.jpg).
  if (!hasExplicitFrameCountPath && !hasPrefixedFrameName) return [];
  const count =
    hasExplicitFrameCountPath
      ? pathCount
      : hintedCount >= 2 && hintedCount <= MAX_IMAGE_SEQUENCE_FRAMES
        ? hintedCount
        : defaultImageSequenceCountForUrl(absolute);
  if (!count || frame > count) return [];
  return Array.from({ length: count }, (_, index) => {
    const clone = new URL(parsed.href);
    clone.pathname = `${match[1]}${index + 1}${match[3]}`;
    return {
      url: clone.href,
      frame: index + 1,
      count,
    };
  });
};

const extractImageSequencesFromText = (text: string, targetUrl: string) => {
  const images: any[] = [];
  const source = String(text || '').replace(/\\/g, '').replace(/&amp;/g, '&');
  const counts = Array.from(source.matchAll(/data-image-count=["']?(\d{1,3})/gi), (match) => Number(match[1])).filter(
    (count) => count >= 2 && count <= MAX_IMAGE_SEQUENCE_FRAMES
  );
  const hintedCount = counts.includes(36) ? 36 : counts[0] || 0;
  const urlRegex = /(?:https?:\/\/[^"'<>\s\\)]+|\/[^"'<>\s\\)]+)\.(?:png|jpe?g|webp|avif)(?:\?[^"'<>\s\\)]*)?/gi;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(source)) !== null) {
    expandImageSequenceUrl(match[0], targetUrl, hintedCount).forEach((frame) => {
      const frameUrl = frame.url;
      if (seen.has(frameUrl)) return;
      seen.add(frameUrl);
      images.push({
        url: frameUrl,
        type: inferImageTypeFromUrl(frameUrl) || getAssetTypeFromUrl(frameUrl, 'png'),
        filename: filenameFromUrlPath(frameUrl),
        source: '360-sequence',
        alt: `360 frame ${frame.frame}`,
        sequenceFrame: frame.frame,
        sequenceCount: frame.count,
        status: DEFAULT_ASSET_STATUS,
      });
    });
  }
  return images;
};

const LAZY_IMAGE_ATTRS = [
  'src',
  'data-src',
  'data-lazy-src',
  'data-lazy',
  'data-original',
  'data-original-src',
  'data-url',
  'data-image',
  'data-img',
  'data-bg',
  'data-background',
  'data-background-image',
  'data-thumb',
  'data-thumbnail',
  'data-poster',
  'data-hires',
  'data-retina',
  'data-full',
  'data-large',
  'data-medium',
  'data-small',
  'data-lazyload',
  'data-lazy-image',
  'data-iesrc',
  'data-src-small',
  'data-src-medium',
  'data-src-large',
  'data-src-retina',
  'data-flickity-lazyload',
];

const SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset'];

const extractInlineSvgsFromDom = ($: any, images: any[], options: { asIcons?: boolean } = {}) => {
  $('svg').each((index: number, el: any) => {
    // External <use> wrappers are not standalone artwork. The referenced sprite
    // fragment is collected separately and materialized during preview/download.
    if ($(el).find('use').toArray().some((use: any) => {
      const href = String($(use).attr('href') || $(use).attr('xlink:href') || '');
      return href && !href.startsWith('#');
    })) return;
    if (!$(el).attr('xmlns')) {
      $(el).attr('xmlns', 'http://www.w3.org/2000/svg');
    }
    const rawName = String(
      $(el).attr('id') ||
        $(el).attr('aria-label') ||
        $(el).find('title').first().text() ||
        `inline-svg-${index + 1}`
    ).trim();
    const safeName =
      sanitizeFilenameBase(rawName)
        .replace(/\.[^.]+$/i, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || `inline-svg-${index + 1}`;
    const svgString = $.html(el);
    const svgBuffer = Buffer.from(svgString, 'utf8');
    const dims = probeRasterDimensions(svgBuffer);
    images.push({
      url: `data:image/svg+xml;base64,${svgBuffer.toString('base64')}`,
      filename: `${safeName}.svg`,
      type: 'svg',
      isInlineSvg: true,
      assetCategory: options.asIcons ? 'icon' : undefined,
      bytes: svgBuffer.length,
      width: dims.width || undefined,
      height: dims.height || undefined,
      mimeType: 'image/svg+xml',
    });
  });
};

const classifyAssetIconCandidate = (item: any) => {
  if (item?.assetCategory === 'icon' || item?.isInlineSvg) return true;
  const url = String(item?.url || '').toLowerCase();
  if (/icon|favicon|sprite|glyph|logo-mark|brandmark|\/icons?\//i.test(url)) return true;
  if (/\.ico(?:\?|$)/i.test(url)) return true;
  const alt = String(item?.alt || '').toLowerCase();
  if (alt && /icon|logo|glyph|symbol/.test(alt)) return true;
  return false;
};

const splitImagesAndIcons = (items: any[]) => {
  const images: any[] = [];
  const icons: any[] = [];
  items.forEach((item) => {
    const enriched = classifyAssetIconCandidate(item) ? { ...item, assetCategory: 'icon' } : item;
    if (enriched.assetCategory === 'icon') icons.push(enriched);
    else images.push(enriched);
  });
  return { images, icons };
};

const extractIconsFromDom = ($: any, targetUrl: string) => {
  const icons: any[] = [];
  extractInlineSvgsFromDom($, icons, { asIcons: true });
  $('img').each((_: any, el: any) => {
    const cls = String($(el).attr('class') || '').toLowerCase();
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!/icon|glyph|logo|symbol|avatar|badge/i.test(`${cls} ${src}`)) return;
    const alt = $(el).attr('alt') || undefined;
    const meta = alt ? { alt, assetCategory: 'icon' } : { assetCategory: 'icon' };
    LAZY_IMAGE_ATTRS.forEach((attr) => addImageCandidate(icons, $(el).attr(attr), targetUrl, meta, { permissive: true }));
    addImageCandidate(icons, src, targetUrl, meta, { permissive: true });
  });
  $('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"], link[rel="mask-icon"]').each((_: any, el: any) => {
    addImageCandidate(icons, $(el).attr('href'), targetUrl, { assetCategory: 'icon' });
  });
  return icons;
};

const normalizeFontFamilyToken = (value: string) =>
  String(value || '')
    .split(',')[0]
    .replace(/^['"]|['"]$/g, '')
    .trim()
    .toLowerCase();

const normalizeFontFamilyName = (value: string) =>
  String(value || '')
    .split(',')[0]
    .replace(/^['"]|['"]$/g, '')
    .trim();

const isGenericCssFontFamily = (value: string) =>
  /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|emoji|math|fangsong)$/i.test(
    String(value || '').trim()
  );

const getBrowserFontFamilies = (computedFonts: Array<{ family: string; weight?: string; style?: string }> = []) =>
  Array.from(
    new Set(
      computedFonts
        .map((entry) => normalizeFontFamilyName(entry.family))
        .filter((family) => family && !isGenericCssFontFamily(family) && !isJunkFontLabel(family))
    )
  );

const inferBrowserFontFamilyForRecord = (
  font: any,
  browserFamilies: string[]
) => {
  if (browserFamilies.length === 0) return '';
  const current = normalizeFontFamilyName(String(font?.family || font?.title || font?.name || ''));
  if (current && !isJunkFontLabel(current) && !isGenericCssFontFamily(current)) return '';
  const cssSource = String(font?.cssSource || '');
  try {
    const parsed = new URL(cssSource);
    if (/fonts\.googleapis\.com/i.test(parsed.hostname)) {
      const familyParams = parsed.searchParams.getAll('family');
      const families = familyParams
        .map((value) => value.split(':')[0].replace(/\+/g, ' ').trim())
        .filter(Boolean);
      if (families.length === 1) return families[0];
    }
  } catch {
    // Keep browser-family fallback below.
  }
  if (browserFamilies.length === 1) return browserFamilies[0];
  return '';
};

const applyBrowserFontFamilyEvidence = (
  fonts: any[],
  computedFonts: Array<{ family: string; weight?: string; style?: string }> = []
) => {
  const browserFamilies = getBrowserFontFamilies(computedFonts);
  if (browserFamilies.length === 0) return fonts;
  return fonts.map((font) => {
    const inferred = inferBrowserFontFamilyForRecord(font, browserFamilies);
    if (!inferred) return font;
    return {
      ...font,
      family: inferred,
      browserResolvedFamily: inferred,
    };
  });
};

const filterFontsByComputedUsage = (fonts: any[], computedFonts: Array<{ family: string; weight?: string; style?: string }>) => {
  if (!computedFonts.length) return fonts;
  const wanted = computedFonts.map((entry) => ({
    family: normalizeFontFamilyToken(entry.family),
    weight: String(entry.weight || '400').replace(/\D/g, '') || '400',
    style: String(entry.style || 'normal').toLowerCase(),
  }));
  return fonts.filter((font) => {
    const family = normalizeFontFamilyToken(font?.family || '');
    if (!family || family === 'inherit') return false;
    return wanted.some((entry) => {
      if (!family.includes(entry.family) && !entry.family.includes(family)) return false;
      const fontWeight = String(font?.weight || '400').replace(/\D/g, '') || '400';
      const fontStyle = String(font?.style || 'normal').toLowerCase();
      if (entry.style !== 'normal' && fontStyle !== entry.style) return false;
      if (entry.weight !== fontWeight && entry.weight !== '400' && fontWeight !== '400') return false;
      return true;
    });
  });
};

const extractImagesFromCss = (cssText: string, baseUrl: string) => {
  const images: any[] = [];
  const urlRegex = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
  let match;
  while ((match = urlRegex.exec(cssText)) !== null) {
    addImageCandidate(images, decodeCssUrlValue(match[2]), baseUrl);
  }

  const imageSetRegex = /image-set\(([^)]+)\)/gi;
  while ((match = imageSetRegex.exec(cssText)) !== null) {
    const innerUrlRegex = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
    let innerMatch;
    while ((innerMatch = innerUrlRegex.exec(match[1])) !== null) {
      addImageCandidate(images, decodeCssUrlValue(innerMatch[2]), baseUrl);
    }
  }

  return images;
};

const extractImagesFromDom = ($: any, targetUrl: string, options: { scoped?: boolean } = {}) => {
  const images: any[] = [];

  $('img').each((_: any, el: any) => {
    const alt = $(el).attr('alt') || undefined;
    const meta = alt ? { alt } : undefined;
    LAZY_IMAGE_ATTRS.forEach((attr) => addImageCandidate(images, $(el).attr(attr), targetUrl, meta, { permissive: true }));
    SRCSET_ATTRS.forEach((attr) => addSrcsetCandidates(images, $(el).attr(attr), targetUrl));
  });

  $('picture source, source[type^="image/"]').each((_: any, el: any) => {
    addImageCandidate(images, $(el).attr('src'), targetUrl, undefined, { permissive: true });
    SRCSET_ATTRS.forEach((attr) => addSrcsetCandidates(images, $(el).attr(attr), targetUrl));
  });

  $('input[type="image"]').each((_: any, el: any) => {
    addImageCandidate(images, $(el).attr('src'), targetUrl, undefined, { permissive: true });
  });

  if (!options.scoped) {
    const metaSelectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[itemprop="image"]',
      'meta[name="thumbnail"]',
    ];
    metaSelectors.forEach((selector) => {
      $(selector).each((_: any, el: any) => addImageCandidate(images, $(el).attr('content'), targetUrl));
    });

    $('link[rel="preload"][as="image"]').each((_: any, el: any) => {
      addImageCandidate(images, $(el).attr('href'), targetUrl);
    });
  }

  $('svg image').each((_: any, el: any) => {
    addImageCandidate(images, $(el).attr('href'), targetUrl, undefined, { permissive: true });
    addImageCandidate(images, $(el).attr('xlink:href'), targetUrl, undefined, { permissive: true });
  });

  $('svg use').each((_: any, el: any) => {
    const href = $(el).attr('href') || $(el).attr('xlink:href');
    if (href && !href.startsWith('#')) addImageCandidate(images, href, targetUrl, undefined, { permissive: true });
  });

  $('object[type^="image/"], embed[type^="image/"]').each((_: any, el: any) => {
    addImageCandidate(images, $(el).attr('data') || $(el).attr('src'), targetUrl, undefined, { permissive: true });
  });

  $('[data-src], [data-lazy-src], [data-original], [data-bg], [data-background-image], [data-image], [data-thumb]').each((_: any, el: any) => {
    const attrs = (el as any)?.attribs || {};
    Object.entries(attrs).forEach(([name, value]) => {
      if (!name.startsWith('data-') || !value) return;
      const lowerName = name.toLowerCase();
      if (/image|img|photo|thumb|poster|bg|background|src|lazy|icon|avatar|banner|hero/i.test(lowerName)) {
        if (String(value).includes(',') && /\d+w|\d+x/.test(String(value))) {
          addSrcsetCandidates(images, String(value), targetUrl);
        } else {
          addImageCandidate(images, String(value), targetUrl, undefined, { permissive: true });
        }
      }
    });
  });

  $('style').each((_: any, el: any) => {
    const cssText = $(el).html();
    if (cssText) images.push(...extractImagesFromCss(cssText, targetUrl));
  });

  $('[style]').each((_: any, el: any) => {
    const style = $(el).attr('style');
    if (style) images.push(...extractImagesFromCss(style, targetUrl));
  });

  if (!options.scoped && !shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) {
    images.push(...extractImageSequencesFromText($.html() || '', targetUrl));
  }
  if (!options.scoped) extractInlineSvgsFromDom($, images);
  return images;
};

const extractImagesFromHtmlString = (html: string, targetUrl: string) => {
  const images: any[] = [];
  const searchText = html.replace(/\\/g, '').replace(/&amp;/g, '&');

  const absoluteRegex = /https?:\/\/[^"'<>\s\\)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'<>\s\\)]*)?(?:\?[^"'<>\s\\)]*)?/gi;
  (searchText.match(absoluteRegex) || []).slice(0, 200).forEach((raw) => addImageCandidate(images, raw, targetUrl));

  const wpUploadsRegex = /(?:https?:\/\/[^"'<>\s]+)?\/wp-content\/uploads\/[^"'<>\s)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'<>\s)]*)?(?:\?[^"'<>\s)]*)?/gi;
  (searchText.match(wpUploadsRegex) || []).slice(0, 200).forEach((raw) => addImageCandidate(images, raw, targetUrl));

  const commerceMediasRegex =
    /(?:https?:\/\/[^"'<>\s]+)?\/medias\/[^"'<>\s)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'<>\s)]*)?(?:\?[^"'<>\s)]*)?/gi;
  (searchText.match(commerceMediasRegex) || []).slice(0, 300).forEach((raw) => addImageCandidate(images, raw, targetUrl));

  const bgImageRegex = /background-image\s*:\s*url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi;
  let bgMatch;
  while ((bgMatch = bgImageRegex.exec(searchText)) !== null) {
    addImageCandidate(images, bgMatch[1], targetUrl);
  }

  const relativeRegex = /(?:["'`(])(\/[^"'`<>\\)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\?[^"'`<>\\)]*)?)(?:["'`)])/gi;
  let relMatch;
  while ((relMatch = relativeRegex.exec(searchText)) !== null) {
    addImageCandidate(images, relMatch[1], targetUrl);
  }

  const jsonImageRegex = /"(?:image|thumbnail|poster|logo|icon|avatar|heroImage|coverImage|ogImage|background_image|backgroundImage)(?:Url|URL|Src|Source)?"\s*:\s*"([^"]+)"/gi;
  let jsonMatch;
  while ((jsonMatch = jsonImageRegex.exec(searchText)) !== null) {
    addImageCandidate(images, jsonMatch[1], targetUrl);
  }

  if (!shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) {
    images.push(...extractImageSequencesFromText(searchText, targetUrl));
  }
  return images;
};

const isVimeoUrl = (url: string) => {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname === 'vimeo.com' || hostname.endsWith('.vimeo.com');
  } catch {
    return false;
  }
};

const isYouTubeUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  } catch {
    return false;
  }
};

const isBrightcoveUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'players.brightcove.net' || host.endsWith('.players.brightcove.net');
  } catch {
    return false;
  }
};

const isIspotUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'ispot.tv' || host.endsWith('.ispot.tv');
  } catch {
    return false;
  }
};

const parseBrightcovePlayerUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'players.brightcove.net' && !host.endsWith('.players.brightcove.net')) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const accountId = segments[0] || '';
    const playerPath = segments[1] || 'default';
    const playerId = playerPath.replace(/_default$/i, '') || 'default';
    const videoId =
      parsed.searchParams.get('videoId') ||
      parsed.searchParams.get('video_id') ||
      parsed.searchParams.get('bctid') ||
      parsed.hash.match(/(?:videoId|bctid)=(\d+)/i)?.[1] ||
      '';
    if (!accountId || !videoId) return null;
    return { accountId, playerId, videoId };
  } catch {
    return null;
  }
};

const isUnsupportedVideoResourceUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim().toLowerCase();
  if (!value) return true;
  if (value.startsWith('data:') || value.startsWith('blob:')) return true;
  if (/\.(?:js|mjs|css|json|map|xml|txt|ico|svg|png|jpe?g|gif|webp|avif)(?:[?#@]|$)/i.test(value)) return true;
  if (isWistiaHelperResourceUrl(value)) return true;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && (
      path === '/iframe_api' ||
      path.includes('/www-widgetapi') ||
      path.startsWith('/s/player/') ||
      path.startsWith('/youtubei/') ||
      path.startsWith('/api/')
    )) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

const isPlaylistUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return Boolean(parsed.searchParams.get('list')) || path.includes('/playlist');
    }
    if (host.includes('vimeo.com')) return /\/(?:showcase|album|channels|groups)\//.test(path);
    if (host.includes('facebook.com')) return /\/(?:watch|playlist|videos)\//.test(path) && Boolean(parsed.searchParams.get('vlist') || parsed.searchParams.get('playlist_id'));
    if (host === 'x.com' || host.includes('twitter.com')) return /\/status(?:es)?\//.test(path) && /\/\d+(?:\/(?:photo|video)\/\d+)?$/i.test(path);
    if (isBrightcoveUrl(rawUrl)) return Boolean(parsed.searchParams.get('playlistId') || parsed.searchParams.get('playlist_id'));
    return false;
  } catch {
    return false;
  }
};

const isYouTubeShortsUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return false;
    return /\/shorts\//i.test(parsed.pathname);
  } catch {
    return /youtube\.com\/shorts\//i.test(String(rawUrl || ''));
  }
};

const normalizeYouTubeWatchUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      const embedMatch = parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (embedMatch?.[1]) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};

const YOUTUBE_METADATA_TIMEOUT_MS = 20000;
const YOUTUBE_FORMATS_TIMEOUT_MS = 30000;
const YOUTUBE_MERGE_TIMEOUT_MS = 180000;

const fetchYouTubeOEmbedTitle = async (watchUrl: string) => {
  try {
    const normalized = normalizeYouTubeWatchUrl(watchUrl);
    const videoId = new URL(normalized).searchParams.get('v') || '';
    if (!videoId) return '';
    const response = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: YOUTUBE_METADATA_TIMEOUT_MS,
      validateStatus: (status) => status === 200,
    });
    return String(response.data?.title || '').trim();
  } catch {
    return '';
  }
};

const isCopyableStreamMediaUrl = (rawUrl: string) => {
  const candidate = String(rawUrl || '').trim();
  if (!candidate) return false;
  if (isYouTubeUrl(candidate) && !isGoogleVideoPlaybackUrl(candidate)) return false;
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\/api\/(?:youtube-merged-stream|download)(?:\?|$)/i.test(candidate)) return false;
  if (isGoogleVideoPlaybackUrl(candidate)) return true;
  if (/^~?\//.test(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) return true;
  if (/^https?:\/\//i.test(candidate) && !isYouTubeUrl(candidate)) return true;
  return false;
};

const pickVariantMediaUrl = (variant: any) => {
  const candidates = [
    variant?.mediaUrl,
    variant?.copyUrl,
    variant?.directStreamUrl,
    variant?.localPath,
    variant?.downloadPath,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (isCopyableStreamMediaUrl(value)) return value;
  }
  return '';
};

const extractYouTubeUrlsFromText = (text: string, baseUrl: string) => {
  const urls = new Set<string>();
  const normalizedText = text
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  const youtubeUrlRegex = /(?:https?:)?\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^"'<>\\\s]*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})[^"'<>\\\s]*/gi;
  let match;
  while ((match = youtubeUrlRegex.exec(normalizedText)) !== null) {
    const raw = match[0].startsWith('//') ? `https:${match[0]}` : match[0];
    urls.add(normalizeYouTubeWatchUrl(raw));
  }

  const iframeRegex = /<iframe[^>]+src=["']([^"']*(?:youtube\.com|youtu\.be)[^"']+)["']/gi;
  while ((match = iframeRegex.exec(normalizedText)) !== null) {
    const resolved = resolveUrl(baseUrl, match[1]);
    if (resolved) urls.add(normalizeYouTubeWatchUrl(resolved));
  }

  return Array.from(urls);
};

const normalizeVimeoUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const match =
      parsed.pathname.match(/\/video\/(\d+)/) ||
      parsed.pathname.match(/\/videos\/(\d+)/) ||
      parsed.pathname.match(/\/progressive_redirect\/(?:download|playback)\/(\d+)/) ||
      parsed.pathname.match(/^\/(\d+)/);

    if (match) {
      const privacyHash =
        parsed.pathname.match(/\/(?:video\/)?\d+\/([a-z0-9]+)(?:\/|$)/i)?.[1] ||
        parsed.searchParams.get('h') ||
        '';
      return `https://vimeo.com/${match[1]}${privacyHash ? `/${privacyHash}` : ''}`;
    }

    // Support Vimeo slug URLs as standalone links, e.g. /spencerwardwell/stg
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const cleanedPath = parsed.pathname.replace(/\/+$/, '');
      if (/\.(ico|js|css|json)$/i.test(cleanedPath)) return null;
      if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/i.test(cleanedPath)) return null;
      if (cleanedPath && cleanedPath !== '/') {
        return `https://vimeo.com${cleanedPath}`;
      }
    }

    return null;
  } catch {
    return null;
  }
};

const extractVimeoUrlsFromText = (text: string, baseUrl: string) => {
  const urls = new Set<string>();
  const normalizedText = text
    .replace(/\\\//g, '/')
    .replace(/&amp;amp;/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");

  const absoluteUrlRegex = /(?:https?:)?\/\/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/)?(\d+)/gi;
  let match;
  while ((match = absoluteUrlRegex.exec(normalizedText)) !== null) {
    urls.add(`https://vimeo.com/${match[1]}`);
  }

  // Keep this Vimeo-specific to avoid false positives on sites that use generic videoId fields (e.g. Facebook).
  const idRegex = /(?:vimeo(?:Video)?Id|vimeo_id|vimeoId)["']?\s*[:=]\s*["']?(\d{6,})/gi;
  while ((match = idRegex.exec(normalizedText)) !== null) {
    urls.add(`https://vimeo.com/${match[1]}`);
  }

  const iframeRegex = /<iframe[^>]+src=["']([^"']*vimeo\.com[^"']+)["']/gi;
  while ((match = iframeRegex.exec(normalizedText)) !== null) {
    const resolved = resolveUrl(baseUrl, match[1]);
    const vimeoUrl = resolved ? normalizeVimeoUrl(resolved) : null;
    if (vimeoUrl) urls.add(vimeoUrl);
  }

  const dataVimeoRegex = /data-vimeo(?:-id|_id)?=["'](\d{6,})["']/gi;
  while ((match = dataVimeoRegex.exec(normalizedText)) !== null) {
    urls.add(`https://vimeo.com/${match[1]}`);
  }

  const configUrlRegex = /config_url["']?\s*[:=]\s*["'](https?:\/\/[^"']+player\.vimeo\.com[^"']+)["']/gi;
  while ((match = configUrlRegex.exec(normalizedText)) !== null) {
    const idMatch = match[1].match(/\/video\/(\d+)/);
    if (idMatch?.[1]) urls.add(`https://vimeo.com/${idMatch[1]}`);
  }

  const thumbRegex = /video_thumbnails\/(\d{6,})\.(?:jpg|jpeg|png|webp)/gi;
  while ((match = thumbRegex.exec(normalizedText)) !== null) {
    urls.add(`https://vimeo.com/${match[1]}`);
  }

  const modalRegex = /data-video-embed-field-modal=["']([\s\S]*?)["']/gi;
  while ((match = modalRegex.exec(normalizedText)) !== null) {
    const decoded = match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&');
    extractVimeoUrlsFromText(decoded, baseUrl).forEach((entry) => urls.add(entry));
    const encodedIframeRegex = /player\.vimeo\.com\/video\/(\d{6,})/gi;
    let encodedMatch: RegExpExecArray | null;
    while ((encodedMatch = encodedIframeRegex.exec(match[1])) !== null) {
      urls.add(`https://vimeo.com/${encodedMatch[1]}`);
    }
  }

  return Array.from(urls);
};

const extractDrupalVideoEmbedTitles = (text: string) => {
  const titlesById = new Map<string, string>();
  const modalRegex = /data-video-embed-field-modal=["']([\s\S]*?)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = modalRegex.exec(text)) !== null) {
    const chunk = match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&');
    const iframeRegex = /player\.vimeo\.com\/video\/(\d{6,})/gi;
    let iframeMatch: RegExpExecArray | null;
    while ((iframeMatch = iframeRegex.exec(chunk)) !== null) {
      const titleMatch =
        chunk.match(/modal-video-title[^>]*>([^<]+)/i) ||
        chunk.match(/title=["']([^"']+)["']/i);
      const title = String(titleMatch?.[1] || '').trim();
      if (title) titlesById.set(iframeMatch[1], title);
    }
  }
  return titlesById;
};

const buildWebsiteVideoPlayersFromHtml = (html: string, pageUrl: string) => {
  const titlesById = extractDrupalVideoEmbedTitles(html);
  const vimeoUrls = dedupeVimeoUrlsById(extractVimeoUrlsFromText(html, pageUrl));
  return vimeoUrls.map((vimeoUrl) => {
    const vimeoId = parseVimeoIdFromUrl(vimeoUrl) || getVimeoIdFromVideoRecord({ url: vimeoUrl });
    const title = (vimeoId && titlesById.get(vimeoId)) || 'Vimeo video';
    return {
      url: vimeoUrl,
      sourceUrl: pageUrl,
      pageUrl,
      provider: 'vimeo',
      isVimeo: true,
      type: 'vimeo',
      title,
      vimeoId,
      thumbnail: vimeoId ? resolveUrl(pageUrl, `/sites/default/files/video_thumbnails/${vimeoId}.jpg`) : '',
    };
  });
};

const getVimeoIdFromVideoRecord = (video: any) => {
  const candidates = [
    video?.vimeoId,
    video?.sourceUrl,
    video?.pageUrl,
    video?.originalUrl,
    video?.url,
  ];
  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const normalized = normalizeVimeoUrl(value);
    if (normalized) {
      const idMatch = normalized.match(/vimeo\.com\/(\d+)/);
      if (idMatch?.[1]) return idMatch[1];
    }
    const directMatch = value.match(/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/|progressive_redirect\/download\/)(\d+)/i);
    if (directMatch?.[1]) return directMatch[1];
  }
  return '';
};

const dedupeVimeoUrlsById = (vimeoUrls: string[]) => {
  const byId = new Map<string, string>();
  for (const raw of vimeoUrls) {
    const id = getVimeoIdFromVideoRecord({ url: raw, sourceUrl: raw });
    if (!id) continue;
    const normalized = normalizeVimeoUrl(raw) || `https://vimeo.com/${id}`;
    const existing = byId.get(id) || '';
    const includesPrivacyHash = new RegExp(`vimeo\\.com/${id}/[a-z0-9]+`, 'i').test(normalized);
    if (!existing || includesPrivacyHash) byId.set(id, normalized);
  }
  return Array.from(byId.values());
};

const getEffectiveVideoPixels = (candidateOrHeight: any, width?: number) => {
  if (candidateOrHeight && typeof candidateOrHeight === 'object') {
    const height = parseCandidateHeight(candidateOrHeight) || 0;
    const candidateWidth = parseCandidateWidth(candidateOrHeight) || 0;
    return Math.max(height, candidateWidth);
  }
  const height = Number(candidateOrHeight) || 0;
  const candidateWidth = Number(width) || 0;
  return Math.max(height, candidateWidth);
};

const vimeoQualityBucketFromHeight = (height: number, width = 0) => {
  const effective = Math.max(height, width);
  if (!Number.isFinite(effective) || effective <= 0) return null;
  if (effective >= 1080) return 'fhd';
  if (effective >= 720) return 'hd';
  return null;
};

const collapseVimeoVideosForClient = (videos: any[]) => {
  const vimeoGroups = new Map<string, any[]>();
  const others: any[] = [];

  for (const video of Array.isArray(videos) ? videos : []) {
    if (!video?.url) continue;
    const provider = String(video?.provider || '').toLowerCase();
    const isVimeo =
      provider.includes('vimeo') ||
      video?.isVimeo ||
      video?.isVimeoDirect ||
      /vimeo\.com/i.test(String(video?.url || '')) ||
      /vimeo\.com/i.test(String(video?.sourceUrl || ''));
    if (!isVimeo) {
      others.push(video);
      continue;
    }
    const vimeoId = getVimeoIdFromVideoRecord(video);
    if (!vimeoId) {
      others.push(video);
      continue;
    }
    const bucket = vimeoGroups.get(vimeoId) || [];
    bucket.push(video);
    vimeoGroups.set(vimeoId, bucket);
  }

  const collapsed: any[] = [...others];
  for (const [vimeoId, group] of vimeoGroups.entries()) {
    const directStreams = group.filter((video) => video?.isVimeoDirect && video?.url);
    if (directStreams.length === 0) {
      const placeholder =
        group.find((video) => video?.url && (video?.isVimeo || /vimeo\.com/i.test(String(video?.url || '')))) ||
        group.find((video) => video?.url) ||
        group[0];
      if (placeholder) {
        collapsed.push({
          ...placeholder,
          vimeoId,
          sourceUrl: placeholder.sourceUrl || `https://vimeo.com/${vimeoId}`,
          sourceStreamUrl: placeholder.sourceStreamUrl || placeholder.url,
          defaultQualityKey: placeholder.defaultQualityKey || 'fhd',
          displayQualityKey: placeholder.displayQualityKey || 'fhd',
          displayQualityLabel: placeholder.displayQualityLabel || getCleanQualityLabel('fhd'),
          qualityRequested: placeholder.qualityRequested || 'fhd',
          streamsPrepared: Boolean(placeholder.streamsPrepared),
        });
      }
      continue;
    }

    const variants: Record<string, any> = {};
    for (const stream of directStreams) {
      const height = parseCandidateHeight(stream) || Number(stream.height || 0);
      const width = parseCandidateWidth(stream) || Number(stream.width || 0);
      const bucket = vimeoQualityBucketFromHeight(height, width);
      if (!bucket) continue;
      const normalized = {
        ...stream,
        vimeoId,
        sourceUrl: stream.sourceUrl || `https://vimeo.com/${vimeoId}`,
        sourceStreamUrl: stream.url,
        displayQualityKey: bucket,
        displayQualityLabel: getCleanQualityLabel(bucket),
        qualityRequested: bucket,
        streamsPrepared: true,
      };
      const current = variants[bucket];
      const currentHeight = current ? parseCandidateHeight(current) || Number(current.height || 0) : 0;
      if (!current || height > currentHeight) variants[bucket] = normalized;
    }

    const defaultQualityKey = variants.fhd ? 'fhd' : variants.hd ? 'hd' : null;
    if (!defaultQualityKey) {
      const best = [...directStreams].sort(
        (a, b) => (parseCandidateHeight(b) || Number(b.height || 0)) - (parseCandidateHeight(a) || Number(a.height || 0))
      )[0];
      collapsed.push({
        ...best,
        vimeoId,
        sourceUrl: best.sourceUrl || `https://vimeo.com/${vimeoId}`,
        sourceStreamUrl: best.url,
        streamsPrepared: true,
        defaultQualityKey: getCleanQualityKey(best),
      });
      continue;
    }

    const primary = variants[defaultQualityKey];
    collapsed.push({
      ...primary,
      vimeoId,
      sourceUrl: primary.sourceUrl || `https://vimeo.com/${vimeoId}`,
      sourceStreamUrl: primary.url,
      qualityVariants: variants,
      vimeoQualityVariants: variants,
      defaultQualityKey,
      displayQualityKey: defaultQualityKey,
      displayQualityLabel: getCleanQualityLabel(defaultQualityKey),
      qualityRequested: defaultQualityKey,
      streamsPrepared: true,
      availableFormats: Object.keys(variants).length,
      vimeoQualityDebug: primary?.vimeoQualityDebug || group.find((video) => video?.vimeoQualityDebug)?.vimeoQualityDebug,
    });
  }

  return collapsed;
};

const isWistiaUrl = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host.includes('wistia.com') || host.includes('wistia.net');
  } catch {
    return false;
  }
};

const buildWistiaEmbedUrl = (hashedId: string) => `https://fast.wistia.com/embed/medias/${hashedId}`;

const isWistiaSwatchUrl = (rawUrl = '') => {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return (host.includes('wistia.com') || host.includes('wistia.net')) &&
      /\/embed\/medias\/[a-z0-9]{8,12}\/swatch\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
};

const isWistiaHelperResourceUrl = (rawUrl = '') => {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!host.includes('wistia.com') && !host.includes('wistia.net')) return false;
    const path = parsed.pathname.toLowerCase();
    if (isWistiaSwatchUrl(parsed.href)) return true;
    if (/\/assets\/external\/(?:publicapi|captions|interfontface|playpauseloadingcontrol|hls_video|x)(?:\.js)?(?:@|\/|$)/i.test(path)) {
      return true;
    }
    if (/\/(?:mput|jsonp|iframe_shim)(?:\/|$)/i.test(path)) return true;
    return /\/embed\/medias\/[a-z0-9]{8,12}\/(?:swatch|seo|jsonp)(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
};

const extractWistiaIdsFromText = (text: string, baseUrl: string) => {
  const ids = new Set<string>();
  const normalizedText = text
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  const addId = (value: string | undefined) => {
    const id = String(value || '').trim().toLowerCase();
    if (/^[a-z0-9]{8,12}$/.test(id)) ids.add(id);
  };

  const embedRegex = /(?:fast\.)?wistia\.com\/embed\/medias\/([a-z0-9]{8,12})(?:\.jsonp?)?/gi;
  let match;
  while ((match = embedRegex.exec(normalizedText)) !== null) {
    addId(match[1]);
  }

  const asyncRegex = /wistia_async_([a-z0-9]{8,12})/gi;
  while ((match = asyncRegex.exec(normalizedText)) !== null) {
    addId(match[1]);
  }

  const wvideoRegex = /[?&]wvideo=([a-z0-9]{8,12})/gi;
  while ((match = wvideoRegex.exec(normalizedText)) !== null) {
    addId(match[1]);
  }

  const mediaIdRegex = /(?:media-id|media_id|hashedId|hashed_id|wistiaHashedId|wistia_hashed_id)["'\s:=]+["']?([a-z0-9]{8,12})/gi;
  while ((match = mediaIdRegex.exec(normalizedText)) !== null) {
    addId(match[1]);
  }

  const mediasRegex = /wistia\.com\/medias\/([a-z0-9]{8,12})/gi;
  while ((match = mediasRegex.exec(normalizedText)) !== null) {
    addId(match[1]);
  }

  const embedIframeRegex = /(?:fast\.)?wistia\.(?:com|net)\/embed\/iframe\/([a-z0-9]{8,12})/gi;
  while ((match = embedIframeRegex.exec(normalizedText)) !== null) {
    addId(match[1]);
  }

  const iframeRegex = /<iframe[^>]+src=["']([^"']*wistia[^"']+)["']/gi;
  while ((match = iframeRegex.exec(normalizedText)) !== null) {
    const resolved = resolveUrl(baseUrl, match[1]);
    if (!resolved) continue;
    const idMatch = resolved.match(/\/(?:medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
    if (idMatch?.[1]) addId(idMatch[1]);
  }

  return Array.from(ids);
};

const buildBrightcovePlayerUrl = (accountId: string, playerId: string, videoId: string) => {
  const account = String(accountId || '').trim();
  const player = String(playerId || 'default').trim() || 'default';
  const video = String(videoId || '').trim();
  if (!account || !video) return '';
  const normalizedPlayer = player.endsWith('_default') ? player : `${player}_default`;
  return `https://players.brightcove.net/${account}/${normalizedPlayer}/index.html?videoId=${video}`;
};

const extractBrightcoveVideosFromHtml = (htmlText: string, baseUrl: string) => {
  const videos: any[] = [];
  const seen = new Set<string>();
  const normalizedText = htmlText
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  const add = (input: any) => {
    const url = String(input?.url || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    videos.push(input);
  };

  try {
    const $ = cheerio.load(htmlText);
    $('gb-video-brightcove, [data-video-id][data-account-id], [data-bc-video-id][data-account-id]').each((_, el) => {
      const accountId = $(el).attr('data-account-id') || $(el).attr('account-id') || '';
      const playerId = $(el).attr('data-player-id') || $(el).attr('player-id') || 'default';
      const videoId = $(el).attr('data-video-id') || $(el).attr('data-bc-video-id') || $(el).attr('video-id') || '';
      const url = buildBrightcovePlayerUrl(accountId, playerId, videoId);
      if (!url) return;

      const title =
        $(el).find('.video-info-title').first().text().trim() ||
        $(el).attr('aria-label') ||
        $(el).attr('title') ||
        'Brightcove video';
      const poster =
        $(el).find('img[src]').first().attr('src') ||
        $(el).find('source[srcset]').first().attr('srcset')?.split(',').pop()?.trim().split(/\s+/)[0] ||
        '';
      add({
        url,
        sourceUrl: baseUrl,
        provider: 'brightcove',
        type: 'video',
        title,
        thumbnail: poster ? resolveUrl(baseUrl, poster) || poster : '',
        brightcoveAccountId: accountId,
        brightcovePlayerId: playerId,
        brightcoveVideoId: videoId,
      });
    });
  } catch {
    // Fall through to regex extraction below.
  }

  const tagRegex = /<gb-video-brightcove\b[\s\S]*?<\/gb-video-brightcove>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(normalizedText)) !== null) {
    const tag = tagMatch[0];
    const accountId = tag.match(/data-account-id=["']([^"']+)["']/i)?.[1] || '';
    const playerId = tag.match(/data-player-id=["']([^"']+)["']/i)?.[1] || 'default';
    const videoId = tag.match(/data-video-id=["']([^"']+)["']/i)?.[1] || '';
    const url = buildBrightcovePlayerUrl(accountId, playerId, videoId);
    if (!url) continue;
    const title = tag.match(/class=["'][^"']*video-info-title[^"']*["'][^>]*>([^<]+)/i)?.[1]?.trim() || 'Brightcove video';
    const poster = tag.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || '';
    add({
      url,
      sourceUrl: baseUrl,
      provider: 'brightcove',
      type: 'video',
      title,
      thumbnail: poster ? resolveUrl(baseUrl, poster) || poster : '',
      brightcoveAccountId: accountId,
      brightcovePlayerId: playerId,
      brightcoveVideoId: videoId,
    });
  }

  const playerUrlRegex = /https?:\/\/players\.brightcove\.net\/(\d+)\/([^"'<>\\\s]+?)\/index\.html\?[^"'<>\\\s]*?videoId=(\d+)/gi;
  let playerMatch;
  while ((playerMatch = playerUrlRegex.exec(normalizedText)) !== null) {
    add({
      url: playerMatch[0],
      sourceUrl: baseUrl,
      provider: 'brightcove',
      type: 'video',
      title: 'Brightcove video',
      brightcoveAccountId: playerMatch[1],
      brightcovePlayerId: playerMatch[2],
      brightcoveVideoId: playerMatch[3],
    });
  }

  const jsonBcRegex = /"(?:accountId|account_id)"\s*:\s*"(\d+)"[\s\S]{0,320}?"(?:videoId|video_id|id)"\s*:\s*"(\d+)"/gi;
  let jsonMatch;
  while ((jsonMatch = jsonBcRegex.exec(normalizedText)) !== null) {
    const url = buildBrightcovePlayerUrl(jsonMatch[1], 'default', jsonMatch[2]);
    if (url) {
      add({
        url,
        sourceUrl: baseUrl,
        provider: 'brightcove',
        type: 'video',
        title: 'Brightcove video',
        brightcoveAccountId: jsonMatch[1],
        brightcovePlayerId: 'default',
        brightcoveVideoId: jsonMatch[2],
      });
    }
  }

  return videos;
};

const discoverSiteVideoCandidates = async (siteUrl: string, initialHtml: string) => {
  const vimeoUrls = new Set<string>();
  const wistiaIds = new Set<string>();
  const videoUrls = new Set<string>();
  const brightcoveVideos = new Map<string, any>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number; html?: string }> = [{ url: siteUrl, depth: 0, html: initialHtml }];
  const maxPages = 10;
  const maxDepth = 2;

  const normalizedSite = new URL(siteUrl);
  const sameOrigin = (candidate: string) => {
    try {
      const parsed = new URL(candidate);
      return parsed.hostname.replace(/^www\./, '') === normalizedSite.hostname.replace(/^www\./, '');
    } catch {
      return false;
    }
  };

  const normalizePageUrl = (candidate: string) => {
    try {
      const parsed = new URL(candidate);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return '';
    }
  };

  const addVideoUrlsFromHtml = (htmlText: string, baseUrl: string) => {
    extractVimeoUrlsFromText(htmlText, baseUrl).forEach((vimeoUrl) => vimeoUrls.add(vimeoUrl));
    extractWistiaIdsFromText(htmlText, baseUrl).forEach((wistiaId) => wistiaIds.add(wistiaId));
    extractBrightcoveVideosFromHtml(htmlText, baseUrl).forEach((video) => {
      if (video?.url) brightcoveVideos.set(video.url, video);
    });

    const normalizeDiscoveredVideoUrl = (value: string) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return '';
      // Some sites embed unescaped spaces inside JSON strings; normalize so URL parsing works.
      return trimmed.replace(/ /g, '%20');
    };

    const normalizedText = htmlText
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
    const absoluteVideoRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#\s"'<>\\])(?:[?#][^\s"'<>\\]*)?/gi;
    // Allow spaces within the URL token (common in embedded JSON strings).
    const absoluteVideoRegexLoose = /https?:\/\/[^"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'<>\\])(?:[?#][^"'<>\\]*)?/gi;
    const relativeVideoRegex = /(?:["'`])(\/[^"'`<>\\]+?\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'`<>\\])(?:[?#][^"'`<>\\]*)?)(?:["'`])/gi;

    (normalizedText.match(absoluteVideoRegex) || []).forEach((match) => {
      const normalized = normalizeDiscoveredVideoUrl(match);
      if (normalized) videoUrls.add(normalized);
    });
    (normalizedText.match(absoluteVideoRegexLoose) || []).forEach((match) => {
      const normalized = normalizeDiscoveredVideoUrl(match);
      if (normalized) videoUrls.add(normalized);
    });
    let relMatch;
    while ((relMatch = relativeVideoRegex.exec(normalizedText)) !== null) {
      const absolute = resolveUrl(baseUrl, relMatch[1]);
      const normalized = normalizeDiscoveredVideoUrl(absolute);
      if (normalized) videoUrls.add(normalized);
    }
  };

  while (queue.length > 0 && visited.size < maxPages) {
    const current = queue.shift()!;
    const pageUrl = normalizePageUrl(current.url);
    if (!pageUrl || visited.has(pageUrl) || !sameOrigin(pageUrl)) continue;
    visited.add(pageUrl);

    let htmlText = current.html || '';
    if (!htmlText) {
      try {
        const response = await axios.get(pageUrl, {
          timeout: 7000,
          httpsAgent: relaxedHttpsAgent,
          responseType: 'text',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });
        htmlText = String(response.data || '');
      } catch {
        continue;
      }
    }

    addVideoUrlsFromHtml(htmlText, pageUrl);
    if (current.depth >= maxDepth) continue;

    const $ = cheerio.load(htmlText);
    const links: string[] = [];
    $('a[href], area[href]').each((_, el) => {
      const href = $(el).attr('href');
      const absolute = href ? resolveUrl(pageUrl, href) : null;
      if (!absolute || !sameOrigin(absolute)) return;
      if (/\.(pdf|jpg|jpeg|png|webp|svg|gif|zip|docx?|xlsx?)(\?|$)/i.test(absolute)) return;
      links.push(normalizePageUrl(absolute));
    });

    const scored = Array.from(new Set(links))
      .filter((link) => link && !visited.has(link))
      .sort((a, b) => {
        const score = (value: string) => /video|webinar|media|resource|education|event|watch|learn|patient|hcp|news/i.test(value) ? 0 : 1;
        return score(a) - score(b) || a.length - b.length;
      })
      .slice(0, 10);

    scored.forEach((link) => queue.push({ url: link, depth: current.depth + 1 }));
  }

  return {
    vimeoUrls: Array.from(vimeoUrls),
    wistiaIds: Array.from(wistiaIds),
    videoUrls: Array.from(videoUrls),
    brightcoveVideos: Array.from(brightcoveVideos.values()),
    visitedUrls: Array.from(visited),
  };
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string) => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
) => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
};

const fontOutputToBuffer = (output: any) => {
  if (Buffer.isBuffer(output)) return output;
  if (typeof output === 'string') return Buffer.from(output);
  if (output instanceof ArrayBuffer) return Buffer.from(new Uint8Array(output));
  if (ArrayBuffer.isView(output)) return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  return Buffer.from(output);
};

const bufferToExactArrayBuffer = (buffer: Buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

const assetCacheKey = (url: string, suffix = '') =>
  crypto.createHash('sha1').update(`${url}::${suffix}`).digest('hex');

const browserLikeHeaders = (targetUrl: string, refererPage = '') => {
  const origin = (() => {
    try {
      return new URL(targetUrl).origin;
    } catch {
      return '';
    }
  })();
  const referer = String(refererPage || '').trim() || (origin ? `${origin}/` : '');
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(referer ? { Referer: referer, ...(origin ? { Origin: origin } : {}) } : {}),
  };
};

const isLikelyFontAssetUrl = (url: string) => /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(String(url || ''));

const imageAcceptHeaderForUrl = (url: string) => {
  const value = String(url || '').toLowerCase();
  if (/[?&]fmt=(?:png|png-alpha)(?:&|$)/i.test(value) || /\.png(?:[?#]|$)/i.test(value)) {
    return 'image/png,image/apng,image/*,*/*;q=0.8';
  }
  if (/[?&]fmt=jpe?g(?:&|$)/i.test(value) || /\.jpe?g(?:[?#]|$)/i.test(value)) {
    return 'image/jpeg,image/*,*/*;q=0.8';
  }
  if (/[?&]fmt=webp(?:&|$)/i.test(value) || /\.webp(?:[?#]|$)/i.test(value)) {
    return 'image/webp,image/*,*/*;q=0.8';
  }
  return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
};

const isValidFontOriginalBuffer = (buffer: Buffer, contentType = '') => {
  if (!buffer || buffer.length < 128) return false;
  if (/text\/html|application\/json|text\/plain/i.test(String(contentType || ''))) return false;
  const head = buffer.slice(0, 96).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || (head.startsWith('<') && !head.startsWith('<svg'))) {
    return false;
  }
  return Boolean(detectFontFormatFromBuffer(buffer));
};

const fetchRemoteFontBufferViaCurl = async (url: string, refererPage = '') => {
  const pageReferer =
    String(refererPage || '').trim() ||
    (() => {
      try {
        return `${new URL(url).origin}/`;
      } catch {
        return '';
      }
    })();

  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const args = [
        '-sL',
        '--max-time',
        '25',
        '-A',
        userAgent,
        '-H',
        'Accept: font/woff2,font/woff,font/ttf,application/font-woff2,application/font-woff,*/*;q=0.8',
        ...(pageReferer ? ['-H', `Referer: ${pageReferer}`] : []),
        url,
      ];
      const { stdout } = await execFileAsync('curl', args, { maxBuffer: 10 * 1024 * 1024 });
      const buffer = Buffer.from(stdout);
      const contentType = guessContentTypeFromPath(url);
      if (isValidFontOriginalBuffer(buffer, contentType)) {
        return { buffer, contentType };
      }
    } catch {
      // Try the next user agent.
    }
  }

  return null;
};

const fontFetchSiblingUrls = (url: string) => {
  const siblings = new Set<string>();
  const add = (candidate: string) => {
    const normalized = String(candidate || '').trim();
    if (normalized && normalized !== url) siblings.add(normalized);
  };

  // Sitecore hyphenated naming: Foo-Bar-woff2.woff2 <-> Foo-Bar-ttf.ttf / Foo-Bar-woff.woff
  add(url.replace(/-woff2\.woff2(\?.*)?$/i, '-ttf.ttf$1'));
  add(url.replace(/-woff2\.woff2(\?.*)?$/i, '-woff.woff$1'));
  add(url.replace(/-woff\.woff(\?.*)?$/i, '-ttf.ttf$1'));
  add(url.replace(/-woff\.woff(\?.*)?$/i, '-woff2.woff2$1'));
  add(url.replace(/-ttf\.ttf(\?.*)?$/i, '-woff2.woff2$1'));
  add(url.replace(/-ttf\.ttf(\?.*)?$/i, '-woff.woff$1'));

  // Simple extension swap
  add(url.replace(/\.woff2(\?.*)?$/i, '.ttf$1'));
  add(url.replace(/\.woff2(\?.*)?$/i, '.woff$1'));
  add(url.replace(/\.woff(\?.*)?$/i, '.ttf$1'));
  add(url.replace(/\.woff(\?.*)?$/i, '.woff2$1'));
  add(url.replace(/\.ttf(\?.*)?$/i, '.woff2$1'));
  add(url.replace(/\.ttf(\?.*)?$/i, '.woff$1'));

  // Folder variant: EducatedDeers/EducatedDeers-Regular.ttf <-> EducatedDeers/EducatedDeers-Regular-woff2.woff2
  add(url.replace(/\/([^/]+)\/\1\.ttf(\?.*)?$/i, '/$1/$1-woff2.woff2$2'));
  add(url.replace(/\/([^/]+)\/\1-woff2\.woff2(\?.*)?$/i, '/$1/$1.ttf$2'));
  add(url.replace(/\/([^/]+)\/\1\.ttf(\?.*)?$/i, '/$1/$1-woff.woff$2'));
  add(url.replace(/\/([^/]+)\/\1-woff\.woff(\?.*)?$/i, '/$1/$1.ttf$2'));
  add(url.replace(/\/([^/]+)\/\1-woff2\.woff2(\?.*)?$/i, '/$1/$1-woff.woff$2'));

  return Array.from(siblings);
};

const resolveFontRefererPage = (cssSource = '', pageUrl = '') => {
  const page = String(pageUrl || '').trim();
  if (page.startsWith('http') && !isLikelyFontAssetUrl(page)) return page;
  const css = String(cssSource || '').trim();
  if (css.startsWith('http') && !isLikelyFontAssetUrl(css)) {
    try {
      return `${new URL(css).origin}/`;
    } catch {
      return css;
    }
  }
  return page || css;
};

const fetchRemoteFontBufferViaBrowser = async (url: string, refererPage = '') => {
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  try {
	    browser = await launchPuppeteerBrowser(activeExtractionProxyUrl);
	    const page = await acquireSingleWebsitePage(browser);
	    await applyProxyAuthToPage(page);
    await applyPuppeteerStealth(page);
    const landing =
      String(refererPage || '').trim() ||
      (() => {
        try {
          return `${new URL(url).origin}/`;
        } catch {
          return '';
        }
      })();
    if (landing) {
      await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const candidates = [url, ...fontFetchSiblingUrls(url)];
    for (const candidate of candidates) {
      try {
        const fetched = await page.evaluate(async (fontUrl) => {
          const response = await fetch(fontUrl, { credentials: 'include', cache: 'force-cache' });
          if (!response.ok) return null;
          const contentType = response.headers.get('content-type') || '';
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length < 128) return null;
          return { contentType, bytes: Array.from(bytes) };
        }, candidate);
        if (!fetched?.bytes?.length) continue;
        const buffer = Buffer.from(fetched.bytes);
        const contentType = String(fetched.contentType || guessContentTypeFromPath(candidate));
        if (isValidFontOriginalBuffer(buffer, contentType)) {
          return { buffer, contentType, sourceUrl: candidate };
        }
      } catch {
        // try next candidate
      }
    }

    for (const candidate of candidates) {
      const response = await page.goto(candidate, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
      if (!response || response.status() < 200 || response.status() >= 400) continue;
      const buffer = Buffer.from(await response.buffer());
      const contentType = String(response.headers()['content-type'] || response.headers()['Content-Type'] || '');
      if (isValidFontOriginalBuffer(buffer, contentType)) {
        return { buffer, contentType, sourceUrl: candidate };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await closePuppeteerBrowser(browser);
  }
};

const tryFetchRemoteFontBuffer = async (url: string, refererPage = '') => {
  const candidates = [url, ...fontFetchSiblingUrls(url)];
  for (const candidate of candidates) {
    const pageReferer =
      String(refererPage || '').trim() ||
      (() => {
        try {
          return `${new URL(candidate).origin}/`;
        } catch {
          return '';
        }
      })();
    try {
      const response = await axios.get(candidate, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxRedirects: 5,
        httpsAgent: relaxedHttpsAgent,
        validateStatus: (status) => status >= 200 && status < 300,
        headers: browserLikeHeaders(candidate, pageReferer),
      });
      const buffer = Buffer.from(response.data);
      const contentType = String(response.headers['content-type'] || '');
      if (isValidFontOriginalBuffer(buffer, contentType)) {
        return {
          buffer,
          contentType,
          contentDisposition: String(response.headers['content-disposition'] || ''),
          sourceUrl: candidate,
        };
      }
    } catch {
      // try next candidate / transport
    }
    const curlFetched = await fetchRemoteFontBufferViaCurl(candidate, pageReferer);
    if (curlFetched) {
      return { ...curlFetched, sourceUrl: candidate };
    }
  }
  const browserFetched = await fetchRemoteFontBufferViaBrowser(url, refererPage);
  if (browserFetched) return browserFetched;
  return null;
};

const fetchRemoteFontBuffer = async (url: string, refererPage = '') => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  assertPublicAssetUrl(normalized);
  const fetched = await tryFetchRemoteFontBuffer(normalized, refererPage);
  if (fetched) return fetched;
  throw new Error(`Failed to fetch a valid font from ${normalized}`);
};

const fetchRemoteAssetBuffer = async (url: string) => {
  assertPublicAssetUrl(url);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    httpsAgent: relaxedHttpsAgent,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: browserLikeHeaders(url),
  });
  return {
    buffer: Buffer.from(response.data),
    contentType: String(response.headers['content-type'] || ''),
  };
};

const getLocalCachedAssetPath = (rawUrl: string) => {
  try {
    let pathname = '';
    const value = String(rawUrl || '').trim();
    if (value.startsWith('/cached-images-original/') || value.startsWith('/cached-fonts-original/')) {
      pathname = value;
    } else {
      const parsed = new URL(value);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return null;
      pathname = decodeURIComponent(parsed.pathname || '');
    }
    const allowedPrefixes = ['/cached-images-original/', '/cached-fonts-original/'];
    if (!allowedPrefixes.some((prefix) => pathname.startsWith(prefix))) return null;
    const relative = pathname.replace(/^\/+/, '');
    if (relative.includes('..')) return null;
    if (pathname.startsWith('/cached-images-original/')) {
      return path.join(cachedImageOriginalDir, relative.replace(/^cached-images-original\//, ''));
    }
    if (pathname.startsWith('/cached-fonts-original/')) {
      return path.join(cachedFontOriginalDir, relative.replace(/^cached-fonts-original\//, ''));
    }
    return null;
  } catch {
    return null;
  }
};

const normalizeAssetRequestUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value || value.startsWith('data:')) return value;
  if (value.startsWith('/cached-images-original/') || value.startsWith('/cached-fonts-original/')) {
    return `http://127.0.0.1:${activePort}${value}`;
  }
  const appBase = `http://127.0.0.1:${activePort}`;
  return sanitizeStreamUrl(value, appBase) || (value.startsWith('http') ? value : '');
};

const assertAssetUrlAllowed = (rawUrl: string) => {
  const normalized = normalizeAssetRequestUrl(rawUrl);
  if (!normalized) throw new Error('Invalid asset URL');
  if (normalized.startsWith('data:')) return normalized;
  if (!getLocalCachedAssetPath(normalized)) {
    assertPublicAssetUrl(normalized);
  }
  return normalized;
};

const guessContentTypeFromPath = (filePath: string) => {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'ttf') return 'font/ttf';
  if (ext === 'woff') return 'font/woff';
  if (ext === 'woff2') return 'font/woff2';
  if (ext === 'otf') return 'font/otf';
  if (ext === 'eot') return 'application/vnd.ms-fontobject';
  return 'application/octet-stream';
};

const getUrlKeyedOriginalCachePath = async (url: string, kind: 'image' | 'font') => {
  const resolved = await resolveOriginalCachedAsset(url, kind);
  return resolved?.filePath || null;
};

const writeCachedOriginalImageFromBuffer = async (
  url: string,
  buffer: Buffer,
  contentType = '',
  hintType = 'bin',
  contentDisposition = ''
) => {
  if (!isValidImageBuffer(buffer, contentType)) return '';
  return writeOriginalCachedAsset(url, 'image', buffer, {
    contentType,
    contentDisposition,
    hintType,
  });
};

const inferCacheKind = (url: string, contentType = '') =>
  /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url) || /font\//i.test(contentType)
    ? 'font' as const
    : isRemoteImageRequestUrl(url) || /^image\//i.test(contentType)
      ? 'image' as const
      : null;

const readAssetBufferFromCache = async (url: string, preferredKind: 'image' | 'font' | null = null) => {
  const normalized = normalizeAssetRequestUrl(url);
  if (!normalized) return null;

  const localPath = getLocalCachedAssetPath(normalized);
  if (localPath) {
    try {
      const buffer = await fsp.readFile(localPath);
      const contentType = guessContentTypeFromPath(localPath);
      const isImagePath = localPath.includes(`${path.sep}cached-images-original${path.sep}`) || isRemoteImageRequestUrl(normalized);
      if (buffer.length > 0 && (!isImagePath || isValidImageBuffer(buffer, contentType))) {
        return { buffer, contentType };
      }
    } catch {
      // try other cache locations
    }
  }

  const kind = preferredKind || inferCacheKind(normalized);
  if (kind) {
    try {
      const cachedPath = await getUrlKeyedOriginalCachePath(normalized, kind);
      if (cachedPath) {
        const buffer = await fsp.readFile(cachedPath);
        const contentType = guessContentTypeFromPath(cachedPath);
        if (kind !== 'image' || isValidImageBuffer(buffer, contentType)) {
          if (kind === 'font' && !isValidFontOriginalBuffer(buffer, contentType)) {
            await fsp.unlink(cachedPath).catch(() => undefined);
          } else {
            return { buffer, contentType };
          }
        }
      }
      const resolved = await resolveOriginalCachedAsset(normalized, kind);
      if (resolved?.filePath) {
        const buffer = await fsp.readFile(resolved.filePath);
        const contentType = guessContentTypeFromPath(resolved.filePath);
        if (kind === 'font') {
          if (isValidFontOriginalBuffer(buffer, contentType)) {
            return { buffer, contentType };
          }
        } else if (kind !== 'image' || isValidImageBuffer(buffer, contentType)) {
          return { buffer, contentType };
        }
      }
    } catch {
      // cache miss
    }
  }

  return null;
};

const getAssetCacheDebugPath = async (url: string, preferredKind: 'image' | 'font' | null = null) => {
  const normalized = normalizeAssetRequestUrl(url);
  if (!normalized) return '';
  const localPath = getLocalCachedAssetPath(normalized);
  if (localPath) return localPath;
  const kind = preferredKind || inferCacheKind(normalized);
  if (!kind) return '';
  const resolved = await resolveOriginalCachedAsset(normalized, kind);
  return resolved?.filePath || '';
};

const fetchAssetBuffer = async (
  url: string,
  fallbackUrl = '',
  options: { cacheOnly?: boolean; refererPageUrl?: string; skipBrowser?: boolean } = {}
) => {
  const refererPage =
    String(options.refererPageUrl || '').trim() ||
    (() => {
      const candidate = String(fallbackUrl || '').trim();
      if (candidate.startsWith('http') && !isLikelyFontAssetUrl(candidate)) return candidate;
      return '';
    })();

  const attempt = async (target: string) => {
    const cached = await readAssetBufferFromCache(target);
    if (cached) return cached;

    if (options.cacheOnly) {
      throw new Error(`Asset is not cached yet: ${target}`);
    }

    const normalized = normalizeAssetRequestUrl(target);
    if (isRemoteImageRequestUrl(normalized)) {
      const fetched = await fetchRemoteImageBuffer(normalized, refererPage, {
        skipBrowser: options.skipBrowser,
      });
      if (fetched) return fetched;
      throw new Error(`Failed to fetch a valid image from ${normalized}`);
    }

    if (isLikelyFontAssetUrl(normalized) || inferCacheKind(normalized) === 'font') {
      return fetchRemoteFontBuffer(normalized, refererPage);
    }

    return fetchRemoteAssetBuffer(normalized);
  };

  try {
    return await attempt(url);
  } catch (primaryError) {
    const fallback = String(fallbackUrl || '').trim();
    if (isJunkImageUrl(url) && fallback && fallback !== url && !isJunkImageUrl(fallback)) {
      try {
        return await attempt(fallback);
      } catch {
        // fall through to generic fallback
      }
    }
    if (!fallback || fallback === url) throw primaryError;
    return attempt(fallback);
  }
};

const readCachedFileIfExists = async (filePath: string) => {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > 0) return await fsp.readFile(filePath);
  } catch {
    // Cache miss.
  }
  return null;
};

const safeExtFromAssetType = (value: string) => {
  const ext = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 10);
  return ext || 'bin';
};

const isValidImageBuffer = (buffer: Buffer, contentType = '') => {
  if (!buffer || buffer.length < 12) return false;
  const detected = detectImageFormatFromBuffer(buffer);
  const minBytes = detected === 'svg' ? 16 : 128;
  if (buffer.length < minBytes) return false;
  if (/text\/html|application\/json|text\/plain/i.test(contentType)) return false;
  if (detected) return true;
  const head = buffer.slice(0, 64).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return false;
  if (head.startsWith('<') && !head.startsWith('<svg')) return false;
  return false;
};

const resolveImageFetchReferer = (url: string, refererPageUrl = '') => {
  const pageReferer = String(refererPageUrl || '').trim();
  if (pageReferer.startsWith('http')) return pageReferer;
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return '';
  }
};

const fetchRemoteImageBufferViaHttp = async (url: string, refererPageUrl = '') => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const accept = imageAcceptHeaderForUrl(url);
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: accept,
          ...(referer ? { Referer: referer } : {}),
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (!response.ok) continue;
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = String(response.headers.get('content-type') || guessContentTypeFromPath(url));
      if (isValidImageBuffer(buffer, contentType)) {
        return { buffer, contentType };
      }
    } catch {
      // Try the next user agent.
    }
  }
  return null;
};

const fetchRemoteImageBufferViaCurl = async (url: string, refererPageUrl = '') => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const accept = imageAcceptHeaderForUrl(url);

  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const args = [
        '-sL',
        '--max-time',
        '25',
        '-A',
        userAgent,
        '-H',
        `Accept: ${accept}`,
        ...(referer ? ['-H', `Referer: ${referer}`] : []),
        url,
      ];
      const { stdout } = await execFileAsync('curl', args, {
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'buffer' as BufferEncoding,
      });
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as string, 'latin1');
      const contentType = guessContentTypeFromPath(url);
      if (isValidImageBuffer(buffer, contentType)) {
        return { buffer, contentType };
      }
    } catch {
      // Try the next user agent.
    }
  }

  return null;
};

const fetchImageFromRenderedPage = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>,
  url: string
) => {
  const dataUrl = await page.evaluate(async (targetUrl) => {
    const normalize = (value: string) => {
      try {
        const parsed = new URL(value, location.href);
        parsed.hash = '';
        return parsed.href;
      } catch {
        return String(value || '');
      }
    };
    const target = normalize(targetUrl);
    const targetPath = (() => {
      try {
        return new URL(target).pathname;
      } catch {
        return '';
      }
    })();
    const imageElements = Array.from(document.images || []);
    const exactMatch = imageElements.find((img) => {
      const candidates = [img.currentSrc, img.src, img.getAttribute('src'), img.getAttribute('data-src')]
        .map((candidate) => normalize(String(candidate || '')))
        .filter(Boolean);
      return candidates.some((candidate) => candidate === target);
    });
    const pathMatch = exactMatch || imageElements.find((img) => {
      const candidates = [img.currentSrc, img.src, img.getAttribute('src'), img.getAttribute('data-src')]
        .map((candidate) => normalize(String(candidate || '')))
        .filter(Boolean);
      return candidates.some((candidate) => {
        try {
          return targetPath && new URL(candidate).pathname === targetPath;
        } catch {
          return false;
        }
      });
    });

    const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });

    try {
      const response = await fetch(target, { credentials: 'include', cache: 'force-cache' });
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (response.ok && contentType.startsWith('image/')) {
        const blob = await response.blob();
        if (blob.size > 0 && blob.size <= 15 * 1024 * 1024) {
          const fetchedDataUrl = await blobToDataUrl(blob);
          if (fetchedDataUrl.startsWith('data:image/')) return fetchedDataUrl;
        }
      }
    } catch {
      // Fall through to canvas extraction below.
    }

    const img = pathMatch as HTMLImageElement | undefined;
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return '';
      context.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return '';
    }
  }, url);
  if (!String(dataUrl || '').startsWith('data:image/')) return null;
  const buffer = decodeDataImageBuffer(String(dataUrl));
  if (!buffer?.length) return null;
  const contentType = String(dataUrl).match(/^data:([^;,]+)/i)?.[1] || 'image/png';
  if (!isValidImageBuffer(buffer, contentType)) return null;
  return { buffer, contentType };
};

const fetchRemoteImageBufferViaBrowser = async (url: string, refererPageUrl = '') => {
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await applyPuppeteerStealth(page);
    let landing = String(refererPageUrl || '').trim();
    if (!landing.startsWith('http')) {
      try {
        landing = `${new URL(url).origin}/`;
      } catch {
        return null;
      }
    }
    await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await waitForPageContentSettle(page, { minWaitMs: 2800, readinessTimeoutMs: 2200 });
    const renderedImage = await fetchImageFromRenderedPage(page, url).catch(() => null);
    if (renderedImage) {
      await writeCachedOriginalImageFromBuffer(url, renderedImage.buffer, renderedImage.contentType);
      return renderedImage;
    }
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    if (!response || response.status() < 200 || response.status() >= 400) return null;
    const buffer = Buffer.from(await response.buffer());
    const contentType = String(response.headers()['content-type'] || response.headers()['Content-Type'] || '');
    if (!isValidImageBuffer(buffer, contentType)) return null;
    await writeCachedOriginalImageFromBuffer(url, buffer, contentType);
    return { buffer, contentType };
  } catch {
    return null;
  } finally {
    await closePuppeteerBrowser(browser);
  }
};

const imagingUrlFallbacks = (url: string) => {
  const fallbacks: string[] = [];
  const lowered = String(url || '').toLowerCase();
  if (!/\.imaging\//i.test(lowered)) return fallbacks;
  if (!/\/jcr:content\./i.test(lowered)) {
    const withoutQuery = url.split('?')[0];
    const withoutExt = withoutQuery.replace(/\.(?:webp|png|jpe?g|gif|avif)$/i, '');
    fallbacks.push(`${withoutExt}/jcr:content.webp`);
    if (withoutExt !== withoutQuery) fallbacks.push(withoutExt);
  }
  return Array.from(new Set(fallbacks.filter((candidate) => candidate && candidate !== url)));
};

const fetchRemoteImageBuffer = async (
  url: string,
  refererPageUrl = '',
  options: { skipBrowser?: boolean } = {}
) => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);

  const isProtectedCdnImage = /\.imaging\/|\/dam\/jcr:|dam\/jcr:|fabindia\.com.*\/medias\//i.test(url);
  if (isProtectedCdnImage) {
    const httpFetched = await fetchRemoteImageBufferViaHttp(url, refererPageUrl);
    if (httpFetched) {
      await writeCachedOriginalImageFromBuffer(url, httpFetched.buffer, httpFetched.contentType);
      return httpFetched;
    }
    const curlFetched = await fetchRemoteImageBufferViaCurl(url, refererPageUrl);
    if (curlFetched) {
      await writeCachedOriginalImageFromBuffer(url, curlFetched.buffer, curlFetched.contentType);
      return curlFetched;
    }
    if (!options.skipBrowser) {
      const browserFetched = await fetchRemoteImageBufferViaBrowser(url, refererPageUrl);
      if (browserFetched) return browserFetched;
    }
    for (const fallbackUrl of imagingUrlFallbacks(url)) {
      const curlFallback = await fetchRemoteImageBufferViaCurl(fallbackUrl, refererPageUrl);
      if (curlFallback) {
        await writeCachedOriginalImageFromBuffer(url, curlFallback.buffer, curlFallback.contentType);
        return curlFallback;
      }
      if (!options.skipBrowser) {
        const browserFallback = await fetchRemoteImageBufferViaBrowser(fallbackUrl, refererPageUrl);
        if (browserFallback) {
          await writeCachedOriginalImageFromBuffer(url, browserFallback.buffer, browserFallback.contentType);
          return browserFallback;
        }
      }
    }
  }

  const httpFetched = await fetchRemoteImageBufferViaHttp(url, refererPageUrl);
  if (httpFetched) {
    await writeCachedOriginalImageFromBuffer(url, httpFetched.buffer, httpFetched.contentType);
    return httpFetched;
  }

  const curlFetched = await fetchRemoteImageBufferViaCurl(url, refererPageUrl);
  if (curlFetched) {
    await writeCachedOriginalImageFromBuffer(url, curlFetched.buffer, curlFetched.contentType);
    return curlFetched;
  }

  if (options.skipBrowser) return null;
  return fetchRemoteImageBufferViaBrowser(url, refererPageUrl);
};

const ensureImageCachedForDownload = async (
  requestUrl: string,
  originalUrl: string,
  refererPageUrl = ''
) => {
  let cached =
    (await readAssetBufferFromCache(requestUrl, 'image')) ||
    (originalUrl && originalUrl !== requestUrl ? await readAssetBufferFromCache(originalUrl, 'image') : null);
  if (cached) {
    const declaredFormat = inferImageTypeFromUrl(originalUrl || requestUrl, cached.contentType);
    const cachedFormat = detectImageFormatFromBuffer(cached.buffer);
    // Older thumbnail flows could poison an original SVG cache entry with a
    // rasterized PNG/WebP preview. Heal that cache before the download path
    // reconciles the filename to `.png`.
    if (declaredFormat === 'svg' && cachedFormat !== 'svg') {
      const refreshed = await fetchRemoteImageBuffer(originalUrl || requestUrl, refererPageUrl, {
        skipBrowser: true,
      }).catch(() => null);
      if (refreshed && detectImageFormatFromBuffer(refreshed.buffer) === 'svg') {
        return { cached: refreshed, requestUrl: originalUrl || requestUrl };
      }
    }
    return { cached, requestUrl };
  }

  const warmTarget = String(originalUrl || requestUrl || '').trim();
  if (!warmTarget || warmTarget.startsWith('data:')) {
    return { cached: null, requestUrl };
  }

  try {
    const warmed = await withTimeout(
      warmCachedOriginalAssetForExtraction(
        warmTarget,
        'image',
        inferImageTypeFromUrl(warmTarget, '') || getAssetTypeFromUrl(warmTarget, 'bin'),
        { refererPageUrl }
      ),
      20000,
      `Ensure image cache for ${warmTarget}`
    );
    if (warmed?.ok && warmed.cachedUrl) {
      cached =
        (await readAssetBufferFromCache(warmed.cachedUrl, 'image')) ||
        (await readAssetBufferFromCache(warmTarget, 'image'));
      if (cached) {
        return { cached, requestUrl: warmed.cachedUrl };
      }
    }
  } catch {
    // Fall through to direct fetch.
  }

  try {
    const fetched = await withTimeout(
      fetchAssetBuffer(warmTarget, warmTarget, { refererPageUrl }),
      30000,
      `Ensure image fetch for ${warmTarget}`
    );
    if (fetched && isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      const cachedUrl = await writeCachedOriginalImageFromBuffer(
        warmTarget,
        fetched.buffer,
        fetched.contentType,
        inferImageTypeFromUrl(warmTarget, '') || getAssetTypeFromUrl(warmTarget, 'bin'),
        String((fetched as any).contentDisposition || '')
      );
      cached =
        (cachedUrl ? await readAssetBufferFromCache(cachedUrl, 'image') : null) ||
        (await readAssetBufferFromCache(warmTarget, 'image'));
      if (cached) {
        return { cached, requestUrl: cachedUrl || warmTarget };
      }
      return { cached: fetched, requestUrl: warmTarget };
    }
  } catch {
    // Caller may retry fetch.
  }

  return { cached: null, requestUrl: warmTarget || requestUrl };
};

const readCachedImageBuffer = async (url: string) => {
  try {
    const normalized = normalizeAssetRequestUrl(url);
    if (!normalized.startsWith('http')) return null;
    const cachedPath = await getUrlKeyedOriginalCachePath(normalized, 'image');
    if (!cachedPath) return null;
    const buffer = await fsp.readFile(cachedPath);
    const contentType = guessContentTypeFromPath(cachedPath);
    if (!isValidImageBuffer(buffer, contentType)) {
      await fsp.unlink(cachedPath).catch(() => undefined);
      return null;
    }
    return { buffer, contentType };
  } catch {
    return null;
  }
};

const fetchRemoteImageBuffersViaBrowserBatch = async (urls: string[], refererPageUrl = '') => {
  const results = new Map<string, { buffer: Buffer; contentType: string }>();
  const uniqueUrls = Array.from(new Set(urls.filter(Boolean)));
  if (uniqueUrls.length === 0) return results;

  let landing = String(refererPageUrl || '').trim();
  if (!landing.startsWith('http')) {
    try {
      landing = `${new URL(uniqueUrls[0]).origin}/`;
    } catch {
      return results;
    }
  }

  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await applyPuppeteerStealth(page);
    await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await waitForPageContentSettle(page, { minWaitMs: 2800, readinessTimeoutMs: 2200 });

    const batchSize = 8;
    for (let offset = 0; offset < uniqueUrls.length; offset += batchSize) {
      const chunk = uniqueUrls.slice(offset, offset + batchSize);
      const fetched = await page
        .evaluate(async (imageUrls: string[]) => {
          const out: Array<{ url: string; bytes: number[]; contentType: string }> = [];
          await Promise.all(
            imageUrls.map(async (imageUrl) => {
              try {
                const response = await fetch(imageUrl, { credentials: 'include', cache: 'no-store' });
                if (!response.ok) return;
                const contentType = response.headers.get('content-type') || '';
                const buffer = await response.arrayBuffer();
                out.push({ url: imageUrl, bytes: Array.from(new Uint8Array(buffer)), contentType });
              } catch {
                // Skip individual image failures.
              }
            })
          );
          return out;
        }, chunk)
        .catch(() => [] as Array<{ url: string; bytes: number[]; contentType: string }>);

      for (const item of fetched) {
        const buffer = Buffer.from(item.bytes);
        const contentType = String(item.contentType || '');
        if (!isValidImageBuffer(buffer, contentType)) continue;
        results.set(item.url, { buffer, contentType });
        await writeCachedOriginalImageFromBuffer(item.url, buffer, contentType);
      }

      // Fallback for images blocked by in-page fetch (CORS / cookies).
      for (const imageUrl of chunk) {
        if (results.has(imageUrl)) continue;
        try {
          const response = await page.goto(imageUrl, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => null);
          if (!response || response.status() < 200 || response.status() >= 400) continue;
          const buffer = Buffer.from(await response.buffer());
          const contentType = String(response.headers()['content-type'] || response.headers()['Content-Type'] || '');
          if (!isValidImageBuffer(buffer, contentType)) continue;
          results.set(imageUrl, { buffer, contentType });
          await writeCachedOriginalImageFromBuffer(imageUrl, buffer, contentType);
        } catch {
          // Skip individual image failures.
        }
      }
    }
  } finally {
    await closePuppeteerBrowser(browser);
  }

  return results;
};

const prefetchRemoteImageBuffers = async (urls: string[]) => {
  const results = new Map<string, { buffer: Buffer; contentType: string }>();
  const missing: string[] = [];

  for (const url of Array.from(new Set(urls))) {
    if (!url || url.startsWith('data:')) continue;
    const cached = await readCachedImageBuffer(url);
    if (cached) results.set(url, cached);
    else missing.push(url);
  }

  const allowedMissing: string[] = [];
  for (const url of missing) {
    try {
      allowedMissing.push(assertAssetUrlAllowed(url));
    } catch {
      // Ignore blocked URLs.
    }
  }

  await mapWithConcurrency(allowedMissing, 12, async (url) => {
    if (results.has(url)) return;
    const fetched = await fetchRemoteImageBuffer(url);
    if (fetched) results.set(url, fetched);
  });

  const stillMissing = allowedMissing.filter((url) => !results.has(url));

  const byOrigin = new Map<string, string[]>();
  for (const url of stillMissing) {
    try {
      const origin = new URL(url).origin;
      if (!byOrigin.has(origin)) byOrigin.set(origin, []);
      byOrigin.get(origin)!.push(url);
    } catch {
      // Ignore malformed URLs.
    }
  }

  for (const originUrls of byOrigin.values()) {
    const fetched = await fetchRemoteImageBuffersViaBrowserBatch(originUrls);
    fetched.forEach((value, key) => results.set(key, value));
  }

  return results;
};

const isRemoteImageRequestUrl = (url: string) => {
  const value = String(url || '').toLowerCase();
  if (value.startsWith('data:image/')) return true;
  if (value.includes('/cached-images-original/')) return true;
  if (isLikelyFontAssetUrl(value)) return false;
  if (/\.(png|jpe?g|gif|webp|avif|svg|ashx)(\?|$)/i.test(value)) return true;
  if (/\/-\/media\//i.test(value) && !/\/fonts\//i.test(value)) return true;
  return false;
};

const warmCachedOriginalAsset = async (
  url: string,
  kind: 'image' | 'font',
  hintType = 'bin'
) => {
  const existing = await resolveOriginalCachedAsset(url, kind);
  if (existing) {
    try {
      const buffer = await fsp.readFile(existing.filePath);
      if (buffer.length > 0 && (kind !== 'image' || isValidImageBuffer(buffer, guessContentTypeFromPath(existing.filePath)))) {
        return { ok: true, cachedUrl: existing.cachedUrl };
      }
    } catch {
      // fetch again below
    }
  }

  let buffer: Buffer;
  let contentType = '';
  let contentDisposition = '';
  if (kind === 'image') {
    const fetched = await fetchRemoteImageBuffer(url);
    if (!fetched) return { ok: false, cachedUrl: '' };
    buffer = fetched.buffer;
    contentType = fetched.contentType;
    contentDisposition = String((fetched as { contentDisposition?: string }).contentDisposition || '');
  } else {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      maxRedirects: 4,
      validateStatus: (status) => status >= 200 && status < 300,
      httpsAgent: relaxedHttpsAgent,
      headers: browserLikeHeaders(url),
    });
    buffer = Buffer.from(response.data);
    contentType = String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || '');
    contentDisposition = String(response.headers?.['content-disposition'] || response.headers?.['Content-Disposition'] || '');
  }

  const maxBytes = kind === 'image' ? 15 * 1024 * 1024 : 10 * 1024 * 1024;
  if (buffer.length <= 0 || buffer.length > maxBytes) {
    return { ok: false, cachedUrl: '' };
  }
  if (kind === 'image' && !isValidImageBuffer(buffer, contentType)) {
    return { ok: false, cachedUrl: '' };
  }

  const cachedUrl = await writeOriginalCachedAsset(url, kind, buffer, {
    contentType,
    contentDisposition,
    hintType,
  });
  return { ok: Boolean(cachedUrl), cachedUrl };
};

const getDefaultImageDownloadFormat = (url: string, contentType = '') => {
  const value = `${url} ${contentType}`.toLowerCase();
  if (/\.svg(\?|$)|image\/svg/i.test(value)) return 'svg';
  if (/\.webp(\?|$)|image\/webp/i.test(value)) return 'jpg';
  if (/\.avif(\?|$)|image\/avif/i.test(value)) return 'png';
  return '';
};

const RASTER_CONVERTIBLE_FORMATS = new Set(['webp', 'avif', 'svg']);

const normalizeRasterFormat = (format: string) =>
  String(format || '').toLowerCase().replace('jpeg', 'jpg').trim();

const resolveRasterSourceFormat = (
  buffer: Buffer,
  normalizedUrl: string,
  lookupUrl: string,
  contentType = ''
) => {
  const fromBuffer = detectRasterFormatFromBuffer(buffer) || detectImageFormatFromBuffer(buffer);
  // Trust the actual bytes first. Some websites serve raster images from URLs
  // ending in .svg; saving those bytes with a .svg extension creates invalid
  // Illustrator files.
  if (fromBuffer) return fromBuffer;
  const fromLookup = inferImageTypeFromUrl(lookupUrl, contentType);
  if (fromLookup && RASTER_CONVERTIBLE_FORMATS.has(fromLookup)) return fromLookup;
  const fromUrl = inferImageTypeFromUrl(normalizedUrl, contentType);
  if (fromUrl && RASTER_CONVERTIBLE_FORMATS.has(fromUrl)) return fromUrl;
  const fromCt = inferImageTypeFromContentType(contentType);
  if (fromCt && RASTER_CONVERTIBLE_FORMATS.has(fromCt)) return fromCt;
  return normalizeRasterFormat(fromBuffer || fromLookup || fromUrl || fromCt || getAssetTypeFromUrl(lookupUrl || normalizedUrl, 'bin'));
};

const imageContentTypeForFormat = (format: string, fallback = 'application/octet-stream') => {
  const normalized = normalizeRasterFormat(format);
  if (normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'png') return 'image/png';
  if (normalized === 'webp') return 'image/webp';
  if (normalized === 'avif') return 'image/avif';
  if (normalized === 'svg') return 'image/svg+xml';
  if (normalized === 'gif') return 'image/gif';
  return fallback;
};

const IMAGE_BINARY_FORMATS = new Set(['jpg', 'png', 'webp', 'avif', 'svg', 'gif']);

const reconcileImageFilenameWithBuffer = (filename: string, buffer: Buffer, contentType = '') => {
  const actual = normalizeRasterFormat(
    detectRasterFormatFromBuffer(buffer) ||
      detectImageFormatFromBuffer(buffer) ||
      inferImageTypeFromContentType(contentType)
  );
  if (!actual || !IMAGE_BINARY_FORMATS.has(actual)) return filename;
  const ext = actual === 'jpeg' ? 'jpg' : actual;
  const currentExt = normalizeRasterFormat(path.extname(filename || '').replace(/^\./, ''));
  if (currentExt === ext) return filename;
  if (filename && path.extname(filename)) return filename.replace(/\.[^./\\]+$/, `.${ext}`);
  return `${filename || 'asset'}.${ext}`;
};

const escapeXmlAttribute = (value: string) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const wrapRasterBufferAsIllustratorSvg = (buffer: Buffer, format: string, label = '') => {
  const normalized = normalizeRasterFormat(format);
  if (!buffer?.length || !['jpg', 'png', 'webp', 'avif', 'gif'].includes(normalized)) return buffer;
  const dimensions = probeRasterDimensions(buffer);
  const width = dimensions.width > 0 ? dimensions.width : 1200;
  const height = dimensions.height > 0 ? dimensions.height : 800;
  const mime = imageContentTypeForFormat(normalized, 'image/png');
  const title = escapeXmlAttribute(path.basename(label || 'embedded-image').replace(/\.[^.]+$/, ''));
  const encoded = buffer.toString('base64');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${title}</title>
  <image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${encoded}" xlink:href="data:${mime};base64,${encoded}"/>
</svg>
`;
  return Buffer.from(svg, 'utf8');
};

const convertImageFileWithFfmpeg = async (inputPath: string, outputPath: string, format: 'jpg' | 'png') =>
  new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    if (format === 'jpg') {
      cmd.outputOptions(['-q:v', '2']);
    }
    cmd
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (error) => reject(error))
      .run();
  });

const sanitizeFilenameBase = (value: string) =>
  String(value || 'asset')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[/\\\\]+/g, '-')
    .replace(/[^a-z0-9._ -]+/gi, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160) || 'asset';

const decodeUrlEncodedFilename = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw.replace(/\+/g, ' ');
  }
};

const parseContentDispositionFilename = (header: string | undefined) => {
  const value = String(header || '').trim();
  if (!value) return '';
  const encoded = value.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (encoded?.[1]) return decodeUrlEncodedFilename(encoded[1].trim().replace(/^["']|["']$/g, ''));
  const quoted = value.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return decodeUrlEncodedFilename(quoted[1].trim());
  const plain = value.match(/filename=([^;]+)/i);
  if (plain?.[1]) return decodeUrlEncodedFilename(plain[1].trim().replace(/^["']|["']$/g, ''));
  return '';
};

const filenameFromUrlPath = (rawUrl: string) => {
  const value = String(rawUrl || '').trim();
  if (!value || value.startsWith('data:')) return '';
  try {
    const parsed = new URL(value);
    const segment = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodeUrlEncodedFilename(segment.split('?')[0].split('#')[0]);
  } catch {
    const segment = value.split('/').pop() || '';
    return decodeUrlEncodedFilename(segment.split('?')[0].split('#')[0]);
  }
};

const normalizeAssetExtension = (ext: string) => {
  const cleaned = String(ext || '').toLowerCase().replace(/^\./, '');
  if (cleaned === 'jpeg') return 'jpg';
  return cleaned;
};

const sanitizeFullFilename = (filename: string, fallbackExt = '') => {
  const decoded = decodeUrlEncodedFilename(String(filename || '').replace(/^\.\/+/, ''));
  let baseName = path.basename(decoded.split('?')[0].split('#')[0]).replace(/[\\/:*?"<>|]/g, '-');
  if (!baseName) baseName = `asset${fallbackExt ? `.${normalizeAssetExtension(fallbackExt)}` : ''}`;
  const ext = path.extname(baseName);
  const nameBase = ext ? path.basename(baseName, ext) : baseName;
  const safeExt = normalizeAssetExtension(ext.slice(1) || fallbackExt || 'bin');
  return `${sanitizeFilenameBase(nameBase)}.${safeExt}`;
};

type AssetFilenameOptions = {
  url?: string;
  contentDisposition?: string;
  metadataFilename?: string;
  preferredBase?: string;
  format?: string;
  fallbackBase?: string;
};

const deriveAssetFilename = (options: AssetFilenameOptions) => {
  const formatExt = normalizeAssetExtension(options.format || '');
  const fromHeader = parseContentDispositionFilename(options.contentDisposition);
  const fromUrl = options.url ? filenameFromUrlPath(options.url) : '';
  const fromMeta = options.metadataFilename ? decodeUrlEncodedFilename(options.metadataFilename) : '';
  const fromPreferred = String(options.preferredBase || '').trim();

  let candidate = '';
  if (fromHeader) candidate = fromHeader;
  else if (fromPreferred) candidate = fromPreferred.includes('.') || !formatExt ? fromPreferred : `${fromPreferred}.${formatExt}`;
  else if (fromUrl) candidate = fromUrl;
  else if (fromMeta) candidate = fromMeta.includes('.') ? fromMeta : formatExt ? `${fromMeta}.${formatExt}` : fromMeta;
  else candidate = `${options.fallbackBase || 'asset'}${formatExt ? `.${formatExt}` : '.bin'}`;

  if (formatExt && !path.extname(candidate)) candidate = `${candidate}.${formatExt}`;
  return sanitizeFullFilename(candidate, formatExt);
};

const uniqueFilenameInSet = (filename: string, used: Set<string>) => {
  let candidate = sanitizeFullFilename(filename);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const ext = path.extname(candidate);
  const base = path.basename(candidate, ext) || 'asset';
  let index = 1;
  while (used.has(`${base}-${index}${ext}`)) index += 1;
  candidate = `${base}-${index}${ext}`;
  used.add(candidate);
  return candidate;
};

const uniqueZipPathInSet = (zipPath: string, used: Set<string>) => {
  const normalized = String(zipPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  const file = parts.length ? parts.pop()! : 'asset.bin';
  const safeFile = sanitizeFullFilename(file);
  const safeDir = parts.map((segment) => sanitizeFilenameBase(segment)).filter(Boolean).join('/');
  let candidate = safeDir ? `${safeDir}/${safeFile}` : safeFile;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const ext = path.extname(safeFile);
  const base = path.basename(safeFile, ext) || 'asset';
  let index = 1;
  while (used.has(safeDir ? `${safeDir}/${base}-${index}${ext}` : `${base}-${index}${ext}`)) index += 1;
  candidate = safeDir ? `${safeDir}/${base}-${index}${ext}` : `${base}-${index}${ext}`;
  used.add(candidate);
  return candidate;
};

const reconcileZipEntryNameWithBuffer = (zipEntryName: string, buffer: Buffer) => {
  const normalized = String(zipEntryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  const file = parts.length ? parts.pop()! : 'asset.bin';
  const reconciledFile = reconcileImageFilenameWithBuffer(file, buffer);
  return parts.length ? `${parts.join('/')}/${reconciledFile}` : reconciledFile;
};

const uniqueDownloadFilePath = async (
  filename: string,
  options: { sourcePageUrl?: string; kind?: DownloadSaveKind; subfolder?: string; rootFolderName?: string } = {}
) => {
  const requestedRootFolderName = sanitizeFilenameBase(String(options.rootFolderName || '').trim());
  const rootFolderName = /^(?:asset|assets|image|images|font|fonts|video|videos)$/i.test(requestedRootFolderName)
    ? ''
    : requestedRootFolderName;
  const pageUrl = normalizeProjectSourcePageUrl(
    String(options.sourcePageUrl || (rootFolderName ? '' : lastExtractedSourceUrl) || '').trim()
  );
  const baseTargetDir = rootFolderName
    ? path.join(downloadsDir, rootFolderName)
    : resolveDownloadSaveDir(options.kind || 'default', pageUrl);
  const rawSubfolder = String(options.subfolder || '').trim();
  const safeSubfolder = rawSubfolder ? sanitizeFilenameBase(rawSubfolder) : '';
  const targetDir = safeSubfolder ? path.join(baseTargetDir, safeSubfolder) : baseTargetDir;
  if (!rootFolderName) {
    await removeEmptyCreativeAssetFolders(pageUrl);
  }
  await fsp.mkdir(assertPathInsideDownloads(targetDir), { recursive: true });
  const safeFilename = sanitizeFullFilename(filename);
  const ext = path.extname(safeFilename);
  const base = path.basename(safeFilename, ext) || 'asset';
  let candidate = safeFilename;
  let index = 1;
  while (true) {
    const filePath = path.join(targetDir, candidate);
    const resolved = assertPathInsideDownloads(filePath);
    try {
      await fsp.access(resolved);
      candidate = `${base}-${index}${ext}`;
      index += 1;
    } catch {
      return { filePath: resolved, filename: candidate, folderPath: targetDir };
    }
  }
};

const saveBufferToDownloads = async (
  buffer: Buffer,
  filename: string,
  label = 'Download',
  sourcePageUrl?: string,
  kind: DownloadSaveKind = 'default',
  subfolder = ''
) => {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error(`${label} produced an empty file.`);
  }
  const detectedImageFormat = kind === 'image' || /\.svg$/i.test(filename)
    ? detectImageFormatFromBuffer(buffer)
    : '';
  const writeBuffer = detectedImageFormat === 'svg'
    ? normalizeSvgBufferForIllustrator(buffer)
    : buffer;
  const safeFilename = kind === 'image'
    ? reconcileImageFilenameWithBuffer(filename, writeBuffer)
    : filename;
  const target = await uniqueDownloadFilePath(safeFilename, { sourcePageUrl, kind, subfolder });
  await fsp.writeFile(target.filePath, writeBuffer);
  const stat = await validateSavedAssetFile(target.filePath, label);
  return {
    ok: true,
    filename: target.filename,
    downloadPath: target.filePath,
    localPath: target.filePath,
    folderPath: target.folderPath,
    size: stat.size,
  };
};

const saveCachedFileToDownloads = async (
  sourcePath: string,
  filename: string,
  label = 'Download',
  sourcePageUrl?: string,
  kind: DownloadSaveKind = 'default'
) => {
  if (!sourcePath) throw new Error(`${label} cache path is missing.`);
  if (kind === 'image' || /\.svg$/i.test(filename) || /\.svg$/i.test(sourcePath)) {
    const sourceBuffer = await fsp.readFile(sourcePath);
    const detectedImageFormat = detectImageFormatFromBuffer(sourceBuffer);
    const writeBuffer = detectedImageFormat === 'svg'
      ? normalizeSvgBufferForIllustrator(sourceBuffer)
      : sourceBuffer;
    const safeFilename = kind === 'image'
      ? reconcileImageFilenameWithBuffer(filename, writeBuffer)
      : filename;
    const target = await uniqueDownloadFilePath(safeFilename, { sourcePageUrl, kind });
    await fsp.writeFile(target.filePath, writeBuffer);
    const stat = await validateSavedAssetFile(target.filePath, label);
    return {
      ok: true,
      filename: target.filename,
      downloadPath: target.filePath,
      localPath: target.filePath,
      folderPath: target.folderPath,
      size: stat.size,
    };
  } else {
    const target = await uniqueDownloadFilePath(filename, { sourcePageUrl, kind });
    await fsp.copyFile(sourcePath, target.filePath);
    const stat = await validateSavedAssetFile(target.filePath, label);
    return {
      ok: true,
      filename: target.filename,
      downloadPath: target.filePath,
      localPath: target.filePath,
      folderPath: target.folderPath,
      size: stat.size,
    };
  }
};

const convertedImageCachePath = (lookupUrl: string, targetFormat: string) =>
  path.join(cachedImageDir, `${assetCacheKey(lookupUrl, targetFormat)}.${targetFormat}`);

const readValidatedConvertedImageCache = async (lookupUrl: string, targetFormat: RasterOutputFormat) => {
  const cachePath = convertedImageCachePath(lookupUrl, targetFormat);
  const cached = await readCachedFileIfExists(cachePath);
  if (!cached) return null;
  if (!isValidRasterOutputBuffer(cached, targetFormat)) {
    await fsp.unlink(cachePath).catch(() => undefined);
    return null;
  }
  return { buffer: cached, cachePath };
};

const originalCacheKindDir = (kind: 'image' | 'font') =>
  kind === 'image' ? cachedImageOriginalDir : cachedFontOriginalDir;

const originalCachePublicDir = (kind: 'image' | 'font') =>
  kind === 'image' ? '/cached-images-original' : '/cached-fonts-original';

const publicUrlFromAbsoluteCachePath = (absolutePath: string, kind: 'image' | 'font' = 'image') => {
  const normalized = String(absolutePath || '').replace(/\\/g, '/');
  if (!normalized) return '';
  const publicPrefix = originalCachePublicDir(kind);
  const directIdx = normalized.indexOf(`${publicPrefix}/`);
  if (directIdx >= 0) return normalized.slice(directIdx);
  const base = originalCacheKindDir(kind).replace(/\\/g, '/');
  if (normalized.startsWith(`${base}/`)) {
    return `${publicPrefix}/${normalized.slice(base.length + 1)}`;
  }
  return '';
};

const resolveCachedPublicUrl = async (
  publicPath: string,
  normalized: string,
  originalUrl: string
) => {
  if (publicPath.startsWith('/cached-')) return publicPath;
  const cachePath =
    (await getAssetCacheDebugPath(publicPath, 'image')) ||
    (await getAssetCacheDebugPath(normalized, 'image')) ||
    (originalUrl ? await getAssetCacheDebugPath(originalUrl, 'image') : '') ||
    '';
  return publicUrlFromAbsoluteCachePath(cachePath, 'image');
};

const originalCacheIndexPath = (kind: 'image' | 'font') =>
  path.join(originalCacheKindDir(kind), '.url-index.json');

const loadOriginalCacheIndex = async (kind: 'image' | 'font') => {
  try {
    const raw = await fsp.readFile(originalCacheIndexPath(kind), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
};

const saveOriginalCacheIndex = async (kind: 'image' | 'font', index: Record<string, string>) => {
  await fsp.mkdir(originalCacheKindDir(kind), { recursive: true });
  await fsp.writeFile(originalCacheIndexPath(kind), JSON.stringify(index));
};

const originalCacheLookupKey = (url: string) => assetCacheKey(normalizeAssetRequestUrl(url) || url, 'original-lookup');

const findLegacyHashOriginalCachePath = async (url: string, kind: 'image' | 'font') => {
  const cacheDir = originalCacheKindDir(kind);
  const key = assetCacheKey(url, `original-${kind}`);
  const candidates =
    kind === 'image'
      ? ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bin']
      : ['woff2', 'woff', 'ttf', 'otf', 'eot', 'svg', 'bin'];
  for (const ext of candidates) {
    const filePath = path.join(cacheDir, `${key}.${ext}`);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size <= 0) continue;
      if (kind === 'image') {
        const buffer = await fsp.readFile(filePath);
        if (!isValidImageBuffer(buffer, guessContentTypeFromPath(filePath))) {
          await fsp.unlink(filePath).catch(() => undefined);
          continue;
        }
      }
      return filePath;
    } catch {
      // keep trying
    }
  }
  return null;
};

const resolveOriginalCachedAsset = async (url: string, kind: 'image' | 'font') => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  const index = await loadOriginalCacheIndex(kind);
  const indexedName = index[originalCacheLookupKey(normalized)];
  if (indexedName) {
    const filePath = path.join(originalCacheKindDir(kind), indexedName);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size > 0) {
        const buffer = await fsp.readFile(filePath);
        const contentType = guessContentTypeFromPath(filePath);
        const valid =
          kind === 'image'
            ? isValidImageBuffer(buffer, contentType)
            : isValidFontOriginalBuffer(buffer, contentType);
        if (!valid) {
          await fsp.unlink(filePath).catch(() => undefined);
          delete index[originalCacheLookupKey(normalized)];
          await saveOriginalCacheIndex(kind, index).catch(() => undefined);
        } else {
          return {
            filePath,
            filename: indexedName,
            cachedUrl: `${originalCachePublicDir(kind)}/${indexedName}`,
          };
        }
      }
    } catch {
      // fall through
    }
  }
  const legacyPath = await findLegacyHashOriginalCachePath(normalized, kind);
  if (!legacyPath) return null;
  const filename = path.basename(legacyPath);
  return {
    filePath: legacyPath,
    filename,
    cachedUrl: `${originalCachePublicDir(kind)}/${filename}`,
  };
};

const writeOriginalCachedAsset = async (
  url: string,
  kind: 'image' | 'font',
  buffer: Buffer,
  options: {
    contentType?: string;
    contentDisposition?: string;
    metadataFilename?: string;
    hintType?: string;
    preferredBase?: string;
  } = {}
) => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  const cacheDir = originalCacheKindDir(kind);
  await fsp.mkdir(cacheDir, { recursive: true });

  const existing = await resolveOriginalCachedAsset(url, kind);
  if (existing) {
    try {
      const current = await fsp.readFile(existing.filePath);
      const currentType = guessContentTypeFromPath(existing.filePath);
      const validOriginal =
        current.length > 0 &&
        (kind === 'image'
          ? isValidImageBuffer(current, currentType)
          : isValidFontOriginalBuffer(current, currentType));
      if (validOriginal) {
        return existing.cachedUrl;
      }
      await fsp.unlink(existing.filePath).catch(() => undefined);
    } catch {
      // rewrite below
    }
  }

  if (kind === 'font' && !isValidFontOriginalBuffer(buffer, options.contentType || '')) {
    return '';
  }

  const writeBuffer = kind === 'image' && detectImageFormatFromBuffer(buffer) === 'svg'
    ? normalizeSvgBufferForIllustrator(buffer)
    : buffer;

  const ext =
    kind === 'image'
      ? safeExtFromAssetType(
          detectImageFormatFromBuffer(writeBuffer) ||
            inferImageTypeFromUrl(normalized, options.contentType || '') ||
            options.hintType ||
            'bin'
        )
      : safeExtFromAssetType(getFontFormatFromUrlOrType(normalized, options.contentType || '') || options.hintType || 'bin');

  const desired = deriveAssetFilename({
    url: normalized.startsWith('http') ? normalized : url,
    contentDisposition: options.contentDisposition,
    metadataFilename: options.metadataFilename,
    preferredBase: options.preferredBase,
    format: ext,
    fallbackBase: kind === 'image' ? 'image' : 'font',
  });

  const existingFiles = await fsp.readdir(cacheDir).catch(() => [] as string[]);
  const used = new Set(existingFiles.filter((name) => !name.startsWith('.')));
  const filename = uniqueFilenameInSet(desired, used);
  await fsp.writeFile(path.join(cacheDir, filename), writeBuffer);

  const index = await loadOriginalCacheIndex(kind);
  index[originalCacheLookupKey(normalized)] = filename;
  await saveOriginalCacheIndex(kind, index);

  const legacyPath = await findLegacyHashOriginalCachePath(normalized, kind);
  if (legacyPath && path.basename(legacyPath) !== filename) {
    await fsp.unlink(legacyPath).catch(() => undefined);
  }

  return `${originalCachePublicDir(kind)}/${filename}`;
};

const buildDownloadFilename = (
  url: string,
  format: string,
  preferredBase?: string,
  extras: { contentDisposition?: string; metadataFilename?: string } = {}
) =>
  deriveAssetFilename({
    url,
    format,
    preferredBase,
    contentDisposition: extras.contentDisposition,
    metadataFilename: extras.metadataFilename,
    fallbackBase: 'asset',
  });

const getCachedConvertedImage = async (
  url: string,
  requestedFormat?: string,
  options?: {
    prefetched?: { buffer: Buffer; contentType: string; contentDisposition?: string };
    filenameBase?: string;
    originalUrl?: string;
    metadataFilename?: string;
    cacheOnly?: boolean;
    refererPageUrl?: string;
    skipBrowser?: boolean;
  }
) => {
  await fsp.mkdir(cachedImageDir, { recursive: true });
  const normalizedUrl = normalizeAssetRequestUrl(url);
  const lookupUrl = String(options?.originalUrl || normalizedUrl || '').trim();
  const preferredBase = options?.filenameBase;
  const filenameSourceUrl = options?.originalUrl || normalizedUrl;
  const filenameExtras = {
    contentDisposition: (options?.prefetched as any)?.contentDisposition,
    metadataFilename: options?.metadataFilename,
  };

  const requestedTarget = normalizeRasterFormat(requestedFormat || '');
  const wantsPreconvertedTarget = ['png', 'jpg'].includes(requestedTarget);
  if (wantsPreconvertedTarget) {
    const targetFormat = requestedTarget as RasterOutputFormat;
    const cacheKeyUrl = lookupUrl || normalizedUrl;
    const convertedHit = await readValidatedConvertedImageCache(cacheKeyUrl, targetFormat);
    if (convertedHit) {
      return {
        buffer: convertedHit.buffer,
        format: targetFormat,
        filename: buildDownloadFilename(filenameSourceUrl, targetFormat, preferredBase, filenameExtras),
        cachedPath: convertedHit.cachePath,
      };
    }
  }

  const cachedOriginal =
    !options?.prefetched
      ? (await readAssetBufferFromCache(normalizedUrl, 'image')) ||
        (lookupUrl && lookupUrl !== normalizedUrl ? await readAssetBufferFromCache(lookupUrl, 'image') : null)
      : null;

  if (options?.cacheOnly && !options?.prefetched && !cachedOriginal) {
    if (wantsPreconvertedTarget) {
      throw new Error(`Converted ${requestedTarget.toUpperCase()} is not cached yet for this image.`);
    }
    throw new Error('Image is not cached yet. Extract the page first, then download again.');
  }

  const fetched =
    options?.prefetched ||
  cachedOriginal ||
    (await fetchAssetBuffer(normalizedUrl, options?.originalUrl || '', {
      cacheOnly: options?.cacheOnly,
      refererPageUrl: options?.refererPageUrl,
      skipBrowser: options?.skipBrowser,
    }));
  if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
    throw new Error(`Downloaded asset is not a valid image: ${normalizedUrl}`);
  }
  let sourceFormat = resolveRasterSourceFormat(
    fetched.buffer,
    normalizedUrl,
    lookupUrl,
    fetched.contentType
  );
  const bufferFormat = detectRasterFormatFromBuffer(fetched.buffer);
  if (RASTER_CONVERTIBLE_FORMATS.has(bufferFormat)) {
    sourceFormat = bufferFormat;
  }
  const normalizedSource = normalizeRasterFormat(sourceFormat);
  const preparedSourceBuffer = normalizedSource === 'svg'
    ? materializeSvgFragmentForIllustrator(fetched.buffer, lookupUrl || normalizedUrl)
    : fetched.buffer;
  const defaultTarget =
    normalizedSource === 'webp' ? 'jpg' :
    normalizedSource === 'avif' ? 'png' :
    normalizedSource;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  filenameExtras.contentDisposition = (fetched as any).contentDisposition || options?.prefetched?.contentDisposition;

  if (normalizedTarget === 'svg' && normalizedSource !== 'svg' && IMAGE_BINARY_FORMATS.has(normalizedSource)) {
    const wrappedSvg = wrapRasterBufferAsIllustratorSvg(fetched.buffer, normalizedSource, filenameSourceUrl);
    return {
      buffer: normalizeSvgBufferForIllustrator(wrappedSvg),
      format: 'svg',
      filename: buildDownloadFilename(filenameSourceUrl, 'svg', preferredBase, filenameExtras),
      cachedPath: '',
    };
  }

  const wantsRasterConversion =
    ['png', 'jpg'].includes(normalizedTarget) &&
    RASTER_CONVERTIBLE_FORMATS.has(normalizedSource) &&
    supportedRasterConversionTargets(normalizedSource).includes(normalizedTarget as RasterOutputFormat);

  if (!wantsRasterConversion) {
    const cachePath = path.join(cachedImageDir, `${assetCacheKey(normalizedUrl, 'original')}.${sourceFormat || 'bin'}`);
    let cached = await readCachedFileIfExists(cachePath);
    if (cached && !isValidImageBuffer(cached, guessContentTypeFromPath(cachePath))) {
      await fsp.unlink(cachePath).catch(() => undefined);
      cached = null;
    }
    if (!cached) {
      await fsp.writeFile(cachePath, preparedSourceBuffer);
      cached = preparedSourceBuffer;
    }
    const passthroughBuffer = cached || fetched.buffer;
    if (RASTER_CONVERTIBLE_FORMATS.has(normalizedSource)) {
      const detected = detectRasterFormatFromBuffer(passthroughBuffer);
      if (detected && detected !== normalizedSource) {
        throw new Error(`Cached image format mismatch for ${lookupUrl || normalizedUrl}`);
      }
    }
    return {
      buffer: passthroughBuffer,
      format: normalizedSource || 'bin',
      filename: buildDownloadFilename(filenameSourceUrl, normalizedSource || 'bin', preferredBase, filenameExtras),
      cachedPath: cachePath,
    };
  }

  const targetFormat = normalizedTarget as RasterOutputFormat;
  const cacheKeyUrl = lookupUrl || normalizedUrl;
  const cachePath = convertedImageCachePath(cacheKeyUrl, targetFormat);
  let cached = (await readValidatedConvertedImageCache(cacheKeyUrl, targetFormat))?.buffer || null;
  if (!cached) {
    cached = await convertRasterImageBuffer(preparedSourceBuffer, targetFormat);
    await fsp.writeFile(cachePath, cached);
  }

  if (!isValidRasterOutputBuffer(cached, targetFormat)) {
    throw new Error(`Converted cache is not valid ${targetFormat.toUpperCase()} for ${lookupUrl || normalizedUrl}`);
  }

  return {
    buffer: cached,
    format: targetFormat,
    filename: buildDownloadFilename(filenameSourceUrl, targetFormat, preferredBase, filenameExtras),
    cachedPath: cachePath,
  };
};

const getCurlFetchedConvertedImage = async (
  url: string,
  requestedFormat?: string,
  options?: {
    filenameBase?: string;
    originalUrl?: string;
    metadataFilename?: string;
  }
) => {
  const normalizedUrl = normalizeAssetRequestUrl(url);
  if (!normalizedUrl || !normalizedUrl.startsWith('http')) return null;
  let fetched: { buffer: Buffer; contentType: string; contentDisposition?: string } | null = null;
  const referer = (() => {
    try {
      return `${new URL(normalizedUrl).origin}/`;
    } catch {
      return '';
    }
  })();
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await axios.get(normalizedUrl, {
        responseType: 'arraybuffer',
        timeout: 12000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
        httpsAgent: relaxedHttpsAgent,
        headers: {
          'User-Agent': userAgent,
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
      });
      const buffer = Buffer.from(response.data);
      const contentType = String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || '');
      const contentDisposition = String(response.headers?.['content-disposition'] || response.headers?.['Content-Disposition'] || '');
      if (isValidImageBuffer(buffer, contentType)) {
        fetched = { buffer, contentType, contentDisposition };
        break;
      }
    } catch {
      // Try the next user agent.
    }
  }
  fetched ||= await fetchRemoteImageBufferViaCurl(normalizedUrl);
  if (!fetched || !isValidImageBuffer(fetched.buffer, fetched.contentType)) return null;

  const lookupUrl = String(options?.originalUrl || normalizedUrl).trim();
  const filenameSourceUrl = options?.originalUrl || normalizedUrl;
  const preferredBase = options?.filenameBase;
  const filenameExtras = { metadataFilename: options?.metadataFilename };
  const sourceFormat = normalizeRasterFormat(
    detectRasterFormatFromBuffer(fetched.buffer) ||
      detectImageFormatFromBuffer(fetched.buffer) ||
      inferImageTypeFromContentType(fetched.contentType) ||
      inferImageTypeFromUrl(lookupUrl || normalizedUrl, fetched.contentType) ||
      getAssetTypeFromUrl(lookupUrl || normalizedUrl, 'bin')
  );
  const preparedSourceBuffer = sourceFormat === 'svg'
    ? materializeSvgFragmentForIllustrator(fetched.buffer, lookupUrl || normalizedUrl)
    : fetched.buffer;
  const defaultTarget =
    sourceFormat === 'webp' ? 'jpg' :
    sourceFormat === 'avif' ? 'png' :
    sourceFormat;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  if (normalizedTarget === 'svg' && sourceFormat !== 'svg' && IMAGE_BINARY_FORMATS.has(sourceFormat)) {
    const wrappedSvg = wrapRasterBufferAsIllustratorSvg(fetched.buffer, sourceFormat, filenameSourceUrl);
    return {
      buffer: normalizeSvgBufferForIllustrator(wrappedSvg),
      format: 'svg',
      filename: buildDownloadFilename(filenameSourceUrl, 'svg', preferredBase, filenameExtras),
      cachedPath: '',
    };
  }
  const wantsRasterConversion =
    ['png', 'jpg'].includes(normalizedTarget) &&
    RASTER_CONVERTIBLE_FORMATS.has(sourceFormat) &&
    supportedRasterConversionTargets(sourceFormat).includes(normalizedTarget as RasterOutputFormat);

  if (wantsRasterConversion) {
    const targetFormat = normalizedTarget as RasterOutputFormat;
    const converted = await convertRasterImageBuffer(preparedSourceBuffer, targetFormat);
    if (!isValidRasterOutputBuffer(converted, targetFormat)) return null;
    const cacheKeyUrl = lookupUrl || normalizedUrl;
    const cachePath = convertedImageCachePath(cacheKeyUrl, targetFormat);
    await fsp.writeFile(cachePath, converted).catch(() => undefined);
    return {
      buffer: converted,
      format: targetFormat,
      filename: buildDownloadFilename(filenameSourceUrl, targetFormat, preferredBase, filenameExtras),
      cachedPath: cachePath,
    };
  }

  const cachedUrl = await writeOriginalCachedAsset(lookupUrl || normalizedUrl, 'image', fetched.buffer, {
    contentType: fetched.contentType,
    hintType: sourceFormat || 'bin',
    preferredBase,
  });
  const resolved = cachedUrl ? await resolveOriginalCachedAsset(lookupUrl || normalizedUrl, 'image') : null;
  return {
    buffer: preparedSourceBuffer,
    format: sourceFormat || 'bin',
    filename: buildDownloadFilename(filenameSourceUrl, sourceFormat || 'bin', preferredBase, filenameExtras),
    cachedPath: resolved?.filePath || '',
  };
};

const warmRasterConversionVariants = async (url: string, cachedUrl = '') => {
  const originalUrl = String(url || '').trim();
  if (!originalUrl || !/\.(?:webp|avif)(?:[?#]|$)/i.test(originalUrl)) return;
  const convertUrl = String(cachedUrl || '').trim() || originalUrl;
  await Promise.all(
    (['png', 'jpg'] as const).map(async (format) => {
      try {
        await getCachedConvertedImage(convertUrl, format, { originalUrl });
      } catch {
        // Best-effort pre-conversion for faster WEBP/AVIF downloads.
      }
    })
  );
};

const warmFontConversionVariants = async (
  url: string,
  cachedUrl = '',
  originalFormat = 'unknown',
  options: { refererPageUrl?: string; cssSource?: string } = {}
) => {
  const originalUrl = String(url || '').trim();
  if (!originalUrl) return;
  const convertUrl = String(cachedUrl || '').trim() || originalUrl;
  const refererPageUrl = resolveFontRefererPage(options.cssSource || '', options.refererPageUrl || '');
  const targets = getFontConversionOutputs(originalFormat);
  await Promise.all(
    targets.map(async (format) => {
      try {
        await convertFontAsset(convertUrl, format, originalFormat, undefined, {
          originalUrl,
          refererPageUrl: refererPageUrl || undefined,
        });
      } catch {
        // Best-effort pre-conversion for faster font ZIP downloads.
      }
    })
  );
};

const normalizeFontFormat = (format: string, contentType = '') => {
  let fromFormat = String(format || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fromFormat === 'truetype') fromFormat = 'ttf';
  if (fromFormat === 'opentype') fromFormat = 'otf';
  if (fromFormat === 'unknown' || !fromFormat) {
    const value = contentType.toLowerCase();
    if (value.includes('woff2')) fromFormat = 'woff2';
    else if (value.includes('woff')) fromFormat = 'woff';
    else if (value.includes('ttf') || value.includes('truetype')) fromFormat = 'ttf';
    else if (value.includes('otf') || value.includes('opentype')) fromFormat = 'otf';
    else if (value.includes('svg')) fromFormat = 'svg';
    else if (value.includes('eot')) fromFormat = 'eot';
  }
  return fromFormat;
};

const detectFontFormatFromBuffer = (buffer: Buffer) => {
  if (!buffer || buffer.length < 4) return '';
  const sig = buffer.slice(0, 4).toString('latin1');
  if (sig === 'wOF2') return 'woff2';
  if (sig === 'wOFF') return 'woff';
  if (sig === 'OTTO') return 'otf';
  if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0) return 'ttf';
  return '';
};

const normalizeTtfIdentity = (filenameBase: string) => {
  const clean = String(filenameBase || 'Font')
    .replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, '')
    .replace(/[_]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'Font';
  const variantMatch = clean.match(/^(.*?)[- ](Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black)(?:[- ]?(Italic|Oblique))?$/i);
  const family = (variantMatch?.[1] || clean).replace(/[- ]+$/g, '').trim() || 'Font';
  const weight = variantMatch?.[2] || 'Regular';
  const slant = variantMatch?.[3] || '';
  const subfamily = [weight, slant].filter(Boolean).join(' ') || 'Regular';
  const fullName = subfamily === 'Regular' ? family : `${family} ${subfamily}`;
  // Use a distinct PostScript identity so Font Book does not reuse cached
  // validation/name data from the original web-only font with the same name.
  const postScriptName = `${family}CAE-${subfamily}`
    .replace(/[^A-Za-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .slice(0, 63) || 'Font-Regular';
  return { family, subfamily, fullName, postScriptName };
};

const sfntChecksum = (buffer: Buffer) => {
  let sum = 0;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const word = Buffer.alloc(4);
    buffer.copy(word, 0, offset, Math.min(offset + 4, buffer.length));
    sum = (sum + word.readUInt32BE(0)) >>> 0;
  }
  return sum >>> 0;
};

/** macOS requires SFNT directory entries to be sorted by their four-byte tag.
 * fonteditor-core preserves glyphs but can emit this directory out of order. */
const normalizeTtfSfntDirectory = (buffer: Buffer) => {
  if (detectFontFormatFromBuffer(buffer) !== 'ttf' || buffer.length < 12) return buffer;
  const tableCount = buffer.readUInt16BE(4);
  if (tableCount < 1 || tableCount > 256 || 12 + tableCount * 16 > buffer.length) return buffer;
  const output = Buffer.from(buffer);
  const entries = Array.from({ length: tableCount }, (_, index) => {
    const offset = 12 + index * 16;
    return { tag: output.toString('latin1', offset, offset + 4), bytes: Buffer.from(output.subarray(offset, offset + 16)) };
  }).sort((a, b) => Buffer.from(a.tag, 'latin1').compare(Buffer.from(b.tag, 'latin1')));
  entries.forEach((entry, index) => entry.bytes.copy(output, 12 + index * 16));

  const head = entries.find((entry) => entry.tag === 'head');
  if (head) {
    const headOffset = head.bytes.readUInt32BE(8);
    if (headOffset + 12 <= output.length) {
      output.writeUInt32BE(0, headOffset + 8);
      const adjustment = (0xb1b0afba - sfntChecksum(output)) >>> 0;
      output.writeUInt32BE(adjustment, headOffset + 8);
    }
  }
  return output;
};

const encodeSfntName = (value: string, platformId: number) => {
  if (platformId === 0 || platformId === 3) {
    const output = Buffer.alloc(value.length * 2);
    for (let index = 0; index < value.length; index += 1) output.writeUInt16BE(value.charCodeAt(index), index * 2);
    return output;
  }
  return Buffer.from(value.replace(/[^\x20-\x7e]/g, ''), 'latin1');
};

const rewriteTtfNameRecords = (buffer: Buffer, values: Record<number, string>) => {
  const tableCount = buffer.readUInt16BE(4);
  const sourceTables = Array.from({ length: tableCount }, (_, index) => {
    const directoryOffset = 12 + index * 16;
    const tag = buffer.toString('latin1', directoryOffset, directoryOffset + 4);
    const offset = buffer.readUInt32BE(directoryOffset + 8);
    const length = buffer.readUInt32BE(directoryOffset + 12);
    return { tag, data: Buffer.from(buffer.subarray(offset, offset + length)) };
  });
  const nameTable = sourceTables.find((table) => table.tag === 'name');
  if (!nameTable || nameTable.data.length < 6) throw new Error('TTF name table is missing.');
  const format = nameTable.data.readUInt16BE(0);
  const recordCount = nameTable.data.readUInt16BE(2);
  const stringOffset = nameTable.data.readUInt16BE(4);
  if (format !== 0 || stringOffset < 6 + recordCount * 12 || stringOffset > nameTable.data.length) {
    throw new Error('Unsupported TTF name-table layout.');
  }

  const records: Array<{ platformId: number; encodingId: number; languageId: number; nameId: number; bytes: Buffer }> = [];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 6 + index * 12;
    const platformId = nameTable.data.readUInt16BE(offset);
    const encodingId = nameTable.data.readUInt16BE(offset + 2);
    const languageId = nameTable.data.readUInt16BE(offset + 4);
    const nameId = nameTable.data.readUInt16BE(offset + 6);
    const length = nameTable.data.readUInt16BE(offset + 8);
    const relativeOffset = nameTable.data.readUInt16BE(offset + 10);
    const start = stringOffset + relativeOffset;
    const original = start + length <= nameTable.data.length
      ? Buffer.from(nameTable.data.subarray(start, start + length))
      : Buffer.alloc(0);
    records.push({
      platformId,
      encodingId,
      languageId,
      nameId,
      bytes: values[nameId] ? encodeSfntName(values[nameId], platformId) : original,
    });
  }

  const rebuiltName = Buffer.alloc(6 + recordCount * 12 + records.reduce((sum, record) => sum + record.bytes.length, 0));
  rebuiltName.writeUInt16BE(0, 0);
  rebuiltName.writeUInt16BE(recordCount, 2);
  rebuiltName.writeUInt16BE(6 + recordCount * 12, 4);
  let nameStorageOffset = 0;
  records.forEach((record, index) => {
    const offset = 6 + index * 12;
    rebuiltName.writeUInt16BE(record.platformId, offset);
    rebuiltName.writeUInt16BE(record.encodingId, offset + 2);
    rebuiltName.writeUInt16BE(record.languageId, offset + 4);
    rebuiltName.writeUInt16BE(record.nameId, offset + 6);
    rebuiltName.writeUInt16BE(record.bytes.length, offset + 8);
    rebuiltName.writeUInt16BE(nameStorageOffset, offset + 10);
    record.bytes.copy(rebuiltName, 6 + recordCount * 12 + nameStorageOffset);
    nameStorageOffset += record.bytes.length;
  });
  nameTable.data = rebuiltName;

  const tables = sourceTables.sort((a, b) => Buffer.from(a.tag, 'latin1').compare(Buffer.from(b.tag, 'latin1')));
  const maxPower = 2 ** Math.floor(Math.log2(tables.length));
  const headerSize = 12 + tables.length * 16;
  let dataOffset = (headerSize + 3) & ~3;
  const placements = tables.map((table) => {
    const placement = { ...table, offset: dataOffset };
    dataOffset += (table.data.length + 3) & ~3;
    return placement;
  });
  const output = Buffer.alloc(dataOffset);
  buffer.copy(output, 0, 0, 4);
  output.writeUInt16BE(tables.length, 4);
  output.writeUInt16BE(maxPower * 16, 6);
  output.writeUInt16BE(Math.log2(maxPower), 8);
  output.writeUInt16BE(tables.length * 16 - maxPower * 16, 10);
  placements.forEach((table, index) => {
    const directoryOffset = 12 + index * 16;
    output.write(table.tag, directoryOffset, 4, 'latin1');
    const checksumData = Buffer.from(table.data);
    if (table.tag === 'head' && checksumData.length >= 12) checksumData.writeUInt32BE(0, 8);
    output.writeUInt32BE(sfntChecksum(checksumData), directoryOffset + 4);
    output.writeUInt32BE(table.offset, directoryOffset + 8);
    output.writeUInt32BE(table.data.length, directoryOffset + 12);
    checksumData.copy(output, table.offset);
  });
  const head = placements.find((table) => table.tag === 'head');
  if (head && head.offset + 12 <= output.length) {
    output.writeUInt32BE((0xb1b0afba - sfntChecksum(output)) >>> 0, head.offset + 8);
  }
  return output;
};

const fontWeightName = (value: string) => {
  const normalized = String(value || '').trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric <= 100) return 'Thin';
    if (numeric <= 200) return 'ExtraLight';
    if (numeric <= 300) return 'Light';
    if (numeric <= 400) return 'Regular';
    if (numeric <= 500) return 'Medium';
    if (numeric <= 600) return 'SemiBold';
    if (numeric <= 700) return 'Bold';
    if (numeric <= 800) return 'ExtraBold';
    return 'Black';
  }
  const aliases: Record<string, string> = {
    thin: 'Thin', hairline: 'Thin', extralight: 'ExtraLight', 'extra light': 'ExtraLight',
    ultralight: 'ExtraLight', light: 'Light', normal: 'Regular', regular: 'Regular',
    book: 'Book', medium: 'Medium', semibold: 'SemiBold', 'semi bold': 'SemiBold',
    demibold: 'SemiBold', bold: 'Bold', extrabold: 'ExtraBold', 'extra bold': 'ExtraBold',
    ultrabold: 'ExtraBold', black: 'Black', heavy: 'Black',
  };
  return aliases[normalized] || '';
};

const buildTtfIdentityBase = (preferredBase: string | undefined, extras: ConvertFontExtras) => {
  const explicit = String(preferredBase || '').trim();
  if (explicit && !/^font(?:[-_ ]?\d+)?$/i.test(explicit)) return explicit;
  const family = String(extras.fontFamily || extras.metadataFilename || explicit || 'Font')
    .replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, '')
    .trim() || 'Font';
  const weight = fontWeightName(String(extras.fontWeight || '')) || 'Regular';
  const slant = /italic/i.test(String(extras.fontStyle || ''))
    ? 'Italic'
    : /oblique/i.test(String(extras.fontStyle || '')) ? 'Oblique' : '';
  return [family, weight === 'Regular' && !slant ? '' : weight, slant].filter(Boolean).join(' ');
};

const repairTtfNameTable = (buffer: Buffer, filenameBase: string) => {
  if (detectFontFormatFromBuffer(buffer) !== 'ttf') return buffer;
  const requestedIdentity = normalizeTtfIdentity(filenameBase);
  const font = Font.create(buffer, { type: 'ttf', hinting: true, kerning: true });
  const data = font.get();
  const isUsableIdentityName = (value: unknown) => {
    const text = String(value || '').trim();
    return Boolean(text) && !/not licensed|copyright|all rights reserved|webfont|web font|type foundry$/i.test(text);
  };
  // Keep every downloaded face linked to the CSS/extracted family shown in the
  // app. Some webfonts expose a different preferred family (for example,
  // "Tiempos Headline") which causes macOS to hide Medium in a separate family
  // while Regular appears under "Tiempos". The requested identity has already
  // been sanitized and includes the extracted weight/style.
  const family = isUsableIdentityName(requestedIdentity.family)
    ? requestedIdentity.family
    : String(data.name?.preferredFamily || 'Font').trim();
  const subfamily = isUsableIdentityName(requestedIdentity.subfamily)
    ? requestedIdentity.subfamily
    : String(data.name?.preferredSubFamily || 'Regular').trim();
  const fullName = subfamily === 'Regular' ? family : `${family} ${subfamily}`;
  // Keep a converter-specific PostScript identity. Font Book caches validation
  // and legacy name records by this value, so reusing the webfont's original
  // identity can surface its old "Not Licensed for Desktop Use" subfamily even
  // after every visible name record has been repaired.
  const postScriptName = requestedIdentity.postScriptName;
  const repaired = rewriteTtfNameRecords(buffer, {
    1: family,
    2: subfamily,
    3: `${fullName}; Creative Asset Extractor`,
    4: fullName,
    6: postScriptName,
    16: family,
    17: subfamily,
    18: fullName,
    21: family,
    22: subfamily,
  });
  if (detectFontFormatFromBuffer(repaired) !== 'ttf') {
    throw new Error('TTF name-table repair produced an invalid font file.');
  }
  return repaired;
};

const isInstallableTtfBuffer = (buffer: Buffer) => {
  if (detectFontFormatFromBuffer(buffer) !== 'ttf') return false;
  const hasValidSfntStructure = (() => {
    if (buffer.length < 12) return false;
    const tableCount = buffer.readUInt16BE(4);
    if (tableCount < 4 || tableCount > 256 || 12 + tableCount * 16 > buffer.length) return false;
    const tables = new Set<string>();
    let previousTag = '';
    for (let index = 0; index < tableCount; index += 1) {
      const entryOffset = 12 + index * 16;
      const tag = buffer.toString('latin1', entryOffset, entryOffset + 4);
      const tableOffset = buffer.readUInt32BE(entryOffset + 8);
      const tableLength = buffer.readUInt32BE(entryOffset + 12);
      if (!tag.trim() || tableOffset > buffer.length || tableLength > buffer.length - tableOffset) return false;
      if (previousTag && Buffer.from(previousTag, 'latin1').compare(Buffer.from(tag, 'latin1')) >= 0) return false;
      previousTag = tag;
      tables.add(tag);
    }
    const hasCoreTables = ['cmap', 'head', 'maxp', 'name'].every((tag) => tables.has(tag));
    const hasGlyphTables = (tables.has('glyf') && tables.has('loca')) || tables.has('CFF ') || tables.has('CFF2');
    return hasCoreTables && hasGlyphTables;
  })();
  if (!hasValidSfntStructure) return false;
  try {
    const parsed = opentype.parse(bufferToExactArrayBuffer(buffer) as any) as any;
    const glyphCount = Number(parsed?.glyphs?.length || parsed?.numGlyphs || 0);
    const hasBasicLatin = ['A', 'a', '0'].every((character) => Number(parsed?.charToGlyphIndex?.(character) || 0) > 0);
    const names = parsed?.names || {};
    const hasReadableName = [
      names.preferredFamily,
      names.typographicFamily,
      names.fontFamily,
      names.fullName,
      names.postScriptName,
    ].some((group) => {
      if (typeof group === 'string') return Boolean(group.trim());
      return group && typeof group === 'object' && Object.values(group).some((value) => typeof value === 'string' && value.trim());
    });
    // Some licensed web fonts expose valid SFNT tables but keep name records in
    // encodings that opentype.js cannot decode. The structural checks above are
    // sufficient for those fonts; retain the parser checks when metadata is readable.
    return glyphCount > 1 && hasBasicLatin && (hasReadableName || hasValidSfntStructure);
  } catch {
    return hasValidSfntStructure;
  }
};

const isValidFontBuffer = (buffer: Buffer, expectedFormat: string) => {
  if (!buffer || buffer.length < 128) return false;
  const detected = detectFontFormatFromBuffer(buffer);
  const target = String(expectedFormat || '').toLowerCase();
  if (!detected) return false;
  if (target === 'svg' || target === 'eot') return false;
  if (detected !== target) return false;
  if (target === 'ttf') return isInstallableTtfBuffer(buffer);
  return true;
};

const TRANSFONTER_ORIGIN = 'https://transfonter.org';
const TRANSFONTER_MAX_FONT_BYTES = 5_000_000;
const transfonterTtfCache = new Map<string, Promise<Buffer>>();
const fontForgeTtfCache = new Map<string, Promise<Buffer>>();
let transfonterActiveConversions = 0;
const transfonterWaiters: Array<() => void> = [];

const withTransfonterSlot = async <T>(task: () => Promise<T>) => {
  if (transfonterActiveConversions >= 3) {
    await new Promise<void>((resolve) => transfonterWaiters.push(resolve));
  }
  transfonterActiveConversions += 1;
  try {
    return await task();
  } finally {
    transfonterActiveConversions = Math.max(0, transfonterActiveConversions - 1);
    transfonterWaiters.shift()?.();
  }
};

const findFilesByExtension = async (root: string, extension: string): Promise<string[]> => {
  const found: string[] = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findFilesByExtension(absolute, extension));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) found.push(absolute);
  }
  return found;
};

const readResponseCookies = (response: Response) => {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || ''];
  return values
    .flatMap((value) => String(value || '').split(/,(?=[^;,]+=)/g))
    .map((value) => value.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
};

const resolveFontForgePath = () => {
  const candidates = [
    String(process.env.FONTFORGE_PATH || '').trim(),
    '/opt/homebrew/bin/fontforge',
    '/usr/local/bin/fontforge',
    '/usr/bin/fontforge',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
};

const convertFontBufferWithFontForge = async (
  buffer: Buffer,
  filenameBase: string,
  sourceFormat: string,
) => {
  const fontForgePath = resolveFontForgePath();
  if (!fontForgePath) throw new Error('FontForge is not installed.');
  const cacheKey = crypto.createHash('sha256').update(buffer).digest('hex');
  const cached = fontForgeTtfCache.get(cacheKey);
  if (cached) return cached;

  const conversion = (async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cae-fontforge-'));
    try {
      const safeBase = sanitizeFilenameBase(filenameBase || 'font').replace(/\s+/g, '-') || 'font';
      const sourceExt = ['woff2', 'woff', 'ttf', 'otf'].includes(sourceFormat) ? sourceFormat : 'woff';
      const inputPath = path.join(tempRoot, `${safeBase}.${sourceExt}`);
      const outputPath = path.join(tempRoot, `${safeBase}.ttf`);
      await fsp.writeFile(inputPath, buffer);
      await execFileAsync(
        fontForgePath,
        ['-lang=ff', '-c', 'Open($1); Generate($2)', inputPath, outputPath],
        { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }
      );
      const converted = await fsp.readFile(outputPath);
      if (!isInstallableTtfBuffer(converted)) {
        throw new Error('FontForge returned a TTF that failed installability validation.');
      }
      return converted;
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  fontForgeTtfCache.set(cacheKey, conversion);
  try {
    return await conversion;
  } catch (error) {
    fontForgeTtfCache.delete(cacheKey);
    throw error;
  }
};

const convertFontBufferWithTransfonter = async (
  buffer: Buffer,
  filenameBase: string,
  sourceFormat: string,
  fixVerticalMetrics = true,
  targetFormat = 'ttf',
) => {
  if (!buffer.length || buffer.length > TRANSFONTER_MAX_FONT_BYTES) {
    throw new Error('Transfonter accepts font files up to 5 MB.');
  }
  const normalizedTarget = normalizeFontFormat(targetFormat);
  if (!['ttf', 'woff'].includes(normalizedTarget)) {
    throw new Error('Transfonter conversion is only enabled for TTF and WOFF outputs.');
  }
  const safeBase = sanitizeFilenameBase(filenameBase || 'font').replace(/\s+/g, ' ').trim() || 'font';
  const cacheKey = [
    crypto.createHash('sha256').update(buffer).digest('hex'),
    `target:${normalizedTarget}`,
    `metrics:${fixVerticalMetrics ? 'on' : 'off'}`,
    `name:${safeBase.toLowerCase()}`,
  ].join(':');
  const cached = transfonterTtfCache.get(cacheKey);
  if (cached) return cached;

  const conversion = withTransfonterSlot(async () => {
    const pageResponse = await fetch(`${TRANSFONTER_ORIGIN}/`, { headers: { 'User-Agent': 'Creative-Asset-Extractor/2.0' } });
    if (!pageResponse.ok) throw new Error(`Transfonter initialization failed (${pageResponse.status}).`);
    const sessionCookie = readResponseCookies(pageResponse);
    const pageHtml = await pageResponse.text();
    const userId = pageHtml.match(/USER_ID\s*=\s*['"]([^'"]+)['"]/)?.[1] || '';
    if (!userId) throw new Error('Transfonter session could not be initialized.');

    const sessionHeaders = {
      'User-Agent': 'Creative-Asset-Extractor/2.0',
      'Referer': `${TRANSFONTER_ORIGIN}/`,
      'Origin': TRANSFONTER_ORIGIN,
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    };

    const sourceExt = ['woff2', 'woff', 'ttf', 'otf'].includes(sourceFormat) ? sourceFormat : 'woff2';
    const upload = new FormData();
    upload.set('user_id', userId);
    const uploadBytes = new Uint8Array(buffer.length);
    uploadBytes.set(buffer);
    upload.set('files[]', new Blob([uploadBytes]), `${safeBase}.${sourceExt}`);
    const uploadResponse = await fetch(`${TRANSFONTER_ORIGIN}/fonts/upload`, {
      method: 'POST',
      headers: sessionHeaders,
      body: upload,
    });
    const uploadPayload: any = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !Array.isArray(uploadPayload?.files) || uploadPayload.files.length === 0) {
      throw new Error(uploadPayload?.error || `Transfonter upload failed (${uploadResponse.status}).`);
    }

    const settings = new URLSearchParams();
    settings.set('user_id', userId);
    settings.set('family', '1');
    if (fixVerticalMetrics) settings.set('fixVerticalMetrics', '1');
    settings.append('formats[]', normalizedTarget);
    settings.set('hinting', '');
    settings.set('language', '');
    settings.set('fontDisplay', 'swap');
    const processResponse = await fetch(`${TRANSFONTER_ORIGIN}/fonts/process`, {
      method: 'POST',
      headers: {
        ...sessionHeaders,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: settings,
    });
    const processPayload: any = await processResponse.json().catch(() => ({}));
    if (!processResponse.ok || processPayload?.error || processPayload?.status === 'error') {
      throw new Error(processPayload?.error || processPayload?.message || `Transfonter conversion request failed (${processResponse.status}).`);
    }

    let resultUrl = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const statusResponse = await fetch(`${TRANSFONTER_ORIGIN}/fonts/status?user_id=${encodeURIComponent(userId)}`, {
        headers: sessionHeaders,
      });
      const status: any = await statusResponse.json().catch(() => ({}));
      if (status?.status === 'success' && status?.result) {
        resultUrl = new URL(String(status.result), TRANSFONTER_ORIGIN).href;
        break;
      }
      if (status?.status === 'error' || status?.error) {
        throw new Error(status?.error || 'Transfonter conversion failed.');
      }
    }
    if (!resultUrl) throw new Error('Transfonter conversion timed out.');

    const archiveResponse = await fetch(resultUrl, { headers: sessionHeaders });
    if (!archiveResponse.ok) throw new Error(`Transfonter result download failed (${archiveResponse.status}).`);
    const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cae-transfonter-'));
    try {
      const zipPath = path.join(tempRoot, 'result.zip');
      const outputDir = path.join(tempRoot, 'output');
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.writeFile(zipPath, archiveBuffer);
      await extractZip(zipPath, { dir: outputDir });
      const convertedFiles = await findFilesByExtension(outputDir, `.${normalizedTarget}`);
      if (convertedFiles.length === 0) throw new Error(`Transfonter result did not contain a ${normalizedTarget.toUpperCase()} file.`);
      // Preserve the file produced by Transfonter. Re-serializing TTF with a JS
      // font editor can corrupt Macintosh name records and makes Font Book
      // report "No Installable Fonts Selected".
      const converted = await fsp.readFile(convertedFiles[0]);
      if (normalizedTarget === 'ttf' && !isInstallableTtfBuffer(converted)) {
        throw new Error('Transfonter returned a TTF that failed installability validation.');
      }
      if (normalizedTarget === 'woff' && !isValidFontBuffer(converted, 'woff')) {
        throw new Error('Transfonter returned a WOFF that failed validation.');
      }
      return converted;
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  transfonterTtfCache.set(cacheKey, conversion);
  try {
    return await conversion;
  } catch (error) {
    transfonterTtfCache.delete(cacheKey);
    throw error;
  }
};

const convertFontBufferToInstallableTtf = async (
  buffer: Buffer,
  filenameBase: string,
  sourceFormat: string,
  fixVerticalMetrics = true,
) => {
  try {
    // Use the same conversion service requested by the user for client,
    // Google and Typekit fonts. Its output carries complete Mac/Windows name
    // records; local FontForge remains an offline fallback only.
    return await convertFontBufferWithTransfonter(buffer, filenameBase, sourceFormat, fixVerticalMetrics);
  } catch {
    return convertFontBufferWithFontForge(buffer, filenameBase, sourceFormat);
  }
};

const getInnerFontBuffer = async (buffer: Buffer, readFormat: string) => {
  if (readFormat === 'woff2') {
    await ensureWoff2Ready();
    const inner = fontOutputToBuffer(woff2.decode(bufferToExactArrayBuffer(buffer)));
    const innerFormat = inner.slice(0, 4).toString('latin1') === 'OTTO' ? 'otf' : 'ttf';
    return { buffer: inner, format: innerFormat };
  }
  if (readFormat === 'woff') {
    try {
      const font = Font.create(buffer, { type: 'woff' });
      const inner = fontOutputToBuffer(font.write({ type: 'ttf' }));
      const innerFormat = inner.slice(0, 4).toString('latin1') === 'OTTO' ? 'otf' : 'ttf';
      return { buffer: inner, format: innerFormat };
    } catch {
      // Some real-world WOFFs fail to parse in fonteditor-core; fall back to opentype.js.
      const parsed = opentype.parse(bufferToExactArrayBuffer(buffer) as any);
      const out = Buffer.from(parsed.toArrayBuffer());
      const outMagic = out.slice(0, 4).toString('latin1');
      const outFormat = outMagic === 'OTTO' ? 'otf' : 'ttf';
      return { buffer: out, format: outFormat };
    }
  }
  if (readFormat === 'ttf' || readFormat === 'otf') {
    return { buffer, format: readFormat };
  }
  return { buffer, format: readFormat };
};

const pickOpenTypeName = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  const names = value as Record<string, unknown>;
  const preferredKeys = ['en', 'en-US', 'en-us', 'en_GB', 'en-gb'];
  for (const key of preferredKeys) {
    const candidate = names[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const first = Object.values(names).find((item) => typeof item === 'string' && item.trim());
  return typeof first === 'string' ? first.trim() : '';
};

const splitPostScriptFontName = (value: string) =>
  String(value || '')
    .replace(/[-_](?:Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black|Italic|Oblique)+$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();

const readFontNameMetadataFromBuffer = async (buffer: Buffer, formatHint = '') => {
  const detected = detectFontFormatFromBuffer(buffer);
  const readFormat = detected || normalizeFontFormat(formatHint);
  if (!['woff2', 'woff', 'ttf', 'otf'].includes(readFormat)) return null;
  const { buffer: innerBuffer } = await getInnerFontBuffer(buffer, readFormat);
  const parsed = opentype.parse(bufferToExactArrayBuffer(innerBuffer) as any);
  const names = (parsed as any)?.names || {};
  const family =
    pickOpenTypeName(names.preferredFamily) ||
    pickOpenTypeName(names.typographicFamily) ||
    pickOpenTypeName(names.fontFamily);
  const subfamily =
    pickOpenTypeName(names.preferredSubfamily) ||
    pickOpenTypeName(names.typographicSubfamily) ||
    pickOpenTypeName(names.fontSubfamily);
  const fullName = pickOpenTypeName(names.fullName);
  const postScriptName = pickOpenTypeName(names.postScriptName);
  const postScriptFamily = splitPostScriptFontName(postScriptName);
  return {
    family,
    name: fullName || postScriptName,
    title: fullName || family || postScriptName,
    filename: postScriptName || fullName,
    style: subfamily && !/^(regular|normal)$/i.test(subfamily) ? subfamily : '',
    postScriptName,
    postScriptFamily,
  };
};

const shouldResolveFontMetadata = (font: any) => {
  const label = String(font?.family || font?.title || font?.name || font?.filename || '').trim();
  if (!label) return true;
  if (isJunkFontLabel(label)) return true;
  if (/\bweb font\s+\d+$/i.test(label)) return true;
  const urlBase = filenameFromUrlPath(String(font?.url || font?.cachedUrl || '')).replace(/\.[^/.]+$/, '');
  if (urlBase && label.replace(/[^a-z0-9]+/gi, '').toLowerCase() === urlBase.replace(/[^a-z0-9]+/gi, '').toLowerCase()) {
    return true;
  }
  return false;
};

const FONT_METADATA_CACHE = new Map<string, any | null>();

const resolveFontMetadata = async (font: any, targetUrl: string) => {
  const url = String(font?.url || '').trim();
  if (!url || url.startsWith('data:')) return null;
  if (FONT_METADATA_CACHE.has(url)) return FONT_METADATA_CACHE.get(url) || null;
  try {
    assertPublicAssetUrl(url);
    const referer = resolveFontRefererPage(String(font?.cssSource || ''), targetUrl);
    const response = await withTimeout(
      axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 6500,
        maxContentLength: 4 * 1024 * 1024,
        httpsAgent: relaxedHttpsAgent,
        validateStatus: (status) => status >= 200 && status < 300,
        headers: {
          'User-Agent': PAGE_FETCH_USER_AGENTS[0],
          Accept: 'font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.1',
          ...(referer ? { Referer: referer } : {}),
        },
      }),
      8000,
      `Font metadata read for ${url}`
    );
    const buffer = Buffer.from(response.data);
    const format = detectFontFormatFromBuffer(buffer) || getFontFormatFromUrlOrType(url, String(response.headers?.['content-type'] || font?.format || ''));
    const metadata = await readFontNameMetadataFromBuffer(buffer, format);
    const family = String(metadata?.family || metadata?.postScriptFamily || '').trim();
    const cleanMetadata =
      family && !isJunkFontLabel(family)
        ? {
            ...metadata,
            family,
          }
        : null;
    FONT_METADATA_CACHE.set(url, cleanMetadata);
    return cleanMetadata;
  } catch {
    FONT_METADATA_CACHE.set(url, null);
    return null;
  }
};

const enrichFontsWithMetadata = async (fonts: any[], targetUrl: string, options: { fast?: boolean } = {}) => {
  const candidates = fonts.filter((font) => font?.url && shouldResolveFontMetadata(font));
  if (candidates.length === 0) return fonts;
  const limit = options.fast ? 12 : 28;
  const uniqueCandidates = Array.from(new Map(candidates.map((font) => [String(font.url), font])).values()).slice(0, limit);
  const metadataByUrl = new Map<string, any>();
  await mapWithConcurrency(uniqueCandidates, 4, async (font) => {
    const metadata = await resolveFontMetadata(font, targetUrl);
    if (metadata) metadataByUrl.set(String(font.url), metadata);
  });
  if (metadataByUrl.size === 0) return fonts;
  return fonts.map((font) => {
    const metadata = metadataByUrl.get(String(font?.url || ''));
    if (!metadata) return font;
    return {
      ...font,
      title: metadata.title || font.title,
      name: metadata.name || font.name,
      filename: metadata.filename || font.filename,
      family: metadata.family || font.family,
      style: font.style || metadata.style || undefined,
      fontMetadata: {
        postScriptName: metadata.postScriptName || '',
      },
    };
  });
};

const writeFontBuffer = async (innerBuffer: Buffer, innerFormat: string, toFormat: string) => {
  if (toFormat === innerFormat) return innerBuffer;
  if (toFormat === 'woff2' && (innerFormat === 'ttf' || innerFormat === 'otf')) {
    await ensureWoff2Ready();
    return fontOutputToBuffer(woff2.encode(bufferToExactArrayBuffer(innerBuffer)));
  }
  if (toFormat === 'woff' && (innerFormat === 'ttf' || innerFormat === 'otf')) {
    const font = Font.create(innerBuffer, { type: innerFormat as any });
    return fontOutputToBuffer(font.write({ type: 'woff' as any }));
  }
  const font = Font.create(innerBuffer, { type: innerFormat as any });
  return fontOutputToBuffer(font.write({ type: toFormat as any }));
};

const fontConvertWorkerPath = () => path.join(getAppRoot(), 'server', 'font-convert-worker.mjs');

const extractWorkerPath = () => path.join(getAppRoot(), 'server', 'extract-workers.mjs');

const quickExtractInWorker = async (targetUrl: string) => {
  const worker = new Worker(extractWorkerPath(), {
    workerData: { task: 'quickExtract', payload: { targetUrl } },
  });
  return new Promise<any>((resolve, reject) => {
    worker.once('message', (message: { ok?: boolean; result?: any; error?: string }) => {
      worker.terminate().catch(() => undefined);
      if (!message?.ok) {
        reject(new Error(message?.error || 'Worker quick extract failed'));
        return;
      }
      resolve(message.result);
    });
    worker.once('error', (error) => {
      worker.terminate().catch(() => undefined);
      reject(error);
    });
    setTimeout(() => {
      worker.terminate().catch(() => undefined);
      reject(new Error('Worker quick extract timed out'));
    }, 15000);
  });
};

const convertFontBufferOffThread = async (buffer: Buffer, fromFormat: string, toFormat: string) =>
  new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(fontConvertWorkerPath(), {
      workerData: {
        bufferBase64: buffer.toString('base64'),
        fromFormat,
        toFormat,
      },
    });
    worker.once('message', (message: { ok?: boolean; bufferBase64?: string; error?: string }) => {
      worker.terminate().catch(() => undefined);
      if (!message?.ok || !message.bufferBase64) {
        reject(new Error(message?.error || 'Font conversion failed in worker thread.'));
        return;
      }
      resolve(Buffer.from(message.bufferBase64, 'base64'));
    });
    worker.once('error', (error) => {
      worker.terminate().catch(() => undefined);
      reject(error);
    });
  });

const convertFontBuffer = async (
  url: string,
  buffer: Buffer,
  fromFormat: string,
  toFormat: string,
  contentType = '',
  preferInlineConversion = false
) => {
  const detected = detectFontFormatFromBuffer(buffer);
  let readFormat = detected || normalizeFontFormat(fromFormat, contentType);
  if (!['ttf', 'woff', 'woff2', 'eot', 'otf', 'svg'].includes(readFormat)) {
    throw new Error(`Unsupported or undetectable original font format: ${readFormat || 'unknown'}`);
  }

  if (readFormat === toFormat) {
    return buffer;
  }

  const convertInline = async () => {
    const { buffer: innerBuffer, format: innerFormat } = await getInnerFontBuffer(buffer, readFormat);
    if (toFormat === 'ttf' && innerFormat === 'otf') {
      throw new Error('CFF/OpenType outlines cannot be safely converted to an installable macOS TTF.');
    }
    return writeFontBuffer(innerBuffer, innerFormat, toFormat);
  };

  if (preferInlineConversion) {
    try {
      return await convertInline();
    } catch (inlineError) {
      return convertFontBufferOffThread(buffer, readFormat, toFormat);
    }
  }

  try {
    return await convertFontBufferOffThread(buffer, readFormat, toFormat);
  } catch (workerError: any) {
    return convertInline();
  }
};

type ConvertFontExtras = {
  originalUrl?: string;
  metadataFilename?: string;
  contentDisposition?: string;
  cacheOnly?: boolean;
  refererPageUrl?: string;
  cssSource?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  prefetched?: { buffer: Buffer; contentType: string; contentDisposition?: string };
  preferInlineConversion?: boolean;
  timeoutMs?: number;
  fixVerticalMetrics?: boolean;
};

const GOOGLE_INSTALLABLE_FONT_CACHE = new Map<string, any | null>();

const normalizeFontFamilyCompare = (value: string) =>
  String(value || '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const resolveGoogleInstallableFontSource = async (extras: ConvertFontExtras = {}) => {
  const cssSource = String(extras.cssSource || '').trim();
  if (!/fonts\.googleapis\.com/i.test(cssSource)) return null;
  const familyWanted = normalizeFontFamilyCompare(extras.fontFamily || extras.metadataFilename || '');
  const weightWanted = String(extras.fontWeight || '').trim() || '400';
  const styleWanted = String(extras.fontStyle || '').trim().toLowerCase() || 'normal';
  const cacheKey = `${cssSource}|${familyWanted}|${weightWanted}|${styleWanted}`;
  if (GOOGLE_INSTALLABLE_FONT_CACHE.has(cacheKey)) return GOOGLE_INSTALLABLE_FONT_CACHE.get(cacheKey);
  try {
    assertPublicAssetUrl(cssSource);
    const response = await axios.get(cssSource, {
      timeout: 10000,
      httpsAgent: relaxedHttpsAgent,
      ...axiosProxyOptions(),
      validateStatus: (status) => status === 200,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/css,*/*;q=0.1',
      },
    });
    const css = String(response.data || '');
    const directFonts: any[] = [];
    for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const block = match[1] || '';
      const family = normalizeFontFamilyCompare(block.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/i)?.[1] || '');
      const weight = String(block.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || '400').trim();
      const style = String(block.match(/font-style\s*:\s*([^;]+)/i)?.[1] || 'normal').trim().toLowerCase();
      const unicodeRange = String(block.match(/unicode-range\s*:\s*([^;]+)/i)?.[1] || '').trim();
      const src = block.match(/url\(\s*['"]?([^'")]+?\.(?:ttf|woff2?|otf)(?:[?#][^'")]+)?)['"]?\s*\)/i)?.[1] || '';
      const format = getFontFormatFromUrlOrType(src, block);
      if (!src || !/^https?:\/\//i.test(src)) continue;
      directFonts.push({ family, weight, style, unicodeRange, url: src, format, cssSource });
    }
    const scored = directFonts
      .filter((font) => {
        if (familyWanted && font.family && font.family !== familyWanted) return false;
        if (weightWanted && font.weight && font.weight !== weightWanted) return false;
        if (styleWanted && font.style && font.style !== styleWanted) return false;
        return true;
      })
      .sort((a, b) => {
        const aUrl = String(a?.url || '');
        const bUrl = String(b?.url || '');
        const aScore = (/\.ttf(?:[?#]|$)/i.test(aUrl) ? 100 : 0) + scoreFontRecord(a);
        const bScore = (/\.ttf(?:[?#]|$)/i.test(bUrl) ? 100 : 0) + scoreFontRecord(b);
        return bScore - aScore;
      });
    const best = scored[0] || null;
    GOOGLE_INSTALLABLE_FONT_CACHE.set(cacheKey, best);
    return best;
  } catch {
    GOOGLE_INSTALLABLE_FONT_CACHE.set(cacheKey, null);
    return null;
  }
};

const convertFontAsset = async (
  url: string,
  toFormat: string,
  originalFormat = 'unknown',
  preferredBase?: string,
  extras: ConvertFontExtras = {}
) => {
  const normalizedTarget = normalizeFontFormat(toFormat);
  const normalizedOriginal = normalizeFontFormat(originalFormat);
  const maxAttempts = normalizedTarget && normalizedTarget === normalizedOriginal ? 1 : 2;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTimeout(
        getCachedConvertedFont(url, toFormat, originalFormat, preferredBase, extras),
        extras.timeoutMs || 10000 + attempt * 5000,
        `Font conversion (${toFormat})`
      );
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error?.message || error || 'Font conversion failed'));
      const retryable = /timeout|fetch|network|econnreset|socket|temporarily/i.test(String(lastError.message));
      if (attempt < maxAttempts && retryable) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 350));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('Font conversion failed.');
};

const fetchOriginalFontBufferForFallback = async (
  url: string,
  originalFormat: string,
  preferredBase: string | undefined,
  extras: ConvertFontExtras
) => {
  const sourceFormat = normalizeFontFormat(originalFormat);
  return convertFontAsset(url, sourceFormat, originalFormat, preferredBase, { ...extras, cacheOnly: false });
};

const getCachedConvertedFont = async (
  url: string,
  toFormat = 'ttf',
  originalFormat = 'unknown',
  preferredBase?: string,
  extras: ConvertFontExtras = {}
) => {
  await fsp.mkdir(cachedFontDir, { recursive: true });
  const normalizedTarget = ['ttf', 'woff', 'woff2', 'eot', 'otf', 'svg'].includes(toFormat) ? toFormat : 'ttf';
  const cacheSourceUrl =
    normalizeAssetRequestUrl(String(extras.originalUrl || '').trim()) ||
    normalizeAssetRequestUrl(url) ||
    url;
  // Version the TTF cache whenever conversion/installability handling changes,
  // so previously broken generated files are never served again.
  const cacheIdentity = normalizedTarget === 'ttf'
    ? `${cacheSourceUrl}#installable-ttf-v10-macos-family-linking-metrics-${extras.fixVerticalMetrics === false ? 'off' : 'on'}`
    : cacheSourceUrl;
  const cachePath = path.join(cachedFontDir, `${assetCacheKey(cacheIdentity, normalizedTarget)}.${normalizedTarget}`);
  const filenameSourceUrl = extras.originalUrl || url;
  const filenameExtras = {
    contentDisposition: extras.contentDisposition,
    metadataFilename: extras.metadataFilename,
  };
  let cached = await readCachedFileIfExists(cachePath);
  if (cached && /fonts\.googleapis\.com/i.test(String(extras.cssSource || '')) && ['ttf', 'woff'].includes(normalizedTarget)) {
    await fsp.unlink(cachePath).catch(() => undefined);
    cached = null;
  }
  if (cached && !isValidFontBuffer(cached, normalizedTarget)) {
    await fsp.unlink(cachePath).catch(() => undefined);
    cached = null;
  }
  if (cached) {
    return {
      buffer: cached,
      format: normalizedTarget,
      filename: buildDownloadFilename(filenameSourceUrl, normalizedTarget, preferredBase, filenameExtras),
    };
  }

  let fetched: { buffer: Buffer; contentType: string; contentDisposition?: string };
  const cacheOnly = Boolean(extras.cacheOnly);
  const remoteOriginal = String(extras.originalUrl || '').trim();
  const refererPage =
    String(extras.refererPageUrl || '').trim() ||
    (remoteOriginal.startsWith('http') && !isLikelyFontAssetUrl(remoteOriginal) ? remoteOriginal : '');
  if (extras.prefetched?.buffer?.length) {
    fetched = extras.prefetched;
  } else {
    try {
      const googleInstallable = await resolveGoogleInstallableFontSource(extras);
      const effectiveUrl =
        googleInstallable?.url && ['ttf', 'otf', 'woff', 'woff2'].includes(String(googleInstallable.format || '').toLowerCase())
          ? String(googleInstallable.url)
          : url;
      const effectiveOriginal =
        googleInstallable?.url && googleInstallable.url !== url
          ? String(googleInstallable.url)
          : extras.originalUrl || '';
      const effectiveFormat =
        googleInstallable?.format ? String(googleInstallable.format) : originalFormat;
      fetched = await fetchAssetBuffer(url, extras.originalUrl || '', { cacheOnly, refererPageUrl: refererPage });
      if (effectiveUrl !== url && !cacheOnly) {
        fetched = await fetchAssetBuffer(effectiveUrl, effectiveOriginal, {
          cacheOnly: false,
          refererPageUrl: extras.cssSource || refererPage,
        });
        originalFormat = effectiveFormat;
        url = effectiveUrl;
      }
    } catch (primaryFetchError: any) {
      const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
      if (siblingUrl !== url) {
        fetched = await fetchAssetBuffer(siblingUrl, extras.originalUrl || '', { cacheOnly, refererPageUrl: refererPage });
      } else {
        throw primaryFetchError;
      }
    }
  }

  const expectedSourceFormat = getFontFormatFromUrlOrType(url, fetched.contentType);
  const fetchedDetected = detectFontFormatFromBuffer(fetched.buffer);
  if (!isValidFontOriginalBuffer(fetched.buffer, fetched.contentType)) {
    if (remoteOriginal.startsWith('http') && remoteOriginal !== url && !cacheOnly) {
      try {
        fetched = await fetchRemoteFontBuffer(remoteOriginal, refererPage);
      } catch {
        throw new Error(`Downloaded asset is not a valid font: ${url}`);
      }
    } else {
      throw new Error(`Downloaded asset is not a valid font: ${url}`);
    }
  } else if (
    fetchedDetected &&
    expectedSourceFormat !== 'unknown' &&
    fetchedDetected !== expectedSourceFormat &&
    remoteOriginal.startsWith('http') &&
    remoteOriginal !== url
  ) {
    try {
      fetched = await fetchAssetBuffer(remoteOriginal, remoteOriginal, { cacheOnly: false, refererPageUrl: refererPage });
    } catch {
      // Keep the cached bytes and let conversion report a precise error.
    }
  }

  let outputBuffer = fetched.buffer;
  let conversionProvider = 'local';
  const detected = detectFontFormatFromBuffer(fetched.buffer);
  let fromFormat = detected || normalizeFontFormat(originalFormat || getFontFormatFromUrlOrType(url, fetched.contentType), fetched.contentType);
  if (normalizedTarget === 'ttf' && fromFormat !== 'ttf' && !cacheOnly) {
    outputBuffer = await convertFontBufferToInstallableTtf(
      fetched.buffer,
      preferredBase || extras.fontFamily || 'font',
      fromFormat,
      extras.fixVerticalMetrics !== false,
    );
    conversionProvider = 'transfonter';
  } else if (normalizedTarget === 'woff' && fromFormat !== 'woff' && !cacheOnly) {
    outputBuffer = await convertFontBufferWithTransfonter(
      fetched.buffer,
      preferredBase || extras.fontFamily || 'font',
      fromFormat,
      extras.fixVerticalMetrics !== false,
      'woff',
    );
    conversionProvider = 'transfonter';
  } else try {
    outputBuffer = await convertFontBuffer(
      url,
      fetched.buffer,
      fromFormat,
      normalizedTarget,
      fetched.contentType,
      Boolean(extras.preferInlineConversion)
    );
  } catch (convertError: any) {
    if (normalizedTarget === 'ttf' && !cacheOnly) {
      outputBuffer = await convertFontBufferToInstallableTtf(
        fetched.buffer,
        preferredBase || extras.fontFamily || 'font',
        fromFormat,
        extras.fixVerticalMetrics !== false,
      );
      conversionProvider = 'transfonter';
    } else if (normalizedTarget === 'woff' && !cacheOnly) {
      outputBuffer = await convertFontBufferWithTransfonter(
        fetched.buffer,
        preferredBase || extras.fontFamily || 'font',
        fromFormat,
        extras.fixVerticalMetrics !== false,
        'woff',
      );
      conversionProvider = 'transfonter';
    } else {
    if (cacheOnly) throw convertError;
    const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
    if (siblingUrl !== url) {
      const sibling = await fetchAssetBuffer(siblingUrl, extras.originalUrl || '', { cacheOnly, refererPageUrl: refererPage });
      const siblingDetected = detectFontFormatFromBuffer(sibling.buffer);
      const siblingFrom =
        siblingDetected ||
        normalizeFontFormat(getFontFormatFromUrlOrType(siblingUrl, sibling.contentType), sibling.contentType);
      outputBuffer = await convertFontBuffer(
        siblingUrl,
        sibling.buffer,
        siblingFrom,
        normalizedTarget,
        sibling.contentType,
        Boolean(extras.preferInlineConversion)
      );
    } else {
      throw convertError;
    }
    }
  }

  if (
    normalizedTarget === 'ttf' &&
    !isInstallableTtfBuffer(outputBuffer) &&
    !cacheOnly &&
    fromFormat !== 'ttf'
  ) {
    outputBuffer = await convertFontBufferToInstallableTtf(
      fetched.buffer,
      preferredBase || extras.fontFamily || 'font',
      fromFormat,
      extras.fixVerticalMetrics !== false,
    );
    conversionProvider = 'transfonter';
  }

  if (normalizedTarget === 'ttf') {
    // Web fonts sometimes misuse the subfamily name record for messages such
    // as "Not Licensed for Desktop Use". Font Book displays that record as the
    // style name. Rebuild only the identity records from the extracted CSS
    // family/weight/style; copyright, trademark, license and embedding tables
    // remain untouched.
    outputBuffer = repairTtfNameTable(outputBuffer, buildTtfIdentityBase(preferredBase, extras));
  }

  if (!isValidFontBuffer(outputBuffer, normalizedTarget)) {
    throw new Error(`Converted font is not valid ${normalizedTarget.toUpperCase()} binary`);
  }

  if (!cacheOnly) {
    await fsp.writeFile(cachePath, outputBuffer);
  }
  return {
    buffer: outputBuffer,
    format: normalizedTarget,
    conversionProvider,
    filename: buildDownloadFilename(filenameSourceUrl, normalizedTarget, preferredBase, {
      ...filenameExtras,
      contentDisposition: fetched.contentDisposition || filenameExtras.contentDisposition,
    }),
  };
};

const cleanRawAssetUrl = (value: string) =>
  decodeCssUrlValue(String(value || ''))
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[)\]};,]+$/g, '')
    .trim();

const readExistingOriginalAssetUrl = async (url: string, kind: 'image' | 'font') => {
  const existing = await resolveOriginalCachedAsset(url, kind);
  return existing?.cachedUrl || '';
};

type WarmedOriginalAsset = {
  ok: boolean;
  cachedUrl: string;
  bytes?: number;
  width?: number;
  height?: number;
};

const warmCachedOriginalAssetForExtraction = async (
  url: string,
  kind: 'image' | 'font',
  hintType = 'bin',
  options: { preferredBase?: string; metadataFilename?: string; refererPageUrl?: string; skipBrowser?: boolean } = {}
): Promise<WarmedOriginalAsset> => {
  const existing = await resolveOriginalCachedAsset(url, kind);
  if (existing) {
    try {
      const current = await fsp.readFile(existing.filePath);
      const currentType = guessContentTypeFromPath(existing.filePath);
      const valid =
        kind === 'image'
          ? isValidImageBuffer(current, currentType)
          : isValidFontOriginalBuffer(current, currentType);
      if (valid) {
        const meta = kind === 'image' ? enrichImageAssetMeta({}, current, currentType) : {};
        return {
          ok: true,
          cachedUrl: existing.cachedUrl,
          bytes: meta.bytes,
          width: meta.width,
          height: meta.height,
        };
      }
      await fsp.unlink(existing.filePath).catch(() => undefined);
    } catch {
      // re-fetch below
    }
  }

  const refererPage = resolveFontRefererPage('', String(options.refererPageUrl || ''));
  let buffer: Buffer;
  let contentType = '';
  let contentDisposition = '';

  if (kind === 'font') {
    try {
      const fetched = await fetchRemoteFontBuffer(url, refererPage);
      buffer = fetched.buffer;
      contentType = fetched.contentType;
      contentDisposition = String((fetched as any).contentDisposition || '');
    } catch {
      return { ok: false, cachedUrl: '' };
    }
  } else {
    try {
      const fetched = await withTimeout(
        fetchRemoteImageBuffer(url, refererPage, { skipBrowser: options.skipBrowser }),
        20000,
        `${kind} warm for ${url}`
      );
      if (!fetched) return { ok: false, cachedUrl: '' };
      buffer = fetched.buffer;
      contentType = fetched.contentType;
      contentDisposition = String((fetched as any).contentDisposition || '');
    } catch {
      return { ok: false, cachedUrl: '' };
    }
  }

  const maxBytes = kind === 'image' ? 15 * 1024 * 1024 : 10 * 1024 * 1024;
  if (buffer.length <= 0 || buffer.length > maxBytes) return { ok: false, cachedUrl: '' };
  if (kind === 'image' && !isValidImageBuffer(buffer, contentType)) return { ok: false, cachedUrl: '' };
  if (kind === 'font' && !isValidFontOriginalBuffer(buffer, contentType)) return { ok: false, cachedUrl: '' };

  const cachedUrl = await writeOriginalCachedAsset(url, kind, buffer, {
    contentType,
    contentDisposition,
    hintType,
    preferredBase: options.preferredBase,
    metadataFilename: options.metadataFilename,
  });
  if (kind === 'image' && cachedUrl && /\.(?:webp|avif)(?:[?#]|$)/i.test(url)) {
    void warmRasterConversionVariants(url, cachedUrl).catch(() => undefined);
  }
  if (kind === 'font' && cachedUrl) {
    void warmFontConversionVariants(url, cachedUrl, hintType, {
      refererPageUrl: String(options.refererPageUrl || ''),
    }).catch(() => undefined);
  }
  const meta = kind === 'image' ? enrichImageAssetMeta({}, buffer, contentType) : {};
  return {
    ok: Boolean(cachedUrl),
    cachedUrl,
    bytes: meta.bytes,
    width: meta.width,
    height: meta.height,
  };
};

const extractAssetsFromRawText = (text: string, baseUrl: string) => {
  const images: any[] = [];
  const videos: any[] = [];
  const fonts: any[] = [];
  const raw = String(text || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  const assetRegex = /(?:https?:\/\/|\/\/|\/|\.{1,2}\/)[^"'`<>\s\\)]+?\.(?:jpe?g|png|webp|gif|avif|svg|mp4|webm|m3u8|mov|woff2?|ttf|otf|eot)(?=$|[?#"'`<>\s\\)])(?:[?#][^"'`<>\s\\)]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = assetRegex.exec(raw)) !== null) {
    const cleaned = cleanRawAssetUrl(match[0]);
    const resolved = resolveUrl(baseUrl, cleaned);
    if (!resolved || resolved.startsWith('data:') || resolved.startsWith('blob:')) continue;
    if (isWistiaHelperResourceUrl(resolved)) {
      if (isWistiaSwatchUrl(resolved)) {
        addImageCandidate(images, resolved, baseUrl, { status: DEFAULT_ASSET_STATUS, type: 'webp' }, { permissive: true });
      }
      continue;
    }

    if (/\.(?:jpe?g|png|webp|gif|avif|svg)(?:[?#]|$)/i.test(resolved)) {
      addImageCandidate(images, resolved, baseUrl, { status: DEFAULT_ASSET_STATUS }, { permissive: true });
    } else if (/\.(?:mp4|webm|m3u8|mov)(?:[?#]|$)/i.test(resolved)) {
      videos.push({
        url: resolved,
        sourceUrl: baseUrl,
        provider: platformProviderFromUrl(resolved),
        type: getVideoFormatFromUrlOrType(resolved),
        title: pageTitleFromUrl(resolved),
        isDirect: isLikelyDirectVideoStreamUrl(resolved) || isLikelyVideoAssetUrl(resolved),
        status: DEFAULT_ASSET_STATUS,
      });
    } else if (/\.(?:woff2|ttf|otf)(?:[?#]|$)/i.test(resolved)) {
      const format = getFontFormatFromUrlOrType(resolved);
      if (!isSupportedFontFormat(format)) continue;
      const filenameBase = filenameFromUrlPath(resolved).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
      const readableFilename = filenameBase && !/^[0-9a-f]{8,}(?: s p)?$/i.test(filenameBase) && !isJunkFontLabel(filenameBase);
      let hostLabel = 'Website';
      try {
        const hostname = new URL(resolved).hostname.replace(/^www\./i, '').split('.');
        hostLabel = hostname.length > 1 ? hostname[hostname.length - 2] : hostname[0] || hostLabel;
        hostLabel = hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1);
      } catch {
        // Keep the generic website label.
      }
      fonts.push({
        family: readableFilename ? filenameBase : `${hostLabel} Web Font ${fonts.length + 1}`,
        url: resolved,
        format,
        cssSource: baseUrl,
        status: DEFAULT_ASSET_STATUS,
      });
    }
  }

  const wistiaSwatchRegex = /https?:\/\/fast\.wistia\.(?:com|net)\/embed\/medias\/[a-z0-9]{8,12}\/swatch(?:[?#][^"'`<>\s\\)]*)?/gi;
  while ((match = wistiaSwatchRegex.exec(raw)) !== null) {
    const resolved = resolveUrl(baseUrl, cleanRawAssetUrl(match[0]));
    if (resolved && isWistiaSwatchUrl(resolved)) {
      addImageCandidate(images, resolved, baseUrl, { status: DEFAULT_ASSET_STATUS, type: 'webp' }, { permissive: true });
    }
  }

  return { images, videos, fonts };
};

const normalizeExactBlockText = (value: string) =>
  String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const extractPharmaBlocksFromText = (items: string[]) => {
  const indication: string[] = [];
  const isi: string[] = [];
  items.forEach((raw) => {
    const text = normalizeExactBlockText(raw);
    if (text.length < 40 || isBotWallText(text)) return;
    const lower = text.toLowerCase();
    const firstLine = (text.split('\n').find((line) => line.trim()) || '').toLowerCase();
    const looksIsi =
      lower.includes('important safety information') ||
      /^important safety\b/i.test(firstLine) ||
      /^warnings and precautions\b/i.test(firstLine) ||
      lower.includes('see full prescribing information') ||
      lower.includes('full prescribing information') ||
      lower.includes('boxed warning') ||
      (/\bisi\b/i.test(firstLine) && /(warning|adverse|contraindic)/i.test(lower));
    const looksIndication =
      !looksIsi &&
      (
        /^indication(s)?(\s+and\s+usage)?\b/i.test(firstLine) ||
        /\bindicated for\b/i.test(lower) ||
        /\bis indicated\b/i.test(lower) ||
        /\bapproved for\b/i.test(lower) ||
        /\bfor the treatment of\b/i.test(lower) ||
        /\bindication\(s\)?\s*:/i.test(lower) ||
        (/\bindication(s)?\b/i.test(firstLine) && /\bindicated\b/i.test(lower))
      );
    if (looksIndication) indication.push(text);
    if (looksIsi) isi.push(text);
  });
  return { indication, isi };
};

const extractIndicationBlocksFromHtml = (html: string) => {
  const blocks: string[] = [];
  const $ = cheerio.load(html || '');
  $('[id*="indication" i], [class*="indication" i], [data-module*="indication" i], [data-section*="indication" i]').each((_, el) => {
    const text = normalizeExactBlockText($(el).text());
    if (text.length > 40 && !isBotWallText(text)) blocks.push(text);
  });
  $('h1,h2,h3,h4,strong,b,span').each((_, el) => {
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!/^indication(s)?(\s+and\s+usage)?$/i.test(title)) return;
    const parentText = normalizeExactBlockText($(el).parent().text());
    if (parentText.length > 40 && !isBotWallText(parentText)) blocks.push(parentText);
  });
  return blocks;
};

const extractIsiBlocksFromHtml = (html: string) => {
  const blocks: string[] = [];
  const $ = cheerio.load(html || '');
  $('[id*="isi" i], [class*="isi" i], [data-module*="isi" i], [data-section*="isi" i], [class*="important-information" i], [class*="safety-information" i]').each((_, el) => {
    const text = normalizeExactBlockText($(el).text());
    if (text.length > 40 && !isBotWallText(text)) blocks.push(text);
  });
  $('h1,h2,h3,h4,h5,h6,strong,b,span,button').each((_, el) => {
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!/^important safety information$/i.test(title)) return;
    const sectionText = normalizeExactBlockText(
      $(el).closest('section, article, div, footer, main').text() || $(el).parent().text()
    );
    if (sectionText.length > 40 && !isBotWallText(sectionText)) blocks.push(sectionText);
  });
  $('footer, [role="contentinfo"]').each((_, el) => {
    const text = normalizeExactBlockText($(el).text());
    if (text.length > 80 && /important safety information/i.test(text) && !isBotWallText(text)) {
      blocks.push(text);
    }
  });
  return blocks;
};

const deriveIndicationFromIsi = (isiText: string) => {
  const text = normalizeExactBlockText(isiText);
  if (text.length < 40) return '';
  const patterns = [
    /(?:INDICATIONS?\s+(?:AND\s+USAGE\s*)?[:\-]?\s*)([\s\S]{40,2500}?)(?=\n\s*(?:IMPORTANT SAFETY|WARNINGS|CONTRAINDICATIONS|DOSAGE|ADVERSE|BOXED WARNING))/i,
    /(?:What is [^\n?]+\?\s*)([\s\S]{40,1500}?)(?=\n\s*(?:IMPORTANT|WARNINGS|Who should not))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match[1].trim().length > 40) return match[1].trim();
  }
  return '';
};

const isBotWallImageUrl = (url: string) =>
  /robot-suspicion|loader\.svg|captcha|cf-chl|challenge-platform|akamai.*\.svg|datadome|waf/i.test(String(url || ''));

const isTrackingPixelImageUrl = (url: string) => {
  const lowered = String(url || '').toLowerCase();
  if (!lowered) return false;
  return (
    /(?:^|[./-])(?:pixel|beacon|tracker|tracking|analytics|collect|rum-collector|clarity)(?:[./?_-]|$)/i.test(lowered) ||
    /\/(?:1p|px|pixel|beacon)\.(?:gif|png|jpe?g|webp)(?:$|[?#])/i.test(lowered) ||
    /(?:pingdom\.net|clarity\.ms|doubleclick\.net|googletagmanager\.com|google-analytics\.com|facebook\.com\/tr|unbxdapi\.com\/v2\/1p\.jpg)/i.test(lowered)
  );
};

const isJpeg2000ImageVariantUrl = (url: string) => {
  const lowered = String(url || '').toLowerCase();
  if (!lowered) return false;
  if (/\.(?:jp2|j2k|jpf|jpx)(?:$|[?#])/i.test(lowered)) return true;
  try {
    const parsed = new URL(String(url || '').replace(/&amp;/g, '&'));
    const fmt = String(parsed.searchParams.get('fmt') || parsed.searchParams.get('format') || parsed.searchParams.get('fm') || '').toLowerCase();
    return /^(?:jp2|j2k|jpf|jpx|jpeg2000|jpeg2000-alpha)$/.test(fmt);
  } catch {
    return /[?&](?:fmt|format|fm)=(?:jp2|j2k|jpf|jpx|jpeg2000|jpeg2000-alpha)(?:&|$)/i.test(lowered);
  }
};

const isJunkImageUrl = (url: string) => {
  const lowered = String(url || '').toLowerCase();
  if (!lowered) return true;
  // Avoid JPEG2000 variants in extracted image cards. macOS/browser previews are slower
  // and these variants can leak as tiny .jp2 files when a source has <picture> fallbacks.
  if (isJpeg2000ImageVariantUrl(url)) return true;
  // Broken AEM srcset fragments like https://site.com/jcr:content.png (no dam/.imaging path).
  if (/^https?:\/\/[^/]+\/jcr:content\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|[?#])/i.test(lowered)) return true;
  if (/^https?:\/\/[^/]+\/jcr:content(?:$|[?#])/i.test(lowered)) return true;
  if (isTrackingPixelImageUrl(url)) return true;
  return false;
};

const IMAGE_DEDUPE_STRIP_PARAMS = new Set([
  'w',
  'h',
  'width',
  'height',
  'mw',
  'mh',
  'quality',
  'q',
  'format',
  'fm',
  'auto',
  'fit',
  'crop',
  'scale',
  'dpr',
  'rev',
  'mode',
  'output',
]);

const isOpaqueGeneratedImageLeaf = (leaf: string) => {
  const name = String(leaf || '').trim().toLowerCase();
  if (!name) return true;
  if (/^image-\d+\.[a-z0-9]+$/i.test(name)) return true;
  if (/^[a-f0-9]{16,}(\-\d+)?\.[a-z0-9]+$/i.test(name)) return true;
  return false;
};

const canonicalImageDedupKey = (url: string) => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) {
    if (raw.length <= 280) return raw;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const leaf = filenameFromUrlPath(raw).toLowerCase();
    // Every symbol in an SVG sprite is a separate extractable asset.
    if (/\.svg$/i.test(parsed.pathname) && parsed.hash) {
      return `${host}:${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
    }
    const contextParam = parsed.searchParams.get('context');
    if (contextParam) {
      return `${host}:${parsed.pathname}?context=${contextParam}`.toLowerCase();
    }
    if (isLikely360SequenceUrl(raw)) {
      const sequencePath = parsed.pathname
        .replace(/^\/content\/dam\/toyota\/(?=jellies\/)/i, '/')
        .replace(/^\/is\/image\/toyota\/toyota\/(?=jellies\/)/i, '/')
        .replace(/\/{2,}/g, '/');
      return `sequence:${sequencePath}`.toLowerCase();
    }
    if (leaf && !isOpaqueGeneratedImageLeaf(leaf)) {
      return `${host}:file:${leaf}`;
    }
    const ashId =
      parsed.searchParams.get('id') ||
      parsed.searchParams.get('mediaid') ||
      parsed.searchParams.get('mid') ||
      parsed.searchParams.get('assetid');
    if (/\.ashx$/i.test(parsed.pathname) && ashId) {
      return `${host}:ashx:${String(ashId).toLowerCase()}`;
    }
    const imagingMatch = parsed.pathname.match(/\.imaging\/[^/]+\/[^/]+\/jcr:([^/]+)/i);
    if (imagingMatch?.[1]) return `${host}:imaging:${imagingMatch[1].toLowerCase()}`;

    const normalizedPath = parsed.pathname.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '');
    IMAGE_DEDUPE_STRIP_PARAMS.forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = '';
    const search = parsed.searchParams.toString();
    return `${host}:${normalizedPath}${search ? `?${search}` : ''}`.toLowerCase();
  } catch {
    return raw.split('#')[0].replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '').toLowerCase();
  }
};

const scoreImageRecord = (img: any) => {
  let score = 0;
  const url = String(img?.url || '');
  if (img?.cachedUrl) score += 50;
  if (img?.status === 'downloaded') score += 40;
  if (img?.filename || img?.alt || img?.name) score += 20;
  try {
    const parsed = new URL(url);
    const width = Number(parsed.searchParams.get('wid') || parsed.searchParams.get('width') || parsed.searchParams.get('w') || 0);
    const height = Number(parsed.searchParams.get('hei') || parsed.searchParams.get('height') || parsed.searchParams.get('h') || 0);
    const quality = Number(parsed.searchParams.get('qlt') || parsed.searchParams.get('quality') || parsed.searchParams.get('q') || 0);
    if (width > 0) score += Math.min(30, Math.round(width / 80));
    if (height > 0) score += Math.min(12, Math.round(height / 80));
    if (quality > 0) score += Math.min(10, Math.round(quality / 10));
    const fmt = String(parsed.searchParams.get('fmt') || parsed.searchParams.get('format') || '').toLowerCase();
    if (/jp2|j2k|jpf|jpx|jpeg2000/.test(fmt)) score -= 10000;
    if (/jpg|jpeg|png/.test(fmt)) score += 5;
    if (/webp|avif/.test(fmt)) score += 2;
  } catch {
    // Keep base score.
  }
  if (!/-\d+x\d+\./i.test(url)) score += 12;
  if (/\.(?:png|jpe?g|webp|avif)(\?|$)/i.test(url)) score += 8;
  if (/\.(?:jp2|j2k|jpf|jpx)(?:$|[?#])/i.test(url)) score -= 10000;
  if (/[?&]context=/i.test(url)) score += 30;
  if (!/\.ashx(\?|$)/i.test(url)) score += 4;
  return score;
};

const dedupeImagesByCanonicalKey = (images: any[]) => {
  const groups = new Map<string, any[]>();
  for (const img of images) {
    const url = String(img?.url || '');
    if (!url) continue;
    const key = canonicalImageDedupKey(url);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(img);
    groups.set(key, bucket);
  }
  return Array.from(groups.values()).map((group) =>
    [...group].sort((a, b) => scoreImageRecord(b) - scoreImageRecord(a))[0]
  );
};

const parseExpandableImageSequence = (rawUrl: string) => {
  const value = String(rawUrl || '').replace(/&amp;/g, '&').trim();
  if (!value || !isLikely360SequenceUrl(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.pathname.includes('//')) return null;
  const numericLeafMatch = parsed.pathname.match(/^(.*\/)(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const prefixedLeafMatch = parsed.pathname.match(/^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const match = numericLeafMatch || prefixedLeafMatch;
  if (!match) return null;
  const frame = Number(match[2]);
  if (!Number.isFinite(frame) || frame < 1 || frame > MAX_IMAGE_SEQUENCE_FRAMES) return null;
  const pathParts = match[1].split('/').filter(Boolean);
  const pathCount = Number(pathParts[pathParts.length - 1] || 0);
  const hasExplicitCountPath = Boolean(numericLeafMatch && pathCount >= 2 && pathCount <= MAX_IMAGE_SEQUENCE_FRAMES);
  return {
    href: parsed.href,
    prefix: match[1],
    suffix: match[3],
    frame,
    explicitCount: hasExplicitCountPath ? pathCount : 0,
    numericLeaf: Boolean(numericLeafMatch),
    key: `${parsed.origin}${match[1]}*${match[3]}?${parsed.searchParams.toString()}`.toLowerCase(),
  };
};

const imageSequenceFrameUrl = (seedUrl: string, frame: number) => {
  const parsed = parseExpandableImageSequence(seedUrl);
  if (!parsed) return '';
  try {
    const clone = new URL(parsed.href);
    clone.pathname = `${parsed.prefix}${frame}${parsed.suffix}`;
    return clone.href;
  } catch {
    return '';
  }
};

const toyotaCountedImageSequenceFrameUrl = (seedUrl: string, frame: number, count = 36) => {
  const parsed = parseExpandableImageSequence(seedUrl);
  if (!parsed || parsed.explicitCount > 0 || !parsed.numericLeaf) return '';
  if (!/\/jellies\/(?:max|relative)\//i.test(parsed.href)) return '';
  if (count < 2 || count > MAX_IMAGE_SEQUENCE_FRAMES) return '';
  try {
    const clone = new URL(parsed.href);
    clone.pathname = `${parsed.prefix}${count}/${frame}${parsed.suffix}`;
    return clone.href;
  } catch {
    return '';
  }
};

const isRemoteImageUrlAvailable = async (url: string, refererPageUrl = '') => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const accept = imageAcceptHeaderForUrl(url);
  const headers = {
    'User-Agent': PAGE_FETCH_USER_AGENTS[0],
    Accept: accept,
    ...(referer ? { Referer: referer } : {}),
  };
  const check = async (method: 'HEAD' | 'GET') => {
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(method === 'GET' ? { Range: 'bytes=0-511' } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok && response.status !== 206) return false;
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('image/')) return false;
    return true;
  };
  try {
    if (await check('HEAD')) return true;
  } catch {
    // Some asset hosts do not allow HEAD.
  }
  try {
    return await check('GET');
  } catch {
    return false;
  }
};

const repairMalformedToyotaCountedSequences = async (items: any[], targetUrl: string) => {
  if (!isToyotaVehicleExtractionTarget(targetUrl)) return items;

  const ordinarySeeds = items
    .map((item) => ({ item, parsed: String(item?.url || '').match(/\/jellies\/(?:max|relative)\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/1\.(png|jpe?g|webp|avif)(?:[?#]|$)/i) }))
    .filter((entry) => entry.parsed);
  if (ordinarySeeds.length === 0) return items;

  let repairedGroup: { seed: any; urls: Array<{ frame: number; url: string }> } | null = null;
  for (const item of items) {
    const raw = String(item?.url || '').replace(/&amp;/g, '&').trim();
    if (!raw || !hasMalformedImageSequencePath(raw)) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const malformed = parsed.pathname.match(/^(.*\/jellies\/(?:max|relative)\/(\d{4})\/([^/]+))\/{2,}([^/]+)\/([^/]+)\/(\d{1,3})\/(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
    if (!malformed) continue;
    const [, prefix, year, model, modelCode, colorCode, countRaw, , extension] = malformed;
    const count = Number(countRaw);
    if (count < 8 || count > MAX_IMAGE_SEQUENCE_FRAMES) continue;
    const matchingSeed = ordinarySeeds.find(({ parsed: seedMatch }) =>
      seedMatch?.[1] === year &&
      seedMatch?.[2]?.toLowerCase() === model.toLowerCase() &&
      seedMatch?.[4]?.toLowerCase() === modelCode.toLowerCase() &&
      seedMatch?.[5]?.toLowerCase() === colorCode.toLowerCase()
    );
    const trim = matchingSeed?.parsed?.[3];
    if (!trim) continue;

    const urls = Array.from({ length: count }, (_unused, index) => {
      const clone = new URL(parsed.href);
      clone.pathname = `${prefix}/${trim}/${modelCode}/${colorCode}/${count}/${index + 1}${extension}`;
      return { frame: index + 1, url: clone.href };
    });
    // The page's first malformed counted URL belongs to the color currently
    // loaded in the viewer. Keep only that color and do not probe every trim.
    repairedGroup = { seed: item, urls };
    break;
  }
  if (!repairedGroup) return items;

  const existingUrls = new Set(items.map((item) => String(item?.url || '').trim()).filter(Boolean));
  const discovered: any[] = [];
  const sequenceCount = repairedGroup.urls.length;
  for (const candidate of repairedGroup.urls) {
      if (existingUrls.has(candidate.url)) continue;
      existingUrls.add(candidate.url);
      discovered.push({
        ...repairedGroup.seed,
        url: candidate.url,
        type: inferImageTypeFromUrl(candidate.url) || getAssetTypeFromUrl(candidate.url, 'png'),
        filename: filenameFromUrlPath(candidate.url),
        source: '360-sequence-probed',
        alt: `360 frame ${candidate.frame}`,
        sequenceFrame: candidate.frame,
        sequenceCount,
        status: DEFAULT_ASSET_STATUS,
      });
  }

  return discovered.length ? [...items.filter((item) => !hasMalformedImageSequencePath(String(item?.url || ''))), ...discovered] : items;
};

const expandAvailableImageSequences = async (items: any[], targetUrl: string) => {
  const byGroup = new Map<string, { seed: any; parsed: NonNullable<ReturnType<typeof parseExpandableImageSequence>>; observedFrames: Set<number> }>();
  for (const item of items) {
    const url = String(item?.url || '').trim();
    const parsed = parseExpandableImageSequence(url);
    if (!parsed) continue;
    if (parsed.explicitCount > 0) continue;
    if (!/(?:toyota|jellies|mazda|lexus|assetscs|visualizer|threesixty|360)/i.test(url)) continue;
    const isToyotaJellySequence = /\/jellies\/(?:max|relative)\//i.test(url);
    const isPrefixedVisualizerSequence =
      /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(url) &&
      /[-_]\d{1,3}\.(?:png|jpe?g|webp|avif)(?:[?#]|$)/i.test(url);
    if (!isToyotaJellySequence && !isPrefixedVisualizerSequence) continue;
    const group = byGroup.get(parsed.key) || { seed: item, parsed, observedFrames: new Set<number>() };
    group.observedFrames.add(parsed.frame);
    byGroup.set(parsed.key, group);
  }
  const groups = [...byGroup.values()].slice(0, 48);
  if (groups.length === 0) return items;
  const existingUrls = new Set(items.map((item) => String(item?.url || '').trim()).filter(Boolean));
  const discovered: any[] = [];
  const replacedGroupKeys = new Set<string>();
  await mapWithConcurrency(groups, 4, async (group) => {
    const seedUrl = String(group.seed?.url || '');
    const isToyotaJellyGroup = /\/jellies\/(?:max|relative)\//i.test(seedUrl) && group.parsed.explicitCount === 0;
    const maxProbe = Math.min(MAX_IMAGE_SEQUENCE_FRAMES, Math.max(36, ...Array.from(group.observedFrames)));
    const toyotaCountedCandidates = isToyotaJellyGroup
      ? Array.from({ length: Math.min(36, MAX_IMAGE_SEQUENCE_FRAMES) }, (_unused, index) => index + 1)
          .map((frame) => ({ frame, url: toyotaCountedImageSequenceFrameUrl(seedUrl, frame, 36), counted: true }))
          .filter((candidate) => candidate.url && !existingUrls.has(candidate.url))
      : [];
    const toyotaCountedChecks = toyotaCountedCandidates.length
      ? await mapWithConcurrency(toyotaCountedCandidates, 8, async (candidate) => ({
          ...candidate,
          ok: await isRemoteImageUrlAvailable(candidate.url, targetUrl),
        }))
      : [];
    const countedValidFrames = new Set<number>();
    toyotaCountedChecks.filter((check) => check.ok).forEach((check) => countedValidFrames.add(check.frame));
    const useToyotaCountedSequence = countedValidFrames.size >= Math.max(8, group.observedFrames.size + 1);
    const candidates = useToyotaCountedSequence ? [] : Array.from({ length: maxProbe }, (_unused, index) => index + 1)
      .filter((frame) => !group.observedFrames.has(frame))
      .map((frame) => ({ frame, url: imageSequenceFrameUrl(seedUrl, frame) }))
      .filter((candidate) => candidate.url && !existingUrls.has(candidate.url));
    const checks = await mapWithConcurrency(candidates, 8, async (candidate) => ({
      ...candidate,
      ok: await isRemoteImageUrlAvailable(candidate.url, targetUrl),
    }));
    const validFrames = useToyotaCountedSequence ? countedValidFrames : new Set<number>(group.observedFrames);
    if (!useToyotaCountedSequence) checks.filter((check) => check.ok).forEach((check) => validFrames.add(check.frame));
    const sortedFrames = [...validFrames].filter((frame) => frame >= 1).sort((a, b) => a - b);
    // Keep every frame that the site actually exposes. Some 360 viewers skip
    // frame numbers or only expose a small subset for alternate trims/colors;
    // stopping at the first missing frame hides valid later frames.
    const frameSet = sortedFrames;
    const count = Math.max(...frameSet);
    if (count < 2) return;
    // Toyota product pages expose many 1-4 frame angle-preview image groups
    // under the same jellies path. Only promote Toyota no-count jellies URLs
    // to a 360 sequence when probing finds a fuller frame run. Otherwise keep
    // those assets as normal images so they do not crowd the 360 section.
    if (isToyotaJellyGroup && !useToyotaCountedSequence && count < 8) return;
    if (useToyotaCountedSequence) replacedGroupKeys.add(group.parsed.key);
    for (const frame of frameSet) {
      const url = useToyotaCountedSequence
        ? toyotaCountedImageSequenceFrameUrl(seedUrl, frame, 36)
        : imageSequenceFrameUrl(seedUrl, frame);
      if (!url || existingUrls.has(url)) continue;
      existingUrls.add(url);
      discovered.push({
        ...group.seed,
        url,
        type: inferImageTypeFromUrl(url) || getAssetTypeFromUrl(url, String(group.seed?.type || 'jpg')),
        filename: filenameFromUrlPath(url),
        source: '360-sequence-probed',
        alt: `360 frame ${frame}`,
        sequenceFrame: frame,
        sequenceCount: count,
        status: DEFAULT_ASSET_STATUS,
      });
    }
    // Normalize observed seed frames with the actual count too.
    for (const item of items) {
      const parsed = parseExpandableImageSequence(String(item?.url || ''));
      if (!parsed || parsed.key !== group.parsed.key || !frameSet.includes(parsed.frame)) continue;
      item.source = String(item.source || '').includes('360-sequence') ? item.source : '360-sequence-probed';
      item.sequenceFrame = parsed.frame;
      item.sequenceCount = count;
      item.alt = item.alt || `360 frame ${parsed.frame}`;
    }
  });
  const keptItems = replacedGroupKeys.size
    ? items.filter((item) => {
        const parsed = parseExpandableImageSequence(String(item?.url || ''));
        return !parsed || !replacedGroupKeys.has(parsed.key);
      })
    : items;
  return discovered.length ? [...keptItems, ...discovered] : keptItems;
};

const filterUnavailableGeneratedImageSequences = async (items: any[], targetUrl: string) => {
  if (shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) {
    return items;
  }
  const groups = new Map<
    string,
    {
      seed: any;
      parsed: NonNullable<ReturnType<typeof parseExpandableImageSequence>>;
      items: any[];
      sequenceCount: number;
    }
  >();

  for (const item of items) {
    const url = String(item?.url || '').trim();
    const parsed = parseExpandableImageSequence(url);
    if (!parsed || parsed.explicitCount < 8 || !/^https?:\/\//i.test(url)) continue;
    const source = String(item?.source || '');
    const isGeneratedSequence =
      source.includes('360-sequence') ||
      Number(item?.sequenceCount || 0) >= 8 ||
      /\/jellies\/(?:max|relative)\//i.test(url);
    if (!isGeneratedSequence) continue;
    const group = groups.get(parsed.key) || {
      seed: item,
      parsed,
      items: [],
      sequenceCount: Number(item?.sequenceCount || parsed.explicitCount || 0),
    };
    group.items.push(item);
    group.sequenceCount = Math.max(group.sequenceCount, Number(item?.sequenceCount || parsed.explicitCount || 0));
    groups.set(parsed.key, group);
  }

  if (groups.size === 0) return items;

  const invalidKeys = new Set<string>();
  await mapWithConcurrency([...groups.values()], 4, async (group) => {
    const count = Math.min(MAX_IMAGE_SEQUENCE_FRAMES, Math.max(8, group.sequenceCount || group.parsed.explicitCount));
    const sampleFrames = Array.from(new Set([1, Math.max(1, Math.ceil(count / 2)), count]));
    const checks = await mapWithConcurrency(sampleFrames, 3, async (frame) => {
      const sampleUrl = imageSequenceFrameUrl(String(group.seed?.url || ''), frame);
      if (!sampleUrl) return false;
      return isRemoteImageUrlAvailable(sampleUrl, targetUrl);
    });
    const validSamples = checks.filter(Boolean).length;
    if (validSamples < Math.min(2, sampleFrames.length)) {
      invalidKeys.add(group.parsed.key);
    }
  });

  if (invalidKeys.size === 0) return items;
  return items.filter((item) => {
    const parsed = parseExpandableImageSequence(String(item?.url || ''));
    return !parsed || !invalidKeys.has(parsed.key);
  });
};

const keepBestToyotaSequenceGroup = (items: any[], targetUrl: string) => {
  if (!shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) return items;
  const groups = new Map<
    string,
    {
      key: string;
      items: any[];
      count: number;
      trusted: boolean;
      explicitCount: number;
    }
  >();

  for (const item of items) {
    const url = String(item?.url || '').trim();
    const parsed = parseExpandableImageSequence(url);
    const source = String(item?.source || '').trim();
    const count = Number(item?.sequenceCount || parsed?.explicitCount || 0);
    const trusted = source.includes('360-sequence') || source.includes('360-sequence-probed');
    if ((!parsed && !trusted) || count < 8) continue;
    const key = parsed?.key || `${source}:${url}`;
    const group = groups.get(key) || {
      key,
      items: [],
      count: 0,
      trusted: false,
      explicitCount: parsed?.explicitCount || 0,
    };
    group.items.push(item);
    group.count = Math.max(group.count, count, group.items.length);
    group.trusted = group.trusted || trusted;
    group.explicitCount = Math.max(group.explicitCount, parsed?.explicitCount || 0);
    groups.set(key, group);
  }

  if (groups.size === 0) return items;

  const preferredGroup = [...groups.values()].sort((a, b) => {
    if (Number(b.trusted) !== Number(a.trusted)) return Number(b.trusted) - Number(a.trusted);
    if (b.count !== a.count) return b.count - a.count;
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return b.explicitCount - a.explicitCount;
  })[0];

  if (!preferredGroup || preferredGroup.count < 8) return items;

  const allowedKeys = new Set([preferredGroup.key]);
  return items.filter((item) => {
    const url = String(item?.url || '').trim();
    const parsed = parseExpandableImageSequence(url);
    const source = String(item?.source || '').trim();
    const count = Number(item?.sequenceCount || parsed?.explicitCount || 0);
    const isSequenceCandidate = Boolean(parsed || source.includes('360-sequence') || source.includes('360-sequence-probed'));
    if (!isSequenceCandidate || count < 8) return true;
    const key = parsed?.key || `${source}:${url}`;
    return allowedKeys.has(key);
  });
};

const probeSvgDimensions = (buffer: Buffer) => {
  try {
    const text = buffer.slice(0, 8192).toString('utf8');
    const viewBox = text.match(/viewBox=["']([\d.\s]+)["']/i);
    if (viewBox) {
      const parts = viewBox[1].trim().split(/\s+/).map((value) => Number(value));
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
      }
    }
    const widthMatch = text.match(/\bwidth=["'](\d+(?:\.\d+)?)/i);
    const heightMatch = text.match(/\bheight=["'](\d+(?:\.\d+)?)/i);
    const width = widthMatch ? Math.round(Number(widthMatch[1])) : 0;
    const height = heightMatch ? Math.round(Number(heightMatch[1])) : 0;
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // ignore SVG probe failures
  }
  return { width: 0, height: 0 };
};

const probeRasterDimensions = (buffer: Buffer) => {
  if (!buffer || buffer.length < 24) return { width: 0, height: 0 };
  const head = buffer.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<') && head.includes('<svg'))) {
    return probeSvgDimensions(buffer);
  }
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2 || marker === 0xc1) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + Math.max(segmentLength, 2);
      }
    }
    if (buffer.slice(0, 8).toString('ascii') === '\x89PNG\r\n\x1a\n') {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      if (buffer.slice(12, 16).toString('ascii') === 'VP8X' && buffer.length >= 30) {
        return {
          width: 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16),
          height: 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16),
        };
      }
    }
  } catch {
    // ignore dimension probe failures
  }
  return { width: 0, height: 0 };
};

const decodeDataImageBuffer = (dataUrl: string) => {
  const raw = String(dataUrl || '').trim();
  if (!raw.startsWith('data:image/')) return null;
  const comma = raw.indexOf(',');
  if (comma < 0) return null;
  const header = raw.slice(0, comma).toLowerCase();
  const payload = raw.slice(comma + 1);
  try {
    const buffer = header.includes(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (!buffer.length) return null;
    return buffer;
  } catch {
    return null;
  }
};

const fontIconPathFontCache = new Map<string, Promise<any | null>>();

const escapeSvgXml = (value: unknown) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const decodeFontIconSvgTextMeta = (dataUrl: string, fallback: Record<string, any> = {}) => {
  const buffer = decodeDataImageBuffer(dataUrl);
  if (!buffer?.length) return null;
  const svgText = buffer.toString('utf8');
  if (!/<text\b/i.test(svgText)) return null;
  const textMatch = svgText.match(/<text\b([^>]*)>([\s\S]*?)<\/text>/i);
  if (!textMatch) return null;
  const attrs = textMatch[1] || '';
  const readAttr = (name: string) =>
    attrs.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1]?.trim() || '';
  const glyph = String(fallback.fontGlyph || textMatch[2] || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  const fontFamily = String(fallback.fontFamily || readAttr('font-family') || '').replace(/&quot;/g, '"').replace(/^["']|["']$/g, '');
  const fontSize = Number(fallback.fontSize || readAttr('font-size') || 0) || 48;
  const fill = String(fallback.fill || readAttr('fill') || '#000').replace(/&quot;/g, '"');
  const width = Number(fallback.width || svgText.match(/<svg\b[^>]*\bwidth=["']?(\d+)/i)?.[1] || 0) || 64;
  const height = Number(fallback.height || svgText.match(/<svg\b[^>]*\bheight=["']?(\d+)/i)?.[1] || 0) || width;
  if (!glyph || !/font awesome|fontawesome/i.test(fontFamily)) return null;
  return { glyph, fontFamily, fontSize, fill, width, height };
};

const buildFontIconTextSvgDataUrlFromMeta = (imageMeta: Record<string, any> = {}) => {
  const glyph = String(imageMeta.fontGlyph || '').trim();
  if (!glyph) return '';
  const width = Math.max(32, Number(imageMeta.width || 0) || 64);
  const height = Math.max(32, Number(imageMeta.height || 0) || width);
  const fontSize = Math.max(12, Number(imageMeta.fontSize || 0) || Math.round(Math.min(width, height) * 0.72));
  const fontFamily = String(imageMeta.fontFamily || 'Font Awesome 6 Free, Font Awesome 5 Free, Font Awesome 6 Brands, Font Awesome 5 Brands, sans-serif');
  const fill = String(imageMeta.fill || '#000');
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}">` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="${escapeSvgXml(fontFamily)}" font-size="${Math.round(fontSize)}" fill="${escapeSvgXml(fill)}">${escapeSvgXml(glyph)}</text>` +
    '</svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svgText, 'utf8').toString('base64')}`;
};

const rasterizeSvgDataUrlToPngDataUrl = async (svgDataUrl: string) => {
  const buffer = decodeDataImageBuffer(svgDataUrl);
  if (!buffer?.length) return '';
  try {
    const sharp = await loadSharp();
    const png = await sharp(buffer, { density: 192, failOn: 'none' }).png().toBuffer();
    return png?.length ? `data:image/png;base64,${png.toString('base64')}` : '';
  } catch {
    return '';
  }
};

const loadOpenTypeFontForIcon = async (fontUrl: string, refererPage = '') => {
  const key = `${fontUrl}::${refererPage}`;
  if (!fontIconPathFontCache.has(key)) {
    fontIconPathFontCache.set(key, (async () => {
      try {
        const fetched = await fetchRemoteFontBuffer(fontUrl, refererPage);
        const detected = detectFontFormatFromBuffer(fetched.buffer) || normalizeFontFormat(getAssetTypeFromUrl(fetched.sourceUrl || fontUrl, 'font'));
        const inner = await getInnerFontBuffer(fetched.buffer, detected);
        return opentype.parse(bufferToExactArrayBuffer(inner.buffer) as any);
      } catch {
        return null;
      }
    })());
  }
  return fontIconPathFontCache.get(key)!;
};

const fontMatchesIconFamily = (font: any, family: string) => {
  const haystack = [
    font?.family,
    font?.name,
    font?.title,
    font?.source,
    font?.url,
    font?.originalFilename,
  ].map((item) => String(item || '').toLowerCase()).join(' ');
  const normalizedFamily = String(family || '').toLowerCase().replace(/["']/g, '');
  if (/font awesome|fontawesome/.test(normalizedFamily)) return /font[-\s]?awesome|\/fa-|fa-(?:solid|regular|brands)|fontawesome/i.test(haystack);
  return haystack.includes(normalizedFamily);
};

const convertFontIconTextSvgToPathSvg = async (
  dataUrl: string,
  imageMeta: Record<string, any>,
  fonts: any[],
  refererPage = ''
) => {
  const meta = decodeFontIconSvgTextMeta(dataUrl, imageMeta);
  if (!meta) return '';
  const candidateFonts = fonts
    .filter((font) => String(font?.url || '').trim())
    .filter((font) => fontMatchesIconFamily(font, meta.fontFamily));
  for (const font of candidateFonts) {
    const parsedFont = await loadOpenTypeFontForIcon(String(font.url), refererPage);
    if (!parsedFont) continue;
    try {
      const glyph = parsedFont.charToGlyph(meta.glyph);
      if (!glyph || !Number.isFinite(Number(glyph.index)) || Number(glyph.index) === 0) continue;
      const size = Math.max(meta.width, meta.height, 64);
      const fontSize = Math.max(16, Math.min(size * 0.82, Number(meta.fontSize || size * 0.72)));
      const probePath = glyph.getPath(0, 0, fontSize);
      const box = probePath.getBoundingBox();
      const glyphWidth = Math.max(1, box.x2 - box.x1);
      const glyphHeight = Math.max(1, box.y2 - box.y1);
      const x = (size - glyphWidth) / 2 - box.x1;
      const y = (size - glyphHeight) / 2 - box.y1;
      const pathData = glyph.getPath(x, y, fontSize).toPathData(3);
      if (!pathData || pathData.length < 8) continue;
      const svgText =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
        `<path fill="${escapeSvgXml(meta.fill)}" d="${escapeSvgXml(pathData)}"/></svg>`;
      return `data:image/svg+xml;base64,${Buffer.from(svgText, 'utf8').toString('base64')}`;
    } catch {
      // Try next font candidate.
    }
  }
  return '';
};

const enrichImageAssetMeta = (img: any, buffer?: Buffer | null, contentType = '') => {
  const next = { ...img };
  const resolvedBuffer =
    buffer && buffer.length > 0 ? buffer : decodeDataImageBuffer(String(next.url || ''));
  if (resolvedBuffer && resolvedBuffer.length > 0) {
    next.bytes = resolvedBuffer.length;
    const dims = probeRasterDimensions(resolvedBuffer);
    if (dims.width > 0 && dims.height > 0) {
      next.width = dims.width;
      next.height = dims.height;
    }
  }
  if (!next.filename) {
    const fromUrl = filenameFromUrlPath(String(next.url || ''));
    if (fromUrl) next.filename = fromUrl;
  }
  if (!next.mimeType && contentType) next.mimeType = contentType;
  return next;
};

const isBotWallText = (text: string) =>
  /checking (the )?site connection|connection security|robot-suspicion|captcha|verify you are human|access denied|just a moment|enable javascript|cloudflare|datadome|akamai|waf challenge|bot detection/i.test(
    String(text || '')
  );

const isBotWallHtml = (html: string) => {
  return htmlLooksLikeBotWall(html);
};

const isLikelyBotWallExtract = (assets: { images?: any[] }) => {
  const imgs = assets?.images || [];
  if (!imgs.length) return false;
  const botCount = imgs.filter((img) => isBotWallImageUrl(String(img?.url || ''))).length;
  return botCount > 0 && botCount >= imgs.length - 1;
};

const staticExtractNeedsBrowser = (
  html: string,
  assets: { images?: any[]; fonts?: any[]; videos?: any[] },
  options: { videosOnly?: boolean } = {}
) => {
  const text = String(html || '');
  if (htmlNeedsRenderedExtraction(text)) return true;
  const fontHints = /fonts\.(?:googleapis|gstatic)|typekit|accelerator\.sanofi|use\.typekit|@font-face|rel=["']stylesheet["']/i.test(text);
  const videoHints = /youtube\.com|youtu\.be|vimeo\.com|wistia|brightcove|vidyard|\.(?:mp4|webm|m3u8)(?:[?#"'`<>\s\\)]|$)|<video\b|<iframe[^>]+src=/i.test(text);
  const lazyImageHints = /\bdata-(?:src|lazy-src|original|image)=/i.test(text) || /\bloading=["']lazy["']/i.test(text);
  const lowFonts = (assets?.fonts?.length || 0) < 2;
  const lowVideos = options.videosOnly && (assets?.videos?.length || 0) === 0 && videoHints;
  const lowImagesForLazySite = lazyImageHints && (assets?.images?.length || 0) < 40;
  return (lowFonts && fontHints) || lowVideos || lowImagesForLazySite || staticExtractHasUnresolvedEmbeds(text, assets, options);
};

const staticExtractHasUnresolvedEmbeds = (
  html: string,
  assets: { videos?: any[] },
  options: { videosOnly?: boolean } = {}
) => {
  if (!options.videosOnly) return false;
  const text = String(html || '');
  const videos = assets?.videos || [];
  const vimeoHints = /vimeo\.com|data-vimeo-id/i.test(text);
  if (vimeoHints && !videos.some((video: any) => video?.isVimeoDirect)) return true;
  const wistiaHints = /wistia|<wistia-player\b|fast\.wistia\.(?:com|net)/i.test(text);
  if (wistiaHints && !videos.some((video: any) => video?.provider === 'wistia' && (video?.isWistiaDirect || /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(String(video?.url || ''))))) {
    return true;
  }
  const brightcoveHints = /brightcove|gb-video-brightcove|data-account-id|players\.brightcove\.net/i.test(text);
  if (brightcoveHints && !videos.some((video: any) => video?.provider === 'brightcove' && (video?.isDirect || video?.brightcoveManifestUrl || /\.mp4|m3u8/i.test(String(video?.url || ''))))) {
    return true;
  }
  const jwHints = /jwplayer|jw-player|kaltura|videoUrl["']\s*:/i.test(text);
  if (jwHints && videos.length === 0) return true;
  return false;
};

const collectBrightcovePlayerUrls = (videos: any[]) =>
  Array.from(
    new Set(
      (videos || [])
        .map((video) => String(video?.url || video?.sourceUrl || '').trim())
        .filter((url) => /players\.brightcove\.net/i.test(url) || parseBrightcovePlayerUrl(url))
    )
  );

const resolveBrightcoveCandidateVideos = async (videos: any[], label: string) => {
  const playerUrls = collectBrightcovePlayerUrls(videos);
  if (playerUrls.length === 0) return videos;
  const resolved: any[] = [];
  const unavailablePlayerUrls = new Set<string>();
  for (const playerUrl of playerUrls.slice(0, 8)) {
    try {
      const assets = await withTimeout(extractBrightcoveVideos(playerUrl), 20000, `${label} for ${playerUrl}`);
      if (assets?.videos?.length) resolved.push(...assets.videos);
    } catch (error: any) {
      if (/\bVIDEO_NOT_FOUND\b/i.test(String(error?.message || error || ''))) {
        unavailablePlayerUrls.add(playerUrl);
      }
      console.warn(`${label} failed for ${playerUrl}:`, error?.message || error);
    }
  }
  if (!resolved.length) {
    return videos.filter((video) => {
      const url = String(video?.url || video?.embedUrl || '').trim();
      return !unavailablePlayerUrls.has(url) && !/players\.brightcove\.net/i.test(url);
    });
  }
  const withoutPlaceholders = videos.filter((video) => {
    const url = String(video?.url || '');
    return !/players\.brightcove\.net/i.test(url);
  });
  return [...withoutPlaceholders, ...resolved];
};

const shouldTryStaticBeforeBrowser = (html: string) => {
  const text = String(html || '');
  if (htmlLooksLikeBotWall(text)) return false;
  return text.length > 5000 && !isSparseSiteHtml(text) && scoreSiteHtml(text, 200) >= 30;
};

const htmlNeedsRenderedExtraction = (html: string) => {
  const sample = String(html || '').slice(0, 500000);
  const lazyAttrCount =
    (sample.match(/\bdata-(?:src|lazy-src|original|image|bg|background-image|lazyload|iesrc|lazy-image|flickity-lazyload|thumb|thumbnail|poster|hires|retina)=/gi)?.length || 0) +
    (sample.match(/\bloading=["']lazy["']/gi)?.length || 0);
  return (
    lazyAttrCount >= 2 ||
    /__NEXT_DATA__|__NUXT__|sap-commerce|hybris|next\/image|nuxt-img|swiper-lazy|lazyload|hydrateRoot|data-hydration|fabindia|\/medias\/|medias\/sys_master|commercecloud|IntersectionObserver|lazySizes|lozad|vanilla-lazyload/i.test(
      sample
    )
  );
};

const isPlatformMarketingHomepage = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/' && path !== '/home') return false;
    return host === 'vimeo.com' || host.endsWith('.vimeo.com');
  } catch {
    return false;
  }
};

const performLazyLoadScroll = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>,
  options: { stepDelayMs?: number; maxStableRounds?: number; maxDurationMs?: number } = {}
) => {
  const stepDelayMs = options.stepDelayMs ?? 750;
  const maxStableRounds = options.maxStableRounds ?? 4;
  const maxDurationMs = options.maxDurationMs ?? 45000;
  await page.evaluate(
    async ({ delayMs, stableLimit, maxMs }) => {
      const vp = window.innerHeight || document.documentElement.clientHeight || 800;
      const step = Math.max(Math.floor(vp * 0.9), 500);
      let stable = 0;
      let lastHeight = 0;
      const startedAt = Date.now();
      while (stable < stableLimit && Date.now() - startedAt < maxMs) {
        window.scrollBy(0, step);
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
        const scrollHeight = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        );
        if (scrollHeight <= lastHeight + 8) stable += 1;
        else {
          stable = 0;
          lastHeight = scrollHeight;
        }
        if (window.scrollY + vp >= scrollHeight - 4) stable += 1;
      }
      window.scrollTo(0, 0);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    },
    { delayMs: stepDelayMs, stableLimit: maxStableRounds, maxMs: maxDurationMs }
  );
};

const pageNeedsLazyLoadScroll = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>,
  initialHtml: string
) => {
  if (htmlNeedsRenderedExtraction(initialHtml)) return true;
  try {
    return await page.evaluate(() => {
      const lazyNodes =
        document.querySelectorAll(
          '[loading="lazy"], [data-src], [data-lazy-src], [data-original], [class*="lazy"], [class*="infinite"], ' +
          '[data-lazyload], [data-lazy-image], [data-iesrc], [data-flickity-lazyload], ' +
          '[data-lazy-srcset], [data-srcset], [data-thumb], [data-thumbnail], [data-poster], ' +
          '[class*="swiper-lazy"], [class*="lazyload"], [class*="lozad"]'
        ).length;
      const hasObserver = document.querySelectorAll('script').length > 0 &&
        Array.from(document.querySelectorAll('script')).some((s) =>
          /IntersectionObserver|lazySizes|lozad|vanilla-lazyload/i.test(s.textContent || '')
        );
      const tallPage =
        Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0) >
        Math.max(window.innerHeight || 800, 640) * 2.2;
      return lazyNodes >= 2 || hasObserver || tallPage;
    });
  } catch {
    return false;
  }
};

const extractRenderedDomAssetsFromPage = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>>
) =>
  page.evaluate(() => {
    const imageUrls = new Set<string>();
    const videoEntries: Array<{ url: string; poster: string; title: string }> = [];
    const fontFamilies = new Set<string>();
    const computedFonts: Array<{ family: string; weight?: string; style?: string }> = [];
    const computedFontKeys = new Set<string>();
    const stylesheetUrls = new Set<string>();
    const fontFaceCss: string[] = [];
    // tsx uses keepNames:true → avoid const/var fn = ()=>{} patterns
    // which get wrapped with __name(fn, "name") and break in browser context.
    // Using object methods instead (not wrapped by __name).
    var _ = {
      toAbsolute(raw: string) {
        const value = String(raw || '').trim();
        if (!value || value === 'about:blank' || value.startsWith('blob:')) return '';
        if (value.startsWith('data:image/')) return value;
        if (value.startsWith('data:')) return '';
        try { return new URL(value, window.location.href).href; }
        catch { return value.startsWith('http') ? value : ''; }
      },
      isLikelyImageCandidate(raw: string) {
        const value = String(raw || '').replace(/&amp;/g, '&').trim();
        if (!value || /%7b|%7d|[{}]/i.test(value)) return false;
        if (/^data:image\//i.test(value)) return true;
        if (/\.(?:css|js|json|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|mkv|m3u8|mpd|html?)(?:[?#]|$)/i.test(value)) return false;
        try {
          const parsed = new URL(value);
          const path = parsed.pathname.replace(/\/{2,}/g, '/');
          const hasImageExt = /\.(?:svg|png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(parsed.href);
          const hasImageFormat = /[?&](?:fmt|format|fm|output)=(?:svg|png|jpe?g|webp|gif|avif|png-alpha|webp-alpha)/i.test(parsed.search);
          const isImageService = /\/is\/image\/|\/image\/|\/images?\/|\/img\/|\/media\/|\/assets?\/|\/content\/dam\/|\/\.imaging\//i.test(path);
          if (!hasImageExt && !hasImageFormat && !isImageService) return false;
          if (!hasImageExt && /\/\d{1,3}(?:&|$)/.test(path)) return false;
          return true;
        } catch {
          return false;
        }
      },
      addImage(raw: string | null | undefined) {
        const abs = _.toAbsolute(String(raw || ''));
        if (abs && _.isLikelyImageCandidate(abs)) imageUrls.add(abs);
      },
      addInlineSvg(svg: SVGElement, index: number) {
        try {
          const externalUse = Array.from(svg.querySelectorAll('use')).some((use) => {
            const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
            return href && !href.startsWith('#');
          });
          if (externalUse) return;
          const clone = svg.cloneNode(true) as SVGElement;
          if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          const svgText = new XMLSerializer().serializeToString(clone);
          const bytes = new TextEncoder().encode(svgText);
          let binary = '';
          const chunkSize = 8192;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...Array.from(bytes.slice(offset, offset + chunkSize)));
          }
          imageUrls.add(`data:image/svg+xml;base64,${btoa(binary)}`);
        } catch {
          // Ignore inline SVG serialization failures.
        }
      },
      addSrcsetCandidates(raw: string | null | undefined) {
        if (!raw) return;
        raw.split(',').forEach((part) => _.addImage(part.trim().split(/\s+/)[0]));
      },
    };
    var fontAwesomeHelpers = {
      decodeCssContent(raw: string | null | undefined) {
        let text = String(raw || '').trim();
        if (!text || text === 'none' || text === 'normal') return '';
        if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
          text = text.slice(1, -1);
        }
        text = text.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex) => {
          try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
        });
        return text.replace(/\\(["'\\])/g, '$1');
      },
      resolveGlyph(style: CSSStyleDeclaration, baseStyle: CSSStyleDeclaration, initialGlyph: string) {
        const candidates = [
          initialGlyph,
          style.getPropertyValue('--fa'),
          baseStyle.getPropertyValue('--fa'),
          style.getPropertyValue('--fa-primary'),
          baseStyle.getPropertyValue('--fa-primary'),
          style.content,
        ];
        for (const candidate of candidates) {
          const glyph = fontAwesomeHelpers.decodeCssContent(candidate);
          if (glyph && !/^var\(/i.test(glyph) && glyph !== 'none' && glyph !== 'normal') return glyph;
        }
        return '';
      },
      svgDataUrl(glyph: string, family: string, fontPx: number, color: string, size: number) {
        try {
          const escapeXml = (value: string) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          const svgText =
            '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
            '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ' +
            'font-family="' + escapeXml(family || 'Font Awesome 6 Free, Font Awesome 5 Free, sans-serif') + '" ' +
            'font-size="' + Math.round(fontPx) + '" fill="' + escapeXml(color || '#000') + '">' +
            escapeXml(glyph) +
            '</text></svg>';
          const bytes = new TextEncoder().encode(svgText);
          let binary = '';
          const chunkSize = 8192;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...Array.from(bytes.slice(offset, offset + chunkSize)));
          }
          return `data:image/svg+xml;base64,${btoa(binary)}`;
        } catch {
          return '';
        }
      },
      addFontAwesomePngs() {
        const selector = [
          '[class~="fa"]',
          '[class~="fas"]',
          '[class~="far"]',
          '[class~="fab"]',
          '[class~="fal"]',
          '[class~="fad"]',
          '[class*=" fa-"]',
          '[class^="fa-"]',
        ].join(',');
        document.querySelectorAll(selector).forEach((el, index) => {
          const htmlEl = el as HTMLElement;
          const classText = String(htmlEl.getAttribute('class') || '');
          const baseStyle = window.getComputedStyle(htmlEl);
          ['::before', '::after'].forEach((pseudo) => {
            try {
              const style = window.getComputedStyle(htmlEl, pseudo);
              const parentStyle = htmlEl.parentElement ? window.getComputedStyle(htmlEl.parentElement) : baseStyle;
              const family = String(style.fontFamily || baseStyle.fontFamily || parentStyle.fontFamily || '');
              if (!/font awesome|fontawesome/i.test(family) && !/(?:^|\s)(?:fa|fas|far|fab|fal|fad|fa-[a-z0-9-]+)/i.test(classText)) return;
              const glyph = fontAwesomeHelpers.resolveGlyph(style, baseStyle, fontAwesomeHelpers.decodeCssContent(style.content));
              const rect = htmlEl.getBoundingClientRect();
              const fontPx = Math.max(14, Number.parseFloat(style.fontSize || baseStyle.fontSize || parentStyle.fontSize || '') || rect.height || 24);
              const cssSize = Math.min(256, Math.max(64, Math.ceil(Math.max(rect.width || 0, rect.height || 0, fontPx) + 24)));
              if (!glyph || glyph.length > 4) return;
              const canvas = document.createElement('canvas');
              canvas.width = cssSize * 2;
              canvas.height = cssSize * 2;
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              ctx.scale(2, 2);
              ctx.clearRect(0, 0, cssSize, cssSize);
              ctx.fillStyle = style.color || baseStyle.color || '#000';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.font = `${style.fontStyle || baseStyle.fontStyle || 'normal'} ${style.fontWeight || baseStyle.fontWeight || '400'} ${fontPx}px ${family || 'Font Awesome 6 Free, Font Awesome 5 Free, sans-serif'}`;
              ctx.fillText(glyph, cssSize / 2, cssSize / 2);
              imageUrls.add(canvas.toDataURL('image/png'));
              const svgDataUrl = fontAwesomeHelpers.svgDataUrl(glyph, family, fontPx, style.color || baseStyle.color || '#000', cssSize);
              if (svgDataUrl) imageUrls.add(svgDataUrl);
            } catch {
              // Ignore individual icon render failures.
            }
          });
        });
      },
    };

    const LAZY_ATTRS = [
      'data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-image', 'data-img',
      'data-bg', 'data-background', 'data-background-image', 'data-thumb', 'data-thumbnail',
      'data-poster', 'data-hires', 'data-retina', 'data-full', 'data-large', 'data-medium',
      'data-small', 'data-lazyload', 'data-lazy-image', 'data-iesrc',
      'data-src-small', 'data-src-medium', 'data-src-large', 'data-src-retina',
      'data-flickity-lazyload', 'data-url',
    ];
    const SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset'];
    const expand360Sequence = (raw: string | null | undefined, countHint = 0) => {
      const target = _.toAbsolute(String(raw || '').replace(/&amp;/g, '&'));
      if (!target || !/(?:threesixty|360|jellies|vehicle|toyota|lexus|aemassets|assetscs|visualizer)/i.test(target)) return [];
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return [];
      }
      if (parsed.pathname.includes('//')) return [];
      const match =
        parsed.pathname.match(/^(.*\/)(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i) ||
        parsed.pathname.match(/^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
      if (!match) return [];
      const frame = Number(match[2]);
      const parts = match[1].split('/').filter(Boolean);
      const pathCount = Number(parts[parts.length - 1] || 0);
      const hinted = Number(countHint || 0);
      const commonSequenceCounts = new Set([4, 18, 24, 36, 72, 120]);
      const hasExplicitFrameCountPath = Boolean(
        pathCount >= 2 &&
          pathCount <= 120 &&
          ((hinted >= 2 && hinted <= 120 && pathCount === hinted) || commonSequenceCounts.has(pathCount))
      );
      const hasPrefixedFrameName = Boolean(
        /^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i.test(parsed.pathname) &&
          /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(target)
      );
      if (!hasExplicitFrameCountPath && !hasPrefixedFrameName) return [];
      const count = hasExplicitFrameCountPath ? pathCount : Number(countHint || 0);
      if (!Number.isFinite(frame) || frame < 1 || !count || count > 120 || frame > count) return [];
      return Array.from({ length: count }, (_unused, index) => {
        const clone = new URL(parsed.href);
        clone.pathname = `${match[1]}${index + 1}${match[3]}`;
        return clone.href;
      });
    };
    const collect360FromRoot = (root: Element) => {
      const count = Number(
        root.getAttribute('data-image-count') ||
          root.querySelector('[data-image-count]')?.getAttribute('data-image-count') ||
          0
      );
      const candidates: string[] = [];
      root.querySelectorAll('img, source, picture, [src], [srcset], [data-src], [data-srcset], [data-image], [data-lazy-src]').forEach((node) => {
        const anyNode = node as any;
        ['currentSrc', 'src'].forEach((key) => {
          if (anyNode[key]) candidates.push(anyNode[key]);
        });
        ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-image', 'data-url'].forEach((attr) => {
          const value = node.getAttribute(attr);
          if (!value) return;
          String(value).split(',').forEach((part) => candidates.push(part.trim().split(/\s+/)[0]));
        });
      });
      candidates.forEach((candidate) => {
        expand360Sequence(candidate, count).forEach((frameUrl) => _.addImage(frameUrl));
      });
    };
    const collectToyotaColorizerSwatchSequences = (root: Element) => {
      const countHint = Number(
        root.getAttribute('data-image-count') ||
          root.querySelector('[data-image-count]')?.getAttribute('data-image-count') ||
          0
      );
      if (!countHint || countHint > 120) return;
      const activeSwatch = root.querySelector('.color-selector__swatch[data-active="true"][data-model-grade]');
      const activeGrade = String(activeSwatch?.getAttribute('data-model-grade') || '').trim().toLowerCase();
      const activeModel = String(activeSwatch?.getAttribute('data-model-code') || '').trim().toLowerCase();
      const activeYear = String(activeSwatch?.getAttribute('data-model-year') || '').trim();
      const activeColor = String(activeSwatch?.getAttribute('data-color-code') || '').trim().toLowerCase();
      const activeColorName = String(
        activeSwatch?.getAttribute('data-color-name') ||
        activeSwatch?.getAttribute('aria-label') ||
        activeColor
      ).trim();
      if (!activeGrade || !activeColor) return;
      const mediaUrls: string[] = [];
      root.querySelectorAll('.threesixty-media img, .threesixty-media source, .threesixty-media [src], .threesixty-media [srcset]').forEach((node) => {
        const anyNode = node as any;
        ['currentSrc', 'src'].forEach((key) => {
          if (anyNode[key]) mediaUrls.push(anyNode[key]);
        });
        ['src', 'srcset', 'data-src', 'data-srcset'].forEach((attr) => {
          const value = node.getAttribute(attr);
          if (!value) return;
          String(value).split(',').forEach((part) => mediaUrls.push(part.trim().split(/\s+/)[0]));
        });
      });
      const template = mediaUrls
        .map((raw) => _.toAbsolute(raw))
        .filter(Boolean)
        .map((raw) => {
          try {
            const parsed = new URL(String(raw).replace(/&amp;/g, '&'));
            const match = parsed.pathname.replace(/\/{2,}/g, '/').match(/^(.*\/jellies\/max\/(\d{4})\/([^/]+)\/)(?:(?!\d+\/)[^/]+\/)?(\d+)\/([^/]+)\/(\d+)\/(\d+)(\.(?:png|jpe?g|webp|avif))$/i);
            if (!match) return null;
            return {
              href: parsed.href,
              prefix: match[1],
              year: match[2],
              model: match[3],
              style: match[4],
              count: Number(match[6]),
              suffix: match[8],
            };
          } catch {
            return null;
          }
        })
        .find((item) => item && item.count >= 2 && item.count <= 120 && (!activeYear || item.year === activeYear) && (!activeModel || item.model.toLowerCase() === activeModel));
      if (!template) return;
      for (let frame = 1; frame <= template.count; frame += 1) {
        try {
          const clone = new URL(template.href);
          clone.pathname = `${template.prefix}${activeGrade}/${template.style}/${activeColor}/${template.count}/${frame}${template.suffix}`;
          _.addImage(clone.href);
        } catch {
          // Ignore malformed generated frame URLs.
        }
      }
    };

    document.querySelectorAll('img').forEach((img) => {
      const el = img as HTMLImageElement;
      _.addImage(el.currentSrc);
      _.addImage(el.getAttribute('src'));
      LAZY_ATTRS.forEach((attr) => _.addImage(el.getAttribute(attr)));
      SRCSET_ATTRS.forEach((attr) => _.addSrcsetCandidates(el.getAttribute(attr)));
    });

    document.querySelectorAll('picture source, source[srcset], source[src]').forEach((source) => {
      _.addImage(source.getAttribute('src'));
      SRCSET_ATTRS.forEach((attr) => _.addSrcsetCandidates(source.getAttribute(attr)));
    });

    document.querySelectorAll('input[type="image"]').forEach((el) => {
      _.addImage(el.getAttribute('src'));
    });

    document.querySelectorAll('svg image').forEach((el) => {
      _.addImage(el.getAttribute('href'));
      _.addImage(el.getAttribute('xlink:href'));
    });

    document.querySelectorAll('svg use').forEach((el) => {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href');
      if (href && !href.startsWith('#')) _.addImage(href);
    });

    document.querySelectorAll('svg').forEach((svg, index) => {
      _.addInlineSvg(svg as SVGElement, index);
    });
    fontAwesomeHelpers.addFontAwesomePngs();

    document.querySelectorAll('link[rel="preload"][as="image"]').forEach((el) => {
      _.addImage(el.getAttribute('href'));
    });

    document.querySelectorAll('meta[itemprop="image"]').forEach((el) => {
      _.addImage(el.getAttribute('content'));
    });

    document.querySelectorAll('object[type^="image/"], embed[type^="image/"]').forEach((el) => {
      _.addImage(el.getAttribute('data') || el.getAttribute('src'));
    });

    document.querySelectorAll('[data-src], [data-lazy-src], [data-original], [data-bg], [data-background-image], [data-image], [data-thumb]').forEach((el) => {
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        if (!attr.name.startsWith('data-') || !attr.value) continue;
        const lower = attr.name.toLowerCase();
        if (/image|img|photo|thumb|poster|bg|background|src|lazy|icon|avatar|banner|hero/i.test(lower)) {
          if (attr.value.includes(',') && /\d+w|\dx/.test(attr.value)) {
            _.addSrcsetCandidates(attr.value);
          } else {
            _.addImage(attr.value);
          }
        }
      }
    });

    document.querySelectorAll('video').forEach((video) => {
      const poster = _.toAbsolute(video.getAttribute('poster') || '');
      if (poster) _.addImage(poster);
      const src = _.toAbsolute(video.getAttribute('src') || '');
      if (src) {
        videoEntries.push({ url: src, poster, title: video.getAttribute('aria-label') || '' });
      }
      video.querySelectorAll('source').forEach((source) => {
        const sourceUrl = _.toAbsolute(source.getAttribute('src') || '');
        if (sourceUrl) videoEntries.push({ url: sourceUrl, poster, title: '' });
      });
    });

    document.querySelectorAll('iframe, embed').forEach((frame) => {
      const src = _.toAbsolute(frame.getAttribute('src') || frame.getAttribute('data-src') || '');
      if (!src) return;
      if (/vimeo\.com|youtube\.com|youtu\.be|player\.vimeo|brightcove|jwplayer/i.test(src)) {
        videoEntries.push({
          url: src,
          poster: '',
          title: frame.getAttribute('title') || frame.getAttribute('aria-label') || '',
        });
      }
    });

    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = _.toAbsolute(anchor.getAttribute('href') || '');
      if (!href) return;
      if (/vimeo\.com\/\d+/i.test(href) || /\/video\/\d+/i.test(href)) {
        const img = anchor.querySelector('img');
        videoEntries.push({
          url: href,
          poster: img ? _.toAbsolute((img as HTMLImageElement).currentSrc || img.getAttribute('src') || '') : '',
          title: anchor.getAttribute('aria-label') || anchor.textContent?.trim().slice(0, 120) || '',
        });
      }
    });

    document.querySelectorAll('body *').forEach((el) => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === 'none') return;
      const matches = bg.match(/url\(([^)]+)\)/g) || [];
      matches.forEach((match) => {
        const inner = /url\(["']?([^"')]+)["']?\)/.exec(match);
        if (inner?.[1]) _.addImage(inner[1]);
      });
    });

    document.querySelectorAll('style').forEach((styleEl) => {
      const cssText = styleEl.textContent || '';
      const bgRegex = /background-image\s*:\s*url\(([^)]+)\)/gi;
      let match: RegExpExecArray | null;
      while ((match = bgRegex.exec(cssText)) !== null) {
        _.addImage(match[1].replace(/^["']|["']$/g, ''));
      }
    });

    document.querySelectorAll('[data-image-count], .threesixty, [class*="threesixty"], [class*="360"]').forEach((root) => {
      collect360FromRoot(root);
    });
    document.querySelectorAll('.colorizer, [class*="colorizer"]').forEach((root) => {
      collectToyotaColorizerSwatchSequences(root);
    });
    Array.from(performance.getEntriesByType('resource') || []).forEach((entry) => {
      expand360Sequence((entry as PerformanceResourceTiming).name, 0).forEach((frameUrl) => _.addImage(frameUrl));
    });

    Array.from(document.styleSheets).forEach((sheet) => {
      const href = _.toAbsolute(sheet.href || '');
      if (href) stylesheetUrls.add(href);
      try {
        Array.from(sheet.cssRules || []).forEach((rule) => {
          const cssText = String(rule.cssText || '');
          if (/^@font-face\b/i.test(cssText)) fontFaceCss.push(cssText);
        });
      } catch {
        // Cross-origin stylesheet rules are inaccessible, but their href is still collected above.
      }
    });

    document.querySelectorAll('body *').forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const style = window.getComputedStyle(el);
      const family = String(style.fontFamily || '').split(',')[0]?.replace(/^["']|["']$/g, '').trim();
      if (family && family !== 'inherit') fontFamilies.add(family);
      if (family && family !== 'inherit') {
        const payload = {
          family,
          weight: style.fontWeight || '400',
          style: style.fontStyle || 'normal',
        };
        const key = JSON.stringify(payload);
        if (!computedFontKeys.has(key)) {
          computedFontKeys.add(key);
          computedFonts.push(payload);
        }
      }
    });

    return {
      images: Array.from(imageUrls),
      videos: videoEntries,
      fontFamilies: Array.from(fontFamilies).slice(0, 48),
      computedFonts: computedFonts.slice(0, 96),
      stylesheetUrls: Array.from(stylesheetUrls).slice(0, 96),
      fontFaceCss: fontFaceCss.slice(0, 256),
    };
  });

const isRichStaticExtract = (assets: {
  images?: any[];
  fonts?: any[];
  videos?: any[];
}) => {
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const videoCount = assets?.videos?.length || 0;
  if (videoCount > 0) return true;
  if (imageCount >= 4 || fontCount >= 3) return true;
  if (imageCount + fontCount >= 6) return true;
  return false;
};

const isUsableStaticExtract = (assets: {
  images?: any[];
  fonts?: any[];
  videos?: any[];
  colors?: string[];
}) => {
  if (isRichStaticExtract(assets)) return true;
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const colorCount = assets?.colors?.length || 0;
  if (imageCount >= 1 && (fontCount >= 1 || colorCount >= 1)) return true;
  return imageCount >= 4;
};

const isStrongStaticExtractForImmediateReturn = (
  assets: {
    images?: any[];
    fonts?: any[];
    videos?: any[];
    colors?: string[];
  },
  options: { videosOnly?: boolean } = {}
) => {
  if (options.videosOnly) return false;
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const videoCount = assets?.videos?.length || 0;
  if (videoCount > 0) return true;
  if (imageCount >= 12) return true;
  return imageCount >= 8 && fontCount >= 2;
};

const warmExtractedAssetList = async (
  images: any[],
  fonts: any[],
  limits: { imageLimit: number; fontLimit: number; budgetMs: number },
  pageUrl = ''
) => {
  const started = Date.now();
  const imageWarmPriority = (img: any) => {
    const url = String(img?.url || '');
    if (url.startsWith('data:')) return 0;
    if (String(img?.source || '').includes('360-sequence') || isLikely360SequenceUrl(url)) return 6;
    if (/\.(?:jpe?g|png|webp|gif|avif)(\?|$)/i.test(url)) return 3;
    if (/\/wp-content\/uploads\//i.test(url)) return 2;
    return 1;
  };
  const prioritizedImages = [...images]
    .sort((a, b) => imageWarmPriority(b) - imageWarmPriority(a))
    .slice(0, limits.imageLimit);
  const fontsToWarm = fonts.slice(0, limits.fontLimit);

  await mapWithConcurrency(prioritizedImages, 12, async (img: any) => {
    if (Date.now() - started > limits.budgetMs) return;
    const url = String(img?.url || '');
    if (!url || url.startsWith('data:')) return;
    try {
      assertPublicAssetUrl(url);
      const warmed = await withTimeout(
        warmCachedOriginalAssetForExtraction(
          url,
          'image',
          inferImageTypeFromUrl(url, String(img?.type || '')) || getAssetTypeFromUrl(url, img?.type || 'bin'),
          { refererPageUrl: pageUrl }
        ),
        12000,
        `Extract image cache for ${url}`
      );
      if (warmed?.ok && warmed.cachedUrl) {
        img.cachedUrl = warmed.cachedUrl;
        img.status = 'downloaded';
        if (warmed.bytes) img.bytes = warmed.bytes;
        if (warmed.width) img.width = warmed.width;
        if (warmed.height) img.height = warmed.height;
        if (/\.(?:webp|avif)(?:[?#]|$)/i.test(url)) {
          void warmRasterConversionVariants(url, warmed.cachedUrl).catch(() => undefined);
        }
      }
    } catch {
      // Best-effort cache warm.
    }
  });

  await mapWithConcurrency(fontsToWarm, 10, async (font: any) => {
    if (Date.now() - started > limits.budgetMs) return;
    const url = String(font?.url || '');
    if (!url || url.startsWith('data:')) return;
    const existing = await readExistingOriginalAssetUrl(url, 'font');
    if (existing) {
      await withTimeout(
        warmFontConversionVariants(url, existing, String(font?.format || 'woff2'), {
          cssSource: String(font?.cssSource || ''),
          refererPageUrl: String(pageUrl || ''),
        }),
        20000,
        `Font warm for ${url}`
      ).catch(() => undefined);
      return;
    }
    try {
      assertPublicAssetUrl(url);
      await withTimeout(
        warmCachedOriginalAssetForExtraction(
          url,
          'font',
          getFontFormatFromUrlOrType(url, String(font?.format || 'woff2')),
          {
            preferredBase: buildFontDisplayName(font) || undefined,
            metadataFilename: buildFontDisplayName(font) || undefined,
            refererPageUrl: resolveFontRefererPage(String(font?.cssSource || ''), String(pageUrl || '')) || undefined,
          }
        ),
        25000,
        `Extract font cache for ${url}`
      );
    } catch {
      // Best-effort cache warm.
    }
  });
};

const warmExtractedAssetsInBackground = (images: any[], fonts: any[], pageUrl = '') => {
  setImmediate(() => {
    void (async () => {
      const imageWarmPriority = (img: any) => {
        const url = String(img?.url || '');
        if (url.startsWith('data:')) return 0;
        if (/\.(?:jpe?g|png|webp|gif|avif)(\?|$)/i.test(url)) return 3;
        if (/\/wp-content\/uploads\//i.test(url)) return 2;
        return 1;
      };
      const prioritizedImages = [...images].sort((a, b) => imageWarmPriority(b) - imageWarmPriority(a)).slice(0, 120);
      const fontsToWarm = fonts.slice(0, 80);
      await mapWithConcurrency(prioritizedImages, 8, async (img: any) => {
        const url = String(img?.url || '');
        if (!url || url.startsWith('data:')) return;
        const existing = await readExistingOriginalAssetUrl(url, 'image');
        if (existing) {
          if (/\.(?:webp|avif)(?:[?#]|$)/i.test(url)) {
            void warmRasterConversionVariants(url, existing).catch(() => undefined);
          }
          return;
        }
        try {
          assertPublicAssetUrl(url);
          await withTimeout(
            warmCachedOriginalAssetForExtraction(
              url,
              'image',
              inferImageTypeFromUrl(url, String(img?.type || '')) || getAssetTypeFromUrl(url, img?.type || 'bin'),
              { refererPageUrl: pageUrl }
            ),
            4500,
            `Background image warm for ${url}`
          );
        } catch {
          // Best-effort background warming only.
        }
      });
      await mapWithConcurrency(fontsToWarm, 8, async (font: any) => {
        const url = String(font?.url || '');
        if (!url || url.startsWith('data:')) return;
        const existing = await readExistingOriginalAssetUrl(url, 'font');
        if (existing) {
          void warmFontConversionVariants(url, existing, String(font?.format || 'woff2'), {
            cssSource: String(font?.cssSource || ''),
            refererPageUrl: String(lastExtractedSourceUrl || ''),
          }).catch(() => undefined);
          return;
        }
        try {
          assertPublicAssetUrl(url);
          await withTimeout(
            warmCachedOriginalAssetForExtraction(
              url,
              'font',
              getFontFormatFromUrlOrType(url, String(font?.format || 'bin')),
              {
                preferredBase: buildFontDisplayName(font) || undefined,
                metadataFilename: buildFontDisplayName(font) || undefined,
                refererPageUrl:
                  resolveFontRefererPage(String(font?.cssSource || ''), String(lastExtractedSourceUrl || '')) ||
                  undefined,
              }
            ),
            20000,
            `Background font warm for ${url}`
          );
        } catch {
          // Best-effort background warming only.
        }
      });
    })().catch(() => undefined);
  });
};

const filterUnavailableSitecoreFonts = async (fonts: any[], pageUrl = '') => {
  const referer = resolveFontRefererPage('', pageUrl);
  const results = await mapWithConcurrency(fonts, 10, async (font) => {
    const url = String(font?.url || '');
    if (!url || url.startsWith('data:') || /fonts\.gstatic\.com/i.test(url)) return font;
    if (!/\/-\/media\/.*\/fonts\//i.test(url)) return font;
    const probed = await fetchRemoteFontBufferViaCurl(url, referer);
    return probed ? font : null;
  });
  return results
    .filter(Boolean)
    .sort((a, b) => {
      const familyA = buildFontDisplayName(a) || a.family || '';
      const familyB = buildFontDisplayName(b) || b.family || '';
      return familyA.localeCompare(familyB);
    });
};

const isLikelyEncodedVideoPlaceholderTitle = (value = '') =>
  /^[A-Za-z0-9+/_=-]{24,}\.*$/.test(String(value || '').trim()) && !/\s/.test(String(value || '').trim());

const isDirectVideoCandidateUrl = (rawUrl = '') =>
  /\.(?:mp4|webm|mov|mkv|m4v|m3u8|mpd)(?:[?#]|$)/i.test(String(rawUrl || '')) ||
  /\/(?:videoplayback|progressive_redirect\/download)\b|vimeocdn\.com|vod-adaptive\.akamaized\.net|wistia\.com\/deliveries\//i.test(String(rawUrl || ''));

const isLikelyBlankEmbeddedVideoCard = (video: any, targetUrl = '') => {
  const candidates = [
    video?.url,
    video?.sourceStreamUrl,
    video?.downloadUrl,
    video?.originalUrl,
    video?.embedUrl,
    video?.sourceUrl,
    video?.pageUrl,
    targetUrl,
  ].map((candidate) => String(candidate || '').trim()).filter(Boolean);
  if (candidates.some(isWistiaHelperResourceUrl)) return true;
  if (
    candidates.some((candidate) => /(?:wistia\.com|wistia\.net)\/deliveries\//i.test(candidate)) &&
    !video?.isWistiaDirect &&
    !video?.height &&
    !video?.width &&
    !/\b(?:mp4|m3u8|hls)\b/i.test(String(video?.type || video?.format || video?.resolution || ''))
  ) {
    return true;
  }
  if (candidates.some(isDirectVideoCandidateUrl)) return false;
  const title = String(video?.title || video?.name || video?.label || '').trim();
  const hasPreview = /^https?:\/\//i.test(String(video?.thumbnail || video?.poster || '').trim());
  if (hasPreview) return false;
  const hasHttpCandidate = candidates.some((candidate) => /^https?:\/\//i.test(candidate));
  if (!hasHttpCandidate) return true;
  if (isLikelyEncodedVideoPlaceholderTitle(title)) return true;
  return /(?:embedded\s+player|video\s+player)/i.test(String(video?.type || video?.provider || video?.label || '')) &&
    !candidates.some((candidate) => /youtube\.com|youtu\.be|vimeo\.com|wistia\.com|brightcove|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com/i.test(candidate));
};

const dedupeExtractedAssets = async (
  images: any[],
  videos: any[],
  fonts: any[],
  colors: string[],
  targetUrl: string,
  fallbackThumb = '',
  options: {
    fast?: boolean;
    videosOnly?: boolean;
    extraIcons?: any[];
    sectionMode?: boolean;
    sectionLabel?: string;
    sectionSelector?: string;
  } = {}
) => {
  const normalizedTargetImageUrl = (() => {
    try {
      const parsed = new URL(targetUrl);
      parsed.hash = '';
      return parsed.href.replace(/\/+$/, '');
    } catch {
      return String(targetUrl || '').replace(/[#?].*$/, '').replace(/\/+$/, '');
    }
  })();
  const isUsableExtractedImage = (img: any) => {
    const url = String(img?.url || '').trim();
    if (!url || isBotWallImageUrl(url) || isJunkImageUrl(url)) return false;
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      if (parsed.href.replace(/\/+$/, '') === normalizedTargetImageUrl) return false;
    } catch {
      // Non-URL image candidates are handled by the normal image URL checks.
    }
    return true;
  };
  const iconPool = [...(options.extraIcons || []), ...images.filter((item) => classifyAssetIconCandidate(item))];
  const baseImages = await repairMalformedToyotaCountedSequences(
    images.filter((item) => !classifyAssetIconCandidate(item)),
    targetUrl,
  );
  const hasTrustedToyotaSequence =
    shouldSuppressToyotaSequenceAutoExpansion(targetUrl) &&
    baseImages.some((item) => {
      const source = String(item?.source || '').trim();
      const count = Number(item?.sequenceCount || 0);
      return source.includes('360-sequence') && count >= 8;
    });
  let imagePool = hasTrustedToyotaSequence
    ? baseImages
    : await expandAvailableImageSequences(baseImages, targetUrl);
  imagePool = await filterUnavailableGeneratedImageSequences(imagePool, targetUrl);
  imagePool = keepBestToyotaSequenceGroup(imagePool, targetUrl);
  const uniqueIcons = dedupeImagesByCanonicalKey(
    Array.from(new Set(iconPool.map((item) => item.url)))
      .map((url) => iconPool.find((item) => item.url === url))
      .filter(Boolean)
      .filter(isUsableExtractedImage)
  );
  const uniqueImages = dedupeImagesByCanonicalKey(
    Array.from(new Set(imagePool.map((item) => item.url)))
      .map((url) => imagePool.find((item) => item.url === url))
      .filter(Boolean)
      .filter(isUsableExtractedImage)
  );

  const videoKey = (video: any) => {
    const raw = String(video?.url || video?.sourceStreamUrl || video?.sourceUrl || '');
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (host.includes('vimeo.com')) {
        const idMatch =
          parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/) ||
          parsed.pathname.match(/\/video\/(\d+)/) ||
          parsed.pathname.match(/\/videos\/(\d+)/) ||
          parsed.pathname.match(/^\/(\d+)/);
        if (idMatch?.[1]) {
          return `vimeo:${idMatch[1]}`;
        }
      }
      if (host.includes('brightcove.net')) {
        const brightcove = parseBrightcovePlayerUrl(parsed.href);
        return `brightcove:${brightcove?.accountId || host}:${brightcove?.videoId || parsed.pathname}:${video?.height || video?.displayQualityKey || video?.qualityRequested || 'stream'}`;
      }
      if (host.includes('wistia.com') || host.includes('wistia.net')) {
        const idMatch = parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
        const wistiaId = video?.wistiaHashedId || idMatch?.[1];
        if (wistiaId) {
          if (video?.isWistiaDirect || video?.height) {
            return `wistia:${wistiaId}:${video?.height || 'h'}`;
          }
          return `wistia:${wistiaId}`;
        }
        if (parsed.pathname.includes('/deliveries/')) {
          const deliveryId = parsed.pathname.split('/deliveries/')[1]?.split(/[/?#]/)[0] || parsed.pathname;
          return `wistia-delivery:${deliveryId}:${video?.height || 'stream'}`;
        }
      }
      parsed.hash = '';
      parsed.searchParams.sort();
      return parsed.toString();
    } catch {
      return raw;
    }
  };

  const videoRank = (video: any) => {
    const raw = String(video?.url || '');
    if (video?.isVimeoDirect || video?.isYouTubeDirect || video?.isWistiaDirect || video?.isDirect) return 4;
    if (isLikelyDirectVideoStreamUrl(raw)) return 3;
    if (isPlatformVideoUrl(raw)) return 2;
    return 1;
  };

  const videoByKey = new Map<string, any>();
  collapseVimeoVideosForClient(videos).forEach((video) => {
    if (!video?.url) return;
    if (isLikelyBlankEmbeddedVideoCard(video, targetUrl)) return;
    if (isUnsupportedVideoResourceUrl(String(video.url || video.sourceStreamUrl || video.sourceUrl || ''))) return;
    const sanitized = sanitizeVideoForClient(video, targetUrl);
    if (!sanitized?.url) return;
    if (isLikelyBlankEmbeddedVideoCard(sanitized, targetUrl)) return;
    if (isUnsupportedVideoResourceUrl(String(sanitized.url || sanitized.sourceStreamUrl || sanitized.sourceUrl || ''))) return;
    const key = videoKey(sanitized);
    const normalizedVideo = !sanitized.thumbnail && fallbackThumb ? { ...sanitized, thumbnail: fallbackThumb } : sanitized;
    const current = videoByKey.get(key);
    if (!current || videoRank(normalizedVideo) > videoRank(current)) {
      videoByKey.set(key, normalizedVideo);
    }
  });

  const uniqueVideos = await prepareVisibleVideoStreams(
    attachYouTubeWatchUrlToVideos(Array.from(videoByKey.values())),
    targetUrl
  );
  const videosWithThumbnailFallback = uniqueVideos.map((video: any) => {
    if (String(video?.thumbnail || video?.poster || '').trim()) return video;
    const streamUrl = String(
      video?.sourceStreamUrl ||
      video?.brightcoveManifestUrl ||
      video?.url ||
      ''
    ).trim();
    if (!/^https?:\/\//i.test(streamUrl) || !isLikelyHttpMediaUrl(streamUrl)) return video;
    const thumbnail = `/api/video-frame-thumbnail?url=${encodeURIComponent(streamUrl)}&sourcePageUrl=${encodeURIComponent(targetUrl)}`;
    return { ...video, thumbnail, thumbnailGenerated: true };
  });
  const metadataFonts = await enrichFontsWithMetadata(fonts, targetUrl, { fast: options.fast });
  let uniqueFonts = dedupeFontsByLogicalKey(
    Array.from(new Set(metadataFonts.map((font) => font.url)))
      .map((url) => pickBestFontForUrl(metadataFonts, url))
      .filter(Boolean)
      .filter(isSupportedFontAsset)
  );
  if (!options.fast && uniqueFonts.length > 0 && uniqueFonts.length <= 12) {
    uniqueFonts = await filterUnavailableSitecoreFonts(uniqueFonts, targetUrl);
  } else if (uniqueFonts.length > 0) {
    void filterUnavailableSitecoreFonts(uniqueFonts, targetUrl).catch(() => undefined);
  }
  const uniqueColors = getPrimaryExtractedColors(colors);

  if (options.videosOnly) {
    return {
      images: [],
      videos: videosWithThumbnailFallback,
      fonts: [],
      colors: [],
      ...(options.sectionMode
        ? {
            sectionMode: true,
            sectionLabel: options.sectionLabel || '',
            sectionSelector: options.sectionSelector || '',
          }
        : {}),
    };
  }

  if (options.fast) {
    // Skip cache checks if we're running low on time - return assets immediately
    if (uniqueImages.length > 0) {
      await Promise.race([
        Promise.all(
          uniqueImages.slice(0, 64).map(async (img: any) => {
            const assetUrl = String(img?.url || '');
            if (!assetUrl || assetUrl.startsWith('data:')) return;
            const existing = await readExistingOriginalAssetUrl(assetUrl, 'image');
            if (existing) {
              img.cachedUrl = existing;
              img.status = 'downloaded';
            }
          })
        ),
        new Promise(r => setTimeout(r, 3000)) // Max 3 seconds for cache checks
      ]).catch(() => {
        // Timeout or error - just proceed without cache data
      });
    }
    warmExtractedAssetsInBackground(uniqueImages as any[], uniqueFonts as any[], targetUrl);
  } else {
    const fontLimit = Math.min(uniqueFonts.length, 80);
    // Image previews should behave like extract.pics: return discovered URLs quickly
    // and let browser-native image loading show cards immediately. Heavy cache warm
    // work can make Toyota-style 360 galleries feel stuck, so only fonts are warmed
    // synchronously; images warm in the background for downloads.
    await warmExtractedAssetList([], uniqueFonts as any[], {
      imageLimit: 0,
      fontLimit,
      budgetMs: Math.min(30000, 8000 + fontLimit * 200),
    }, targetUrl);
    warmExtractedAssetsInBackground(
      uniqueImages as any[],
      uniqueFonts.slice(fontLimit) as any[],
      targetUrl
    );
  }

  const attachCachedUrl = async (asset: any, kind: 'image' | 'font') => {
    const url = String(asset?.url || '');
    if (!url || url.startsWith('data:')) return withAssetStatus(asset);
    let cachedUrl = await readExistingOriginalAssetUrl(url, kind);
    let enriched = asset;

    // Do not fetch remote images here. Returning hundreds of image cards must
    // stay instant; individual/ZIP downloads fetch and cache on demand.

    if (cachedUrl && kind === 'image') {
      const cachedBuffer =
        (await readAssetBufferFromCache(url, 'image')) ||
        (await readAssetBufferFromCache(cachedUrl, 'image'));
      if (cachedBuffer) {
        const detected = detectRasterFormatFromBuffer(cachedBuffer.buffer);
        enriched = enrichImageAssetMeta(
          detected === 'webp' || detected === 'avif'
            ? {
                ...enriched,
                type: detected,
                mimeType: cachedBuffer.contentType || (detected === 'webp' ? 'image/webp' : 'image/avif'),
              }
            : enriched,
          cachedBuffer.buffer,
          cachedBuffer.contentType
        );
      } else {
        enriched = enrichImageAssetMeta(enriched);
      }
      void warmRasterConversionVariants(url, cachedUrl).catch(() => undefined);
    }
    if (cachedUrl && kind === 'font') {
      void warmFontConversionVariants(url, cachedUrl, String(asset?.format || 'unknown'), {
        cssSource: String(asset?.cssSource || ''),
        refererPageUrl: String(targetUrl || ''),
      }).catch(() => undefined);
    }
    return withAssetStatus(cachedUrl ? { ...enriched, cachedUrl } : enriched);
  };

  const fallbackImages = uniqueImages.map((img) => withAssetStatus(enrichImageAssetMeta(img)));
  const fallbackIcons = uniqueIcons.map((img) => withAssetStatus(enrichImageAssetMeta(img)));
  const fallbackFonts = uniqueFonts.map((font) => withAssetStatus(font));
  const resultImages = (
    await Promise.race<any[]>([
      Promise.all(uniqueImages.map((img) => attachCachedUrl(enrichImageAssetMeta(img), 'image'))),
      options.fast
        ? new Promise<any[]>((resolve) => setTimeout(() => resolve(fallbackImages), 2000))
        : new Promise<any[]>(() => {})
    ]).catch(() => fallbackImages)
  )
    .sort((a, b) => {
      const rank = (item: any) =>
        item?.cachedUrl || item?.status === 'downloaded' ? 0 :
        item?.status === 'path-only' ? 1 :
        2;
      return rank(a) - rank(b);
    });
  const resultIcons = (
    await Promise.race<any[]>([
      Promise.all(uniqueIcons.map((img) => attachCachedUrl(enrichImageAssetMeta(img), 'image'))),
      options.fast
        ? new Promise<any[]>((resolve) => setTimeout(() => resolve(fallbackIcons), 1000))
        : new Promise<any[]>(() => {})
    ]).catch(() => fallbackIcons)
  ).sort((a, b) => String(a?.url || '').localeCompare(String(b?.url || '')));
  const resultVideos = videosWithThumbnailFallback.map((video) => withAssetStatus(video));
  const resultFonts = await Promise.race<any[]>([
    Promise.all(uniqueFonts.map((font) => attachCachedUrl(font, 'font'))),
    options.fast
      ? new Promise<any[]>((resolve) => setTimeout(() => resolve(fallbackFonts), 1000))
      : new Promise<any[]>(() => {})
  ]).catch(() => fallbackFonts);

  return {
    // Keep icons in their dedicated collection for category-aware clients, but
    // also include them in the primary image list. Packaged/background extract
    // completion historically merged only `images`, which caused discovered SVG
    // sprite symbols to disappear even though extraction had found them.
    images: Array.from(
      new Map([...resultImages, ...resultIcons].map((item) => [String(item?.url || ''), item])).values()
    ).filter((item) => item?.url),
    icons: resultIcons,
    videos: resultVideos,
    fonts: resultFonts,
    colors: uniqueColors,
    ...(options.sectionMode
      ? {
          extractionMeta: {
            mode: 'section',
            sectionLabel: options.sectionLabel || '',
            sectionSelector: options.sectionSelector || '',
          },
        }
      : {}),
  };
};

const enrichAssetsFromHtml = async (
  html: string,
  targetUrl: string,
  assets: {
    images: any[];
    videos: any[];
    fonts: any[];
    colors: string[];
    vimeoCandidateUrls: Set<string>;
    wistiaCandidateIds: Set<string>;
  },
  options: { fast?: boolean; videosOnly?: boolean } = {}
) => {
  const $ = cheerio.load(html);
  const pagePrimaryThumb =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    '';
  const resolvedPagePrimaryThumb = pagePrimaryThumb ? resolveUrl(targetUrl, pagePrimaryThumb) || pagePrimaryThumb : '';
  const pageTitle =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text().trim() ||
    'Video link';

  extractVimeoUrlsFromText(html, targetUrl).forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
  extractWistiaIdsFromText(`${targetUrl}\n${html}`, targetUrl).forEach((wistiaId) => assets.wistiaCandidateIds.add(wistiaId));

  if (!options.videosOnly) {
    assets.images.push(...extractImagesFromDom($, targetUrl));
    assets.images.push(...extractImagesFromHtmlString(html, targetUrl));
  }
  const rawAssets = extractAssetsFromRawText(html, targetUrl);
  if (!options.videosOnly) {
    assets.images.push(...rawAssets.images);
    assets.fonts.push(...rawAssets.fonts);
  }
  assets.videos.push(...rawAssets.videos);

  const addVideoCandidate = (urlStr: string | undefined, poster?: string, title?: string) => {
    if (!urlStr) return;
    const normalizedRaw = String(urlStr).trim().replace(/ /g, '%20');
    const absoluteUrl = sanitizeStreamUrl(normalizedRaw, targetUrl);
    if (!absoluteUrl || absoluteUrl.startsWith('data:')) return;
    if (!isLikelyVideoAssetUrl(absoluteUrl) && !isPlatformVideoUrl(absoluteUrl)) return;
    assets.videos.push({
      url: absoluteUrl,
      sourceUrl: targetUrl,
      provider: platformProviderFromUrl(absoluteUrl),
      type: isPlatformVideoUrl(absoluteUrl) ? 'video' : getAssetTypeFromUrl(absoluteUrl, 'video'),
      title: title || pageTitle,
      thumbnail: poster ? resolveUrl(targetUrl, poster) || poster : resolvedPagePrimaryThumb,
      status: DEFAULT_ASSET_STATUS,
    });
  };

  $('video source, video').each((_, el) => {
    const poster = $(el).attr('poster');
    addVideoCandidate($(el).attr('src'), poster);
    $(el).find('source').each((__, sourceEl) => addVideoCandidate($(sourceEl).attr('src'), poster));
  });

  const htmlVideoUrlRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#\s"'<>\\])(?:[?#][^\s"'<>\\]*)?/gi;
  const htmlVideoUrlRegexLoose = /https?:\/\/[^"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'<>\\])(?:[?#][^"'<>\\]*)?/gi;
  // Some sites embed large JSON strings with lots of escaping (e.g. \"), so strip backslashes for URL discovery.
  // Also normalize spaces so URLs survive parsing.
  const videoSearchText = html.replace(/\\/g, '');
  (videoSearchText.match(htmlVideoUrlRegex) || []).forEach((match) => addVideoCandidate(match));
  (videoSearchText.match(htmlVideoUrlRegexLoose) || []).forEach((match) => addVideoCandidate(match));
  extractYouTubeUrlsFromText(html, targetUrl).forEach((youtubeUrl) => addVideoCandidate(youtubeUrl));
  $('iframe[src], iframe[data-src], embed[src]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!/youtube|youtu\.be|vimeo|wistia|brightcove|vidyard|loom|\.mp4|\.webm|\.m3u8/i.test(src)) return;
    const absolute = resolveUrl(targetUrl, src) || src;
    if (/vimeo\.com/i.test(absolute)) {
      extractVimeoUrlsFromText(absolute, targetUrl).forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
      return;
    }
    addVideoCandidate(absolute, '', pageTitle);
  });
  extractBrightcoveVideosFromHtml(html, targetUrl).forEach((brightcoveVideo) => {
    assets.videos.push({
      ...brightcoveVideo,
      thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb,
    });
  });

  if (!options.fast) {
    try {
      const deepVideoCandidates = await withTimeout(
        discoverSiteVideoCandidates(targetUrl, html),
        10000,
        `Deep video crawl for ${targetUrl}`
      );
      deepVideoCandidates.vimeoUrls.forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
      (deepVideoCandidates.wistiaIds || []).forEach((wistiaId: string) => assets.wistiaCandidateIds.add(wistiaId));
      deepVideoCandidates.videoUrls.forEach((videoUrl) => addVideoCandidate(videoUrl));
      (deepVideoCandidates.brightcoveVideos || []).forEach((brightcoveVideo: any) => {
        assets.videos.push({
          ...brightcoveVideo,
          thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb,
        });
      });
    } catch (error: any) {
      console.warn('Deep video crawl failed:', error?.message || error);
    }
  }

  if (!options.videosOnly) {
    $('style').each((_, el) => {
      const cssText = $(el).html();
      if (!cssText) return;
      assets.fonts.push(...extractFontsFromCss(cssText, targetUrl));
      assets.colors.push(...extractColorsFromCss(cssText));
    });

    $('[fill], [stroke], [color], [bgcolor]').each((_, el) => {
      const addColor = (value: string | undefined) => {
        if (!value || value === 'none' || value === 'transparent' || value.startsWith('url(') || value.startsWith('var(')) return;
        if (value.startsWith('#') || value.startsWith('rgb') || value.startsWith('hsl') || /^[a-zA-Z]+$/.test(value)) {
          assets.colors.push(value.toLowerCase().replace(/\s+/g, ''));
        }
      };
      addColor($(el).attr('fill'));
      addColor($(el).attr('stroke'));
      addColor($(el).attr('color'));
      addColor($(el).attr('bgcolor'));
    });

    $('link[rel="preload"][as="font"], link[as="font"], link[href*=".woff"], link[href*=".woff2"], link[href*=".ttf"], link[href*=".otf"], link[href*=".eot"]').each((_, el) => {
      const href = $(el).attr('href');
      const abs = href ? resolveUrl(targetUrl, href) : null;
      if (abs && !abs.startsWith('data:') && isSupportedFontAsset({ url: abs, format: getAssetTypeFromUrl(abs, 'unknown') })) {
        assets.fonts.push({
          family: '',
          url: abs,
          format: getAssetTypeFromUrl(abs, 'unknown'),
          status: DEFAULT_ASSET_STATUS,
        });
      }
    });
  }

  return { resolvedPagePrimaryThumb, pageTitle };
};

const extractStaticAssets = async (targetUrl: string, preloadedHtml = '', options: { fast?: boolean; videosOnly?: boolean } = {}) => {
  const images: any[] = [];
  const videos: any[] = [];
  let fonts: any[] = [];
  let colors: string[] = [];
  const vimeoCandidateUrls = new Set<string>();
  const wistiaCandidateIds = new Set<string>();
  extractWistiaIdsFromText(targetUrl, targetUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));

  const html = preloadedHtml || await withTimeout(fetchSiteHtml(targetUrl), 28000, `Static HTML fetch for ${targetUrl}`).catch(() => '');
  if (!html) {
    return extractReaderFallbackAssets(targetUrl, { videosOnly: options.videosOnly });
  }
  if (htmlLooksLikeBotWall(html)) {
    return extractReaderFallbackAssets(targetUrl, { videosOnly: options.videosOnly });
  }
  const { resolvedPagePrimaryThumb } = await enrichAssetsFromHtml(html, targetUrl, {
    images,
    videos,
    fonts,
    colors,
    vimeoCandidateUrls,
    wistiaCandidateIds,
  }, { fast: options.fast, videosOnly: options.videosOnly });
  if (!options.videosOnly) {
    fonts.push(...recoverKnownThemeFontCandidates(html, targetUrl));
  }

  if (!options.videosOnly && html) {
    const providerFonts = await withTimeout(
      fetchImportedFontProviderFonts(targetUrl, html),
      options.fast ? 18000 : 30000,
      `Font provider scan for ${targetUrl}`
    ).catch(() => []);
    fonts.push(...providerFonts);
  }

  const htmlVideoPlayers = html ? buildWebsiteVideoPlayersFromHtml(html, targetUrl) : [];
  if (htmlVideoPlayers.length > 0) {
    htmlVideoPlayers.forEach((player) => {
      const normalized = normalizeVimeoUrl(String(player.url || ''));
      if (normalized) vimeoCandidateUrls.add(normalized);
    });
    videos.push(...htmlVideoPlayers);
  }

  // Fallback: some Next.js sites embed media URLs inside escaped JSON strings in the HTML payload.
  // Example (Qfitlia): \"videoUrl\":\"https://.../Qfitlia PFP Promo Video.m3u8\"
  // If the DOM-based scan doesn't find anything, scan a lightly-unescaped version of the HTML.
  if (videos.length === 0) {
    const addStaticVideoUrl = (rawUrl: string) => {
      const normalized = String(rawUrl || '').trim().replace(/\\/g, '').replace(/ /g, '%20');
      if (!normalized || normalized.startsWith('data:') || normalized.startsWith('blob:')) return;
      const absoluteUrl = sanitizeStreamUrl(normalized, targetUrl) || encodeURI(normalized);
      if (!absoluteUrl || absoluteUrl.startsWith('data:') || absoluteUrl.startsWith('blob:')) return;
      videos.push({
        url: absoluteUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(absoluteUrl),
        type: isPlatformVideoUrl(absoluteUrl) ? 'video' : getAssetTypeFromUrl(absoluteUrl, 'video'),
        title: 'Video',
        thumbnail: resolvedPagePrimaryThumb,
      });
    };

    // 1) Look for explicit \"videoUrl\":\"...\" occurrences in escaped JSON blobs.
    const escapedVideoUrlRegex = /\\"videoUrl\\":\\"([^"]+\.(?:m3u8|mpd|mp4)[^"]*)\\"/gi;
    let match: RegExpExecArray | null;
    while ((match = escapedVideoUrlRegex.exec(html)) !== null) {
      addStaticVideoUrl(match[1]);
    }

    // 1b) Same field but unescaped (some responses include raw JSON segments).
    const plainVideoUrlRegex = /"videoUrl"\s*:\s*"([^"]+\.(?:m3u8|mpd|mp4)[^"]*)"/gi;
    while ((match = plainVideoUrlRegex.exec(html)) !== null) {
      addStaticVideoUrl(match[1]);
    }

    // 1c) Extremely common variant in embedded JSON blobs: videoUrl":"<url>"
    // Keep this intentionally permissive for sites like qfitlia.com.
    const simpleVideoUrlMatch = html.match(/videoUrl"\s*:\s*"(https?:\/\/[^"]+)"/i) || html.match(/videoUrl":"(https?:\/\/[^"]+)"/i);
    if (simpleVideoUrlMatch?.[1]) {
      addStaticVideoUrl(simpleVideoUrlMatch[1]);
    }

    // 2) Generic URL scan over lightly-unescaped HTML.
    const videoSearchText = html.replace(/\\/g, '');
    const candidateRegex = /https?:\/\/[^"'<>]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'<>])(?:[?#][^"'<>]*)?/gi;
    (videoSearchText.match(candidateRegex) || []).slice(0, 40).forEach((raw) => addStaticVideoUrl(raw));
  }

  const resolveVimeoCandidateVideos = async (timeoutMs: number, label: string) => {
    if (vimeoCandidateUrls.size === 0) return;
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(Array.from(vimeoCandidateUrls), 'fhd', targetUrl),
        timeoutMs,
        label
      );
      videos.push(...(vimeoAssets.videos || []));
      if (!options.videosOnly) images.push(...(vimeoAssets.images || []));
    } catch (error: any) {
      console.warn(`${label} failed:`, error?.message || error);
      videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
    }
  };

  const resolveWistiaCandidateVideos = async (timeoutMs: number, label: string) => {
    if (wistiaCandidateIds.size === 0) return;
    try {
      const wistiaAssets = await withTimeout(
        extractWistiaVideos(Array.from(wistiaCandidateIds), 'fhd'),
        timeoutMs,
        label
      );
      videos.push(...(wistiaAssets.videos || []));
      if (!options.videosOnly) images.push(...(wistiaAssets.images || []));
    } catch (error: any) {
      console.warn(`${label} failed, using placeholders:`, error?.message || error);
      videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
    }
  };

  const deferVimeoHomepageStreamUpgrade = !options.videosOnly && isPlatformMarketingHomepage(targetUrl);
  if (vimeoCandidateUrls.size > 0 && deferVimeoHomepageStreamUpgrade) {
    videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
  } else if (vimeoCandidateUrls.size > 0 && htmlVideoPlayers.length === 0) {
    await resolveVimeoCandidateVideos(
      options.fast ? 8000 : VIMEO_EXTRACT_TIMEOUT_MS,
      options.fast ? `Fast static Vimeo extraction for ${targetUrl}` : `Static Vimeo extraction for ${targetUrl}`
    );
  } else if (vimeoCandidateUrls.size > 0 && htmlVideoPlayers.length > 0) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(Array.from(vimeoCandidateUrls), 'fhd', targetUrl),
        options.fast ? 12000 : 45000,
        `Quick Vimeo upgrade for ${targetUrl}`
      );
      videos.push(...(vimeoAssets.videos || []));
      if (!options.videosOnly) images.push(...(vimeoAssets.images || []));
    } catch (error: any) {
      console.warn('Quick Vimeo upgrade skipped:', error?.message || error);
    }
  }

  await resolveWistiaCandidateVideos(
    options.fast ? 8000 : 12000,
    options.fast ? `Fast static Wistia extraction for ${targetUrl}` : `Static Wistia extraction for ${targetUrl}`
  );

  if (videos.length === 0 && html) {
    videos.push(...buildWebsiteVideoPlayersFromHtml(html, targetUrl));
  }

  if (options.videosOnly && videos.length > 0) {
    return dedupeExtractedAssets(
      [],
      await resolveBrightcoveCandidateVideos(videos, `Static Brightcove extraction for ${targetUrl}`),
      [],
      [],
      targetUrl,
      resolvedPagePrimaryThumb,
      { fast: true, videosOnly: true }
    );
  }

  if (options.fast && isRichStaticExtract({ images, fonts, videos })) {
    const stylesheetLinks = (html.match(/<link[^>]+rel=["']stylesheet["']/gi) || []).length;
    const canSkipCssFetch = options.videosOnly || stylesheetLinks === 0;
    const embedsResolved = options.videosOnly
      ? !staticExtractHasUnresolvedEmbeds(html, { videos }, options)
      : true;
    if (canSkipCssFetch && embedsResolved) {
      return dedupeExtractedAssets(
        images,
        await resolveBrightcoveCandidateVideos(videos, `Fast static Brightcove extraction for ${targetUrl}`),
        fonts,
        colors,
        targetUrl,
        resolvedPagePrimaryThumb,
        {
        fast: true,
        videosOnly: options.videosOnly,
        }
      );
    }
  }

  if (options.videosOnly) {
    return dedupeExtractedAssets(
      [],
      await resolveBrightcoveCandidateVideos(videos, `Static Brightcove extraction for ${targetUrl}`),
      [],
      [],
      targetUrl,
      resolvedPagePrimaryThumb,
      { fast: options.fast, videosOnly: true }
    );
  }

  const cssBundle = await withTimeout(
    fetchCssSourceCandidates(targetUrl, html, { fast: options.fast }),
    options.fast ? 20000 : 30000,
    `CSS asset scan for ${targetUrl}`
  ).catch(() => ({ inlineStyles: [] as Array<{ css: string; source: string }>, fetchedCss: [] as Array<{ css: string; source: string }> }));
  cssBundle.inlineStyles.forEach(({ css, source }) => {
    fonts = fonts.concat(extractFontsFromCss(css, source));
    images.push(...extractImagesFromCss(css, source));
    const rawAssets = extractAssetsFromRawText(css, source);
    images.push(...rawAssets.images);
    videos.push(...rawAssets.videos);
    fonts = fonts.concat(rawAssets.fonts);
    colors = colors.concat(extractColorsFromCss(css));
  });
  cssBundle.fetchedCss.forEach(({ css, source }) => {
    fonts = fonts.concat(extractFontsFromCss(css, source));
    images.push(...extractImagesFromCss(css, source));
    const rawAssets = extractAssetsFromRawText(css, source);
    images.push(...rawAssets.images);
    videos.push(...rawAssets.videos);
    fonts = fonts.concat(rawAssets.fonts);
    colors = colors.concat(extractColorsFromCss(css));
  });

  return dedupeExtractedAssets(images, await resolveBrightcoveCandidateVideos(videos, `Static Brightcove extraction for ${targetUrl}`), fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: options.fast });
};

const extractQuickAssets = async (targetUrl: string, options: { videosOnly?: boolean } = {}) => {
  const images: any[] = [];
  const videos: any[] = [];
  let fonts: any[] = [];
  let colors: string[] = [];
  const vimeoCandidateUrls = new Set<string>();
  const wistiaCandidateIds = new Set<string>();

  const html = await withTimeout(fetchQuickSiteHtml(targetUrl), 10000, `Quick HTML fetch for ${targetUrl}`).catch(() => '');
  if (!html) {
    return extractReaderFallbackAssets(targetUrl, { videosOnly: options.videosOnly });
  }
  if (htmlLooksLikeBotWall(html)) {
    return extractReaderFallbackAssets(targetUrl, { videosOnly: options.videosOnly });
  }

  const { resolvedPagePrimaryThumb } = await enrichAssetsFromHtml(html, targetUrl, {
    images,
    videos,
    fonts,
    colors,
    vimeoCandidateUrls,
    wistiaCandidateIds,
  }, { fast: true, videosOnly: options.videosOnly });
  if (!options.videosOnly) {
    // Some storefronts (including nike.in) embed their @font-face rules in the
    // initial document rather than a separately linked stylesheet. Capture
    // those in the quick result so the UI does not finish with images only.
    fonts.push(...extractFontsFromCss(html, targetUrl));
    fonts.push(...recoverKnownThemeFontCandidates(html, targetUrl));
  }

  if (vimeoCandidateUrls.size > 0) {
    videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
  }
  if (wistiaCandidateIds.size > 0) {
    videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
  }

  const htmlVideoPlayers = buildWebsiteVideoPlayersFromHtml(html, targetUrl);
  if (htmlVideoPlayers.length > 0) {
    videos.push(...htmlVideoPlayers);
  }

  return dedupeExtractedAssets(
    images,
    await resolveBrightcoveCandidateVideos(videos, `Quick Brightcove extraction for ${targetUrl}`),
    fonts,
    colors,
    targetUrl,
    resolvedPagePrimaryThumb,
    { fast: true, videosOnly: options.videosOnly }
  );
};

const recoverKnownThemeFontCandidates = (html: string, targetUrl: string) => {
  const text = String(html || '');
  const fonts: any[] = [];
  const addFont = (rawUrl: string, family: string, format: string, cssSource = targetUrl) => {
    const url = resolveUrl(targetUrl, rawUrl);
    if (!url) return;
    fonts.push({
      family,
      url,
      format,
      cssSource,
      weight: 'normal',
      style: 'normal',
      source: 'theme-font-recovery',
      status: DEFAULT_ASSET_STATUS,
    });
  };

  if (/uncode-icons\.css|uncodeicon|uncode-icon|fa[bcirs]?\s+fa-|fa-(?:solid|regular|brands)/i.test(text)) {
    addFont('/fonts/uncode-icons.woff2', 'uncodeicon', 'woff2');
    addFont('/fonts/uncode-icons.woff', 'uncodeicon', 'woff');
    addFont('/fonts/uncode-icons.ttf', 'uncodeicon', 'ttf');
    addFont('/wp-content/themes/uncode/library/fonts/uncode-icons.woff2', 'uncodeicon', 'woff2');
  }

  return fonts;
};

const needsMp4Transcode = (rawUrl: string, contentType: string) => {
  const loweredUrl = String(rawUrl || '').toLowerCase();
  const loweredType = String(contentType || '').toLowerCase();
  // URL extension takes priority because some CDNs mislabel content-type.
  if (/\.(webm|mov|m3u8|mpd|mkv)(\?|$)/i.test(loweredUrl)) return true;
  if (loweredType.includes('video/mp4')) return false;
  if (loweredType.includes('video/webm') || loweredType.includes('application/x-mpegurl') || loweredType.includes('application/vnd.apple.mpegurl') || loweredType.includes('application/dash+xml') || loweredType.includes('video/quicktime') || loweredType.includes('video/x-matroska')) {
    return true;
  }
  return false;
};

const validateOutputFile = async (outputPath: string, label: string) => {
  const stat = await fsp.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 1024) {
    throw new Error(`${label} output was not created.`);
  }
  return stat;
};

const validateSavedAssetFile = async (outputPath: string, label: string) => {
  const stat = await fsp.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new Error(`${label} output was not created.`);
  }
  return stat;
};

class MediaExtractionError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

const probeMediaFile = (inputPath: string) =>
  new Promise<any>((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) reject(error);
      else resolve(metadata);
    });
  });

const STRICT_YOUTUBE_AUDIO_VERIFY = process.env.VDX_STRICT_YOUTUBE_AUDIO_VERIFY === '1';

const assertLocalFileHasAudio = async (inputPath: string) => {
  const metadata = await probeMediaFile(inputPath);
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const audioStream = streams.find((stream: any) => stream?.codec_type === 'audio' && stream?.codec_name && stream.codec_name !== 'unknown');
  if (!audioStream) {
    throw new MediaExtractionError('Audio track unavailable for this video.', 422);
  }
  return audioStream;
};

const verifyMergedYouTubeFile = async (inputPath: string) => {
  const stat = await fsp.stat(inputPath).catch(() => null);
  if (!stat || stat.size < 1024) {
    throw new MediaExtractionError('Merged YouTube file missing or too small.', 422);
  }

  logYouTubeMerge('verify-start', {
    mergedOutputPath: inputPath,
    fileSize: stat.size,
    tempFolder: path.dirname(inputPath),
    strictAudioVerify: STRICT_YOUTUBE_AUDIO_VERIFY,
  });

  try {
    const audioStream = await assertLocalFileHasAudio(inputPath);
    const metadata = await probeMediaFile(inputPath);
    const probe = describeMediaProbe(metadata);
    logYouTubeMerge('verify-ok', {
      mergedOutputPath: inputPath,
      hasAudio: true,
      audioCodec: probe.audioCodec,
      videoCodec: probe.videoCodec,
    });
    return { ...probe, hasAudio: true, audioVerified: true, audioStream };
  } catch (probeError: any) {
    logYouTubeMerge('verify-audio-probe-failed', {
      mergedOutputPath: inputPath,
      fileSize: stat.size,
      error: probeError?.message || String(probeError),
    });
    if (STRICT_YOUTUBE_AUDIO_VERIFY) throw probeError;
    return {
      hasVideo: true,
      hasAudio: true,
      audioVerified: false,
      audioCodec: '',
      videoCodec: '',
      warning: probeError?.message || 'Audio probe skipped; merged file exists.',
    };
  }
};

const describeMediaProbe = (metadata: any) => {
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videoStream = streams.find((stream: any) => stream?.codec_type === 'video');
  const audioStream = streams.find((stream: any) => stream?.codec_type === 'audio' && stream?.codec_name && stream.codec_name !== 'unknown');
  return {
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream?.codec_name || '',
    audioCodec: audioStream?.codec_name || '',
    pixFmt: String(videoStream?.pix_fmt || ''),
    width: Number(videoStream?.width || 0) || undefined,
    height: Number(videoStream?.height || 0) || undefined,
    duration: Number(metadata?.format?.duration || 0) || undefined,
    bitrate: Number(metadata?.format?.bit_rate || 0) || undefined,
  };
};

const isQuickTimeCompatibleProbe = (probe: {
  hasVideo?: boolean;
  hasAudio?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
}) => {
  const videoCodec = String(probe.videoCodec || '').toLowerCase();
  const audioCodec = String(probe.audioCodec || '').toLowerCase();
  const pixFmt = String(probe.pixFmt || '').toLowerCase();
  if (/^(vp9|av01|av1|hevc|h265|theora|vorbis)$/i.test(videoCodec)) return false;
  const videoOk = probe.hasVideo && (videoCodec === 'h264' || videoCodec.startsWith('avc1') || videoCodec.includes('h264'));
  const audioOk = !probe.hasAudio || audioCodec === 'aac' || audioCodec.startsWith('mp4a') || audioCodec.includes('aac');
  const pixOk = !pixFmt || pixFmt === 'yuv420p' || pixFmt === 'yuvj420p';
  return videoOk && audioOk && pixOk;
};

const ensureQuickTimeCompatibleMp4 = async (
  inputPath: string,
  options: { titleHint?: string; quality?: string; outputPath?: string } = {}
) => {
  const metadata = await probeMediaFile(inputPath);
  const probe = describeMediaProbe(metadata);
  const quality = options.quality || 'fhd';
  const titleHint = options.titleHint || path.basename(inputPath, path.extname(inputPath));
  const desiredOutput =
    options.outputPath ||
    path.join(path.dirname(inputPath), toQuickTimeVideoFilename(titleHint, quality));
  const tempOutput = `${desiredOutput}.part`;

  if (isQuickTimeCompatibleProbe(probe)) {
    const cmd = ffmpeg(inputPath).outputOptions(['-c copy', '-movflags +faststart', '-f mp4']);
    await waitForFfmpegFile(cmd, tempOutput, 'QuickTime faststart remux');
  } else {
    const cmd = ffmpeg(inputPath).outputOptions([
      '-c:v libx264',
      '-preset veryfast',
      '-crf 23',
      '-pix_fmt yuv420p',
      '-c:a aac',
      '-b:a 192k',
      '-movflags +faststart',
      '-f mp4',
    ]);
    await waitForFfmpegFile(cmd, tempOutput, 'QuickTime transcode');
  }

  await fsp.mkdir(path.dirname(desiredOutput), { recursive: true }).catch(() => undefined);
  if (path.resolve(desiredOutput) !== path.resolve(inputPath)) {
    await fsp.unlink(desiredOutput).catch(() => undefined);
  }
  await fsp.rename(tempOutput, desiredOutput);
  if (path.resolve(desiredOutput) !== path.resolve(inputPath)) {
    await fsp.unlink(inputPath).catch(() => undefined);
  }
  const finalProbe = describeMediaProbe(await probeMediaFile(desiredOutput));
  return {
    outputPath: desiredOutput,
    probe: finalProbe,
    quickTimeCompatible: isQuickTimeCompatibleProbe(finalProbe),
    remuxedOnly: isQuickTimeCompatibleProbe(probe),
  };
};

const waitForFfmpegFile = async (
  cmd: any,
  outputPath: string,
  label: string,
  { timeoutMs = 8 * 60 * 1000, stallMs = 75 * 1000 } = {}
) => {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastActivity = Date.now();
    const markActivity = () => {
      lastActivity = Date.now();
    };
    const finish = (error?: any) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const kill = () => {
      try {
        cmd.kill('SIGKILL');
      } catch {
        // Process may already be gone.
      }
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) {
        kill();
        finish(new Error(`${label} stalled while processing.`));
      }
    }, 5000);
    const timeout = setTimeout(() => {
      kill();
      finish(new Error(`${label} timed out.`));
    }, timeoutMs);

    cmd
      .on('start', (commandLine: string) => {
        markActivity();
        logYouTubeMerge('ffmpeg-spawn', { label, commandLine: String(commandLine || '').slice(0, 500), outputPath });
      })
      .on('codecData', markActivity)
      .on('progress', markActivity)
      .on('stderr', (line: string) => {
        markActivity();
        if (/error|failed/i.test(String(line || ''))) {
          logYouTubeMerge('ffmpeg-stderr', { label, line: String(line || '').slice(0, 400) });
        }
      })
      .on('end', () => finish())
      .on('close', markActivity)
      .on('exit', (code: number) => {
        markActivity();
        if (code && code !== 0) {
          logYouTubeMerge('ffmpeg-exit', { label, exitCode: code, outputPath });
        }
      })
      .on('error', (err: any) => {
        logYouTubeMerge('ffmpeg-error', { label, error: err?.message || String(err), exitCode: err?.exitCode ?? null, outputPath });
        finish(err);
      })
      .save(outputPath);
  });

  return validateOutputFile(outputPath, label);
};

const transcodeUrlToMp4File = async (inputUrl: string, outputPath: string, referer?: string, origin?: string) => {
  const headerLines: string[] = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join('\r\n')}\r\n` : '';

  const cmd = ffmpeg(inputUrl);

  if (headersArg) {
    cmd.inputOptions(['-headers', headersArg]);
  }

  cmd.outputOptions([
    '-c:v libx264',
    '-preset veryfast',
    '-crf 23',
    '-c:a aac',
    '-movflags +faststart',
    '-f mp4',
  ]);

  await waitForFfmpegFile(cmd, outputPath, 'MP4 conversion');
};

const transcodeLocalFileToMp4File = async (inputPath: string, outputPath: string) => {
  const cmd = ffmpeg(inputPath).outputOptions([
    '-c:v libx264',
    '-preset veryfast',
    '-crf 23',
    '-pix_fmt yuv420p',
    '-c:a aac',
    '-b:a 192k',
    '-movflags +faststart',
    '-f mp4',
  ]);

  await waitForFfmpegFile(cmd, outputPath, 'Local MP4 conversion');
};

type AudioEncodeOptions = {
  durationSeconds?: number;
  timeoutMs?: number;
  stallMs?: number;
};

type AudioMode = 'turbo' | 'hq' | 'original';

const audioDurationOptions = (durationSeconds?: number) =>
  durationSeconds && durationSeconds > 0 ? [`-t ${durationSeconds}`] : [];

const transcodeLocalFileToMp3File = async (inputPath: string, outputPath: string, bitrate = '192k', options: AudioEncodeOptions = {}) => {
  const cmd = ffmpeg(inputPath)
    .noVideo()
    .audioCodec('libmp3lame')
    .audioBitrate(bitrate)
    .audioChannels(2)
    .audioFrequency(44100)
    .outputOptions([
      ...audioDurationOptions(options.durationSeconds),
      '-map 0:a:0?',
    ])
    .format('mp3');

  await waitForFfmpegFile(cmd, outputPath, 'Local audio extraction', {
    timeoutMs: options.timeoutMs || 6 * 60 * 1000,
    stallMs: options.stallMs || 55 * 1000,
  });
};

const downloadUrlToFile = async (sourceUrl: string, outputPath: string, sourcePageUrl?: string) => {
  const headers = mediaRequestHeaders(sourceUrl, sourcePageUrl);
  const response = await axios({
    method: 'GET',
    url: sourceUrl,
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 4,
    headers,
    httpsAgent: relaxedHttpsAgent,
  });

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    response.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    response.data.on('error', reject);
  });

  return validateOutputFile(outputPath, 'Source download');
};

const transcodeUrlToMp3File = async (
  inputUrl: string,
  outputPath: string,
  referer?: string,
  origin?: string,
  bitrate = '192k',
  options: AudioEncodeOptions = {}
) => {
  const headerLines: string[] = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join('\r\n')}\r\n` : '';

  const cmd = ffmpeg(inputUrl);

  if (headersArg) {
    cmd.inputOptions(['-headers', headersArg]);
  }

  cmd
    .noVideo()
    .audioCodec('libmp3lame')
    .audioBitrate(bitrate)
    .audioChannels(2)
    .audioFrequency(44100)
    .outputOptions([
      ...audioDurationOptions(options.durationSeconds),
      '-map 0:a:0?',
    ])
    .format('mp3');

  await waitForFfmpegFile(cmd, outputPath, 'Audio extraction', {
    timeoutMs: options.timeoutMs || 6 * 60 * 1000,
    stallMs: options.stallMs || 55 * 1000,
  });
};

const copyUrlAudioSegmentToM4aFile = async (
  inputUrl: string,
  outputPath: string,
  referer?: string,
  origin?: string,
  durationSeconds = 60
) => {
  const headerLines: string[] = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join('\r\n')}\r\n` : '';

  const cmd = ffmpeg(inputUrl);

  if (headersArg) {
    cmd.inputOptions(['-headers', headersArg]);
  }

  cmd
    .noVideo()
    .audioCodec('copy')
    .outputOptions([
      '-map 0:a:0?',
      ...audioDurationOptions(durationSeconds),
      '-movflags +faststart',
      '-f mp4',
    ]);

  await waitForFfmpegFile(cmd, outputPath, 'Audio copy', {
    timeoutMs: 90 * 1000,
    stallMs: 25 * 1000,
  });
};

const copyUrlAudioToFile = async (
  inputUrl: string,
  outputPath: string,
  referer?: string,
  origin?: string,
  containerFormat?: string
) => {
  const headerLines: string[] = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join('\r\n')}\r\n` : '';

  const cmd = ffmpeg(inputUrl);

  if (headersArg) {
    cmd.inputOptions(['-headers', headersArg]);
  }

  cmd
    .noVideo()
    .audioCodec('copy')
    .outputOptions([
      '-map 0:a:0?',
      '-vn',
      ...(containerFormat === 'mp4' ? ['-movflags +faststart'] : []),
      ...(containerFormat ? [`-f ${containerFormat}`] : []),
    ]);

  await waitForFfmpegFile(cmd, outputPath, 'Original audio extraction', {
    timeoutMs: 6 * 60 * 1000,
    stallMs: 55 * 1000,
  });
};

const toSafeFileBase = (raw: string) =>
  String(raw || 'video')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';

const toQualityVideoFilename = (quality: string, titleHint?: string) => {
  if (titleHint) return toQuickTimeVideoFilename(titleHint, quality);
  if (quality === 'fhd') return 'FHD_QuickTime.mp4';
  if (quality === 'hd') return 'HD_QuickTime.mp4';
  if (quality === '4k') return '4K_QuickTime.mp4';
  return `${String(quality || 'video').toUpperCase()}_QuickTime.mp4`;
};

const toQuickTimeVideoFilename = (titleHint: string, quality: string) => {
  const base = toSafeFileBase(titleHint);
  if (quality === 'hd') return `${base}_HD_QuickTime.mp4`;
  if (quality === '4k') return `${base}_4K_QuickTime.mp4`;
  return `${base}_FHD_QuickTime.mp4`;
};

const toQuickTimeAudioFilename = (titleHint: string) => `${toSafeFileBase(titleHint)}_Audio_128kbps.m4a`;

const toStandardAudioFilename = (mode?: string, titleHint?: string) => {
  if (titleHint && mode !== 'hq' && mode !== 'original') return toQuickTimeAudioFilename(titleHint);
  if (mode === 'hq') return 'Audio-HQ.mp3';
  if (mode === 'original') return 'Audio-Original.m4a';
  return 'Audio_128kbps.m4a';
};

const pageTitleFromUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const file = parsed.pathname.split('/').filter(Boolean).pop() || 'Video';
    return decodeURIComponent(file).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Video';
  } catch {
    return 'Video';
  }
};

const toMp4ProxyUrl = (streamUrl: string, titleHint?: string) => {
  const filename = `${toSafeFileBase(titleHint || 'video')}.mp4`;
  const normalized = sanitizeStreamUrl(streamUrl) || streamUrl;
  return `/api/download?url=${encodeURIComponent(normalized)}&filename=${encodeURIComponent(filename)}`;
};

const isGoogleVideoPlaybackUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host.includes('googlevideo.com') || /\/videoplayback(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /googlevideo\.com|\/videoplayback(?:\?|\/|$)/i.test(String(rawUrl || ''));
  }
};

const toAbsoluteAppUrl = (req: express.Request, relativePath: string) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.get('host') || `localhost:${activePort || DEFAULT_PORT}`;
  return `${proto}://${host}${relativePath}`;
};

const unwrapDownloadProxyUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl, `http://localhost:${activePort || DEFAULT_PORT}`);
    if (parsed.pathname === '/api/download' || parsed.pathname === '/api/youtube-merged-stream') {
      return parsed.searchParams.get('url') || rawUrl;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};

const getStreamRequestContext = (parsedUrl: URL, sourcePageUrl?: string) => {
  const sourceOrigin = parsedUrl.origin;
  const host = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
  const isGoogleVideo = host.includes('googlevideo.com');
  const pageOrigin = (() => {
    try {
      return sourcePageUrl ? new URL(sourcePageUrl).origin : '';
    } catch {
      return '';
    }
  })();
  const isVimeoCdn = host.includes('vimeocdn.com');
  const referer = isGoogleVideo
    ? 'https://www.youtube.com/'
    : isVimeoCdn
      ? (pageOrigin ? `${pageOrigin}/` : 'https://player.vimeo.com/')
      : (pageOrigin ? `${pageOrigin}/` : `${sourceOrigin}/`);
  const origin = isGoogleVideo
    ? 'https://www.youtube.com'
    : isVimeoCdn
      ? 'https://player.vimeo.com'
      : (pageOrigin || sourceOrigin);
  return { referer, origin };
};

const openLocalFolder = async (folderPath: string) => {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [folderPath]);
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', folderPath]);
    return;
  }
  await execFileAsync('xdg-open', [folderPath]);
};

const isPortAvailable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '127.0.0.1');
  });

const findAvailablePort = async (preferredPort: number, attempts = 50) => {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 3000;
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) return candidate;
  }
  throw new Error('No available local port was found.');
};

const ensureRuntimeToolsReady = async () => {
  console.log('Preparing video engine...');
  try {
    await fsp.mkdir(appDataDir, { recursive: true });
    await refreshResolvedMediaTools();
    const chromiumPath = findBundledChromiumExecutable();
    if (chromiumPath) await fsp.chmod(chromiumPath, 0o755).catch(() => undefined);
    console.log('Optimizing extraction engine...');
    console.log('Setup complete.');
  } catch {
    console.log('Required video tools missing. Restart the app to retry bundled tool setup.');
  }
};

type StreamValidation = {
  ok: boolean;
  url?: string;
  status?: number;
  contentType?: string;
  contentLength?: number;
  reason?: string;
};

const mediaRequestHeaders = (streamUrl: string, sourcePageUrl?: string) => {
  let referer: string | undefined;
  let origin: string | undefined;
  try {
    const parsed = new URL(streamUrl);
    const context = getStreamRequestContext(parsed, sourcePageUrl);
    referer = context.referer;
    origin = context.origin;
  } catch {
    // Keep generic headers for malformed URLs; validation will reject them.
  }

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    ...(referer ? { 'Referer': referer } : {}),
    ...(origin ? { 'Origin': origin } : {}),
  };
};

const generateVideoFrameThumbnail = async (streamUrl: string, sourcePageUrl: string | undefined, req: express.Request) => {
  const normalized = sanitizeStreamUrl(streamUrl, sourcePageUrl);
  if (!normalized || !isLikelyHttpMediaUrl(normalized)) return '';

  await fsp.mkdir(generatedThumbnailDir, { recursive: true });
  const hash = crypto.createHash('sha1').update(normalized).digest('hex');
  const outputPath = path.join(generatedThumbnailDir, `${hash}.jpg`);
  const existing = await fsp.stat(outputPath).catch(() => null);
  if (existing && existing.size > 1024) {
    return toAbsoluteAppUrl(req, `/generated-thumbnails/${hash}.jpg`);
  }

  const headers = mediaRequestHeaders(normalized, sourcePageUrl);
  const headerLines = Object.entries(headers)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  const headerArg = `${headerLines.join('\r\n')}\r\n`;

  const renderFrame = async (input: string, useHeaders: boolean) => {
    const cmd = ffmpeg(input)
      .outputOptions(['-frames:v 1', '-q:v 3', '-update 1'])
      .format('image2');
    if (useHeaders) cmd.inputOptions(['-headers', headerArg]);
    await waitForFfmpegFile(cmd, outputPath, 'Thumbnail generation', {
      timeoutMs: 30 * 1000,
      stallMs: 15 * 1000,
    });
  };

  try {
    await renderFrame(normalized, true);
  } catch (remoteError) {
    await fsp.unlink(outputPath).catch(() => undefined);
    const validation = await validateStreamUrl(normalized, sourcePageUrl).catch(() => null);
    const isManifestSource = /\.m3u8|\.mpd/i.test(normalized) || /mpegurl|dash\+xml/i.test(String(validation?.contentType || ''));
    const isSmallEnoughForFallback = !validation?.contentLength || validation.contentLength <= 60 * 1024 * 1024;
    if (isManifestSource || !isSmallEnoughForFallback) throw remoteError;

    let tempInput = '';
    try {
      const parsed = new URL(normalized);
      const ext = path.extname(parsed.pathname) || '.bin';
      tempInput = path.join(generatedThumbnailDir, `${hash}-source${ext}`);
      await downloadUrlToFile(normalized, tempInput, sourcePageUrl);
      await renderFrame(tempInput, false);
    } finally {
      if (tempInput) await fsp.unlink(tempInput).catch(() => undefined);
    }
  }

  return toAbsoluteAppUrl(req, `/generated-thumbnails/${hash}.jpg`);
};

app.get('/api/video-frame-thumbnail', async (req, res) => {
  const streamUrl = String(req.query?.url || '').trim();
  const sourcePageUrl = String(req.query?.sourcePageUrl || '').trim();
  if (!streamUrl) return res.status(400).json({ error: 'Video URL is required.' });
  try {
    const thumbnailUrl = await generateVideoFrameThumbnail(streamUrl, sourcePageUrl || undefined, req);
    if (!thumbnailUrl) return res.status(404).json({ error: 'Video thumbnail is unavailable.' });
    return res.redirect(302, thumbnailUrl);
  } catch (error: any) {
    return res.status(404).json({ error: error?.message || 'Video thumbnail generation failed.' });
  }
});

const getVideoPreviewMetadata = async (targetUrl: string) => {
  if (isBrightcoveUrl(targetUrl)) {
    try {
      const info = await getBrightcoveMetadata(targetUrl);
      const thumbnail = sanitizeStreamUrl(
        info.poster || info.thumbnail || info.poster_sources?.[0]?.src || info.thumbnail_sources?.[0]?.src || '',
        targetUrl
      ) || '';
      return {
        sourceUrl: targetUrl,
        thumbnail,
        title: String(info.name || info.title || 'Brightcove video'),
        provider: 'brightcove',
      };
    } catch {
      return null;
    }
  }
  try {
    const info: any = await withTimeout(
      youtubedl(targetUrl, {
        dumpSingleJson: true,
        skipDownload: true,
        ...buildYtDlpQueryOptions(targetUrl),
      } as any),
      9000,
      `Preview metadata for ${targetUrl}`
    );

    const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
    const bestThumb = thumbnails
      .filter((thumb: any) => thumb?.url)
      .sort((a: any, b: any) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0))[0]?.url;
    const thumbnail = sanitizeStreamUrl(bestThumb || info.thumbnail || '', targetUrl) || '';

    return {
      sourceUrl: targetUrl,
      thumbnail,
      title: info.title || 'Video link',
      provider: platformProviderFromUrl(targetUrl),
    };
  } catch {
    return null;
  }
};

const isAcceptableStreamMime = (contentType: string, streamUrl: string) => {
  const lowered = String(contentType || '').toLowerCase();
  if (/video\/|audio\/|mpegurl|dash\+xml|octet-stream|application\/x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(lowered)) return true;
  return isLikelyHttpMediaUrl(streamUrl) || isLikelyDirectVideoStreamUrl(streamUrl) || isLikelyVideoAssetUrl(streamUrl);
};

const validateStreamUrl = async (rawUrl: string, sourcePageUrl?: string, baseUrl?: string): Promise<StreamValidation> => {
  const normalized = sanitizeStreamUrl(rawUrl, baseUrl || sourcePageUrl);
  if (!normalized) return { ok: false, reason: 'Invalid stream URL.' };
  if (isExpiredStreamUrl(normalized)) return { ok: false, url: normalized, reason: 'Stream URL expired.' };

  const headers = mediaRequestHeaders(normalized, sourcePageUrl);
  const validateHeaders = (status: number, responseHeaders: any): StreamValidation => {
    const contentType = String(responseHeaders?.['content-type'] || '');
    const contentLength = Number(responseHeaders?.['content-length'] || 0) || undefined;
    if (status < 200 || status >= 400) {
      return { ok: false, url: normalized, status, contentType, contentLength, reason: `Stream returned ${status}.` };
    }
    if (!isAcceptableStreamMime(contentType, normalized)) {
      return { ok: false, url: normalized, status, contentType, contentLength, reason: `Unexpected stream type ${contentType || 'unknown'}.` };
    }
    return { ok: true, url: normalized, status, contentType, contentLength };
  };

  try {
    const head = await axios({
      method: 'HEAD',
      url: normalized,
      timeout: 7000,
      maxRedirects: 4,
      validateStatus: () => true,
      headers,
      httpsAgent: relaxedHttpsAgent,
    });
    const checked = validateHeaders(head.status, head.headers);
    if (checked.ok || (head.status !== 403 && head.status !== 405)) return checked;
  } catch {
    // Some CDNs reject HEAD; try a ranged GET below.
  }

  try {
    const ranged = await axios({
      method: 'GET',
      url: normalized,
      responseType: 'stream',
      timeout: 9000,
      maxRedirects: 4,
      validateStatus: () => true,
      headers: {
        ...headers,
        Range: 'bytes=0-1',
      },
      httpsAgent: relaxedHttpsAgent,
    });
    const checked = validateHeaders(ranged.status, ranged.headers);
    ranged.data?.destroy?.();
    return checked;
  } catch (error: any) {
    return { ok: false, url: normalized, reason: error?.message || 'Stream validation failed.' };
  }
};

const cleanMediaUrlArtifacts = (rawUrl: string) =>
  String(rawUrl || '')
    .replace(/(\.mp4)(?:%20|\s)\([^?#]*?\)\.mp4(?=[?#]|$)/ig, '$1')
    .replace(/(\.webm)(?:%20|\s)\([^?#]*?\)\.webm(?=[?#]|$)/ig, '$1')
    .replace(/(\.mov)(?:%20|\s)\([^?#]*?\)\.mov(?=[?#]|$)/ig, '$1');

const sanitizeVideoForClient = (video: any, baseUrl?: string) => {
  if (!video?.url) return null;
  const normalizedUrl = cleanMediaUrlArtifacts(sanitizeStreamUrl(String(video.url), baseUrl || video.sourceUrl || video.pageUrl) || '');
  if (!normalizedUrl) return null;
  const sourceStreamUrl = video.sourceStreamUrl
    ? cleanMediaUrlArtifacts(sanitizeStreamUrl(String(video.sourceStreamUrl), baseUrl || video.sourceUrl || video.pageUrl) || video.sourceStreamUrl)
    : undefined;
  const sourceUrl = video.sourceUrl ? sanitizeStreamUrl(String(video.sourceUrl), baseUrl) || video.sourceUrl : undefined;
  return {
    ...video,
    url: normalizedUrl,
    ...(sourceStreamUrl ? { sourceStreamUrl } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
};

const validateAndNormalizeVideo = async (video: any, sourcePageUrl?: string, baseUrl?: string) => {
  const normalized = sanitizeVideoForClient(video, baseUrl || sourcePageUrl);
  if (!normalized) return null;
  if (!isLikelyDirectVideoStreamUrl(normalized.url) && !isLikelyVideoAssetUrl(normalized.url)) return normalized;

  const validation = await validateStreamUrl(normalized.url, sourcePageUrl || normalized.sourceUrl, baseUrl);
  if (!validation.ok || !validation.url) return null;
  return {
    ...normalized,
    url: validation.url,
    contentType: validation.contentType,
    filesize: normalized.filesize || validation.contentLength,
    verifiedPlayable: true,
  };
};

const toVerifiedPlayableVideo = async (video: any, sourcePageUrl?: string) => {
  const normalized = sanitizeVideoForClient(video, sourcePageUrl);
  if (!normalized) return null;
  const rawStreamUrl = sanitizeStreamUrl(String(normalized.sourceStreamUrl || normalized.url), sourcePageUrl || normalized.sourceUrl);
  if (!rawStreamUrl) return null;
  if (isDirectProgressiveVideoUrl(rawStreamUrl)) {
    return enforceMp4VideoPayload({
      ...normalized,
      url: rawStreamUrl,
      sourceStreamUrl: rawStreamUrl,
      isDirect: true,
      isDirectAsset: true,
      verifiedPlayable: true,
    });
  }
  if (!isLikelyDirectVideoStreamUrl(rawStreamUrl) && !isLikelyVideoAssetUrl(rawStreamUrl)) {
    return normalized;
  }

  const validation = await validateStreamUrl(rawStreamUrl, sourcePageUrl || normalized.sourceUrl);
  if (!validation.ok || !validation.url) return null;

  const verified = {
    ...normalized,
    url: validation.url,
    sourceStreamUrl: validation.url,
    contentType: validation.contentType,
    filesize: normalized.filesize || validation.contentLength,
    verifiedPlayable: true,
  };

  return enforceMp4VideoPayload(verified);
};

const firstValidStreamCandidate = async (candidates: any[], sourcePageUrl?: string, baseUrl?: string) => {
  for (const candidate of candidates) {
    const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ''), baseUrl || sourcePageUrl);
    if (!normalizedUrl || isExpiredStreamUrl(normalizedUrl)) continue;
    const validation = await validateStreamUrl(normalizedUrl, sourcePageUrl, baseUrl);
    if (validation.ok && validation.url) {
      return {
        ...candidate,
        url: validation.url,
        contentType: validation.contentType,
        contentLength: validation.contentLength,
      };
    }
  }
  return null;
};

const enforceMp4VideoPayload = (video: any) => {
  if (!video?.url) return video;
  const originalUrl = sanitizeStreamUrl(String(video.url), video.sourceUrl || video.pageUrl) || String(video.url);
  if (video?.isYouTubeMerged || String(video.url).includes('/api/youtube-merged-stream?')) {
    return {
      ...video,
      sourceStreamUrl: video.sourceStreamUrl || originalUrl,
      url: String(video.url),
      type: 'mp4',
      isMp4Proxy: true,
      isDirect: true,
    };
  }
  if (isGoogleVideoPlaybackUrl(originalUrl)) {
    return {
      ...video,
      sourceStreamUrl: originalUrl,
      url: originalUrl,
      type: 'mp4',
      isMp4Proxy: false,
      isDirect: true,
    };
  }
  if (isDirectProgressiveVideoUrl(originalUrl)) {
    return {
      ...video,
      sourceStreamUrl: originalUrl,
      url: originalUrl,
      type: getVideoFormatFromUrlOrType(originalUrl),
      isMp4Proxy: false,
      isDirect: true,
      isDirectAsset: true,
    };
  }

  return {
    ...video,
    sourceStreamUrl: originalUrl,
    url: toMp4ProxyUrl(originalUrl, video?.title),
    type: 'mp4',
    isMp4Proxy: true,
  };
};

const getVimeoTargetHeight = (quality: string) => {
  if (quality === '4k') return 2160;
  if (quality === 'fhd') return 1080;
  return 720;
};

const getFhdMp4FormatSelector = (quality: string) => {
  const targetHeight = getVimeoTargetHeight(quality);
  return [
    `bv*[height<=${targetHeight}][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best[height<=${targetHeight}][ext=mp4]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio`,
    `best[height<=${targetHeight}][ext=mp4]`,
    `best[height<=${targetHeight}]`,
    'best[ext=mp4]/best',
  ].join('/');
};

const vimeoMetadataCache = new Map<string, { expiresAt: number; info: any }>();
const vimeoMetadataTtlMs = 3 * 60 * 1000;
/** Vimeo pages often need 45–60s for yt-dlp (API + manifests) before formats are available. */
const VIMEO_YTDLP_TIMEOUT_MS = 120000;
const VIMEO_EXTRACT_TIMEOUT_MS = 130000;

const isVimeoProgressiveMp4Format = (format: any) => {
  const protocol = String(format?.protocol || '').toLowerCase();
  const ext = String(format?.ext || '').toLowerCase();
  const formatId = String(format?.format_id || format?.id || '').toLowerCase();
  const formatNote = String(format?.format_note || '').toLowerCase();
  const streamUrl = String(format?.url || '').toLowerCase();
  if (!format?.url || format?.vcodec === 'none') return false;
  if (ext !== 'mp4') return false;
  if (protocol.includes('m3u8') || protocol.includes('dash')) return false;
  if (formatNote.includes('dash') || formatId.startsWith('dash-') || formatId.startsWith('hls-')) return false;
  return (
    protocol === 'https' ||
    protocol === 'http' ||
    formatId.startsWith('http-') ||
    streamUrl.includes('progressive_redirect') ||
    /\.mp4(?:\?|$)/i.test(streamUrl)
  );
};

const parseVimeoIdFromUrl = (vimeoUrl: string) => {
  const value = String(vimeoUrl || '').trim();
  const directMatch = value.match(/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/|progressive_redirect\/(?:download|playback)\/)(\d+)/i);
  if (directMatch?.[1]) return directMatch[1];
  const normalized = normalizeVimeoUrl(vimeoUrl) || vimeoUrl;
  return String(normalized.match(/vimeo\.com\/(\d+)/)?.[1] || '');
};

const extractJsonObjectAfterMarker = (html: string, marker: string) => {
  const startIndex = html.indexOf(marker);
  if (startIndex < 0) return null;
  let index = startIndex + marker.length;
  while (index < html.length && /\s/.test(html[index])) index += 1;
  if (html[index] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(index, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const parseVimeoPlayerConfigFromHtml = (html: string) => {
  const markers = ['window.playerConfig = ', 'var playerConfig = ', 'playerConfig = '];
  for (const marker of markers) {
    const config = extractJsonObjectAfterMarker(html, marker);
    if (config?.request || config?.video) return config;
  }
  return null;
};

const getVimeoManifestUrlFromConfig = (config: any, kind: 'hls' | 'dash') => {
  const files = config?.request?.files?.[kind];
  if (!files?.cdns) return '';
  const cdnKey = files.default_cdn;
  const cdn = (cdnKey && files.cdns[cdnKey]) || Object.values(files.cdns)[0];
  const raw = String((cdn as any)?.avc_url || (cdn as any)?.url || '');
  return raw ? decodeEscaped(raw) : '';
};

const getVimeoProgressiveFormatsFromConfig = (config: any) => {
  const progressive = config?.request?.files?.progressive;
  if (!Array.isArray(progressive)) return [];
  return progressive
    .filter((item: any) => item?.url && Number(item?.height || 0) > 0)
    .map((item: any) => ({
      url: decodeEscaped(String(item.url)),
      height: Number(item.height || 0),
      width: Number(item.width || 0),
      fps: Number(item.fps || 0) || undefined,
      quality: String(item.quality || ''),
      ext: 'mp4',
      protocol: 'https',
      vcodec: 'avc1',
      acodec: 'mp4a',
      format_id: `http-${item.height}p`,
    }));
};

const fetchVimeoConfigFromUrl = async (configUrl: string, sourcePageUrl = '') => {
  const response = await axios.get(configUrl, {
    timeout: 12000,
    responseType: 'json',
    httpsAgent: relaxedHttpsAgent,
    headers: mediaRequestHeaders(configUrl, sourcePageUrl || 'https://vimeo.com/'),
  });
  return response.data && typeof response.data === 'object' ? response.data : null;
};

const parseVimeoQualityLabelHeight = (label: string) => {
  const match = String(label || '').match(/(\d{3,4})p/i);
  return match ? Number(match[1]) : 0;
};

const getVimeoDashQualityHeights = (config: any) => {
  const streams =
    config?.request?.files?.dash?.streams_avc ||
    config?.request?.files?.dash?.streams ||
    [];
  return Array.from(
    new Set(
      (Array.isArray(streams) ? streams : [])
        .map((stream: any) => parseVimeoQualityLabelHeight(stream?.quality))
        .filter((height: number) => height > 0)
    )
  ).sort((a, b) => b - a);
};

const fetchVimeoPlayerHtml = async (vimeoId: string, sourcePageUrl = '') => {
  const playerUrl = `https://player.vimeo.com/video/${vimeoId}`;
  const response = await axios.get(playerUrl, {
    timeout: 15000,
    responseType: 'text',
    httpsAgent: relaxedHttpsAgent,
    headers: {
      ...mediaRequestHeaders(playerUrl, sourcePageUrl || 'https://vimeo.com/'),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return String(response.data || '');
};

const loadVimeoPlayerConfig = async (vimeoId: string, sourcePageUrl = '') => {
  let configUrl = '';
  try {
    const html = await fetchVimeoPlayerHtml(vimeoId, sourcePageUrl);
    const config = parseVimeoPlayerConfigFromHtml(html);
    if (config) {
      configUrl = String(config?.request?.config_url || config?.config_url || '').trim();
      return { config, configUrl, source: 'player-page' as const };
    }
    const configUrlMatch = html.match(/config_url["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
    if (configUrlMatch?.[1]) {
      configUrl = decodeEscaped(configUrlMatch[1]);
      const remoteConfig = await fetchVimeoConfigFromUrl(configUrl, sourcePageUrl);
      if (remoteConfig?.request || remoteConfig?.video) {
        return { config: remoteConfig, configUrl, source: 'config-url' as const };
      }
    }
  } catch (error: any) {
    console.warn(`[vimeo:${vimeoId}] Player page config fetch failed:`, error?.message || error);
  }
  return null;
};

const captureVimeoNetworkManifests = async (vimeoId: string, sourcePageUrl = '') => {
  const manifests = new Set<string>();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await acquireSharedPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    if (sourcePageUrl) {
      await page.setExtraHTTPHeaders({ Referer: `${sourcePageUrl.replace(/\/+$/, '')}/` });
    }
    page.on('response', (response) => {
      const url = response.url();
      if (/\.m3u8(?:\?|$)/i.test(url) && /vimeocdn\.com/i.test(url)) manifests.add(url);
    });
    await page.goto(`https://player.vimeo.com/video/${vimeoId}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await page.close().catch(() => undefined);
  } catch (error: any) {
    console.warn(`[vimeo:${vimeoId}] Puppeteer manifest capture failed:`, error?.message || error);
  } finally {
    await releaseSharedPuppeteerBrowser();
  }
  return Array.from(manifests);
};

const pickVimeoHlsVariant = (
  variants: Array<{ url: string; width?: number; height?: number; bandwidth?: number }>,
  targetHeight: number
) => {
  const ranked = variants
    .filter((variant) => variant?.url)
    .map((variant) => ({
      variant,
      height: Number(variant.height || 0),
      distance: variant.height ? Math.abs(variant.height - targetHeight) : 9999,
      abovePenalty: variant.height && variant.height > targetHeight ? 250 : 0,
      bandwidth: Number(variant.bandwidth || 0),
    }))
    .sort(
      (a, b) =>
        a.distance + a.abovePenalty - (b.distance + b.abovePenalty) ||
        b.bandwidth - a.bandwidth ||
        b.height - a.height
    );
  return ranked[0]?.variant || null;
};

const formatVimeoHeightList = (heights: number[]) =>
  heights.length > 0 ? heights.map((height) => `${height}p`).join(', ') : 'none';

const logVimeoQualityDiscovery = (vimeoId: string, debug: {
  progressiveHeights: number[];
  hlsHeights: number[];
  dashHeights: number[];
  configSource: string;
  configUrl?: string;
  fhdAvailable: boolean;
  selectedFhdUrl?: string;
  selectedHdUrl?: string;
  title?: string;
}) => {
  console.log(`[vimeo:${vimeoId}] Vimeo ID: ${vimeoId}`);
  if (debug.title) console.log(`[vimeo:${vimeoId}] Title: ${debug.title}`);
  if (debug.configUrl) console.log(`[vimeo:${vimeoId}] Config URL: ${debug.configUrl}`);
  console.log(`[vimeo:${vimeoId}] Progressive formats: ${formatVimeoHeightList(debug.progressiveHeights)}`);
  const hlsLines = debug.hlsHeights.length > 0
    ? debug.hlsHeights.map((height) => `- ${height}p`).join('\n')
    : '- none';
  console.log(`[vimeo:${vimeoId}] HLS variants:\n${hlsLines}`);
  if (debug.dashHeights.length > 0) {
    console.log(`[vimeo:${vimeoId}] DASH qualities: ${formatVimeoHeightList(debug.dashHeights)}`);
  }
  console.log(
    `[vimeo:${vimeoId}] Config source: ${debug.configSource || 'none'} | FHD available: ${debug.fhdAvailable ? 'yes' : 'no'}`
  );
  if (debug.selectedFhdUrl) console.log(`[vimeo:${vimeoId}] Selected FHD URL: ${debug.selectedFhdUrl}`);
  if (debug.selectedHdUrl) console.log(`[vimeo:${vimeoId}] Selected HD URL: ${debug.selectedHdUrl}`);
};

type VimeoResolvedStream = {
  bucket: 'fhd' | 'hd';
  url: string;
  sourceStreamUrl: string;
  height: number;
  width?: number;
  type: 'mp4' | 'm3u8';
  streamSource: 'progressive-mp4' | 'hls' | 'dash' | 'ytdlp-hls' | 'browser';
  format?: any;
  acodec?: string;
  vcodec?: string;
  fps?: number;
  filesize?: number;
};

const resolveVimeoQualityStreams = async (vimeoUrl: string, sourcePageUrl: string, ytDlpInfo: any = null) => {
  const vimeoId = parseVimeoIdFromUrl(vimeoUrl);
  let configSource = '';
  let configUrl = '';
  let playerConfig: any = null;
  let hlsMasterUrl = '';
  let hlsVariants: Array<{ url: string; width?: number; height?: number; bandwidth?: number }> = [];
  let dashHeights: number[] = [];

  const playerConfigResult = vimeoId ? await loadVimeoPlayerConfig(vimeoId, sourcePageUrl) : null;
  if (playerConfigResult?.config) {
    playerConfig = playerConfigResult.config;
    configSource = playerConfigResult.source;
    configUrl = String(playerConfigResult.configUrl || '').trim();
    hlsMasterUrl = getVimeoManifestUrlFromConfig(playerConfig, 'hls');
    dashHeights = getVimeoDashQualityHeights(playerConfig);
    if (!hlsMasterUrl) {
      hlsMasterUrl = getVimeoManifestUrlFromConfig(playerConfig, 'dash');
      if (hlsMasterUrl) configSource = `${configSource || 'player-page'}+dash`;
    }
  }

  const resolvedTitle = String(playerConfig?.video?.title || ytDlpInfo?.title || '').trim();
  const title = resolvedTitle || 'Vimeo video';
  const thumbnail =
    sanitizeStreamUrl(playerConfig?.video?.thumbnail_url || ytDlpInfo?.thumbnail || '', vimeoUrl) ||
    ytDlpInfo?.thumbnail;
  const duration = Number(playerConfig?.video?.duration || ytDlpInfo?.duration || 0) || undefined;

  const formats = Array.isArray(ytDlpInfo?.formats) ? ytDlpInfo.formats : [];
  const progressiveFormats = [
    ...getVimeoProgressiveFormatsFromConfig(playerConfig),
    ...formats.filter(isVimeoProgressiveMp4Format),
  ].sort((a: any, b: any) => (b.height || 0) - (a.height || 0));

  const progressiveByHeight = new Map<number, any>();
  progressiveFormats.forEach((format: any) => {
    const height = parseCandidateHeight(format) || Number(format.height || 0);
    if (!height) return;
    const current = progressiveByHeight.get(height);
    if (!current || Number(format.tbr || 0) > Number(current.tbr || 0)) progressiveByHeight.set(height, format);
  });
  const progressiveHeights = Array.from(progressiveByHeight.keys()).sort((a, b) => b - a);

  if (!hlsMasterUrl && vimeoId) {
    const ytDlpHls = formats
      .filter((format: any) => {
        const protocol = String(format?.protocol || '').toLowerCase();
        const url = String(format?.url || '');
        return protocol.includes('m3u8') || /\.m3u8(?:\?|$)/i.test(url);
      })
      .sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
    const masterCandidate = ytDlpHls.find((format: any) => /playlist\.m3u8|master\.m3u8/i.test(String(format?.url || '')));
    if (masterCandidate?.url) {
      hlsMasterUrl = sanitizeStreamUrl(masterCandidate.url, vimeoUrl) || masterCandidate.url;
      configSource = configSource || 'ytdlp-hls';
    }
  }

  if (hlsMasterUrl) {
    hlsVariants = await extractHlsVariants(hlsMasterUrl, sourcePageUrl || vimeoUrl).catch(() => []);
  }

  if (hlsVariants.length === 0 && vimeoId) {
    const networkManifests = await captureVimeoNetworkManifests(vimeoId, sourcePageUrl);
    const masterFromNetwork = networkManifests.find((url) => /playlist\.m3u8/i.test(url)) || networkManifests[0];
    if (masterFromNetwork) {
      hlsMasterUrl = masterFromNetwork;
      hlsVariants = await extractHlsVariants(hlsMasterUrl, sourcePageUrl || vimeoUrl).catch(() => []);
      configSource = configSource || 'puppeteer-network';
    }
  }

  const hlsHeights = Array.from(
    new Set(hlsVariants.map((variant) => Number(variant.height || 0)).filter((height) => height > 0))
  ).sort((a, b) => b - a);

  const allHeights = Array.from(new Set([...progressiveHeights, ...hlsHeights, ...dashHeights])).sort((a, b) => b - a);
  const fhdAvailable = allHeights.some((height) => height >= 1000);
  const debug = {
    progressiveHeights,
    hlsHeights,
    dashHeights,
    configSource,
    configUrl,
    fhdAvailable,
    title: resolvedTitle,
    selectedFhdUrl: '',
    selectedHdUrl: '',
  };

  const resolved: Partial<Record<'fhd' | 'hd', VimeoResolvedStream>> = {};

  const buildProgressiveStream = (format: any, bucket: 'fhd' | 'hd'): VimeoResolvedStream => {
    const height = parseCandidateHeight(format) || Number(format.height || 0);
    const normalizedUrl = sanitizeStreamUrl(format.url, vimeoUrl) || format.url;
    return {
      bucket,
      url: normalizedUrl,
      sourceStreamUrl: normalizedUrl,
      height,
      width: format.width,
      type: 'mp4',
      streamSource: 'progressive-mp4',
      format,
      acodec: format.acodec,
      vcodec: format.vcodec,
      fps: format.fps,
      filesize: format.filesize || format.filesize_approx,
    };
  };

  const buildHlsStream = (variant: { url: string; width?: number; height?: number }, bucket: 'fhd' | 'hd'): VimeoResolvedStream => {
    const normalizedUrl = sanitizeStreamUrl(variant.url, hlsMasterUrl || vimeoUrl) || variant.url;
    return {
      bucket,
      url: normalizedUrl,
      sourceStreamUrl: normalizedUrl,
      height: Number(variant.height || 0),
      width: variant.width,
      type: 'm3u8',
      streamSource: hlsMasterUrl && configSource === 'ytdlp-hls' ? 'ytdlp-hls' : 'hls',
    };
  };

  const progressiveFhd = progressiveHeights.filter((height) => height >= 1000).sort((a, b) => b - a)[0];
  const progressiveHd = progressiveHeights.filter((height) => height >= 700 && height < 1000).sort((a, b) => b - a)[0]
    || progressiveHeights.filter((height) => height >= 600).sort((a, b) => b - a)[0];

  if (progressiveFhd && progressiveByHeight.has(progressiveFhd)) {
    resolved.fhd = buildProgressiveStream(progressiveByHeight.get(progressiveFhd), 'fhd');
  } else if (fhdAvailable) {
    const hlsFhd = pickVimeoHlsVariant(hlsVariants, 1080);
    if (hlsFhd?.height && hlsFhd.height >= 1000) {
      resolved.fhd = buildHlsStream(hlsFhd, 'fhd');
    }
  }

  if (progressiveHd && progressiveByHeight.has(progressiveHd)) {
    resolved.hd = buildProgressiveStream(progressiveByHeight.get(progressiveHd), 'hd');
  } else {
    const hlsHd = pickVimeoHlsVariant(hlsVariants, 720);
    if (hlsHd?.height && hlsHd.height >= 600) {
      resolved.hd = buildHlsStream(hlsHd, 'hd');
    }
  }

  if (resolved.fhd?.url) debug.selectedFhdUrl = resolved.fhd.url;
  if (resolved.hd?.url) debug.selectedHdUrl = resolved.hd.url;
  if (vimeoId) logVimeoQualityDiscovery(vimeoId, debug);

  return {
    vimeoId,
    title: resolvedTitle || title,
    thumbnail: sanitizeStreamUrl(playerConfig?.video?.thumbnail_url || thumbnail || '', vimeoUrl) || thumbnail,
    duration: Number(playerConfig?.video?.duration || duration || 0) || undefined,
    streams: resolved,
    debug,
  };
};

const brightcovePolicyCache = new Map<string, { expiresAt: number; policyKey: string }>();
const brightcoveMetadataCache = new Map<string, { expiresAt: number; info: any }>();
const brightcovePolicyInFlight = new Map<string, Promise<string>>();
const brightcoveMetadataInFlight = new Map<string, Promise<any>>();
const brightcoveMetadataTtlMs = 3 * 60 * 1000;

// Brightcove policy keys are public playback credentials embedded in each
// player's config.json. Keep a last-known-good key for the Bath & Body Works
// player so its videos still resolve when players.brightcove.net is slow or
// temporarily unreachable. A rejected key is refreshed from the live config.
const bundledBrightcovePolicyKeys = new Map<string, string>([
  [
    '6311996242001:default_default',
    'BCpkADawqM3eHsnivA0thG9l75psz8Bx4AyMKF8SdZSzD7GGt4gh7XK7yO6gQNN93TpRuY3okeOSZKG6Vq6iB4WB5vGwV-e5unw4zt3oF6_oQxOcXMc20I0iR2-xWpHF7eABbc6xkAB-7qDo',
  ],
]);

const getVimeoMetadata = async (vimeoUrl: string, sourcePageUrl = '') => {
  const cacheKey = `${vimeoUrl}|${String(sourcePageUrl || '')}`;
  const cached = vimeoMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const queryOptions = buildYtDlpQueryOptions(vimeoUrl, sourcePageUrl || undefined);
  const fetchMetadata = (options: Record<string, unknown>) =>
    withTimeout(
      youtubedl(vimeoUrl, {
        dumpSingleJson: true,
        ...options,
      } as any),
      VIMEO_YTDLP_TIMEOUT_MS,
      `Vimeo metadata for ${vimeoUrl}`
    );

  let info: any;
  try {
    info = await fetchMetadata(queryOptions);
  } catch (error: any) {
    const message = String(error?.message || error || '');
    if ((queryOptions as any).cookiesFromBrowser && /cookies|operation not permitted/i.test(message)) {
      const { cookiesFromBrowser: _cookiesFromBrowser, ...withoutCookies } = queryOptions as Record<string, unknown>;
      info = await fetchMetadata(withoutCookies);
    } else {
      throw error;
    }
  }

  vimeoMetadataCache.set(cacheKey, { expiresAt: Date.now() + vimeoMetadataTtlMs, info });
  return info;
};

const getBrightcovePolicyKey = async (accountId: string, playerId: string, forceRefresh = false): Promise<string> => {
  const normalizedPlayer = playerId.endsWith('_default') ? playerId : `${playerId}_default`;
  const cacheKey = `${accountId}:${normalizedPlayer}`;
  if (!forceRefresh) {
    const cached = brightcovePolicyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.policyKey;
    const bundledPolicyKey = bundledBrightcovePolicyKeys.get(cacheKey);
    if (bundledPolicyKey) {
      brightcovePolicyCache.set(cacheKey, {
        expiresAt: Date.now() + brightcoveMetadataTtlMs,
        policyKey: bundledPolicyKey,
      });
      return bundledPolicyKey;
    }
    const existingRequest = brightcovePolicyInFlight.get(cacheKey);
    if (existingRequest) return existingRequest;
  }

  const request = (async () => {
    const playerBaseUrl = `https://players.brightcove.net/${accountId}/${normalizedPlayer}`;
    // Current Brightcove Player 7 builds no longer necessarily embed the policy
    // key in index.min.js. The stable player configuration is the preferred source.
    try {
      const configResponse = await axios.get(`${playerBaseUrl}/config.json`, {
        timeout: 30000,
        httpsAgent: relaxedHttpsAgent,
        responseType: 'json',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json,*/*',
        },
      });
      const configPolicyKey = String(
        configResponse.data?.video_cloud?.policy_key ||
        configResponse.data?.videoCloud?.policyKey ||
        configResponse.data?.policy_key ||
        configResponse.data?.policyKey ||
        ''
      ).trim();
      if (configPolicyKey) {
        brightcovePolicyCache.set(cacheKey, {
          expiresAt: Date.now() + brightcoveMetadataTtlMs,
          policyKey: configPolicyKey,
        });
        return configPolicyKey;
      }
    } catch (error: any) {
      console.warn(`Brightcove player config fetch failed for ${cacheKey}:`, error?.message || error);
    }

    const playerJsUrl = `${playerBaseUrl}/index.min.js`;
    const response = await axios.get(playerJsUrl, {
      timeout: 30000,
      httpsAgent: relaxedHttpsAgent,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
    });
    const js = String(response.data || '');
    const policyKey =
      js.match(/policyKey["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1] ||
      js.match(/"policyKey"\s*:\s*"([^"]+)"/i)?.[1] ||
      js.match(/BCpk[A-Za-z0-9._~-]+/)?.[0] ||
      '';
    if (!policyKey) throw new Error('Brightcove policy key was not found for this player.');
    brightcovePolicyCache.set(cacheKey, { expiresAt: Date.now() + brightcoveMetadataTtlMs, policyKey });
    return policyKey;
  })();

  brightcovePolicyInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (brightcovePolicyInFlight.get(cacheKey) === request) brightcovePolicyInFlight.delete(cacheKey);
  }
};

const getBrightcoveMetadata = async (playerUrl: string) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) throw new Error('Invalid Brightcove player URL.');
  const normalizedPlayer = parsed.playerId.endsWith('_default') ? parsed.playerId : `${parsed.playerId}_default`;
  const cacheKey = `${parsed.accountId}:${normalizedPlayer}:${parsed.videoId}`;
  const cached = brightcoveMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const existingRequest = brightcoveMetadataInFlight.get(cacheKey);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    let policyKey = await getBrightcovePolicyKey(parsed.accountId, parsed.playerId);
    const playbackUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${parsed.accountId}/videos/${parsed.videoId}`;
    let response: any;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await axios.get(playbackUrl, {
          timeout: 30000,
          httpsAgent: relaxedHttpsAgent,
          validateStatus: (status) => status >= 200 && status < 500,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': `application/json;pk=${policyKey}`,
          },
        });
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          brightcovePolicyCache.delete(`${parsed.accountId}:${normalizedPlayer}`);
          policyKey = await getBrightcovePolicyKey(parsed.accountId, parsed.playerId, true);
          continue;
        }
        break;
      } catch (error) {
        if (attempt > 0) throw error;
      }
    }
    const info = response?.data || {};
    const playbackError = Array.isArray(info) ? info[0] : null;
    if (playbackError?.error_code || playbackError?.message) {
      const code = String(playbackError.error_code || 'PLAYBACK_ERROR');
      const message = String(playbackError.message || 'Brightcove could not load this video.');
      throw new Error(`Brightcove ${code}: ${message}`);
    }
    if (!response || response.status >= 400) {
      throw new Error(`Brightcove playback request failed with status ${response?.status || 'unknown'}.`);
    }
    brightcoveMetadataCache.set(cacheKey, { expiresAt: Date.now() + brightcoveMetadataTtlMs, info });
    return info;
  })();

  brightcoveMetadataInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (brightcoveMetadataInFlight.get(cacheKey) === request) brightcoveMetadataInFlight.delete(cacheKey);
  }
};

const getYouTubeVideoId = (rawUrl: string) => {
  try {
    const parsed = new URL(normalizeYouTubeWatchUrl(rawUrl));
    return parsed.searchParams.get('v') || '';
  } catch {
    return '';
  }
};

const getYouTubeDirectFormatSelector = (quality: string, watchUrl = '') => {
  const targetHeight = getVimeoTargetHeight(quality);
  const shorts = isYouTubeShortsUrl(watchUrl);
  if (shorts) {
    return [
      `best[width<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
      `best[height<=${targetHeight * 2}][width<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
      `best[ext=mp4][acodec!=none][vcodec!=none]`,
      `bestvideo[width<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${targetHeight * 2}][width<=${targetHeight}][ext=mp4]+bestaudio`,
    ].join('/');
  }
  return [
    `best[height=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[height<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[ext=mp4][acodec!=none][vcodec!=none]`,
    `bestvideo[height=${targetHeight}][ext=mp4]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]`,
  ].join('/');
};

/** Reference Videos-Downloader format selectors (yt-dlp direct download). */
const getReferenceVideoFormatSelector = (quality: string) => {
  const height = quality === 'hd' ? 720 : quality === '4k' ? 2160 : 1080;
  return [
    `bestvideo[height<=${height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio`,
    `best[height<=${height}][ext=mp4][vcodec!=none][acodec!=none]`,
    `best[height<=${height}][vcodec!=none][acodec!=none]`,
    'bestvideo+bestaudio',
    'best',
  ].join('/');
};

const getReferenceAudioFormatSelector = () => 'bestaudio[abr<=128]/bestaudio/best';

const getYouTubeMergeFormatSelector = (quality: string, _watchUrl = '') =>
  getReferenceVideoFormatSelector(quality);

const buildYouTubeFfmpegHeaders = (watchUrl: string) => {
  const headerLines = ['Referer: https://www.youtube.com/', 'Origin: https://www.youtube.com'];
  try {
    const parsed = new URL(normalizeYouTubeWatchUrl(watchUrl));
    headerLines[0] = `Referer: ${parsed.origin}/`;
  } catch {
    // Keep generic YouTube headers.
  }
  return `${headerLines.join('\r\n')}\r\n`;
};

const classifyYouTubeStreamUrl = (streamUrl: string) => {
  const lowered = String(streamUrl || '').toLowerCase();
  if (/mime=audio|%2faudio|acont=dash|itag=(139|140|141|171|249|250|251|599|600)/i.test(lowered)) return 'audio';
  if (/mime=video|%2fvideo|vcodec=|itag=(133|134|135|136|137|160|242|243|244|247|248|271|272|298|299|302|303|308|313|315|399|401|402)/i.test(lowered)) {
    return 'video';
  }
  return 'unknown';
};

const getYouTubeStreamParts = async (watchUrl: string, quality = 'fhd') => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const shorts = isYouTubeShortsUrl(watchUrl);
  const muxedFormat = shorts
    ? getYouTubeDirectFormatSelector(quality, watchUrl)
    : [
        `best[height=${targetHeight}][ext=mp4][vcodec^=avc1][acodec!=none]`,
        `best[height<=${targetHeight}][ext=mp4][vcodec^=avc1][acodec!=none]`,
        `best[height=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
        `best[height<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
        `best[ext=mp4][acodec!=none][vcodec!=none]`,
      ].join('/');

  try {
    const muxedRaw = await withTimeout(
      youtubedl(normalizedWatchUrl, {
        getUrl: true,
        format: muxedFormat,
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true,
      } as any),
      20000,
      `YouTube muxed stream for ${normalizedWatchUrl}`
    );
    const muxedUrl = sanitizeStreamUrl(
      String(Array.isArray(muxedRaw) ? muxedRaw[0] : muxedRaw || '').split(/\r?\n/)[0]?.trim(),
      normalizedWatchUrl
    );
    if (muxedUrl && !isExpiredStreamUrl(muxedUrl) && classifyYouTubeStreamUrl(muxedUrl) !== 'audio') {
      return { muxedUrl, videoUrl: muxedUrl, audioUrl: '' };
    }
  } catch {
    // Continue to split-stream merge path.
  }

  const splitFormat = shorts
    ? getYouTubeMergeFormatSelector(quality, watchUrl)
    : [
        `bestvideo[height=${targetHeight}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${targetHeight}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${targetHeight}]+bestaudio`,
      ].join('/');
  const splitRaw = await withTimeout(
    youtubedl(normalizedWatchUrl, {
      getUrl: true,
      format: splitFormat,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
    } as any),
    20000,
    `YouTube split streams for ${normalizedWatchUrl}`
  );
  const lines = String(Array.isArray(splitRaw) ? splitRaw.join('\n') : splitRaw || '')
    .split(/\r?\n/)
    .map((line) => sanitizeStreamUrl(line.trim(), normalizedWatchUrl))
    .filter((line) => line && !isExpiredStreamUrl(line));

  let videoUrl = lines.find((line) => classifyYouTubeStreamUrl(line) === 'video') || '';
  let audioUrl = lines.find((line) => classifyYouTubeStreamUrl(line) === 'audio') || '';

  if (!videoUrl && lines.length === 1 && classifyYouTubeStreamUrl(lines[0]) !== 'audio') {
    videoUrl = lines[0];
  }
  if (!audioUrl) {
    const audioRaw = await withTimeout(
      youtubedl(normalizedWatchUrl, {
        getUrl: true,
        format: 'bestaudio[ext=m4a]/bestaudio',
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true,
      } as any),
      15000,
      `YouTube audio stream for ${normalizedWatchUrl}`
    );
    audioUrl = sanitizeStreamUrl(
      String(Array.isArray(audioRaw) ? audioRaw[0] : audioRaw || '').split(/\r?\n/)[0]?.trim(),
      normalizedWatchUrl
    );
  }

  if (!videoUrl) throw new Error('No YouTube video stream was found for this quality.');
  if (!audioUrl) throw new Error('No YouTube audio stream was found for this video.');

  return { videoUrl, audioUrl, muxedUrl: '' };
};

const buildYouTubeFfmpegMergeCommand = (videoUrl: string, audioUrl: string, watchUrl: string, streaming = false) => {
  const headers = buildYouTubeFfmpegHeaders(watchUrl);
  const cmd = ffmpeg()
    .input(videoUrl)
    .inputOptions(['-headers', headers])
    .input(audioUrl)
    .inputOptions(['-headers', headers])
    .outputOptions([
      '-map 0:v:0',
      '-map 1:a:0',
      '-c copy',
      '-shortest',
      streaming ? '-movflags frag_keyframe+empty_moov+default_base_moof' : '-movflags +faststart',
      '-f mp4',
    ])
    .format('mp4');
  return cmd;
};

const mergeYouTubePartsToFile = async (videoUrl: string, audioUrl: string, outputPath: string, watchUrl: string) => {
  const headers = buildYouTubeFfmpegHeaders(watchUrl);
  logYouTubeMerge('ffmpeg-merge-start', {
    videoUrl: String(videoUrl || '').slice(0, 180),
    audioUrl: String(audioUrl || '').slice(0, 180),
    mergedOutputPath: outputPath,
  });
  const cmd = ffmpeg()
    .input(videoUrl)
    .inputOptions(['-headers', headers])
    .input(audioUrl)
    .inputOptions(['-headers', headers])
    .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c copy', '-shortest', '-movflags +faststart', '-f mp4'])
    .format('mp4');
  await waitForFfmpegFile(cmd, outputPath, 'YouTube stream-copy merge');
  logYouTubeMerge('ffmpeg-merge-complete', { mergedOutputPath: outputPath });
};

const youtubeMergeCacheDir = path.join(convertedVideoDir, 'youtube-merge-cache');

const getYouTubeMergeCachePath = (watchUrl: string, quality: string) => {
  const videoId = getYouTubeVideoId(watchUrl) || crypto.createHash('sha1').update(normalizeYouTubeWatchUrl(watchUrl)).digest('hex').slice(0, 12);
  return path.join(youtubeMergeCacheDir, `${videoId}-${quality}-h264.mp4`);
};

const mergeYouTubeWithYtDlp = async (watchUrl: string, quality: string, outputPath: string) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const outputTemplate = outputPath.replace(/\.mp4$/i, '.%(ext)s');
  const options = {
    ...buildYtDlpDownloadOptions(normalizedWatchUrl, quality, undefined, outputTemplate),
  };
  logYouTubeMerge('ytdlp-download-start', {
    watchUrl: normalizedWatchUrl,
    quality,
    mergedOutputPath: outputPath,
    ytdlpOptions: {
      format: options.format,
      mergeOutputFormat: options.mergeOutputFormat,
      ffmpegLocation: (options as any).ffmpegLocation,
      postprocessorArgs: (options as any).postprocessorArgs,
    },
  });
  try {
    const ytdlpOutput = await withTimeout(
      youtubedl(normalizedWatchUrl, options as any),
      10 * 60 * 1000,
      `YouTube yt-dlp merge for ${normalizedWatchUrl}`
    );
    logYouTubeMerge('ytdlp-download-output', {
      watchUrl: normalizedWatchUrl,
      quality,
      outputPreview: String(ytdlpOutput || '').slice(0, 500),
      mergedOutputPath: outputPath,
    });
  } catch (error: any) {
    logYouTubeMerge('ytdlp-download-failed', {
      watchUrl: normalizedWatchUrl,
      quality,
      error: error?.message || String(error),
      exitCode: error?.exitCode ?? error?.status ?? null,
      errno: error?.errno ?? null,
      code: error?.code ?? null,
      syscall: error?.syscall ?? null,
      path: error?.path ?? null,
      stderr: String(error?.stderr || error?.stdout || '').slice(0, 1200),
    });
    throw error;
  }
  return validateOutputFile(outputPath, 'YouTube merged download');
};

const mergeYouTubeWatchUrlToFile = async (watchUrl: string, quality: string, outputPath: string, titleHint = '') => {
  logYouTubeMerge('merge-start', { watchUrl, quality, mergedOutputPath: outputPath });
  const applyQuickTimePass = async () => {
    try {
      await validateOutputFile(outputPath, 'YouTube merged download');
      const probe = describeMediaProbe(await probeMediaFile(outputPath));
      if (isQuickTimeCompatibleProbe(probe)) {
        await ensureQuickTimeCompatibleMp4(outputPath, { titleHint, quality, outputPath });
        return;
      }
      await ensureQuickTimeCompatibleMp4(outputPath, { titleHint, quality, outputPath });
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.warn(`[QuickTime pass] Failed for ${outputPath}: ${msg}`);
      logYouTubeMerge('quicktime-pass-skipped', { outputPath, error: msg });
      await validateOutputFile(outputPath, 'YouTube merged download');
    }
  };
  try {
    const merged = await mergeYouTubeWithYtDlp(watchUrl, quality, outputPath);
    logYouTubeMerge('merge-ytdlp-success', { mergedOutputPath: outputPath });
    await applyQuickTimePass();
    return merged;
  } catch (ytdlpError: any) {
    logYouTubeMerge('merge-ytdlp-fallback', {
      watchUrl,
      quality,
      error: ytdlpError?.message || String(ytdlpError),
      exitCode: ytdlpError?.exitCode ?? ytdlpError?.status ?? null,
    });
    const parts = await getYouTubeStreamParts(watchUrl, quality);
    logYouTubeMerge('stream-parts', {
      watchUrl,
      quality,
      hasVideoUrl: Boolean(parts.videoUrl),
      hasAudioUrl: Boolean(parts.audioUrl),
      hasMuxedUrl: Boolean(parts.muxedUrl),
      videoUrl: String(parts.videoUrl || '').slice(0, 180),
      audioUrl: String(parts.audioUrl || '').slice(0, 180),
    });
    if (parts.audioUrl) {
      await mergeYouTubePartsToFile(parts.videoUrl, parts.audioUrl, outputPath, watchUrl);
      await applyQuickTimePass();
      return validateOutputFile(outputPath, 'YouTube merged download');
    }
    if (parts.muxedUrl) {
      const headers = buildYouTubeFfmpegHeaders(watchUrl);
      const cmd = ffmpeg(parts.muxedUrl).inputOptions(['-headers', headers]).outputOptions(['-c copy', '-movflags +faststart', '-f mp4']).format('mp4');
      await waitForFfmpegFile(cmd, outputPath, 'YouTube muxed copy');
      await applyQuickTimePass();
      return validateOutputFile(outputPath, 'YouTube merged download');
    }
    throw ytdlpError;
  } finally {
    try {
      const stat = await fsp.stat(outputPath);
      logYouTubeMerge('merge-complete', {
        watchUrl,
        quality,
        outputPath,
        size: stat.size,
      });
    } catch {
      // ignore missing stat
    }
  }
};

const pipeLocalVideoFile = async (
  req: express.Request,
  res: express.Response,
  filePath: string,
  options: { inline?: boolean; filename?: string } = {}
) => {
  const stat = await fsp.stat(filePath);
  const fileSize = stat.size;
  const preferredName = (options.filename || path.basename(filePath)).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120);
  const contentType = 'video/mp4';
  const disposition = `${options.inline ? 'inline' : 'attachment'}; filename="${preferredName || 'video.mp4'}"`;

  const setCommonHeaders = () => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
  };

  if (req.method === 'HEAD') {
    setCommonHeaders();
    res.setHeader('Content-Length', String(fileSize));
    return res.status(200).end();
  }

  setCommonHeaders();
  res.status(200);
  res.setHeader('Content-Length', String(fileSize));
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error: any) => {
    console.error('Local video stream read error:', error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream local video file.' });
    else res.end();
  });
  return stream.pipe(res);
};

const resolveYouTubeQuickTimeExportPath = async (
  watchUrl: string,
  quality: string,
  options: { titleHint?: string; sourcePageUrl?: string } = {}
) => {
  const title = String(options.titleHint || pageTitleFromUrl(watchUrl) || 'video').trim();
  const exportPath = path.join(
    resolveDownloadsTargetDir(options.sourcePageUrl || watchUrl),
    toQuickTimeVideoFilename(title, quality)
  );
  try {
    await validateOutputFile(exportPath, 'QuickTime export');
    return exportPath;
  } catch {
    return null;
  }
};

const pipeYouTubeMergedStream = async (
  req: express.Request,
  res: express.Response,
  watchUrl: string,
  quality: string,
  options: { inline?: boolean; filename?: string; titleHint?: string; sourcePageUrl?: string } = {}
) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const titleHint = String(options.titleHint || pageTitleFromUrl(normalizedWatchUrl) || 'video').trim();
  const existingExport = await resolveYouTubeQuickTimeExportPath(normalizedWatchUrl, quality, {
    titleHint,
    sourcePageUrl: options.sourcePageUrl || normalizedWatchUrl,
  });
  if (existingExport) {
    logYouTubeMerge('serve-existing-export', { watchUrl: normalizedWatchUrl, quality, existingExport });
    return pipeLocalVideoFile(req, res, existingExport, options);
  }

  await fsp.mkdir(youtubeMergeCacheDir, { recursive: true });
  const cachedPath = getYouTubeMergeCachePath(watchUrl, quality);
  try {
    await validateOutputFile(cachedPath, 'YouTube merge cache');
  } catch {
    await mergeYouTubeWatchUrlToFile(watchUrl, quality, cachedPath, titleHint);
  }

  return pipeLocalVideoFile(req, res, cachedPath, options);
};

const toYouTubeMergedDownloadUrl = (watchUrl: string, quality: string, titleHint?: string) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const filename = toQualityVideoFilename(quality, titleHint);
  return `/api/youtube-merged-stream?url=${encodeURIComponent(normalizedWatchUrl)}&quality=${quality}&inline=1&filename=${encodeURIComponent(filename)}`;
};

const toDisplayFilePath = (filePath: string) => {
  const resolved = path.resolve(String(filePath || ''));
  const home = os.homedir();
  if (resolved.startsWith(home + path.sep)) return `~${resolved.slice(home.length)}`;
  return resolved;
};

const prepareYouTubeQualityOutput = async (
  watchUrl: string,
  quality: string,
  options: {
    titleHint?: string;
    sourcePageUrl?: string;
    exportToDownloads?: boolean;
    forceLocalMerge?: boolean;
  } = {}
) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const title = String(options.titleHint || pageTitleFromUrl(normalizedWatchUrl) || 'video').trim();
  const internalPreviewUrl = toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title);
  const targetHeight = getVimeoTargetHeight(quality);

  if (!options.forceLocalMerge) {
    let directStreamUrl = '';
    try {
      const parts = await getYouTubeStreamParts(normalizedWatchUrl, quality);
      if (parts.muxedUrl && !isExpiredStreamUrl(parts.muxedUrl)) {
        directStreamUrl = parts.muxedUrl;
      }
    } catch {
      // Fall through to adaptive merge path.
    }

    if (directStreamUrl) {
      return {
        ok: true,
        watchUrl: normalizedWatchUrl,
        quality,
        mergeMode: 'direct' as const,
        isDirectProgressive: true,
        directStreamUrl,
        copyUrl: directStreamUrl,
        mediaUrl: directStreamUrl,
        localPath: '',
        downloadPath: '',
        internalPreviewUrl,
        previewStreamPath: internalPreviewUrl,
        title,
        resolution: `${targetHeight}p`,
        height: targetHeight,
        audioAvailable: true,
        hasAudio: true,
        noAudio: false,
        verifiedPlayable: true,
      };
    }
  }

  await fsp.mkdir(youtubeMergeCacheDir, { recursive: true });
  const cachedPath = getYouTubeMergeCachePath(normalizedWatchUrl, quality);
  try {
    await validateOutputFile(cachedPath, 'YouTube merge cache');
  } catch {
    await withTimeout(
      mergeYouTubeWatchUrlToFile(normalizedWatchUrl, quality, cachedPath, title),
      YOUTUBE_MERGE_TIMEOUT_MS,
      `YouTube merge for ${normalizedWatchUrl}`
    );
  }

  let exportPath = cachedPath;
  if (options.exportToDownloads) {
    const targetDir = resolveDownloadsTargetDir(options.sourcePageUrl || normalizedWatchUrl);
    await fsp.mkdir(targetDir, { recursive: true });
    exportPath = path.join(targetDir, toQualityVideoFilename(quality, title));
    try {
      await validateOutputFile(exportPath, 'QuickTime export');
    } catch {
      await fsp.copyFile(cachedPath, exportPath).catch(async () => {
        await fsp.copyFile(cachedPath, exportPath);
      });
      await ensureQuickTimeCompatibleMp4(exportPath, { titleHint: title, quality, outputPath: exportPath });
    }
  } else {
    await ensureQuickTimeCompatibleMp4(cachedPath, { titleHint: title, quality, outputPath: cachedPath });
    exportPath = cachedPath;
  }

  const probe = await verifyMergedYouTubeFile(exportPath);
  const stat = await fsp.stat(exportPath);
  const qtProbe = describeMediaProbe(await probeMediaFile(exportPath));

  return {
    ok: true,
    watchUrl: normalizedWatchUrl,
    quality,
    mergeMode: 'merged' as const,
    isDirectProgressive: false,
    directStreamUrl: '',
    copyUrl: toDisplayFilePath(exportPath),
    mediaUrl: toDisplayFilePath(exportPath),
    localPath: exportPath,
    downloadPath: exportPath,
    internalPreviewUrl,
    previewStreamPath: internalPreviewUrl,
    title,
    resolution: `${targetHeight}p`,
    height: targetHeight,
    size: stat.size,
    audioAvailable: true,
    hasAudio: true,
    noAudio: false,
    verifiedPlayable: true,
    quickTimeCompatible: isQuickTimeCompatibleProbe(qtProbe),
    ...probe,
  };
};

const buildYouTubeMergedCard = (watchUrl: string, quality: string, titleHint?: string, options: { isShorts?: boolean } = {}) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const isShorts = options.isShorts ?? isYouTubeShortsUrl(watchUrl);
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const title = titleHint || pageTitleFromUrl(normalizedWatchUrl);
  const portraitDims = isShorts
    ? { width: targetHeight, height: Math.round((targetHeight * 16) / 9) }
    : { width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : undefined, height: targetHeight };
  const internalPreviewUrl = toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title);
  return {
    url: normalizedWatchUrl,
    sourceStreamUrl: normalizedWatchUrl,
    sourceUrl: normalizedWatchUrl,
    pageUrl: normalizedWatchUrl,
    watchUrl: normalizedWatchUrl,
    internalPreviewUrl,
    previewStreamPath: internalPreviewUrl,
    provider: 'youtube',
    type: 'mp4',
    title,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : '',
    resolution: `${targetHeight}p`,
    height: portraitDims.height,
    width: portraitDims.width,
    isYouTubeShorts: isShorts,
    qualityRequested: quality,
    qualityExact: true,
    displayQualityKey: quality,
    displayQualityLabel: getCleanQualityLabel(quality),
    streamLabel: getCleanQualityLabel(quality),
    isYouTube: true,
    isDirect: false,
    isMp4Proxy: false,
    isYouTubeMerged: true,
    needsYouTubeMerge: true,
    audioAvailable: true,
    hasAudio: true,
    noAudio: false,
    verifiedPlayable: false,
    streamsPrepared: true,
  };
};

const youTubePreparedToVideoPayload = (prepared: any, quality: string, titleHint?: string) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(String(prepared?.watchUrl || ''));
  const isShorts = isYouTubeShortsUrl(normalizedWatchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const title = String(prepared?.title || titleHint || pageTitleFromUrl(normalizedWatchUrl) || 'video');
  const portraitDims = isShorts
    ? { width: targetHeight, height: Math.round((targetHeight * 16) / 9) }
    : { width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : undefined, height: targetHeight };
  const directStreamUrl = String(prepared?.directStreamUrl || '').trim();
  const localPath = String(prepared?.localPath || prepared?.downloadPath || '').trim();
  const mediaUrl = pickVariantMediaUrl({
    mediaUrl: prepared?.mediaUrl,
    copyUrl: prepared?.copyUrl,
    directStreamUrl,
    localPath,
    downloadPath: localPath,
  });
  const copyUrl = mediaUrl;
  const internalPreviewUrl = String(prepared?.internalPreviewUrl || prepared?.previewStreamPath || toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title));
  const isDirectProgressive = Boolean(prepared?.isDirectProgressive || prepared?.mergeMode === 'direct' || directStreamUrl);

  return {
    url: normalizedWatchUrl,
    copyUrl,
    mediaUrl,
    sourceStreamUrl: directStreamUrl || copyUrl || normalizedWatchUrl,
    sourceUrl: normalizedWatchUrl,
    pageUrl: normalizedWatchUrl,
    watchUrl: normalizedWatchUrl,
    directStreamUrl,
    localPath,
    downloadPath: localPath,
    internalPreviewUrl,
    previewStreamPath: internalPreviewUrl,
    mergeMode: prepared?.mergeMode || (isDirectProgressive ? 'direct' : 'merged'),
    isDirectProgressive,
    provider: 'youtube',
    type: 'mp4',
    title,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : '',
    resolution: prepared?.resolution || `${targetHeight}p`,
    height: prepared?.height || portraitDims.height,
    width: portraitDims.width,
    isYouTubeShorts: isShorts,
    qualityRequested: quality,
    qualityExact: true,
    displayQualityKey: quality,
    displayQualityLabel: getCleanQualityLabel(quality),
    streamLabel: getCleanQualityLabel(quality),
    isYouTube: true,
    isDirect: Boolean(copyUrl),
    isYouTubeDirect: isDirectProgressive,
    isMp4Proxy: false,
    isYouTubeMerged: true,
    needsYouTubeMerge: !isDirectProgressive,
    audioAvailable: prepared?.audioAvailable !== false,
    hasAudio: prepared?.hasAudio !== false,
    noAudio: prepared?.noAudio === true,
    verifiedPlayable: prepared?.verifiedPlayable !== false,
    size: prepared?.size,
    streamsPrepared: true,
  };
};

const scanYtDlpFormatAvailability = async (url: string, sourcePageUrl = '') => {
  const info: any = await withTimeout(
    youtubedl(url, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(url, sourcePageUrl),
      noPlaylist: true,
    } as any),
    YOUTUBE_FORMATS_TIMEOUT_MS,
    `Quality scan for ${url}`
  );
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const videoFormats = formats.filter((format: any) => String(format?.vcodec || '') !== 'none');
  const maxPixels = Math.max(
    0,
    ...videoFormats.map((format: any) => Math.max(Number(format?.height || 0), Number(format?.width || 0)))
  );
  const hasAudio =
    formats.some((format: any) => String(format?.acodec || '') !== 'none') ||
    videoFormats.some((format: any) => streamHasAudio(format));
  return {
    fhd: maxPixels >= 1080,
    hd: maxPixels >= 720,
    audio: hasAudio,
    title: String(info?.title || '').trim(),
    thumbnail: sanitizeStreamUrl(String(info?.thumbnail || ''), url) || '',
    duration: Number(info?.duration || 0) || undefined,
    info,
    formats,
  };
};

const buildUnifiedStreamsPayload = (
  variants: Record<string, any>,
  options: {
    audioReady?: boolean;
    watchUrl?: string;
    fhdAvailable?: boolean;
    hdAvailable?: boolean;
  } = {}
) => {
  const fhdVariant = variants.fhd;
  const hdVariant = variants.hd;
  const fhdMediaUrl = pickVariantMediaUrl(fhdVariant);
  const hdMediaUrl = pickVariantMediaUrl(hdVariant);
  const fhdReady =
    Boolean(fhdMediaUrl) ||
    (options.fhdAvailable !== false && Boolean(fhdVariant?.formatAvailable ?? fhdVariant));
  const hdReady =
    Boolean(hdMediaUrl) ||
    (options.hdAvailable !== false && Boolean(hdVariant?.formatAvailable ?? hdVariant));
  return {
    FHD: {
      mediaUrl: fhdMediaUrl,
      url: fhdMediaUrl,
      ready: fhdReady,
      resolution: String(fhdVariant?.resolution || '1080p'),
    },
    HD: {
      mediaUrl: hdMediaUrl,
      url: hdMediaUrl,
      ready: hdReady,
      resolution: String(hdVariant?.resolution || '720p'),
    },
    AUDIO: {
      mediaUrl: '',
      url: '',
      ready: options.audioReady !== false,
    },
  };
};

const buildYouTubeFormatVariant = (
  watchUrl: string,
  quality: string,
  titleHint: string,
  available: boolean,
  options: { isShorts?: boolean } = {}
) => {
  return {
    ...buildYouTubeMergedCard(watchUrl, quality, titleHint, options),
    formatAvailable: available,
    copyUrl: '',
    mediaUrl: '',
    verifiedPlayable: false,
    needsYouTubeMerge: true,
  };
};

const buildGenericPlatformFormatVariant = (
  targetUrl: string,
  quality: 'fhd' | 'hd',
  titleHint: string,
  available: boolean,
  provider: string
) => ({
  url: targetUrl,
  sourceUrl: targetUrl,
  sourceStreamUrl: '',
  provider,
  platform: provider,
  type: 'mp4',
  title: titleHint || pageTitleFromUrl(targetUrl),
  formatAvailable: available,
  copyUrl: '',
  mediaUrl: '',
  verifiedPlayable: false,
  qualityRequested: quality,
  displayQualityKey: quality,
  displayQualityLabel: getCleanQualityLabel(quality),
  resolution: quality === 'fhd' ? '1080p' : '720p',
});

const buildVimeoUnifiedCard = async (targetUrl: string, sourcePageUrl = targetUrl) => {
  const vimeoAssets = await withTimeout(
    extractVimeoVideos([targetUrl], 'fhd', sourcePageUrl),
    VIMEO_EXTRACT_TIMEOUT_MS,
    `Vimeo unified card for ${targetUrl}`
  ).catch(() => ({ videos: createVimeoSourceVideos([targetUrl]), images: [] as any[] }));

  const collapsed = collapseVimeoVideosForClient(vimeoAssets.videos || []);
  const card = collapsed[0];
  if (!card?.url) {
    return buildGenericPlatformUnifiedCard(targetUrl);
  }

  const variants = card.vimeoQualityVariants || card.qualityVariants || {};
  const enrichedVariants = Object.fromEntries(
    Object.entries(variants).map(([qualityKey, variant]: [string, any]) => {
      const mediaUrl = pickVariantMediaUrl(variant) || String(variant?.url || '').trim();
      return [
        qualityKey,
        mediaUrl
          ? { ...variant, mediaUrl, copyUrl: mediaUrl, sourceStreamUrl: variant?.sourceStreamUrl || mediaUrl, verifiedPlayable: true }
          : variant,
      ];
    })
  );
  const defaultKey = String(card.defaultQualityKey || (enrichedVariants.fhd ? 'fhd' : enrichedVariants.hd ? 'hd' : 'fhd'));
  const primary = enrichedVariants[defaultKey] || card;
  const streams = buildUnifiedStreamsPayload(enrichedVariants, {
    audioReady: card.audioAvailable !== false && card.noAudio !== true,
    fhdAvailable: Boolean(enrichedVariants.fhd),
    hdAvailable: Boolean(enrichedVariants.hd),
  });

  return {
    ...primary,
    ...card,
    title: String(card.title || primary?.title || '').trim() || 'Vimeo video',
    thumbnail: String(card.thumbnail || vimeoAssets.images?.[0]?.url || '').trim(),
    duration: card.duration || primary?.duration,
    durationSeconds: card.durationSeconds || card.duration || primary?.duration,
    qualityVariants: enrichedVariants,
    vimeoQualityVariants: enrichedVariants,
    defaultQualityKey: defaultKey,
    displayQualityKey: defaultKey,
    displayQualityLabel: getCleanQualityLabel(defaultKey),
    streamsPrepared: true,
    streams,
    platform: 'vimeo',
    provider: 'vimeo',
    isVimeo: true,
    audioAvailable: card.audioAvailable !== false,
    hasAudio: card.hasAudio !== false,
    noAudio: card.noAudio === true,
  };
};

const buildGenericPlatformUnifiedCard = async (targetUrl: string) => {
  const scan = await scanYtDlpFormatAvailability(targetUrl, targetUrl).catch(() => ({
    fhd: true,
    hd: true,
    audio: true,
    title: pageTitleFromUrl(targetUrl),
    thumbnail: '',
    duration: undefined as number | undefined,
  }));
  const provider = platformProviderFromUrl(targetUrl);
  const variants: Record<string, any> = {};
  const fhdAvailable = scan.fhd !== false;
  const hdAvailable = scan.hd !== false;
  if (fhdAvailable) {
    variants.fhd = buildGenericPlatformFormatVariant(targetUrl, 'fhd', scan.title, true, provider);
  }
  if (hdAvailable) {
    variants.hd = buildGenericPlatformFormatVariant(targetUrl, 'hd', scan.title, true, provider);
  }
  if (!variants.fhd && !variants.hd) {
    variants.hd = buildGenericPlatformFormatVariant(targetUrl, 'hd', scan.title, true, provider);
  }
  const defaultKey = variants.fhd ? 'fhd' : 'hd';
  const primary = variants[defaultKey];
  const streams = buildUnifiedStreamsPayload(variants, {
    audioReady: scan.audio !== false,
    fhdAvailable,
    hdAvailable,
  });
  return {
    ...primary,
    title: scan.title || primary.title,
    thumbnail: scan.thumbnail,
    duration: scan.duration,
    durationSeconds: scan.duration,
    qualityVariants: variants,
    vimeoQualityVariants: variants,
    defaultQualityKey: defaultKey,
    streamsPrepared: true,
    streams,
    platform: provider,
    provider,
    audioAvailable: scan.audio !== false,
    hasAudio: scan.audio !== false,
    noAudio: scan.audio === false,
  };
};

const captureIspotNetworkManifest = async (targetUrl: string) => {
  const manifests = new Set<string>();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await acquireSharedPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    page.on('response', (response) => {
      const url = response.url();
      if (/videos-cdn\.ispot\.tv\/.*\.m3u8(?:\?|$)/i.test(url)) manifests.add(url);
    });
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate(() => {
      const candidate = Array.from(document.querySelectorAll<HTMLElement>(
        'video, button, [role="button"], [class*="play"], [aria-label*="play" i], [title*="play" i]'
      )).find((element) => {
        const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.className || ''}`;
        return element.tagName === 'VIDEO' || /play|video|watch/i.test(label);
      });
      candidate?.click();
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await page.close().catch(() => undefined);
  } catch (error: any) {
    console.warn('iSpot network manifest capture failed:', error?.message || error);
  } finally {
    await releaseSharedPuppeteerBrowser();
  }
  return Array.from(manifests)[0] || '';
};

const buildIspotYtDlpUnifiedCard = async (
  targetUrl: string,
  fallback: { title?: string; thumbnail?: string } = {}
) => {
  const info: any = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(targetUrl, targetUrl),
      noPlaylist: true,
    } as any),
    45000,
    `iSpot yt-dlp fallback for ${targetUrl}`
  );

  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const requestedDownloads = Array.isArray(info?.requested_downloads) ? info.requested_downloads : [];
  const candidates = [
    ...formats,
    ...requestedDownloads,
    ...(info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, width: info.width, tbr: info.tbr }] : []),
  ]
    .map((candidate: any) => {
      const url = sanitizeStreamUrl(String(candidate?.url || ''), targetUrl);
      return url ? { ...candidate, url } : null;
    })
    .filter(Boolean)
    .filter((candidate: any) => !isExpiredStreamUrl(String(candidate.url)))
    .filter((candidate: any) => streamHasVideo(candidate))
    .filter((candidate: any) => {
      const raw = String(candidate.url || '');
      const ext = String(candidate.ext || '').toLowerCase();
      return (
        isLikelyDirectVideoStreamUrl(raw) ||
        isLikelyVideoAssetUrl(raw) ||
        ext === 'mp4' ||
        ext === 'm3u8'
      );
    });

  const selected =
    await firstValidStreamCandidate(sortCandidatesForQuality(candidates, 'fhd'), targetUrl, targetUrl) ||
    sortCandidatesForQuality(candidates, 'fhd')[0];
  if (!selected?.url) return null;

  const selectedHeight = selected.height || parseCandidateHeight(selected);
  const selectedWidth = selected.width || parseCandidateWidth(selected);
  const title =
    String(info?.title || fallback.title || '').trim() ||
    pageTitleFromUrl(targetUrl) ||
    'iSpot.tv video';
  const thumbnail =
    sanitizeStreamUrl(String(info?.thumbnail || fallback.thumbnail || ''), targetUrl) ||
    String(info?.thumbnail || fallback.thumbnail || '');
  const directUrl = String(selected.url);
  const type = getVideoFormatFromUrlOrType(directUrl, String(selected.contentType || selected.ext || ''));
  const qualityKey = selectedHeight && selectedHeight >= 1080 ? 'fhd' : selectedHeight && selectedHeight >= 720 ? 'hd' : 'best';

  return enforceMp4VideoPayload({
    url: directUrl,
    sourceStreamUrl: directUrl,
    sourceUrl: targetUrl,
    pageUrl: targetUrl,
    provider: 'ispot',
    platform: 'ispot',
    type: type || selected.ext || 'mp4',
    title,
    thumbnail,
    resolution: selectedHeight ? `${selectedHeight}p` : selected.format_note || 'Best Quality',
    width: selectedWidth,
    height: selectedHeight,
    qualityRequested: qualityKey,
    displayQualityKey: qualityKey,
    displayQualityLabel: qualityKey === 'fhd' ? 'FHD' : qualityKey === 'hd' ? 'HD' : 'Best Quality',
    hasAudio: streamHasAudio(selected),
    audioAvailable: streamHasAudio(selected),
    noAudio: !streamHasAudio(selected),
    isDirect: true,
    isDirectAsset: isDirectProgressiveVideoUrl(directUrl),
    verifiedPlayable: true,
    filesize: selected.filesize || selected.filesize_approx || selected.contentLength,
    formatId: selected.format_id || selected.id,
    fallbackSource: 'yt-dlp',
  });
};

const buildIspotUnifiedCard = async (targetUrl: string) => {
  const html = await withTimeout(fetchSiteHtml(targetUrl), 30000, `iSpot video discovery for ${targetUrl}`);
  const unescaped = String(html || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const title =
    unescaped.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ||
    unescaped.match(/<title[^>]*>([^<]+)/i)?.[1] ||
    pageTitleFromUrl(targetUrl);
  const thumbnail =
    unescaped.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1] ||
    '';
  const manifestMatch =
    unescaped.match(/https?:\/\/videos-cdn\.ispot\.tv\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/i) ||
    unescaped.match(/https?:\/\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/i);
  const manifestUrl =
    (manifestMatch?.[0] ? sanitizeStreamUrl(manifestMatch[0], targetUrl) : '') ||
    await captureIspotNetworkManifest(targetUrl);
  if (!manifestUrl) {
    const ytDlpFallback = await buildIspotYtDlpUnifiedCard(targetUrl, { title, thumbnail }).catch((error: any) => {
      console.warn('iSpot yt-dlp fallback failed:', error?.message || error);
      return null;
    });
    if (ytDlpFallback?.url) return ytDlpFallback;
    throw new Error('No downloadable iSpot.tv video stream was found on this ad page.');
  }

  const variants = await extractHlsVariants(manifestUrl, targetUrl).catch(() => []);
  const best = [...variants].sort((a, b) => Number(b.height || 0) - Number(a.height || 0))[0];
  const height = Number(best?.height || 0) || undefined;
  const streamUrl = String(best?.url || manifestUrl);

  return {
    url: streamUrl,
    sourceStreamUrl: streamUrl,
    sourceUrl: targetUrl,
    pageUrl: targetUrl,
    provider: 'ispot',
    platform: 'ispot',
    type: 'm3u8',
    title: String(title)
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim(),
    thumbnail: sanitizeStreamUrl(thumbnail, targetUrl) || thumbnail,
    resolution: height ? `${height}p` : 'Best Quality',
    height,
    qualityRequested: height && height >= 1080 ? 'fhd' : height && height >= 720 ? 'hd' : 'best',
    displayQualityKey: height && height >= 1080 ? 'fhd' : height && height >= 720 ? 'hd' : 'best',
    displayQualityLabel: height && height >= 1080 ? 'FHD' : height && height >= 720 ? 'HD' : 'Best Quality',
    hasAudio: true,
    audioAvailable: true,
    isDirect: true,
    verifiedPlayable: true,
  };
};

const buildBrightcoveDirectUnifiedCard = async (targetUrl: string) => {
  const brightcoveAssets = await extractBrightcoveVideos(targetUrl);
  const videoList = Array.isArray(brightcoveAssets.videos) ? brightcoveAssets.videos : [];
  const fhdVideo = videoList.find((video: any) => matchesStrictQuality(parseCandidateHeight(video), 'fhd'));
  const hdVideo = videoList.find((video: any) => matchesStrictQuality(parseCandidateHeight(video), 'hd'));
  const variants: Record<string, any> = {};
  if (fhdVideo?.url) {
    variants.fhd = {
      ...fhdVideo,
      formatAvailable: true,
      mediaUrl: fhdVideo.url,
      copyUrl: fhdVideo.url,
      verifiedPlayable: true,
    };
  }
  if (hdVideo?.url) {
    variants.hd = {
      ...hdVideo,
      formatAvailable: true,
      mediaUrl: hdVideo.url,
      copyUrl: hdVideo.url,
      verifiedPlayable: true,
    };
  }
  if (Object.keys(variants).length === 0) {
    return buildGenericPlatformUnifiedCard(targetUrl);
  }
  const defaultKey = variants.fhd ? 'fhd' : 'hd';
  const primary = variants[defaultKey];
  const thumbnail = primary.thumbnail || brightcoveAssets.images?.[0]?.url || '';
  const streams = buildUnifiedStreamsPayload(variants, {
    audioReady: true,
    fhdAvailable: Boolean(variants.fhd),
    hdAvailable: Boolean(variants.hd),
  });
  return {
    ...primary,
    thumbnail,
    qualityVariants: variants,
    defaultQualityKey: defaultKey,
    streamsPrepared: true,
    streams,
    platform: 'brightcove',
    provider: 'brightcove',
    sourceUrl: targetUrl,
  };
};

const buildDirectProgressiveUnifiedCard = (targetUrl: string) => {
  const variants = {
    fhd: {
      url: targetUrl,
      sourceUrl: targetUrl,
      sourceStreamUrl: targetUrl,
      provider: 'direct',
      platform: 'direct',
      type: 'mp4',
      isDirect: true,
      formatAvailable: true,
      mediaUrl: targetUrl,
      copyUrl: targetUrl,
      verifiedPlayable: true,
      qualityRequested: 'fhd',
      displayQualityKey: 'fhd',
      displayQualityLabel: 'FHD',
      resolution: '1080p',
      title: filenameFromAssetUrl(targetUrl).replace(/\.mp4$/i, ''),
    },
  };
  const streams = buildUnifiedStreamsPayload(variants, { audioReady: true, fhdAvailable: true, hdAvailable: false });
  return {
    ...variants.fhd,
    qualityVariants: variants,
    defaultQualityKey: 'fhd',
    streamsPrepared: true,
    streams,
  };
};

const enrichCardWithQualityCopyLink = (
  card: any,
  prepared: { copyUrl?: string; mediaUrl?: string; localPath?: string; downloadPath?: string; quickTimeCompatible?: boolean; size?: number },
  quality: 'fhd' | 'hd'
) => {
  const copyUrl = String(prepared.copyUrl || prepared.mediaUrl || '').trim();
  if (!copyUrl || !isCopyableStreamMediaUrl(copyUrl)) return card;
  const streamKey = quality === 'fhd' ? 'FHD' : 'HD';
  const qualityVariant = {
    ...(card.qualityVariants?.[quality] || {}),
    mediaUrl: copyUrl,
    copyUrl,
    localPath: prepared.localPath,
    downloadPath: prepared.downloadPath,
    verifiedPlayable: true,
    quickTimeCompatible: prepared.quickTimeCompatible !== false,
    formatAvailable: true,
  };
  return {
    ...card,
    ...(quality === 'fhd' ? { fhdCopyReady: true } : {}),
    quickTimeCompatible: prepared.quickTimeCompatible !== false,
    streams: {
      ...(card.streams || {}),
      [streamKey]: {
        ...(card.streams?.[streamKey] || {}),
        mediaUrl: copyUrl,
        url: copyUrl,
        ready: true,
      },
    },
    qualityVariants: {
      ...(card.qualityVariants || {}),
      [quality]: qualityVariant,
    },
    vimeoQualityVariants: {
      ...(card.vimeoQualityVariants || {}),
      [quality]: qualityVariant,
    },
  };
};

const enrichCardWithFhdCopyLink = (
  card: any,
  prepared: { copyUrl?: string; mediaUrl?: string; localPath?: string; downloadPath?: string; quickTimeCompatible?: boolean; size?: number }
) => enrichCardWithQualityCopyLink(card, prepared, 'fhd');

const resolveYouTubeDirectCopyUrlFast = async (
  watchUrl: string,
  quality: 'fhd' | 'hd',
  options: { titleHint?: string; sourcePageUrl?: string } = {}
) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const title = String(options.titleHint || pageTitleFromUrl(normalizedWatchUrl) || 'video').trim();
  try {
    const parts = await withTimeout(
      getYouTubeStreamParts(normalizedWatchUrl, quality),
      20000,
      `YouTube stream parts for ${normalizedWatchUrl}`
    );
    if (parts.muxedUrl && !isExpiredStreamUrl(parts.muxedUrl)) {
      return {
        copyUrl: parts.muxedUrl,
        mediaUrl: parts.muxedUrl,
        verifiedPlayable: true,
        quickTimeCompatible: false,
      };
    }
  } catch {
    // Fall through to existing QuickTime export lookup.
  }

  const exportPath = path.join(
    resolveDownloadsTargetDir(options.sourcePageUrl || normalizedWatchUrl),
    toQuickTimeVideoFilename(title, quality)
  );
  try {
    const existing = await validateOutputFile(exportPath, 'QuickTime export');
    const existingProbe = describeMediaProbe(await probeMediaFile(exportPath));
    if (isQuickTimeCompatibleProbe(existingProbe)) {
      return {
        copyUrl: toDisplayFilePath(exportPath),
        mediaUrl: toDisplayFilePath(exportPath),
        localPath: exportPath,
        downloadPath: exportPath,
        verifiedPlayable: true,
        quickTimeCompatible: true,
        size: existing.size,
      };
    }
  } catch {
    // No finished export yet.
  }

  return null;
};

const enrichDirectVideoCardStreams = async (targetUrl: string, card: any) => {
  if (isYouTubeUrl(targetUrl)) {
    const watchUrl = normalizeYouTubeWatchUrl(targetUrl);
    let enriched = card;
    for (const quality of ['fhd', 'hd'] as const) {
      if (!card?.qualityVariants?.[quality]?.formatAvailable) continue;
      try {
        const prepared =
          (await resolveYouTubeDirectCopyUrlFast(watchUrl, quality, {
            titleHint: String(card.title || ''),
            sourcePageUrl: targetUrl,
          })) ||
          (await withTimeout(
            prepareYouTubeQualityOutput(watchUrl, quality, {
              titleHint: String(card.title || ''),
              sourcePageUrl: targetUrl,
              exportToDownloads: true,
              forceLocalMerge: true,
            }),
            45000,
            `Resolve ${quality} stream for ${watchUrl}`
          ).catch(() => null));
        if (!prepared) continue;
        enriched = enrichCardWithQualityCopyLink(enriched, prepared, quality);
      } catch {
        // Leave this quality unavailable until the client resolves it.
      }
    }
    if (!enriched?.streams?.FHD?.mediaUrl && enriched?.qualityVariants?.fhd?.formatAvailable) {
      return { ...enriched, fhdCopyPending: true };
    }
    return enriched;
  }

  if (isBrightcoveUrl(targetUrl)) {
    return card;
  }

  return card?.qualityVariants?.fhd?.formatAvailable && !card?.streams?.FHD?.mediaUrl
    ? { ...card, fhdCopyPending: true }
    : card;
};

const materializeQuickTimeMp4ForDirectCopy = async (
  targetUrl: string,
  quality: string,
  options: { titleHint?: string; sourcePageUrl?: string } = {}
) => {
  const title = String(options.titleHint || pageTitleFromUrl(targetUrl) || 'video').trim();
  const targetDir = resolveDownloadsTargetDir(options.sourcePageUrl || targetUrl);
  await fsp.mkdir(targetDir, { recursive: true });
  const finalPath = path.join(targetDir, toQuickTimeVideoFilename(title, quality));

  try {
    const existing = await validateOutputFile(finalPath, 'QuickTime export');
    const existingProbe = describeMediaProbe(await probeMediaFile(finalPath));
    if (isQuickTimeCompatibleProbe(existingProbe)) {
      return {
        copyUrl: toDisplayFilePath(finalPath),
        mediaUrl: toDisplayFilePath(finalPath),
        localPath: finalPath,
        downloadPath: finalPath,
        quickTimeCompatible: true,
        size: existing.size,
      };
    }
  } catch {
    // Create a fresh QuickTime-safe export below.
  }

  const tempOutput = path.join(convertedVideoDir, `direct-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  await fsp.mkdir(convertedVideoDir, { recursive: true });
  await withTimeout(
    youtubedl(targetUrl, {
      ...buildYtDlpDownloadOptions(targetUrl, quality, options.sourcePageUrl, tempOutput),
    } as any),
    4 * 60 * 1000,
    `Direct QuickTime MP4 for ${targetUrl}`
  );
  await validateOutputFile(tempOutput, 'Direct platform download');
  const qt = await ensureQuickTimeCompatibleMp4(tempOutput, { titleHint: title, quality, outputPath: finalPath });
  const stat = await fsp.stat(qt.outputPath);
  return {
    copyUrl: toDisplayFilePath(qt.outputPath),
    mediaUrl: toDisplayFilePath(qt.outputPath),
    localPath: qt.outputPath,
    downloadPath: qt.outputPath,
    quickTimeCompatible: qt.quickTimeCompatible,
    size: stat.size,
  };
};

const attachDirectFhdQuickTimeCopy = async (targetUrl: string, card: any) => {
  if (!card?.streams?.FHD?.ready && !card?.qualityVariants?.fhd?.formatAvailable) return card;
  const title = String(card.title || pageTitleFromUrl(targetUrl) || 'video').trim();
  const targetDir = resolveDownloadsTargetDir(targetUrl);
  const exportPath = path.join(targetDir, toQuickTimeVideoFilename(title, 'fhd'));

  try {
    const existing = await validateOutputFile(exportPath, 'QuickTime export');
    const existingProbe = describeMediaProbe(await probeMediaFile(exportPath));
    if (isQuickTimeCompatibleProbe(existingProbe)) {
      return enrichCardWithFhdCopyLink(card, {
        copyUrl: toDisplayFilePath(exportPath),
        mediaUrl: toDisplayFilePath(exportPath),
        localPath: exportPath,
        downloadPath: exportPath,
        quickTimeCompatible: true,
        size: existing.size,
      });
    }
    await fsp.unlink(exportPath).catch(() => undefined);
  } catch {
    // No finished QuickTime export yet.
  }

  return { ...card, fhdCopyPending: true };
};

const buildDirectVideoExtractResponse = async (targetUrl: string) => {
  if (isDirectProgressiveVideoUrl(targetUrl)) {
    return {
      images: [],
      icons: [],
      videos: [buildDirectProgressiveUnifiedCard(targetUrl)],
      fonts: [],
      colors: [],
      extractionMeta: { route: 'direct-video', mode: 'direct', platform: 'direct' },
    };
  }

  if (!isPlatformVideoUrl(targetUrl)) {
    throw new Error(describeUnsupportedPlatformVideoUrl(targetUrl));
  }

  if (isPlaylistUrl(targetUrl)) {
    const playlistAssets = await extractPlaylistVideos(targetUrl);
    const cleanVideos = await prepareVisibleVideoStreams(playlistAssets.videos || [], targetUrl);
    return {
      images: [],
      icons: [],
      videos: cleanVideos,
      fonts: [],
      colors: [],
      playlist: playlistAssets.playlist,
      extractionMeta: { route: 'direct-video', mode: 'direct', platform: 'youtube' },
    };
  }

  let videoCard: any;
  if (isYouTubeUrl(targetUrl)) {
    videoCard = await buildYouTubeUnifiedCard(targetUrl, targetUrl);
  } else if (isVimeoUrl(targetUrl)) {
    videoCard = await buildVimeoUnifiedCard(targetUrl, targetUrl);
  } else if (isBrightcoveUrl(targetUrl)) {
    videoCard = await buildBrightcoveDirectUnifiedCard(targetUrl);
  } else if (isIspotUrl(targetUrl)) {
    videoCard = await buildIspotUnifiedCard(targetUrl);
  } else {
    videoCard = await buildGenericPlatformUnifiedCard(targetUrl);
  }

  return {
    images: [],
    icons: [],
    videos: [videoCard],
    fonts: [],
    colors: [],
    extractionMeta: {
      route: 'direct-video',
      mode: 'direct',
      platform: videoCard.platform || platformProviderFromUrl(targetUrl),
    },
  };
};

type VideoExtractorPlatform = 'youtube' | 'vimeo' | 'instagram' | 'facebook' | 'x' | 'ispot' | 'universal';

const runPlatformVideoExtractor = async (targetUrl: string, platform: VideoExtractorPlatform) => {
  const detected = platformProviderFromUrl(targetUrl);
  if (platform !== 'universal') {
    if (detected !== platform) {
      throw new Error(`URL appears to be ${detected || 'unsupported'}, not ${platform}.`);
    }
  }
  lastExtractedSourceUrl = targetUrl;
  lastExtractionSectionMode = false;
  if (platform === 'universal' && !isPlatformVideoUrl(targetUrl)) {
    const videoCard = await buildGenericPlatformUnifiedCard(targetUrl);
    return {
      images: [],
      icons: [],
      videos: [videoCard],
      fonts: [],
      colors: [],
      extractionMeta: {
        route: 'direct-video',
        mode: 'universal',
        platform: videoCard.platform || detected,
      },
    };
  }
  return buildDirectVideoExtractResponse(targetUrl);
};

const youtubeVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'youtube');
const vimeoVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'vimeo');
const instagramVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'instagram');
const facebookVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'facebook');
const xVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'x');
const ispotVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'ispot');
const universalVideoExtractor = (url: string) => runPlatformVideoExtractor(url, 'universal');

const finalizePlatformDownloadOutput = async (
  downloadedPath: string,
  desiredPath: string,
  options: { titleHint?: string; quality?: string; skipQuickTime?: boolean } = {}
) => {
  await fsp.mkdir(path.dirname(desiredPath), { recursive: true });
  if (path.resolve(downloadedPath) !== path.resolve(desiredPath)) {
    await fsp.copyFile(downloadedPath, desiredPath);
    await fsp.unlink(downloadedPath).catch(() => undefined);
  }
  if (!options.skipQuickTime && /\.mp4$/i.test(desiredPath)) {
    try {
      await withTimeout(
        ensureQuickTimeCompatibleMp4(desiredPath, {
          titleHint: options.titleHint,
          quality: options.quality,
          outputPath: desiredPath,
        }),
        90000,
        'QuickTime compatibility pass'
      );
    } catch (qtError: any) {
      await validateOutputFile(desiredPath, 'Downloaded video');
      logYouTubeMerge('quicktime-pass-accepted-existing', {
        desiredPath,
        error: qtError?.message || String(qtError),
      });
    }
  }
  const stat = await validateOutputFile(desiredPath, 'Downloaded video');
  return {
    outputPath: desiredPath,
    displayPath: toDisplayFilePath(desiredPath),
    size: stat.size,
  };
};

const findYtDlpOutputFile = async (tempDir: string, tempBase: string) => {
  const entries = await fsp.readdir(tempDir);
  const matches = entries
    .filter((name) => name.startsWith(tempBase) && !name.endsWith('.part') && !name.endsWith('.ytdl'))
    .map((name) => path.join(tempDir, name));
  if (matches.length === 0) return '';
  const stats = await Promise.all(
    matches.map(async (filePath) => {
      try {
        const stat = await fsp.stat(filePath);
        return stat.isFile() ? { filePath, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      } catch {
        return null;
      }
    })
  );
  const files = stats.filter(Boolean) as Array<{ filePath: string; mtimeMs: number; size: number }>;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return files[0]?.filePath || '';
};

const downloadVimeoPlatformVideoToFile = async (
  targetUrl: string,
  quality: string,
  options: {
    titleHint?: string;
    sourcePageUrl?: string;
    saveToWebsiteAssets?: boolean;
  } = {}
) => {
  const normalizedUrl = normalizeVimeoUrl(targetUrl) || String(targetUrl || '').trim();
  const vimeoId = parseVimeoIdFromUrl(normalizedUrl);
  if (!vimeoId) {
    throw new Error(describeUnsupportedPlatformVideoUrl(targetUrl));
  }
  assertPublicAssetUrl(normalizedUrl);

  const sourcePageUrl = String(options.sourcePageUrl || normalizedUrl).trim();
  const requestedQuality = ['hd', 'fhd', '4k'].includes(String(quality || '').toLowerCase())
    ? String(quality).toLowerCase()
    : 'fhd';
  const platform = 'vimeo';
  const targetDir = resolveVideoDownloadTargetDir(sourcePageUrl, options.saveToWebsiteAssets);
  await fsp.mkdir(targetDir, { recursive: true });

  const vimeoAssets = await withTimeout(
    extractVimeoVideos([normalizedUrl], requestedQuality, sourcePageUrl),
    VIMEO_EXTRACT_TIMEOUT_MS,
    `Vimeo download resolve for ${normalizedUrl}`
  );

  let streamVideo = vimeoAssets.videos.find(
    (video) =>
      video?.isVimeoDirect &&
      (video.displayQualityKey === requestedQuality || video.qualityRequested === requestedQuality)
  );
  if (!streamVideo && requestedQuality === 'fhd') {
    streamVideo = vimeoAssets.videos.find(
      (video) => video?.isVimeoDirect && (video.displayQualityKey === 'hd' || video.qualityRequested === 'hd')
    );
  }

  const title = String(
    options.titleHint ||
      streamVideo?.title ||
      vimeoAssets.videos.find((video) => video?.title)?.title ||
      pageTitleFromUrl(normalizedUrl) ||
      'video'
  ).trim();
  const desiredFilename = toQualityVideoFilename(requestedQuality, title);
  const desiredPath = path.join(targetDir, desiredFilename);

  try {
    const stat = await validateOutputFile(desiredPath, 'Existing download');
    return {
      ok: true,
      filePath: desiredPath,
      displayPath: toDisplayFilePath(desiredPath),
      size: stat.size,
      quality: requestedQuality,
      platform,
      reused: true,
    };
  } catch {
    // Download fresh copy.
  }

  if (!streamVideo?.url && isDirectProgressiveVideoUrl(targetUrl)) {
    streamVideo = {
      url: targetUrl,
      title,
      type: 'mp4',
      isVimeoDirect: true,
      hasAudio: true,
      audioAvailable: true,
      qualityFallback: true,
    };
  }
  if (!streamVideo?.url) {
    throw new Error('No downloadable Vimeo stream is available. The video may be private, embed-only, or region-locked.');
  }

  const streamUrl = sanitizeStreamUrl(String(streamVideo.url), sourcePageUrl) || String(streamVideo.url);
  const tempBase = `vimeo-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPath = path.join(os.tmpdir(), `${tempBase}.mp4`);

  if (streamVideo.isVimeoHls || /\.m3u8(?:\?|$)/i.test(streamUrl)) {
    const parsedStream = new URL(streamUrl);
    const { referer, origin } = getStreamRequestContext(parsedStream, sourcePageUrl || normalizedUrl);
    await withTimeout(
      transcodeUrlToMp4File(streamUrl, tempPath, referer, origin),
      YOUTUBE_MERGE_TIMEOUT_MS,
      `Vimeo HLS download for ${normalizedUrl}`
    );
  } else {
    await downloadUrlToFile(streamUrl, tempPath, sourcePageUrl || normalizedUrl);
  }

  const finalized = await finalizePlatformDownloadOutput(tempPath, desiredPath, {
    titleHint: title,
    quality: requestedQuality,
    skipQuickTime: false,
  });

  return {
    ok: true,
    filePath: finalized.outputPath,
    displayPath: finalized.displayPath,
    size: finalized.size,
    quality: requestedQuality,
    platform,
    reused: false,
  };
};

const downloadPlatformVideoToFile = async (
  targetUrl: string,
  quality: string,
  options: {
    titleHint?: string;
    sourcePageUrl?: string;
    mode?: 'video' | 'audio';
    maxDurationSeconds?: number;
    saveToWebsiteAssets?: boolean;
  } = {}
) => {
  const rawUrl = String(targetUrl || '').trim();
  if (isUnsupportedVideoResourceUrl(rawUrl)) {
    throw new Error('This URL is a player script/API resource, not a downloadable video.');
  }
  const normalizedUrl = isYouTubeUrl(rawUrl)
    ? normalizeYouTubeWatchUrl(rawUrl)
    : isVimeoUrl(rawUrl)
      ? (isDirectProgressiveVideoUrl(rawUrl) ? rawUrl : normalizeVimeoUrl(rawUrl) || rawUrl)
      : rawUrl;
  assertPublicAssetUrl(normalizedUrl);
  if (!isPlatformVideoUrl(normalizedUrl) && !isLikelyDirectVideoStreamUrl(normalizedUrl) && !isLikelyVideoAssetUrl(normalizedUrl)) {
    throw new Error('This URL is not a downloadable video.');
  }

  if (isVimeoUrl(normalizedUrl) && parseVimeoIdFromUrl(normalizedUrl) && options.mode !== 'audio') {
    return downloadVimeoPlatformVideoToFile(normalizedUrl, quality, options);
  }

  const title = String(options.titleHint || pageTitleFromUrl(normalizedUrl) || 'video').trim();
  const isAudio = options.mode === 'audio';
  const maxAudioDurationSeconds = isAudio
    ? Math.min(120, Math.max(1, Number(options.maxDurationSeconds || 120)))
    : undefined;
  const requestedQuality = ['hd', 'fhd', '4k'].includes(String(quality || '').toLowerCase())
    ? String(quality).toLowerCase()
    : 'fhd';
  const platform = platformProviderFromUrl(options.sourcePageUrl || normalizedUrl) || 'video';
  const targetDir = isAudio
    ? resolveDownloadSaveDir('audio', options.sourcePageUrl || normalizedUrl)
    : resolveVideoDownloadTargetDir(options.sourcePageUrl || normalizedUrl, options.saveToWebsiteAssets);
  await fsp.mkdir(targetDir, { recursive: true });
  const desiredFilename = isAudio
    ? `${toSafeFileBase(title)}_MP3_${maxAudioDurationSeconds}s.mp3`
    : toQualityVideoFilename(requestedQuality, title);
  const desiredPath = path.join(targetDir, desiredFilename);

  try {
    const stat = await validateOutputFile(desiredPath, 'Existing download');
    return {
      ok: true,
      filePath: desiredPath,
      displayPath: toDisplayFilePath(desiredPath),
      size: stat.size,
      quality: isAudio ? 'audio' : requestedQuality,
      platform: platformProviderFromUrl(normalizedUrl),
      reused: true,
    };
  } catch {
    // Download fresh copy.
  }

  const tempBase = `platform-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempTemplate = path.join(os.tmpdir(), `${tempBase}.%(ext)s`);
  const ydlOptions: Record<string, unknown> = {
    ...buildYtDlpQueryOptions(normalizedUrl, options.sourcePageUrl),
    ...buildYtDlpSpeedOptions(),
    output: tempTemplate,
    format: isAudio ? getReferenceAudioFormatSelector() : getReferenceVideoFormatSelector(requestedQuality),
    mergeOutputFormat: 'mp4',
    ...(isYouTubeUrl(normalizedUrl) ? { noPart: true, noContinue: true } : {}),
    ...(isAudio
      ? {
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: '128K',
          postprocessorArgs: `ffmpeg:-t ${maxAudioDurationSeconds}`,
        }
      : { postprocessorArgs: 'ffmpeg:-c copy -movflags +faststart' }),
  };

  await withTimeout(
    youtubedl(normalizedUrl, ydlOptions as any),
    YOUTUBE_MERGE_TIMEOUT_MS,
    `Platform download for ${normalizedUrl}`
  );

  let downloadedPath = await findYtDlpOutputFile(os.tmpdir(), tempBase);
  if (!downloadedPath) {
    try {
      const stat = await validateOutputFile(desiredPath, 'Downloaded video');
      return {
        ok: true,
        filePath: desiredPath,
        displayPath: toDisplayFilePath(desiredPath),
        size: stat.size,
        quality: isAudio ? 'audio' : requestedQuality,
        platform: platformProviderFromUrl(normalizedUrl),
        reused: false,
      };
    } catch {
      throw new Error('Download finished but output file was not found.');
    }
  }

  const finalized = await finalizePlatformDownloadOutput(downloadedPath, desiredPath, {
    titleHint: title,
    quality: requestedQuality,
    skipQuickTime: isAudio,
  });

  return {
    ok: true,
    filePath: finalized.outputPath,
    displayPath: finalized.displayPath,
    size: finalized.size,
    quality: isAudio ? 'audio' : requestedQuality,
    platform: platformProviderFromUrl(normalizedUrl),
    reused: false,
  };
};

const downloadDirectStreamVideoToFile = async (
  targetUrl: string,
  options: {
    titleHint?: string;
    sourcePageUrl?: string;
    quality?: string;
    saveToWebsiteAssets?: boolean;
  } = {}
) => {
  const normalizedUrl = sanitizeStreamUrl(String(targetUrl || '').trim(), options.sourcePageUrl) || String(targetUrl || '').trim();
  if (!normalizedUrl || !isDirectDownloadableVideoUrl(normalizedUrl)) {
    throw new Error('URL is not a direct downloadable video stream.');
  }
  assertPublicAssetUrl(normalizedUrl);

  const sourcePageUrl = String(options.sourcePageUrl || normalizedUrl).trim();
  lastExtractedSourceUrl = sourcePageUrl;
  lastExtractionSectionMode = false;
  const title = String(options.titleHint || pageTitleFromUrl(normalizedUrl) || 'video').trim();
  const requestedQuality = ['hd', 'fhd', '4k'].includes(String(options.quality || '').toLowerCase())
    ? String(options.quality).toLowerCase()
    : 'fhd';
  const targetDir = resolveVideoDownloadTargetDir(sourcePageUrl, options.saveToWebsiteAssets);
  await fsp.mkdir(targetDir, { recursive: true });
  const desiredFilename = toQualityVideoFilename(requestedQuality, title);
  const desiredPath = path.join(targetDir, desiredFilename);

  try {
    const stat = await validateOutputFile(desiredPath, 'Existing download');
    return {
      ok: true,
      filePath: desiredPath,
      displayPath: toDisplayFilePath(desiredPath),
      size: stat.size,
      quality: requestedQuality,
      platform: platformProviderFromUrl(normalizedUrl),
      reused: true,
    };
  } catch {
    // Download fresh copy.
  }

  await downloadUrlToFile(normalizedUrl, desiredPath, sourcePageUrl);
  const finalized = await finalizePlatformDownloadOutput(desiredPath, desiredPath, {
    titleHint: title,
    quality: requestedQuality,
    skipQuickTime: true,
  });

  return {
    ok: true,
    filePath: finalized.outputPath,
    displayPath: finalized.displayPath,
    size: finalized.size,
    quality: requestedQuality,
    platform: platformProviderFromUrl(normalizedUrl),
    reused: false,
  };
};

const listVideoDownloadFiles = async () => {
  const entries: Array<{
    name: string;
    platform: string;
    size: number;
    modifiedAt: number;
    path: string;
    displayPath: string;
    quality: string;
  }> = [];
  let dirNames: string[] = [];
  try {
    dirNames = await fsp.readdir(downloadsDir);
  } catch {
    return entries;
  }
  for (const dirName of dirNames) {
    if (!/_CreativeAssets$/i.test(dirName)) continue;
    const platform = dirName.replace(/_CreativeAssets$/i, '');
    const videosDir = path.join(downloadsDir, dirName, VIDEO_ASSET_SUBFOLDER);
    let files: string[] = [];
    try {
      files = await fsp.readdir(videosDir);
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (fileName.startsWith('.')) continue;
      const filePath = path.join(videosDir, fileName);
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) continue;
        entries.push({
          name: fileName,
          platform,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          path: filePath,
          displayPath: toDisplayFilePath(filePath),
          quality: /_FHD_/i.test(fileName)
            ? 'FHD'
            : /_HD_/i.test(fileName)
              ? 'HD'
              : /128|audio|\.m4a|\.mp3/i.test(fileName)
                ? 'Audio'
                : 'Video',
        });
      } catch {
        // skip unreadable file
      }
    }
  }
  return entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
};

const buildYouTubeUnifiedCard = async (targetUrl: string, sourcePageUrl = '') => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(targetUrl);
  const isShorts = isYouTubeShortsUrl(targetUrl);
  const [titleHint, scan] = await Promise.all([
    withTimeout(
      fetchYouTubeOEmbedTitle(normalizedWatchUrl),
      YOUTUBE_METADATA_TIMEOUT_MS,
      `YouTube metadata for ${normalizedWatchUrl}`
    ).catch(() => ''),
    scanYtDlpFormatAvailability(normalizedWatchUrl, sourcePageUrl || targetUrl).catch(() => ({
      fhd: true,
      hd: true,
      audio: true,
      title: '',
      thumbnail: '',
      duration: undefined as number | undefined,
    })),
  ]);
  const resolvedTitle = scan.title || titleHint;
  const variants: Record<string, any> = {};
  if (scan.fhd) {
    variants.fhd = buildYouTubeFormatVariant(normalizedWatchUrl, 'fhd', resolvedTitle, true, { isShorts });
  }
  if (scan.hd) {
    variants.hd = buildYouTubeFormatVariant(normalizedWatchUrl, 'hd', resolvedTitle, true, { isShorts });
  }

  const defaultKey = scan.fhd ? 'fhd' : scan.hd ? 'hd' : 'fhd';
  const primary =
    variants[defaultKey] ||
    buildYouTubeMergedCard(normalizedWatchUrl, defaultKey, resolvedTitle, { isShorts });
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const streams = buildUnifiedStreamsPayload(variants, {
    audioReady: scan.audio !== false,
    watchUrl: normalizedWatchUrl,
    fhdAvailable: scan.fhd,
    hdAvailable: scan.hd,
  });
  return {
    ...primary,
    title: resolvedTitle || primary.title,
    thumbnail:
      scan.thumbnail || primary.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : ''),
    duration: scan.duration,
    durationSeconds: scan.duration,
    qualityVariants: variants,
    vimeoQualityVariants: variants,
    defaultQualityKey: defaultKey,
    streamsPrepared: true,
    streams,
    platform: 'youtube',
    audioAvailable: scan.audio !== false,
    hasAudio: scan.audio !== false,
    noAudio: scan.audio === false,
    provider: 'youtube',
    isYouTube: true,
    isYouTubeMerged: true,
  };
};

const probeVideoQualityManifest = async (url: string, sourcePageUrl = '') => {
  const manifest: {
    fhd: boolean;
    hd: boolean;
    audio: boolean;
    title: string;
    thumbnail: string;
    duration?: number;
    variants: Record<string, any>;
  } = {
    fhd: false,
    hd: false,
    audio: false,
    title: '',
    thumbnail: '',
    variants: {},
  };

  if (isYouTubeUrl(url)) {
    const normalizedWatchUrl = normalizeYouTubeWatchUrl(url);
    const scan = await scanYtDlpFormatAvailability(normalizedWatchUrl, sourcePageUrl || url).catch(() => ({
      fhd: true,
      hd: true,
      audio: true,
      title: '',
      thumbnail: '',
      duration: undefined as number | undefined,
    }));
    manifest.fhd = scan.fhd;
    manifest.hd = scan.hd;
    manifest.audio = scan.audio !== false;
    manifest.title = scan.title;
    manifest.thumbnail = scan.thumbnail;
    manifest.duration = scan.duration;
    if (scan.fhd) {
      manifest.variants.fhd = buildYouTubeFormatVariant(normalizedWatchUrl, 'fhd', scan.title, true);
    }
    if (scan.hd) {
      manifest.variants.hd = buildYouTubeFormatVariant(normalizedWatchUrl, 'hd', scan.title, true);
    }
    return manifest;
  }

  const vimeoId = getVimeoIdFromVideoRecord({ url, sourceUrl: sourcePageUrl });
  if (vimeoId || isVimeoUrl(url)) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos([url], 'fhd', sourcePageUrl || url),
        45000,
        `Vimeo manifest for ${url}`
      );
      const collapsed = collapseVimeoVideosForClient(vimeoAssets.videos || []);
      const card = collapsed[0];
      if (card) {
        const variants = card.vimeoQualityVariants || card.qualityVariants || {};
        manifest.variants = variants;
        manifest.fhd = Boolean(variants.fhd);
        manifest.hd = Boolean(variants.hd);
        manifest.audio = card.audioAvailable !== false && card.noAudio !== true;
        manifest.title = String(card.title || '');
        manifest.thumbnail = String(card.thumbnail || '');
        manifest.duration = Number(card.duration || card.durationSeconds || 0) || undefined;
      }
    } catch {
      // fall through with empty manifest
    }
    return manifest;
  }

  try {
    const scan = await scanYtDlpFormatAvailability(url, sourcePageUrl || url);
    manifest.fhd = scan.fhd;
    manifest.hd = scan.hd;
    manifest.audio = scan.audio;
    manifest.title = scan.title;
    manifest.thumbnail = scan.thumbnail;
    manifest.duration = scan.duration;
  } catch {
    manifest.hd = true;
    manifest.audio = true;
  }
  return manifest;
};

type VideoQualityManifest = Awaited<ReturnType<typeof probeVideoQualityManifest>>;
const videoQualityManifestCache = new Map<string, { expiresAt: number; value: VideoQualityManifest }>();
const videoQualityManifestInFlight = new Map<string, Promise<VideoQualityManifest>>();

const getVideoQualityManifestFast = async (url: string, sourcePageUrl = '') => {
  const key = `${url}|${sourcePageUrl}`;
  const cached = videoQualityManifestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existing = videoQualityManifestInFlight.get(key);
  if (existing) return existing;

  const task = withTimeout(
    probeVideoQualityManifest(url, sourcePageUrl),
    10000,
    `Video manifest probe for ${url}`
  )
    .then((value) => {
      videoQualityManifestCache.set(key, { expiresAt: Date.now() + 2 * 60 * 1000, value });
      return value;
    })
    .finally(() => {
      videoQualityManifestInFlight.delete(key);
    });
  videoQualityManifestInFlight.set(key, task);
  return task;
};

const wrapYouTubePlaybackStream = (video: any, watchUrl: string, quality: string) => {
  if (!video?.url) return video;
  const streamUrl = sanitizeStreamUrl(String(video.sourceStreamUrl || video.url), watchUrl) || String(video.url);
  const hasMuxedAudio = streamHasAudio({ ...video, url: streamUrl, sourceStreamUrl: streamUrl });
  if (hasMuxedAudio && !isGoogleVideoPlaybackUrl(streamUrl)) {
    return {
      ...video,
      sourceStreamUrl: streamUrl,
      url: streamUrl,
      audioAvailable: true,
      noAudio: false,
      hasAudio: true,
    };
  }

  const mergedUrl = toYouTubeMergedDownloadUrl(watchUrl, quality, video?.title);
  return {
    ...video,
    sourceStreamUrl: streamUrl,
    url: mergedUrl,
    type: 'mp4',
    isDirect: true,
    isMp4Proxy: true,
    isYouTubeMerged: true,
    audioAvailable: true,
    noAudio: false,
    hasAudio: true,
    verifiedPlayable: true,
    qualityRequested: quality,
  };
};

const extractYouTubeVideoIdFromThumbnail = (thumbnail?: string) => {
  const match = String(thumbnail || '').match(
    /(?:i\.ytimg\.com|yt3(?:\.ggpht)?(?:\.com)?(?:\/googleusercontent)?)\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})(?:\/|[?#]|$)/i
  );
  return match?.[1] || '';
};

const attachYouTubeWatchUrlToVideos = (videos: any[]) => {
  const watchUrlsByVideoId = new Map<string, string>();
  videos.forEach((video) => {
    [video?.watchUrl, video?.sourceUrl, video?.pageUrl, video?.url]
      .filter(Boolean)
      .forEach((candidate) => {
        const value = String(candidate);
        if (!isYouTubeUrl(value)) return;
        const id = getYouTubeVideoId(value);
        if (id) watchUrlsByVideoId.set(id, normalizeYouTubeWatchUrl(value));
      });
  });

  return videos.map((video) => {
    const rawUrl = String(video?.url || video?.sourceStreamUrl || '');
    let watchUrl = video?.watchUrl ? normalizeYouTubeWatchUrl(String(video.watchUrl)) : '';
    if (!watchUrl && isYouTubeUrl(String(video?.sourceUrl || ''))) {
      watchUrl = normalizeYouTubeWatchUrl(String(video.sourceUrl));
    }
    const thumbId = extractYouTubeVideoIdFromThumbnail(video?.thumbnail);
    if (!watchUrl && thumbId) {
      watchUrl = watchUrlsByVideoId.get(thumbId) || `https://www.youtube.com/watch?v=${thumbId}`;
    }
    const provider =
      isGoogleVideoPlaybackUrl(rawUrl) || watchUrl || String(video?.provider || '').toLowerCase().includes('youtube')
        ? 'youtube'
        : video?.provider;
    const enriched = {
      ...video,
      ...(watchUrl ? { watchUrl, pageUrl: video?.pageUrl || watchUrl } : {}),
      ...(provider ? { provider } : {}),
    };
    if (isGoogleVideoPlaybackUrl(rawUrl) && watchUrl && !video?.isYouTubeMerged) {
      const payload = enforceMp4VideoPayload({
        ...enriched,
        sourceStreamUrl: rawUrl,
        url: rawUrl,
        acodec: enriched.acodec || 'none',
        hasAudio: false,
        audioAvailable: false,
        noAudio: true,
      });
      return wrapYouTubePlaybackStream(payload, watchUrl, String(video?.qualityRequested || 'fhd'));
    }
    return enriched;
  });
};

const resolveYouTubeDirectStream = async (rawUrl: string, quality: string) => {
  const normalizedUrl = normalizeYouTubeWatchUrl(rawUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const directUrl = await withTimeout(
    youtubedl(normalizedUrl, {
      getUrl: true,
      format: getYouTubeDirectFormatSelector(quality, rawUrl),
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
    } as any),
    20000,
    `YouTube direct ${targetHeight}p stream for ${rawUrl}`
  );
  const selectedUrl = sanitizeStreamUrl(
    String(Array.isArray(directUrl) ? directUrl[0] : directUrl || '').split(/\r?\n/)[0]?.trim(),
    rawUrl
  );
  if (!selectedUrl || isExpiredStreamUrl(selectedUrl) || !isLikelyDirectVideoStreamUrl(selectedUrl)) return null;
  const validation = await validateStreamUrl(selectedUrl, rawUrl);
  if (!validation.ok || !validation.url) return null;
  const videoId = getYouTubeVideoId(rawUrl);
  const isVideoOnly = isGoogleVideoPlaybackUrl(validation.url);
  const payload = enforceMp4VideoPayload({
    url: validation.url,
    sourceUrl: rawUrl,
    provider: 'YouTube',
    type: 'mp4',
    title: `YouTube ${targetHeight}p video`,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : '',
    resolution: `${targetHeight}p`,
    height: targetHeight,
    width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : undefined,
    filesize: validation.contentLength,
    acodec: isVideoOnly ? 'none' : undefined,
    hasAudio: !isVideoOnly,
    audioAvailable: !isVideoOnly,
    noAudio: isVideoOnly,
    isDirect: true,
    qualityRequested: quality,
  });
  return isVideoOnly ? wrapYouTubePlaybackStream(payload, rawUrl, quality) : payload;
};

const resolveYouTubeBestAvailableStream = async (rawUrl: string) => {
  for (const quality of ['fhd', 'hd']) {
    try {
      const stream = await resolveYouTubeDirectStream(rawUrl, quality);
      if (stream?.url) return stream;
    } catch (error: any) {
      console.warn(`YouTube ${quality} stream resolve failed:`, error.message || error);
    }
  }
  return null;
};

const pickVimeoFormat = (formats: any[], quality = 'fhd') => {
  const targetHeight = getVimeoTargetHeight(quality);
  const preferredFormats = formats.filter((format: any) => String(format.url).includes('/progressive_redirect/download/'));
  const pool = preferredFormats.length > 0 ? preferredFormats : formats;

  return pool
    .map((format: any) => ({
      format,
      distance: Math.abs((format.height || 0) - targetHeight),
      belowPenalty: (format.height || 0) < targetHeight ? 10000 : 0,
    }))
    .sort((a, b) => (a.distance + a.belowPenalty) - (b.distance + b.belowPenalty) || (b.format.tbr || 0) - (a.format.tbr || 0))[0]?.format;
};

const pickUniversalVideoFormat = (formats: any[], quality = 'fhd') => {
  const targetHeight = getVimeoTargetHeight(quality);
  const extRank = (ext: string) => {
    if (ext === 'mp4') return 0;
    if (ext === 'm3u8') return 1;
    if (ext === 'mpd') return 1;
    if (ext === 'mov') return 1;
    if (ext === 'webm') return 2;
    if (ext === 'mkv') return 3;
    return 4;
  };
  const candidates = formats
    .filter((format: any) => {
      const ext = String(format.ext || '').toLowerCase();
      const vcodec = String(format.vcodec || '');
      const url = String(format.url || '');
      const isPlayableSource =
        ext === 'mp4' ||
        ext === 'm3u8' ||
        ext === 'mpd' ||
        /\.(mp4|m3u8|mpd)(\?|$)/i.test(url);
      return (
        url &&
        vcodec !== 'none' &&
        isPlayableSource
      );
    })
    .map((format: any) => ({
      format,
      distance: Math.abs((format.height || 0) - targetHeight),
      belowPenalty: (format.height || 0) < targetHeight ? 10000 : 0,
      audioPenalty: String(format.acodec || '') === 'none' ? 500 : 0,
      extPenalty: extRank(String(format.ext || '').toLowerCase()) * 80,
    }))
    .sort(
      (a, b) =>
        (a.distance + a.belowPenalty + a.audioPenalty + a.extPenalty) - (b.distance + b.belowPenalty + b.audioPenalty + b.extPenalty) ||
        (b.format.tbr || 0) - (a.format.tbr || 0)
    );

  return candidates[0]?.format;
};

const getOriginalAudioOutput = (format: any) => {
  const ext = String(format?.ext || '').toLowerCase();
  const acodec = String(format?.acodec || '').toLowerCase();
  if (ext === 'webm' || acodec.includes('opus') || acodec.includes('vorbis')) {
    return { extension: 'webm', container: 'webm' };
  }
  if (ext === 'm4a' || ext === 'mp4' || /aac|mp4a|ac-?3|ec-?3|eac3|alac/.test(acodec)) {
    return { extension: 'm4a', container: 'mp4' };
  }
  return { extension: 'mka', container: 'matroska' };
};

const isDolbyLikeAudio = (format: any) => {
  const value = `${format?.acodec || ''} ${format?.format || ''} ${format?.format_note || ''}`.toLowerCase();
  return /dolby|e-?ac-?3|ec-?3|ac-?3|atmos/.test(value);
};

const resolveBestAudioStream = async (rawUrl: string, mode: AudioMode = 'turbo') => {
  const info: any = await withTimeout(
    youtubedl(rawUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
    } as any),
    30000,
    `Audio metadata for ${rawUrl}`
  );

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const preferredBitrate = mode === 'hq' ? 320 : 128;
  const selected = formats
    .filter((format: any) => {
      const url = String(format?.url || '');
      const acodec = String(format?.acodec || '');
      if (!url || acodec === 'none') return false;
      if (/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(url)) return false;
      return true;
    })
    .map((format: any) => ({
      format,
      audioOnlyPenalty: String(format?.vcodec || '') === 'none' ? 0 : 4000,
      extPenalty: mode === 'original'
        ? 0
        : ['m4a', 'mp4'].includes(String(format?.ext || '').toLowerCase()) ? 0 : String(format?.ext || '').toLowerCase() === 'webm' ? 120 : 500,
      bitrate: Number(format?.abr || format?.tbr || format?.bitrate || 0),
      channels: Number(format?.audio_channels || format?.channels || 0),
      dolbyPenalty: isDolbyLikeAudio(format) ? -10000 : 0,
    }))
    .sort((a, b) => {
      if (mode === 'original') {
        return (a.audioOnlyPenalty + a.dolbyPenalty) - (b.audioOnlyPenalty + b.dolbyPenalty) ||
          b.channels - a.channels ||
          b.bitrate - a.bitrate;
      }
      const aBitrate = a.bitrate || preferredBitrate;
      const bBitrate = b.bitrate || preferredBitrate;
      const aSpeedScore = Math.abs(aBitrate - preferredBitrate) + (aBitrate > preferredBitrate + 96 ? 90 : 0);
      const bSpeedScore = Math.abs(bBitrate - preferredBitrate) + (bBitrate > preferredBitrate + 96 ? 90 : 0);
      return (a.audioOnlyPenalty + a.extPenalty) - (b.audioOnlyPenalty + b.extPenalty) ||
        (mode === 'hq' ? bBitrate - aBitrate : aSpeedScore - bSpeedScore);
    })[0]?.format;

  const selectedUrl = selected?.url ? sanitizeStreamUrl(selected.url, rawUrl) : null;
  if (!selectedUrl) return null;
  return {
    url: selectedUrl,
    title: info.title || 'Audio',
    thumbnail: info.thumbnail || '',
    bitrate: selected.abr || selected.tbr || 192,
    acodec: selected.acodec,
    ext: selected.ext,
    formatId: selected.format_id || selected.itag || selected.id,
    audioChannels: Number(selected.audio_channels || selected.channels || 0) || undefined,
    isDolbyLike: isDolbyLikeAudio(selected),
    originalOutput: getOriginalAudioOutput(selected),
    isAudioOnly: String(selected.vcodec || '') === 'none',
  };
};

const isFacebookUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch';
  } catch {
    return false;
  }
};

const isInstagramUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return false;
  }
};

const YTDLP_FHD_POSTPROCESSOR_ARGS =
  'ffmpeg:-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 192k -pix_fmt yuv420p -movflags +faststart -threads 0';

const needsBrowserCookiesForUrl = (url: string) =>
  isFacebookUrl(url) || isInstagramUrl(url);

const isPackagedDesktopApp = () =>
  Boolean(String(process.env.VDX_RESOURCES_PATH || '').trim());

const buildYtDlpBaseOptions = () => ({
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  forceIpv4: true,
  ...(resolvedFfmpegPath ? { ffmpegLocation: path.dirname(String(resolvedFfmpegPath)) } : {}),
});

const buildYtDlpAuthOptions = (targetUrl: string) => {
  // Packaged apps cannot read Safari's protected cookie store without Full Disk Access.
  if (isPackagedDesktopApp()) return {};
  if (process.platform === 'darwin' && needsBrowserCookiesForUrl(targetUrl)) {
    return { cookiesFromBrowser: 'safari' };
  }
  return {};
};

const buildYtDlpRefererOptions = (targetUrl: string, sourcePageUrl?: string) => {
  if (isVimeoUrl(targetUrl)) {
    const refererPage = String(sourcePageUrl || targetUrl || '').trim();
    return { referer: refererPage || 'https://vimeo.com/' };
  }
  const refererPage = String(sourcePageUrl || '').trim();
  if (!refererPage) return {};
  try {
    const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    const refererHost = new URL(refererPage).hostname.replace(/^www\./, '').toLowerCase();
    if (refererHost !== targetHost) {
      return { referer: refererPage };
    }
  } catch {
    // Ignore malformed referer URLs.
  }
  return {};
};

const buildYtDlpSpeedOptions = () => {
  if (!aria2Path || !fs.existsSync(aria2Path)) return {};
  return {
    externalDownloader: 'aria2c',
    externalDownloaderArgs: 'aria2c:-x 16 -s 16 -k 1M',
    concurrentFragments: 16,
  };
};

const buildYtDlpQueryOptions = (targetUrl: string, sourcePageUrl?: string) => ({
  ...buildYtDlpBaseOptions(),
  ...buildYtDlpAuthOptions(targetUrl),
  ...buildYtDlpRefererOptions(targetUrl, sourcePageUrl),
});

const buildYtDlpDownloadOptions = (
  targetUrl: string,
  quality: string,
  sourcePageUrl?: string,
  output?: string
) => {
  const isYouTube = isYouTubeUrl(targetUrl);
  return {
    ...buildYtDlpQueryOptions(targetUrl, sourcePageUrl),
    ...buildYtDlpSpeedOptions(),
    ...(output ? { output } : {}),
    format: getReferenceVideoFormatSelector(quality),
    mergeOutputFormat: 'mp4',
    // Prevent flaky resume/partial-file state in tmp cache (seen as missing *.part errors).
    ...(isYouTube ? { noPart: true, noContinue: true } : {}),
    ...(isYouTube
      ? { postprocessorArgs: 'ffmpeg:-c copy -movflags +faststart' }
      : { postprocessorArgs: YTDLP_FHD_POSTPROCESSOR_ARGS }),
  };
};

const isXUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
};

const platformProviderFromUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('facebook.com') || host === 'fb.watch') return 'facebook';
    if (host === 'x.com' || host.includes('twitter.com')) return 'x';
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('googlevideo.com')) return 'youtube';
    if (host.includes('vimeo.com')) return 'vimeo';
    if (host.includes('wistia.com') || host.includes('wistia.net')) return 'wistia';
    if (host.includes('brightcove.net')) return 'brightcove';
    if (host === 'ispot.tv' || host.endsWith('.ispot.tv')) return 'ispot';
    if (host.includes('tiktok.com')) return 'tiktok';
    return 'platform';
  } catch {
    return 'platform';
  }
};

const describeUnsupportedPlatformVideoUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.includes('vimeo.com')) {
      if (!path || path === '/') {
        return 'That link is the Vimeo homepage. Paste a direct video URL like https://vimeo.com/123456789.';
      }
      if (path.startsWith('/ondemand/')) {
        return 'That is a Vimeo On Demand catalog page, not a single video. Open a video and copy its direct link.';
      }
      if (path.startsWith('/channels/') || path.startsWith('/groups/') || path.startsWith('/categories/')) {
        return 'That is a Vimeo browse page. Paste the URL of a specific video instead.';
      }
      if (!parseVimeoIdFromUrl(rawUrl) && path.split('/').filter(Boolean).length < 2) {
        return 'Paste a direct Vimeo video link (e.g. https://vimeo.com/123456789).';
      }
    }
    if (host.includes('youtube.com') && !parsed.searchParams.get('v') && !/\/(?:shorts|live|embed)\//.test(path)) {
      return 'Paste a direct YouTube watch link (e.g. https://www.youtube.com/watch?v=...).';
    }
  } catch {
    // Fall through to generic message.
  }
  return 'Paste a direct video link for this platform — not a homepage, channel, or catalog page.';
};

const isPlatformVideoUrl = (rawUrl: string) => {
  try {
    if (isUnsupportedVideoResourceUrl(rawUrl)) return false;
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl)) return true;
    if (host === 'youtu.be') return path.replace(/^\/+/, '').length > 0;
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return Boolean(parsed.searchParams.get('v')) || /\/(?:embed|shorts|live)\//.test(path);
    }
    if (host === 'player.vimeo.com') return /\/video\/\d+/.test(path) || /\/progressive_redirect\/download\/\d+/.test(path);
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      if (/\/progressive_redirect\/download\/\d+/.test(path)) return true;
      if (/^\/\d+(?:\/|$)/.test(path)) return true;
      if (/\.(ico|js|css|json)(\?|$)/i.test(path)) return false;
      if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/.test(path)) return false;
      const segments = path.split('/').filter(Boolean);
      return segments.length >= 2;
    }
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch') {
      return host === 'fb.watch' || /\/(?:watch|reel|videos?)\b|\/videos\//.test(path);
    }
    if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) return /\/status(?:es)?\//.test(path);
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return /\/(?:reel|reels|p|tv)\//.test(path);
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return /\/video\//.test(path);
    if (host === 'players.brightcove.net' || host.endsWith('.players.brightcove.net')) {
      return /\/index\.html$/i.test(path) && Boolean(parsed.searchParams.get('videoId'));
    }
    if (host.includes('wistia.com') || host.includes('wistia.net')) {
      return /\/(?:embed\/(?:medias|iframe)|medias)\/[a-z0-9]{8,12}/i.test(path);
    }
    if (host === 'ispot.tv' || host.endsWith('.ispot.tv')) return /^\/ad\/[^/]+\/[^/]+/.test(path);
    return false;
  } catch {
    return /(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl);
  }
};

const isVideoPlatformHostUrl = (rawUrl: string) => {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host === 'vimeo.com' ||
      host.endsWith('.vimeo.com') ||
      host === 'x.com' ||
      host === 'twitter.com' ||
      host.endsWith('.twitter.com') ||
      host === 'facebook.com' ||
      host.endsWith('.facebook.com') ||
      host === 'fb.watch' ||
      host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'tiktok.com' ||
      host.endsWith('.tiktok.com') ||
      host === 'players.brightcove.net' ||
      host.endsWith('.players.brightcove.net') ||
      host === 'ispot.tv' ||
      host.endsWith('.ispot.tv')
    );
  } catch {
    return false;
  }
};

const isLikelyVideoStoryPage = (rawUrl: string, html = '') => {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();
    const text = `${path}\n${String(html || '').slice(0, 250000)}`;
    return /video|watch|story|stories|family-stories|patient-stories|gallery|media/i.test(text);
  } catch {
    return /video|watch|story|stories|family-stories|patient-stories|gallery|media/i.test(`${rawUrl}\n${html}`);
  }
};

const isLikelyVideoAssetUrl = (rawUrl: string) => {
  const value = String(rawUrl || '').toLowerCase();
  if (!value) return false;
  if (isUnsupportedVideoResourceUrl(rawUrl)) return false;
  if (value.startsWith('data:')) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v|\.m3u8|\.mpd)(\?|$)/i.test(value)) return true;
  if (value.includes('wistia.com/deliveries/') || value.includes('wistia.net/deliveries/')) return true;
  if (value.includes('/videoplayback?') || value.includes('manifest') || value.includes('/video/')) return true;
  return false;
};

const isDirectProgressiveVideoUrl = (rawUrl: string) =>
  /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(rawUrl || ''));

const isDirectDownloadableVideoUrl = (rawUrl: string) => {
  if (!rawUrl) return false;
  if (isDirectProgressiveVideoUrl(rawUrl)) return true;
  return isLikelyDirectVideoStreamUrl(rawUrl);
};

const filenameFromAssetUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'video.mp4');
    return name.replace(/[\\/:*?"<>|]/g, '_') || 'video.mp4';
  } catch {
    return 'video.mp4';
  }
};

const heightToQualityKey = (height?: number) => {
  if (!height || height <= 0) return 'best';
  if (height >= 2160) return '4k';
  if (height >= 1440) return '2k';
  if (height >= 1080) return 'fhd';
  if (height >= 720) return 'hd';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return 'best';
};

const heightToQualityLabel = (height?: number) => {
  if (!height || height <= 0) return 'Best Quality';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return 'FHD';
  if (height >= 720) return 'HD';
  if (height >= 480) return 'SD';
  if (height >= 360) return '360p';
  return `${height}p`;
};

const probeRemoteVideoMetadata = async (sourceUrl: string, sourcePageUrl?: string) => {
  const headers = mediaRequestHeaders(sourceUrl, sourcePageUrl);
  const headerArg = `${Object.entries(headers)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')}\r\n`;
  return new Promise<any>((resolve, reject) => {
    ffmpeg(sourceUrl)
      .inputOptions(['-headers', headerArg])
      .ffprobe((error, metadata) => {
        if (error) reject(error);
        else resolve(metadata);
      });
  });
};

const buildDirectProgressiveVideoPayload = async (
  sourceUrl: string,
  req: express.Request,
  sourcePageUrl?: string,
  options: { cache?: boolean } = {}
) => {
  const normalizedUrl = sanitizeStreamUrl(sourceUrl, sourcePageUrl);
  if (!normalizedUrl || !isDirectProgressiveVideoUrl(normalizedUrl)) {
    throw new Error('URL is not a direct progressive video asset.');
  }
  assertPublicAssetUrl(normalizedUrl);

  const localFilename = filenameFromAssetUrl(normalizedUrl);
  const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
  const localPath = path.join(targetDir, localFilename);
  let stat: fs.Stats | null = null;
  let metadata: any = null;

  if (options.cache) {
    await fsp.mkdir(targetDir, { recursive: true });
    const existing = await fsp.stat(localPath).catch(() => null);
    if (!existing || existing.size <= 1024) {
      await downloadUrlToFile(normalizedUrl, localPath, sourcePageUrl);
    }
    stat = await validateOutputFile(localPath, 'Direct video cache');
    metadata = await probeMediaFile(localPath).catch(() => null);
  } else {
    try {
      metadata = await probeRemoteVideoMetadata(normalizedUrl, sourcePageUrl);
    } catch {
      await fsp.mkdir(targetDir, { recursive: true });
      const tempPath = path.join(targetDir, `.probe-${Date.now()}-${localFilename}`);
      try {
        await downloadUrlToFile(normalizedUrl, tempPath, sourcePageUrl);
        stat = await validateOutputFile(tempPath, 'Direct video probe');
        metadata = await probeMediaFile(tempPath);
        await fsp.rename(tempPath, localPath).catch(async () => {
          await fsp.copyFile(tempPath, localPath);
          await fsp.unlink(tempPath).catch(() => undefined);
        });
        stat = await fsp.stat(localPath);
      } finally {
        await fsp.unlink(tempPath).catch(() => undefined);
      }
    }
    if (!stat) {
      const validation = await validateStreamUrl(normalizedUrl, sourcePageUrl);
      stat = validation.contentLength ? ({ size: validation.contentLength } as fs.Stats) : null;
    }
  }

  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videoStream = streams.find((stream: any) => stream?.codec_type === 'video');
  const audioStream = streams.find((stream: any) => stream?.codec_type === 'audio');
  const height = Number(videoStream?.height || 0) || undefined;
  const width = Number(videoStream?.width || 0) || undefined;
  const duration = Number(metadata?.format?.duration || 0) || undefined;
  const bitrate = Number(metadata?.format?.bit_rate || videoStream?.bit_rate || 0) || undefined;
  const qualityKey = heightToQualityKey(height);
  const fileStat = stat || (await fsp.stat(localPath).catch(() => null));

  return {
    url: normalizedUrl,
    sourceStreamUrl: normalizedUrl,
    sourceUrl: sourcePageUrl || normalizedUrl,
    provider: platformProviderFromUrl(normalizedUrl),
    type: getVideoFormatFromUrlOrType(normalizedUrl),
    title: pageTitleFromUrl(normalizedUrl),
    localPath: fileStat ? localPath : undefined,
    downloadPath: fileStat ? localPath : undefined,
    localFilename,
    width,
    height,
    resolution: height ? `${height}p` : undefined,
    qualityRequested: qualityKey,
    qualityExact: true,
    displayQualityKey: qualityKey,
    displayQualityLabel: heightToQualityLabel(height),
    streamLabel: heightToQualityLabel(height),
    duration,
    filesize: fileStat?.size,
    bitrate,
    vcodec: videoStream?.codec_name,
    acodec: audioStream?.codec_name,
    hasAudio: Boolean(audioStream),
    audioAvailable: Boolean(audioStream),
    noAudio: !audioStream,
    isDirect: true,
    isDirectAsset: true,
    isLocalCached: Boolean(fileStat),
    verifiedPlayable: true,
    isMp4Proxy: false,
  };
};

const isLikelyDirectVideoStreamUrl = (rawUrl: string) => {
  if (!rawUrl) return false;
  const lowered = String(rawUrl).toLowerCase();
  if (isUnsupportedVideoResourceUrl(rawUrl)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(lowered)) return false;
  if (/i\.ytimg\.com|yt3\.ggpht\.com|twimg\.com\/media|fbcdn\.net\/.*\.(jpg|jpeg|png|webp)/i.test(lowered)) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv)(\?|$)/i.test(lowered)) return true;
  if (lowered.includes('googlevideo.com/videoplayback')) return true;
  if (lowered.includes('video.xx.fbcdn.net')) return true;
  if (lowered.includes('vimeo.com/progressive_redirect')) return true;
  if (/vimeocdn\.com|vod-adaptive\.akamaized\.net|cloudfront\.net.*\/packages\//i.test(lowered)) return true;
  if (lowered.includes('wistia.com/deliveries/') || lowered.includes('wistia.net/deliveries/')) return true;
  return false;
};

const matchesStrictQuality = (heightOrCandidate: any, quality: string, width?: number) => {
  const effective = getEffectiveVideoPixels(heightOrCandidate, width);
  if (!effective) return false;
  if (quality === 'hd') return effective >= 720;
  if (quality === 'fhd') return effective >= 1080;
  if (quality === '4k') return effective >= 2160;
  return true;
};

const parseCandidateHeight = (candidate: any): number | undefined => {
  const directHeight = Number(candidate?.height);
  if (Number.isFinite(directHeight) && directHeight > 0) return directHeight;

  const qualityLabel = String(
    candidate?.qualityLabel ||
    candidate?.format_note ||
    candidate?.format ||
    candidate?.resolution ||
    ''
  ).toLowerCase();
  const match = qualityLabel.match(/(\d{3,4})p/);
  if (match?.[1]) return Number(match[1]);

  return undefined;
};

const parseCandidateWidth = (candidate: any): number | undefined => {
  const directWidth = Number(candidate?.width);
  if (Number.isFinite(directWidth) && directWidth > 0) return directWidth;

  const resolution = String(candidate?.resolution || candidate?.format || '').toLowerCase();
  const match = resolution.match(/(\d{3,4})x(\d{3,4})/);
  if (match?.[1]) return Number(match[1]);
  return undefined;
};

const getQualityTarget = (quality: string) => {
  if (quality === 'fhd') return { width: 1920, height: 1080, label: 'FHD' };
  if (quality === '4k') return { width: 3840, height: 2160, label: '4K' };
  return { width: 1280, height: 720, label: 'HD' };
};

const qualityCandidateScore = (candidate: any, quality: string) => {
  const target = getQualityTarget(quality);
  const height = parseCandidateHeight(candidate);
  const width = parseCandidateWidth(candidate);
  const heightDistance = height ? Math.abs(height - target.height) : 5000;
  const widthDistance = width ? Math.abs(width - target.width) / 2 : 0;
  const belowPenalty = height && height < target.height ? 250 : 0;
  const videoOnlyPenalty = String(candidate?.acodec || candidate?.audioCodec || '') === 'none' ? 35 : 0;
  const container = String(candidate?.ext || candidate?.container || '').toLowerCase();
  const containerPenalty = container === 'mp4' ? 0 : container === 'webm' ? 120 : 300;
  const protocol = String(candidate?.protocol || '').toLowerCase();
  const protocolPenalty = protocol.includes('m3u8') || String(candidate?.url || '').includes('.m3u8') ? 500 : 0;
  const exactBonus = matchesStrictQuality(height, quality) ? -1000 : 0;
  return heightDistance * 12 + widthDistance + belowPenalty + videoOnlyPenalty + containerPenalty + protocolPenalty + exactBonus;
};

const sortCandidatesForQuality = (candidates: any[], quality: string) =>
  [...candidates].sort(
    (a, b) =>
      qualityCandidateScore(a, quality) - qualityCandidateScore(b, quality) ||
      Number(b?.tbr || b?.bitrate || b?.abr || 0) - Number(a?.tbr || a?.bitrate || a?.abr || 0)
  );

const cleanQualityOrder: Record<string, number> = {
  best: 0,
  fhd: 1,
  hd: 2,
  '480p': 3,
  '360p': 4,
  audio: 5,
};

const streamHasAudio = (candidate: any) => {
  const acodec = String(candidate?.acodec || candidate?.audioCodec || '').toLowerCase();
  const streamUrl = String(candidate?.sourceStreamUrl || candidate?.url || '');
  if (candidate?.audioAvailable === false || candidate?.noAudio) return false;
  if (candidate?.audioAvailable === true) return true;
  if (candidate?.hasAudio === true) return true;
  if (acodec === 'none') return false;
  if (acodec && acodec !== 'unknown') return true;
  if (isGoogleVideoPlaybackUrl(streamUrl)) return false;
  return candidate?.isYouTubeDirect ? false : true;
};

const streamHasVideo = (candidate: any) => {
  const vcodec = String(candidate?.vcodec || candidate?.videoCodec || '').toLowerCase();
  if (vcodec === 'none') return false;
  return true;
};

const getCleanQualityKey = (candidate: any) => {
  if (!streamHasVideo(candidate)) return 'audio';
  const height = parseCandidateHeight(candidate);
  if (!height || height > 1080) return 'best';
  if (height >= 900) return 'fhd';
  if (height >= 600) return 'hd';
  if (height >= 400) return '480p';
  if (height >= 300) return '360p';
  return 'best';
};

const getCleanQualityLabel = (qualityKey: string) => {
  if (qualityKey === 'fhd') return 'FHD';
  if (qualityKey === 'hd') return 'HD';
  if (qualityKey === '480p') return '480p';
  if (qualityKey === '360p') return '360p';
  if (qualityKey === 'audio') return 'Audio Only';
  return 'Best Quality';
};

const isTechnicalOrUnsupportedStream = (candidate: any) => {
  const raw = String(candidate?.url || '').toLowerCase();
  const type = String(candidate?.type || candidate?.ext || '').toLowerCase();
  const note = String(candidate?.formatNote || candidate?.format_note || candidate?.format || candidate?.resolution || '').toLowerCase();
  if (!raw) return true;
  if (isUnsupportedVideoResourceUrl(raw)) return true;
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif|js|css|json)(\?|$)/i.test(raw)) return true;
  if (/storyboard|thumbnail|sprite|dash fragment|fragmented|metadata|manifest|m3u8|mpd/i.test(note)) return true;
  if (type === 'm3u8' || type === 'mpd') return true;
  if (/\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\/manifest|dash\+xml/i.test(raw)) return true;
  return false;
};

const displayStreamRank = (candidate: any) => {
  const raw = String(candidate?.url || '');
  const type = String(candidate?.type || candidate?.ext || '').toLowerCase();
  const isMp4 = type === 'mp4' || /\.mp4(\?|$)/i.test(raw) || raw.includes('googlevideo.com/videoplayback') || raw.includes('vimeo.com/progressive_redirect');
  const hasAudio = streamHasAudio(candidate);
  const direct = candidate?.isDirect || candidate?.isVimeoDirect || candidate?.isWistiaDirect || candidate?.isYouTubeDirect || isLikelyDirectVideoStreamUrl(raw);
  const bitrate = Number(candidate?.tbr || candidate?.bitrate || candidate?.filesize || candidate?.filesize_approx || 0);
  return (isMp4 ? 10_000 : 0) + (hasAudio ? 4_000 : 0) + (direct ? 1_000 : 0) + Math.min(900, bitrate / 10_000);
};

const getStreamSourceIdentity = (candidate: any, fallbackUrl: string) => {
  const sourceRaw = String(candidate?.sourceUrl || candidate?.pageUrl || candidate?.originalUrl || fallbackUrl || '');
  const candidateRaw = String(candidate?.url || '');
  const useSourceIdentity = sourceRaw && isPlatformVideoUrl(sourceRaw);
  const raw = useSourceIdentity ? sourceRaw : (candidateRaw || sourceRaw);
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return `youtube:${getYouTubeVideoId(raw) || parsed.pathname}`;
    if (host.includes('vimeo.com')) {
      const match = parsed.pathname.match(/\/(?:video\/)?(\d+)/) || parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/);
      return `vimeo:${match?.[1] || parsed.pathname.replace(/\/+$/, '')}`;
    }
    if (host === 'x.com' || host.includes('twitter.com')) {
      const match = parsed.pathname.match(/\/status(?:es)?\/(\d+)/);
      return `x:${match?.[1] || parsed.pathname}`;
    }
    if (host.includes('facebook.com') || host === 'fb.watch') return `facebook:${parsed.pathname.replace(/\/+$/, '')}`;
    if (host.includes('instagram.com')) return `instagram:${parsed.pathname.replace(/\/+$/, '')}`;
    if (host.includes('brightcove.net')) {
      const parsedBrightcove = parseBrightcovePlayerUrl(parsed.href);
      return parsedBrightcove
        ? `brightcove:${parsedBrightcove.accountId}:${parsedBrightcove.videoId}`
        : `brightcove:${parsed.pathname.replace(/\/+$/, '')}`;
    }
    if (host.includes('wistia.com') || host.includes('wistia.net')) {
      const match = parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
      if (match?.[1]) return `wistia:${match[1]}`;
      if (candidate?.wistiaHashedId) return `wistia:${candidate.wistiaHashedId}`;
    }
    parsed.search = '';
    parsed.hash = '';
    return `${host}${parsed.pathname}`;
  } catch {
    return raw;
  }
};

const normalizeVisibleVideoStreams = (videos: any[], sourcePageUrl = '') => {
  const candidates = (Array.isArray(videos) ? videos : [])
    .map((video) => sanitizeVideoForClient(video, sourcePageUrl))
    .filter(Boolean)
    .filter((video: any) => {
      const url = String(video?.url || '');
      const isPagePlaceholder = isPlatformVideoUrl(url) && !isLikelyVideoAssetUrl(url) && !isLikelyDirectVideoStreamUrl(url);
      const sourceUrl = String(video?.sourceUrl || video?.pageUrl || sourcePageUrl || '');
      const isSilentDirectPlatformVideo =
        streamHasVideo(video) &&
        !streamHasAudio(video) &&
        (isYouTubeUrl(sourceUrl) || isXUrl(sourceUrl) || isFacebookUrl(sourceUrl) || isInstagramUrl(sourceUrl)) &&
        (isLikelyDirectVideoStreamUrl(url) || isLikelyVideoAssetUrl(url));
      if (video?.isVimeo && !video?.isVimeoDirect) {
        const vimeoUrl = String(video?.url || video?.sourceUrl || '');
        return isPlatformVideoUrl(vimeoUrl);
      }
      if (video?.isWistia && !video?.isWistiaDirect) return true;
      if (isTechnicalOrUnsupportedStream(video) && !isPagePlaceholder) return false;
      if (!streamHasVideo(video) && getCleanQualityKey(video) !== 'audio') return false;
      if (!streamHasAudio(video) && streamHasVideo(video)) {
        // Keep platform placeholders, but hide video-only technical renditions from the initial card list.
        return isPagePlaceholder || isSilentDirectPlatformVideo;
      }
      return true;
    });

  const hasResolvedPlayableVideo = candidates.some((video: any) => {
    const url = String(video?.sourceStreamUrl || video?.url || '');
    return !video?.unresolvable && (
      video?.isDirect ||
      video?.isVimeoDirect ||
      video?.isWistiaDirect ||
      video?.isYouTubeDirect ||
      isLikelyDirectVideoStreamUrl(url) ||
      isLikelyVideoAssetUrl(url)
    );
  });
  const visibleCandidates = hasResolvedPlayableVideo
    ? candidates.filter((video: any) => !video?.unresolvable)
    : candidates;

  const totalAvailable = visibleCandidates.length;
  const grouped = new Map<string, any>();
  visibleCandidates.forEach((video: any) => {
    const qualityKey = getCleanQualityKey(video);
    const sourceIdentity = getStreamSourceIdentity(video, sourcePageUrl);
    const groupKey = `${sourceIdentity}:${qualityKey}`;
    const normalized = {
      ...video,
      displayQualityKey: qualityKey,
      displayQualityLabel: getCleanQualityLabel(qualityKey),
      streamLabel: getCleanQualityLabel(qualityKey),
      audioAvailable: streamHasAudio(video),
      noAudio: !streamHasAudio(video),
      availableFormats: totalAvailable,
    };
    const current = grouped.get(groupKey);
    if (!current || displayStreamRank(normalized) > displayStreamRank(current)) {
      grouped.set(groupKey, normalized);
    }
  });

  const sorted = Array.from(grouped.values())
    .sort((a, b) => {
      const aHeight = parseCandidateHeight(a);
      const bHeight = parseCandidateHeight(b);
      if (aHeight && bHeight && aHeight !== bHeight) return bHeight - aHeight;
      return (
        (cleanQualityOrder[a.displayQualityKey] ?? 99) - (cleanQualityOrder[b.displayQualityKey] ?? 99) ||
        displayStreamRank(b) - displayStreamRank(a)
      );
    });
  const isPlatformStreamSet = isPlatformVideoUrl(sourcePageUrl) || sorted.some((video: any) => {
    const source = String(video?.sourceUrl || video?.pageUrl || '').toLowerCase();
    if (source.includes('wistia.com') || source.includes('wistia.net')) return false;
    return isPlatformVideoUrl(source);
  });
  const isVimeoStreamSet = isVimeoUrl(sourcePageUrl) || sorted.some((video: any) => {
    const provider = String(video?.provider || '').toLowerCase();
    const source = String(video?.sourceUrl || video?.url || '').toLowerCase();
    return provider.includes('vimeo') || source.includes('vimeo.com');
  });
  const visibleSorted = isPlatformStreamSet
    ? sorted.filter((video: any) => ['best', 'fhd', 'hd', 'audio'].includes(video.displayQualityKey))
    : sorted;
  const finalSorted = visibleSorted.length > 0 ? visibleSorted : sorted.slice(0, 2);
  const playlistLike = finalSorted.length > 6 && finalSorted.some((video: any) => video?.playlistIndex || video?.playlistTitle);
  const limit = playlistLike ? 48 : (isPlatformStreamSet || isVimeoStreamSet ? 8 : 12);

  return finalSorted.slice(0, limit).map((video) => ({
    ...video,
    availableFormats: totalAvailable,
    hiddenFormats: Math.max(0, totalAvailable - finalSorted.length),
  }));
};

const prepareVisibleVideoStreams = async (videos: any[], sourcePageUrl = '') => {
  const visible = normalizeVisibleVideoStreams(videos, sourcePageUrl);
  const prepared = await mapWithConcurrency(visible, 2, async (video: any) => {
    const watchUrl = String(video?.watchUrl || '').trim()
      || (isYouTubeUrl(String(video?.sourceUrl || video?.url || ''))
        ? normalizeYouTubeWatchUrl(String(video?.sourceUrl || video?.url || ''))
        : '');
    if (watchUrl && getYouTubeVideoId(watchUrl)) {
      if (video?.streamsPrepared) {
        return video;
      }
      try {
        return await buildYouTubeUnifiedCard(watchUrl, sourcePageUrl);
      } catch (error: any) {
        console.warn('YouTube unified card prepare failed:', error?.message || error);
        return video;
      }
    }

    if (video?.isYouTubeMerged || String(video?.url || '').includes('/api/youtube-merged-stream')) {
      return video;
    }
    const raw = String(video?.sourceStreamUrl || video?.url || '');
    if (!raw) return null;
    if (!isLikelyDirectVideoStreamUrl(raw) && !isLikelyVideoAssetUrl(raw)) return video;
    return toVerifiedPlayableVideo(video, sourcePageUrl);
  });

  return prepared.filter(Boolean);
};

const extractDirectPlatformVideoStreams = async (targetUrl: string, quality = 'fhd') => {
  const info: any = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(targetUrl),
    } as any),
    isXUrl(targetUrl) || isFacebookUrl(targetUrl) || isInstagramUrl(targetUrl) ? 18000 : 14000,
    `Direct platform video metadata for ${targetUrl}`
  );

  const thumbnail = sanitizeStreamUrl(info.thumbnail || '', targetUrl) || info.thumbnail || '';
  const images = thumbnail ? [{ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, 'jpg') }] : [];
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const requestedDownloads = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
  const mergedCandidates = [
    ...formats,
    ...requestedDownloads,
    ...(info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, width: info.width, tbr: info.tbr }] : []),
  ];
  const hasAnyAudioCandidate = mergedCandidates.some((candidate: any) => streamHasAudio(candidate));

  const videos = mergedCandidates
    .map((candidate: any) => {
      const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ''), targetUrl);
      if (!normalizedUrl || isExpiredStreamUrl(normalizedUrl)) return null;
      if (isTechnicalOrUnsupportedStream({ ...candidate, url: normalizedUrl })) return null;
      if (!streamHasVideo(candidate)) return null;
      const hasAudio = streamHasAudio(candidate);
      if (!hasAudio && hasAnyAudioCandidate) return null;
      if (!isLikelyDirectVideoStreamUrl(normalizedUrl) && !isLikelyVideoAssetUrl(normalizedUrl)) return null;

      return {
        url: normalizedUrl,
        sourceUrl: targetUrl,
        provider: info.extractor_key || info.extractor || platformProviderFromUrl(targetUrl),
        type: candidate.ext || getVideoFormatFromUrlOrType(normalizedUrl, ''),
        title: info.title || pageTitleFromUrl(targetUrl),
        thumbnail,
        resolution: candidate.format_note || candidate.resolution || (candidate.height ? `${candidate.height}p` : 'Best Quality'),
        formatId: candidate.format_id || candidate.itag || candidate.id,
        width: candidate.width,
        height: candidate.height || parseCandidateHeight(candidate),
        qualityRequested: quality,
        qualityExact: matchesStrictQuality(candidate.height || parseCandidateHeight(candidate), quality),
        fps: candidate.fps,
        vcodec: candidate.vcodec,
        acodec: candidate.acodec,
        hasAudio,
        audioAvailable: hasAudio,
        noAudio: !hasAudio,
        filesize: candidate.filesize || candidate.filesize_approx || candidate.contentLength,
        duration: Number(candidate.duration || info.duration || 0) || undefined,
        isDirect: true,
      };
    })
    .filter(Boolean);

  return { videos, images };
};

const extractHlsVariants = async (manifestUrl: string, sourcePageUrl?: string) => {
  const response = await axios.get(manifestUrl, {
    timeout: 8000,
    responseType: 'text',
    httpsAgent: relaxedHttpsAgent,
    headers: mediaRequestHeaders(manifestUrl, sourcePageUrl),
  });
  const text = String(response.data || '');
  const lines = text.split(/\r?\n/);
  const variants: Array<{ url: string; width?: number; height?: number; bandwidth?: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const bandwidth = line.match(/BANDWIDTH=(\d+)/i);
    const nextLine = lines.slice(index + 1).find((candidate) => {
      const value = candidate.trim();
      return value && !value.startsWith('#');
    })?.trim();
    const url = nextLine ? resolveUrl(manifestUrl, nextLine) || nextLine : '';
    if (!url) continue;
    variants.push({
      url,
      width: resolution?.[1] ? Number(resolution[1]) : undefined,
      height: resolution?.[2] ? Number(resolution[2]) : undefined,
      bandwidth: bandwidth?.[1] ? Number(bandwidth[1]) : undefined,
    });
  }

  if (variants.length === 0 && manifestUrl) {
    variants.push({ url: manifestUrl });
  }

  return variants;
};

const selectHlsVariantUrl = async (manifestUrl: string, targetHeight: number, sourcePageUrl?: string) => {
  const variants = await extractHlsVariants(manifestUrl, sourcePageUrl);
  const selected = variants
    .map((variant) => ({
      variant,
      distance: variant.height ? Math.abs(variant.height - targetHeight) : 9999,
      abovePenalty: variant.height && variant.height > targetHeight ? 500 : 0,
      bitrate: Number(variant.bandwidth || 0),
    }))
    .sort((a, b) => (a.distance + a.abovePenalty) - (b.distance + b.abovePenalty) || b.bitrate - a.bitrate)[0]?.variant;
  return selected?.url || manifestUrl;
};

const extractBrightcoveVideos = async (playerUrl: string) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) return { videos: [], images: [] };
  const info = await getBrightcoveMetadata(playerUrl);
  const durationRaw = Number(info.duration || 0);
  const duration = durationRaw > 10000 ? Math.round(durationRaw / 1000) : durationRaw || undefined;
  const thumbnail =
    sanitizeStreamUrl(
      info.poster || info.thumbnail || info.poster_sources?.[0]?.src || info.thumbnail_sources?.[0]?.src || '',
      playerUrl
    ) ||
    info.poster ||
    info.thumbnail ||
    '';
  const sources = Array.isArray(info.sources) ? info.sources : [];
  const hlsSource = sources.find((source: any) => {
    const src = String(source?.src || '');
    const type = String(source?.type || '').toLowerCase();
    return src && (src.includes('.m3u8') || type.includes('mpegurl'));
  });
  const hlsUrl = sanitizeStreamUrl(String(hlsSource?.src || ''), playerUrl) || '';
  const hlsVariants = hlsUrl
    ? await extractHlsVariants(hlsUrl, playerUrl).catch(() => [])
    : [];
  const directMp4Sources = sources
    .map((source: any) => {
      const src = sanitizeStreamUrl(String(source?.src || ''), playerUrl);
      return src ? { ...source, src } : null;
    })
    .filter(Boolean)
    .filter((source: any) => {
      const src = String(source.src || '');
      const container = String(source.container || source.type || '').toLowerCase();
      return src && (container.includes('mp4') || /\.mp4(?:\?|$)/i.test(src));
    });

  const bestByHeight = new Map<string, any>();
  directMp4Sources.forEach((source: any) => {
    const height = Number(source.height || source.size || parseCandidateHeight(source) || 0);
    const key = String(height || 'best');
    const current = bestByHeight.get(key);
    if (!current || Number(source.avg_bitrate || source.encoding_rate || source.filesize || 0) > Number(current.avg_bitrate || current.encoding_rate || current.filesize || 0)) {
      bestByHeight.set(key, source);
    }
  });

  const videos = Array.from(bestByHeight.values()).map((source: any) => {
    const height = Number(source.height || source.size || parseCandidateHeight(source) || 0) || undefined;
    return {
      url: source.src,
      sourceUrl: playerUrl,
      provider: 'brightcove',
      type: 'mp4',
      title: info.name || info.title || 'Brightcove video',
      thumbnail,
      resolution: height ? `${height}p` : 'Best Quality',
      formatId: source.asset_id || source.id || `${parsed.videoId}-${height || 'best'}`,
      width: source.width,
      height,
      filesize: source.filesize || source.size,
      duration,
      vcodec: source.codec || source.video_codec,
      acodec: source.audio_codec || 'aac',
      hasAudio: true,
      audioAvailable: true,
      isDirect: true,
      qualityExact: Boolean(height && (height === 720 || height === 1080)),
      brightcoveManifestUrl: hlsUrl,
      brightcoveAccountId: parsed.accountId,
      brightcovePlayerId: parsed.playerId,
      brightcoveVideoId: parsed.videoId,
    };
  });

  const images = thumbnail ? [{ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, 'jpg') }] : [];
  if (videos.length > 0) return { videos, images };

  const mergeHeights = Array.from(new Set(
    ((hlsVariants.length > 0 ? hlsVariants.map((variant) => variant.height || 0) : [1080, 720])
      .filter((height) => height === 1080 || height === 720)
      .sort((a, b) => b - a))
  ));

  return {
    images,
    videos: (mergeHeights.length > 0 ? mergeHeights : [0]).map((height) => ({
      url: playerUrl,
      sourceUrl: playerUrl,
      provider: 'brightcove',
      type: 'video',
      title: info.name || info.title || 'Brightcove video',
      thumbnail,
      duration,
      resolution: height ? `${height}p` : 'Best Quality',
      height: height || undefined,
      isDirect: false,
      needsMp4Merge: Boolean(hlsUrl),
      brightcoveManifestUrl: hlsUrl,
      qualityRequested: height === 1080 ? 'fhd' : height === 720 ? 'hd' : 'best',
      qualityExact: Boolean(height === 1080 || height === 720),
      displayQualityKey: height === 1080 ? 'fhd' : height === 720 ? 'hd' : 'best',
      displayQualityLabel: height === 1080 ? 'FHD' : height === 720 ? 'HD' : 'Best Quality',
      streamLabel: height === 1080 ? 'FHD' : height === 720 ? 'HD' : 'Best Quality',
      brightcoveAccountId: parsed.accountId,
      brightcovePlayerId: parsed.playerId,
      brightcoveVideoId: parsed.videoId,
    })),
  };
};

const downloadBrightcoveVideoToFile = async (
  url: string,
  quality: string,
  options: {
    title?: string;
    sourcePageUrl?: string;
    saveToWebsiteAssets?: boolean;
    mode?: 'video' | 'audio';
  } = {}
) => {
  const assets = await extractBrightcoveVideos(url);
  const videos: any[] = Array.isArray(assets.videos) ? assets.videos : [];
  const requestedHeight = getVimeoTargetHeight(quality === 'audio' ? 'fhd' : quality);
  const directCandidates = videos
    .filter((video: any) => video?.isDirect && isLikelyDirectVideoStreamUrl(String(video?.url || '')))
    .sort((a: any, b: any) => {
      const aHeight = parseCandidateHeight(a) || 0;
      const bHeight = parseCandidateHeight(b) || 0;
      const aPenalty = aHeight > requestedHeight ? 10000 + aHeight - requestedHeight : requestedHeight - aHeight;
      const bPenalty = bHeight > requestedHeight ? 10000 + bHeight - requestedHeight : requestedHeight - bHeight;
      return aPenalty - bPenalty;
    });
  const selected = directCandidates[0];
  const fallback = videos.find((video: any) => video?.brightcoveManifestUrl);
  const manifestUrl = String(fallback?.brightcoveManifestUrl || selected?.brightcoveManifestUrl || '').trim();
  // Keep the master manifest intact. Brightcove commonly publishes video and
  // AAC audio as separate HLS renditions; selecting only a child video variant
  // produces a silent MP4. yt-dlp/FFmpeg can select and mux both tracks from
  // the master manifest according to the requested quality.
  const selectedHlsUrl = manifestUrl;
  const streamUrl = String(selectedHlsUrl || selected?.url || '').trim();
  if (!streamUrl) throw new Error('Brightcove did not provide a downloadable video stream.');

  const resolvedTitle = String(options.title || selected?.title || fallback?.title || 'Brightcove video');
  const thumbnail = String(selected?.thumbnail || fallback?.thumbnail || assets.images?.[0]?.url || '');
  const result = options.mode !== 'audio' && !selectedHlsUrl && selected?.url
    ? await downloadDirectStreamVideoToFile(streamUrl, {
        titleHint: resolvedTitle,
        sourcePageUrl: options.sourcePageUrl || url,
        quality,
        saveToWebsiteAssets: options.saveToWebsiteAssets,
      })
    : await downloadPlatformVideoToFile(streamUrl, quality === 'audio' ? 'fhd' : quality, {
        titleHint: resolvedTitle,
        sourcePageUrl: options.sourcePageUrl || url,
        saveToWebsiteAssets: options.saveToWebsiteAssets,
        mode: options.mode === 'audio' ? 'audio' : 'video',
        maxDurationSeconds: options.mode === 'audio' ? 120 : undefined,
      });
  return { ...result, title: resolvedTitle, thumbnail, platform: 'brightcove' };
};

const normalizePlaylistEntryUrl = (entry: any, sourceUrl: string) => {
  const raw =
    String(entry?.webpage_url || entry?.webpage_url_basename || entry?.original_url || entry?.url || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z0-9_-]{6,}$/.test(raw) && isYouTubeUrl(sourceUrl)) {
    return `https://www.youtube.com/watch?v=${raw}`;
  }
  const resolved = sanitizeStreamUrl(raw, sourceUrl);
  if (!resolved) return '';
  return isYouTubeUrl(resolved) ? normalizeYouTubeWatchUrl(resolved) : resolved;
};

const extractPlaylistVideos = async (targetUrl: string) => {
  const info: any = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
      playlistEnd: 48,
    } as any),
    isYouTubeUrl(targetUrl) ? 35000 : 24000,
    `Playlist metadata for ${targetUrl}`
  );

  const entries = Array.isArray(info?.entries) ? info.entries.filter(Boolean) : [];
  if (entries.length <= 1) return null;
  const playlistTitle = info.title || info.playlist_title || 'Playlist';
  const videos = entries
    .map((entry: any, index: number) => {
      const entryUrl = normalizePlaylistEntryUrl(entry, targetUrl);
      if (!entryUrl || !isPlatformVideoUrl(entryUrl)) return null;
      const duration = Number(entry.duration || entry.duration_string || 0) || undefined;
      return {
        url: entryUrl,
        sourceUrl: entryUrl,
        pageUrl: entryUrl,
        provider: entry.extractor_key || info.extractor_key || platformProviderFromUrl(entryUrl),
        type: 'video',
        title: entry.title || `${playlistTitle} ${index + 1}`,
        thumbnail: sanitizeStreamUrl(entry.thumbnail || entry.thumbnails?.[entry.thumbnails.length - 1]?.url || '', entryUrl) || '',
        duration,
        playlistTitle,
        playlistIndex: index + 1,
        playlistCount: entries.length,
        availableFormats: entries.length,
      };
    })
    .filter(Boolean);

  if (videos.length <= 1) return null;
  return {
    playlist: {
      title: playlistTitle,
      count: videos.length,
      totalDuration: videos.reduce((sum: number, video: any) => sum + (Number(video.duration || 0) || 0), 0),
    },
    videos,
    images: [],
  };
};

const extractDirectYtDlpVideoStreams = async (targetUrl: string, qualities = ['fhd', 'hd'], exactOnly = true) => {
  const info: any = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(targetUrl),
    } as any),
    isYouTubeUrl(targetUrl) ? 45000 : 18000,
    `Direct video metadata for ${targetUrl}`
  );

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const requestedDownloads = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
  const mergedCandidates = [
    ...formats,
    ...requestedDownloads,
    ...(info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, width: info.width, tbr: info.tbr }] : []),
  ];
  const normalizedCandidates = mergedCandidates
    .map((candidate: any) => {
      const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ''), targetUrl);
      return normalizedUrl ? { ...candidate, url: normalizedUrl } : null;
    })
    .filter(Boolean)
    .filter((candidate: any) => !isExpiredStreamUrl(String(candidate.url)));
  const hasAudioCandidate = normalizedCandidates.some((candidate: any) => streamHasAudio(candidate));
  const playableCandidates = normalizedCandidates.filter((candidate: any) => {
    const raw = String(candidate.url || '');
    if (isTechnicalOrUnsupportedStream(candidate)) return false;
    if (isYouTubeUrl(targetUrl) && raw.includes('.m3u8')) return false;
    if (!streamHasVideo(candidate)) return false;
    return isLikelyDirectVideoStreamUrl(raw) || (!isYouTubeUrl(targetUrl) && isLikelyVideoAssetUrl(raw));
  });

  const selectedByQuality = new Map<string, any>();
  for (const quality of qualities) {
    const qualityCandidates = sortCandidatesForQuality(
      exactOnly
        ? playableCandidates.filter((candidate: any) => matchesStrictQuality(parseCandidateHeight(candidate), quality))
        : playableCandidates,
      quality
    );
    const selected = await firstValidStreamCandidate(qualityCandidates, targetUrl, targetUrl);
    if (!selected?.url) continue;
    const selectedHeight = selected.height || parseCandidateHeight(selected);
    const selectedHasAudio = streamHasAudio(selected);
    const payload = enforceMp4VideoPayload({
      url: selected.url,
      sourceUrl: targetUrl,
      watchUrl: isYouTubeUrl(targetUrl) ? normalizeYouTubeWatchUrl(targetUrl) : undefined,
      provider: info.extractor_key || info.extractor || platformProviderFromUrl(targetUrl),
      type: selected.ext || 'mp4',
      title: info.title || pageTitleFromUrl(targetUrl),
      thumbnail: sanitizeStreamUrl(info.thumbnail || '', targetUrl) || info.thumbnail || '',
      resolution: selected.format_note || (selectedHeight ? `${selectedHeight}p` : 'Best Quality'),
      formatId: selected.format_id || selected.itag || selected.id,
      width: selected.width,
      height: selectedHeight,
      qualityRequested: quality,
      qualityExact: matchesStrictQuality(selectedHeight, quality),
      displayQualityKey: quality,
      displayQualityLabel: getCleanQualityLabel(quality),
      streamLabel: getCleanQualityLabel(quality),
      fps: selected.fps,
      vcodec: selected.vcodec,
      acodec: selected.acodec,
      hasAudio: selectedHasAudio,
      audioAvailable: selectedHasAudio,
      noAudio: !selectedHasAudio,
      filesize: selected.filesize || selected.filesize_approx || selected.contentLength,
      duration: Number(selected.duration || info.duration || 0) || undefined,
      isDirect: true,
      verifiedPlayable: true,
    });
    const video = isYouTubeUrl(targetUrl)
      ? wrapYouTubePlaybackStream(payload, normalizeYouTubeWatchUrl(targetUrl), quality)
      : payload;
    selectedByQuality.set(quality, video);
  }

  if (selectedByQuality.size === 0 && !exactOnly) {
    const selected = await firstValidStreamCandidate(sortCandidatesForQuality(playableCandidates, qualities[0] || 'fhd'), targetUrl, targetUrl);
    if (selected?.url) {
      const selectedHeight = selected.height || parseCandidateHeight(selected);
      const selectedHasAudio = streamHasAudio(selected);
      const payload = enforceMp4VideoPayload({
        url: selected.url,
        sourceUrl: targetUrl,
        watchUrl: isYouTubeUrl(targetUrl) ? normalizeYouTubeWatchUrl(targetUrl) : undefined,
        provider: info.extractor_key || info.extractor || platformProviderFromUrl(targetUrl),
        type: selected.ext || 'mp4',
        title: info.title || pageTitleFromUrl(targetUrl),
        thumbnail: sanitizeStreamUrl(info.thumbnail || '', targetUrl) || info.thumbnail || '',
        resolution: selected.format_note || (selectedHeight ? `${selectedHeight}p` : 'Best Quality'),
        formatId: selected.format_id || selected.itag || selected.id,
        width: selected.width,
        height: selectedHeight,
        qualityRequested: 'best',
        qualityExact: false,
        displayQualityKey: getCleanQualityKey(selected),
        displayQualityLabel: getCleanQualityLabel(getCleanQualityKey(selected)),
        streamLabel: getCleanQualityLabel(getCleanQualityKey(selected)),
        fps: selected.fps,
        vcodec: selected.vcodec,
        acodec: selected.acodec,
        hasAudio: selectedHasAudio,
        audioAvailable: selectedHasAudio,
        noAudio: !selectedHasAudio,
        filesize: selected.filesize || selected.filesize_approx || selected.contentLength,
        duration: Number(selected.duration || info.duration || 0) || undefined,
        isDirect: true,
        verifiedPlayable: true,
      });
      selectedByQuality.set(
        'best',
        isYouTubeUrl(targetUrl)
          ? wrapYouTubePlaybackStream(payload, normalizeYouTubeWatchUrl(targetUrl), 'fhd')
          : payload
      );
    }
  }

  return Array.from(selectedByQuality.values());
};

const extractDirectYtDlpVideoStream = async (targetUrl: string, quality = 'fhd') => {
  const exact = await extractDirectYtDlpVideoStreams(targetUrl, [quality], true);
  if (exact[0]?.url) return exact[0];
  const fallback = await extractDirectYtDlpVideoStreams(targetUrl, [quality], false);
  return fallback[0] || null;
};

const materializeMergedMp4FromPlatform = async (
  targetUrl: string,
  quality: string,
  req: express.Request,
  titleHint = 'video',
  options: { directInputUrl?: string; sourcePageUrl?: string } = {}
) => {
  await fsp.mkdir(convertedVideoDir, { recursive: true });
  const targetHeight = getVimeoTargetHeight(quality);
  const tempBase = `merged-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempOutput = path.join(convertedVideoDir, `${tempBase}.mp4`);
  const resolvedTitle = String(titleHint || 'video').trim();
  const safeFilename = toQualityVideoFilename(quality, resolvedTitle);
  const targetDir = resolveDownloadsTargetDir(options.sourcePageUrl);
  await fsp.mkdir(targetDir, { recursive: true });
  const finalPath = path.join(targetDir, safeFilename);

  try {
    const directInputUrl = options.directInputUrl ? sanitizeStreamUrl(options.directInputUrl, options.sourcePageUrl || targetUrl) : '';
    if (directInputUrl) {
      const parsedInput = new URL(directInputUrl);
      const { referer, origin } = getStreamRequestContext(parsedInput, options.sourcePageUrl || targetUrl);
      await transcodeUrlToMp4File(directInputUrl, tempOutput, referer, origin);
    } else {
      await withTimeout(
        youtubedl(targetUrl, {
          ...buildYtDlpDownloadOptions(targetUrl, quality, options.sourcePageUrl, tempOutput),
        } as any),
        4 * 60 * 1000,
        `Merged MP4 fallback for ${targetUrl}`
      );
    }

    await validateOutputFile(tempOutput, 'Merged MP4 fallback');
    const qt = await ensureQuickTimeCompatibleMp4(tempOutput, {
      titleHint: resolvedTitle,
      quality,
      outputPath: finalPath,
    });
    await fsp.unlink(tempOutput).catch(() => undefined);
    const stat = await validateOutputFile(qt.outputPath, 'Merged MP4 fallback');

    return {
      url: toLocalVideoDownloadUrl(req, safeFilename, options.sourcePageUrl),
      localPath: qt.outputPath,
      downloadPath: qt.outputPath,
      copyUrl: toDisplayFilePath(qt.outputPath),
      sourceUrl: targetUrl,
      provider: platformProviderFromUrl(targetUrl),
      type: 'mp4',
      title: resolvedTitle || 'Video',
      resolution: `${targetHeight}p`,
      height: targetHeight,
      isDirect: true,
      isLocalMerged: true,
      verifiedPlayable: true,
      quickTimeCompatible: qt.quickTimeCompatible,
      qualityRequested: quality,
      filesize: stat.size,
    };
  } catch (error) {
    await fsp.unlink(tempOutput).catch(() => undefined);
    throw error;
  }
};

const decodeEscaped = (value: string) =>
  value
    .replace(/\\u0025/g, '%')
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');

const extractFacebookVideoFallback = async (targetUrl: string, quality = 'fhd') => {
  const response = await axios.get(targetUrl, {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = String(response.data || '');
  const pick = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeEscaped(match[1]);
    }
    return '';
  };

  const hd = pick([
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
    /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/i,
    /"hd_src"\s*:\s*"([^"]+)"/i,
  ]);
  const sd = pick([
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/i,
    /"playable_url"\s*:\s*"([^"]+)"/i,
    /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/i,
    /"sd_src"\s*:\s*"([^"]+)"/i,
  ]);
  const thumbnail = pick([
    /<meta property="og:image" content="([^"]+)"/i,
    /"preferred_thumbnail"\s*:\s*\{"image"\s*:\s*\{"uri"\s*:\s*"([^"]+)"/i,
  ]);
  const title = pick([
    /<meta property="og:title" content="([^"]+)"/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ]) || 'Facebook video';

  const selected = sanitizeStreamUrl(quality === 'fhd' ? (hd || sd) : (sd || hd), targetUrl);
  if (!selected) return null;

  return {
    url: selected,
    sourceUrl: targetUrl,
    provider: 'facebook',
    type: 'mp4',
    title,
    thumbnail: sanitizeStreamUrl(thumbnail, targetUrl) || thumbnail,
    resolution: hd && sanitizeStreamUrl(hd, targetUrl) === selected ? '1080p' : '720p',
    isDirect: true,
  };
};

const extractXVideoFallback = async (targetUrl: string, quality = 'fhd') => {
  const parsed = new URL(targetUrl);
  const altUrl = `https://vxtwitter.com${parsed.pathname}${parsed.search || ''}`;
  const response = await axios.get(altUrl, {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = String(response.data || '');
  const pick = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeEscaped(match[1]);
    }
    return '';
  };

  const ogVideo = pick([
    /<meta\s+property="og:video"\s+content="([^"]+)"/i,
    /<meta\s+property="og:video:url"\s+content="([^"]+)"/i,
  ]);
  const thumbnail = pick([
    /<meta\s+property="og:image"\s+content="([^"]+)"/i,
    /<meta\s+name="twitter:image"\s+content="([^"]+)"/i,
  ]);
  const title = pick([
    /<meta\s+property="og:title"\s+content="([^"]+)"/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ]) || 'X video';

  const selected = sanitizeStreamUrl(ogVideo, targetUrl);
  if (!selected) return null;

  return {
    url: selected,
    sourceUrl: targetUrl,
    provider: 'x',
    type: 'mp4',
    title,
    thumbnail: sanitizeStreamUrl(thumbnail, targetUrl) || thumbnail,
    resolution: quality === 'fhd' ? '1080p' : '720p',
    isDirect: true,
  };
};

const buildVimeoStreamVideos = (vimeoUrl: string, resolved: Awaited<ReturnType<typeof resolveVimeoQualityStreams>>) => {
  const videos: any[] = [];
  const images: any[] = [];
  const thumbnail = resolved.thumbnail;
  const title = String(resolved.title || '').trim();
  const streamBuckets = Object.entries(resolved.streams) as Array<['fhd' | 'hd', VimeoResolvedStream]>;

  if (!title || title === 'Vimeo video' || !thumbnail || streamBuckets.length === 0) {
    return { videos, images };
  }

  images.push({ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, 'jpg') });
  streamBuckets.forEach(([bucket, stream]) => {
    const acodec = String(stream.acodec || '');
    const hasAudio = stream.type === 'm3u8' ? true : acodec !== 'none';
    videos.push({
      url: stream.url,
      sourceStreamUrl: stream.sourceStreamUrl,
      sourceUrl: vimeoUrl,
      vimeoId: resolved.vimeoId || undefined,
      provider: 'vimeo',
      isVimeoDirect: true,
      isVimeoHls: stream.type === 'm3u8',
      type: stream.type,
      title,
      thumbnail,
      resolution: stream.height ? `${stream.height}p` : 'Unknown',
      formatId: stream.format?.format_id || stream.format?.id,
      width: stream.width,
      height: stream.height,
      fps: stream.fps,
      vcodec: stream.vcodec,
      acodec: stream.acodec,
      audioAvailable: hasAudio,
      hasAudio,
      filesize: stream.filesize,
      duration: resolved.duration,
      availableFormats: streamBuckets.length,
      qualityRequested: bucket,
      displayQualityKey: bucket,
      displayQualityLabel: getCleanQualityLabel(bucket),
      qualityExact: matchesStrictQuality(stream.height, bucket),
      streamsPrepared: true,
      streamSource: stream.streamSource,
      vimeoQualityDebug: resolved.debug,
    });
  });
  return { videos, images };
};

const extractVimeoVideos = async (vimeoUrls: string[], quality = 'fhd', sourcePageUrl = '') => {
  const uniqueUrls = dedupeVimeoUrlsById(
    vimeoUrls
      .map((value) => normalizeVimeoUrl(value) || value)
      .filter(Boolean)
  );

  const results = await mapWithConcurrency(uniqueUrls.slice(0, 12), 4, async (vimeoUrl) => {
    const vimeoId = parseVimeoIdFromUrl(vimeoUrl);
    try {
      let ytDlpInfo: any = null;
      try {
        ytDlpInfo = await withTimeout(
          getVimeoMetadata(vimeoUrl, sourcePageUrl),
          25000,
          `Vimeo yt-dlp metadata for ${vimeoUrl}`
        );
      } catch (error: any) {
        console.warn(`[vimeo:${vimeoId}] yt-dlp metadata skipped:`, error?.message || error);
      }

      const resolved = await resolveVimeoQualityStreams(vimeoUrl, sourcePageUrl, ytDlpInfo);
      const built = buildVimeoStreamVideos(vimeoUrl, resolved);
      if (built.videos.length === 0) {
        console.warn(`[vimeo:${vimeoId}] Skipping card — title, thumbnail, or streams were not fully resolved.`);
        return { images: [], videos: createVimeoSourceVideos([vimeoUrl]) };
      }
      return built;
    } catch (error: any) {
      console.warn(`[vimeo:${vimeoId}] Vimeo extraction failed:`, error?.message || error);
      return { images: [], videos: createVimeoSourceVideos([vimeoUrl]) };
    }
  });

  return {
    videos: results.flatMap((result) => result.videos),
    images: results.flatMap((result) => result.images),
  };
};

const createVimeoSourceVideos = (vimeoUrls: string[]) => {
  const uniqueUrls = Array.from(new Set(vimeoUrls.map(normalizeVimeoUrl).filter(Boolean))) as string[];

  return uniqueUrls.slice(0, 24).map((vimeoUrl) => ({
    url: vimeoUrl,
    provider: 'vimeo',
    isVimeo: true,
    type: 'vimeo',
    title: 'Vimeo video',
  }));
};

const wistiaMetadataCache = new Map<string, { expiresAt: number; info: any }>();
const wistiaMetadataTtlMs = 3 * 60 * 1000;

const getWistiaMetadata = async (hashedId: string) => {
  const cached = wistiaMetadataCache.get(hashedId);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const embedUrl = buildWistiaEmbedUrl(hashedId);
  const response = await withTimeout(
    axios.get(`${embedUrl}.json`, {
      timeout: 12000,
      httpsAgent: relaxedHttpsAgent,
      headers: browserLikeHeaders(embedUrl),
    }),
    12000,
    `Wistia metadata for ${hashedId}`
  );
  const media = response.data?.media;
  if (!media) throw new Error(`Wistia media not found for ${hashedId}`);
  wistiaMetadataCache.set(hashedId, { expiresAt: Date.now() + wistiaMetadataTtlMs, info: media });
  return media;
};

const extractWistiaVideos = async (wistiaIds: string[], quality = 'fhd') => {
  const uniqueIds = Array.from(new Set(wistiaIds.filter(Boolean)));

  const results = await mapWithConcurrency(uniqueIds.slice(0, 12), 4, async (hashedId) => {
    try {
      const media = await getWistiaMetadata(hashedId);
      const wistiaUrl = buildWistiaEmbedUrl(hashedId);
      const title = String(media.name || 'Wistia video').trim() || 'Wistia video';
      const videos: any[] = [];
      const images: any[] = [];

      const stillAsset = (Array.isArray(media.assets) ? media.assets : []).find((asset: any) => asset?.type === 'still_image' && asset?.url);
      const thumbnail = stillAsset?.url ? sanitizeStreamUrl(stillAsset.url, wistiaUrl) || stillAsset.url : '';
      if (thumbnail) {
        images.push({ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, 'jpg') });
      }

      const mp4Assets = (Array.isArray(media.assets) ? media.assets : [])
        .filter((asset: any) => {
          const ext = String(asset?.ext || asset?.container || '').toLowerCase();
          const type = String(asset?.type || '').toLowerCase();
          if (!asset?.url || asset?.status !== 2) return false;
          if (type === 'still_image' || type === 'storyboard') return false;
          return ext === 'mp4' || type.includes('mp4') || type === 'iphone_video';
        })
        .sort((a: any, b: any) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));

      if (mp4Assets.length > 0) {
        const bestAsset = mp4Assets[0];
        const fhdAsset = mp4Assets.find((asset: any) => Number(asset.height || 0) >= 900);
        const hdAsset = mp4Assets.find((asset: any) => {
          const height = Number(asset.height || 0);
          return height >= 600 && height < 900;
        });
        const publishAssets = Array.from(new Map(
          [bestAsset, fhdAsset, hdAsset]
            .filter(Boolean)
            .map((asset: any) => [Number(asset.height || 0), asset])
        ).values());

        publishAssets.forEach((asset: any) => {
          const normalizedUrl = asset?.url ? sanitizeStreamUrl(asset.url, wistiaUrl) : null;
          if (!normalizedUrl) return;
          videos.push({
            url: normalizedUrl,
            sourceUrl: wistiaUrl,
            provider: 'wistia',
            isWistiaDirect: true,
            type: 'mp4',
            title,
            thumbnail,
            resolution: asset.display_name || (asset.height ? `${asset.height}p` : 'Unknown'),
            width: asset.width,
            height: asset.height,
            bitrate: asset.bitrate,
            filesize: asset.size,
            duration: Number(media.duration || 0) || undefined,
            wistiaHashedId: hashedId,
            availableFormats: publishAssets.length,
            qualityRequested: quality,
            qualityExact: matchesStrictQuality(Number(asset.height || 0), quality),
            hasAudio: true,
            audioAvailable: true,
            acodec: 'aac',
            vcodec: asset.codec || 'h264',
          });
        });
      } else {
        videos.push({
          url: wistiaUrl,
          sourceUrl: wistiaUrl,
          provider: 'wistia',
          isWistia: true,
          type: 'wistia',
          title,
          thumbnail,
          wistiaHashedId: hashedId,
        });
      }

      return { videos, images };
    } catch (error: any) {
      console.warn(`Wistia extraction failed for ${hashedId}:`, error?.message || error);
      const wistiaUrl = buildWistiaEmbedUrl(hashedId);
      return {
        images: [],
        videos: [{
          url: wistiaUrl,
          sourceUrl: wistiaUrl,
          provider: 'wistia',
          isWistia: true,
          type: 'wistia',
          title: 'Wistia video',
          wistiaHashedId: hashedId,
        }],
      };
    }
  });

  return {
    videos: results.flatMap((result) => result.videos),
    images: results.flatMap((result) => result.images),
  };
};

const createWistiaSourceVideos = (wistiaIds: string[]) => {
  const uniqueIds = Array.from(new Set(wistiaIds.filter(Boolean)));
  return uniqueIds.slice(0, 24).map((hashedId) => {
    const wistiaUrl = buildWistiaEmbedUrl(hashedId);
    return {
      url: wistiaUrl,
      sourceUrl: wistiaUrl,
      provider: 'wistia',
      isWistia: true,
      type: 'wistia',
      title: 'Wistia video',
      wistiaHashedId: hashedId,
    };
  });
};

const extractEmbeddedPlatformVideosOnly = async (html: string, targetUrl: string) => {
  const vimeoUrls = Array.from(new Set(extractVimeoUrlsFromText(html, targetUrl))).slice(0, 12);
  const wistiaIds = Array.from(new Set(extractWistiaIdsFromText(html, targetUrl))).slice(0, 12);
  const brightcoveVideos = extractBrightcoveVideosFromHtml(html, targetUrl).slice(0, 12);
  const directVideoUrls = extractAssetsFromRawText(html, targetUrl).videos
    .filter((video) => video?.url && (isLikelyVideoAssetUrl(video.url) || isLikelyDirectVideoStreamUrl(video.url)))
    .slice(0, 12);
  const videos: any[] = [];

  if (vimeoUrls.length > 0) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(vimeoUrls, 'fhd', targetUrl),
        Math.min(VIMEO_EXTRACT_TIMEOUT_MS, 18000),
        `Video-only Vimeo extraction for ${targetUrl}`
      );
      videos.push(...(vimeoAssets.videos || []));
    } catch (error: any) {
      console.warn('Video-only Vimeo extraction failed:', error?.message || error);
    }
  }

  if (wistiaIds.length > 0) {
    try {
      const wistiaAssets = await withTimeout(
        extractWistiaVideos(wistiaIds, 'fhd'),
        12000,
        `Video-only Wistia extraction for ${targetUrl}`
      );
      videos.push(...(wistiaAssets.videos || []));
    } catch (error: any) {
      console.warn('Video-only Wistia extraction failed, using source cards:', error?.message || error);
      videos.push(...createWistiaSourceVideos(wistiaIds));
    }
  }

  if (brightcoveVideos.length > 0) {
    videos.push(...await resolveBrightcoveCandidateVideos(
      brightcoveVideos,
      `Video-only Brightcove extraction for ${targetUrl}`
    ));
  }

  videos.push(...directVideoUrls);
  const cleanVideos = await prepareVisibleVideoStreams(videos, targetUrl);
  return cleanVideos.length > 0 ? cleanVideos : normalizeVisibleVideoStreams(videos, targetUrl);
};

const SECTION_PICKER_SCRIPT = `
(function () {
  if (window.__vdxSectionPickerActive) return;
  window.__vdxSectionPickerActive = true;
  const style = document.createElement('style');
  style.textContent = \`
    .vdx-section-hover { outline: 2px solid #2563eb !important; outline-offset: 2px !important; cursor: crosshair !important; }
    .vdx-section-selected { outline: 3px solid #16a34a !important; outline-offset: 2px !important; background: rgba(22,163,74,0.06) !important; }
    #vdx-section-banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646; background: #111827; color: #fff; padding: 10px 16px; border-radius: 999px; font: 600 13px/1.2 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
  \`;
  document.documentElement.appendChild(style);
  const banner = document.createElement('div');
  banner.id = 'vdx-section-banner';
  banner.textContent = 'Click a section to select it';
  document.documentElement.appendChild(banner);
  let hoverEl = null;
  let selectedEl = null;
  const buildSelector = (el) => {
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && parts.length < 8) {
      const tag = current.tagName.toLowerCase();
      const id = current.getAttribute('id');
      if (id && /^[a-zA-Z][\\w-]*$/.test(id)) { parts.unshift('#' + CSS.escape(id)); break; }
      const cls = String(current.getAttribute('class') || '').split(/\\s+/).filter(Boolean).find((t) => t && !/^js-/.test(t));
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(cls ? tag + '.' + cls + ':nth-of-type(' + index + ')' : tag + ':nth-of-type(' + index + ')');
      } else parts.unshift(tag);
      current = parent;
    }
    return parts.join(' > ');
  };
  const labelFor = (el) => {
    const id = el.getAttribute('id');
    const cls = String(el.getAttribute('class') || '').split(/\\s+/).filter(Boolean)[0];
    return [el.tagName.toLowerCase(), id ? '#' + id : '', cls ? '.' + cls : ''].join('').slice(0, 120);
  };
  const notify = (el) => {
    const selector = buildSelector(el);
    window.parent.postMessage({ type: 'vdx-section-picked', selector, label: labelFor(el) }, '*');
    banner.textContent = 'Selected: ' + labelFor(el);
  };
  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target === banner || target.id === 'vdx-section-banner') return;
    if (hoverEl && hoverEl !== selectedEl) hoverEl.classList.remove('vdx-section-hover');
    hoverEl = target;
    if (hoverEl !== selectedEl) hoverEl.classList.add('vdx-section-hover');
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target === banner || target.id === 'vdx-section-banner') return;
    event.preventDefault();
    event.stopPropagation();
    if (selectedEl) selectedEl.classList.remove('vdx-section-selected');
    selectedEl = target;
    selectedEl.classList.add('vdx-section-selected');
    notify(selectedEl);
  }, true);
})();
`;

const injectSectionPickerIntoHtml = (html: string, targetUrl: string, enablePicker = true) => {
  const baseTag = `<base href="${targetUrl.replace(/"/g, '&quot;')}">`;
  const scriptTag = enablePicker
    ? `<script>${SECTION_PICKER_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>`
    : '';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`).replace(/<\/body>/i, `${scriptTag}</body>`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}${scriptTag}</body></html>`;
};

const extractSectionAssetsFromHtml = async (
  targetUrl: string,
  sectionHtml: string,
  sectionSelector: string,
  sectionLabel = '',
  computedFonts: Array<{ family: string; weight?: string; style?: string }> = []
) => {
  const $section = cheerio.load(sectionHtml);
  const images: any[] = [];
  const icons: any[] = [];
  let fonts: any[] = [];
  const colors: string[] = [];

  images.push(...extractImagesFromDom($section, targetUrl, { scoped: true }));
  icons.push(...extractIconsFromDom($section, targetUrl));
  $section('video[poster]').each((_: any, el: any) => {
    addImageCandidate(images, $section(el).attr('poster'), targetUrl, undefined, { permissive: true });
  });

  $section('style').each((_: any, el: any) => {
    const cssText = $section(el).html();
    if (!cssText) return;
    fonts = fonts.concat(extractFontsFromCss(cssText, targetUrl));
    images.push(...extractImagesFromCss(cssText, targetUrl));
    colors.push(...extractColorsFromCss(cssText));
  });
  $section('[style]').each((_: any, el: any) => {
    const style = $section(el).attr('style');
    if (!style) return;
    images.push(...extractImagesFromCss(style, targetUrl));
    colors.push(...extractColorsFromCss(style));
  });

  const pageHtml = await withTimeout(fetchSiteHtml(targetUrl), 28000, `Section CSS fetch for ${targetUrl}`).catch(() => '');
  if (pageHtml) {
    const cssBundle = await withTimeout(
      fetchCssSourceCandidates(targetUrl, pageHtml, { fast: true }),
      8000,
      `Section stylesheet scan for ${targetUrl}`
    ).catch(() => ({ inlineStyles: [] as Array<{ css: string; source: string }>, fetchedCss: [] as Array<{ css: string; source: string }> }));
    [...cssBundle.inlineStyles, ...cssBundle.fetchedCss].forEach(({ css, source }) => {
      fonts = fonts.concat(extractFontsFromCss(css, source));
    });
  }

  if (computedFonts.length > 0) {
    fonts = filterFontsByComputedUsage(fonts, computedFonts);
  }

  return dedupeExtractedAssets(images, [], fonts, colors, targetUrl, '', {
    fast: true,
    extraIcons: icons,
    sectionMode: true,
    sectionLabel,
    sectionSelector,
  });
};

const extractSectionAssets = async (targetUrl: string, sectionSelector: string, sectionLabel = '') => {
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const sectionData = await page.evaluate((selector) => {
      const root = document.querySelector(selector);
      if (!root) return null;
      const computedFonts: Array<{ family: string; weight?: string; style?: string }> = [];
      const seen = new Set<string>();
      root.querySelectorAll('*').forEach((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        const style = window.getComputedStyle(el);
        const payload = JSON.stringify({
          family: style.fontFamily,
          weight: style.fontWeight,
          style: style.fontStyle,
        });
        if (seen.has(payload)) return;
        seen.add(payload);
        computedFonts.push(JSON.parse(payload));
      });
      return {
        html: root.outerHTML,
        label:
          root.getAttribute('data-section-label') ||
          root.getAttribute('aria-label') ||
          root.getAttribute('id') ||
          root.tagName.toLowerCase(),
        computedFonts,
      };
    }, sectionSelector);

    await page.close().catch(() => undefined);
    await closePuppeteerBrowser(browser);
    browser = null;

    if (!sectionData?.html) {
      throw new Error('Selected section was not found on the page. Pick the section again.');
    }

    return extractSectionAssetsFromHtml(
      targetUrl,
      sectionData.html,
      sectionSelector,
      sectionLabel || sectionData.label || '',
      sectionData.computedFonts || []
    );
  } finally {
    if (browser) await closePuppeteerBrowser(browser).catch(() => undefined);
  }
};

app.get('/api/section-frame', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) return res.status(400).send('URL is required');
  try {
    const targetUrl = new URL(rawUrl).href;
    assertPublicAssetUrl(targetUrl);
    if (isVideoPlatformHostUrl(targetUrl) && isPlatformVideoUrl(targetUrl)) {
      return res.status(400).send('Video platform URLs cannot be previewed here. Use Video Downloader instead.');
    }
    let html = await withTimeout(fetchSiteHtml(targetUrl), 20000, `Section frame for ${targetUrl}`).catch(() => '');
    if (!html || htmlLooksLikeBotWall(html)) {
      const readerText = await fetchReaderFallbackText(targetUrl).catch(() => '');
      html = buildKnownBlockedSiteFallbackHtml(targetUrl, readerText);
      if (!html && readerText) {
        const escaped = readerText.replace(/[<&>]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] || char));
        html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;line-height:1.55;color:#18181b}pre{white-space:pre-wrap}</style></head><body><pre>${escaped}</pre></body></html>`;
      }
    }
    if (!html) return res.status(502).send('Could not load page HTML.');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;");
    const enablePicker = req.query.picker !== '0';
    return res.send(injectSectionPickerIntoHtml(html, targetUrl, enablePicker));
  } catch (error: any) {
    return res.status(500).send(error?.message || 'Failed to load section preview.');
  }
});

// API Endpoint to extract assets
app.post('/api/extract', async (req, res) => {
  const { url, mode, extractionMode, sectionSelector, sectionLabel, scope, videosOnly: videosOnlyBody, crawlMode: crawlModeBody, proxyUrl } = req.body;
  // Force deep crawl for slow-loading sites
  const needsDeepCrawl = /fabindia\.com|\.imaging\/|\/dam\/jcr:/i.test(url);
  const crawlMode = (crawlModeBody === 'deep' || needsDeepCrawl) ? 'deep' : 'fast';
  const isFastCrawl = crawlMode !== 'deep';
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  let extractKey = '';
  let progressMgr: ExtractionProgressManager | null = null;
  let quickExtractPromise: Promise<any> | null = null;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const targetUrl = new URL(url).href;
    assertPublicAssetUrl(targetUrl);
    const extractionProxyUrl = normalizeExtractionProxyUrl(proxyUrl);
    activeExtractionProxyUrl = extractionProxyUrl;
    lastExtractedSourceUrl = targetUrl;

    extractKey = `${crypto.createHash('sha256').update(targetUrl).digest('hex').slice(0, 12)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    progressMgr = ExtractionProgressManager.create(extractKey);
    activeExtractProgress = progressMgr;
    setGlobalProgressManager(progressMgr);
    res.setHeader('X-Extract-Id', extractKey);
    const videosOnly = scope === 'videos' || videosOnlyBody === true;
    const useStaticExtract = mode === 'static';
    const sectionExtract =
      extractionMode === 'section' && typeof sectionSelector === 'string' && sectionSelector.trim().length > 0;
    lastExtractionSectionMode = sectionExtract;

    if (sectionExtract && isVideoPlatformHostUrl(targetUrl)) {
      return res.status(400).json({ error: 'Section extraction is for website assets only. Use Extract for video URLs.' });
    }

    if (sectionExtract) {
      const sectionAssets = await extractSectionAssets(targetUrl, sectionSelector.trim(), String(sectionLabel || '').trim());
      return res.json(sectionAssets);
    }

    lastExtractionSectionMode = false;

    if (extractionMode === 'direct') {
      try {
        const directAssets = await buildDirectVideoExtractResponse(targetUrl);
        return res.json(directAssets);
      } catch (directError: any) {
        return res.status(400).json({ error: directError?.message || 'Direct video extraction failed.' });
      }
    }

    if (
      isVideoPlatformHostUrl(targetUrl) &&
      !isPlaylistUrl(targetUrl) &&
      !isPlatformVideoUrl(targetUrl) &&
      !isPlatformMarketingHomepage(targetUrl)
    ) {
      return res.json({
        images: [],
        videos: [],
        fonts: [],
        colors: [],
      });
    }

    if (mode === 'quick') {
      const quickAssets = await withTimeout(
        extractQuickAssets(targetUrl, { videosOnly }),
        12000,
        `Quick extract for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      return res.json(quickAssets);
    }

    if (useStaticExtract) {
      const staticAssets = await withTimeout(
        extractStaticAssets(targetUrl, '', { fast: true, videosOnly }),
        isFastCrawl ? 35000 : 45000,
        `Static extract for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      return res.json(staticAssets);
    }

    const prefetchedSiteHtml = await withTimeout(
      fetchSiteHtml(targetUrl),
      12000,
      `Prefetch HTML for ${targetUrl}`
    ).catch(() => '');
    const staticFallbackAssets = async () => extractStaticAssets(targetUrl, prefetchedSiteHtml);

    if (!prefetchedSiteHtml || htmlLooksLikeBotWall(prefetchedSiteHtml)) {
      const blockedFallbackAssets = await withTimeout(
        extractReaderFallbackAssets(targetUrl, { videosOnly }),
        35000,
        `Blocked site fallback for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      if (isStrongStaticExtractForImmediateReturn(blockedFallbackAssets, { videosOnly })) {
        return res.json(blockedFallbackAssets);
      }
      const staticRecoveryAssets = await withTimeout(
        extractStaticAssets(targetUrl, '', { fast: true, videosOnly }),
        35000,
        `Static recovery before browser for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      if (isStrongStaticExtractForImmediateReturn(staticRecoveryAssets, { videosOnly })) {
        return res.json(staticRecoveryAssets);
      }
      if (isUsableStaticExtract(blockedFallbackAssets)) {
        return res.json(blockedFallbackAssets);
      }
    }

    if (prefetchedSiteHtml && !htmlLooksLikeBotWall(prefetchedSiteHtml)) {
      try {
        const hasVimeoHints = /vimeo\.com|data-vimeo-id/i.test(prefetchedSiteHtml);
        const staticQuickTimeoutMs = isToyotaVehicleExtractionTarget(targetUrl)
          ? 6000
          : hasVimeoHints
          ? 75000
          : shouldTryStaticBeforeBrowser(prefetchedSiteHtml)
            ? 45000
            : 18000;
        const staticQuick = await withTimeout(
          extractStaticAssets(targetUrl, prefetchedSiteHtml, { fast: true, videosOnly }),
          staticQuickTimeoutMs,
          `Static fast path for ${targetUrl}`
        );
        if (
          isUsableStaticExtract(staticQuick) &&
          (isStrongStaticExtractForImmediateReturn(staticQuick, { videosOnly }) ||
          !htmlNeedsRenderedExtraction(prefetchedSiteHtml) &&
          !staticExtractNeedsBrowser(prefetchedSiteHtml, staticQuick, { videosOnly }) &&
          !staticExtractHasUnresolvedEmbeds(prefetchedSiteHtml, staticQuick, { videosOnly }))
        ) {
          return res.json(staticQuick);
        }
      } catch (error: any) {
        console.warn('Static fast path skipped, continuing with browser route:', error?.message || error);
      }
    }
    
    const images: any[] = [];
    const videos: any[] = [];
    let fonts: any[] = [];
    let renderedComputedFonts: Array<{ family: string; weight?: string; style?: string }> = [];
    let colors: string[] = [];
    const vimeoCandidateUrls = new Set<string>();
    const wistiaCandidateIds = new Set<string>();
    const embeddedPageUrls = new Set<string>();

    const isYouTube = isYouTubeUrl(targetUrl);

    if (isPlaylistUrl(targetUrl)) {
      try {
        const playlistAssets = await extractPlaylistVideos(targetUrl);
        if (playlistAssets?.videos?.length > 1) {
          const cleanVideos = await prepareVisibleVideoStreams(playlistAssets.videos, targetUrl);
          return res.json({
            images: [],
            videos: cleanVideos,
            fonts: [],
            colors: [],
            playlist: playlistAssets.playlist,
          });
        }
      } catch (error: any) {
        console.warn('Playlist metadata extraction failed, continuing with single-video route:', error?.message || error);
      }
    }

    if (isBrightcoveUrl(targetUrl)) {
      try {
        const brightcoveAssets = await extractBrightcoveVideos(targetUrl);
        const cleanVideos = await prepareVisibleVideoStreams(brightcoveAssets.videos || [], targetUrl);
        if (cleanVideos.length > 0) {
          return res.json({
            images: [],
            videos: cleanVideos,
            fonts: [],
            colors: [],
          });
        }
      } catch (error: any) {
        console.warn('Brightcove direct extraction failed, continuing with browser route:', error?.message || error);
      }
    }

    if (isYouTube) {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(targetUrl) || targetUrl;
      const fallbackVideo = {
        url: toYouTubeMergedDownloadUrl(normalizedWatchUrl, 'fhd', pageTitleFromUrl(normalizedWatchUrl)),
        sourceStreamUrl: normalizedWatchUrl,
        sourceUrl: normalizedWatchUrl,
        pageUrl: normalizedWatchUrl,
        watchUrl: normalizedWatchUrl,
        provider: 'youtube',
        type: 'mp4',
        isYouTube: true,
        isYouTubeMerged: true,
        isDirect: true,
        isMp4Proxy: true,
        qualityRequested: 'fhd',
        displayQualityKey: 'fhd',
        displayQualityLabel: getCleanQualityLabel('fhd'),
        streamLabel: getCleanQualityLabel('fhd'),
        audioAvailable: true,
        hasAudio: true,
        noAudio: false,
        verifiedPlayable: true,
      };
      try {
        const ytDlpDirectVideos = await extractDirectYtDlpVideoStreams(targetUrl, ['fhd', 'hd'], true).catch((error: any) => {
          console.warn('YouTube yt-dlp direct extraction failed, trying ytdl-core:', error?.message || error);
          return [];
        });
        if (ytDlpDirectVideos.length > 0) {
          const cleanVideos = await prepareVisibleVideoStreams(ytDlpDirectVideos, targetUrl);
          if (cleanVideos.length > 0) {
            return res.json({
              images: [],
              videos: cleanVideos,
              fonts: [],
              colors: [],
            });
          }
        }

        let bestDirectVideo: any = null;
        const directVideo = await resolveYouTubeBestAvailableStream(targetUrl);
        if (directVideo?.url) {
          bestDirectVideo = directVideo;
        }

        const info = await ytdl.getInfo(targetUrl);

        const youtubeId = getYouTubeVideoId(targetUrl);
        const thumbnails = Array.isArray(info?.videoDetails?.thumbnails) ? info.videoDetails.thumbnails : [];
        const pickedThumb =
          thumbnails.length > 0
            ? thumbnails[thumbnails.length - 1]?.url
            : (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : '');
        const thumbnail = sanitizeStreamUrl(String(pickedThumb || ''), targetUrl) || String(pickedThumb || '');
        if (info.formats) {
          info.formats.forEach((format: any) => {
            const formatUrl = sanitizeStreamUrl(format.url, targetUrl);
            if (formatUrl && format.hasVideo && !isExpiredStreamUrl(formatUrl)) {
              const acodec = String(format.audioCodec || format.acodec || '');
              const hasAudio =
                Boolean(format.hasAudio) ||
                (acodec && acodec.toLowerCase() !== 'none' && acodec.toLowerCase() !== 'unknown');
              videos.push({
                url: formatUrl,
                sourceUrl: targetUrl,
                provider: 'youtube',
                type: 'mp4',
                resolution: format.qualityLabel || 'Unknown',
                formatId: format.itag || format.format_id,
                width: format.width,
                height: format.height,
                formatNote: format.quality,
                fps: format.fps,
                vcodec: format.videoCodec,
                acodec: format.audioCodec || format.acodec,
                hasAudio,
                filesize: format.contentLength,
                title: info.videoDetails?.title || 'YouTube video',
                thumbnail,
                duration: Number(info.videoDetails?.lengthSeconds || 0) || undefined,
                isYouTubeDirect: true
              });
            }
          });
        }

        if (bestDirectVideo?.url && videos.length === 0) {
          videos.push(bestDirectVideo);
        }
        videos.forEach((video) => {
          video.availableFormats = videos.length;
        });
        
        // Return early for YouTube to bypass browser
        const uniqueImages = Array.from(new Set(images.map(i => i.url))).map(url => images.find(i => i.url === url));
        const uniqueVideos = Array.from(new Set(videos.map(v => v.url))).map(url => videos.find(v => v.url === url));
        const cleanVideos = await prepareVisibleVideoStreams(
          uniqueVideos.map((video: any) => wrapYouTubePlaybackStream(
            video,
            normalizeYouTubeWatchUrl(targetUrl),
            String(video?.qualityRequested || getCleanQualityKey(video) || 'fhd')
          )),
          targetUrl
        );
        
        return res.json({
          images: [],
          videos: cleanVideos.length > 0 ? cleanVideos : [fallbackVideo],
          fonts: [],
          colors: [],
        });
      } catch (err: any) {
        console.error('ytdl-core error:', err.message);
        const directVideo =
          await extractDirectYtDlpVideoStream(targetUrl, 'fhd').catch(() => null) ||
          await resolveYouTubeBestAvailableStream(targetUrl);
        const cleanVideos = await prepareVisibleVideoStreams(directVideo?.url ? [directVideo] : [], targetUrl);
        return res.json({
          images: [],
          videos: cleanVideos.length > 0 ? cleanVideos : [fallbackVideo],
          fonts: [],
          colors: [],
        });
      }
    }

    if (isVimeoUrl(targetUrl)) {
      const vimeoUrl = normalizeVimeoUrl(targetUrl);
      if (vimeoUrl) {
        try {
          const vimeoAssets = await withTimeout(
            extractVimeoVideos([vimeoUrl], 'fhd', targetUrl),
            VIMEO_EXTRACT_TIMEOUT_MS,
            `Vimeo extraction for ${vimeoUrl}`
          );
          let cleanVideos = await prepareVisibleVideoStreams(vimeoAssets.videos || [], vimeoUrl);
          if (cleanVideos.length === 0 && (vimeoAssets.videos || []).length > 0) {
            cleanVideos = normalizeVisibleVideoStreams(vimeoAssets.videos, vimeoUrl);
          }
          if (cleanVideos.length === 0) {
            cleanVideos = [];
          }
          return res.json({
            images: [],
            videos: cleanVideos,
            fonts: [],
            colors: [],
          });
        } catch (error: any) {
          console.warn('Vimeo extraction failed:', error?.message || error);
          return res.json({
            images: [],
            videos: [],
            fonts: [],
            colors: [],
          });
        }
      }
    }

    if (isXUrl(targetUrl) || isFacebookUrl(targetUrl) || isInstagramUrl(targetUrl)) {
      const fallbackVideo = isPlatformVideoUrl(targetUrl)
        ? {
            url: targetUrl,
            sourceUrl: targetUrl,
            provider: platformProviderFromUrl(targetUrl),
            type: 'video',
            title: platformProviderFromUrl(targetUrl) === 'x' ? 'X video' : `${platformProviderFromUrl(targetUrl)} video`,
          }
        : null;
      try {
        const platformAssets = await extractDirectPlatformVideoStreams(targetUrl, 'fhd');
        const cleanPlatformVideos = await prepareVisibleVideoStreams(platformAssets.videos || [], targetUrl);
        return res.json({
          images: [],
          videos: cleanPlatformVideos.length > 0 ? cleanPlatformVideos : (fallbackVideo ? [fallbackVideo] : []),
          fonts: [],
          colors: [],
        });
      } catch (error: any) {
        console.warn('Fast platform video extraction failed:', error?.message || error);
        return res.json({
          images: [],
          videos: fallbackVideo ? [fallbackVideo] : [],
          fonts: [],
          colors: [],
        });
      }
    }

    // Toyota's vehicle page often spends most of the generic 30s budget in
    // consent/app hydration before its image viewer requests appear. Give this
    // known extraction target enough time to expose the real blue 360 seed;
    // other fast crawls keep the existing budget.
    const needsLoaderGateBudget = /(?:^|\.)joannamendoza\.com$/i.test(new URL(targetUrl).hostname);
    const browserBudgetMs = isToyotaVehicleExtractionTarget(targetUrl)
      ? 45000
      : needsLoaderGateBudget
        ? 65000
      : isFastCrawl
        ? 30000
        : 120000;
    activeExtractProgress?.setPhase('loading');
    // Launch parallel quick static extraction in a worker thread
    quickExtractPromise = extractionProxyUrl ? Promise.resolve(null) : quickExtractInWorker(targetUrl).catch(() => null);

    // IMPORTANT: Browser extraction runs asynchronously to avoid HTTP idle timeout.
    // The HTTP response returns immediately with { async: true }.
    // When the browser extraction completes, the results are broadcast via WebSocket
    // and the frontend picks them up from the WS 'complete' event.
    const browserExtractPromise = withTimeout(
      (async () => {
    browser = await launchPuppeteerBrowser();
    let lastNewAssetAt = Date.now();
    const touchAssetActivity = () => {
      lastNewAssetAt = Date.now();
    };
    
    const page = await acquireSingleWebsitePage(browser);
    await page.setViewport({ width: 1440, height: 1100 });
    await applyPuppeteerStealth(page);
    
    // Intercept network requests
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      if (
        !videosOnly &&
        (resourceType === 'image' ||
          /\/medias\/[^?#]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(requestUrl))
      ) {
        const asset = createImageAsset(requestUrl, targetUrl, {}, { permissive: true });
        pushImageAsset(images, asset);
        touchAssetActivity();
      }
      if (videosOnly && ['image', 'font', 'stylesheet'].includes(resourceType)) {
        request.abort();
        return;
      }
      if (['websocket', 'eventsource'].includes(resourceType)) {
        request.abort();
        return;
      }
      if (/google-analytics|googletagmanager|doubleclick|facebook\.net\/tr|hotjar|clarity\.ms|segment\.io/i.test(requestUrl)) {
        request.abort();
        return;
      }
      request.continue();
    });
    
    const handlePageResponse = async (response: any) => {
      const url = sanitizeStreamUrl(response.url(), targetUrl) || response.url();
      const resourceType = response.request().resourceType();
      const status = response.status();
      const headers = response.headers ? response.headers() : {};
      const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();

      if (isVimeoUrl(url)) {
        const vimeoUrl = normalizeVimeoUrl(url);
        if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
      }
      
      if (status >= 200 && status < 300) {
        const looksLikeImageResponse =
          !videosOnly &&
          (resourceType === 'image' ||
          /^image\//i.test(contentType));
        if (looksLikeImageResponse && (isLikelyImageAssetUrl(url, contentType) || resourceType === 'image')) {
          images.push({
            url,
            type: inferImageTypeFromUrl(url, contentType) || getAssetTypeFromUrl(url, 'img'),
            status: DEFAULT_ASSET_STATUS,
          });
          touchAssetActivity();
          if (!isFastCrawl) {
            void (async () => {
              try {
                const buffer = Buffer.from(await withTimeout(Promise.resolve(response.buffer()), 4000, 'Image buffer read'));
                const cachedUrl = await writeCachedOriginalImageFromBuffer(
                  url,
                  buffer,
                  contentType,
                  inferImageTypeFromUrl(url, contentType) || 'bin'
                );
                if (cachedUrl) {
                  const existing = images.find((item) => item.url === url);
                  if (existing) {
                    existing.cachedUrl = cachedUrl;
                    existing.status = 'downloaded';
                  }
                }
              } catch {
                const existing = images.find((item) => item.url === url);
                if (existing && !existing.cachedUrl) existing.status = 'failed-download';
                // Some cross-origin image bodies cannot be read from DevTools protocol.
              }
            })();
          }
        }

        const looksLikeVideoResponse =
          resourceType === 'media' ||
          /video\/|mpegurl|dash\+xml/i.test(contentType) ||
          isLikelyVideoAssetUrl(url);
        if (looksLikeVideoResponse) {
          videos.push({
            url,
            sourceUrl: targetUrl,
            provider: platformProviderFromUrl(url),
            type: getVideoFormatFromUrlOrType(url, contentType),
            title: pageTitleFromUrl(url),
            isDirect: isLikelyDirectVideoStreamUrl(url) || isLikelyVideoAssetUrl(url),
            status: DEFAULT_ASSET_STATUS,
          });
        }

        const looksLikeFontResponse =
          resourceType === 'font' ||
          /font\/|application\/font|vnd\.ms-fontobject/i.test(contentType) ||
          /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url);
        if (looksLikeFontResponse) {
          const format = getFontFormatFromUrlOrType(url, contentType);
          if (isSupportedFontFormat(format)) {
            fonts.push({
              family: '',
              url: url,
              format,
              status: DEFAULT_ASSET_STATUS,
            });
          }
        }

        if (resourceType === 'stylesheet' || /text\/css/i.test(contentType) || /\.css(\?|$)/i.test(url)) {
          try {
            const cssReadMs = isFastCrawl ? 1000 : 1500;
            const cssText = String(await withTimeout(Promise.resolve(response.text()), cssReadMs, 'Stylesheet read'));
            if (isFastCrawl && cssText.length > 400_000) return;
            fonts.push(...extractFontsFromCss(cssText, String(url)));
            images.push(...extractImagesFromCss(cssText, String(url)));
            const rawAssets = extractAssetsFromRawText(cssText, String(url));
            images.push(...rawAssets.images);
            videos.push(...rawAssets.videos);
            fonts.push(...rawAssets.fonts);
          } catch {
            // Some cross-origin responses cannot be read from DevTools protocol; network URL capture above still helps.
          }
        }

        if (resourceType === 'script' || /(?:javascript|json|text\/plain)/i.test(contentType) || /\.(?:js|json)(\?|$)/i.test(url)) {
          try {
            const sourceText = String(await withTimeout(Promise.resolve(response.text()), 1500, 'Script/config read'));
            const rawAssets = extractAssetsFromRawText(sourceText, String(url));
            images.push(...rawAssets.images);
            videos.push(...rawAssets.videos);
            fonts.push(...rawAssets.fonts);
          } catch {
            // Keep the response URL itself; body reads can be blocked for protected configs.
          }
        }

        if (
          (resourceType === 'xhr' || resourceType === 'fetch') &&
          /(?:application\/json|text\/json|\+json)/i.test(contentType)
        ) {
          try {
            const jsonText = String(await withTimeout(Promise.resolve(response.text()), 2500, 'XHR JSON read'));
            const rawAssets = extractAssetsFromRawText(jsonText, targetUrl);
            if (!videosOnly) {
              images.push(...rawAssets.images);
              fonts.push(...rawAssets.fonts);
            }
            videos.push(...rawAssets.videos);
          } catch {
            // Ignore unreadable XHR payloads.
          }
        }
      }
    };

    page.on('response', handlePageResponse);
    page.on('pageerror', (pageErr: Error) => {
      console.warn('Page JS error during extraction:', pageErr?.message || pageErr || 'unknown');
    });

    // Long-lived analytics, ad and streaming requests make networkidle2 a poor
    // readiness signal for modern sites. DOM readiness plus the bounded asset
    // settle/scroll passes below is both faster and more reliable.
    const pageLoadTimeout = isFastCrawl ? 12000 : 25000;
    const pageWaitUntil = 'domcontentloaded';
    const navigated = await page
      .goto(targetUrl, { waitUntil: pageWaitUntil as 'domcontentloaded' | 'networkidle2', timeout: pageLoadTimeout })
      .catch((e) => {
        console.log('Goto timeout, continuing...', e?.message || e);
        return null;
      });
    if (!navigated) {
      // A timeout often means the document loaded but a subresource never
      // completed. Do not pay for a second full navigation when usable DOM is
      // already present.
      const currentPageUrl = String(page.url?.() || '');
      if (!currentPageUrl || currentPageUrl === 'about:blank') {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(pageLoadTimeout, 12000) }).catch(() => undefined);
      }
      await waitForPageContentSettle(page, {
        minWaitMs: isFastCrawl ? 6000 : 9000,
        readinessTimeoutMs: isFastCrawl ? 3500 : 6000,
      });
    } else if (isFastCrawl) {
      await waitForPageContentSettle(page, { minWaitMs: 6000, readinessTimeoutMs: 3500 });
    } else {
      await waitForPageContentSettle(page, { minWaitMs: 9000, readinessTimeoutMs: 6000 });
    }

    let initialHtml = await page.content().catch(() => '');
    const shouldWaitForChallengeOrLoader =
      pageHtmlLooksBlocked(initialHtml) ||
      /captcha|verify you are human|checking (?:your browser|the site connection)|just a moment|loading|loader|challenge/i.test(
        initialHtml.slice(0, 160000)
      );
    if (shouldWaitForChallengeOrLoader) {
      activeExtractProgress?.setTask('Waiting for website loader or captcha gate');
      await waitForChallengeOrLoaderSettle(page, {
        timeoutMs: isFastCrawl ? 30000 : 60000,
        minAssetWaitMs: isFastCrawl ? 9000 : 14000,
      });
      await waitForPageContentSettle(page, {
        minWaitMs: isFastCrawl ? 6000 : 9000,
        readinessTimeoutMs: isFastCrawl ? 3500 : 6000,
      });
      initialHtml = await page.content().catch(() => initialHtml);
    }

    if (pageHtmlLooksBlocked(initialHtml)) {
      await new Promise((resolve) => setTimeout(resolve, isFastCrawl ? 2500 : 4500));
      await page
        .goto(targetUrl, {
          waitUntil: isFastCrawl ? 'domcontentloaded' : 'networkidle2',
          timeout: isFastCrawl ? 15000 : 45000,
        })
        .catch(() => undefined);
      await waitForPageContentSettle(page, {
        minWaitMs: isFastCrawl ? 6000 : 9000,
        readinessTimeoutMs: isFastCrawl ? 3500 : 6000,
      });
      initialHtml = await page.content().catch(() => initialHtml);
    }

    if (pageHtmlLooksBlocked(initialHtml)) {
      throw new Error(
        'This website is protected by a captcha or browser verification gate. Please open the page in Chrome, complete the captcha, then run extraction again.'
      );
    }

    activeExtractProgress?.setPhase('dom');
    activeExtractProgress?.setTask('Scanning page DOM and network assets');
    const scrollBudgetMs = isFastCrawl ? 12000 : 45000;
    const needsScroll = await pageNeedsLazyLoadScroll(page, initialHtml);
    if (needsScroll) {
      activeExtractProgress?.setPhase('scroll');
      activeExtractProgress?.setTask('Scrolling for lazy-loaded assets');
      await performLazyLoadScroll(page, {
        stepDelayMs: isFastCrawl ? 450 : 800,
        maxStableRounds: isFastCrawl ? 2 : 4,
        maxDurationMs: scrollBudgetMs,
      });
      await page
        .evaluate(() => {
          const clickables = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[class*="swiper-button-next"], [class*="carousel"] button, [aria-label*="next" i], [data-testid*="next" i], button.slick-next'
            )
          );
          clickables.slice(0, 12).forEach((el) => {
            try {
              el.click();
            } catch {
            }
          });
        })
        .catch(() => undefined);
      if (!isFastCrawl) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await performLazyLoadScroll(page, { stepDelayMs: 700, maxStableRounds: 3, maxDurationMs: 30000 });
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, isFastCrawl ? 500 : 1800));
    }

    try {
      const renderedDom = await extractRenderedDomAssetsFromPage(page);
      if (Array.isArray(renderedDom?.images)) {
        renderedDom.images.forEach((imageUrl) => {
          const asset = createImageAsset(imageUrl, targetUrl, {}, { permissive: true });
          pushImageAsset(images, asset);
        });
      }
      if (Array.isArray(renderedDom?.videos)) {
        renderedDom.videos.forEach((entry) => {
          if (!entry?.url) return;
          const absoluteUrl = sanitizeStreamUrl(entry.url, targetUrl) || resolveUrl(targetUrl, entry.url);
          if (!absoluteUrl) return;
          if (isVimeoUrl(absoluteUrl)) {
            const vimeoUrl = normalizeVimeoUrl(absoluteUrl);
            if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
          }
          videos.push({
            url: absoluteUrl,
            sourceUrl: targetUrl,
            provider: platformProviderFromUrl(absoluteUrl),
            type: isPlatformVideoUrl(absoluteUrl) ? 'video' : getAssetTypeFromUrl(absoluteUrl, 'video'),
            title: entry.title || pageTitleFromUrl(absoluteUrl),
            thumbnail: entry.poster ? resolveUrl(targetUrl, entry.poster) || entry.poster : '',
            status: DEFAULT_ASSET_STATUS,
          });
        });
      }
      if (Array.isArray(renderedDom?.fontFamilies)) {
        renderedDom.fontFamilies.forEach((family) => {
          if (!family) return;
          fonts.push({ family, url: '', format: 'computed', status: DEFAULT_ASSET_STATUS });
        });
      }
      if (Array.isArray(renderedDom?.computedFonts)) {
        renderedComputedFonts = renderedDom.computedFonts
          .map((entry: any) => ({
            family: String(entry?.family || '').trim(),
            weight: String(entry?.weight || '').trim() || undefined,
            style: String(entry?.style || '').trim() || undefined,
          }))
          .filter((entry: any) => entry.family);
      }
      if (Array.isArray(renderedDom?.fontFaceCss)) {
        renderedDom.fontFaceCss.forEach((cssText) => {
          fonts.push(...extractFontsFromCss(String(cssText || ''), targetUrl));
        });
      }
      if (Array.isArray(renderedDom?.stylesheetUrls) && renderedDom.stylesheetUrls.length > 0) {
        const renderedStylesheetUrls = prioritizeFontCssCandidates(
          renderedDom.stylesheetUrls.filter((url: unknown) => typeof url === 'string' && /^https?:\/\//i.test(url))
        ).slice(0, isFastCrawl ? 24 : 72);
        const renderedStylesheetResults = await mapWithConcurrency(renderedStylesheetUrls, 8, async (cssUrl) => {
          try {
            assertPublicAssetUrl(cssUrl);
            const response = await axios.get(cssUrl, {
              timeout: isFastCrawl ? 3500 : 6000,
              httpsAgent: relaxedHttpsAgent,
              validateStatus: (status) => status === 200,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Referer: targetUrl,
              },
            });
            return extractFontsFromCss(String(response.data || ''), cssUrl);
          } catch {
            return [];
          }
        });
        renderedStylesheetResults.forEach((stylesheetFonts) => fonts.push(...stylesheetFonts));
      }
    } catch {
      // Ignore rendered DOM scan failures.
    }

    // Multi-pass: scroll again only when the fast pass still looks sparse.
    {
      let prevCount = images.length;
      const shouldRunExtraPasses =
        !isFastCrawl ||
        images.length < 12 ||
        (Date.now() - lastNewAssetAt < 2500 && images.length < 40);
      const maxPasses = isFastCrawl ? 1 : 3;
      for (let pass = 0; shouldRunExtraPasses && pass < maxPasses; pass++) {
        try {
          await performLazyLoadScroll(page, {
            stepDelayMs: isFastCrawl ? 350 : 500,
            maxStableRounds: 2,
            maxDurationMs: isFastCrawl ? 7000 : 15000,
          });
        } catch (scrollErr: any) {
          console.warn(`Multi-pass scroll round ${pass + 1} failed:`, scrollErr?.message || scrollErr);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        const moreDom = await extractRenderedDomAssetsFromPage(page).catch(() => null);
        if (Array.isArray(moreDom?.images)) {
          moreDom.images.forEach((imageUrl: string) => {
            const asset = createImageAsset(imageUrl, targetUrl, {}, { permissive: true });
            pushImageAsset(images, asset);
          });
        }
        const newCount = images.length;
        if (newCount === prevCount) break;
        prevCount = newCount;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 400));

    // Trigger lazy media players that only request the stream after a visible play interaction.
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        'button, [role="button"], a, .play, .play-button, [class*="play"], [aria-label*="play" i], [title*="play" i]'
      ));
      candidates.slice(0, 12).forEach((el) => {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''} ${el.textContent || ''}`;
        const rect = el.getBoundingClientRect();
        if (/play|watch|video/i.test(label) && rect.width > 10 && rect.height > 10) {
          try {
            el.click();
          } catch {
            // Ignore synthetic click failures.
          }
        }
      });
    }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 700));

    // Vimeo players sometimes expose only a blob: stream URL in the DOM.
    // In that case, we still want to surface the underlying Vimeo video id URL.
    try {
      const domVimeoUrls = await page.evaluate(() => {
        const urls = new Set<string>();
        var _ = {
          addId(id: string) {
            const clean = String(id || '').trim();
            if (/^\d{6,}$/.test(clean)) urls.add(`https://vimeo.com/${clean}`);
          },
          scanText(value: string) {
            const text = String(value || '')
              .replace(/\\\//g, '/')
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"');
            const re = /(?:https?:)?\/\/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/)?(\d+)/gi;
            let match: RegExpExecArray | null;
            while ((match = re.exec(text)) !== null) _.addId(match[1]);

            const idRegex = /(?:vimeo(?:Video)?Id|vimeo_id|vimeoId|clip_id|clipId)["']?\s*[:=]\s*["']?(\d{6,})/gi;
            while ((match = idRegex.exec(text)) !== null) _.addId(match[1]);
          },
        };

        // 1) Scripts often embed the numeric id even when the DOM shows blob:.
        Array.from(document.querySelectorAll('script'))
          .map((script) => script.textContent || '')
          .filter(Boolean)
          .slice(0, 120)
          .forEach((s) => _.scanText(s));

        // 2) Common data attributes used by Vimeo wrappers.
        const attrNames = ['data-vimeo-id', 'data-vimeoid', 'data-video-id', 'data-clip-id', 'data-vimeo-video-id'];
        Array.from(document.querySelectorAll<HTMLElement>('[data-vimeo-id],[data-vimeoid],[data-video-id],[data-clip-id],[data-vimeo-video-id]'))
          .slice(0, 120)
          .forEach((node) => {
            for (const attr of attrNames) {
              const val = node.getAttribute(attr);
              if (val) _.addId(val);
            }
          });

        // 3) Last resort: scan nearby markup around Vimeo blob videos.
        Array.from(document.querySelectorAll<HTMLVideoElement>('video[src^=\"blob:\"]'))
          .slice(0, 40)
          .forEach((video) => {
            const src = String(video.getAttribute('src') || '');
            if (!/blob:https?:\/\/player\.vimeo\.com/i.test(src)) return;
            const wrapper = video.closest('div, section, article') as HTMLElement | null;
            if (wrapper) _.scanText(wrapper.outerHTML);
          });

        return Array.from(urls);
      });
      if (Array.isArray(domVimeoUrls)) {
        domVimeoUrls.forEach((vimeoUrl) => {
          const normalized = normalizeVimeoUrl(vimeoUrl);
          if (normalized) vimeoCandidateUrls.add(normalized);
        });
      }
    } catch {
      // Ignore DOM scan failures.
    }

    try {
      const domPlayerCandidates = await page.evaluate(() => {
        const players: Array<{ url: string; title: string; poster: string; provider: string }> = [];
        const seen = new Set<string>();
        var _ = {
          addBrightcove(accountId: string, playerId: string, videoId: string, title = '', poster = '') {
            const account = String(accountId || '').trim();
            const video = String(videoId || '').trim();
            if (!account || !video) return;
            const player = String(playerId || 'default').trim() || 'default';
            const normalizedPlayer = player.endsWith('_default') ? player : `${player}_default`;
            const url = `https://players.brightcove.net/${account}/${normalizedPlayer}/index.html?videoId=${video}`;
            if (seen.has(url)) return;
            seen.add(url);
            players.push({ url, title: title || 'Brightcove video', poster, provider: 'brightcove' });
          },
        };

        document.querySelectorAll('gb-video-brightcove, [data-account-id][data-video-id], [data-bc-video-id]').forEach((el) => {
          const node = el as HTMLElement;
          _.addBrightcove(
            node.getAttribute('data-account-id') || node.getAttribute('account-id') || '',
            node.getAttribute('data-player-id') || node.getAttribute('player-id') || 'default',
            node.getAttribute('data-video-id') || node.getAttribute('data-bc-video-id') || node.getAttribute('video-id') || '',
            node.getAttribute('aria-label') || node.getAttribute('title') || '',
            node.querySelector('img')?.getAttribute('src') || node.getAttribute('poster') || ''
          );
        });

        const scriptText = Array.from(document.querySelectorAll('script')).map((s) => s.textContent || '').join('\n');
        const normalizedScript = scriptText.replace(/\\\//g, '/').replace(/\\"/g, '"');
        const bcRegex = /data-account-id=["'](\d+)["'][\s\S]{0,400}?data-video-id=["'](\d+)["']/gi;
        let bcMatch: RegExpExecArray | null;
        while ((bcMatch = bcRegex.exec(normalizedScript)) !== null) {
          _.addBrightcove(bcMatch[1], 'default', bcMatch[2]);
        }
        const bcJsonRegex = /"accountId"\s*:\s*"(\d+)"[\s\S]{0,300}?"(?:videoId|id)"\s*:\s*"(\d+)"/gi;
        while ((bcMatch = bcJsonRegex.exec(normalizedScript)) !== null) {
          _.addBrightcove(bcMatch[1], 'default', bcMatch[2]);
        }

        const jwRegex = /(?:jwplayer|playlist)\s*\([\s\S]{0,800}?(https?:\/\/[^"'\\]+\.(?:mp4|m3u8)[^"'\\]*)/gi;
        let jwMatch: RegExpExecArray | null;
        while ((jwMatch = jwRegex.exec(normalizedScript)) !== null) {
          const url = jwMatch[1];
          if (!url || seen.has(url)) continue;
          seen.add(url);
          players.push({ url, title: 'JW Player video', poster: '', provider: 'jwplayer' });
        }

        const kalturaRegex = /"entryId"\s*:\s*"([^"]+)"/gi;
        let kMatch: RegExpExecArray | null;
        while ((kMatch = kalturaRegex.exec(normalizedScript)) !== null) {
          const entryId = String(kMatch[1] || '').trim();
          if (!entryId) continue;
          const url = `https://cdnapi.kaltura.com/p/0/sp/0/playManifest/entryId/${entryId}/format/applehttp/protocol/https/a.m3u8`;
          if (seen.has(url)) continue;
          seen.add(url);
          players.push({ url, title: 'Kaltura video', poster: '', provider: 'kaltura' });
        }

        document.querySelectorAll('video[src], video source[src]').forEach((el) => {
          const src = (el as HTMLMediaElement).getAttribute('src') || '';
          if (!src || src.startsWith('blob:') || seen.has(src)) return;
          if (!/\.(mp4|webm|m3u8|mpd)(\?|$)/i.test(src)) return;
          seen.add(src);
          players.push({ url: src, title: 'Embedded video', poster: '', provider: 'direct' });
        });

        return players;
      });
      if (Array.isArray(domPlayerCandidates)) {
        domPlayerCandidates.forEach((candidate) => {
          if (!candidate?.url) return;
          videos.push({
            url: candidate.url,
            sourceUrl: targetUrl,
            provider: candidate.provider || platformProviderFromUrl(candidate.url),
            type: 'video',
            title: candidate.title || 'Video',
            thumbnail: candidate.poster || resolvedPagePrimaryThumb,
          });
        });
      }
    } catch {
      // Ignore runtime player scan failures.
    }

    // Extract colors from the full rendered DOM, including fills, borders, and backgrounds.
    const domColors = videosOnly ? [] : await page.evaluate(`
      (() => {
        const isTransparent = (value) => !value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
        const rgbToHex = (rgb) => {
          const result = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(rgb);
          if (!result) return '';
          return "#" + (1 << 24 | parseInt(result[1]) << 16 | parseInt(result[2]) << 8 | parseInt(result[3])).toString(16).slice(1);
        };
        const toHex = (value) => {
          if (!value || typeof value !== 'string') return '';
          const v = value.trim();
          if (v.startsWith('#')) return v.toLowerCase();
          const hex = rgbToHex(v);
          return hex ? hex.toLowerCase() : '';
        };

        const scoreByColor = new Map();
        const bump = (hex, weight) => {
          if (!hex) return;
          const prev = scoreByColor.get(hex) || 0;
          scoreByColor.set(hex, prev + weight);
        };

        const candidates = document.querySelectorAll('body, body *');
        candidates.forEach((el) => {
          const tag = (el.tagName || '').toLowerCase();
          const cls = (el.getAttribute('class') || '').toLowerCase();
          const isCTA = tag === 'button' || cls.includes('cta') || cls.includes('btn') || el.getAttribute('role') === 'button';
          const isHeading = tag.startsWith('h') || cls.includes('heading') || cls.includes('title') || cls.includes('subtitle');
          const isIcon = tag === 'svg' || cls.includes('icon');
          const weight = isCTA ? 6 : isHeading ? 4 : isIcon ? 3 : 1;

          const style = window.getComputedStyle(el);
          const fg = toHex(style.color);
          const bg = toHex(style.backgroundColor);
          const border = toHex(style.borderColor);

          if (!isTransparent(style.color)) bump(fg, weight);
          if (!isTransparent(style.backgroundColor)) bump(bg, Math.max(1, weight - 1));
          if (style.borderWidth !== '0px' && style.borderStyle !== 'none' && !isTransparent(style.borderColor)) bump(border, Math.max(1, weight - 2));

          if (tag === 'svg') {
            const fill = toHex(style.fill);
            const stroke = toHex(style.stroke);
            if (!isTransparent(style.fill)) bump(fill, weight);
            if (!isTransparent(style.stroke)) bump(stroke, weight);
          }
        });

        const sorted = Array.from(scoreByColor.entries())
          .filter(([hex]) => /^#[0-9a-f]{6}$/i.test(hex))
          .sort((a, b) => b[1] - a[1])
          .map(([hex]) => hex);

        return sorted;
      })()
    `) as string[];

    colors = domColors;

    // Also extract from DOM just in case (like inline SVGs, colors)
    const html = await waitForRenderedSiteHtml(page);
    const $ = cheerio.load(html);
    const pagePrimaryThumb =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      '';
    const resolvedPagePrimaryThumb = pagePrimaryThumb ? resolveUrl(targetUrl, pagePrimaryThumb) || pagePrimaryThumb : '';
    const pageTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').first().text().trim() ||
      'Video link';

    extractVimeoUrlsFromText(html, targetUrl).forEach((vimeoUrl) => vimeoCandidateUrls.add(vimeoUrl));
    extractWistiaIdsFromText(`${targetUrl}\n${html}`, targetUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));

    if (!videosOnly) {
      images.push(...extractImagesFromDom($, targetUrl));
      images.push(...extractImagesFromHtmlString(html, targetUrl));
    }
    const rawRenderedAssets = extractAssetsFromRawText(html, targetUrl);
    if (!videosOnly) {
      images.push(...rawRenderedAssets.images);
      fonts.push(...rawRenderedAssets.fonts);
    }
    videos.push(...rawRenderedAssets.videos);

    if (prefetchedSiteHtml) {
      const $prefetch = cheerio.load(prefetchedSiteHtml);
      if (!videosOnly) {
        images.push(...extractImagesFromDom($prefetch, targetUrl));
        images.push(...extractImagesFromHtmlString(prefetchedSiteHtml, targetUrl));
      }
      const rawPrefetchAssets = extractAssetsFromRawText(prefetchedSiteHtml, targetUrl);
      if (!videosOnly) {
        images.push(...rawPrefetchAssets.images);
        fonts.push(...rawPrefetchAssets.fonts);
      }
      videos.push(...rawPrefetchAssets.videos);
    }

    // Extract Videos
    const addVideoCandidate = (urlStr: string | undefined, poster?: string, title?: string) => {
      if (!urlStr) return;
      const absoluteUrl = sanitizeStreamUrl(urlStr, targetUrl);
      if (!absoluteUrl || absoluteUrl.startsWith('data:')) return;
      if (!isLikelyVideoAssetUrl(absoluteUrl) && !isPlatformVideoUrl(absoluteUrl)) return;
      videos.push({
        url: absoluteUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(absoluteUrl),
        type: isPlatformVideoUrl(absoluteUrl) ? 'video' : getAssetTypeFromUrl(absoluteUrl, 'video'),
        title: title || pageTitle,
        thumbnail: poster ? resolveUrl(targetUrl, poster) || poster : resolvedPagePrimaryThumb,
        status: DEFAULT_ASSET_STATUS,
      });
    };

    $('video source').each((_, el) => {
      const src = $(el).attr('src');
      addVideoCandidate(src);
    });
    $('video').each((_, el) => {
      const src = $(el).attr('src');
      const poster = $(el).attr('poster');
      addVideoCandidate(src, poster);
      $(el).find('source').each((__, sourceEl) => {
        addVideoCandidate($(sourceEl).attr('src'), poster);
      });
    });

    // Extract from common data attributes used by dynamic players.
    $('[data-src], [data-video], [data-video-src], [data-video-url], [data-mp4], [data-hls], [data-stream], [data-url]').each((_, el) => {
      const poster = $(el).attr('data-poster') || $(el).attr('poster');
      const title = $(el).attr('aria-label') || $(el).attr('title') || undefined;
      const candidates = [
        $(el).attr('data-src'),
        $(el).attr('data-video'),
        $(el).attr('data-video-src'),
        $(el).attr('data-video-url'),
        $(el).attr('data-mp4'),
        $(el).attr('data-hls'),
        $(el).attr('data-stream'),
        $(el).attr('data-url'),
      ];
      candidates.forEach((candidate) => addVideoCandidate(candidate, poster, title));
    });

    // Extract from raw HTML / JSON blobs where video urls are embedded but not requested yet.
    const htmlVideoUrlRegex = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#\s"'<>\\])(?:[?#][^\s"'<>\\]*)?/gi;
    const relativeVideoUrlRegex = /(?:["'`])(\/[^"'`<>\\]+?\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'`<>\\])(?:[?#][^"'`<>\\]*)?)(?:["'`])/gi;
    const rawMatches = html.match(htmlVideoUrlRegex) || [];
    rawMatches.forEach((match) => addVideoCandidate(match));
    extractYouTubeUrlsFromText(html, targetUrl).forEach((youtubeUrl) => addVideoCandidate(youtubeUrl));
    extractBrightcoveVideosFromHtml(html, targetUrl).forEach((brightcoveVideo) => {
      videos.push({
        ...brightcoveVideo,
        thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb,
      });
    });
    let relMatch;
    while ((relMatch = relativeVideoUrlRegex.exec(html)) !== null) {
      addVideoCandidate(relMatch[1]);
    }

    try {
      const deepVideoCandidates = await withTimeout(
        discoverSiteVideoCandidates(targetUrl, html),
        6000,
        `Deep video crawl for ${targetUrl}`
      );
      deepVideoCandidates.vimeoUrls.forEach((vimeoUrl) => vimeoCandidateUrls.add(vimeoUrl));
      (deepVideoCandidates.wistiaIds || []).forEach((wistiaId: string) => wistiaCandidateIds.add(wistiaId));
      deepVideoCandidates.videoUrls.forEach((videoUrl) => addVideoCandidate(videoUrl));
      (deepVideoCandidates.brightcoveVideos || []).forEach((brightcoveVideo: any) => {
        videos.push({
          ...brightcoveVideo,
          thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb,
        });
      });
    } catch (error: any) {
      console.warn('Deep video crawl failed:', error?.message || error);
    }

    $('iframe, embed, object').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data') || '';
      const absoluteUrl = resolveUrl(targetUrl, src);
      if (absoluteUrl && !absoluteUrl.startsWith('data:')) {
        embeddedPageUrls.add(absoluteUrl);
      }
      if (absoluteUrl && isVimeoUrl(absoluteUrl)) {
        const vimeoUrl = normalizeVimeoUrl(absoluteUrl);
        if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
      }
      if (absoluteUrl && isYouTubeUrl(absoluteUrl) && isPlatformVideoUrl(absoluteUrl)) {
        addVideoCandidate(normalizeYouTubeWatchUrl(absoluteUrl), undefined, $(el).attr('title') || $(el).attr('aria-label') || undefined);
      } else if (absoluteUrl && isPlatformVideoUrl(absoluteUrl)) {
        addVideoCandidate(absoluteUrl, undefined, $(el).attr('title') || $(el).attr('aria-label') || undefined);
      }
    });

    $('a[href], [data-href], [data-url], [data-video-url]').each((_, el) => {
      const possibleUrls = [
        $(el).attr('href'),
        $(el).attr('data-href'),
        $(el).attr('data-url'),
        $(el).attr('data-video-url'),
      ];

      possibleUrls.forEach((possibleUrl) => {
        if (!possibleUrl) return;
        const absoluteUrl = resolveUrl(targetUrl, possibleUrl);
        if (absoluteUrl && isVimeoUrl(absoluteUrl)) {
          const vimeoUrl = normalizeVimeoUrl(absoluteUrl);
          if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
        }
        if (absoluteUrl && isYouTubeUrl(absoluteUrl) && isPlatformVideoUrl(absoluteUrl)) {
          addVideoCandidate(normalizeYouTubeWatchUrl(absoluteUrl), $(el).find('img').attr('src'), $(el).attr('title') || $(el).text().trim());
        } else if (absoluteUrl && isPlatformVideoUrl(absoluteUrl)) {
          addVideoCandidate(absoluteUrl, $(el).find('img').attr('src'), $(el).attr('title') || $(el).text().trim());
        }
      });
    });

    await mapWithConcurrency(Array.from(embeddedPageUrls).slice(0, 2), 2, async (embeddedUrl) => {
      let embeddedPage: any;
      try {
	        embeddedPage = await acquireSingleWebsitePage(browser);
	        await applyProxyAuthToPage(embeddedPage);
        embeddedPage.on('response', handlePageResponse);
        await embeddedPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await embeddedPage.setRequestInterception(true);
        embeddedPage.on('request', (request: any) => {
          const resourceType = request.resourceType();
          if (['image', 'font', 'stylesheet'].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });
        await embeddedPage.goto(embeddedUrl, { waitUntil: 'domcontentloaded', timeout: 3500 }).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 500));

        const embeddedHtml = await embeddedPage.content();
        extractVimeoUrlsFromText(embeddedHtml, embeddedUrl).forEach((vimeoUrl) => vimeoCandidateUrls.add(vimeoUrl));
        extractWistiaIdsFromText(embeddedHtml, embeddedUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));
      } catch (error: any) {
        console.warn(`Embedded page could not be crawled: ${embeddedUrl}`, error.message || error);
      } finally {
        await embeddedPage?.close().catch(() => undefined);
      }
    });

    if (!videosOnly) {
    // Extract Fonts from inline styles
    $('style').each((_, el) => {
      const cssText = $(el).html();
      if (cssText) {
        fonts = fonts.concat(extractFontsFromCss(cssText, targetUrl));
      }
    });

    const cssLinks: string[] = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        const absoluteUrl = resolveUrl(targetUrl, href);
        if (absoluteUrl) {
          try {
            assertPublicAssetUrl(absoluteUrl);
            cssLinks.push(absoluteUrl);
          } catch {
            // Ignore private/local stylesheet references.
          }
        }
      }
    });

    // Collect preloaded and direct font files from link/script tags (Google/Typekit/etc)
    $('link[rel="preload"][as="font"], link[as="font"], link[href*=".woff"], link[href*=".woff2"], link[href*=".ttf"], link[href*=".otf"], link[href*=".eot"]').each((_, el) => {
      const href = $(el).attr('href');
      const abs = href ? resolveUrl(targetUrl, href) : null;
      if (abs && !abs.startsWith('data:') && isSupportedFontAsset({ url: abs, format: getAssetTypeFromUrl(abs, 'unknown') })) {
        fonts.push({
          family: '',
          url: abs,
          format: getAssetTypeFromUrl(abs, 'unknown'),
          status: DEFAULT_ASSET_STATUS,
        });
      }
    });

    $('script[src*="typekit.net"], script[src*="fonts.googleapis.com"], script[src*="fonts.gstatic.com"]').each((_, el) => {
      const src = $(el).attr('src');
      const abs = src ? resolveUrl(targetUrl, src) : null;
      if (abs) {
        try {
          assertPublicAssetUrl(abs);
          cssLinks.push(abs);
        } catch {
          // Ignore private/local stylesheet references.
        }
      }
    });

    // Fetch external CSS with small recursion to include @import chains (Google/Typekit/etc).
    extractExternalFontCssUrls(html, targetUrl).forEach((fontCssUrl) => {
      try {
        assertPublicAssetUrl(fontCssUrl);
        cssLinks.push(fontCssUrl);
      } catch {
        // Ignore private/local stylesheet references.
      }
    });
    activeExtractProgress?.setPhase('fonts-colors');
    activeExtractProgress?.setTask('Extracting fonts and colors from stylesheets');
    const cssQueue = prioritizeFontCssCandidates(Array.from(new Set(cssLinks))).slice(0, isFastCrawl ? 12 : 48);
    const visitedCss = new Set<string>();
    const discoveredFonts: any[] = [];
    const discoveredImages: any[] = [];
    let hops = 0;
    const cssMaxHops = isFastCrawl ? 32 : 72;
    const cssMaxMs = isFastCrawl ? 12000 : 24000;
    const cssStartedAt = Date.now();

    while (cssQueue.length > 0 && hops < cssMaxHops && (Date.now() - cssStartedAt) < cssMaxMs) {
      const batch = cssQueue.splice(0, 6).filter((url) => !visitedCss.has(url));
      if (batch.length === 0) break;
      hops += batch.length;
      batch.forEach((url) => visitedCss.add(url));

      const cssResults = await Promise.allSettled(batch.map(async (cssUrl) => {
      try {
        assertPublicAssetUrl(cssUrl);
        const cssTimeout = isFastCrawl ? 2500 : 3500;
        const cssResponse = await axios.get(cssUrl, { 
          timeout: cssTimeout,
          httpsAgent: relaxedHttpsAgent,
          validateStatus: (status) => status === 200,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          }
        });
        if (cssResponse.data) {
          const imported = extractCssImports(cssResponse.data, cssUrl);
          imported.forEach((importUrl) => {
            try {
              assertPublicAssetUrl(importUrl);
              if (!visitedCss.has(importUrl) && !cssQueue.includes(importUrl)) {
                if (/use\.typekit\.net|p\.typekit\.net|fonts\.googleapis\.com/i.test(importUrl)) {
                  cssQueue.unshift(importUrl);
                } else {
                  cssQueue.push(importUrl);
                }
              }
            } catch {
              // Ignore private/local CSS imports.
            }
          });
          return {
            fonts: extractFontsFromCss(cssResponse.data, cssUrl),
            images: extractImagesFromCss(cssResponse.data, cssUrl),
            rawAssets: extractAssetsFromRawText(String(cssResponse.data || ''), cssUrl),
          };
        }
      } catch (e: any) {
        // Only log non-4xx errors to avoid cluttering the console with expected missing/forbidden files
        if (e.response && e.response.status >= 400 && e.response.status < 500) {
          console.warn(`CSS file could not be fetched (${e.response.status}): ${cssUrl}`);
        } else {
          console.error(`Failed to fetch CSS: ${cssUrl}`, e.message || e);
        }
      }
      return { fonts: [], images: [], rawAssets: { images: [], videos: [], fonts: [] } };
      }));

      cssResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          discoveredFonts.push(...result.value.fonts);
          discoveredImages.push(...result.value.images);
          discoveredImages.push(...result.value.rawAssets.images);
          videos.push(...result.value.rawAssets.videos);
          discoveredFonts.push(...result.value.rawAssets.fonts);
        }
      });
    }

    fonts = fonts.concat(discoveredFonts);
    images.push(...discoveredImages);
    }

    const realImageCount = images.filter((img) => !isBotWallImageUrl(String(img?.url || ''))).length;
    if (!videosOnly && realImageCount < 5 && images.some((img) => isBotWallImageUrl(String(img?.url || '')))) {
      console.warn('Bot-wall detected during extract, reloading page:', targetUrl);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const reloadHtml = await page.content().catch(() => '');
      if (reloadHtml && !pageHtmlLooksBlocked(reloadHtml)) {
        await enrichAssetsFromHtml(reloadHtml, targetUrl, {
          images,
          videos,
          fonts,
          colors,
          vimeoCandidateUrls,
          wistiaCandidateIds,
        }, { videosOnly });
      }
    }

    await page.close().catch(() => undefined);
    await closePuppeteerBrowser(browser);
    browser = null;

    if (vimeoCandidateUrls.size > 0) {
      try {
        const vimeoAssets = await withTimeout(
          extractVimeoVideos(Array.from(vimeoCandidateUrls), 'fhd', targetUrl),
          isFastCrawl ? 8000 : VIMEO_EXTRACT_TIMEOUT_MS,
          `Browser Vimeo extraction for ${targetUrl}`
        );
        videos.push(...(vimeoAssets.videos || []));
        images.push(...(vimeoAssets.images || []));
      } catch (error: any) {
        console.warn('Vimeo direct extraction failed:', error?.message || error);
      }
    }

    if (wistiaCandidateIds.size > 0) {
      try {
        const wistiaAssets = await withTimeout(
          extractWistiaVideos(Array.from(wistiaCandidateIds), 'fhd'),
          8000,
          `Browser Wistia extraction for ${targetUrl}`
        );
        videos.push(...(wistiaAssets.videos || []));
        images.push(...(wistiaAssets.images || []));
      } catch (error: any) {
        console.warn('Wistia direct extraction failed, using source placeholders only:', error?.message || error);
        videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
      }
    }

    const resolvedVideos = await resolveBrightcoveCandidateVideos(videos, `Browser Brightcove extraction for ${targetUrl}`);

    if ((isInstagramUrl(targetUrl) || isFacebookUrl(targetUrl) || isXUrl(targetUrl)) && resolvedVideos.length === 0) {
      videos.push({
        url: targetUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(targetUrl),
        type: 'video',
        title: pageTitle,
        thumbnail: resolvedPagePrimaryThumb,
      });
    }

    let mergedVideos = resolvedVideos;
    if (mergedVideos.length === 0 && html) {
      mergedVideos = buildWebsiteVideoPlayersFromHtml(html, targetUrl);
    }

    activeExtractProgress?.setPhase('finalizing');
    activeExtractProgress?.setTask('Deduplicating and finalizing extracted assets');
    activeExtractProgress?.updateCounters({
      images: images.length,
      videos: videos.length,
      fonts: fonts.length,
      colors: colors.length,
    });
    fonts = applyBrowserFontFamilyEvidence(fonts, renderedComputedFonts);
    let extractedAssets = await dedupeExtractedAssets(images, mergedVideos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, {
      fast: true,
      videosOnly,
    });
    extractedAssets = await recoverExtractWhenEmpty(targetUrl, extractedAssets);
    return extractedAssets;
      })(),
      browserBudgetMs,
      `Browser extract for ${targetUrl}`
    );

    // Handle background completion: merge quick results + broadcast via WS
    browserExtractPromise.then(async (bx) => {
      try {
        const quickExtracted = await quickExtractPromise;
        if (quickExtracted) {
          const seenUrls = new Set((bx?.images || []).map((i: any) => i.url).filter(Boolean));
          for (const img of quickExtracted.images || []) {
            if (img.url && !seenUrls.has(img.url)) { bx.images.push(img); seenUrls.add(img.url); }
          }
          const seenVideoUrls = new Set((bx?.videos || []).map((v: any) => v.url).filter(Boolean));
          for (const vid of quickExtracted.videos || []) {
            if (vid.url && !seenVideoUrls.has(vid.url)) { bx.videos.push(vid); seenVideoUrls.add(vid.url); }
          }
          const seenFontUrls = new Set((bx?.fonts || []).map((f: any) => f.url).filter(Boolean));
          for (const fnt of quickExtracted.fonts || []) {
            if (fnt.url && !seenFontUrls.has(fnt.url)) { bx.fonts.push(fnt); seenFontUrls.add(fnt.url); }
          }
          const existingColors = new Set(bx?.colors || []);
          for (const col of quickExtracted.colors || []) {
            if (!existingColors.has(col)) { bx.colors.push(col); existingColors.add(col); }
          }
        }
        progressMgr?.complete(bx);
      } catch (mergeError: any) {
        console.error('Browser extraction merge/broadcast error:', mergeError?.message || mergeError);
        progressMgr?.fail(mergeError?.message || 'Merge failed');
      }
    }).catch(async (error: any) => {
      console.error('Background browser extraction error:', error?.message || error);
      const quickExtracted = await quickExtractPromise.catch(() => null);
      if (images.length || videos.length || fonts.length || colors.length) {
        try {
          const mergeToyotaQuickAssets = isToyotaVehicleExtractionTarget(targetUrl);
          const partialAssets = await dedupeExtractedAssets(
            mergeToyotaQuickAssets ? [...images, ...(quickExtracted?.images || [])] : images,
            mergeToyotaQuickAssets ? [...videos, ...(quickExtracted?.videos || [])] : videos,
            mergeToyotaQuickAssets ? [...fonts, ...(quickExtracted?.fonts || [])] : fonts,
            mergeToyotaQuickAssets ? [...colors, ...(quickExtracted?.colors || [])] : colors,
            targetUrl,
            '',
            {
            fast: true,
            videosOnly,
            },
          );
          const seenUrls = new Set((partialAssets.images || []).map((item: any) => item.url).filter(Boolean));
          for (const image of mergeToyotaQuickAssets ? [] : (quickExtracted?.images || [])) {
            if (image?.url && !seenUrls.has(image.url)) {
              partialAssets.images.push(image);
              seenUrls.add(image.url);
            }
          }
          progressMgr?.complete(partialAssets);
          return;
        } catch (partialError: any) {
          console.error('Partial browser extraction finalization failed:', partialError?.message || partialError);
        }
      }
      if ((quickExtracted?.images?.length || 0) || (quickExtracted?.videos?.length || 0) || (quickExtracted?.fonts?.length || 0)) {
        progressMgr?.complete(quickExtracted);
        return;
      }
      progressMgr?.fail(error?.message || 'Browser extraction failed');
    }).finally(async () => {
      await closePuppeteerBrowser(browser).catch(() => undefined);
      if (activeExtractProgress === progressMgr) {
        activeExtractProgress = null;
        setGlobalProgressManager(null);
      }
      // Keep the completed manager briefly so a client that receives the async
      // extract id just after completion can still replay the terminal result.
      if (extractKey) {
        setTimeout(() => ExtractionProgressManager.remove(extractKey), 60_000).unref?.();
      }
    });

    // Return immediately with async marker — browser extraction continues in background.
    // Results arrive via WebSocket 'complete' event.
    return res.json({ async: true, extractId: extractKey });

  } catch (error: any) {
    // Non-browser errors (setup, etc.). Browser extraction errors are handled in the background promise above.
    progressMgr?.fail(String(error?.message || 'Extraction failed'));
    console.error('Extraction error:', error.message);
    if (/proxy url|proxy protocol/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    try {
      const targetUrl = new URL(String(req.body?.url || '')).href;
      assertPublicAssetUrl(targetUrl);
      const quickAssets = await (quickExtractPromise || extractQuickAssets(targetUrl)).catch(() => ({
        images: [],
        videos: [],
        fonts: [],
        colors: [],
      }));
      if (quickAssets.images.length || quickAssets.videos.length || quickAssets.fonts.length) {
        return res.json(quickAssets);
      }
      const prefetchedHtml = await fetchSiteHtml(targetUrl).catch(() => '');
      const staticAssets = await extractStaticAssets(targetUrl, prefetchedHtml, { fast: true });
      return res.json(staticAssets);
    } catch (fallbackError: any) {
      console.warn('Static extraction fallback failed:', fallbackError?.message || fallbackError);
      try {
        const targetUrl = new URL(String(req.body?.url || '')).href;
        assertPublicAssetUrl(targetUrl);
        const sourceOnlyAssets = extractAssetsFromRawText(targetUrl, targetUrl);
        const extracted = await dedupeExtractedAssets(
          sourceOnlyAssets.images,
          sourceOnlyAssets.videos,
          sourceOnlyAssets.fonts,
          [],
          targetUrl,
          '',
          { fast: true }
        );
        if (extracted.images.length || extracted.videos.length || extracted.fonts.length) {
          return res.json(extracted);
        }
      } catch (sourceFallbackError: any) {
        console.warn('Source-only extraction fallback failed:', sourceFallbackError?.message || sourceFallbackError);
      }
    }
    // Last resort: keep the app responsive even if the origin blocks us.
    return res.json({
      images: [],
      videos: [],
      fonts: [],
      colors: [],
    });
  } finally {
    // At this point browser is null (the background IIFE hasn't reached launchPuppeteerBrowser yet).
    // The background promise's .finally() handles browser cleanup.
    await closePuppeteerBrowser(browser).catch(() => undefined);
  }
});

const registerVideoExtractorRoute = (
  route: string,
  handler: (url: string) => ReturnType<typeof buildDirectVideoExtractResponse>
) => {
  app.post(route, async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
      const targetUrl = new URL(url).href;
      assertPublicAssetUrl(targetUrl);
      const result = await handler(targetUrl);
      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'Video extraction failed.' });
    }
  });
};

registerVideoExtractorRoute('/api/video-extract/universal', universalVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/youtube', youtubeVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/vimeo', vimeoVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/instagram', instagramVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/facebook', facebookVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/x', xVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/ispot', ispotVideoExtractor);
registerVideoExtractorRoute('/api/video-extract/brightcove', buildDirectVideoExtractResponse);

app.post('/api/video-extract/bulk', async (req, res) => {
  const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls = rawUrls.map((value: unknown) => String(value || '').trim()).filter(Boolean);
  if (urls.length === 0) return res.status(400).json({ error: 'At least one URL is required' });
  const results = await Promise.all(
    urls.map(async (entryUrl: string) => {
      try {
        const targetUrl = new URL(entryUrl).href;
        assertPublicAssetUrl(targetUrl);
        const payload = await universalVideoExtractor(targetUrl);
        const videos = Array.isArray(payload?.videos) ? payload.videos : [];
        return { url: entryUrl, ok: true, videos, platform: payload?.extractionMeta?.platform || platformProviderFromUrl(entryUrl) };
      } catch (error: any) {
        return { url: entryUrl, ok: false, error: error?.message || 'Extraction failed', videos: [] as any[] };
      }
    })
  );
  const videos = results.flatMap((entry) => entry.videos || []);
  return res.json({ results, videos, count: videos.length });
});

registerVideoDownloaderRoutes(app, {
  appRoot: getAppRoot(),
  resourcesPath: getResourcesPath(),
  validateUrl: assertPublicAssetUrl,
  specialInspect: async (url) => {
    if (isBrightcoveUrl(url)) {
      return buildDirectVideoExtractResponse(url);
    }
    return ispotVideoExtractor(url);
  },
  specialDownload: async ({ url, quality, title, sourcePageUrl, saveToWebsiteAssets }) => {
    if (isBrightcoveUrl(url)) {
      return downloadBrightcoveVideoToFile(url, quality, {
        title,
        sourcePageUrl,
        saveToWebsiteAssets,
        mode: quality === 'audio' ? 'audio' : 'video',
      });
    }
    const payload = await ispotVideoExtractor(url);
    const card = Array.isArray(payload?.videos) ? payload.videos[0] : null;
    const refreshedUrl = String(card?.sourceStreamUrl || card?.url || url);
    return downloadPlatformVideoToFile(refreshedUrl, quality === 'audio' ? 'fhd' : quality, {
      titleHint: title,
      sourcePageUrl: sourcePageUrl || url,
      saveToWebsiteAssets,
      mode: quality === 'audio' ? 'audio' : 'video',
      maxDurationSeconds: quality === 'audio' ? 120 : undefined,
    });
  },
});

app.get('/api/video-downloads', async (_req, res) => {
  try {
    const items = await listVideoDownloadFiles();
    return res.json({ items, count: items.length });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to list video downloads.' });
  }
});

app.post('/api/platform-video-download', async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();
  const quality = String(req.body?.quality || 'fhd').toLowerCase();
  const titleHint = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const sourcePageUrl = typeof req.body?.sourcePageUrl === 'string' ? req.body.sourcePageUrl.trim() : rawUrl;
  const mode = req.body?.mode === 'audio' ? 'audio' : 'video';
  const saveToWebsiteAssets = req.body?.saveToWebsiteAssets === true;

  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: 'URL is required' });
  }

  try {
    if (isUnsupportedVideoResourceUrl(rawUrl) || (!isPlatformVideoUrl(rawUrl) && !isLikelyDirectVideoStreamUrl(rawUrl) && !isLikelyVideoAssetUrl(rawUrl))) {
      return res.status(400).json({ ok: false, error: 'This URL is a player script/API resource, not a downloadable video.' });
    }
    assertPublicAssetUrl(rawUrl);
    lastExtractedSourceUrl = sourcePageUrl || rawUrl;
    lastExtractionSectionMode = false;
    const result = isBrightcoveUrl(rawUrl)
      ? await downloadBrightcoveVideoToFile(rawUrl, quality, {
          title: titleHint,
          sourcePageUrl,
          mode,
          saveToWebsiteAssets,
        })
      : await downloadPlatformVideoToFile(rawUrl, quality, {
          titleHint,
          sourcePageUrl,
          mode,
          maxDurationSeconds: mode === 'audio' ? 120 : undefined,
          saveToWebsiteAssets,
        });
    return res.json(result);
  } catch (error: any) {
    console.error('Platform video download error:', error?.message || error);
    const message = String(error?.message || 'Video download failed.');
    if (/\bVIDEO_NOT_FOUND\b/i.test(message)) {
      return res.status(404).json({
        ok: false,
        error: 'Brightcove reports that this video does not exist or is no longer available.',
      });
    }
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/direct-video-download', async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();
  const quality = String(req.body?.quality || 'fhd').toLowerCase();
  const titleHint = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const sourcePageUrl = typeof req.body?.sourcePageUrl === 'string' ? req.body.sourcePageUrl.trim() : rawUrl;
  const saveToWebsiteAssets = req.body?.saveToWebsiteAssets === true;

  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: 'URL is required' });
  }

  try {
    const result = await downloadDirectStreamVideoToFile(rawUrl, {
      titleHint,
      sourcePageUrl,
      quality,
      saveToWebsiteAssets,
    });
    return res.json(result);
  } catch (error: any) {
    console.error('Direct video download error:', error?.message || error);
    return res.status(500).json({ ok: false, error: error?.message || 'Direct video download failed.' });
  }
});

app.get('/api/image-meta', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    const inlineBuffer = decodeDataImageBuffer(url);
    if (inlineBuffer) {
      const dims = probeRasterDimensions(inlineBuffer);
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: inlineBuffer.length,
      });
    }
    const normalized = assertAssetUrlAllowed(url);
    const cached =
      (await readAssetBufferFromCache(normalized, 'image')) ||
      (await readAssetBufferFromCache(String(req.query.originalUrl || ''), 'image'));
    if (cached?.buffer) {
      const dims = probeRasterDimensions(cached.buffer);
      const format =
        detectRasterFormatFromBuffer(cached.buffer) ||
        detectImageFormatFromBuffer(cached.buffer) ||
        inferImageTypeFromContentType(cached.contentType) ||
        getAssetTypeFromUrl(normalized, 'jpg');
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: cached.buffer.length,
        format,
      });
    }
    const thumbMeta = await readImageThumbMeta(String(req.query.originalUrl || normalized));
    if (thumbMeta && (thumbMeta.width || thumbMeta.height)) {
      const remoteMeta = await withTimeout(
        fetch(normalized, {
          method: 'HEAD',
          redirect: 'follow',
          headers: browserLikeHeaders(normalized, readSourcePageUrl(req)),
          signal: AbortSignal.timeout(2200),
        }),
        2500,
        `image-meta head for ${normalized}`
      ).catch(() => null);
      const contentType = String(remoteMeta?.headers.get('content-type') || '');
      const bytes = Number(remoteMeta?.headers.get('content-length') || 0) || 0;
      const format =
        inferImageTypeFromContentType(contentType) ||
        inferImageTypeFromUrl(normalized, contentType) ||
        getAssetTypeFromUrl(normalized, 'jpg');
      return res.json({
        width: thumbMeta.width || 0,
        height: thumbMeta.height || 0,
        bytes,
        format,
      });
    }

    const originalUrl = String(req.query.originalUrl || normalized);
    const sourcePageUrl = readSourcePageUrl(req);
    await withTimeout(ensureImageThumbnail(originalUrl, sourcePageUrl), 3500, `image-meta warm for ${normalized}`).catch(
      () => null
    );
    const warmed =
      (await readAssetBufferFromCache(normalized, 'image')) ||
      (originalUrl !== normalized ? await readAssetBufferFromCache(originalUrl, 'image') : null);
    if (warmed?.buffer) {
      const dims = probeRasterDimensions(warmed.buffer);
      const format =
        detectRasterFormatFromBuffer(warmed.buffer) ||
        detectImageFormatFromBuffer(warmed.buffer) ||
        inferImageTypeFromContentType(warmed.contentType) ||
        getAssetTypeFromUrl(originalUrl, 'jpg');
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: warmed.buffer.length,
        format,
      });
    }
    return res.status(202).json({ width: 0, height: 0, bytes: 0, pending: true });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to read image metadata' });
  }
});

app.post('/api/image-meta-batch', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
  const sourcePageUrl = String(req.body?.sourcePageUrl || '').trim();
  const results: Record<string, { width: number; height: number; bytes: number; format: string }> = {};

  await mapWithConcurrency(items, 48, async (item: any) => {
    const originalUrl = String(item?.originalUrl || item?.url || '').trim();
    if (!originalUrl || originalUrl.startsWith('data:')) return;
    try {
      const normalized = assertAssetUrlAllowed(originalUrl);
      const cached = await readAssetBufferFromCache(normalized, 'image');
      if (cached?.buffer) {
        const dims = probeRasterDimensions(cached.buffer);
        results[originalUrl] = {
          width: dims.width || 0,
          height: dims.height || 0,
          bytes: cached.buffer.length,
          format:
            detectRasterFormatFromBuffer(cached.buffer) ||
            detectImageFormatFromBuffer(cached.buffer) ||
            inferImageTypeFromContentType(cached.contentType) ||
            getAssetTypeFromUrl(normalized, 'jpg'),
        };
        return;
      }
      const thumbMeta = await readImageThumbMeta(originalUrl);
      const head = thumbMeta
        ? await withTimeout(
            fetch(normalized, {
              method: 'HEAD',
              redirect: 'follow',
              headers: browserLikeHeaders(normalized, sourcePageUrl),
              signal: AbortSignal.timeout(800),
            }),
            1000,
            `image-meta batch head for ${normalized}`
          ).catch(() => null)
        : null;
      const contentType = String(head?.headers.get('content-type') || '');
      results[originalUrl] = {
        width: thumbMeta?.width || 0,
        height: thumbMeta?.height || 0,
        bytes: Number(head?.headers.get('content-length') || 0) || 0,
        format:
          inferImageTypeFromContentType(contentType) ||
          inferImageTypeFromUrl(normalized, contentType) ||
          getAssetTypeFromUrl(normalized, 'jpg'),
      };
    } catch {
      // Best-effort card metadata only.
    }
  });

  return res.json({ ok: true, results });
});

type ImageThumbMeta = {
  thumbUrl: string;
  lqip: string;
  width: number;
  height: number;
  bytes: number;
};

const imageThumbHashFor = (originalUrl: string) =>
  crypto.createHash('sha1').update(String(originalUrl || '').trim()).digest('hex');

const imageThumbPathsFor = (originalUrl: string) => {
  const hash = imageThumbHashFor(originalUrl);
  return {
    hash,
    thumbPath: path.join(generatedImageThumbDir, `${hash}.webp`),
    metaPath: path.join(generatedImageThumbDir, `${hash}.meta.json`),
    publicThumbUrl: `/generated-image-thumbs/${hash}.webp`,
  };
};

const readImageThumbMeta = async (originalUrl: string): Promise<ImageThumbMeta | null> => {
  const { thumbPath, metaPath, publicThumbUrl } = imageThumbPathsFor(originalUrl);
  const thumbStat = await fsp.stat(thumbPath).catch(() => null);
  if (!thumbStat || thumbStat.size < 64) return null;
  let lqip = '';
  let width = 0;
  let height = 0;
  let bytes = 0;
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    lqip = String(parsed?.lqip || '');
    width = Number(parsed?.width || 0);
    height = Number(parsed?.height || 0);
    bytes = Number(parsed?.bytes || 0);
  } catch {
    // Meta is optional; thumb file is authoritative.
  }
  return {
    thumbUrl: publicThumbUrl,
    lqip,
    width,
    height,
    bytes,
  };
};

const buildImageThumbnail = async (
  originalUrl: string,
  sourcePageUrl = ''
): Promise<ImageThumbMeta> => {
  const normalized = String(originalUrl || '').trim();
  if (!normalized) throw new Error('Missing image URL');
  if (normalized.startsWith('data:')) {
    throw new Error('Data URLs use client-side preview');
  }

  const existing = await readImageThumbMeta(normalized);
  if (existing) return existing;

  await fsp.mkdir(generatedImageThumbDir, { recursive: true });
  const { thumbPath, metaPath, publicThumbUrl } = imageThumbPathsFor(normalized);

  const cached = (await readCachedImageBuffer(normalized)) || null;

  let sourceBuffer = cached?.buffer || null;
  let contentType = cached?.contentType || '';

  if (!sourceBuffer) {
    const fetched = await withTimeout(
      fetchAssetBuffer(normalized, normalized, { refererPageUrl: sourcePageUrl, skipBrowser: true }),
      25000,
      `Thumbnail source fetch for ${normalized}`
    ).catch(() => null);
    if (fetched && isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      sourceBuffer = fetched.buffer;
      contentType = fetched.contentType || '';
      void writeCachedOriginalImageFromBuffer(
        normalized,
        fetched.buffer,
        contentType,
        inferImageTypeFromUrl(normalized, '') || getAssetTypeFromUrl(normalized, 'bin'),
        String((fetched as any).contentDisposition || '')
      ).catch(() => undefined);
    }
  }

  if (!sourceBuffer || !isValidImageBuffer(sourceBuffer, contentType)) {
    return { thumbUrl: '', lqip: '', width: 0, height: 0, bytes: 0 };
  }

  const thumbnailSource = detectImageFormatFromBuffer(sourceBuffer) === 'svg'
    ? materializeSvgFragmentForIllustrator(sourceBuffer, normalized)
    : sourceBuffer;
  const artifacts = await generateImageThumbArtifacts(thumbnailSource);
  await fsp.writeFile(thumbPath, artifacts.thumbBuffer);
  await fsp.writeFile(
    metaPath,
    JSON.stringify({
      lqip: artifacts.lqip,
      width: artifacts.width,
      height: artifacts.height,
      bytes: sourceBuffer.length,
      originalUrl: normalized,
      updatedAt: new Date().toISOString(),
    })
  );
  return {
    thumbUrl: publicThumbUrl,
    lqip: artifacts.lqip,
    width: artifacts.width,
    height: artifacts.height,
    bytes: sourceBuffer.length,
  };
};

const imageThumbnailInFlight = new Map<string, Promise<ImageThumbMeta>>();
const ensureImageThumbnail = async (originalUrl: string, sourcePageUrl = '') => {
  const key = String(originalUrl || '').trim();
  const existing = imageThumbnailInFlight.get(key);
  if (existing) return existing;
  const task = buildImageThumbnail(key, sourcePageUrl).finally(() => {
    imageThumbnailInFlight.delete(key);
  });
  imageThumbnailInFlight.set(key, task);
  return task;
};

app.get('/api/image-thumb', async (req, res) => {
  const originalUrl = String(req.query?.originalUrl || req.query?.url || '').trim();
  const sourcePageUrl = readSourcePageUrl(req);
  const wantsMeta = String(req.query?.meta || '').trim() === '1';

  if (!originalUrl) {
    return res.status(400).json({ error: 'originalUrl is required' });
  }
  if (originalUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'Data URLs are not supported for server thumbnails' });
  }

  try {
    assertAssetUrlAllowed(originalUrl);
    const meta = await ensureImageThumbnail(originalUrl, sourcePageUrl);
    if (!meta.thumbUrl) {
      if (wantsMeta) return res.json({ ok: false, error: 'Thumbnail unavailable' });
      return res.status(204).end();
    }
    if (wantsMeta) {
      return res.json({
        ok: true,
        ...meta,
        thumbUrl: toAbsoluteAppUrl(req, meta.thumbUrl),
      });
    }
    const { thumbPath } = imageThumbPathsFor(originalUrl);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    return res.sendFile(thumbPath);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Thumbnail generation failed' });
  }
});

app.post('/api/warm-image-thumbs-batch', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const sourcePageUrl = String(req.body?.sourcePageUrl || '').trim();
  if (!items.length) {
    return res.json({ ok: true, results: {}, warmed: 0, total: 0 });
  }

  const results: Record<string, { ok: boolean; thumbUrl?: string; lqip?: string; width?: number; height?: number; bytes?: number; format?: string; error?: string }> = {};

  await mapWithConcurrency(items.slice(0, 500), 6, async (item: any) => {
    const originalUrl = String(item?.originalUrl || item?.url || '').trim();
    if (!originalUrl || originalUrl.startsWith('data:')) return;
    try {
      assertAssetUrlAllowed(originalUrl);
      const meta = await ensureImageThumbnail(originalUrl, sourcePageUrl);
      const cached = await readAssetBufferFromCache(originalUrl, 'image');
      const contentType = cached?.contentType || '';
      const bytes = cached?.buffer?.length || meta.bytes || 0;
      const format =
        (cached?.buffer ? detectRasterFormatFromBuffer(cached.buffer) || detectImageFormatFromBuffer(cached.buffer) : '') ||
        inferImageTypeFromContentType(contentType) ||
        inferImageTypeFromUrl(originalUrl, contentType) ||
        getAssetTypeFromUrl(originalUrl, 'jpg');
      results[originalUrl] = {
        ok: true,
        thumbUrl: meta.thumbUrl,
        lqip: meta.lqip,
        width: meta.width,
        height: meta.height,
        bytes,
        format,
      };
    } catch (error: any) {
      results[originalUrl] = { ok: false, error: error?.message || 'Thumbnail warm failed' };
    }
  });

  const warmed = Object.values(results).filter((entry) => entry.ok).length;
  return res.json({ ok: true, results, warmed, total: items.length });
});

// API Endpoint to convert image formats with cache
app.get('/api/image-preview', async (req, res) => {
  const { url, originalUrl } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const sourcePageUrl = readSourcePageUrl(req);
    const normalized = assertAssetUrlAllowed(url);
    const origin = typeof originalUrl === 'string' ? originalUrl.trim() : '';
    const ensured = await ensureImageCachedForDownload(normalized, origin || normalized, sourcePageUrl);
    const fetched =
      ensured.cached ||
      (await withTimeout(
        fetchAssetBuffer(ensured.requestUrl || normalized, origin || normalized, { refererPageUrl: sourcePageUrl }),
        12000,
        `Preview fetch for ${normalized}`
      ));
    if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      return res.status(502).json({ error: 'Preview image could not be loaded' });
    }
    const format =
      detectRasterFormatFromBuffer(fetched.buffer) ||
      detectImageFormatFromBuffer(fetched.buffer) ||
      inferImageTypeFromContentType(fetched.contentType) ||
      getAssetTypeFromUrl(normalized, 'bin');
    const contentType =
      format === 'jpg' || format === 'jpeg' ? 'image/jpeg'
        : format === 'png' ? 'image/png'
          : format === 'svg' ? 'image/svg+xml'
            : format === 'webp' ? 'image/webp'
              : format === 'avif' ? 'image/avif'
                : format === 'gif' ? 'image/gif'
                  : fetched.contentType || 'application/octet-stream';
    const previewBuffer = format === 'svg'
      ? materializeSvgFragmentForIllustrator(fetched.buffer, origin || normalized)
      : fetched.buffer;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (ensured.requestUrl?.startsWith('/cached-')) {
      res.setHeader('X-Cached-Image-Path', ensured.requestUrl);
    }
    return res.send(previewBuffer);
  } catch (error: any) {
    console.error('Image preview error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load image preview' });
  }
});

// Fast original-format download from extraction cache (no conversion).
app.get('/api/download-image', async (req, res) => {
  const { url, originalUrl, filenameBase, metadataFilename, save } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const sourcePageUrl = readSourcePageUrl(req);
    const normalized = assertAssetUrlAllowed(url);
    const origin = typeof originalUrl === 'string' ? originalUrl.trim() : '';
    const convertOptions = {
      filenameBase: typeof filenameBase === 'string' ? filenameBase : undefined,
      originalUrl: origin || undefined,
      metadataFilename: typeof metadataFilename === 'string' ? metadataFilename : undefined,
    };
    const ensured = await ensureImageCachedForDownload(normalized, origin || normalized, sourcePageUrl);
    let cached = ensured.cached;
    const resolvedRequestUrl = ensured.requestUrl || normalized;
    const cachePath =
      cached
        ? (await getAssetCacheDebugPath(resolvedRequestUrl, 'image')) ||
          (await getAssetCacheDebugPath(normalized, 'image')) ||
          (origin ? await getAssetCacheDebugPath(origin, 'image') : '')
        : '';
    console.debug('[image-download:cache]', {
      url: origin || normalized,
      requestUrl: resolvedRequestUrl,
      mimeType: cached?.contentType || '',
      cachePath,
      cache: cached ? 'hit' : 'miss',
    });
    if (
      cached &&
      cachePath &&
      (String(save || '').toLowerCase() === '1' || String(save || '').toLowerCase() === 'true')
    ) {
      const sourceFormat = normalizeRasterFormat(
        detectImageFormatFromBuffer(cached.buffer) ||
          inferImageTypeFromContentType(cached.contentType) ||
          inferImageTypeFromUrl(origin || normalized, cached.contentType) ||
          getAssetTypeFromUrl(origin || normalized, 'bin')
      );
      const filename = buildDownloadFilename(origin || normalized, sourceFormat, convertOptions.filenameBase, {
        metadataFilename: convertOptions.metadataFilename,
        contentDisposition: (cached as any).contentDisposition,
      });
      if (sourceFormat === 'svg' && new URL(origin || normalized).hash) {
        const standalone = materializeSvgFragmentForIllustrator(cached.buffer, origin || normalized);
        const saved = await saveBufferToDownloads(standalone, filename, 'Image download', sourcePageUrl, 'image');
        return res.json(saved);
      }
      const saved = await saveCachedFileToDownloads(cachePath, filename, 'Image download', sourcePageUrl, 'image');
      return res.json(saved);
    }
    const fetched =
      cached ||
      (await fetchAssetBuffer(resolvedRequestUrl, origin || normalized, { refererPageUrl: sourcePageUrl }));
    if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      throw new Error(`Downloaded asset is not a valid image: ${normalized}`);
    }
    const sourceFormat = normalizeRasterFormat(
      detectImageFormatFromBuffer(fetched.buffer) ||
        inferImageTypeFromContentType(fetched.contentType) ||
        inferImageTypeFromUrl(origin || normalized, fetched.contentType) ||
        getAssetTypeFromUrl(origin || normalized, 'bin')
    );
    const filename = buildDownloadFilename(origin || normalized, sourceFormat, convertOptions.filenameBase, {
      metadataFilename: convertOptions.metadataFilename,
      contentDisposition: (fetched as any).contentDisposition,
    });
    const contentType = imageContentTypeForFormat(sourceFormat, fetched.contentType || 'application/octet-stream');
    const downloadBuffer = sourceFormat === 'svg'
      ? materializeSvgFragmentForIllustrator(fetched.buffer, origin || normalized)
      : fetched.buffer;
    if (String(save || '').toLowerCase() === '1' || String(save || '').toLowerCase() === 'true') {
      const saved = await saveBufferToDownloads(downloadBuffer, filename, 'Image download', sourcePageUrl, 'image');
      return res.json(saved);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
    return res.send(downloadBuffer);
  } catch (error: any) {
    console.error('Image download error:', error.message || error);
    const message = String(error?.message || 'Unknown error');
    if (/failed to fetch a valid image|downloaded asset is not a valid image|403|forbidden|cloudflare|blocked/i.test(message)) {
      return res.status(409).json({
        error: 'This image could not be downloaded directly because the source site blocked the fetch.',
        sourceUrl: typeof originalUrl === 'string' ? originalUrl : url,
        blocked: true,
      });
    }
    return res.status(500).json({ error: `Failed to download image: ${message}` });
  }
});

app.post('/api/warm-image-cache', async (req, res) => {
  const originalUrl = String(req.body?.originalUrl || req.body?.url || '').trim();
  const requestUrl = String(req.body?.url || originalUrl).trim();
  const sourcePageUrl = String(req.body?.sourcePageUrl || '').trim();
  if (!requestUrl) {
    return res.status(400).json({ ok: false, error: 'URL is required' });
  }

  try {
    const normalized = assertAssetUrlAllowed(requestUrl);
    const ensured = await ensureImageCachedForDownload(normalized, originalUrl || normalized, sourcePageUrl);
    if (!ensured.cached) {
      return res.status(502).json({ ok: false, error: 'Image could not be cached' });
    }
    const publicPath = String(ensured.requestUrl || '').trim();
    const cachePath =
      (await getAssetCacheDebugPath(publicPath, 'image')) ||
      (await getAssetCacheDebugPath(normalized, 'image')) ||
      (originalUrl ? await getAssetCacheDebugPath(originalUrl, 'image') : '') ||
      '';
    const cachedUrl =
      (await resolveCachedPublicUrl(publicPath, normalized, originalUrl)) ||
      (publicPath.startsWith('/cached-') ? publicPath : '');
    return res.json({
      ok: true,
      cachedUrl,
      cachePath,
      bytes: ensured.cached.buffer.length,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'Image cache warm failed' });
  }
});

app.post('/api/warm-image-cache-batch', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const sourcePageUrl = String(req.body?.sourcePageUrl || '').trim();
  if (!items.length) {
    return res.json({ ok: true, results: {}, warmed: 0, total: 0 });
  }

  const results: Record<string, { ok: boolean; cachedUrl?: string; error?: string }> = {};

  const pending: any[] = [];
  await mapWithConcurrency(items.slice(0, 500), 24, async (item: any) => {
    const originalUrl = String(item?.originalUrl || item?.url || '').trim();
    const requestUrl = String(item?.url || originalUrl).trim();
    if (!requestUrl) return;
    if (originalUrl.startsWith('data:')) {
      results[originalUrl] = { ok: true, cachedUrl: originalUrl };
      return;
    }
    try {
      const normalized = assertAssetUrlAllowed(requestUrl);
      const cached =
        (await readAssetBufferFromCache(normalized, 'image')) ||
        (originalUrl && originalUrl !== normalized ? await readAssetBufferFromCache(originalUrl, 'image') : null);
      if (!cached) {
        pending.push({ originalUrl, requestUrl: normalized });
        results[originalUrl] = { ok: false, error: 'warming' };
        return;
      }
      const cachedUrl = await resolveCachedPublicUrl(normalized, normalized, originalUrl);
      results[originalUrl] = { ok: true, cachedUrl };
    } catch (error: any) {
      results[originalUrl] = { ok: false, error: error?.message || 'Image cache warm failed' };
    }
  });

  if (pending.length > 0) {
    setImmediate(() => {
      void mapWithConcurrency(pending, 8, async (item: any) => {
        await ensureImageCachedForDownload(item.requestUrl, item.originalUrl || item.requestUrl, sourcePageUrl).catch(
          () => undefined
        );
      }).catch(() => undefined);
    });
  }

  const warmed = Object.values(results).filter((entry) => entry.ok).length;
  return res.json({ ok: true, results, warmed, pending: pending.length, total: items.length });
});

app.post('/api/warm-image-conversions', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const warmed: string[] = [];
  await mapWithConcurrency(items.slice(0, 200), 12, async (item: any) => {
    const originalUrl = String(item?.originalUrl || item?.url || '').trim();
    const convertUrl = String(item?.url || item?.cachedUrl || originalUrl).trim();
    if (!originalUrl || !/\.(?:webp|avif)(?:[?#]|$)/i.test(originalUrl)) return;
    try {
      await warmRasterConversionVariants(originalUrl, convertUrl);
      warmed.push(originalUrl);
    } catch {
      // Best-effort pre-conversion only.
    }
  });
  return res.json({ ok: true, warmed: warmed.length });
});

// API Endpoint to convert image formats with cache
app.get('/api/convert-image', async (req, res) => {
  const { url, toFormat, filenameBase, originalUrl, metadataFilename, cacheOnly, save } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const sourcePageUrl = readSourcePageUrl(req);
    const normalized = assertAssetUrlAllowed(url);
    const cacheOnlyFlag = String(cacheOnly || '').toLowerCase();
    const convertOptions = {
      filenameBase: typeof filenameBase === 'string' ? filenameBase : undefined,
      originalUrl: typeof originalUrl === 'string' ? originalUrl : undefined,
      metadataFilename: typeof metadataFilename === 'string' ? metadataFilename : undefined,
      cacheOnly: cacheOnlyFlag === '1' || cacheOnlyFlag === 'true' ? true : undefined,
      refererPageUrl: sourcePageUrl || undefined,
    };
    let converted;
    try {
      converted = await withTimeout(
        getCachedConvertedImage(normalized, typeof toFormat === 'string' ? toFormat : undefined, convertOptions),
        60000,
        `Image conversion for ${normalized}`
      );
    } catch (primaryError) {
      if (convertOptions.cacheOnly) {
        try {
          converted = await withTimeout(
            getCachedConvertedImage(normalized, typeof toFormat === 'string' ? toFormat : undefined, {
              ...convertOptions,
              cacheOnly: undefined,
            }),
            60000,
            `Image conversion fetch for ${normalized}`
          );
        } catch {
          // Fall through to curl fallback below.
        }
      }
      if (!converted) {
        converted = await getCurlFetchedConvertedImage(
          normalized,
          typeof toFormat === 'string' ? toFormat : undefined,
          convertOptions
        );
        if (!converted) {
          const origin = typeof originalUrl === 'string' ? originalUrl.trim() : '';
          if (origin && origin !== normalized) {
            converted = await withTimeout(
              getCachedConvertedImage(origin, typeof toFormat === 'string' ? toFormat : undefined, convertOptions),
              60000,
              `Image conversion fallback for ${origin}`
            );
          } else {
            throw primaryError;
          }
        }
      }
    }
    const responseFormat = normalizeRasterFormat(
      detectRasterFormatFromBuffer(converted.buffer) ||
        detectImageFormatFromBuffer(converted.buffer) ||
        converted.format ||
        'bin'
    );
    const responseFilename = reconcileImageFilenameWithBuffer(converted.filename, converted.buffer);
    const contentType = imageContentTypeForFormat(responseFormat, 'application/octet-stream');
    if (typeof toFormat === 'string' && ['png', 'jpg'].includes(normalizeRasterFormat(toFormat))) {
      const expected = normalizeRasterFormat(toFormat) as RasterOutputFormat;
      if (!isValidRasterOutputBuffer(converted.buffer, expected)) {
        throw new Error(`Response is not valid ${expected.toUpperCase()} binary`);
      }
      if (detectRasterFormatFromBuffer(converted.buffer) === 'webp' || detectRasterFormatFromBuffer(converted.buffer) === 'avif') {
        throw new Error('Refusing to stream WEBP/AVIF when PNG/JPG was requested');
      }
    }
    if (String(save || '').toLowerCase() === '1' || String(save || '').toLowerCase() === 'true') {
      if (converted.cachedPath) {
        try {
          await fsp.access(converted.cachedPath);
          const saved = await saveCachedFileToDownloads(converted.cachedPath, responseFilename, 'Image conversion', sourcePageUrl, 'image');
          return res.json(saved);
        } catch {
          // Converted buffer may be in memory only; save bytes directly.
        }
      }
      const saved = await saveBufferToDownloads(converted.buffer, responseFilename, 'Image conversion', sourcePageUrl, 'image');
      return res.json(saved);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${responseFilename}"`);
    res.setHeader('Content-Type', contentType);
    return res.send(converted.buffer);
  } catch (error: any) {
    console.error('Image conversion error:', error.message || error);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: `Failed to convert image: ${error?.message || 'Unknown error'}` });
  }
});

const parseDownloadSaveKind = (value: unknown): DownloadSaveKind => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'font' || raw === 'image' || raw === 'icon' || raw === 'color' || raw === 'video' || raw === 'audio' || raw === 'brief' || raw === 'isi' || raw === 'zip') {
    return raw;
  }
  return 'default';
};

const inferDownloadSaveKindFromFilename = (filename: string): DownloadSaveKind => {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (/^\.(?:woff2?|ttf|otf|eot|svg)$/.test(ext)) return 'font';
  if (/^\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|heif)$/.test(ext)) return 'image';
  return 'default';
};

app.post('/api/save-asset-buffer', async (req, res) => {
  const { base64, filename, sourcePageUrl: bodySourcePageUrl, kind: bodyKind } = req.body || {};
  if (!base64 || typeof base64 !== 'string') {
    return res.status(400).json({ error: 'base64 is required' });
  }
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }

  try {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 50 * 1024 * 1024) {
      return res.status(413).json({ error: 'File is too large to save through this path.' });
    }
    const explicitKind = parseDownloadSaveKind(bodyKind);
    const saveKind = explicitKind !== 'default' ? explicitKind : inferDownloadSaveKindFromFilename(filename);
    const saved = await saveBufferToDownloads(buffer, filename, 'Asset buffer save', readSourcePageUrl(req, bodySourcePageUrl), saveKind);
    return res.json(saved);
  } catch (error: any) {
    console.error('Save asset buffer error:', error?.message || error);
    return res.status(500).json({ error: `Failed to save file: ${error?.message || 'Unknown error'}` });
  }
});

// API Endpoint to convert font formats
app.get('/api/convert-font', async (req, res) => {
  const { url, toFormat, originalFormat, filenameBase, familyFolder, originalUrl, metadataFilename, save, cssSource, fontFamily, fontWeight, fontStyle, fixVerticalMetrics } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const targetFormat = typeof toFormat === 'string' && toFormat.trim()
    ? toFormat.trim().toLowerCase()
    : 'ttf';
  const sourceFormat = typeof originalFormat === 'string' ? originalFormat : 'unknown';
  const preferredBase = typeof filenameBase === 'string' ? filenameBase : undefined;
  const fontFamilyFolder = typeof familyFolder === 'string' ? familyFolder : '';
  const extras = {
    originalUrl: typeof originalUrl === 'string' ? originalUrl : undefined,
    metadataFilename: typeof metadataFilename === 'string' ? metadataFilename : undefined,
    refererPageUrl: readSourcePageUrl(req) || undefined,
    cssSource: typeof cssSource === 'string' ? cssSource : undefined,
    fontFamily: typeof fontFamily === 'string' ? fontFamily : fontFamilyFolder || undefined,
    fontWeight: typeof fontWeight === 'string' ? fontWeight : undefined,
    fontStyle: typeof fontStyle === 'string' ? fontStyle : undefined,
    preferInlineConversion: true,
    timeoutMs: 65000,
    fixVerticalMetrics: !['0', 'false', 'off'].includes(String(fixVerticalMetrics || '').toLowerCase()),
  };
  const wantsSave = String(save || '').toLowerCase() === '1' || String(save || '').toLowerCase() === 'true';

  try {
    const normalized = assertAssetUrlAllowed(url);
    const converted = await convertFontAsset(normalized, targetFormat, sourceFormat, preferredBase, extras);

    if (wantsSave) {
      const saved = await saveBufferToDownloads(
        converted.buffer,
        converted.filename,
        'Font conversion',
        readSourcePageUrl(req),
        'font',
        fontFamilyFolder
      );
      return res.json({ ...saved, format: converted.format, conversionProvider: converted.conversionProvider || 'local' });
    }

    let contentType = 'application/octet-stream';
    if (converted.format === 'woff2') contentType = 'font/woff2';
    else if (converted.format === 'woff') contentType = 'font/woff';
    else if (converted.format === 'ttf') contentType = 'font/ttf';
    else if (converted.format === 'otf') contentType = 'font/otf';
    else if (converted.format === 'eot') contentType = 'application/vnd.ms-fontobject';
    else if (converted.format === 'svg') contentType = 'image/svg+xml';

    res.setHeader('Content-Disposition', `attachment; filename="${converted.filename}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Font-Conversion-Provider', converted.conversionProvider || 'local');
    return res.send(converted.buffer);
  } catch (error: any) {
    console.error('Font conversion error:', error.message || error);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    if (/woff2|decode/i.test(String(error?.message || '')) && wantsSave) {
      try {
        const normalized = assertAssetUrlAllowed(url);
        const original = await fetchOriginalFontBufferForFallback(
          normalized,
          sourceFormat,
          preferredBase,
          extras
        );
        const saved = await saveBufferToDownloads(
          original.buffer,
          original.filename,
          'Font original fallback',
          readSourcePageUrl(req),
          'font',
          fontFamilyFolder
        );
        return res.json({
          ...saved,
          format: original.format,
          warning: 'WOFF2 converter unavailable. Downloading original font only.',
        });
      } catch {
        // Fall through to generic fallback below.
      }
    }
    if (wantsSave) {
      try {
        const normalized = assertAssetUrlAllowed(url);
        const original = await fetchOriginalFontBufferForFallback(
          normalized,
          sourceFormat,
          preferredBase,
          extras
        );
        const saved = await saveBufferToDownloads(
          original.buffer,
          original.filename,
          'Font original fallback',
          readSourcePageUrl(req),
          'font',
          fontFamilyFolder
        );
        return res.json({
          ...saved,
          format: original.format,
          warning: 'Font conversion failed. Original file saved.',
        });
      } catch {
        // Fall through.
      }
    }
    return res.status(500).json({
      error: wantsSave
        ? 'Font conversion failed. Try downloading the original format or use ZIP download.'
        : `Font conversion failed: ${error?.message || 'Unknown error'}`,
    });
  }
});

// API Endpoint to convert font formats from provided bytes (browser-fetched fallback).
app.post('/api/convert-font-buffer', async (req, res) => {
  const { base64, toFormat, originalFormat, filenameBase, familyFolder, save, sourcePageUrl: bodySourcePageUrl, fixVerticalMetrics } = req.body || {};
  if (!base64 || typeof base64 !== 'string') {
    return res.status(400).json({ error: 'base64 is required' });
  }

  const targetFormat = typeof toFormat === 'string' && toFormat.trim()
    ? toFormat.trim().toLowerCase()
    : 'ttf';

  try {
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      return res.status(400).json({ error: 'Font buffer was empty' });
    }
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(413).json({ error: 'Font buffer too large' });
    }

    const normalizedTarget = ['ttf', 'woff', 'woff2', 'eot', 'otf', 'svg'].includes(targetFormat) ? targetFormat : 'ttf';
    let output: Buffer;
    let conversionProvider = 'local';
    try {
      const normalizedOriginal = normalizeFontFormat(typeof originalFormat === 'string' ? originalFormat : 'unknown');
      if (normalizedTarget === 'ttf' && normalizedOriginal !== 'ttf') {
        output = await convertFontBufferToInstallableTtf(
          buffer,
          typeof filenameBase === 'string' ? filenameBase : 'font',
          normalizedOriginal,
          fixVerticalMetrics !== false,
        );
        conversionProvider = 'transfonter';
      } else if (normalizedTarget === 'woff' && normalizedOriginal !== 'woff') {
        output = await convertFontBufferWithTransfonter(
          buffer,
          typeof filenameBase === 'string' ? filenameBase : 'font',
          normalizedOriginal,
          fixVerticalMetrics !== false,
          'woff',
        );
        conversionProvider = 'transfonter';
      } else {
      output = await convertFontBuffer(
        typeof filenameBase === 'string' ? filenameBase : 'font',
        buffer,
        typeof originalFormat === 'string' ? originalFormat : 'unknown',
        normalizedTarget,
        ''
      );
      }
      if (
        normalizedTarget === 'ttf' &&
        !isInstallableTtfBuffer(output) &&
        normalizeFontFormat(typeof originalFormat === 'string' ? originalFormat : 'unknown') !== 'ttf'
      ) {
        output = await convertFontBufferToInstallableTtf(
          buffer,
          typeof filenameBase === 'string' ? filenameBase : 'font',
          normalizeFontFormat(typeof originalFormat === 'string' ? originalFormat : 'unknown'),
          fixVerticalMetrics !== false,
        );
        conversionProvider = 'transfonter';
      }
    } catch (localError) {
      if (!['ttf', 'woff'].includes(normalizedTarget)) throw localError;
      const normalizedOriginal = normalizeFontFormat(typeof originalFormat === 'string' ? originalFormat : 'unknown');
      output = normalizedTarget === 'ttf'
        ? await convertFontBufferToInstallableTtf(
            buffer,
            typeof filenameBase === 'string' ? filenameBase : 'font',
            normalizedOriginal,
            fixVerticalMetrics !== false,
          )
        : await convertFontBufferWithTransfonter(
            buffer,
            typeof filenameBase === 'string' ? filenameBase : 'font',
            normalizedOriginal,
            fixVerticalMetrics !== false,
            'woff',
          );
      conversionProvider = 'transfonter';
    }
    if (!isValidFontBuffer(output, normalizedTarget)) {
      throw new Error(`Converted font is not a valid installable ${normalizedTarget.toUpperCase()} file`);
    }

    const preferredBase = typeof filenameBase === 'string' ? filenameBase : undefined;
    const filename = deriveAssetFilename({
      metadataFilename: typeof req.body?.metadataFilename === 'string' ? req.body.metadataFilename : undefined,
      preferredBase,
      format: normalizedTarget,
      fallbackBase: 'font',
    });

    let contentType = 'application/octet-stream';
    if (normalizedTarget === 'woff2') contentType = 'font/woff2';
    else if (normalizedTarget === 'woff') contentType = 'font/woff';
    else if (normalizedTarget === 'ttf') contentType = 'font/ttf';
    else if (normalizedTarget === 'otf') contentType = 'font/otf';
    else if (normalizedTarget === 'eot') contentType = 'application/vnd.ms-fontobject';
    else if (normalizedTarget === 'svg') contentType = 'image/svg+xml';

    if (save === true || String(save || '').toLowerCase() === 'true') {
      const saved = await saveBufferToDownloads(
        output,
        filename,
        'Font buffer conversion',
        readSourcePageUrl(req, bodySourcePageUrl),
        'font',
        typeof familyFolder === 'string' ? familyFolder : ''
      );
      return res.json({ ...saved, format: normalizedTarget, conversionProvider });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Font-Conversion-Provider', conversionProvider);
    return res.send(output);
  } catch (error: any) {
    console.error('Font buffer conversion error:', error.message || error);
    return res.status(500).json({ error: `Failed to convert font: ${error?.message || 'Unknown error'}` });
  }
});

app.get('/api/probe-stream-audio', async (req, res) => {
  const { url, sourcePageUrl } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    const normalizedUrl = sanitizeStreamUrl(url, typeof sourcePageUrl === 'string' ? sourcePageUrl : undefined);
    if (!normalizedUrl) return res.status(400).json({ error: 'Invalid media URL' });
    assertPublicAssetUrl(normalizedUrl);
    const metadata = await probeRemoteVideoMetadata(
      normalizedUrl,
      typeof sourcePageUrl === 'string' ? sourcePageUrl : undefined
    );
    return res.json({
      url: normalizedUrl,
      ...describeMediaProbe(metadata),
    });
  } catch (error: any) {
    console.error('Stream audio probe error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Failed to probe stream audio.' });
  }
});

app.get('/api/verify-youtube-merge', async (req, res) => {
  const { url, quality } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'YouTube watch URL is required' });
  }

  const watchUrl = recoverYouTubeWatchFromMergeQuery(url, typeof req.query.v === 'string' ? req.query.v : '');
  if (!isYouTubeUrl(watchUrl) || !getYouTubeVideoId(watchUrl)) {
    return res.status(400).json({ error: 'Only YouTube watch URLs are supported.' });
  }

  const requestedQuality = typeof quality === 'string' && ['hd', 'fhd', '4k'].includes(quality) ? quality : 'fhd';

  try {
    assertPublicAssetUrl(watchUrl);
    const sourcePageUrl = typeof req.query.sourcePageUrl === 'string' ? req.query.sourcePageUrl : watchUrl;
    const titleHint =
      typeof req.query.title === 'string' && req.query.title.trim()
        ? req.query.title.trim()
        : pageTitleFromUrl(watchUrl);
    const exportToDownloads = req.query.export === '1' || req.query.direct === '1';
    const forceLocalMerge = req.query.direct === '1';
    const prepared = await prepareYouTubeQualityOutput(watchUrl, requestedQuality, {
      titleHint,
      sourcePageUrl,
      exportToDownloads,
      forceLocalMerge,
    });
    return res.json(prepared);
  } catch (error: any) {
    console.error('YouTube merge verify error:', error?.message || error);
    try {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
      const cachedPath = getYouTubeMergeCachePath(normalizedWatchUrl, requestedQuality);
      await validateOutputFile(cachedPath, 'YouTube merge cache');
      const probe = await verifyMergedYouTubeFile(cachedPath);
      const stat = await fsp.stat(cachedPath);
      const title = pageTitleFromUrl(normalizedWatchUrl);
      const internalPreviewUrl = toYouTubeMergedDownloadUrl(normalizedWatchUrl, requestedQuality, title);
      const targetHeight = getVimeoTargetHeight(requestedQuality);
      logYouTubeMerge('verify-salvage', { cachedPath, originalError: error?.message || String(error) });
      return res.json({
        ok: true,
        watchUrl: normalizedWatchUrl,
        quality: requestedQuality,
        mergeMode: 'merged',
        isDirectProgressive: false,
        directStreamUrl: '',
        copyUrl: toDisplayFilePath(cachedPath),
        localPath: cachedPath,
        downloadPath: cachedPath,
        internalPreviewUrl,
        previewStreamPath: internalPreviewUrl,
        title,
        resolution: `${targetHeight}p`,
        height: targetHeight,
        size: stat.size,
        audioAvailable: true,
        hasAudio: true,
        noAudio: false,
        verifiedPlayable: true,
        audioVerified: probe.audioVerified !== false,
        warning: probe.warning || error?.message || '',
        ...probe,
      });
    } catch {
      return res.status(500).json({ error: error?.message || 'Merged YouTube file failed audio verification.' });
    }
  }
});

app.get('/api/youtube-merged-stream', async (req, res) => {
  const { url, quality, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const watchUrl = recoverYouTubeWatchFromMergeQuery(url, typeof req.query.v === 'string' ? req.query.v : '');
  if (!isYouTubeUrl(watchUrl) || !getYouTubeVideoId(watchUrl)) {
    return res.status(400).json({ error: 'Only YouTube watch URLs are supported for merged streaming.' });
  }

  const requestedQuality = typeof quality === 'string' && ['hd', 'fhd', '4k'].includes(quality) ? quality : 'fhd';
  const inlinePlayback = req.query.inline !== '0' && (req.query.inline === '1' || req.query.inline === 'true' || req.query.inline === undefined);
  const preferredFilename = typeof filename === 'string' ? filename : toQualityVideoFilename(requestedQuality);

  try {
    assertPublicAssetUrl(watchUrl);
    await pipeYouTubeMergedStream(req, res, watchUrl, requestedQuality, {
      inline: inlinePlayback,
      filename: preferredFilename,
    });
  } catch (error: any) {
    console.error('YouTube merged stream error:', error?.message || error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error?.message || 'Failed to merge YouTube audio into stream.' });
    }
  }
});

app.head('/api/youtube-merged-stream', async (req, res) => {
  const { url, quality, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).end();
  }

  const watchUrl = recoverYouTubeWatchFromMergeQuery(url, typeof req.query.v === 'string' ? req.query.v : '');
  if (!isYouTubeUrl(watchUrl) || !getYouTubeVideoId(watchUrl)) {
    return res.status(400).end();
  }

  const requestedQuality = typeof quality === 'string' && ['hd', 'fhd', '4k'].includes(quality) ? quality : 'fhd';
  const inlinePlayback = req.query.inline !== '0' && (req.query.inline === '1' || req.query.inline === 'true' || req.query.inline === undefined);
  const preferredFilename = typeof filename === 'string' ? filename : toQualityVideoFilename(requestedQuality);

  try {
    assertPublicAssetUrl(watchUrl);
    await pipeYouTubeMergedStream(req, res, watchUrl, requestedQuality, {
      inline: inlinePlayback,
      filename: preferredFilename,
    });
  } catch (error: any) {
    console.error('YouTube merged stream HEAD error:', error?.message || error);
    if (!res.headersSent) res.status(500).end();
  }
});

// API Endpoint to proxy download (avoids CORS)
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    let normalizedSourceUrl = sanitizeStreamUrl(url);
    if (!normalizedSourceUrl) {
      return res.status(400).json({ error: 'Invalid download URL' });
    }
    for (let unwrapPass = 0; unwrapPass < 3; unwrapPass += 1) {
      const unwrapped = unwrapDownloadProxyUrl(normalizedSourceUrl);
      if (unwrapped === normalizedSourceUrl) break;
      normalizedSourceUrl = sanitizeStreamUrl(unwrapped) || unwrapped;
    }
    if (isYouTubeUrl(normalizedSourceUrl)) {
      normalizedSourceUrl = normalizeYouTubeWatchUrl(normalizedSourceUrl);
    }
    assertPublicAssetUrl(normalizedSourceUrl);

    // When the user passes a YouTube watch URL, prefer a merged MP4 download (video + audio)
    // to avoid "video-only" googlevideo streams.
    if (isYouTubeUrl(normalizedSourceUrl) && !isLikelyDirectVideoStreamUrl(normalizedSourceUrl) && !isLikelyVideoAssetUrl(normalizedSourceUrl)) {
      const tempBase = `creative-ytdlp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const outputPath = path.join(os.tmpdir(), `${tempBase}.mp4`);
      const requestedQuality = typeof req.query.quality === 'string' && ['hd', 'fhd', '4k'].includes(req.query.quality)
        ? req.query.quality
        : 'fhd';
      const inlinePlayback = req.query.inline === '1' || req.query.inline === 'true';
      try {
        await withTimeout(
          mergeYouTubeWatchUrlToFile(normalizedSourceUrl, requestedQuality, outputPath),
          4 * 60 * 1000,
          `YouTube merged download for ${normalizedSourceUrl}`
        );

        const stat = await fsp.stat(outputPath);
        const requestedName = typeof filename === 'string' ? filename.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') : '';
        const preferredName = requestedName || `${pageTitleFromUrl(normalizedSourceUrl)}.mp4`.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120);
        res.setHeader('Content-Disposition', `${inlinePlayback ? 'inline' : 'attachment'}; filename="${preferredName || 'youtube-video.mp4'}"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(stat.size));
        const stream = fs.createReadStream(outputPath);
        stream.on('close', async () => {
          await fsp.unlink(outputPath).catch(() => undefined);
        });
        stream.pipe(res);
        return;
      } catch (ytdlpError: any) {
        await fsp.unlink(outputPath).catch(() => undefined);
        console.warn('YouTube merged download failed:', ytdlpError?.message || ytdlpError);
        return res.status(500).json({ error: 'Could not merge YouTube video and audio. Please retry with the YouTube watch URL.' });
      }
    }

    const mediaValidation = isLikelyHttpMediaUrl(normalizedSourceUrl) || isLikelyDirectVideoStreamUrl(normalizedSourceUrl) || isLikelyVideoAssetUrl(normalizedSourceUrl)
      ? await validateStreamUrl(normalizedSourceUrl)
      : null;
    if (mediaValidation && (!mediaValidation.ok || !mediaValidation.url)) {
      return res.status(410).json({ error: mediaValidation.reason || 'Stream URL is no longer valid.' });
    }
    const downloadUrl = mediaValidation?.url || normalizedSourceUrl;
    if (isGoogleVideoPlaybackUrl(downloadUrl)) {
      return res.status(400).json({ error: 'This YouTube link is video-only. Paste the YouTube watch URL to download with audio merged.' });
    }
    const sourceOrigin = (() => {
      try {
        return new URL(downloadUrl).origin;
      } catch {
        return '';
      }
    })();
    const parsedDownloadUrl = (() => {
      try {
        return new URL(downloadUrl);
      } catch {
        return null;
      }
    })();
    const host = parsedDownloadUrl?.hostname.replace(/^www\./, '').toLowerCase() || '';
    const isGoogleVideo = host.includes('googlevideo.com');
    const referer = isGoogleVideo ? 'https://www.youtube.com/' : (sourceOrigin ? `${sourceOrigin}/` : undefined);
    const origin = isGoogleVideo ? 'https://www.youtube.com' : (sourceOrigin || undefined);

    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 60000,
      httpsAgent: relaxedHttpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        ...(referer ? { 'Referer': referer } : {}),
        ...(origin ? { 'Origin': origin } : {}),
      },
    });

    const sourceName = downloadUrl.split('/').pop()?.split('?')[0] || 'download';
    const base = sourceName.replace(/\.[a-z0-9]+$/i, '') || 'download';
    const requestedName = typeof filename === 'string' ? filename.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') : '';
    const preferredName = requestedName || `${base}.mp4`;
    const contentType = String(response.headers['content-type'] || 'video/mp4');
    const forceTranscode = needsMp4Transcode(downloadUrl, contentType);

    res.setHeader('Content-Disposition', `attachment; filename="${preferredName}"`);
    res.setHeader('Content-Type', 'video/mp4');

    if (!forceTranscode) {
      response.data.pipe(res);
      return;
    }

    // Non-mp4 source: transcode the exact source URL to MP4.
    response.data.destroy();
    const tempBase = `creative-extractor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempOutput = path.join(os.tmpdir(), `${tempBase}.mp4`);
    try {
      await transcodeUrlToMp4File(downloadUrl, tempOutput, referer, origin);
      const stat = await fsp.stat(tempOutput);
      res.setHeader('Content-Length', String(stat.size));
      const stream = fs.createReadStream(tempOutput);
      stream.on('close', async () => {
        await fsp.unlink(tempOutput).catch(() => undefined);
      });
      stream.pipe(res);
    } catch (transcodeError: any) {
      await fsp.unlink(tempOutput).catch(() => undefined);
      throw new Error(`Failed to convert source to mp4: ${transcodeError?.message || transcodeError}`);
    }
  } catch (error: any) {
    console.error('Download error:', error.message || error);
    const blockedPrivateUrl = /private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ''));
    res.status(blockedPrivateUrl ? 403 : (error.response?.status || 500)).json({ error: blockedPrivateUrl ? error.message : 'Failed to download file' });
  }
});

app.get('/api/convert-mp4', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const sourceUrl = sanitizeStreamUrl(unwrapDownloadProxyUrl(url));
  if (!sourceUrl) {
    return res.status(400).json({ error: 'Invalid video URL' });
  }
  try {
    assertPublicAssetUrl(sourceUrl);
  } catch (securityError: any) {
    return res.status(403).json({ error: securityError?.message || 'Private or local video URLs are blocked.' });
  }
  let parsedSource: URL;
  try {
    parsedSource = new URL(sourceUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid video URL' });
  }

  const safeFilename =
    (typeof filename === 'string' && filename.trim()
      ? filename
      : `${toSafeFileBase(parsedSource.pathname.split('/').pop() || 'video')}.mp4`
    )
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/\.[a-z0-9]+$/i, '.mp4');

  try {
    const validation = await validateStreamUrl(sourceUrl);
    if (!validation.ok || !validation.url) {
      return res.status(410).json({ error: validation.reason || 'Stream URL is no longer valid.' });
    }
    const validatedSourceUrl = validation.url;
    parsedSource = new URL(validatedSourceUrl);
    const { referer, origin } = getStreamRequestContext(parsedSource);
    await fsp.mkdir(convertedVideoDir, { recursive: true });
    const sourcePageUrl = readSourcePageUrl(req);
    const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
    await fsp.mkdir(targetDir, { recursive: true });

    const tempBase = `converted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempOutput = path.join(convertedVideoDir, `${tempBase}.mp4`);

    const isAlreadyMp4 = /\.mp4(\?|$)/i.test(validatedSourceUrl);
    if (isAlreadyMp4) {
      const downloadResponse = await axios({
        method: 'GET',
        url: validatedSourceUrl,
        responseType: 'stream',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': referer,
          'Origin': origin,
        },
      });
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tempOutput);
        downloadResponse.data.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        downloadResponse.data.on('error', reject);
      });
    } else {
      await transcodeUrlToMp4File(validatedSourceUrl, tempOutput, referer, origin);
    }

    const finalPath = path.join(targetDir, safeFilename);
    await fsp.rename(tempOutput, finalPath).catch(async () => {
      await fsp.copyFile(tempOutput, finalPath);
      await fsp.unlink(tempOutput).catch(() => undefined);
    });
    const stat = await validateOutputFile(finalPath, 'MP4 conversion');

    return res.json({
      ok: true,
      url: toLocalVideoDownloadUrl(req, safeFilename, sourcePageUrl),
      localPath: finalPath,
      downloadPath: finalPath,
      folderPath: targetDir,
      filename: safeFilename,
      size: stat.size,
    });
  } catch (error: any) {
    console.error('Convert MP4 error:', error.message || error);
    return res.status(500).json({ error: `Failed to convert to MP4: ${error?.message || 'Unknown error'}` });
  }
});

app.get('/api/convert-audio', async (req, res) => {
  const { url, filename, bitrate, mode } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const sourceUrl = sanitizeStreamUrl(unwrapDownloadProxyUrl(url));
  if (!sourceUrl) {
    return res.status(400).json({ error: 'Invalid media URL' });
  }
  try {
    assertPublicAssetUrl(sourceUrl);
  } catch (securityError: any) {
    return res.status(403).json({ error: securityError?.message || 'Private or local media URLs are blocked.' });
  }
  let parsedSource: URL;
  try {
    parsedSource = new URL(sourceUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid media URL' });
  }

  const audioMode: AudioMode = mode === 'original' ? 'original' : mode === 'hq' || bitrate === '320k' ? 'hq' : 'turbo';
  const requestedBitrate = typeof bitrate === 'string' && /^\d{2,3}k$/.test(bitrate)
    ? bitrate
    : audioMode === 'hq' ? '320k' : '128k';
  const requestedBase =
    (typeof filename === 'string' && filename.trim()
      ? filename
      : toStandardAudioFilename(String(mode || ''))
    )
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'Audio';
  const turboDurationSeconds = audioMode === 'turbo' ? 30 : undefined;

  try {
    await fsp.mkdir(convertedAudioDir, { recursive: true });

    let audioSourceUrl = sourceUrl;
    let sourcePageUrl = sourceUrl;
    let resolvedAudioStream: any = null;

    if (isPlatformVideoUrl(sourceUrl) && !isLikelyDirectVideoStreamUrl(sourceUrl)) {
      try {
        const audioStream = await resolveBestAudioStream(sourceUrl, audioMode);
        if (audioStream?.url) {
          resolvedAudioStream = audioStream;
          audioSourceUrl = sanitizeStreamUrl(audioStream.url, sourceUrl) || audioStream.url;
          sourcePageUrl = sourceUrl;
        } else {
          return res.status(422).json({ error: 'Audio track unavailable for this video.' });
        }
      } catch (resolveError: any) {
        if (isXUrl(sourceUrl)) {
          return res.status(422).json({ error: 'This X.com video does not contain a separate audio stream.' });
        }
        console.warn('Audio stream resolver failed, falling back to direct FFmpeg input:', resolveError.message || resolveError);
      }
    }

    const validation = await validateStreamUrl(audioSourceUrl, sourcePageUrl);
    if (!validation.ok || !validation.url) {
      return res.status(410).json({ error: validation.reason || 'Audio stream URL is no longer valid.' });
    }
    audioSourceUrl = validation.url;
    const parsedAudioSource = new URL(audioSourceUrl);
    const { referer, origin } = getStreamRequestContext(parsedAudioSource, sourcePageUrl);
    const tempBase = `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let outputFormat: 'mp3' | 'm4a' | 'webm' | 'mka' = audioMode === 'original'
      ? resolvedAudioStream?.originalOutput?.extension || getOriginalAudioOutput(resolvedAudioStream || { ext: path.extname(parsedAudioSource.pathname).replace(/^\./, '') }).extension
      : audioMode === 'turbo' ? 'm4a' : 'mp3';
    const originalContainer = audioMode === 'original'
      ? resolvedAudioStream?.originalOutput?.container || getOriginalAudioOutput(resolvedAudioStream || { ext: outputFormat }).container
      : undefined;
    let tempOutput = path.join(convertedAudioDir, `${tempBase}.${outputFormat}`);
    const tempInput = path.join(convertedAudioDir, `${tempBase}-source${path.extname(parsedAudioSource.pathname) || '.bin'}`);

    const isManifestSource =
      /\.m3u8|\.mpd/i.test(parsedAudioSource.pathname) ||
      /mpegurl|dash\+xml/i.test(String(validation.contentType || ''));
    try {
      if (audioMode === 'original') {
        if (resolvedAudioStream?.isAudioOnly) {
          await downloadUrlToFile(audioSourceUrl, tempOutput, sourcePageUrl);
          await assertLocalFileHasAudio(tempOutput);
        } else {
          await copyUrlAudioToFile(audioSourceUrl, tempOutput, referer, origin, originalContainer);
        }
      } else if (audioMode === 'turbo') {
        try {
          await copyUrlAudioSegmentToM4aFile(audioSourceUrl, tempOutput, referer, origin, turboDurationSeconds || 30);
        } catch (copyError: any) {
          console.warn('Quick audio copy failed, falling back to 128kbps MP3:', copyError?.message || copyError);
          await fsp.unlink(tempOutput).catch(() => undefined);
          outputFormat = 'mp3';
          tempOutput = path.join(convertedAudioDir, `${tempBase}.mp3`);
          try {
            await transcodeUrlToMp3File(audioSourceUrl, tempOutput, referer, origin, requestedBitrate, {
              durationSeconds: turboDurationSeconds,
              timeoutMs: 90 * 1000,
              stallMs: 25 * 1000,
            });
          } catch (urlTranscodeError: any) {
            console.warn('Quick URL audio transcode failed, using chunked local fallback:', urlTranscodeError?.message || urlTranscodeError);
            await fsp.unlink(tempOutput).catch(() => undefined);
            await downloadUrlToFile(audioSourceUrl, tempInput, sourcePageUrl);
            await assertLocalFileHasAudio(tempInput);
            await transcodeLocalFileToMp3File(tempInput, tempOutput, requestedBitrate, {
              durationSeconds: turboDurationSeconds,
              timeoutMs: 90 * 1000,
              stallMs: 25 * 1000,
            });
          }
        }
      } else if (isManifestSource) {
        await transcodeUrlToMp3File(audioSourceUrl, tempOutput, referer, origin, requestedBitrate);
      } else {
        await downloadUrlToFile(audioSourceUrl, tempInput, sourcePageUrl);
        await assertLocalFileHasAudio(tempInput);
        await transcodeLocalFileToMp3File(tempInput, tempOutput, requestedBitrate);
      }
    } finally {
      await fsp.unlink(tempInput).catch(() => undefined);
    }

    const safeFilename = `${requestedBase}.${outputFormat}`;
    const finalPath = path.join(convertedAudioDir, safeFilename);
    await fsp.rename(tempOutput, finalPath).catch(async () => {
      await fsp.copyFile(tempOutput, finalPath);
      await fsp.unlink(tempOutput).catch(() => undefined);
    });

    const stat = await validateOutputFile(finalPath, 'Audio extraction');
    return res.json({
      ok: true,
      url: toAbsoluteAppUrl(req, `/converted-audio/${encodeURIComponent(safeFilename)}`),
      filename: safeFilename,
      format: outputFormat,
      bitrate: audioMode === 'original' || outputFormat === 'm4a' ? 'source copy' : requestedBitrate.replace('k', ' kbps'),
      mode: audioMode,
      durationSeconds: turboDurationSeconds,
      codec: resolvedAudioStream?.acodec,
      channels: resolvedAudioStream?.audioChannels,
      formatId: resolvedAudioStream?.formatId,
      originalAudio: audioMode === 'original',
      dolbyLike: Boolean(resolvedAudioStream?.isDolbyLike),
      estimatedSeconds: audioMode === 'turbo' ? 30 : audioMode === 'original' ? 20 : 45,
      size: stat.size,
    });
  } catch (error: any) {
    console.error('Convert audio error:', error.message || error);
    const looksLikeMissingAudio = /audio track unavailable|stream map|matches no streams|does not contain any stream|output was not created/i.test(String(error?.message || ''));
    const status = error?.status || (looksLikeMissingAudio ? 422 : 500);
    const message = status === 422
      ? error?.message || 'Audio track unavailable for this video.'
      : `Failed to extract audio: ${error?.message || 'Unknown error'}`;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/open-folder', async (req, res) => {
  const target = String(req.body?.target || 'downloads');
  const sourcePageUrl = readSourcePageUrl(req, String(req.body?.sourcePageUrl || ''));
  const requestedFolderPath = String(req.body?.folderPath || '').trim();
  const exactFolderPath = requestedFolderPath
    ? assertPathInsideDownloads(requestedFolderPath)
    : '';
  const folderPath = exactFolderPath || (
    target === 'converted-audio'
      ? convertedAudioDir
      : target === 'converted-video'
        ? convertedVideoDir
        : target === 'video-downloads'
          ? resolveDownloadSaveDir('video', sourcePageUrl)
          : target === 'fonts'
            ? resolveCreativeAssetsDir(sourcePageUrl, 'Fonts', { sectionMode: lastExtractionSectionMode })
            : target === 'colors'
              ? resolveCreativeAssetsDir(sourcePageUrl, 'Colors', { sectionMode: lastExtractionSectionMode })
            : target === 'icons'
              ? resolveCreativeAssetsDir(sourcePageUrl, 'Images', { sectionMode: lastExtractionSectionMode })
              : target === 'images'
                ? resolveCreativeAssetsDir(sourcePageUrl, 'Images', { sectionMode: lastExtractionSectionMode })
                : resolveCreativeAssetsRoot(sourcePageUrl, { sectionMode: lastExtractionSectionMode })
  );

  try {
    const stat = await fsp.stat(folderPath);
    if (!stat.isDirectory()) throw new Error('Requested Downloads path is not a folder.');
    await openLocalFolder(folderPath);
    return res.json({ ok: true, path: folderPath });
  } catch (error: any) {
    console.error('Open folder error:', error.message || error);
    return res.status(500).json({ error: 'Could not open the folder on this machine.' });
  }
});

const WEBSITE_DOWNLOAD_SUBFOLDERS = ['Images', 'Videos', 'Fonts', 'Colors', 'Logs'] as const;

const isInsidePath = (candidate: string, parent: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const ensureWebsiteDownloadStructure = async (sourcePageUrl: string) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl, { sectionMode: lastExtractionSectionMode });
  await fsp.mkdir(root, { recursive: true });
  await Promise.all(WEBSITE_DOWNLOAD_SUBFOLDERS.map((subfolder) => fsp.mkdir(path.join(root, subfolder), { recursive: true })));
  return root;
};

app.delete('/api/website-downloads', async (req, res) => {
  const sourcePageUrl = readSourcePageUrl(req, String(req.body?.sourcePageUrl || ''));
  const deleteFiles = Boolean(req.body?.deleteFiles);
  if (!sourcePageUrl) return res.status(400).json({ error: 'Source URL is required.' });

  try {
    const root = resolveCreativeAssetsRoot(sourcePageUrl, { sectionMode: lastExtractionSectionMode });
    if (!deleteFiles) return res.json({ ok: true, mode: 'history', removed: 0, path: root });

    const downloadsRoot = path.join(os.homedir(), 'Downloads');
    if (!isInsidePath(root, downloadsRoot)) {
      return res.status(400).json({ error: 'Refusing to clear files outside Downloads.' });
    }

    const entries = await fsp.readdir(root).catch(() => []);
    await fsp.rm(root, { recursive: true, force: true });
    return res.json({ ok: true, mode: 'files', removed: entries.length, path: root });
  } catch (error: any) {
    console.error('Clear website downloads error:', error.message || error);
    return res.status(500).json({ error: error?.message || 'Failed to clear website downloads.' });
  }
});

app.get('/api/fetch-direct-video', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!isDirectProgressiveVideoUrl(url)) {
    return res.status(400).json({ error: 'Only direct progressive video URLs are supported.' });
  }

  try {
    assertPublicAssetUrl(url);
    const sourcePageUrl = typeof req.query.sourcePageUrl === 'string' ? req.query.sourcePageUrl : undefined;
    const payload = await buildDirectProgressiveVideoPayload(url, req, sourcePageUrl, { cache: true });
    const preferredName = typeof filename === 'string' && filename.trim()
      ? filename.trim().replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120)
      : payload.localFilename;
    const filePath = payload.localPath || path.join(downloadsDir, payload.localFilename);
    const stat = await validateOutputFile(filePath, 'Direct video download');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${preferredName || payload.localFilename}"`);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return fs.createReadStream(filePath).pipe(res);
  } catch (error: any) {
    console.error('Direct video fetch error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Failed to fetch direct video.' });
  }
});

app.get('/api/download-local-video', async (req, res) => {
  const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
  const safeFilename = filename
    .split('/')
    .map((segment) => segment.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/');
  if (!safeFilename || safeFilename !== filename || !safeFilename.toLowerCase().endsWith('.mp4')) {
    return res.status(400).json({ error: 'A valid local MP4 filename is required.' });
  }

  const filePath = path.join(downloadsDir, safeFilename);
  const resolved = assertPathInsideDownloads(filePath);

  try {
    await validateOutputFile(resolved, 'Local video download');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store, private');
    return fs.createReadStream(resolved).pipe(res);
  } catch {
    return res.status(404).json({ error: 'Local video file was not found in Downloads.' });
  }
});

app.head('/api/download-local-video', async (req, res) => {
  const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
  const safeFilename = filename
    .split('/')
    .map((segment) => segment.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/');
  if (!safeFilename || safeFilename !== filename || !safeFilename.toLowerCase().endsWith('.mp4')) {
    return res.status(400).end();
  }
  const filePath = path.join(downloadsDir, safeFilename);
  try {
    const stat = await validateOutputFile(assertPathInsideDownloads(filePath), 'Local video download');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stat.size));
    return res.status(200).end();
  } catch {
    return res.status(404).end();
  }
});

app.post('/api/ftp/upload-url', async (req, res) => {
  const {
    ftpHost,
    ftpPort,
    ftpUser,
    ftpPassword,
    ftpSecure,
    remoteDir,
    fileUrl,
    filename,
  } = req.body || {};

  if (!ftpHost || !ftpUser || !ftpPassword || !fileUrl) {
    return res.status(400).json({
      error: 'ftpHost, ftpUser, ftpPassword, and fileUrl are required',
    });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fileUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid fileUrl' });
  }

  const downloadResponse = await axios({
    method: 'GET',
    url: parsedUrl.href,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
    },
    validateStatus: (status) => status >= 200 && status < 300,
  }).catch((error: any) => {
    const status = error?.response?.status;
    throw new Error(status ? `Source download failed (${status})` : 'Source download failed');
  });

  const fileBuffer = Buffer.from(downloadResponse.data);
  const inferredName = parsedUrl.pathname.split('/').pop() || 'asset.bin';
  const safeFilename = String(filename || inferredName).replace(/[\\/:*?"<>|]/g, '_');
  const port = Number(ftpPort) > 0 ? Number(ftpPort) : 21;
  const secure = Boolean(ftpSecure);

  const ftp = new FtpClient(30000);
  ftp.ftp.verbose = false;

  try {
    await ftp.access({
      host: String(ftpHost),
      port,
      user: String(ftpUser),
      password: String(ftpPassword),
      secure,
    });

    const normalizedRemoteDir = String(remoteDir || '').trim();
    if (normalizedRemoteDir) {
      await ftp.ensureDir(normalizedRemoteDir);
    }

    await ftp.uploadFrom(Readable.from(fileBuffer), safeFilename);

    const uploadedPath = normalizedRemoteDir ? `${normalizedRemoteDir}/${safeFilename}` : safeFilename;
    return res.json({
      ok: true,
      uploadedPath,
      bytes: fileBuffer.length,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: `FTP upload failed: ${error?.message || 'Unknown error'}`,
    });
  } finally {
    ftp.close();
  }
});

app.get('/api/resolve-vimeo', async (req, res) => {
  const { url, quality, sourcePageUrl } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const requestedQuality = typeof quality === 'string' && ['hd', 'fhd', '4k'].includes(quality) ? quality : 'fhd';

  const vimeoUrl = normalizeVimeoUrl(url);
  if (!vimeoUrl) {
    return res.status(400).json({ error: 'A valid Vimeo URL is required' });
  }
  try {
    assertPublicAssetUrl(vimeoUrl);
  } catch (securityError: any) {
    return res.status(403).json({ error: securityError?.message || 'Private or local video URLs are blocked.' });
  }

  try {
    const source = typeof sourcePageUrl === 'string' ? sourcePageUrl : '';
    const vimeoAssets = await withTimeout(
      extractVimeoVideos([vimeoUrl], requestedQuality, source),
      VIMEO_EXTRACT_TIMEOUT_MS,
      `Vimeo progressive resolve for ${vimeoUrl}`
    );
    const directVideo = vimeoAssets.videos.find(
      (video) =>
        video.isVimeoDirect &&
        streamHasAudio(video) &&
        (video.displayQualityKey === requestedQuality || video.qualityRequested === requestedQuality)
    ) || (requestedQuality === 'fhd'
      ? vimeoAssets.videos.find(
          (video) =>
            video.isVimeoDirect &&
            streamHasAudio(video) &&
            (video.displayQualityKey === 'hd' || video.qualityRequested === 'hd')
        )
      : undefined) ||
      vimeoAssets.videos.find((video) => video.isVimeoDirect && streamHasAudio(video));
    if (!directVideo && isDirectProgressiveVideoUrl(url)) {
      try {
        const source = typeof sourcePageUrl === 'string' ? sourcePageUrl : undefined;
        const directFallback = await buildDirectProgressiveVideoPayload(url, req, source, { cache: false });
        if (directFallback?.url && streamHasAudio(directFallback)) {
          const selectedHeight = parseCandidateHeight(directFallback);
          return res.json({
            video: enforceMp4VideoPayload({
              ...directFallback,
              qualityRequested: requestedQuality,
              qualityExact: matchesStrictQuality(selectedHeight, requestedQuality),
              qualityFallback: !matchesStrictQuality(selectedHeight, requestedQuality),
              fallbackMessage:
                requestedQuality === 'fhd'
                  ? '1080p was unavailable, so the best fetched MP4 with audio was selected instead.'
                  : undefined,
              hasAudio: true,
              audioAvailable: true,
              noAudio: false,
            }),
            images: vimeoAssets.images,
          });
        }
      } catch (directFallbackError: any) {
        console.warn('Vimeo direct MP4 fallback failed:', directFallbackError?.message || directFallbackError);
      }
    }
    if (!directVideo) {
      const debug = vimeoAssets.videos.find((video) => video?.vimeoQualityDebug)?.vimeoQualityDebug;
      const qualityLabel = requestedQuality === 'fhd' ? '1080p FHD' : requestedQuality === 'hd' ? '720p HD' : requestedQuality.toUpperCase();
      return res.status(404).json({
        error: `No ${qualityLabel} Vimeo stream is available for this video.`,
        vimeoQualityDebug: debug,
      });
    }
    const validVideo = directVideo
      ? directVideo.isVimeoDirect
        ? enforceMp4VideoPayload(directVideo)
        : await validateAndNormalizeVideo(directVideo, vimeoUrl)
      : null;
    if (validVideo) {
      const selectedHeight = parseCandidateHeight(validVideo);
      const qualityExact = matchesStrictQuality(selectedHeight, requestedQuality);
      return res.json({
        video: enforceMp4VideoPayload({
          ...validVideo,
          qualityRequested: requestedQuality,
          qualityExact,
          qualityFallback: !qualityExact,
          fallbackMessage:
            !qualityExact && requestedQuality === 'fhd'
              ? `1080p was unavailable, so the best MP4 with audio was selected instead.`
              : validVideo?.fallbackMessage,
          hasAudio: true,
          audioAvailable: true,
          noAudio: false,
        }),
        images: vimeoAssets.images,
      });
    }
    return res.status(404).json({
      error: 'No downloadable Vimeo progressive MP4 stream was available for this link.',
    });
  } catch (error: any) {
    console.error('Vimeo resolve error:', error.message || error);
    const msg = String(error?.message || error || '');
    if (/HTTP Error 404|not found/i.test(msg)) {
      return res.status(404).json({ error: 'This Vimeo video is unavailable (404).' });
    }
    res.status(500).json({ error: `Failed to resolve Vimeo download link: ${msg || 'Unknown error'}` });
  }
});

app.get('/api/video-quality-manifest', async (req, res) => {
  const { url, sourcePageUrl } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }
  try {
    assertPublicAssetUrl(url);
    const manifest = await getVideoQualityManifestFast(
      url,
      typeof sourcePageUrl === 'string' ? sourcePageUrl : undefined
    );
    return res.json(manifest);
  } catch (error: any) {
    console.warn('Video quality manifest probe skipped:', error?.message || error);
    return res.json({
      fhd: false,
      hd: false,
      audio: true,
      title: '',
      thumbnail: '',
      variants: {},
      pending: true,
    });
  }
});

app.get('/api/resolve-video', async (req, res) => {
  const { url, quality } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const requestedQuality = typeof quality === 'string' && ['hd', 'fhd', '4k'].includes(quality) ? quality : 'fhd';
  const resolverTargetUrl = isYouTubeUrl(url) ? normalizeYouTubeWatchUrl(url) : url;
  try {
    assertPublicAssetUrl(resolverTargetUrl);
  } catch (securityError: any) {
    return res.status(403).json({ error: securityError?.message || 'Private or local video URLs are blocked.' });
  }

  if (isDirectProgressiveVideoUrl(resolverTargetUrl)) {
    try {
      const sourcePageUrl = typeof req.query.sourcePageUrl === 'string' ? req.query.sourcePageUrl : undefined;
      const video = await buildDirectProgressiveVideoPayload(resolverTargetUrl, req, sourcePageUrl, { cache: false });
      return res.json({ video });
    } catch (directError: any) {
      console.error('Direct progressive video resolve error:', directError?.message || directError);
      return res.status(500).json({ error: directError?.message || 'Failed to resolve direct video metadata.' });
    }
  }

  const qualityUnavailableMessage =
    requestedQuality === 'fhd'
      ? '1080p stream is not available for this YouTube video.'
      : requestedQuality === 'hd'
        ? '720p stream is not available for this YouTube video.'
        : 'Requested quality stream is not available for this YouTube video.';

  try {
    if (isBrightcoveUrl(url)) {
      try {
        const brightcoveAssets = await extractBrightcoveVideos(url);
        const mergeCandidate: any = (brightcoveAssets.videos || []).find((video: any) => video?.brightcoveManifestUrl);
        // Prefer the HLS manifest captured from Brightcove and remux it to a
        // local MP4. Progressive MP4 remains a fallback when no HLS source is
        // published by the player.
        const directCandidates = (mergeCandidate ? [] : (brightcoveAssets.videos || []))
          .filter((video: any) => video?.isDirect && isLikelyDirectVideoStreamUrl(String(video.sourceStreamUrl || video.url || '')));
        const exactCandidates = directCandidates.filter((video: any) => matchesStrictQuality(parseCandidateHeight(video), requestedQuality));
        const selected = await firstValidStreamCandidate(
          sortCandidatesForQuality(exactCandidates.length > 0 ? exactCandidates : directCandidates, requestedQuality),
          url,
          url
        );
        if (selected?.url) {
          const selectedHeight = selected.height || parseCandidateHeight(selected);
          return res.json({
            video: enforceMp4VideoPayload({
              ...selected,
              url: selected.url,
              sourceUrl: url,
              provider: 'brightcove',
              type: 'mp4',
              height: selectedHeight,
              resolution: selected.resolution || (selectedHeight ? `${selectedHeight}p` : 'Best Quality'),
              qualityRequested: requestedQuality,
              qualityExact: matchesStrictQuality(selectedHeight, requestedQuality),
              qualityFallback: !matchesStrictQuality(selectedHeight, requestedQuality),
              displayQualityKey: matchesStrictQuality(selectedHeight, requestedQuality) ? requestedQuality : getCleanQualityKey(selected),
              verifiedPlayable: true,
              isDirect: true,
            }),
          });
        }
        const hlsInputUrl = String(mergeCandidate?.brightcoveManifestUrl || '');
        const mergedVideo = await materializeMergedMp4FromPlatform(
          url,
          requestedQuality,
          req,
          mergeCandidate?.title || directCandidates[0]?.title || 'Brightcove video',
          hlsInputUrl ? { directInputUrl: hlsInputUrl, sourcePageUrl: url } : {}
        );
        return res.json({ video: mergedVideo });
      } catch (brightcoveError: any) {
        const brightcoveMessage = String(brightcoveError?.message || brightcoveError || '');
        if (/\bVIDEO_NOT_FOUND\b/i.test(brightcoveMessage)) {
          return res.status(404).json({
            error: 'Brightcove reports that this video does not exist or is no longer available. Check the videoId with the publisher.',
          });
        }
        console.warn('Brightcove resolve failed, trying universal yt-dlp route:', brightcoveError?.message || brightcoveError);
      }
    }

    if (isYouTubeUrl(url)) {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(resolverTargetUrl);
      const titleHint = await fetchYouTubeOEmbedTitle(normalizedWatchUrl);
      const sourcePageUrl = typeof req.query.sourcePageUrl === 'string' ? req.query.sourcePageUrl : normalizedWatchUrl;
      const prepared = await prepareYouTubeQualityOutput(normalizedWatchUrl, requestedQuality, {
        titleHint,
        sourcePageUrl,
        exportToDownloads: false,
      });
      return res.json({
        video: youTubePreparedToVideoPayload(prepared, requestedQuality, titleHint),
      });
    }

    const metadataTimeoutMs = isYouTubeUrl(url) ? 45000 : 15000;
    const sourcePageUrl = typeof req.query.sourcePageUrl === 'string' ? req.query.sourcePageUrl : url;
    const info: any = await withTimeout(
      youtubedl(resolverTargetUrl, {
        dumpSingleJson: true,
        ...buildYtDlpQueryOptions(resolverTargetUrl, sourcePageUrl),
      } as any),
      metadataTimeoutMs,
      `Video metadata for ${url}`
    );

    const formats = Array.isArray(info.formats) ? info.formats : [];
    const requestedDownloads = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
    const mergedCandidates = [
      ...formats,
      ...requestedDownloads,
      ...(info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, tbr: info.tbr }] : []),
    ];

    const normalizedCandidates = mergedCandidates
      .map((candidate: any) => {
        const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ''), resolverTargetUrl);
        return normalizedUrl ? { ...candidate, url: normalizedUrl } : null;
      })
      .filter(Boolean)
      .filter((candidate: any) => !isExpiredStreamUrl(String(candidate.url)));

    const platformNeedsProgressiveMp4 = isXUrl(url) || isFacebookUrl(url) || isInstagramUrl(url) || isBrightcoveUrl(url);
    const platformHasAudioCandidate = normalizedCandidates.some((candidate: any) => streamHasAudio(candidate));
    const playableCandidates = normalizedCandidates.filter((candidate: any) => {
      const raw = String(candidate.url || '');
      const ext = String(candidate.ext || '').toLowerCase();
      if (isTechnicalOrUnsupportedStream(candidate)) return false;
      if (isYouTubeUrl(url) && raw.includes('.m3u8')) return false;
      if (platformNeedsProgressiveMp4) {
        if (!streamHasVideo(candidate)) return false;
        if (!streamHasAudio(candidate) && platformHasAudioCandidate) return false;
        if (ext && ext !== 'mp4' && ext !== 'm4v') return false;
        if (!/\.mp4(?:\?|$)|\.m4v(?:\?|$)|\/amplify_video\/|fbcdn\.net|cdninstagram\.com|twimg\.com/i.test(raw)) return false;
      }
      if (isLikelyDirectVideoStreamUrl(raw)) return true;
      return !isYouTubeUrl(url) && isLikelyVideoAssetUrl(raw);
    });

    let selected = await firstValidStreamCandidate(
      sortCandidatesForQuality(playableCandidates, requestedQuality),
      resolverTargetUrl,
      resolverTargetUrl
    );

    if (!selected?.url) {
      if (isFacebookUrl(url)) {
        const fallback = await extractFacebookVideoFallback(url, requestedQuality);
        const validFallback = fallback ? await validateAndNormalizeVideo(fallback, url) : null;
        if (validFallback?.url) return res.json({ video: enforceMp4VideoPayload(validFallback) });
      }
      if (isXUrl(url)) {
        const fallback = await extractXVideoFallback(url, requestedQuality);
        const validFallback = fallback ? await validateAndNormalizeVideo(fallback, url) : null;
        if (validFallback?.url) return res.json({ video: enforceMp4VideoPayload(validFallback) });
      }
      if (platformNeedsProgressiveMp4) {
        try {
          const mergedVideo = await materializeMergedMp4FromPlatform(url, requestedQuality, req, info.title || pageTitleFromUrl(url));
          return res.json({ video: mergedVideo });
        } catch (mergeError: any) {
          console.warn('Merged MP4 fallback failed:', mergeError?.message || mergeError);
        }
      }
      return res.status(404).json({ error: 'No direct downloadable stream found for this link.' });
    }

    if (!isLikelyDirectVideoStreamUrl(String(selected.url)) && !(isLikelyVideoAssetUrl(String(selected.url)) && !isYouTubeUrl(url))) {
      return res.status(404).json({ error: 'No direct MP4/video stream found for this link.' });
    }

    const selectedHeight = selected.height || parseCandidateHeight(selected);
    const exactQuality = matchesStrictQuality(selectedHeight, requestedQuality);
    const fallbackLabel = getCleanQualityLabel(getCleanQualityKey(selected));
    const selectedHasAudio = streamHasAudio(selected);
    const video = {
      url: selected.url,
      sourceUrl: url,
      watchUrl: isYouTubeUrl(url) ? normalizeYouTubeWatchUrl(url) : undefined,
      provider: info.extractor_key || info.extractor || 'video',
      type: selected.ext || 'mp4',
      title: info.title || 'Video',
      thumbnail: sanitizeStreamUrl(info.thumbnail || '', resolverTargetUrl) || info.thumbnail || '',
      resolution: selected.format_note || (selected.height ? `${selected.height}p` : 'Unknown'),
      formatId: selected.format_id || selected.itag || selected.id,
      width: selected.width,
      height: selectedHeight,
      qualityRequested: requestedQuality,
      qualityExact: exactQuality,
      qualityFallback: !exactQuality,
      fallbackMessage: !exactQuality && requestedQuality === 'fhd'
        ? `1080p was unavailable, so ${fallbackLabel} was selected instead.`
        : undefined,
      fps: selected.fps,
      vcodec: selected.vcodec,
      acodec: selected.acodec,
      hasAudio: selectedHasAudio,
      audioAvailable: selectedHasAudio,
      noAudio: !selectedHasAudio,
      filesize: selected.filesize || selected.filesize_approx || selected.contentLength,
      duration: Number(selected.duration || info.duration || 0) || undefined,
      isDirect: true,
      verifiedPlayable: true,
    };

    const payload = enforceMp4VideoPayload(video);
    if (isYouTubeUrl(url) && !selectedHasAudio) {
      return res.json({ video: wrapYouTubePlaybackStream(payload, url, requestedQuality) });
    }
    return res.json({ video: payload });
  } catch (error: any) {
    try {
      if (isFacebookUrl(url)) {
        const fallback = await extractFacebookVideoFallback(url, requestedQuality);
        const validFallback = fallback ? await validateAndNormalizeVideo(fallback, url) : null;
        if (validFallback?.url) return res.json({ video: enforceMp4VideoPayload(validFallback) });
      }
      if (isXUrl(url)) {
        const fallback = await extractXVideoFallback(url, requestedQuality);
        const validFallback = fallback ? await validateAndNormalizeVideo(fallback, url) : null;
        if (validFallback?.url) return res.json({ video: enforceMp4VideoPayload(validFallback) });
      }
      if (isFacebookUrl(url) || isXUrl(url) || isInstagramUrl(url) || isBrightcoveUrl(url)) {
        const mergedVideo = await materializeMergedMp4FromPlatform(url, requestedQuality, req, pageTitleFromUrl(url));
        return res.json({ video: mergedVideo });
      }
    } catch (fallbackError: any) {
      console.error('Fallback resolve error:', fallbackError.message || fallbackError);
    }
    console.error('Universal resolve error:', error.message || error);
    if (isYouTubeUrl(url)) {
      return res.status(404).json({ error: qualityUnavailableMessage });
    }
    return res.status(500).json({ error: 'Failed to resolve downloadable stream for this link.' });
  }
});

app.get('/api/video-preview', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const targetUrl = new URL(url).href;
    assertPublicAssetUrl(targetUrl);
    const response = await axios.get(targetUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = String(response.data || '');
    const $ = cheerio.load(html);

    const rawThumb =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[property="og:image:url"]').attr('content') ||
      '';

    const thumb = rawThumb ? (resolveUrl(targetUrl, rawThumb) || rawThumb) : '';
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').first().text().trim() ||
      'Video link';

    const preview = {
      sourceUrl: targetUrl,
      thumbnail: thumb,
      title,
      provider: platformProviderFromUrl(targetUrl),
    };

    if (!preview.thumbnail && (isPlatformVideoUrl(targetUrl) || isLikelyHttpMediaUrl(targetUrl))) {
      const richPreview = await getVideoPreviewMetadata(targetUrl);
      if (richPreview) {
        preview.thumbnail = richPreview.thumbnail || preview.thumbnail;
        preview.title = richPreview.title || preview.title;
        preview.provider = richPreview.provider || preview.provider;
      }
    }

    if (!preview.thumbnail && isLikelyHttpMediaUrl(targetUrl)) {
      preview.thumbnail = await generateVideoFrameThumbnail(targetUrl, targetUrl, req).catch(() => '');
    }

    return res.json({
      preview,
    });
  } catch (error: any) {
    const targetUrl = sanitizeStreamUrl(String(url)) || String(url);
    const richPreview = isPlatformVideoUrl(targetUrl) || isLikelyHttpMediaUrl(targetUrl)
      ? await getVideoPreviewMetadata(targetUrl)
      : null;
    const frameThumbnail = !richPreview?.thumbnail && isLikelyHttpMediaUrl(targetUrl)
      ? await generateVideoFrameThumbnail(targetUrl, targetUrl, req).catch(() => '')
      : '';

    return res.status(200).json({
      preview: {
        sourceUrl: targetUrl,
        thumbnail: richPreview?.thumbnail || frameThumbnail || '',
        title: richPreview?.title || 'Video link',
        provider: richPreview?.provider || platformProviderFromUrl(targetUrl),
      },
    });
  }
});

app.get('/api/font-source', async (req, res) => {
  const { url, fontUrl, fontFamily } = req.query;
  if (!url || typeof url !== 'string' || !fontUrl || typeof fontUrl !== 'string') {
    return res.status(400).json({ error: 'url and fontUrl are required' });
  }

  try {
    const normalizedSiteUrl = new URL(url).href;
    const { inlineStyles, fetchedCss } = await fetchCssSourceCandidates(normalizedSiteUrl);

    const fullFontUrl = fontUrl;
    const strippedFontUrl = fullFontUrl.split('?')[0];
    const basename = strippedFontUrl.split('/').pop() || '';
    const family = String(fontFamily || '').trim().toLowerCase();
    const familyNeedle = family ? family.replace(/['"]/g, '') : '';

    const allSources = [...inlineStyles, ...fetchedCss];
    const matchingSources = allSources
      .filter(({ css }) => {
        const text = css.toLowerCase();
        return (
          text.includes(fullFontUrl.toLowerCase()) ||
          text.includes(strippedFontUrl.toLowerCase()) ||
          (basename ? text.includes(basename.toLowerCase()) : false) ||
          (familyNeedle ? text.includes(familyNeedle) : false)
        );
      })
      .map((entry) => entry.source);

    const uniqueSources = Array.from(new Set(matchingSources));

    return res.json({
      source: uniqueSources[0] || null,
      sources: uniqueSources,
    });
  } catch (error: any) {
    console.error('Font source resolve error:', error.message || error);
    return res.status(500).json({ error: 'Failed to resolve font CSS source.' });
  }
});

app.post('/api/insights', async (req, res) => {
  const { url, assets: clientAssets } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const imageCacheMap = new Map<string, string>();
  for (const img of clientAssets?.images || []) {
    const remote = String(img?.url || '').trim();
    const cached = String(img?.cachedUrl || '').trim();
    if (remote && cached) imageCacheMap.set(remote, cached);
  }

  const applyBriefAssetPreview = (asset: any) => {
    if (!asset?.url) return asset;
    const cachedUrl = imageCacheMap.get(asset.url);
    return {
      ...asset,
      remote_url: asset.url,
      preview_url: cachedUrl || undefined,
    };
  };

  const scoreHeroImage = (asset: any) => {
    let score = Number(asset?.priority || 0);
    const label = `${asset?.url || ''} ${asset?.alt || ''} ${asset?.title || ''}`.toLowerCase();
    if (/hero|banner|masthead|key-visual|keyvisual|about-/.test(label)) score += 2500;
    if (/\/wp-content\/uploads\//i.test(asset?.url || '')) score += 600;
    if (/\.jpe?g(\?|$)/i.test(asset?.url || '')) score += 120;
    return score;
  };

  const isBotWallAsset = (asset: any) => {
    const label = `${asset?.url || ''} ${asset?.alt || ''}`.toLowerCase();
    return /robot-suspicion|captcha|challenge|akamai|datadome|cf-chl|waf|blocked/.test(label);
  };

  const clientImageAssets = () =>
    (clientAssets?.images || [])
      .filter((img: any) => img?.url && !String(img.url).startsWith('data:'))
      .map((img: any) => ({
        url: String(img.url),
        alt: '',
        source: 'extracted-asset',
        priority: scoreHeroImage({ url: img.url, alt: img.url }),
        preview_url: String(img.cachedUrl || '').trim() || undefined,
        pageUrl: '',
        stage: 'Awareness',
      }));

  const normalizeExactBlock = (value: string) => normalizeExactBlockText(value);

  const safetyKeywords = [
    'important safety information',
    'safety',
    'warnings',
    'disclaimer',
    'side effects',
    'risk information',
  ];

  const normalizeUrl = (raw: string) => {
    try {
      const parsed = new URL(raw);
      // Remove common tracking params so crawl budget isn't wasted on duplicate URLs.
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach((key) => parsed.searchParams.delete(key));
      parsed.hash = '';
      return parsed.href;
    } catch {
      return '';
    }
  };

  const sameDomain = (candidate: string, originHost: string) => {
    try {
      const host = new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
      return host === originHost || host.endsWith(`.${originHost}`);
    } catch {
      return false;
    }
  };

  const textHash = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const uniqueByText = (items: string[]) => {
    const seen = new Set<string>();
    const unique: string[] = [];
    items.forEach((item) => {
      const normalized = textHash(item);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      unique.push(item);
    });
    return unique;
  };
  const uniqueExactBlocks = (items: string[]) => {
    const seen = new Set<string>();
    const unique: string[] = [];
    items.forEach((item) => {
      const normalized = normalizeExactBlock(item);
      if (!normalized) return;
      const key = normalized.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(normalized);
    });
    return unique;
  };

  const stageFor = (text: string) => {
    const lower = text.toLowerCase();
    if (/(buy|get started|pricing|trial|book|contact|download|learn more|request demo)/.test(lower)) return 'Conversion';
    if (/(feature|benefit|compare|study|results|proof|review|trusted|demo|efficacy|safety)/.test(lower)) return 'Consideration';
    return 'Awareness';
  };

  const splitSnippets = (text: string, min = 28, max = 280, limit = 6) => {
    return uniqueByText(
      text
        .split(/(?<=[.!?])\s+|[\n•]+/)
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter((item) => item.length >= min && item.length <= max)
    ).slice(0, limit);
  };

  let browser: any;

  try {
    const seedUrl = normalizeUrl(new URL(url).href);
    assertPublicAssetUrl(seedUrl);
    const originHost = new URL(seedUrl).hostname.replace(/^www\./, '').toLowerCase();
    const maxDepth = 1;
    const maxPages = 5;
    const crawlBudgetMs = 16000;
    const pageBudgetMs = 9000;
    const crawlStart = Date.now();

    browser = await launchPuppeteerBrowser();

    const queue: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }];
    const visited = new Set<string>();

    const headingCandidates: Array<{ text: string; score: number }> = [];
    const heroImages: any[] = [];
    const heroVideos: any[] = [];
    const valueCards: any[] = [];
    const featureCards: any[] = [];
    const testimonialCards: any[] = [];
    const visualAssets: any[] = [];
    const videos: any[] = [];
    const importantInfo: Array<{ text: string; source_url: string }> = [];
    const disclaimerInfo: Array<{ text: string; source_url: string }> = [];
    const legalInfo: Array<{ text: string; source_url: string }> = [];
    const referenceInfo: Array<{ text: string; source_url: string }> = [];
    const indicationCandidates: Array<{ text: string; source_url: string }> = [];
    const isiCandidates: Array<{ text: string; source_url: string }> = [];
    const keywordsRaw: string[] = [];

    const prefetchedHtml = await withTimeout(fetchSiteHtml(seedUrl), 28000, `Insights prefetch HTML for ${seedUrl}`).catch(() => '');
    if (prefetchedHtml && !isBotWallHtml(prefetchedHtml)) {
      const $prefetch = cheerio.load(prefetchedHtml);
      const prefetchHeading = $prefetch('h1').first().text().replace(/\s+/g, ' ').trim();
      if (prefetchHeading.length > 4 && !/^phyrago\.com$/i.test(prefetchHeading) && !isBotWallText(prefetchHeading)) {
        headingCandidates.push({ text: prefetchHeading, score: 1200 });
      }
      const prefetchTextBlocks = $prefetch('section, article, div, aside, footer, main, p, li')
        .map((_, el) => $prefetch(el).text())
        .get();
      const prefetchPharma = extractPharmaBlocksFromText(prefetchTextBlocks);
      indicationCandidates.push(...prefetchPharma.indication.map((text) => ({ text, source_url: seedUrl })));
      isiCandidates.push(...prefetchPharma.isi.map((text) => ({ text, source_url: seedUrl })));
      extractIndicationBlocksFromHtml(prefetchedHtml).forEach((text) => {
        indicationCandidates.push({ text, source_url: seedUrl });
      });
      extractIsiBlocksFromHtml(prefetchedHtml).forEach((text) => {
        isiCandidates.push({ text, source_url: seedUrl });
      });
    }

    const scoreLink = (candidate: string) => {
      const lower = candidate.toLowerCase();
      if (/(important|safety|warning|disclaimer|risk|isi|pi|prescribing|side-effects)/.test(lower)) return 120;
      if (/(feature|benefit|about|product|learn|results|video|gallery|testimonial|review)/.test(lower)) return 70;
      return 10;
    };

    while (queue.length > 0 && visited.size < maxPages) {
      if (Date.now() - crawlStart > crawlBudgetMs) break;
      const current = queue.shift()!;
      if (visited.has(current.url) || current.depth > maxDepth) continue;
      visited.add(current.url);

      const page = await acquireSingleWebsitePage(browser);
      try {
        await withTimeout(
          (async () => {
        await applyPuppeteerStealth(page);
        await page.setViewport({ width: 1440, height: 1100 });
        await page.goto(current.url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 600));

        let html = await page.content().catch(() => '');
        if (current.depth === 0 && (isBotWallHtml(html) || isLikelyBotWallExtract(clientAssets || {}))) {
          await page.goto(current.url, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 5000));
          html = await page.content().catch(() => html);
        }

        // Attempt to surface tabbed content on-page.
        const tabHandles = await page.$$('[role="tab"], button[aria-controls], button[data-tab], button[data-target], .tab, .tabs button').catch(() => []);
        for (const handle of tabHandles.slice(0, 8)) {
          try {
            await handle.click({ delay: 10 });
            await new Promise(resolve => setTimeout(resolve, 80));
          } catch {
            // Ignore tab interaction failures.
          }
        }

        const extracted = await page.evaluate(insightsPageEvaluate, current.url, safetyKeywords).catch(() => ({}));

        const htmlFromPage = html || (await page.content().catch(() => ''));
        const $ = cheerio.load(htmlFromPage || '<html></html>');
        const htmlSafety = uniqueExactBlocks(
          $('section, article, div, p, li, footer, [class*="isi" i]')
            .map((_, el) => $(el).text())
            .get()
            .map(item => normalizeExactBlock(item))
            .filter(item => item.length > 20 && !isBotWallText(item) && safetyKeywords.some(keyword => item.toLowerCase().includes(keyword)))
        );
        const htmlDisclaimers = uniqueExactBlocks(
          $('section, article, div, p, li')
            .map((_, el) => $(el).text())
            .get()
            .map(item => normalizeExactBlock(item))
            .filter(item => item.length > 20 && /(disclaimer|not imply|terms apply|limitations|see full prescribing information|full pi|reference)/i.test(item))
        );
        const htmlLegal = uniqueExactBlocks(
          $('section, article, div, p, li')
            .map((_, el) => $(el).text())
            .get()
            .map(item => normalizeExactBlock(item))
            .filter(item => item.length > 20 && /(legal|terms of use|terms and conditions|privacy policy|copyright|all rights reserved|fair balance)/i.test(item))
        );
        const htmlReferences = uniqueExactBlocks(
          $('section, article, div, p, li')
            .map((_, el) => $(el).text())
            .get()
            .map(item => normalizeExactBlock(item))
            .filter(item => item.length > 20 && /(reference|references|bibliography|clinical trial|nct0|nct-)/i.test(item))
        );

        const extractPharmaBlocks = (items: string[]) => extractPharmaBlocksFromText(items);

        const pageTextBlocks = $('section, article, div, aside, footer, main, p, li')
          .map((_, el) => $(el).text())
          .get();
        const pharmaBlocks = extractPharmaBlocks(pageTextBlocks);
        extractIndicationBlocksFromHtml(htmlFromPage).forEach((text) => {
          indicationCandidates.push({ text, source_url: current.url });
        });
        extractIsiBlocksFromHtml(htmlFromPage).forEach((text) => {
          isiCandidates.push({ text, source_url: current.url });
        });

        headingCandidates.push(...((extracted as any).headingCandidates || []));
        heroImages.push(...((extracted as any).heroImages || []).map((asset: any) => ({ ...asset, pageUrl: current.url, stage: 'Awareness' })));
        visualAssets.push(...((extracted as any).galleryImages || []).map((asset: any) => ({ ...asset, pageUrl: current.url, stage: 'Awareness' })));

        const videoAssets = ((extracted as any).videos || []).map((asset: any) => ({ ...asset, pageUrl: current.url, stage: 'Consideration' }));
        videos.push(...videoAssets);
        heroVideos.push(...videoAssets.filter((asset: any) => /hero|intro|overview|video|demo|youtube|vimeo/i.test(`${asset.url} ${asset.title}`)));

        const focusSnippets = splitSnippets(
          ((extracted as any).focusSections || []).map((section: any) => section.text).join('. '),
          28,
          280,
          8
        );
        valueCards.push(...focusSnippets.map(text => ({
          title: text.split(/[:.!?]/)[0].slice(0, 90),
          text,
          stage: stageFor(text),
          source_url: current.url
        })));

        const featureSnippets = uniqueByText(
          ((extracted as any).featureSections || []).flatMap((section: any) => splitSnippets(section.text, 24, 320, 4))
        ).slice(0, 18);
        featureCards.push(
          ...featureSnippets.map((text, idx) => ({
            title: text.split(/[:.!?]/)[0].slice(0, 90),
            text,
            image: (extracted as any).featureSections?.[idx]?.image || '',
            stage: stageFor(text),
            source_url: current.url,
          }))
        );

        testimonialCards.push(
          ...((extracted as any).testimonialSections || []).slice(0, 10).map((section: any) => {
            const quoteMatch = section.text.match(/[“"]([^”"]{20,360})[”"]/);
            const quote = (quoteMatch?.[1] || section.text).replace(/\s+/g, ' ').trim();
            const nameMatch = section.text.match(/\b(?:by|from|—|-)\s+([A-Z][A-Za-z .'-]{2,70})/);
            return {
              quote,
              name: (nameMatch?.[1] || section.title || '').trim(),
              stage: 'Consideration',
              source_url: current.url,
            };
          })
        );

        importantInfo.push(
          ...((extracted as any).safetyBlocks || []).map((text: string) => ({ text, source_url: current.url })),
          ...htmlSafety.map((text) => ({ text, source_url: current.url }))
        );
        disclaimerInfo.push(
          ...((extracted as any).disclaimerBlocks || []).map((text: string) => ({ text, source_url: current.url })),
          ...htmlDisclaimers.map((text) => ({ text, source_url: current.url }))
        );
        legalInfo.push(
          ...((extracted as any).legalBlocks || []).map((text: string) => ({ text, source_url: current.url })),
          ...htmlLegal.map((text) => ({ text, source_url: current.url }))
        );
        referenceInfo.push(
          ...((extracted as any).referenceBlocks || []).map((text: string) => ({ text, source_url: current.url })),
          ...htmlReferences.map((text) => ({ text, source_url: current.url }))
        );
        indicationCandidates.push(
          ...pharmaBlocks.indication.map((text) => ({ text, source_url: current.url }))
        );
        isiCandidates.push(
          ...pharmaBlocks.isi.map((text) => ({ text, source_url: current.url })),
          ...((extracted as any).safetyBlocks || [])
            .filter((text: string) => /important safety information/i.test(text))
            .map((text: string) => ({ text, source_url: current.url }))
        );
        keywordsRaw.push(...((extracted as any).rawKeywords || []));

        if (current.depth < maxDepth && Date.now() - crawlStart <= crawlBudgetMs) {
          const candidates = uniqueByText(((extracted as any).internalLinks || []))
            .filter((candidate) => !/^(javascript:|mailto:|tel:)/i.test(candidate))
            .filter((candidate) => !/\.(pdf|zip|docx?|xlsx?|pptx?)($|\?)/i.test(candidate))
            .sort((a, b) => scoreLink(b) - scoreLink(a));
          candidates.forEach((candidate) => {
            const normalized = normalizeUrl(candidate);
            if (!normalized) return;
            if (!sameDomain(normalized, originHost)) return;
            if (visited.has(normalized) || queue.some(item => item.url === normalized)) return;
            queue.push({ url: normalized, depth: current.depth + 1 });
          });
          if (queue.length > 40) {
            queue.splice(40);
          }
        }
          })(),
          pageBudgetMs,
          `Insights page ${current.url}`
        );
        const strongIndication = indicationCandidates.some((item) => item.text.length > 60);
        const strongIsi = isiCandidates.some((item) => item.text.length > 200);
        if (strongIndication && strongIsi && visited.size >= 1) break;
      } catch (pageError: any) {
        console.warn(`Insights page crawl skipped for ${current.url}:`, pageError?.message || pageError);
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    const uniqueAssetMap = (assets: any[]) => Array.from(new Map(assets.filter(asset => asset?.url).map(asset => [asset.url, asset])).values());
    let dedupedHeroImages = uniqueAssetMap([
      ...clientImageAssets(),
      ...heroImages.filter((asset) => !isBotWallAsset(asset)),
    ])
      .sort((a, b) => scoreHeroImage(b) - scoreHeroImage(a))
      .slice(0, 16);
    const dedupedHeroVideos = uniqueAssetMap(heroVideos.filter((asset) => !isBotWallAsset(asset))).slice(0, 8);
    const dedupedVideos = uniqueAssetMap(videos.filter((asset) => !isBotWallAsset(asset))).slice(0, 20);
    let dedupedGalleryAssets = uniqueAssetMap([
      ...clientImageAssets(),
      ...visualAssets.filter((asset) => !isBotWallAsset(asset)),
    ])
      .filter((asset) => !dedupedHeroImages.some((hero) => hero.url === asset.url))
      .slice(0, 30);

    const dedupedValueCards = uniqueByText(valueCards.map(card => card.text)).slice(0, 12).map(text => {
      const card = valueCards.find(item => textHash(item.text) === textHash(text));
      return card || { title: text.slice(0, 90), text, stage: stageFor(text), source_url: seedUrl };
    });

    const dedupedFeatureCards = uniqueByText(featureCards.map(card => card.text)).slice(0, 18).map(text => {
      const card = featureCards.find(item => textHash(item.text) === textHash(text));
      return card || { title: text.slice(0, 90), text, stage: stageFor(text), source_url: seedUrl };
    });

    const dedupedTestimonialCards = uniqueByText(testimonialCards.map(card => card.quote)).slice(0, 10).map(quote => {
      const card = testimonialCards.find(item => textHash(item.quote) === textHash(quote));
      return card || { quote, name: '', stage: 'Consideration', source_url: seedUrl };
    });

    const heading = headingCandidates
      .filter((item) => !isBotWallText(item.text))
      .sort((a, b) => b.score - a.score)[0]?.text || '';
    const resolvedHeading =
      heading && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(heading.trim())
        ? heading
        : (dedupedValueCards[0]?.title || dedupedValueCards[0]?.text?.slice(0, 120) || heading);

    const keywordFrequency = keywordsRaw.reduce((acc: Record<string, number>, keyword: string) => {
      const normalized = keyword.toLowerCase();
      acc[normalized] = (acc[normalized] || 0) + 1;
      return acc;
    }, {});
    const keywords = Object.entries(keywordFrequency).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([keyword]) => keyword);
    const mainFocus = dedupedValueCards[0]?.text || '';
    const adHeadlines = uniqueByText([
      heading,
      mainFocus ? mainFocus.split(/[.!?]/)[0] : '',
      keywords.length >= 2 ? `${keywords[0][0].toUpperCase() + keywords[0].slice(1)} for ${keywords[1]}` : '',
    ]).filter(Boolean).slice(0, 6);

    const uniqueTextBlocksWithSource = (items: Array<{ text: string; source_url: string }>) => {
      const seen = new Set<string>();
      const out: Array<{ text: string; source_url: string }> = [];
      items.forEach((item) => {
        if (isBotWallText(item.text)) return;
        const normalized = normalizeExactBlock(item.text);
        if (!normalized || isBotWallText(normalized)) return;
        const key = normalized.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ text: normalized, source_url: item.source_url || seedUrl });
      });
      return out;
    };

    const importantInformationBlocks = uniqueTextBlocksWithSource(importantInfo).slice(0, 24);
    const importantKeySet = new Set(importantInformationBlocks.map((item) => item.text.toLowerCase().replace(/\s+/g, ' ')));
    const disclaimersBlocks = uniqueTextBlocksWithSource(disclaimerInfo)
      .filter((item) => !importantKeySet.has(item.text.toLowerCase().replace(/\s+/g, ' ')))
      .slice(0, 24);
    const disclaimerKeySet = new Set(disclaimersBlocks.map((item) => item.text.toLowerCase().replace(/\s+/g, ' ')));
    const legalBlocks = uniqueTextBlocksWithSource(legalInfo)
      .filter((item) => !importantKeySet.has(item.text.toLowerCase().replace(/\s+/g, ' ')))
      .filter((item) => !disclaimerKeySet.has(item.text.toLowerCase().replace(/\s+/g, ' ')))
      .slice(0, 24);
    const legalKeySet = new Set(legalBlocks.map((item) => item.text.toLowerCase().replace(/\s+/g, ' ')));
    const referencesBlocks = uniqueTextBlocksWithSource(referenceInfo)
      .filter((item) => !importantKeySet.has(item.text.toLowerCase().replace(/\s+/g, ' ')))
      .filter((item) => !disclaimerKeySet.has(item.text.toLowerCase().replace(/\s+/g, ' ')))
      .filter((item) => !legalKeySet.has(item.text.toLowerCase().replace(/\s+/g, ' ')))
      .slice(0, 30);

    const pickLongestExactBlock = (items: Array<{ text: string; source_url: string }>) => {
      const blocks = uniqueTextBlocksWithSource(items);
      if (!blocks.length) return { text: '', source_url: seedUrl };
      return blocks.sort((a, b) => b.text.length - a.text.length)[0];
    };
    let indicationBlock = pickLongestExactBlock(indicationCandidates);
    const isiBlock = pickLongestExactBlock(isiCandidates.length ? isiCandidates : importantInformationBlocks);
    if (indicationBlock.text.length < 40) {
      const derived = deriveIndicationFromIsi(isiBlock.text);
      if (derived.length > 40) {
        indicationBlock = { text: derived, source_url: isiBlock.source_url || seedUrl };
      }
    }
    if (indicationBlock.text.length < 40) {
      const focusCandidate = mainFocus.length > 40 ? mainFocus : '';
      const headingCandidate =
        resolvedHeading.length > 30 && /\b(for|treatment|approved|indicated)\b/i.test(resolvedHeading)
          ? resolvedHeading
          : '';
      const fallbackText = focusCandidate || headingCandidate;
      if (fallbackText.length > 40) {
        indicationBlock = { text: fallbackText, source_url: seedUrl };
      }
    }

    const pickCta = (text: string) => {
      const match = text.match(/\b(get started|learn more|contact us|book now|request demo|download|buy now|sign up|try free)\b/i);
      return match?.[0] || adHeadlines[0] || 'Learn more';
    };
    const subheadingCandidate = dedupedValueCards[1]?.text || dedupedFeatureCards[0]?.text || mainFocus || '';
    const buildBriefTabSlides = (
      cards: Array<{ title?: string; text?: string; quote?: string; name?: string }>,
      images: any[],
      videos: any[],
      preferVideoGallery: boolean
    ) => {
      const slides = [];
      for (let i = 0; i < 3; i += 1) {
        const card = cards[i];
        const slideImage = images[i] || images[0] || null;
        if (!card && !slideImage) continue;
        const slideHeading = card?.title || (card?.text ? card.text.slice(0, 90) : card?.quote ? card.quote.slice(0, 90) : '');
        const slideBody = card?.text || card?.quote || '';
        if (!slideHeading && !slideBody && !slideImage) continue;
        const slideVideos = videos.slice(i * 2, i * 2 + 3);
        const useGallery = preferVideoGallery && slideVideos.length > 0;
        slides.push({
          layout: useGallery ? 'video-gallery' : 'image-text',
          heading: slideHeading || (slideImage?.alt || slideImage?.title || 'Supporting visual'),
          body: slideBody,
          cta: pickCta(slideBody || slideHeading || 'Learn more'),
          image: useGallery ? null : slideImage,
          media_assets: useGallery ? slideVideos : [],
        });
      }
      return slides;
    };
    const tabTwoCards = [
      ...dedupedFeatureCards.slice(0, 2),
      ...dedupedValueCards.slice(1, 2),
    ].slice(0, 3);
    const tabThreeCards = [
      ...dedupedFeatureCards.slice(2, 5),
      ...dedupedTestimonialCards.slice(0, 2),
      ...dedupedValueCards.slice(2, 4),
    ].slice(0, 3);
    const briefTabs = [
      {
        id: 1,
        label: 'Tab 1',
        layout: 'hero-video',
        heading: resolvedHeading || 'Campaign heading',
        subheading: subheadingCandidate ? subheadingCandidate.slice(0, 220) : undefined,
        cta: pickCta(`${resolvedHeading} ${mainFocus}`),
        hero_video: applyBriefAssetPreview(dedupedHeroVideos[0] || dedupedVideos[0] || null),
        hero_image: applyBriefAssetPreview(dedupedHeroImages[0] || null),
        slides: [],
      },
      {
        id: 2,
        label: 'Tab 2',
        layout: 'slides',
        slides: buildBriefTabSlides(
          tabTwoCards.length > 0 ? tabTwoCards : dedupedValueCards,
          dedupedGalleryAssets,
          dedupedVideos,
          dedupedVideos.length > 0
        ).map((slide) => ({
          ...slide,
          image: slide.image ? applyBriefAssetPreview(slide.image) : null,
          media_assets: (slide.media_assets || []).map((asset: any) => applyBriefAssetPreview(asset)),
        })),
      },
      {
        id: 3,
        label: 'Tab 3',
        layout: 'slides',
        slides: buildBriefTabSlides(
          tabThreeCards.length > 0 ? tabThreeCards : dedupedTestimonialCards,
          dedupedGalleryAssets.slice(3),
          dedupedVideos.slice(3),
          dedupedVideos.length > 2
        ).map((slide) => ({
          ...slide,
          image: slide.image ? applyBriefAssetPreview(slide.image) : null,
          media_assets: (slide.media_assets || []).map((asset: any) => applyBriefAssetPreview(asset)),
        })),
      },
    ];

    const responsePayload = {
      heading: resolvedHeading,
      hero_images: dedupedHeroImages,
      hero_videos: dedupedHeroVideos,
      main_focus: mainFocus,
      main_focus_cards: dedupedValueCards,
      features: dedupedFeatureCards.map(card => card.text).slice(0, 12),
      feature_cards: dedupedFeatureCards,
      testimonials: dedupedTestimonialCards.map(card => card.quote).slice(0, 10),
      testimonial_cards: dedupedTestimonialCards,
      gallery: dedupedGalleryAssets.map(asset => asset.url),
      gallery_assets: dedupedGalleryAssets,
      videos: dedupedVideos,
      important_information: importantInformationBlocks.map((item) => item.text),
      important_information_blocks: importantInformationBlocks,
      disclaimers: disclaimersBlocks.map((item) => item.text),
      disclaimers_blocks: disclaimersBlocks,
      legals: legalBlocks.map((item) => item.text),
      legal_blocks: legalBlocks,
      references: referencesBlocks.map((item) => item.text),
      reference_blocks: referencesBlocks,
      keywords,
      ad_headlines: adHeadlines,
      brief_tabs: briefTabs,
      indication: indicationBlock.text,
      indication_source_url: indicationBlock.source_url,
      important_safety_information: isiBlock.text,
      important_safety_information_source_url: isiBlock.source_url,
      crawled_pages: Array.from(visited),
    };

    res.json(responsePayload);
  } catch (error: any) {
    console.error('Insights extraction error:', error.message || error);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to extract insights from this site.' });
  } finally {
    await closePuppeteerBrowser(browser);
  }
});

// API Endpoint to download multiple files as ZIP
app.post('/api/download-zip', async (req, res) => {
  const { urls, items } = req.body;
  const list = items || urls;

  if (!list || !Array.isArray(list)) {
    return res.status(400).json({ error: 'Array of items or urls is required' });
  }

  try {
    const zipFailures: Array<{
      url: string;
      assetType: string;
      status: string;
      reason: string;
      toFormat?: string;
      filenameBase?: string;
    }> = [];
    const usedZipNames = new Set<string>();
    const uniqueZipFilename = (filename: string) => uniqueFilenameInSet(filename, usedZipNames);
    const zipImageStats = {
      selected: list.filter((item: any) => typeof item === 'object' && item?.assetType === 'image').length,
      cached: 0,
      skipped: 0,
    };
    console.debug('[image-zip:start]', {
      selectedCount: list.length,
      imageSelectedCount: zipImageStats.selected,
    });

    const zipCacheOnly = { cacheOnly: true as const };
    const zipPageUrl = readSourcePageUrl(req);
    const zipFontConvertTimeoutMs = 30000;
    const zipConvertTimeoutMs = 15000;
    const zipImageConvertTimeoutMs = 45000;
    const zipSkipBrowser = true;

    type ZipBuildResult =
      | { ok: true; entry: { name: string; buffer: Buffer } }
      | {
          ok: false;
          failure: {
            url: string;
            assetType: string;
            status: string;
            reason: string;
            toFormat?: string;
            filenameBase?: string;
          };
        };

    const buildZipEntry = async (item: any, index: number): Promise<ZipBuildResult> => {
      const rawUrl = typeof item === 'string' ? item : item.url;
      if (!rawUrl || typeof rawUrl !== 'string') {
        return { ok: false, failure: { url: String(rawUrl || ''), assetType: 'asset', status: 'failed-download', reason: 'missing url' } };
      }
      const manifestUrl = typeof item === 'object' && typeof item.originalUrl === 'string' && item.originalUrl
        ? item.originalUrl
        : rawUrl;
      const manifestType = typeof item === 'object' && typeof item.assetType === 'string'
        ? item.assetType
        : 'asset';
      const manifestStatus = typeof item === 'object' && typeof item.status === 'string' && item.status
        ? item.status
        : 'failed-download';
      const isFontConversion =
        typeof item === 'object' &&
        item.assetType === 'font' &&
        item.toFormat &&
        ['woff', 'woff2', 'ttf', 'otf', 'eot', 'svg'].includes(String(item.toFormat).toLowerCase());
      const isImageConversion = typeof item === 'object' && item.assetType === 'image';
      const isVideoAsset = typeof item === 'object' && item.assetType === 'video';

      try {
        if (rawUrl.startsWith('data:')) {
          const matches = rawUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            let buffer: Buffer = Buffer.from(matches[2], 'base64') as Buffer;
            let ext = matches[1].split('/')[1]?.split('+')[0] || 'bin';
            if (ext === 'jpeg') ext = 'jpg';
            if (ext === 'svg' || ext === 'svg+xml') {
              ext = 'svg';
              buffer = normalizeSvgBufferForIllustrator(buffer);
            }
            const filename = typeof item === 'object'
              ? deriveAssetFilename({
                  metadataFilename: typeof item.filename === 'string' ? item.filename : item.metadataFilename,
                  preferredBase: typeof item.filenameBase === 'string' ? item.filenameBase : undefined,
                  format: ext,
                  fallbackBase: `inline-image-${index + 1}`,
                })
              : `inline-image-${index + 1}.${ext}`;
            return { ok: true, entry: { name: filename, buffer } };
          }
          throw new Error('Invalid data URL');
        }

        if (isFontConversion) {
          const requestedCachePath = typeof item.cachedPath === 'string' ? item.cachedPath.trim() : '';
          const requestUrl = requestedCachePath || rawUrl;
          const url = assertAssetUrlAllowed(requestUrl);
          const cacheProbe =
            (await readAssetBufferFromCache(url, 'font')) ||
            (manifestUrl && manifestUrl !== requestUrl
              ? await readAssetBufferFromCache(manifestUrl, 'font')
              : null);
          const fontExtras = {
            originalUrl: manifestUrl,
            metadataFilename: typeof item.metadataFilename === 'string' ? item.metadataFilename : undefined,
            refererPageUrl:
              resolveFontRefererPage(
                typeof item.cssSource === 'string' ? item.cssSource : '',
                zipPageUrl || ''
              ) || undefined,
            cssSource: typeof item.cssSource === 'string' ? item.cssSource : undefined,
            fontFamily:
              typeof item.fontFamily === 'string'
                ? item.fontFamily
                : typeof item.familyFolder === 'string'
                  ? item.familyFolder
                  : undefined,
            fontWeight: typeof item.fontWeight === 'string' ? item.fontWeight : undefined,
            fontStyle: typeof item.fontStyle === 'string' ? item.fontStyle : undefined,
            preferInlineConversion: true,
            timeoutMs: 65000,
            fixVerticalMetrics: item.fixVerticalMetrics !== false,
          };
          const toFormat = normalizeFontFormat(String(item.toFormat || 'ttf'));
          const originalFormat = normalizeFontFormat(String(item.originalFormat || 'unknown'));
          const filenameBase = typeof item.filenameBase === 'string' ? item.filenameBase : 'font';
          const familyFolder = typeof item.familyFolder === 'string' ? item.familyFolder : filenameBase;
          const detectedCachedFormat = cacheProbe ? detectFontFormatFromBuffer(cacheProbe.buffer) : '';
          const zipName =
            typeof item.zipEntryName === 'string' && item.zipEntryName.trim()
              ? item.zipEntryName.trim()
              : buildFontZipEntryName(filenameBase, toFormat, familyFolder);
          if (
            cacheProbe?.buffer?.length &&
            (detectedCachedFormat === toFormat || (!detectedCachedFormat && originalFormat === toFormat))
          ) {
            return { ok: true, entry: { name: zipName, buffer: cacheProbe.buffer } };
          }
          const runFontZipConvert = (cacheOnly: boolean) =>
            convertFontAsset(
              url,
              toFormat,
              originalFormat,
              filenameBase,
              {
                ...fontExtras,
                ...(cacheProbe ? { prefetched: cacheProbe } : cacheOnly ? zipCacheOnly : {}),
              }
            );
          let converted;
          try {
            converted = await runFontZipConvert(!cacheProbe);
          } catch (cacheError: any) {
            const reason = String(cacheError?.message || cacheError || '');
            if (!cacheProbe && /not cached|valid font|decode|conversion|timeout|fetch/i.test(reason)) {
              try {
                converted = await runFontZipConvert(false);
              } catch (retryError: any) {
                if (toFormat === 'ttf') throw retryError;
                const fallbackFormat = detectedCachedFormat || originalFormat || getFontFormatFromUrlOrType(url);
                if (!fallbackFormat || fallbackFormat === toFormat) throw retryError;
                converted = await convertFontAsset(
                  url,
                  fallbackFormat,
                  originalFormat,
                  filenameBase,
                  {
                    ...fontExtras,
                    ...(cacheProbe ? { prefetched: cacheProbe } : {}),
                  }
                );
              }
            } else {
              if (toFormat === 'ttf') throw cacheError;
              const fallbackFormat = detectedCachedFormat || originalFormat || getFontFormatFromUrlOrType(url);
              if (!fallbackFormat || fallbackFormat === toFormat) throw cacheError;
              converted = await convertFontAsset(
                url,
                fallbackFormat,
                originalFormat,
                filenameBase,
                {
                  ...fontExtras,
                  ...(cacheProbe ? { prefetched: cacheProbe } : {}),
                }
              );
            }
          }
          if (!converted.buffer?.length) {
            throw new Error(`Font file is empty (${converted?.format || toFormat})`);
          }
          if (toFormat === 'ttf' && detectFontFormatFromBuffer(converted.buffer) !== 'ttf') {
            throw new Error('TTF conversion produced a non-TTF font file.');
          }
          const entryName =
            converted.format && converted.format !== toFormat
              ? buildFontZipEntryName(filenameBase, converted.format, familyFolder)
              : zipName;
          return { ok: true, entry: { name: entryName, buffer: converted.buffer } };
        }

        if (isImageConversion) {
          const requestedCachePath = typeof item.cachedPath === 'string' ? item.cachedPath.trim() : '';
          const requestUrl = requestedCachePath || rawUrl;
          const url = assertAssetUrlAllowed(requestUrl);
          let cacheProbe =
            (await readAssetBufferFromCache(url, 'image')) ||
            (manifestUrl && manifestUrl !== requestUrl
              ? await readAssetBufferFromCache(manifestUrl, 'image')
              : null);
          if (!cacheProbe && !String(url || '').startsWith('data:')) {
            const ensured = await withTimeout(
              ensureImageCachedForDownload(url, manifestUrl || url, zipPageUrl),
              45000,
              `ZIP image cache fetch for ${manifestUrl || url}`
            ).catch(() => null);
            cacheProbe = ensured?.cached || null;
          }
          if (cacheProbe) zipImageStats.cached += 1;
          console.debug('[image-zip:item]', {
            id: typeof item.id === 'string' ? item.id : undefined,
            url: manifestUrl,
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : cacheProbe?.contentType || '',
            cachePath: requestedCachePath || (await getAssetCacheDebugPath(url, 'image')),
            cache: cacheProbe ? 'hit' : 'miss',
          });
          if (item?.preserveOriginal === true || String(item?.preserveOriginal || '').toLowerCase() === 'true') {
            if (!cacheProbe || !isValidImageBuffer(cacheProbe.buffer, cacheProbe.contentType)) {
              throw new Error(`Downloaded asset is not a valid image: ${manifestUrl || url}`);
            }
            let sourceFormat = normalizeRasterFormat(
              detectImageFormatFromBuffer(cacheProbe.buffer) ||
                inferImageTypeFromContentType(cacheProbe.contentType) ||
                inferImageTypeFromUrl(manifestUrl || url, cacheProbe.contentType) ||
                getAssetTypeFromUrl(manifestUrl || url, 'bin')
            );
            const preferredZipName = typeof item.zipEntryName === 'string' ? item.zipEntryName.trim() : '';
            const requestedZipFormat = normalizeRasterFormat(
              preferredZipName.match(/\.([a-z0-9]+)$/i)?.[1] ||
                String(item.filename || item.metadataFilename || '').match(/\.([a-z0-9]+)$/i)?.[1] ||
                ''
            );
            let entryBuffer = sourceFormat === 'svg'
              ? normalizeSvgBufferForIllustrator(cacheProbe.buffer)
              : cacheProbe.buffer;
            if (['png', 'jpg'].includes(requestedZipFormat) && sourceFormat !== requestedZipFormat) {
              const converted = await withTimeout(
                getCachedConvertedImage(url, requestedZipFormat, {
                  prefetched: {
                    buffer: cacheProbe.buffer,
                    contentType: cacheProbe.contentType || guessContentTypeFromPath(String(item.cachedPath || url)) || 'application/octet-stream',
                  },
                  filenameBase: typeof item.filenameBase === 'string' ? item.filenameBase : undefined,
                  originalUrl: manifestUrl,
                  metadataFilename: typeof item.metadataFilename === 'string' ? item.metadataFilename : undefined,
                  refererPageUrl: zipPageUrl || undefined,
                  skipBrowser: zipSkipBrowser,
                }),
                zipImageConvertTimeoutMs,
                `ZIP image preserve conversion for ${manifestUrl || url}`
              );
              entryBuffer = converted.buffer;
              sourceFormat = normalizeRasterFormat(converted.format || requestedZipFormat);
            }
            const fallbackName = buildDownloadFilename(
              manifestUrl || url,
              sourceFormat,
              typeof item.filenameBase === 'string' ? item.filenameBase : undefined,
              {
                metadataFilename: typeof item.metadataFilename === 'string' ? item.metadataFilename : undefined,
                contentDisposition: (cacheProbe as any).contentDisposition,
              }
            );
            const entryName = preferredZipName
              ? reconcileZipEntryNameWithBuffer(preferredZipName, entryBuffer)
              : reconcileImageFilenameWithBuffer(fallbackName, entryBuffer, cacheProbe.contentType);
            return { ok: true, entry: { name: entryName, buffer: entryBuffer } };
          }
          const zipTargetFormat = normalizeRasterFormat(
            typeof item.selectedFormat === 'string'
              ? item.selectedFormat
              : typeof item.toFormat === 'string'
                ? item.toFormat
                : ''
          );
          const needsRasterConvert = ['png', 'jpg'].includes(zipTargetFormat);
          const imageZipExtras = {
            filenameBase: typeof item.filenameBase === 'string' ? item.filenameBase : undefined,
            originalUrl: manifestUrl,
            metadataFilename: typeof item.metadataFilename === 'string' ? item.metadataFilename : undefined,
            refererPageUrl: zipPageUrl || undefined,
            skipBrowser: zipSkipBrowser,
          };
          const runImageZipConvert = (cacheOnly: boolean) =>
            withTimeout(
              getCachedConvertedImage(url, needsRasterConvert ? zipTargetFormat : undefined, {
                ...imageZipExtras,
                ...(cacheProbe
                  ? {
                      prefetched: {
                        buffer: cacheProbe.buffer,
                        contentType:
                          cacheProbe.contentType ||
                          guessContentTypeFromPath(String(item.cachedPath || url)) ||
                          'application/octet-stream',
                      },
                    }
                  : cacheOnly
                    ? zipCacheOnly
                    : {}),
              }),
              needsRasterConvert ? zipImageConvertTimeoutMs : zipConvertTimeoutMs,
              `ZIP image conversion for ${url}`
            );
          let converted;
          try {
            converted = await runImageZipConvert(false);
          } catch (cacheError: any) {
            const reason = String(cacheError?.message || cacheError || '');
            if (!cacheProbe && /not cached|valid image|conversion|timeout|fetch/i.test(reason)) {
              converted = await runImageZipConvert(true);
            } else {
              throw cacheError;
            }
          }
          if (needsRasterConvert) {
            const expected = zipTargetFormat as RasterOutputFormat;
            if (!isValidRasterOutputBuffer(converted.buffer, expected)) {
              throw new Error(`ZIP entry is not valid ${expected.toUpperCase()} binary`);
            }
            if (converted.filename.toLowerCase().endsWith('.webp') || converted.filename.toLowerCase().endsWith('.avif')) {
              throw new Error('ZIP entry must not use WEBP/AVIF extension when PNG/JPG conversion was requested');
            }
          }
          const entryBuffer = detectImageFormatFromBuffer(converted.buffer) === 'svg'
            ? normalizeSvgBufferForIllustrator(converted.buffer)
            : converted.buffer;
          const preferredZipName = typeof item.zipEntryName === 'string' ? item.zipEntryName.trim() : '';
          const entryName = preferredZipName
            ? reconcileZipEntryNameWithBuffer(preferredZipName, entryBuffer)
            : reconcileImageFilenameWithBuffer(converted.filename, entryBuffer);
          return { ok: true, entry: { name: entryName, buffer: entryBuffer } };
        }

        if (isVideoAsset) {
          return {
            ok: false,
            failure: {
              url: manifestUrl,
              assetType: manifestType,
              status: manifestStatus,
              reason: 'Video files must be downloaded directly (FHD.mp4 / HD.mp4), not as ZIP.',
            },
          };
        }

        const url = assertAssetUrlAllowed(rawUrl);
        const looksLikeVideo =
          isLikelyDirectVideoStreamUrl(url) ||
          isLikelyVideoAssetUrl(url) ||
          /\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|$)/i.test(url);
        const looksLikeFont = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url);

        if (looksLikeVideo) {
          return {
            ok: false,
            failure: {
              url: manifestUrl,
              assetType: 'video',
              status: 'failed-download',
              reason: 'Video streams must be downloaded directly (FHD.mp4 / HD.mp4), not as ZIP.',
            },
          };
        }

        if (looksLikeFont) {
          const sourceFormat = getFontFormatFromUrlOrType(url);
          const filenameBase = typeof item?.filenameBase === 'string' ? item.filenameBase : 'font';
          const familyFolder = typeof item?.familyFolder === 'string' ? item.familyFolder : filenameBase;
          if (item?.preserveOriginal === true || String(item?.preserveOriginal || '').toLowerCase() === 'true') {
            const fetched = await fetchRemoteFontBuffer(url, zipPageUrl || '');
            const detectedFormat = detectFontFormatFromBuffer(fetched.buffer) || sourceFormat || 'font';
            const metadataFilename = typeof item?.metadataFilename === 'string' ? item.metadataFilename : undefined;
            const preferredZipName = typeof item?.zipEntryName === 'string' ? item.zipEntryName.trim() : '';
            const fallbackName = buildDownloadFilename(manifestUrl || url, detectedFormat, filenameBase, {
              metadataFilename,
              contentDisposition: (fetched as any).contentDisposition,
            });
            return {
              ok: true,
              entry: {
                name: preferredZipName || fallbackName,
                buffer: fetched.buffer,
              },
            };
          }
          const runFontZipFetch = (cacheOnly: boolean) =>
            convertFontAsset(url, 'ttf', sourceFormat, filenameBase, {
              originalUrl: manifestUrl,
              preferInlineConversion: true,
              timeoutMs: 65000,
              ...(cacheOnly ? zipCacheOnly : {}),
            });
          let converted;
          try {
            converted = await runFontZipFetch(true);
          } catch (cacheError: any) {
            const reason = String(cacheError?.message || cacheError || '');
            if (/not cached|valid font|conversion|timeout|fetch/i.test(reason)) {
              converted = await runFontZipFetch(false);
            } else {
              throw cacheError;
            }
          }
          if (!converted.buffer?.length) {
            throw new Error('Converted font is empty (ttf)');
          }
          return {
            ok: true,
            entry: {
              name: buildFontZipEntryName(filenameBase, converted.format || 'ttf', familyFolder),
              buffer: converted.buffer,
            },
          };
        }

        const runGenericImageZipFetch = (cacheOnly: boolean) =>
          withTimeout(
            getCachedConvertedImage(url, undefined, {
              originalUrl: manifestUrl,
              refererPageUrl: zipPageUrl || undefined,
              skipBrowser: zipSkipBrowser,
              ...(cacheOnly ? zipCacheOnly : {}),
            }),
            zipConvertTimeoutMs,
            `ZIP image conversion for ${url}`
          );
        let converted;
        try {
          converted = await runGenericImageZipFetch(true);
        } catch (cacheError: any) {
          const reason = String(cacheError?.message || cacheError || '');
          if (/not cached|valid image|conversion|timeout|fetch/i.test(reason)) {
            converted = await runGenericImageZipFetch(false);
          } else {
            throw cacheError;
          }
        }
        const entryBuffer = detectImageFormatFromBuffer(converted.buffer) === 'svg'
          ? normalizeSvgBufferForIllustrator(converted.buffer)
          : converted.buffer;
        const preferredZipName = typeof item?.zipEntryName === 'string' ? item.zipEntryName.trim() : '';
        const entryName = preferredZipName
          ? reconcileZipEntryNameWithBuffer(preferredZipName, entryBuffer)
          : reconcileImageFilenameWithBuffer(converted.filename, entryBuffer);
        return { ok: true, entry: { name: entryName, buffer: entryBuffer } };
      } catch (e: any) {
        console.error(`Failed to add ${rawUrl} to zip:`, e.message || e);
        if (isImageConversion) zipImageStats.skipped += 1;
        const failure: {
          url: string;
          assetType: string;
          status: string;
          reason: string;
          toFormat?: string;
          filenameBase?: string;
        } = {
          url: manifestUrl,
          assetType: manifestType,
          status: manifestStatus,
          reason: String(e?.message || e || 'download failed'),
        };
        if (typeof item === 'object') {
          if (typeof item.toFormat === 'string') failure.toFormat = item.toFormat;
          if (typeof item.filenameBase === 'string') failure.filenameBase = item.filenameBase;
        }
        return { ok: false, failure };
      }
    };

    const zipConcurrency =
      list.length > 24 ? 6 : list.length > 12 ? 8 : Math.min(12, Math.max(4, list.length));
    const zipBudgetMs = Math.min(300000, 30000 + list.length * 8000);
    const buildResults = await withTimeout(
      mapWithConcurrency(list, zipConcurrency, (item, index) => buildZipEntry(item, index)),
      zipBudgetMs,
      'ZIP asset build'
    );

    const zipEntries: Array<{ name: string; buffer: Buffer }> = [];
    for (const result of buildResults) {
      if (!result) continue;
      if (result.ok) {
        const entryName = result.entry.name.includes('/')
          ? uniqueZipPathInSet(result.entry.name, usedZipNames)
          : uniqueZipFilename(result.entry.name);
        if (!result.entry.buffer?.length) continue;
        zipEntries.push({ name: entryName, buffer: result.entry.buffer });
      } else {
        const failure = (result as Extract<ZipBuildResult, { ok: false }>).failure;
        zipFailures.push(failure);
        if (failure.assetType === 'font' && failure.toFormat) {
          const base = (failure.filenameBase || 'font').replace(/\.[^/.]+$/, '');
          const note = [
            `Font conversion to ${String(failure.toFormat).toUpperCase()} failed.`,
            `Font: ${base}`,
            `URL: ${failure.url}`,
            `Reason: ${failure.reason}`,
            'The original font file may still be present in this ZIP under its source extension (WOFF2/TTF/WOFF).',
            '',
          ].join('\n');
          zipEntries.push({
            name: uniqueZipFilename(`${base}.${failure.toFormat}.conversion-failed.txt`),
            buffer: Buffer.from(note, 'utf8'),
          });
        }
      }
    }
    console.debug('[image-zip:summary]', {
      selectedCount: zipImageStats.selected,
      cachedCount: zipImageStats.cached,
      skippedCount: zipImageStats.skipped,
    });

    if (zipFailures.length > 0) {
      const manifest = [
        'Some assets were not in the extraction cache.',
        'Re-extract the page to fetch them once, then download the ZIP again.',
        '',
        ...zipFailures.map((failure, index) => [
          `${index + 1}. ${failure.url}`,
          `   type: ${failure.assetType}`,
          failure.toFormat ? `   requested format: ${failure.toFormat}` : '',
          failure.filenameBase ? `   filename base: ${failure.filenameBase}` : '',
          `   status: ${failure.status}`,
          `   reason: ${failure.reason}`,
        ].filter(Boolean).join('\n')),
        '',
      ].join('\n');
      zipEntries.push({
        name: uniqueZipFilename('asset-paths.txt'),
        buffer: Buffer.from(manifest, 'utf8'),
      });
      const fontFailures = zipFailures.filter((failure) => failure.assetType === 'font');
      if (fontFailures.length > 0) {
        const fontReport = [
          'Font conversion failures',
          'Each failed target format has a matching *.conversion-failed.txt note in this ZIP.',
          '',
          ...fontFailures.map((failure, index) => [
            `${index + 1}. ${failure.filenameBase || failure.url}`,
            `   target: ${failure.toFormat || 'unknown'}`,
            `   url: ${failure.url}`,
            `   reason: ${failure.reason}`,
          ].join('\n')),
          '',
        ].join('\n');
        zipEntries.push({
          name: uniqueZipFilename('font-conversion-report.txt'),
          buffer: Buffer.from(fontReport, 'utf8'),
        });
      }
    }

    if (zipEntries.length === 0) {
      return res.status(400).json({
        error: 'No cached assets available for ZIP. Extract the page first so assets are saved locally, then download again.',
      });
    }

    const archive = archiver('zip', { zlib: { level: 0 } });
    const addedCount = zipEntries.filter((entry) => entry.name !== 'asset-paths.txt').length;

    for (const entry of zipEntries) {
      archive.append(entry.buffer, { name: entry.name });
    }

    if (req.body?.save === true || String(req.body?.save || '').toLowerCase() === 'true') {
      const requestedFilename = typeof req.body?.filename === 'string' && req.body.filename.trim()
        ? req.body.filename.trim()
        : 'assets.zip';
      const requestedRootFolderName = typeof req.body?.rootFolderName === 'string'
        ? req.body.rootFolderName.trim()
        : '';
      const rootFolderName = /^(?:asset|assets|image|images|font|fonts|video|videos)$/i.test(
        sanitizeFilenameBase(requestedRootFolderName)
      )
        ? ''
        : requestedRootFolderName;
      archive.on('error', (err: Error) => {
        console.error('ZIP stream error:', err.message || err);
      });
      const target = await uniqueDownloadFilePath(requestedFilename, {
        sourcePageUrl: rootFolderName ? '' : readSourcePageUrl(req),
        kind: 'zip',
        rootFolderName,
      });
      const writeStream = fs.createWriteStream(target.filePath);
      const streamDone = new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      archive.pipe(writeStream);
      await archive.finalize();
      await streamDone;
      const stat = await validateSavedAssetFile(target.filePath, 'Assets ZIP');
      res.setHeader('X-Zip-Added-Count', String(addedCount));
      res.setHeader('X-Zip-Failed-Count', String(zipFailures.length));
      return res.json({
        ok: true,
        filename: target.filename,
        downloadPath: target.filePath,
        localPath: target.filePath,
        folderPath: target.folderPath,
        size: stat.size,
        addedCount,
        failedCount: zipFailures.length,
      });
    }

    archive.on('error', (err: Error) => {
      console.error('ZIP stream error:', err.message || err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create ZIP file' });
      } else {
        res.destroy();
      }
    });
    res.setHeader('Content-Disposition', 'attachment; filename="assets.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Zip-Cache-Only', '1');
    res.setHeader('X-Zip-Added-Count', String(addedCount));
    res.setHeader('X-Zip-Failed-Count', String(zipFailures.length));
    archive.pipe(res);
    await archive.finalize();
  } catch (error: any) {
    console.error('ZIP error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP file' });
    }
  }
});

export async function startServer() {
  await ensureRuntimeToolsReady();
  activePort = await findAvailablePort(DEFAULT_PORT);
  if (activePort !== DEFAULT_PORT) {
    console.log(`Using another available local port: ${activePort}`);
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.VITE_HMR_DISABLED === '1' || process.env.DISABLE_HMR === 'true';
    const hmrPort = hmrDisabled
      ? -1
      : await findAvailablePort(Number(process.env.VITE_HMR_PORT || 24678), 60).catch(() => {
          console.warn('Could not find free HMR port — hot reload will be unavailable');
          return -1;
        });
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrPort > 0 ? { port: hmrPort } : false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(getAppRoot(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(activePort, '127.0.0.1', () => {
    console.log(`Server running on http://localhost:${activePort}`);
  });
  setupExtractProgressWS(server);
  return { server, port: activePort, url: `http://localhost:${activePort}` };
}

if (process.env.VDX_SKIP_AUTOSTART !== '1') {
  startServer().catch((error: any) => {
    const message = /EADDRINUSE|address already in use/i.test(String(error?.message || ''))
      ? 'Using another available local port...'
      : 'Startup repair did not finish. Please run npm install once, then try again.';
    console.error(message);
    console.error(error?.message || error);
    process.exit(1);
  });
}
