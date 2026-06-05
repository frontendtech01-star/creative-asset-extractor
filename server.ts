import express from 'express';
import path from 'path';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import * as cheerio from 'cheerio';
import archiver from 'archiver';
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
import { execFile } from 'child_process';
import { Worker } from 'worker_threads';
import { promisify } from 'util';
import { createRequire } from 'module';
import { isExpiredStreamUrl, isLikelyHttpMediaUrl, recoverYouTubeWatchFromMergeQuery, sanitizeStreamUrl } from './src/lib/streamUrl';
import {
  convertRasterImageBuffer,
  detectRasterFormatFromBuffer,
  isValidRasterOutputBuffer,
  supportedRasterConversionTargets,
  type RasterOutputFormat,
} from './src/lib/convertRasterImage';
import {
  buildFontDisplayName,
  buildFontZipEntryName,
  dedupeFontsByLogicalKey,
  getFontConversionOutputs,
  pickBestFontForUrl,
} from './src/lib/fontAsset';
import {
  CREATIVE_ASSET_SUBFOLDERS,
  ensureCreativeAssetsFolders,
  resolveCreativeAssetsDir,
  resolveCreativeAssetsRoot,
  type CreativeAssetSubfolder,
} from './src/lib/projectDownloadsPaths';

const require = createRequire(import.meta.url);
const getAppRoot = () => process.env.VDX_APP_ROOT || process.cwd();
const insightsPageEvaluate = require(path.join(getAppRoot(), 'scripts', 'insights-page-evaluate.cjs')) as (
  pageUrl: string,
  keywordList: string[]
) => Record<string, unknown>;

const youtubedl = youtubedlModule as unknown as (...args: any[]) => Promise<any>;
const execFileAsync = promisify(execFile);

const getResourcesPath = () => process.env.VDX_RESOURCES_PATH || getAppRoot();

const getUnpackedModulePath = (...segments: string[]) => {
  const resources = process.env.VDX_RESOURCES_PATH;
  if (resources) {
    const unpacked = path.join(resources, 'app.asar.unpacked', ...segments);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(getAppRoot(), ...segments);
};

const resolveYtDlpPath = () => {
  const constantPath = (youtubedlModule as any)?.constants?.YOUTUBE_DL_PATH;
  if (constantPath && fs.existsSync(String(constantPath))) return String(constantPath);
  const candidates = [
    getUnpackedModulePath('node_modules', 'youtube-dl-exec', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    path.join(getAppRoot(), 'node_modules', 'youtube-dl-exec', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1];
};

const findBundledChromiumExecutable = () => {
  const chromeCacheRoot = path.join(getResourcesPath(), 'chromium', 'chrome');
  if (!fs.existsSync(chromeCacheRoot)) return '';
  const platformPrefix = process.arch === 'arm64' ? 'mac_arm-' : 'mac-';
  const bundleDir = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
  try {
    const versionDir = fs.readdirSync(chromeCacheRoot).find((name) => name.startsWith(platformPrefix));
    if (!versionDir) return '';
    const executable = path.join(
      chromeCacheRoot,
      versionDir,
      bundleDir,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
    return fs.existsSync(executable) ? executable : '';
  } catch {
    return '';
  }
};

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(String(ffmpegPath));
}

let aria2Path = '';
try {
  const localToolsPath = path.join(getAppRoot(), '.local-tools.json');
  const localTools = JSON.parse(fs.readFileSync(localToolsPath, 'utf8'));
  aria2Path = String(localTools?.aria2Path || '');
} catch {
  const bundledAria2 = path.join(getResourcesPath(), 'vendor', 'aria2', 'aria2c');
  if (fs.existsSync(bundledAria2)) aria2Path = bundledAria2;
}

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

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || 3000);
let activePort = DEFAULT_PORT;
const convertedVideoDir = path.join(os.tmpdir(), 'creative-asset-extractor-mp4');
const convertedAudioDir = path.join(os.tmpdir(), 'creative-asset-extractor-audio');
const generatedThumbnailDir = path.join(os.tmpdir(), 'creative-asset-extractor-thumbnails');
const cachedImageDir = path.join(os.tmpdir(), 'creative-asset-extractor-images');
const cachedFontDir = path.join(os.tmpdir(), 'creative-asset-extractor-fonts');
const cachedImageOriginalDir = path.join(os.tmpdir(), 'creative-asset-extractor-images-original');
const cachedFontOriginalDir = path.join(os.tmpdir(), 'creative-asset-extractor-fonts-original');
const downloadsDir = path.join(os.homedir(), 'Downloads');
let lastExtractedSourceUrl = '';

const readSourcePageUrl = (req?: express.Request, explicit?: string) => {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  if (!req) return lastExtractedSourceUrl;
  const fromQuery = typeof req.query?.sourcePageUrl === 'string' ? req.query.sourcePageUrl.trim() : '';
  const fromBody = typeof req.body?.sourcePageUrl === 'string' ? req.body.sourcePageUrl.trim() : '';
  return fromQuery || fromBody || lastExtractedSourceUrl;
};

type DownloadSaveKind = 'font' | 'image' | 'video' | 'audio' | 'brief' | 'isi' | 'zip' | 'default';

const resolveDownloadSaveDir = (kind: DownloadSaveKind = 'default', sourcePageUrl?: string) => {
  const pageUrl = String(sourcePageUrl || lastExtractedSourceUrl || '').trim();
  if (kind === 'font') return resolveCreativeAssetsDir(pageUrl, 'Fonts');
  if (kind === 'image') return resolveCreativeAssetsDir(pageUrl, 'Images');
  if (kind === 'video') return resolveCreativeAssetsDir(pageUrl, 'Videos');
  if (kind === 'audio') return resolveCreativeAssetsDir(pageUrl, 'Audio');
  if (kind === 'brief') return resolveCreativeAssetsDir(pageUrl, 'Brief');
  if (kind === 'isi') return resolveCreativeAssetsDir(pageUrl, 'ISI');
  if (kind === 'zip') return resolveCreativeAssetsDir(pageUrl, 'Images');
  return resolveCreativeAssetsRoot(pageUrl);
};

const resolveDownloadsTargetDir = (sourcePageUrl?: string) =>
  resolveCreativeAssetsRoot(String(sourcePageUrl || lastExtractedSourceUrl || '').trim());

const assertPathInsideDownloads = (filePath: string) => {
  const resolved = path.resolve(filePath);
  const root = path.resolve(downloadsDir);
  if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  throw new Error('Download path resolved outside Downloads.');
};
const appDataDir = path.join(os.homedir(), '.creative-asset-extractor');
const feedbackInboxPath = path.join(appDataDir, 'feedback', 'inbox.jsonl');
const feedbackConfigPath = path.join(appDataDir, 'feedback-config.json');
const relaxedHttpsAgent = new https.Agent({ rejectUnauthorized: false });

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

type FeedbackFormConfig = {
  actionUrl: string;
  nameEntryId: string;
  suggestionsEntryId: string;
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
  if (!actionUrl || !nameEntryId || !suggestionsEntryId) return null;
  return { actionUrl, nameEntryId, suggestionsEntryId };
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

const appendLocalFeedbackInbox = async (name: string, suggestions: string) => {
  await fsp.mkdir(path.dirname(feedbackInboxPath), { recursive: true });
  const entry = {
    name,
    suggestions,
    submittedAt: new Date().toISOString(),
    destination: 'frontendtech01@gmail.com',
  };
  await fsp.appendFile(feedbackInboxPath, `${JSON.stringify(entry)}\n`, 'utf8');
};

const submitFeedbackToGoogleForm = async (config: FeedbackFormConfig, name: string, suggestions: string) => {
  const body = new URLSearchParams();
  body.set(config.nameEntryId, name);
  body.set(config.suggestionsEntryId, suggestions);
  await axios.post(config.actionUrl, body.toString(), {
    timeout: 12000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  });
};

const submitFeedbackToGoogleSheet = async (
  config: FeedbackSheetConfig,
  payload: { name: string; suggestions: string; submittedAt: string; appVersion: string }
) => {
  const response = await axios.post(config.webhookUrl, payload, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const data = response.data;
  if (data && typeof data === 'object' && data.ok === false) {
    throw new Error(String(data.error || 'Google Sheet feedback webhook rejected the submission.'));
  }
};

const submitFeedbackRemote = async (
  target: FeedbackRemoteTarget,
  payload: { name: string; suggestions: string; submittedAt: string; appVersion: string }
) => {
  if (target.mode === 'sheet') {
    await submitFeedbackToGoogleSheet(target.config, payload);
    return 'sheet' as const;
  }
  await submitFeedbackToGoogleForm(target.config, payload.name, payload.suggestions);
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

const getCurrentUserName = () => {
  try {
    return os.userInfo().username || 'user';
  } catch {
    return 'user';
  }
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
app.use(express.json({ limit: '1mb' }));
app.use('/converted-videos', localOnlyGuard, express.static(convertedVideoDir, privateStaticOptions));
app.use('/converted-audio', localOnlyGuard, express.static(convertedAudioDir, privateStaticOptions));
app.use('/generated-thumbnails', localOnlyGuard, express.static(generatedThumbnailDir, privateStaticOptions));
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

app.get('/api/feedback/status', async (_req, res) => {
  const target = await resolveFeedbackTarget();
  const sheet = await resolveFeedbackSheetConfig();
  const googleForm = await resolveFeedbackFormConfig();
  res.json({
    ready: true,
    mode: target?.mode || 'local',
    contactEmail: 'frontendtech01@gmail.com',
    googleSheetConfigured: Boolean(sheet),
    googleFormConfigured: Boolean(googleForm),
    sheetId: sheet?.sheetId || DEFAULT_FEEDBACK_SHEET_ID,
    localInboxPath: feedbackInboxPath,
  });
});

app.post('/api/feedback', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const suggestions = String(req.body?.suggestions || '').trim();
  if (!name || !suggestions) {
    return res.status(400).json({ error: 'Name and suggestions are required.' });
  }

  let appVersion = '1.0.0';
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(getAppRoot(), 'package.json'), 'utf8'));
    appVersion = String(pkg?.version || appVersion);
  } catch {
    // package.json may be unavailable in some packaged layouts.
  }

  const payload = {
    name,
    suggestions,
    submittedAt: new Date().toISOString(),
    appVersion,
  };

  try {
    const target = await resolveFeedbackTarget();
    if (target) {
      const mode = await submitFeedbackRemote(target, payload);
      return res.json({
        ok: true,
        mode,
        message: 'Thanks! Your feedback has been submitted.',
      });
    }

    await appendLocalFeedbackInbox(name, suggestions);
    return res.json({
      ok: true,
      mode: 'local',
      message: 'Thanks! Your feedback has been submitted.',
      inboxPath: feedbackInboxPath,
    });
  } catch (error: any) {
    console.error('Feedback submit failed:', error?.message || error);
    try {
      await appendLocalFeedbackInbox(name, suggestions);
      return res.json({
        ok: true,
        mode: 'local',
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

const resolvePackageMeta = async () => {
  const candidates = [
    path.join(process.cwd(), 'package.json'),
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

const resolveGithubRepoConfig = () => {
  const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
  if (repository.includes('/')) {
    const [owner, repo] = repository.split('/');
    return { githubOwner: owner, githubRepo: repo };
  }
  return {
    githubOwner: String(process.env.GITHUB_OWNER || process.env.VITE_GITHUB_OWNER || '').trim(),
    githubRepo: String(process.env.GITHUB_REPO || process.env.VITE_GITHUB_REPO || '').trim(),
  };
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
    const data = response.data || {};
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const dmgAsset = assets.find((asset: any) => /\.dmg$/i.test(String(asset?.name || '')));
    const exeAsset = assets.find((asset: any) => /\.exe$/i.test(String(asset?.name || '')));
    return res.json({
      available: true,
      release: {
        tagName: String(data.tag_name || ''),
        name: String(data.name || data.tag_name || 'Latest release'),
        body: String(data.body || ''),
        htmlUrl: String(data.html_url || ''),
        dmgDownloadUrl: String(dmgAsset?.browser_download_url || ''),
        exeDownloadUrl: String(exeAsset?.browser_download_url || ''),
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

app.get('/api/system-check', async (_req, res) => {
  const ytdlpPath = resolveYtDlpPath();
  const ffmpegReady = Boolean(ffmpegPath && await fileExists(String(ffmpegPath)));
  const ytdlpReady = await fileExists(String(ytdlpPath));
  const downloadsReady = await fsp.mkdir(downloadsDir, { recursive: true }).then(() => true).catch(() => false);
  const appDataReady = await fsp.mkdir(appDataDir, { recursive: true }).then(() => true).catch(() => false);

  res.json({
    ok: ffmpegReady && ytdlpReady && downloadsReady && appDataReady,
    platform: process.platform,
    arch: process.arch,
    userName: getCurrentUserName(),
    downloadsDir,
    appDataDir,
    tools: {
      ffmpeg: { ready: ffmpegReady, path: ffmpegPath ? String(ffmpegPath) : '' },
      ytdlp: { ready: ytdlpReady, path: String(ytdlpPath || '') },
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
    url.hash = ''; // Strip hash to prevent 404s on some servers
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

const scoreSiteHtml = (html: string, status: number) => {
  const text = String(html || '');
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
  if (text.length < 2048) return true;
  if (/\/wp-content\/uploads/i.test(text) && text.length > 8000) return false;
  if (text.length < 90000 && !/\/wp-content\/uploads|<img\b|background-image\s*:\s*url/i.test(text)) return true;
  const rasterHints = (text.match(/\.(?:png|jpe?g|webp|gif|avif)(?:[^\w]|$)/gi) || []).length;
  const svgCount = (text.match(/<svg\b/gi) || []).length;
  return rasterHints < 2 && svgCount > 0 && text.length < 120000;
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

const pageHtmlLooksBlocked = (html: string) =>
  /robot-suspicion|challenge-platform|captcha-delivery|cf-challenge|access denied|just a moment|checking your browser/i.test(
    String(html || '')
  );

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

const launchFreshPuppeteerBrowser = async () => {
  const executablePath = resolvePuppeteerExecutablePath();
  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: PUPPETEER_BROWSER_ARGS,
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

const launchPuppeteerBrowser = async () => acquireSharedPuppeteerBrowser();

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
  if (!recoveryHtml || scoreSiteHtml(recoveryHtml, 200) < 20) return assets;
  return extractStaticAssets(targetUrl, recoveryHtml, { fast: false });
};

const fetchSiteHtmlViaCurl = async (siteUrl: string) => {
  let best = { html: '', score: -1 };
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['-sL', '--max-time', '8', '-A', userAgent, '-H', 'Accept: text/html,application/xhtml+xml', siteUrl],
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

const fetchSiteHtmlViaBrowser = async (siteUrl: string) => {
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  let page: Awaited<ReturnType<Awaited<ReturnType<typeof launchPuppeteerBrowser>>['newPage']>> | null = null;
  try {
    browser = await launchPuppeteerBrowser();
    page = await browser.newPage();
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

const extractFontsFromCss = (cssText: string, baseUrl: string) => {
  const fonts: any[] = [];
  const fontFaceRegex = /@font-face\s*\{([^}]+)\}/g;
  let match;

  while ((match = fontFaceRegex.exec(cssText)) !== null) {
    const block = match[1];
    const fontFamilyMatch = block.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/);
    const srcMatch = block.match(/src\s*:\s*([^;]+)/);

    if (fontFamilyMatch && srcMatch) {
      const fontFamily = fontFamilyMatch[1].trim();
      const fontWeightMatch = block.match(/font-weight\s*:\s*([^;]+)/i);
      const fontStyleMatch = block.match(/font-style\s*:\s*([^;]+)/i);
      const candidates: any[] = [];
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
          status: DEFAULT_ASSET_STATUS,
        });
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
    if (/en-main|main\.css|typography|\/font/.test(lowered)) return 60;
    if (/\/themes\//.test(lowered)) return 40;
    return 0;
  };
  return Array.from(new Set(cssUrls)).sort((a, b) => score(b) - score(a));
};

const extractExternalFontCssUrls = (text: string, baseUrl: string) => {
  const urls = new Set<string>();
  const patterns = [
    /https?:\/\/use\.typekit\.net\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/p\.typekit\.net\/[^"'()\s<>]+/gi,
    /https?:\/\/fonts\.googleapis\.com\/[^"'()\s<>]+/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/fonts\/[^"'()\s<>]+/gi,
  ];
  patterns.forEach((pattern) => {
    (String(text || '').match(pattern) || []).forEach((raw) => {
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
        timeout: options.fast ? 2000 : 3000,
        httpsAgent: relaxedHttpsAgent,
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
        imports: options.fast ? [] : extractCssImports(cssText, current),
      };
    } catch {
      return null;
    }
  };

  if (options.fast) {
    const targets = queue.filter((url) => !visitedCss.has(url)).slice(0, 20);
    targets.forEach((url) => visitedCss.add(url));
    const results = await mapWithConcurrency(targets, 8, (url) => fetchOneStylesheet(url));
    results.filter(Boolean).forEach((entry) => {
      if (!entry) return;
      fetchedCss.push({ css: entry.css, source: entry.source });
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

const pickPrimaryUiColors = (colors: string[], limit = 6) => {
  const scored = new Map<string, number>();

  colors.forEach((raw, index) => {
    const hex = normalizeColorToHex(raw);
    if (!hex) return;

    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    let score = Math.max(0, 60 - index);
    score += saturation * 45;
    if (luminance > 0.93 || luminance < 0.07) score -= 18;
    if (saturation < 0.08) score -= 22;

    scored.set(hex, (scored.get(hex) || 0) + score + 1);
  });

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hex]) => hex);
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

const sanitizeExtractedImageUrl = (value: string) => {
  const cleaned = decodeCssUrlValue(value).trim();
  const extMatch = cleaned.match(/^(.*?\.(?:svg|png|jpe?g|webp|gif|avif))(?:\?[^"'()\s;>]*)?/i);
  if (extMatch?.[1]) return extMatch[1];
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
  if (isJunkImageUrl(absoluteUrl)) return null;
  if (!options.permissive && !isLikelyImageAssetUrl(absoluteUrl)) return null;

  const type = inferImageTypeFromUrl(absoluteUrl) || getAssetTypeFromUrl(absoluteUrl, 'img');
  const filename = filenameFromUrlPath(absoluteUrl);
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

const extractInlineSvgsFromDom = ($: any, images: any[]) => {
  $('svg').each((_: any, el: any) => {
    if (!$(el).attr('xmlns')) {
      $(el).attr('xmlns', 'http://www.w3.org/2000/svg');
    }
    const svgString = $.html(el);
    const svgBuffer = Buffer.from(svgString, 'utf8');
    const dims = probeRasterDimensions(svgBuffer);
    images.push({
      url: `data:image/svg+xml;base64,${svgBuffer.toString('base64')}`,
      type: 'svg',
      isInlineSvg: true,
      bytes: svgBuffer.length,
      width: dims.width || undefined,
      height: dims.height || undefined,
      mimeType: 'image/svg+xml',
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

const extractImagesFromDom = ($: any, targetUrl: string) => {
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

  $('link[rel="preload"][as="image"], link[rel="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"], link[rel="mask-icon"]').each((_: any, el: any) => {
    addImageCandidate(images, $(el).attr('href'), targetUrl);
  });

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

  extractInlineSvgsFromDom($, images);
  return images;
};

const extractImagesFromHtmlString = (html: string, targetUrl: string) => {
  const images: any[] = [];
  const searchText = html.replace(/\\/g, '').replace(/&amp;/g, '&');

  const absoluteRegex = /https?:\/\/[^"'<>\s\\]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\?[^"'<>\s\\]*)?/gi;
  (searchText.match(absoluteRegex) || []).slice(0, 200).forEach((raw) => addImageCandidate(images, raw, targetUrl));

  const wpUploadsRegex = /(?:https?:\/\/[^"'<>\s]+)?\/wp-content\/uploads\/[^"'<>\s)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\?[^"'<>\s)]*)?/gi;
  (searchText.match(wpUploadsRegex) || []).slice(0, 200).forEach((raw) => addImageCandidate(images, raw, targetUrl));

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
      parsed.pathname.match(/^\/(\d+)/);

    if (match) return `https://vimeo.com/${match[1]}`;

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
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

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

  return Array.from(urls);
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

const vimeoQualityBucketFromHeight = (height: number) => {
  if (!Number.isFinite(height) || height <= 0) return null;
  if (height >= 900) return 'fhd';
  if (height >= 600) return 'hd';
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
      const placeholder = group.find((video) => video?.sourceUrl || video?.url) || group[0];
      collapsed.push({
        ...placeholder,
        vimeoId,
        sourceUrl: placeholder?.sourceUrl || `https://vimeo.com/${vimeoId}`,
        url: placeholder?.sourceUrl || placeholder?.url || `https://vimeo.com/${vimeoId}`,
        provider: 'vimeo',
        isVimeo: true,
      });
      continue;
    }

    const variants: Record<string, any> = {};
    for (const stream of directStreams) {
      const height = parseCandidateHeight(stream) || Number(stream.height || 0);
      const bucket = vimeoQualityBucketFromHeight(height);
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

  const mediasRegex = /wistia\.com\/medias\/([a-z0-9]{8,12})/gi;
  while ((match = mediasRegex.exec(normalizedText)) !== null) {
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
    browser = await launchPuppeteerBrowser();
    const page = await browser.newPage();
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
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
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

  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const args = [
        '-sL',
        '--max-time',
        '25',
        '-A',
        userAgent,
        '-H',
        'Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
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

const fetchRemoteImageBufferViaBrowser = async (url: string, refererPageUrl = '') => {
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await browser.newPage();
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
    await new Promise((resolve) => setTimeout(resolve, 1800));
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

  const isProtectedCdnImage = /\.imaging\/|\/dam\/jcr:|dam\/jcr:/i.test(url);
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
    const browserFetched = await fetchRemoteImageBufferViaBrowser(url, refererPageUrl);
    if (browserFetched) return browserFetched;
    for (const fallbackUrl of imagingUrlFallbacks(url)) {
      const curlFallback = await fetchRemoteImageBufferViaCurl(fallbackUrl, refererPageUrl);
      if (curlFallback) {
        await writeCachedOriginalImageFromBuffer(url, curlFallback.buffer, curlFallback.contentType);
        return curlFallback;
      }
      const browserFallback = await fetchRemoteImageBufferViaBrowser(fallbackUrl, refererPageUrl);
      if (browserFallback) {
        await writeCachedOriginalImageFromBuffer(url, browserFallback.buffer, browserFallback.contentType);
        return browserFallback;
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
    const page = await browser.newPage();
    await applyPuppeteerStealth(page);
    await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2000));

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
  if (fromBuffer && RASTER_CONVERTIBLE_FORMATS.has(fromBuffer)) return fromBuffer;
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

const uniqueDownloadFilePath = async (
  filename: string,
  options: { sourcePageUrl?: string; kind?: DownloadSaveKind } = {}
) => {
  const pageUrl = String(options.sourcePageUrl || lastExtractedSourceUrl || '').trim();
  await ensureCreativeAssetsFolders(pageUrl);
  const targetDir = resolveDownloadSaveDir(options.kind || 'default', pageUrl);
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
  kind: DownloadSaveKind = 'default'
) => {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error(`${label} produced an empty file.`);
  }
  const target = await uniqueDownloadFilePath(filename, { sourcePageUrl, kind });
  await fsp.writeFile(target.filePath, buffer);
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

  const ext =
    kind === 'image'
      ? safeExtFromAssetType(
          detectImageFormatFromBuffer(buffer) ||
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
  await fsp.writeFile(path.join(cacheDir, filename), buffer);

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
  const defaultTarget =
    normalizedSource === 'webp' ? 'jpg' :
    normalizedSource === 'avif' ? 'png' :
    normalizedSource;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  filenameExtras.contentDisposition = (fetched as any).contentDisposition || options?.prefetched?.contentDisposition;

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
      await fsp.writeFile(cachePath, fetched.buffer);
      cached = fetched.buffer;
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
    cached = await convertRasterImageBuffer(fetched.buffer, targetFormat);
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
  const defaultTarget =
    sourceFormat === 'webp' ? 'jpg' :
    sourceFormat === 'avif' ? 'png' :
    sourceFormat;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  const wantsRasterConversion =
    ['png', 'jpg'].includes(normalizedTarget) &&
    RASTER_CONVERTIBLE_FORMATS.has(sourceFormat) &&
    supportedRasterConversionTargets(sourceFormat).includes(normalizedTarget as RasterOutputFormat);

  if (wantsRasterConversion) {
    const targetFormat = normalizedTarget as RasterOutputFormat;
    const converted = await convertRasterImageBuffer(fetched.buffer, targetFormat);
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
    buffer: fetched.buffer,
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
  if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0) return 'ttf';
  return '';
};

const isValidFontBuffer = (buffer: Buffer, expectedFormat: string) => {
  if (!buffer || buffer.length < 128) return false;
  const detected = detectFontFormatFromBuffer(buffer);
  const target = String(expectedFormat || '').toLowerCase();
  if (!detected) return false;
  if (target === 'svg' || target === 'eot') return false;
  return detected === target;
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
  contentType = ''
) => {
  const detected = detectFontFormatFromBuffer(buffer);
  let readFormat = detected || normalizeFontFormat(fromFormat, contentType);
  if (!['ttf', 'woff', 'woff2', 'eot', 'otf', 'svg'].includes(readFormat)) {
    throw new Error(`Unsupported or undetectable original font format: ${readFormat || 'unknown'}`);
  }

  if (readFormat === toFormat) {
    return buffer;
  }

  try {
    return await convertFontBufferOffThread(buffer, readFormat, toFormat);
  } catch (workerError: any) {
    const { buffer: innerBuffer, format: innerFormat } = await getInnerFontBuffer(buffer, readFormat);
    return writeFontBuffer(innerBuffer, innerFormat, toFormat);
  }
};

type ConvertFontExtras = {
  originalUrl?: string;
  metadataFilename?: string;
  contentDisposition?: string;
  cacheOnly?: boolean;
  refererPageUrl?: string;
};

const convertFontAsset = async (
  url: string,
  toFormat: string,
  originalFormat = 'unknown',
  preferredBase?: string,
  extras: ConvertFontExtras = {}
) => {
  const maxAttempts = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTimeout(
        getCachedConvertedFont(url, toFormat, originalFormat, preferredBase, extras),
        20000 + attempt * 8000,
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
  extras: { originalUrl?: string; metadataFilename?: string; contentDisposition?: string; cacheOnly?: boolean; refererPageUrl?: string } = {}
) => {
  await fsp.mkdir(cachedFontDir, { recursive: true });
  const normalizedTarget = ['ttf', 'woff', 'woff2', 'eot', 'otf', 'svg'].includes(toFormat) ? toFormat : 'ttf';
  const cacheSourceUrl =
    normalizeAssetRequestUrl(String(extras.originalUrl || '').trim()) ||
    normalizeAssetRequestUrl(url) ||
    url;
  const cachePath = path.join(cachedFontDir, `${assetCacheKey(cacheSourceUrl, normalizedTarget)}.${normalizedTarget}`);
  const filenameSourceUrl = extras.originalUrl || url;
  const filenameExtras = {
    contentDisposition: extras.contentDisposition,
    metadataFilename: extras.metadataFilename,
  };
  let cached = await readCachedFileIfExists(cachePath);
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
  try {
    fetched = await fetchAssetBuffer(url, extras.originalUrl || '', { cacheOnly, refererPageUrl: refererPage });
  } catch (primaryFetchError: any) {
    const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
    if (siblingUrl !== url) {
      fetched = await fetchAssetBuffer(siblingUrl, extras.originalUrl || '', { cacheOnly, refererPageUrl: refererPage });
    } else {
      throw primaryFetchError;
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
  const detected = detectFontFormatFromBuffer(fetched.buffer);
  let fromFormat = detected || normalizeFontFormat(originalFormat || getFontFormatFromUrlOrType(url, fetched.contentType), fetched.contentType);
  try {
    outputBuffer = await convertFontBuffer(url, fetched.buffer, fromFormat, normalizedTarget, fetched.contentType);
  } catch (convertError: any) {
    if (cacheOnly) throw convertError;
    const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
    if (siblingUrl !== url) {
      const sibling = await fetchAssetBuffer(siblingUrl, extras.originalUrl || '', { cacheOnly, refererPageUrl: refererPage });
      const siblingDetected = detectFontFormatFromBuffer(sibling.buffer);
      const siblingFrom =
        siblingDetected ||
        normalizeFontFormat(getFontFormatFromUrlOrType(siblingUrl, sibling.contentType), sibling.contentType);
      outputBuffer = await convertFontBuffer(siblingUrl, sibling.buffer, siblingFrom, normalizedTarget, sibling.contentType);
    } else {
      throw convertError;
    }
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
  options: { preferredBase?: string; metadataFilename?: string; refererPageUrl?: string } = {}
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
        fetchRemoteImageBuffer(url, refererPage),
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
      fonts.push({
        family: '',
        url: resolved,
        format,
        cssSource: baseUrl,
        status: DEFAULT_ASSET_STATUS,
      });
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

const isJunkImageUrl = (url: string) => {
  const lowered = String(url || '').toLowerCase();
  if (!lowered) return true;
  // Broken AEM srcset fragments like https://site.com/jcr:content.png (no dam/.imaging path).
  if (/^https?:\/\/[^/]+\/jcr:content\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|[?#])/i.test(lowered)) return true;
  if (/^https?:\/\/[^/]+\/jcr:content(?:$|[?#])/i.test(lowered)) return true;
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
  if (!/-\d+x\d+\./i.test(url)) score += 12;
  if (/\.(?:png|jpe?g|webp|avif)(\?|$)/i.test(url)) score += 8;
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
  const sample = String(html || '').slice(0, 120000).toLowerCase();
  if (/important safety information|full prescribing information|indicated for|wp-content\/uploads|\/\.imaging\//i.test(String(html || ''))) {
    return false;
  }
  return /robot-suspicion|checking the site connection security|cf-challenge|challenge-platform|datadome|verify you are human|access denied/i.test(sample);
};

const isLikelyBotWallExtract = (assets: { images?: any[] }) => {
  const imgs = assets?.images || [];
  if (!imgs.length) return false;
  const botCount = imgs.filter((img) => isBotWallImageUrl(String(img?.url || ''))).length;
  return botCount > 0 && botCount >= imgs.length - 1;
};

const staticExtractNeedsBrowser = (html: string, assets: { images?: any[]; fonts?: any[]; videos?: any[] }) => {
  const text = String(html || '');
  const fontHints = /fonts\.(?:googleapis|gstatic)|typekit|accelerator\.sanofi|use\.typekit|@font-face|rel=["']stylesheet["']/i.test(text);
  const videoHints = /youtube\.com|youtu\.be|vimeo\.com|wistia|brightcove|vidyard|\.(?:mp4|webm|m3u8)(?:[?#"'`<>\s\\)]|$)|<video\b|<iframe[^>]+src=/i.test(text);
  const lowFonts = (assets?.fonts?.length || 0) < 2;
  const lowVideos = (assets?.videos?.length || 0) === 0 && videoHints;
  return (lowFonts && fontHints) || lowVideos;
};

const shouldTryStaticBeforeBrowser = (html: string) => {
  const text = String(html || '');
  return text.length > 5000 && !isSparseSiteHtml(text) && scoreSiteHtml(text, 200) >= 30;
};

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

const dedupeExtractedAssets = async (
  images: any[],
  videos: any[],
  fonts: any[],
  colors: string[],
  targetUrl: string,
  fallbackThumb = '',
  options: { fast?: boolean } = {}
) => {
  const uniqueImages = dedupeImagesByCanonicalKey(
    Array.from(new Set(images.map((item) => item.url)))
      .map((url) => images.find((item) => item.url === url))
      .filter(Boolean)
      .filter((img: any) => !isBotWallImageUrl(String(img?.url || '')))
      .filter((img: any) => !isJunkImageUrl(String(img?.url || '')))
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
    const sanitized = sanitizeVideoForClient(video, targetUrl);
    if (!sanitized?.url) return;
    const key = videoKey(sanitized);
    const normalizedVideo = !sanitized.thumbnail && fallbackThumb ? { ...sanitized, thumbnail: fallbackThumb } : sanitized;
    const current = videoByKey.get(key);
    if (!current || videoRank(normalizedVideo) > videoRank(current)) {
      videoByKey.set(key, normalizedVideo);
    }
  });

  const uniqueVideos = options.fast
    ? normalizeVisibleVideoStreams(attachYouTubeWatchUrlToVideos(Array.from(videoByKey.values())), targetUrl)
    : await prepareVisibleVideoStreams(attachYouTubeWatchUrlToVideos(Array.from(videoByKey.values())), targetUrl);
  let uniqueFonts = dedupeFontsByLogicalKey(
    Array.from(new Set(fonts.map((font) => font.url)))
      .map((url) => pickBestFontForUrl(fonts, url))
      .filter(Boolean)
      .filter(isSupportedFontAsset)
  );
  if (!options.fast && uniqueFonts.length > 0 && uniqueFonts.length <= 12) {
    uniqueFonts = await filterUnavailableSitecoreFonts(uniqueFonts, targetUrl);
  } else if (uniqueFonts.length > 0) {
    void filterUnavailableSitecoreFonts(uniqueFonts, targetUrl).catch(() => undefined);
  }
  const uniqueColors = pickPrimaryUiColors(Array.from(new Set(colors)).filter((color) => color.length > 0), 6);

  if (options.fast) {
    const imageLimit = Math.min(uniqueImages.length, 48);
    await warmExtractedAssetList(uniqueImages as any[], [], {
      imageLimit,
      fontLimit: 0,
      budgetMs: Math.min(45000, 12000 + imageLimit * 500),
    }, targetUrl);
    const stillUncached = (uniqueImages as any[])
      .filter((img) => !img?.cachedUrl && String(img?.url || '').startsWith('http'))
      .slice(0, 24)
      .map((img) => String(img.url));
    if (stillUncached.length) {
      try {
        await withTimeout(
          fetchRemoteImageBuffersViaBrowserBatch(stillUncached, targetUrl),
          75000,
          `Browser batch warm for ${targetUrl}`
        );
        for (const img of uniqueImages as any[]) {
          if (img?.cachedUrl) continue;
          const url = String(img?.url || '');
          if (!url) continue;
          const existing = await readExistingOriginalAssetUrl(url, 'image');
          if (existing) {
            img.cachedUrl = existing;
            img.status = 'downloaded';
          }
        }
      } catch {
        // Best-effort browser warm only.
      }
    }
    warmExtractedAssetsInBackground(
      uniqueImages.slice(imageLimit) as any[],
      uniqueFonts as any[],
      targetUrl
    );
  } else {
    const imageLimit = Math.min(uniqueImages.length, 200);
    const fontLimit = Math.min(uniqueFonts.length, 80);
    await warmExtractedAssetList(uniqueImages as any[], uniqueFonts as any[], {
      imageLimit,
      fontLimit,
      budgetMs: Math.min(180000, 20000 + imageLimit * 240 + fontLimit * 200),
    }, targetUrl);
    warmExtractedAssetsInBackground(
      uniqueImages.slice(imageLimit) as any[],
      uniqueFonts.slice(fontLimit) as any[],
      targetUrl
    );
  }

  const attachCachedUrl = async (asset: any, kind: 'image' | 'font') => {
    const url = String(asset?.url || '');
    if (!url || url.startsWith('data:')) return withAssetStatus(asset);
    let cachedUrl = await readExistingOriginalAssetUrl(url, kind);
    let enriched = asset;

    if (!cachedUrl && kind === 'image' && !options.fast) {
      try {
        const warmed = await withTimeout(
          warmCachedOriginalAssetForExtraction(
            url,
            'image',
            inferImageTypeFromUrl(url, String(asset?.type || '')) || getAssetTypeFromUrl(url, asset?.type || 'bin'),
            { refererPageUrl: targetUrl }
          ),
          4500,
          `Attach image cache for ${url}`
        );
        if (warmed?.ok && warmed.cachedUrl) {
          cachedUrl = warmed.cachedUrl;
          enriched = {
            ...enriched,
            cachedUrl: warmed.cachedUrl,
            status: 'downloaded',
            ...(warmed.bytes ? { bytes: warmed.bytes } : {}),
            ...(warmed.width ? { width: warmed.width } : {}),
            ...(warmed.height ? { height: warmed.height } : {}),
          };
        }
      } catch {
        // fall through as path-only
      }
    }

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

  const resultImages = (
    await Promise.all(uniqueImages.map((img) => attachCachedUrl(enrichImageAssetMeta(img), 'image')))
  )
    .sort((a, b) => {
      const rank = (item: any) =>
        item?.cachedUrl || item?.status === 'downloaded' ? 0 :
        item?.status === 'path-only' ? 1 :
        2;
      return rank(a) - rank(b);
    });
  const resultVideos = uniqueVideos.map((video) => withAssetStatus(video));
  const resultFonts = await Promise.all(uniqueFonts.map((font) => attachCachedUrl(font, 'font')));

  return {
    images: resultImages,
    videos: resultVideos,
    fonts: resultFonts,
    colors: uniqueColors,
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
  options: { fast?: boolean } = {}
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
  extractWistiaIdsFromText(html, targetUrl).forEach((wistiaId) => assets.wistiaCandidateIds.add(wistiaId));

  assets.images.push(...extractImagesFromDom($, targetUrl));
  assets.images.push(...extractImagesFromHtmlString(html, targetUrl));
  const rawAssets = extractAssetsFromRawText(html, targetUrl);
  assets.images.push(...rawAssets.images);
  assets.videos.push(...rawAssets.videos);
  assets.fonts.push(...rawAssets.fonts);

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

  return { resolvedPagePrimaryThumb, pageTitle };
};

const extractStaticAssets = async (targetUrl: string, preloadedHtml = '', options: { fast?: boolean } = {}) => {
  const images: any[] = [];
  const videos: any[] = [];
  let fonts: any[] = [];
  let colors: string[] = [];
  const vimeoCandidateUrls = new Set<string>();
  const wistiaCandidateIds = new Set<string>();

  const html = preloadedHtml || await withTimeout(fetchSiteHtml(targetUrl), 28000, `Static HTML fetch for ${targetUrl}`).catch(() => '');
  const { resolvedPagePrimaryThumb } = await enrichAssetsFromHtml(html, targetUrl, {
    images,
    videos,
    fonts,
    colors,
    vimeoCandidateUrls,
    wistiaCandidateIds,
  }, { fast: options.fast });

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

  if (options.fast && isRichStaticExtract({ images, fonts, videos })) {
    const stylesheetLinks = (html.match(/<link[^>]+rel=["']stylesheet["']/gi) || []).length;
    const fontCssHints = (html.match(/fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|accelerator\.sanofi|@font-face|\.woff2/gi) || []).length;
    const canSkipCssFetch = stylesheetLinks === 0 || fonts.length >= 3 || (fonts.length >= 1 && fontCssHints === 0);
    if (canSkipCssFetch) {
      return dedupeExtractedAssets(images, videos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: true });
    }
  }

  const cssBundle = await withTimeout(
    fetchCssSourceCandidates(targetUrl, html, { fast: options.fast }),
    options.fast ? 4000 : 10000,
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

  if (!options.fast && vimeoCandidateUrls.size > 0) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(Array.from(vimeoCandidateUrls), 'fhd', targetUrl),
        VIMEO_EXTRACT_TIMEOUT_MS,
        `Static Vimeo extraction for ${targetUrl}`
      );
      videos.push(...(vimeoAssets.videos || []));
      images.push(...(vimeoAssets.images || []));
    } catch (error: any) {
      console.warn('Static Vimeo extraction failed, using placeholders:', error?.message || error);
      videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
    }
  } else if (options.fast && vimeoCandidateUrls.size > 0) {
    videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
  }

  if (!options.fast && wistiaCandidateIds.size > 0) {
    try {
      const wistiaAssets = await withTimeout(
        extractWistiaVideos(Array.from(wistiaCandidateIds), 'fhd'),
        8000,
        `Static Wistia extraction for ${targetUrl}`
      );
      videos.push(...(wistiaAssets.videos || []));
      images.push(...(wistiaAssets.images || []));
    } catch (error: any) {
      console.warn('Static Wistia extraction failed, using placeholders:', error?.message || error);
      videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
    }
  } else if (options.fast && wistiaCandidateIds.size > 0) {
    videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
  }

  return dedupeExtractedAssets(images, videos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: options.fast });
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

const assertLocalFileHasAudio = async (inputPath: string) => {
  const metadata = await probeMediaFile(inputPath);
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const audioStream = streams.find((stream: any) => stream?.codec_type === 'audio' && stream?.codec_name && stream.codec_name !== 'unknown');
  if (!audioStream) {
    throw new MediaExtractionError('Audio track unavailable for this video.', 422);
  }
  return audioStream;
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
    width: Number(videoStream?.width || 0) || undefined,
    height: Number(videoStream?.height || 0) || undefined,
    duration: Number(metadata?.format?.duration || 0) || undefined,
    bitrate: Number(metadata?.format?.bit_rate || 0) || undefined,
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
      .on('start', markActivity)
      .on('codecData', markActivity)
      .on('progress', markActivity)
      .on('stderr', markActivity)
      .on('end', () => finish())
      .on('close', markActivity)
      .on('exit', markActivity)
      .on('error', (err: any) => finish(err))
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
    '-c:a aac',
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
    if (ffmpegPath) await fsp.chmod(String(ffmpegPath), 0o755).catch(() => undefined);
    const ytdlpPath = resolveYtDlpPath();
    await fsp.chmod(String(ytdlpPath), 0o755).catch(() => undefined);
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

const getVideoPreviewMetadata = async (targetUrl: string) => {
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
  try {
    const html = await fetchVimeoPlayerHtml(vimeoId, sourcePageUrl);
    const config = parseVimeoPlayerConfigFromHtml(html);
    if (config) return { config, source: 'player-page' as const };
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
    const page = await browser.newPage();
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
  fhdAvailable: boolean;
}) => {
  console.log(`[vimeo:${vimeoId}] Progressive MP4 found: ${formatVimeoHeightList(debug.progressiveHeights)}`);
  const hlsLines = debug.hlsHeights.length > 0
    ? debug.hlsHeights.map((height) => `- ${height}p`).join('\n')
    : '- none';
  console.log(`[vimeo:${vimeoId}] HLS variants found:\n${hlsLines}`);
  if (debug.dashHeights.length > 0) {
    console.log(`[vimeo:${vimeoId}] DASH qualities: ${formatVimeoHeightList(debug.dashHeights)}`);
  }
  console.log(
    `[vimeo:${vimeoId}] Config source: ${debug.configSource || 'none'} | FHD available: ${debug.fhdAvailable ? 'yes' : 'no'}`
  );
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

const resolveVimeoQualityStreams = async (vimeoUrl: string, sourcePageUrl: string, ytDlpInfo: any) => {
  const vimeoId = parseVimeoIdFromUrl(vimeoUrl);
  const title = ytDlpInfo?.title || 'Vimeo video';
  const thumbnail = sanitizeStreamUrl(ytDlpInfo?.thumbnail || '', vimeoUrl) || ytDlpInfo?.thumbnail;
  const duration = Number(ytDlpInfo?.duration || 0) || undefined;

  const formats = Array.isArray(ytDlpInfo?.formats) ? ytDlpInfo.formats : [];
  const progressiveFormats = formats
    .filter(isVimeoProgressiveMp4Format)
    .sort((a: any, b: any) => (b.height || 0) - (a.height || 0));

  const progressiveByHeight = new Map<number, any>();
  progressiveFormats.forEach((format: any) => {
    const height = parseCandidateHeight(format) || Number(format.height || 0);
    if (!height) return;
    const current = progressiveByHeight.get(height);
    if (!current || Number(format.tbr || 0) > Number(current.tbr || 0)) progressiveByHeight.set(height, format);
  });
  const progressiveHeights = Array.from(progressiveByHeight.keys()).sort((a, b) => b - a);

  let configSource = '';
  let playerConfig: any = null;
  let hlsMasterUrl = '';
  let hlsVariants: Array<{ url: string; width?: number; height?: number; bandwidth?: number }> = [];
  let dashHeights: number[] = [];

  const playerConfigResult = vimeoId ? await loadVimeoPlayerConfig(vimeoId, sourcePageUrl) : null;
  if (playerConfigResult?.config) {
    playerConfig = playerConfigResult.config;
    configSource = playerConfigResult.source;
    hlsMasterUrl = getVimeoManifestUrlFromConfig(playerConfig, 'hls');
    dashHeights = getVimeoDashQualityHeights(playerConfig);
    if (!title && playerConfig?.video?.title) {
      // title already set from yt-dlp when available
    }
  }

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
    fhdAvailable,
  };
  if (vimeoId) logVimeoQualityDiscovery(vimeoId, debug);

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

  return {
    vimeoId,
    title: playerConfig?.video?.title || title,
    thumbnail: sanitizeStreamUrl(playerConfig?.video?.thumbnail_url || thumbnail || '', vimeoUrl) || thumbnail,
    duration: Number(playerConfig?.video?.duration || duration || 0) || undefined,
    streams: resolved,
    debug,
  };
};

const brightcovePolicyCache = new Map<string, { expiresAt: number; policyKey: string }>();
const brightcoveMetadataCache = new Map<string, { expiresAt: number; info: any }>();
const brightcoveMetadataTtlMs = 3 * 60 * 1000;

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

const getBrightcovePolicyKey = async (accountId: string, playerId: string) => {
  const normalizedPlayer = playerId.endsWith('_default') ? playerId : `${playerId}_default`;
  const cacheKey = `${accountId}:${normalizedPlayer}`;
  const cached = brightcovePolicyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.policyKey;

  const playerJsUrl = `https://players.brightcove.net/${accountId}/${normalizedPlayer}/index.min.js`;
  const response = await axios.get(playerJsUrl, {
    timeout: 10000,
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
};

const getBrightcoveMetadata = async (playerUrl: string) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) throw new Error('Invalid Brightcove player URL.');
  const normalizedPlayer = parsed.playerId.endsWith('_default') ? parsed.playerId : `${parsed.playerId}_default`;
  const cacheKey = `${parsed.accountId}:${normalizedPlayer}:${parsed.videoId}`;
  const cached = brightcoveMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const policyKey = await getBrightcovePolicyKey(parsed.accountId, parsed.playerId);
  const playbackUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${parsed.accountId}/videos/${parsed.videoId}`;
  const response = await axios.get(playbackUrl, {
    timeout: 12000,
    httpsAgent: relaxedHttpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': `application/json;pk=${policyKey}`,
    },
  });
  const info = response.data || {};
  brightcoveMetadataCache.set(cacheKey, { expiresAt: Date.now() + brightcoveMetadataTtlMs, info });
  return info;
};

const getYouTubeVideoId = (rawUrl: string) => {
  try {
    const parsed = new URL(normalizeYouTubeWatchUrl(rawUrl));
    return parsed.searchParams.get('v') || '';
  } catch {
    return '';
  }
};

const getYouTubeDirectFormatSelector = (quality: string) => {
  const targetHeight = getVimeoTargetHeight(quality);
  return [
    `best[height=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[height<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[ext=mp4][acodec!=none][vcodec!=none]`,
    `bestvideo[height=${targetHeight}][ext=mp4]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]`,
  ].join('/');
};

const getYouTubeMergeFormatSelector = (quality: string) => {
  const targetHeight = getVimeoTargetHeight(quality);
  return [
    `bestvideo[height<=${targetHeight}][vcodec^=avc1][ext=mp4]+bestaudio[acodec!=none][ext=m4a]/bestaudio[acodec!=none][ext=m4a]`,
    `bestvideo[height<=${targetHeight}][vcodec^=avc1]+bestaudio[acodec!=none]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]/bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio/best`,
  ].join('/');
};

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
  const muxedFormat = [
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

  const splitFormat = [
    `bestvideo[height=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio`,
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
  const cmd = ffmpeg()
    .input(videoUrl)
    .inputOptions(['-headers', headers])
    .input(audioUrl)
    .inputOptions(['-headers', headers])
    .outputOptions([
      '-map 0:v:0',
      '-map 1:a:0',
      '-c:v copy',
      '-c:a aac',
      '-b:a 192k',
      '-shortest',
      '-movflags +faststart',
      '-f mp4',
    ])
    .format('mp4');
  await waitForFfmpegFile(cmd, outputPath, 'YouTube audio merge');
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
  await withTimeout(
    youtubedl(normalizedWatchUrl, {
      ...buildYtDlpDownloadOptions(normalizedWatchUrl, quality, undefined, outputTemplate),
    } as any),
    10 * 60 * 1000,
    `YouTube yt-dlp merge for ${normalizedWatchUrl}`
  );
  return validateOutputFile(outputPath, 'YouTube merged download');
};

const mergeYouTubeWatchUrlToFile = async (watchUrl: string, quality: string, outputPath: string) => {
  try {
    return await mergeYouTubeWithYtDlp(watchUrl, quality, outputPath);
  } catch (ytdlpError: any) {
    console.warn('YouTube yt-dlp merge failed, trying ffmpeg split merge:', ytdlpError?.message || ytdlpError);
    const parts = await getYouTubeStreamParts(watchUrl, quality);
    if (parts.audioUrl) {
      await mergeYouTubePartsToFile(parts.videoUrl, parts.audioUrl, outputPath, watchUrl);
      return validateOutputFile(outputPath, 'YouTube merged download');
    }
    if (parts.muxedUrl) {
      const headers = buildYouTubeFfmpegHeaders(watchUrl);
      const cmd = ffmpeg(parts.muxedUrl).inputOptions(['-headers', headers]).outputOptions(['-c copy', '-movflags +faststart', '-f mp4']).format('mp4');
      await waitForFfmpegFile(cmd, outputPath, 'YouTube muxed copy');
      return validateOutputFile(outputPath, 'YouTube merged download');
    }
    throw ytdlpError;
  }
};

const pipeYouTubeMergedStream = async (
  req: express.Request,
  res: express.Response,
  watchUrl: string,
  quality: string,
  options: { inline?: boolean; filename?: string } = {}
) => {
  await fsp.mkdir(youtubeMergeCacheDir, { recursive: true });
  const cachedPath = getYouTubeMergeCachePath(watchUrl, quality);
  try {
    await validateOutputFile(cachedPath, 'YouTube merge cache');
  } catch {
    await mergeYouTubeWatchUrlToFile(watchUrl, quality, cachedPath);
  }

  const stat = await fsp.stat(cachedPath);
  const fileSize = stat.size;
  const preferredName = (options.filename || `${toSafeFileBase(pageTitleFromUrl(watchUrl))}.mp4`).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120);
  const contentType = 'video/mp4';
  const disposition = `${options.inline ? 'inline' : 'attachment'}; filename="${preferredName || 'youtube-video.mp4'}"`;

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

  const rangeHeader = String(req.headers.range || '');
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (rangeMatch) {
    const start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
    const end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }
    const chunkSize = end - start + 1;
    setCommonHeaders();
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', String(chunkSize));
    const stream = fs.createReadStream(cachedPath, { start, end });
    stream.on('error', (error: any) => {
      console.error('YouTube merged range stream read error:', error?.message || error);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream merged YouTube video.' });
      else res.end();
    });
    return stream.pipe(res);
  }

  setCommonHeaders();
  res.status(200);
  res.setHeader('Content-Length', String(fileSize));

  const stream = fs.createReadStream(cachedPath);
  stream.on('error', (error: any) => {
    console.error('YouTube merged stream read error:', error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream merged YouTube video.' });
    else res.end();
  });
  stream.pipe(res);
};

const toYouTubeMergedDownloadUrl = (watchUrl: string, quality: string, titleHint?: string) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const filename = `${toSafeFileBase(titleHint || 'video')}.mp4`;
  return `/api/youtube-merged-stream?url=${encodeURIComponent(normalizedWatchUrl)}&quality=${quality}&inline=1&filename=${encodeURIComponent(filename)}`;
};

const buildYouTubeMergedCard = (watchUrl: string, quality: string, titleHint?: string) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const title = titleHint || pageTitleFromUrl(normalizedWatchUrl);
  return {
    url: toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title),
    sourceStreamUrl: normalizedWatchUrl,
    sourceUrl: normalizedWatchUrl,
    pageUrl: normalizedWatchUrl,
    watchUrl: normalizedWatchUrl,
    provider: 'youtube',
    type: 'mp4',
    title,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : '',
    resolution: `${targetHeight}p`,
    height: targetHeight,
    width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : undefined,
    qualityRequested: quality,
    qualityExact: true,
    displayQualityKey: quality,
    displayQualityLabel: getCleanQualityLabel(quality),
    streamLabel: getCleanQualityLabel(quality),
    isYouTube: true,
    isDirect: true,
    isMp4Proxy: true,
    isYouTubeMerged: true,
    audioAvailable: true,
    hasAudio: true,
    noAudio: false,
    verifiedPlayable: true,
  };
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
  const targetHeight = getVimeoTargetHeight(quality);
  const directUrl = await withTimeout(
    youtubedl(rawUrl, {
      getUrl: true,
      format: getYouTubeDirectFormatSelector(quality),
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

const buildYtDlpBaseOptions = () => ({
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  ...(ffmpegPath ? { ffmpegLocation: path.dirname(String(ffmpegPath)) } : {}),
});

const buildYtDlpAuthOptions = (targetUrl: string) => {
  if (process.platform === 'darwin' && needsBrowserCookiesForUrl(targetUrl)) {
    return { cookiesFromBrowser: 'safari' };
  }
  return {};
};

const buildYtDlpRefererOptions = (targetUrl: string, sourcePageUrl?: string) => {
  const refererPage = String(sourcePageUrl || '').trim();
  if (!refererPage) return {};
  try {
    const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    const refererHost = new URL(refererPage).hostname.replace(/^www\./, '').toLowerCase();
    if (isVimeoUrl(targetUrl) && refererHost !== targetHost) {
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
    format: isYouTube ? getYouTubeMergeFormatSelector(quality) : getFhdMp4FormatSelector(quality),
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
    if (host.includes('tiktok.com')) return 'tiktok';
    return 'platform';
  } catch {
    return 'platform';
  }
};

const isPlatformVideoUrl = (rawUrl: string) => {
  try {
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
      host.endsWith('.instagram.com')
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
  if (value.startsWith('data:')) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v|\.m3u8|\.mpd)(\?|$)/i.test(value)) return true;
  if (value.includes('wistia.com/deliveries/') || value.includes('wistia.net/deliveries/')) return true;
  if (value.includes('/videoplayback?') || value.includes('manifest') || value.includes('/video/')) return true;
  return false;
};

const isDirectProgressiveVideoUrl = (rawUrl: string) =>
  /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(rawUrl || ''));

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

const matchesStrictQuality = (height: number | undefined, quality: string) => {
  if (!height) return false;
  if (quality === 'hd') return height === 720;
  if (quality === 'fhd') return height === 1080;
  if (quality === '4k') return height >= 2160;
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
      if (video?.isVimeo && !video?.isVimeoDirect) return true;
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
  const prepared = await mapWithConcurrency(visible, 3, async (video: any) => {
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
    sanitizeStreamUrl(info.poster || info.thumbnail || info.thumbnail_sources?.[0]?.src || '', playerUrl) ||
    info.poster ||
    info.thumbnail ||
    '';
  const sources = Array.isArray(info.sources) ? info.sources : [];
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
      brightcoveAccountId: parsed.accountId,
      brightcovePlayerId: parsed.playerId,
      brightcoveVideoId: parsed.videoId,
    };
  });

  const images = thumbnail ? [{ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, 'jpg') }] : [];
  if (videos.length > 0) return { videos, images };

  const hlsSource = sources.find((source: any) => {
    const src = String(source?.src || '');
    const type = String(source?.type || '').toLowerCase();
    return src && (src.includes('.m3u8') || type.includes('mpegurl'));
  });
  const hlsUrl = sanitizeStreamUrl(String(hlsSource?.src || ''), playerUrl) || '';
  const hlsVariants = hlsUrl
    ? await extractHlsVariants(hlsUrl, playerUrl).catch(() => [])
    : [];
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
  const safeFilename = `${toSafeFileBase(titleHint || 'video')}-${quality}.mp4`;
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
    await fsp.rename(tempOutput, finalPath).catch(async () => {
      await fsp.copyFile(tempOutput, finalPath);
      await fsp.unlink(tempOutput).catch(() => undefined);
    });
    const stat = await validateOutputFile(finalPath, 'Merged MP4 fallback');

    return {
      url: toLocalVideoDownloadUrl(req, safeFilename, options.sourcePageUrl),
      localPath: finalPath,
      downloadPath: finalPath,
      sourceUrl: targetUrl,
      provider: platformProviderFromUrl(targetUrl),
      type: 'mp4',
      title: titleHint || 'Video',
      resolution: `${targetHeight}p`,
      height: targetHeight,
      isDirect: true,
      isLocalMerged: true,
      verifiedPlayable: true,
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

const extractVimeoVideos = async (vimeoUrls: string[], quality = 'fhd', sourcePageUrl = '') => {
  const uniqueUrls = Array.from(new Set(vimeoUrls.map(normalizeVimeoUrl).filter(Boolean))) as string[];

  const results = await mapWithConcurrency(uniqueUrls.slice(0, 12), 4, async (vimeoUrl) => {
    try {
      const info: any = await getVimeoMetadata(vimeoUrl, sourcePageUrl);
      const resolved = await resolveVimeoQualityStreams(vimeoUrl, sourcePageUrl, info);

      const videos: any[] = [];
      const images: any[] = [];

      const thumbnail = resolved.thumbnail;
      if (thumbnail) {
        images.push({ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, 'jpg') });
      }

      const streamBuckets = Object.entries(resolved.streams) as Array<['fhd' | 'hd', VimeoResolvedStream]>;
      if (streamBuckets.length > 0) {
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
            title: resolved.title || 'Vimeo video',
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
      } else {
        videos.push({
          url: vimeoUrl,
          provider: 'vimeo',
          isVimeo: true,
          type: 'vimeo',
          title: resolved.title || info.title || 'Vimeo video',
          thumbnail,
          vimeoQualityDebug: resolved.debug,
        });
      }

      return { videos, images };
    } catch (error: any) {
      console.warn(`Vimeo extraction failed for ${vimeoUrl}:`, error.message || error);
      const cleanError = String(error?.message || error || '').slice(0, 260);
      return {
        images: [],
        videos: [{
          url: vimeoUrl,
          provider: 'vimeo',
          isVimeo: true,
          type: 'vimeo',
          title: 'Vimeo video',
          unresolvable: true,
          resolveError: cleanError,
          qualityFallbackMessage: 'This Vimeo link could not be resolved (unavailable or restricted).',
        }],
      };
    }
  });

  return {
    videos: results.flatMap(result => result.videos),
    images: results.flatMap(result => result.images),
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
      console.warn('Video-only Vimeo extraction failed, using source cards:', error?.message || error);
      videos.push(...createVimeoSourceVideos(vimeoUrls));
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
    try {
      const brightcoveAssets = await withTimeout(
        Promise.all(brightcoveVideos.map((video) => extractBrightcoveVideos(video.url))),
        14000,
        `Video-only Brightcove extraction for ${targetUrl}`
      );
      brightcoveAssets.forEach((assets: any) => videos.push(...(assets?.videos || [])));
    } catch (error: any) {
      console.warn('Video-only Brightcove extraction failed, using source cards:', error?.message || error);
      videos.push(...brightcoveVideos);
    }
  }

  videos.push(...directVideoUrls);
  const cleanVideos = await prepareVisibleVideoStreams(videos, targetUrl);
  return cleanVideos.length > 0 ? cleanVideos : normalizeVisibleVideoStreams(videos, targetUrl);
};

// API Endpoint to extract assets
app.post('/api/extract', async (req, res) => {
  const { url, mode } = req.body;
  let browser: Awaited<ReturnType<typeof launchPuppeteerBrowser>> | null = null;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const targetUrl = new URL(url).href;
    assertPublicAssetUrl(targetUrl);
    lastExtractedSourceUrl = targetUrl;
    const useStaticExtract = mode === 'static';

    if (isVideoPlatformHostUrl(targetUrl) && !isPlaylistUrl(targetUrl) && !isPlatformVideoUrl(targetUrl)) {
      return res.json({
        images: [],
        videos: [],
        fonts: [],
        colors: [],
      });
    }

    if (useStaticExtract) {
      const staticAssets = await extractStaticAssets(targetUrl);
      return res.json(staticAssets);
    }

    const prefetchedSiteHtml = await withTimeout(
      fetchSiteHtml(targetUrl),
      12000,
      `Prefetch HTML for ${targetUrl}`
    ).catch(() => '');
    const staticFallbackAssets = async () => extractStaticAssets(targetUrl, prefetchedSiteHtml);

    if (prefetchedSiteHtml && shouldTryStaticBeforeBrowser(prefetchedSiteHtml)) {
      try {
        const staticQuick = await withTimeout(
          extractStaticAssets(targetUrl, prefetchedSiteHtml, { fast: true }),
          12000,
          `Static fast path for ${targetUrl}`
        );
        if (isRichStaticExtract(staticQuick) && !staticExtractNeedsBrowser(prefetchedSiteHtml, staticQuick)) {
          return res.json(staticQuick);
        }
      } catch (error: any) {
        console.warn('Static fast path skipped, continuing with browser route:', error?.message || error);
      }
    }
    
    const images: any[] = [];
    const videos: any[] = [];
    let fonts: any[] = [];
    let colors: string[] = [];
    const vimeoCandidateUrls = new Set<string>();
    const wistiaCandidateIds = new Set<string>();
    const embeddedPageUrls = new Set<string>();

    const isYouTube = targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');

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
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(targetUrl);
      const immediateVideos = ['fhd', 'hd'].map((quality) => buildYouTubeMergedCard(normalizedWatchUrl, quality));
      return res.json({
        images: [],
        videos: immediateVideos,
        fonts: [],
        colors: [],
      });

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
            cleanVideos = createVimeoSourceVideos([vimeoUrl]).map((video) => ({
              ...video,
              unresolvable: true,
              resolveError: 'Vimeo progressive streams were not available for this link.',
              qualityFallbackMessage: 'Try HD/FHD download or check that the video is public.',
            }));
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
            videos: createVimeoSourceVideos([vimeoUrl]).map((video) => ({
              ...video,
              unresolvable: true,
              resolveError: String(error?.message || error || 'Vimeo extraction failed').slice(0, 260),
              qualityFallbackMessage: 'This Vimeo link could not be resolved (timeout, private, or restricted).',
            })),
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

    browser = await launchPuppeteerBrowser();
    
    const page = await browser.newPage();
    await applyPuppeteerStealth(page);
    
    // Intercept network requests
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      if (['websocket', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
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
          resourceType === 'image' ||
          /^image\//i.test(contentType);
        if (looksLikeImageResponse && (isLikelyImageAssetUrl(url, contentType) || resourceType === 'image')) {
          images.push({
            url,
            type: inferImageTypeFromUrl(url, contentType) || getAssetTypeFromUrl(url, 'img'),
            status: DEFAULT_ASSET_STATUS,
          });
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
            const cssText = String(await withTimeout(Promise.resolve(response.text()), 1500, 'Stylesheet read'));
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
      }
    };

    page.on('response', handlePageResponse);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 28000 }).catch((e) => console.log('Goto timeout, continuing...', e?.message || e));

    const initialHtml = await page.content().catch(() => '');
    if (/robot-suspicion|challenge-platform|captcha-delivery|cf-challenge/i.test(initialHtml)) {
      await new Promise((resolve) => setTimeout(resolve, 4500));
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    
    // Scroll down to trigger lazy loading for the entire page
    await page.evaluate(`
      (async () => {
        await new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 1000;
          
          let lastScrollHeight = document.body ? document.body.scrollHeight : (document.documentElement ? document.documentElement.scrollHeight : 0);
          let unchangedCount = 0;
          
          const timer = setInterval(() => {
            const scrollHeight = document.body ? document.body.scrollHeight : (document.documentElement ? document.documentElement.scrollHeight : 0);
            window.scrollBy(0, distance);
            totalHeight += distance;

            if (scrollHeight === lastScrollHeight) {
              unchangedCount++;
            } else {
              unchangedCount = 0;
              lastScrollHeight = scrollHeight;
            }

            if ((totalHeight >= scrollHeight && unchangedCount > 3) || totalHeight > 9000 || scrollHeight === 0) {
              clearInterval(timer);
              resolve();
            }
          }, 80);
        });
      })()
    `);

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
        const addId = (id: string) => {
          const clean = String(id || '').trim();
          if (/^\d{6,}$/.test(clean)) urls.add(`https://vimeo.com/${clean}`);
        };

        const scanText = (value: string) => {
          const text = String(value || '')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"');
          const re = /(?:https?:)?\/\/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/)?(\d+)/gi;
          let match: RegExpExecArray | null;
          while ((match = re.exec(text)) !== null) addId(match[1]);

          const idRegex = /(?:vimeo(?:Video)?Id|vimeo_id|vimeoId|clip_id|clipId)["']?\s*[:=]\s*["']?(\d{6,})/gi;
          while ((match = idRegex.exec(text)) !== null) addId(match[1]);
        };

        // 1) Scripts often embed the numeric id even when the DOM shows blob:.
        Array.from(document.querySelectorAll('script'))
          .map((script) => script.textContent || '')
          .filter(Boolean)
          .slice(0, 120)
          .forEach(scanText);

        // 2) Common data attributes used by Vimeo wrappers.
        const attrNames = ['data-vimeo-id', 'data-vimeoid', 'data-video-id', 'data-clip-id', 'data-vimeo-video-id'];
        Array.from(document.querySelectorAll<HTMLElement>('[data-vimeo-id],[data-vimeoid],[data-video-id],[data-clip-id],[data-vimeo-video-id]'))
          .slice(0, 120)
          .forEach((node) => {
            for (const attr of attrNames) {
              const val = node.getAttribute(attr);
              if (val) addId(val);
            }
          });

        // 3) Last resort: scan nearby markup around Vimeo blob videos.
        Array.from(document.querySelectorAll<HTMLVideoElement>('video[src^=\"blob:\"]'))
          .slice(0, 40)
          .forEach((video) => {
            const src = String(video.getAttribute('src') || '');
            if (!/blob:https?:\/\/player\.vimeo\.com/i.test(src)) return;
            const wrapper = video.closest('div, section, article') as HTMLElement | null;
            if (wrapper) scanText(wrapper.outerHTML);
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

    // Extract primary colors directly from CTA/headings/subheadings/icons (max 6).
    const domColors = await page.evaluate(`
      (() => {
        const MAX = 6;
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

        const selectors = [
          // CTA / buttons
          'button',
          '[role="button"]',
          'a',
          '.btn',
          '.button',
          '.cta',
          '[class*="cta" i]',
          '[class*="btn" i]',
          '[data-cta]',
          // Headings / subheadings
          'h1', 'h2', 'h3', 'h4',
          '[class*="heading" i]',
          '[class*="title" i]',
          '[class*="subtitle" i]',
          // Icons
          'svg',
          'i',
          '[class*="icon" i]',
        ];

        const scoreByColor = new Map();
        const bump = (hex, weight) => {
          if (!hex) return;
          const prev = scoreByColor.get(hex) || 0;
          scoreByColor.set(hex, prev + weight);
        };

        const candidates = document.querySelectorAll(selectors.join(','));
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

        return sorted.slice(0, MAX);
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
    extractWistiaIdsFromText(html, targetUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));

    images.push(...extractImagesFromDom($, targetUrl));
    images.push(...extractImagesFromHtmlString(html, targetUrl));
    const rawRenderedAssets = extractAssetsFromRawText(html, targetUrl);
    images.push(...rawRenderedAssets.images);
    videos.push(...rawRenderedAssets.videos);
    fonts.push(...rawRenderedAssets.fonts);

    if (prefetchedSiteHtml) {
      const $prefetch = cheerio.load(prefetchedSiteHtml);
      images.push(...extractImagesFromDom($prefetch, targetUrl));
      images.push(...extractImagesFromHtmlString(prefetchedSiteHtml, targetUrl));
      const rawPrefetchAssets = extractAssetsFromRawText(prefetchedSiteHtml, targetUrl);
      images.push(...rawPrefetchAssets.images);
      videos.push(...rawPrefetchAssets.videos);
      fonts.push(...rawPrefetchAssets.fonts);
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
        embeddedPage = await browser.newPage();
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
    const cssQueue = prioritizeFontCssCandidates(Array.from(new Set(cssLinks))).slice(0, 48);
    const visitedCss = new Set<string>();
    const discoveredFonts: any[] = [];
    const discoveredImages: any[] = [];
    let hops = 0;

    while (cssQueue.length > 0 && hops < 24) {
      const batch = cssQueue.splice(0, 6).filter((url) => !visitedCss.has(url));
      if (batch.length === 0) break;
      hops += batch.length;
      batch.forEach((url) => visitedCss.add(url));

      const cssResults = await Promise.allSettled(batch.map(async (cssUrl) => {
      try {
        assertPublicAssetUrl(cssUrl);
        const cssResponse = await axios.get(cssUrl, { 
          timeout: 3500,
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
                cssQueue.push(importUrl);
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

    const realImageCount = images.filter((img) => !isBotWallImageUrl(String(img?.url || ''))).length;
    if (realImageCount < 5 && images.some((img) => isBotWallImageUrl(String(img?.url || '')))) {
      console.warn('Bot-wall detected during extract, reloading page:', targetUrl);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const reloadHtml = await page.content().catch(() => '');
      if (reloadHtml && !/robot-suspicion/i.test(reloadHtml)) {
        await enrichAssetsFromHtml(reloadHtml, targetUrl, {
          images,
          videos,
          fonts,
          colors,
          vimeoCandidateUrls,
          wistiaCandidateIds,
        });
      }
    }

    await page.close().catch(() => undefined);
    await closePuppeteerBrowser(browser);
    browser = null;

    if (vimeoCandidateUrls.size > 0) {
      try {
        const vimeoAssets = await withTimeout(
          extractVimeoVideos(Array.from(vimeoCandidateUrls), 'fhd', targetUrl),
          VIMEO_EXTRACT_TIMEOUT_MS,
          `Browser Vimeo extraction for ${targetUrl}`
        );
        videos.push(...(vimeoAssets.videos || []));
        images.push(...(vimeoAssets.images || []));
      } catch (error: any) {
        console.warn('Vimeo direct extraction failed, using source placeholders only:', error?.message || error);
        videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
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

    if ((isInstagramUrl(targetUrl) || isFacebookUrl(targetUrl) || isXUrl(targetUrl)) && videos.length === 0) {
      videos.push({
        url: targetUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(targetUrl),
        type: 'video',
        title: pageTitle,
        thumbnail: resolvedPagePrimaryThumb,
      });
    }

    let extractedAssets = await dedupeExtractedAssets(images, videos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: true });
    extractedAssets = await recoverExtractWhenEmpty(targetUrl, extractedAssets);
    res.json(extractedAssets);

  } catch (error: any) {
    console.error('Extraction error:', error.message);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    try {
      const targetUrl = new URL(String(req.body?.url || '')).href;
      assertPublicAssetUrl(targetUrl);
      const prefetchedHtml = await fetchSiteHtml(targetUrl).catch(() => '');
      const staticAssets = await extractStaticAssets(targetUrl, prefetchedHtml);
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
    await closePuppeteerBrowser(browser);
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
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: cached.buffer.length,
      });
    }
    try {
      const sourcePageUrl = readSourcePageUrl(req);
      const fetched = await withTimeout(
        fetchRemoteImageBuffer(normalized, sourcePageUrl),
        12000,
        `image-meta for ${normalized}`
      );
      const dims = probeRasterDimensions(fetched.buffer);
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: fetched.buffer.length,
      });
    } catch {
      return res.json({ width: 0, height: 0, bytes: 0 });
    }
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to read image metadata' });
  }
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
        45000,
        `Preview fetch for ${normalized}`
      ));
    if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      return res.status(502).json({ error: 'Preview image could not be loaded' });
    }
    const format = getAssetTypeFromUrl(normalized, inferImageTypeFromContentType(fetched.contentType) || 'bin');
    const contentType =
      format === 'jpg' || format === 'jpeg' ? 'image/jpeg'
        : format === 'png' ? 'image/png'
          : format === 'svg' ? 'image/svg+xml'
            : format === 'webp' ? 'image/webp'
              : format === 'avif' ? 'image/avif'
                : format === 'gif' ? 'image/gif'
                  : fetched.contentType || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(fetched.buffer);
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
      const saved = await saveCachedFileToDownloads(cachePath, filename, 'Image download', sourcePageUrl);
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
    if (String(save || '').toLowerCase() === '1' || String(save || '').toLowerCase() === 'true') {
      const saved = await saveBufferToDownloads(fetched.buffer, filename, 'Image download', sourcePageUrl, 'image');
      return res.json(saved);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
    return res.send(fetched.buffer);
  } catch (error: any) {
    console.error('Image download error:', error.message || error);
    return res.status(500).json({ error: `Failed to download image: ${error?.message || 'Unknown error'}` });
  }
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
    const contentType = imageContentTypeForFormat(converted.format, 'application/octet-stream');
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
          const saved = await saveCachedFileToDownloads(converted.cachedPath, converted.filename, 'Image conversion', sourcePageUrl);
          return res.json(saved);
        } catch {
          // Converted buffer may be in memory only; save bytes directly.
        }
      }
      const saved = await saveBufferToDownloads(converted.buffer, converted.filename, 'Image conversion', sourcePageUrl, 'image');
      return res.json(saved);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${converted.filename}"`);
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

app.post('/api/save-asset-buffer', async (req, res) => {
  const { base64, filename, sourcePageUrl: bodySourcePageUrl } = req.body || {};
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
    const saved = await saveBufferToDownloads(buffer, filename, 'Asset buffer save', readSourcePageUrl(req, bodySourcePageUrl));
    return res.json(saved);
  } catch (error: any) {
    console.error('Save asset buffer error:', error?.message || error);
    return res.status(500).json({ error: `Failed to save file: ${error?.message || 'Unknown error'}` });
  }
});

// API Endpoint to convert font formats
app.get('/api/convert-font', async (req, res) => {
  const { url, toFormat, originalFormat, filenameBase, originalUrl, metadataFilename, save } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const targetFormat = typeof toFormat === 'string' && toFormat.trim()
    ? toFormat.trim().toLowerCase()
    : 'ttf';
  const sourceFormat = typeof originalFormat === 'string' ? originalFormat : 'unknown';
  const preferredBase = typeof filenameBase === 'string' ? filenameBase : undefined;
  const extras = {
    originalUrl: typeof originalUrl === 'string' ? originalUrl : undefined,
    metadataFilename: typeof metadataFilename === 'string' ? metadataFilename : undefined,
    refererPageUrl: readSourcePageUrl(req) || undefined,
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
        'font'
      );
      return res.json(saved);
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
          'font'
        );
        return res.json({
          ...saved,
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
          'font'
        );
        return res.json({
          ...saved,
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
  const { base64, toFormat, originalFormat, filenameBase, save, sourcePageUrl: bodySourcePageUrl } = req.body || {};
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
    const output = await convertFontBuffer(
      typeof filenameBase === 'string' ? filenameBase : 'font',
      buffer,
      typeof originalFormat === 'string' ? originalFormat : 'unknown',
      normalizedTarget,
      ''
    );

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
        'font'
      );
      return res.json(saved);
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
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
    await fsp.mkdir(youtubeMergeCacheDir, { recursive: true });
    const cachedPath = getYouTubeMergeCachePath(watchUrl, requestedQuality);
    try {
      await validateOutputFile(cachedPath, 'YouTube merge cache');
    } catch {
      await withTimeout(
        mergeYouTubeWatchUrlToFile(watchUrl, requestedQuality, cachedPath),
        90000,
        `YouTube merge for ${watchUrl}`
      );
    }
    await assertLocalFileHasAudio(cachedPath);
    const metadata = await probeMediaFile(cachedPath);
    const stat = await fsp.stat(cachedPath);
    const probe = describeMediaProbe(metadata);
    return res.json({
      ok: true,
      watchUrl,
      quality: requestedQuality,
      mergedUrl: toYouTubeMergedDownloadUrl(watchUrl, requestedQuality, pageTitleFromUrl(watchUrl)),
      localPath: cachedPath,
      size: stat.size,
      ...probe,
    });
  } catch (error: any) {
    console.error('YouTube merge verify error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Merged YouTube file failed audio verification.' });
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
  const preferredFilename = typeof filename === 'string' ? filename : `${toSafeFileBase(pageTitleFromUrl(watchUrl))}.mp4`;

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
  const preferredFilename = typeof filename === 'string' ? filename : `${toSafeFileBase(pageTitleFromUrl(watchUrl))}.mp4`;

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
    const contentType = response.headers['content-type'] || 'video/mp4';
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
      : parsedSource.pathname.split('/').pop() || 'audio'
    )
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'audio';
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
  const folderPath =
    target === 'converted-audio'
      ? convertedAudioDir
      : target === 'converted-video'
        ? convertedVideoDir
        : target === 'fonts'
          ? resolveCreativeAssetsDir(sourcePageUrl, 'Fonts')
          : target === 'images'
            ? resolveCreativeAssetsDir(sourcePageUrl, 'Images')
            : target === 'videos'
              ? resolveCreativeAssetsDir(sourcePageUrl, 'Videos')
              : target === 'audio'
                ? resolveCreativeAssetsDir(sourcePageUrl, 'Audio')
                : target === 'smoketest'
                  ? resolveCreativeAssetsDir(sourcePageUrl, 'SmokeTest')
                  : target === 'brief'
                    ? resolveCreativeAssetsDir(sourcePageUrl, 'Brief')
                    : target === 'isi'
                      ? resolveCreativeAssetsDir(sourcePageUrl, 'ISI')
                      : resolveCreativeAssetsRoot(sourcePageUrl);

  try {
    await ensureCreativeAssetsFolders(sourcePageUrl);
    await fsp.mkdir(folderPath, { recursive: true });
    await openLocalFolder(folderPath);
    return res.json({ ok: true, path: folderPath });
  } catch (error: any) {
    console.error('Open folder error:', error.message || error);
    return res.status(500).json({ error: 'Could not open the folder on this machine.' });
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
        (video.displayQualityKey === requestedQuality || video.qualityRequested === requestedQuality)
    );
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
      return res.json({ video: enforceMp4VideoPayload(validVideo), images: vimeoAssets.images });
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
        const directCandidates = (brightcoveAssets.videos || [])
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

        const mergeCandidate: any = (brightcoveAssets.videos || []).find((video: any) => video?.brightcoveManifestUrl);
        const hlsInputUrl = mergeCandidate?.brightcoveManifestUrl
          ? await selectHlsVariantUrl(mergeCandidate.brightcoveManifestUrl, getVimeoTargetHeight(requestedQuality), url).catch(() => mergeCandidate.brightcoveManifestUrl)
          : '';
        const mergedVideo = await materializeMergedMp4FromPlatform(
          url,
          requestedQuality,
          req,
          mergeCandidate?.title || directCandidates[0]?.title || 'Brightcove video',
          hlsInputUrl ? { directInputUrl: hlsInputUrl, sourcePageUrl: url } : {}
        );
        return res.json({ video: mergedVideo });
      } catch (brightcoveError: any) {
        console.warn('Brightcove resolve failed, trying universal yt-dlp route:', brightcoveError?.message || brightcoveError);
      }
    }

    if (isYouTubeUrl(url)) {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(resolverTargetUrl);
      return res.json({
        video: buildYouTubeMergedCard(normalizedWatchUrl, requestedQuality),
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

      const page = await browser.newPage();
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
            const buffer = Buffer.from(matches[2], 'base64');
            let ext = matches[1].split('/')[1]?.split('+')[0] || 'bin';
            if (ext === 'jpeg') ext = 'jpg';
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
          const url = assertAssetUrlAllowed(rawUrl);
          const fontExtras = {
            originalUrl: manifestUrl,
            metadataFilename: typeof item.metadataFilename === 'string' ? item.metadataFilename : undefined,
            refererPageUrl:
              resolveFontRefererPage(
                typeof item.cssSource === 'string' ? item.cssSource : '',
                zipPageUrl || ''
              ) || undefined,
          };
          const toFormat = String(item.toFormat || 'ttf');
          const filenameBase = typeof item.filenameBase === 'string' ? item.filenameBase : 'font';
          const runFontZipConvert = (cacheOnly: boolean) =>
            convertFontAsset(
              url,
              toFormat,
              String(item.originalFormat || 'unknown'),
              filenameBase,
              {
                ...fontExtras,
                ...(cacheOnly ? zipCacheOnly : {}),
              }
            );
          let converted;
          try {
            converted = await runFontZipConvert(true);
          } catch (cacheError: any) {
            const reason = String(cacheError?.message || cacheError || '');
            if (/not cached|valid font|decode|conversion|timeout|fetch/i.test(reason)) {
              converted = await runFontZipConvert(false);
            } else {
              throw cacheError;
            }
          }
          if (!converted.buffer?.length) {
            throw new Error(`Converted font is empty (${toFormat})`);
          }
          const zipName =
            typeof item.zipEntryName === 'string' && item.zipEntryName.trim()
              ? item.zipEntryName.trim()
              : buildFontZipEntryName(filenameBase, converted.format || toFormat);
          return { ok: true, entry: { name: zipName, buffer: converted.buffer } };
        }

        if (isImageConversion) {
          const requestedCachePath = typeof item.cachedPath === 'string' ? item.cachedPath.trim() : '';
          const requestUrl = requestedCachePath || rawUrl;
          const url = assertAssetUrlAllowed(requestUrl);
          const cacheProbe =
            (await readAssetBufferFromCache(url, 'image')) ||
            (manifestUrl && manifestUrl !== requestUrl
              ? await readAssetBufferFromCache(manifestUrl, 'image')
              : null);
          if (cacheProbe) zipImageStats.cached += 1;
          console.debug('[image-zip:item]', {
            id: typeof item.id === 'string' ? item.id : undefined,
            url: manifestUrl,
            mimeType: typeof item.mimeType === 'string' ? item.mimeType : cacheProbe?.contentType || '',
            cachePath: requestedCachePath || (await getAssetCacheDebugPath(url, 'image')),
            cache: cacheProbe ? 'hit' : 'miss',
          });
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
          return { ok: true, entry: { name: converted.filename, buffer: converted.buffer } };
        }

        if (isVideoAsset) {
          const url = assertAssetUrlAllowed(rawUrl);
          const cached = await readAssetBufferFromCache(url, 'image');
          if (!cached) {
            throw new Error('Video is not cached. Re-extract the page, then download the ZIP.');
          }
          const filename = url.split('/').pop()?.split('?')[0] || `file-${index + 1}`;
          return { ok: true, entry: { name: filename, buffer: cached.buffer } };
        }

        const url = assertAssetUrlAllowed(rawUrl);
        const looksLikeVideo =
          isLikelyDirectVideoStreamUrl(url) ||
          isLikelyVideoAssetUrl(url) ||
          /\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|$)/i.test(url);
        const looksLikeFont = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url);

        if (looksLikeVideo) {
          const cached = await readAssetBufferFromCache(url, 'image');
          if (!cached) {
            throw new Error('Video is not cached. Re-extract the page, then download the ZIP.');
          }
          const filename = url.split('/').pop()?.split('?')[0] || `file-${index + 1}`;
          return { ok: true, entry: { name: filename, buffer: cached.buffer } };
        }

        if (looksLikeFont) {
          const sourceFormat = getFontFormatFromUrlOrType(url);
          const filenameBase = typeof item?.filenameBase === 'string' ? item.filenameBase : 'font';
          const runFontZipFetch = (cacheOnly: boolean) =>
            convertFontAsset(url, 'ttf', sourceFormat, filenameBase, {
              originalUrl: manifestUrl,
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
              name: buildFontZipEntryName(filenameBase, converted.format || 'ttf'),
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
        return { ok: true, entry: { name: converted.filename, buffer: converted.buffer } };
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
    const zipChunks: Buffer[] = [];
    const zipDone = new Promise<void>((resolve, reject) => {
      archive.on('data', (chunk: Buffer) => zipChunks.push(chunk));
      archive.on('end', () => resolve());
      archive.on('error', reject);
    });
    for (const entry of zipEntries) {
      archive.append(entry.buffer, { name: entry.name });
    }
    await archive.finalize();
    await zipDone;

    const zipBuffer = Buffer.concat(zipChunks);
    const addedCount = zipEntries.filter((entry) => entry.name !== 'asset-paths.txt').length;
    if (req.body?.save === true || String(req.body?.save || '').toLowerCase() === 'true') {
      const requestedFilename = typeof req.body?.filename === 'string' && req.body.filename.trim()
        ? req.body.filename.trim()
        : 'assets.zip';
      const zipSaveKind: DownloadSaveKind =
        /font/i.test(requestedFilename) ||
        list.some((item: any) => typeof item === 'object' && item?.assetType === 'font')
          ? 'font'
          : 'image';
      const saved = await saveBufferToDownloads(
        zipBuffer,
        requestedFilename,
        'Assets ZIP',
        readSourcePageUrl(req),
        zipSaveKind
      );
      res.setHeader('X-Zip-Added-Count', String(addedCount));
      res.setHeader('X-Zip-Failed-Count', String(zipFailures.length));
      return res.json({ ...saved, addedCount, failedCount: zipFailures.length });
    }
    res.setHeader('Content-Disposition', 'attachment; filename="assets.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Zip-Cache-Only', '1');
    res.setHeader('X-Zip-Added-Count', String(addedCount));
    res.setHeader('X-Zip-Failed-Count', String(zipFailures.length));
    res.setHeader('Content-Length', String(zipBuffer.length));
    return res.send(zipBuffer);
  } catch (error: any) {
    console.error('ZIP error:', error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP file' });
    }
  }
});

export async function startServer() {
  await ensureCreativeAssetsFolders(lastExtractedSourceUrl);
  await ensureRuntimeToolsReady();
  activePort = await findAvailablePort(DEFAULT_PORT);
  if (activePort !== DEFAULT_PORT) {
    console.log(`Using another available local port: ${activePort}`);
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrPort = await findAvailablePort(Number(process.env.VITE_HMR_PORT || 24678), 40).catch(() => undefined);
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(hmrPort ? { hmr: { port: hmrPort } } : {}),
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
