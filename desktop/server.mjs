// server.ts
import express from "express";
import path3 from "path";
import rateLimit from "express-rate-limit";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver2 from "archiver";
import extractZip from "extract-zip";
import { URL as URL2 } from "url";
import puppeteer from "puppeteer";
import youtubedlModule from "youtube-dl-exec";
import ytdl from "@distube/ytdl-core";
import { parseSrcset } from "srcset";
import { Font, woff2 } from "fonteditor-core";
import opentype from "opentype.js";
import { Client as FtpClient } from "basic-ftp";
import { Readable } from "stream";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs2 from "fs";
import fsp3 from "fs/promises";
import os3 from "os";
import https from "https";
import net from "net";
import crypto2 from "crypto";
import { execFile as execFile2, spawn as spawn2 } from "child_process";
import { Worker } from "worker_threads";
import { promisify as promisify2 } from "util";
import { createRequire as createRequire2 } from "module";

// server/extract-progress-ws.ts
import { WebSocketServer, WebSocket } from "ws";
var ExtractionProgressManager = class _ExtractionProgressManager {
  constructor() {
    this.clients = /* @__PURE__ */ new Set();
    this.currentPhase = "loading";
    this.currentTask = "Starting extraction\u2026";
    this.currentProfile = null;
    this.currentCounters = { images: 0, videos: 0, fonts: 0, colors: 0 };
    this.terminalEvent = null;
  }
  addClient(ws) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    if (ws.readyState === WebSocket.OPEN) {
      if (this.terminalEvent) {
        ws.send(JSON.stringify({ type: "counters", counters: this.currentCounters }));
        ws.send(JSON.stringify(this.terminalEvent));
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: "phase", phase: this.currentPhase }));
      ws.send(JSON.stringify({ type: "task", task: this.currentTask }));
      if (this.currentProfile) ws.send(JSON.stringify({ type: "profile", profile: this.currentProfile }));
      ws.send(JSON.stringify({ type: "counters", counters: this.currentCounters }));
    }
  }
  broadcast(event) {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
  setPhase(phase) {
    this.currentPhase = phase;
    this.broadcast({ type: "phase", phase });
  }
  setTask(task) {
    this.currentTask = task;
    this.broadcast({ type: "task", task });
  }
  setProfile(profile) {
    this.currentProfile = profile;
    this.broadcast({ type: "profile", profile });
  }
  updateCounters(counters) {
    this.currentCounters = { ...this.currentCounters, ...counters };
    this.broadcast({ type: "counters", counters: this.currentCounters });
  }
  complete(result) {
    this.updateCounters({
      images: Array.isArray(result?.images) ? result.images.length : 0,
      videos: Array.isArray(result?.videos) ? result.videos.length : 0,
      fonts: Array.isArray(result?.fonts) ? result.fonts.length : 0,
      colors: Array.isArray(result?.colors) ? result.colors.length : 0
    });
    this.terminalEvent = { type: "complete", result };
    this.broadcast(this.terminalEvent);
    this.cleanup();
  }
  fail(error) {
    this.terminalEvent = { type: "error", message: error };
    this.broadcast(this.terminalEvent);
    this.cleanup();
  }
  cleanup() {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }
  static {
    this.managerByExtractId = /* @__PURE__ */ new Map();
  }
  static {
    this.globalManager = null;
  }
  static create(extractId) {
    const manager = new _ExtractionProgressManager();
    _ExtractionProgressManager.managerByExtractId.set(extractId, manager);
    return manager;
  }
  static get(extractId) {
    return _ExtractionProgressManager.managerByExtractId.get(extractId);
  }
  static remove(extractId) {
    _ExtractionProgressManager.managerByExtractId.delete(extractId);
  }
};
function setupExtractProgressWS(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/extract" });
  wss.on("connection", (ws, req) => {
    const reqUrl = new URL(req.url || "", "http://localhost");
    const extractId = reqUrl.searchParams.get("extractId");
    if (extractId) {
      const manager = ExtractionProgressManager.get(extractId);
      if (manager) {
        manager.addClient(ws);
        return;
      }
    }
    const globalMgr = ExtractionProgressManager.globalManager;
    if (globalMgr) {
      globalMgr.addClient(ws);
      return;
    }
    ws.close(4e3, "No active extraction for this ID");
  });
  return wss;
}
var globalProgressManager = null;
function setGlobalProgressManager(mgr) {
  globalProgressManager = mgr;
  ExtractionProgressManager.globalManager = mgr;
}

// server/video-downloader-routes.ts
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import fsp2 from "node:fs/promises";
import os2 from "node:os";
import path2 from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import archiver from "archiver";

// src/lib/projectDownloadsPaths.ts
import path from "path";
import os from "os";
import fsp from "fs/promises";

// src/lib/creativeAssetsFolder.ts
var extractSiteKeyFromUrl = (pageUrl) => {
  const raw = String(pageUrl || "").trim();
  if (!raw) return "CreativeAssets";
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") return "youtube";
    const parts = host.split(".").filter(Boolean);
    const site = (parts[0] || "website").replace(/[^a-z0-9]+/gi, "").replace(/-+/g, "").slice(0, 48);
    return site || "website";
  } catch {
    return "CreativeAssets";
  }
};
var buildCreativeAssetsFolderName = (pageUrl) => {
  const site = extractSiteKeyFromUrl(pageUrl);
  if (site === "CreativeAssets") return "CreativeAssets";
  return `${site}_CreativeAssets`;
};
var buildPlatformCreativeAssetsFolderName = (platform) => {
  const safe = String(platform || "video").replace(/[^a-z0-9]+/gi, "").slice(0, 48);
  return `${safe || "video"}_CreativeAssets`;
};

// src/lib/projectDownloadsPaths.ts
var CREATIVE_ASSET_SUBFOLDERS = [
  "Images",
  "Fonts",
  "Colors",
  "Videos"
];
var VIDEO_ASSET_SUBFOLDER = "Videos";
var LEGACY_CREATIVE_ASSET_SUBFOLDERS = [
  "Icons",
  "Screenshots",
  "SelectedAreas",
  "SmokeTest"
];
var LEGACY_IMAGE_SUBFOLDERS = ["Originals", "Thumbnails"];
var DISPOSABLE_FOLDER_ENTRIES = /* @__PURE__ */ new Set([".DS_Store"]);
var resolveDownloadsRoot = () => String(process.env.CAE_DOWNLOADS_DIR || "").trim() || path.join(os.homedir(), "Downloads");
var resolveCreativeAssetsRoot = (sourcePageUrl, options = {}) => {
  const folderName = buildCreativeAssetsFolderName(String(sourcePageUrl || "").trim());
  return path.join(resolveDownloadsRoot(), folderName);
};
var resolveCreativeAssetsDir = (sourcePageUrl, subfolder, options = {}) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl, options);
  return subfolder ? path.join(root, subfolder) : root;
};
var resolvePlatformVideoAssetsDir = (platform) => {
  const root = path.join(resolveDownloadsRoot(), buildPlatformCreativeAssetsFolderName(platform));
  return path.join(root, VIDEO_ASSET_SUBFOLDER);
};
var removeDirectoryWhenEmpty = async (directory) => {
  const entries = await fsp.readdir(directory).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (DISPOSABLE_FOLDER_ENTRIES.has(entry)) {
      await fsp.unlink(path.join(directory, entry)).catch(() => void 0);
    }
  }
  await fsp.rmdir(directory).catch(() => void 0);
};
var removeEmptyCreativeAssetFolders = async (sourcePageUrl) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl);
  const imagesDir = path.join(root, "Images");
  for (const subfolder of LEGACY_IMAGE_SUBFOLDERS) {
    await removeDirectoryWhenEmpty(path.join(imagesDir, subfolder));
  }
  for (const subfolder of LEGACY_CREATIVE_ASSET_SUBFOLDERS) {
    await removeDirectoryWhenEmpty(path.join(root, subfolder));
  }
  for (const subfolder of CREATIVE_ASSET_SUBFOLDERS) {
    await removeDirectoryWhenEmpty(path.join(root, subfolder));
  }
  await removeDirectoryWhenEmpty(root);
};

// server/video-downloader-routes.ts
var execFileAsync = promisify(execFile);
var writeLog = async (jobId, data) => {
  try {
    const logsDir = path2.join(os2.tmpdir(), "creative-asset-extractor", "video-downloader-logs");
    await fsp2.mkdir(logsDir, { recursive: true });
    const logFile = path2.join(logsDir, `${jobId || "unknown"}-${Date.now()}.log`);
    const entry = {
      ...data,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    await fsp2.writeFile(logFile, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch {
  }
};
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var SUPPORTED_PLATFORMS = ["youtube", "vimeo", "instagram", "facebook", "x", "tiktok", "ispot", "brightcove", "direct"];
var jobs = /* @__PURE__ */ new Map();
var pendingJobs = [];
var cancelledJobs = /* @__PURE__ */ new Set();
var activeDownloadProcesses = /* @__PURE__ */ new Map();
var inspectCache = /* @__PURE__ */ new Map();
var activeJobs = 0;
var updatePromise = null;
var lastUpdateAttemptAt = 0;
var now = () => Date.now();
var INSPECT_CACHE_TTL_MS = 10 * 60 * 1e3;
var binaryName = (name) => process.platform === "win32" ? `${name}.exe` : name;
var sanitizeFilenamePart = (value, fallback = "video") => String(value || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 140) || fallback;
var normalizeTrimTime = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+(?:\.\d+)?$/.test(raw)) return raw;
  const parts = raw.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d{1,2}(?:\.\d+)?$/.test(part))) return "";
  const normalized = parts.map((part, index) => {
    if (index === parts.length - 1 && part.includes(".")) return part.padStart(2, "0");
    return String(Number(part)).padStart(2, "0");
  });
  return normalized.join(":");
};
var trimSeconds = (value = "") => {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
};
var normalizeTrimRange = (startInput, endInput) => {
  const startTime = normalizeTrimTime(startInput);
  const endTime = normalizeTrimTime(endInput);
  const startSeconds = trimSeconds(startTime);
  const endSeconds = trimSeconds(endTime);
  if (startTime && startSeconds !== null && startSeconds < 0) return { startTime: "", endTime: "" };
  if (endTime && endSeconds !== null && endSeconds <= 0) return { startTime: "", endTime: "" };
  if (startSeconds !== null && endSeconds !== null && endSeconds <= startSeconds) return { startTime: "", endTime: "" };
  return { startTime, endTime };
};
var trimSectionArgs = (job) => {
  const start = normalizeTrimTime(job.startTime);
  const end = normalizeTrimTime(job.endTime);
  if (!start && !end) return [];
  return ["--download-sections", `*${start || "0"}-${end || "inf"}`];
};
var toDisplayPath = (filePath) => {
  const home = os2.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
};
var isPathInside = (candidate, root) => {
  const resolvedCandidate = path2.resolve(candidate);
  const resolvedRoot = path2.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path2.sep}`);
};
var detectDownloaderPlatform = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube.com") || host === "youtu.be") return "youtube";
    if (host.includes("vimeo.com") || host.includes("vimeocdn.com")) return "vimeo";
    if (host.includes("instagram.com") || host.includes("cdninstagram.com")) return "instagram";
    if (host.includes("facebook.com") || host === "fb.watch" || host.includes("fbcdn.net")) return "facebook";
    if (host === "x.com" || host.includes("twitter.com") || host.includes("twimg.com")) return "x";
    if (host.includes("tiktok.com") || host.includes("tiktokcdn.com")) return "tiktok";
    if (host === "ispot.tv" || host.endsWith(".ispot.tv")) return "ispot";
    if (host === "players.brightcove.net" || host.endsWith(".players.brightcove.net") || host.includes("brightcove.net")) return "brightcove";
    if (/\.(?:mp4|m3u8|mpd|webm|mov)(?:$|\?)/i.test(parsed.href)) return "direct";
    return "unknown";
  } catch {
    return "unknown";
  }
};
var normalizeDownloaderUrl = (rawUrl, platform = detectDownloaderPlatform(rawUrl)) => {
  const parsed = new URL(rawUrl.trim());
  parsed.hash = "";
  if (platform === "x") {
    const match = parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/i);
    if (match) return `https://twitter.com/${match[1]}/status/${match[2]}`;
  }
  if (platform === "instagram") {
    const match = parsed.pathname.match(/^\/(reel|reels|p|tv)\/([^/]+)/i);
    if (match) return `https://www.instagram.com/${match[1] === "reels" ? "reel" : match[1]}/${match[2]}/`;
  }
  if (platform === "facebook" && parsed.hostname === "fb.watch") return parsed.href;
  if (platform === "facebook" && parsed.searchParams.get("v")) {
    return `https://www.facebook.com/watch/?v=${parsed.searchParams.get("v")}`;
  }
  if (!["direct", "youtube", "facebook", "brightcove"].includes(platform)) parsed.search = "";
  return parsed.href;
};
var downloaderUrlCandidates = (url, platform) => {
  if (platform === "x") {
    return Array.from(/* @__PURE__ */ new Set([url, url.replace("twitter.com", "x.com")]));
  }
  if (platform !== "vimeo") return [url];
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "player.vimeo.com") return [url];
    const match = parsed.pathname.match(/\/(\d+)(?:\/([a-z0-9]+))?(?:\/|$)/i);
    if (!match?.[1]) return [url];
    const playerUrl = new URL(`https://player.vimeo.com/video/${match[1]}`);
    if (match[2]) playerUrl.searchParams.set("h", match[2]);
    return Array.from(/* @__PURE__ */ new Set([url, playerUrl.href]));
  } catch {
    return [url];
  }
};
var validateDownloaderUrl = (rawUrl, validateUrl) => {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Paste a valid public video URL.");
  if (/^(?:localhost|127\.|0\.0\.0\.0|::1$)/i.test(parsed.hostname)) {
    throw new Error("Local URLs are not supported in Video Downloader.");
  }
  validateUrl?.(parsed.href);
  const platform = detectDownloaderPlatform(parsed.href);
  if (platform === "unknown") {
    throw new Error("Supported platforms: YouTube, Vimeo, Instagram, Facebook, X.com, TikTok, Brightcove, and iSpot.tv.");
  }
  return { url: normalizeDownloaderUrl(parsed.href, platform), platform };
};
var resolveTool = (options, name) => {
  const fileName = binaryName(name);
  const candidates = [
    path2.join(options.resourcesPath || "", "bin", fileName),
    path2.join(options.appRoot || "", "vendor", "bin-pack", fileName),
    path2.join(options.resourcesPath || "", "vendor", "bin-pack", fileName),
    path2.join(process.cwd(), "vendor", "bin-pack", fileName),
    path2.join(os2.homedir(), ".creative-asset-extractor", "runtime-bin", fileName),
    path2.join(process.cwd(), "runtime-bin", fileName)
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
};
var ensureRuntimeYtDlp = async (options) => {
  const toolPath = resolveTool(options, "yt-dlp");
  if (!toolPath) throw new Error("Video extractor is missing. Reinstall the app.");
  await fsp2.chmod(toolPath, 493).catch(() => void 0);
  return toolPath;
};
var platformHeaders = (platform) => {
  if (platform === "instagram") return ["--referer", "https://www.instagram.com/", "--add-header", "Origin:https://www.instagram.com"];
  if (platform === "facebook") return ["--referer", "https://www.facebook.com/", "--add-header", "Origin:https://www.facebook.com"];
  if (platform === "x") return ["--referer", "https://twitter.com/", "--add-header", "Origin:https://twitter.com"];
  if (platform === "tiktok") return ["--referer", "https://www.tiktok.com/", "--add-header", "Origin:https://www.tiktok.com"];
  if (platform === "vimeo") return ["--referer", "https://vimeo.com/"];
  return [];
};
var commonYtDlpArgs = (options, platform) => {
  const ffmpegPath2 = resolveTool(options, "ffmpeg");
  return [
    "--no-warnings",
    "--no-check-certificates",
    "--no-playlist",
    "--geo-bypass",
    "--force-ipv4",
    "--socket-timeout",
    "25",
    "--retries",
    "3",
    "--extractor-retries",
    "3",
    "--user-agent",
    USER_AGENT,
    ...ffmpegPath2 ? ["--ffmpeg-location", path2.dirname(ffmpegPath2)] : [],
    ...platformHeaders(platform)
  ];
};
var aria2cAvailable = (options) => {
  const aria2Path2 = resolveTool(options, "aria2c");
  return aria2Path2 ? aria2Path2 : "";
};
var toolPathEnv = (options) => {
  const dirs = ["ffmpeg", "ffprobe", "yt-dlp", "aria2c", "deno"].map((tool) => resolveTool(options, tool)).filter(Boolean).map((toolPath) => path2.dirname(toolPath));
  const commonToolDirs = process.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin"];
  return Array.from(/* @__PURE__ */ new Set([...dirs, ...commonToolDirs])).join(path2.delimiter);
};
var normalizeCookiesFilePath = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const expanded = raw.startsWith("~/") ? path2.join(os2.homedir(), raw.slice(2)) : raw;
  try {
    if (!fs.existsSync(expanded)) return "";
    if (!fs.statSync(expanded).isFile()) return "";
    return expanded;
  } catch {
    return "";
  }
};
var cookieAttempts = (_platform, explicitCookiesFilePath = "") => {
  const attempts = [];
  const explicit = normalizeCookiesFilePath(explicitCookiesFilePath);
  if (explicit) attempts.push(["--cookies", explicit]);
  const cookiesFile = String(process.env.VDX_YTDLP_COOKIES_FILE || "").trim();
  const envCookiesFile = normalizeCookiesFilePath(cookiesFile);
  if (envCookiesFile && envCookiesFile !== explicit) attempts.push(["--cookies", envCookiesFile]);
  return attempts;
};
var youtubeClientRetryAttempts = () => [
  ["--extractor-args", "youtube:player_client=android,web_safari,web_embedded,ios,tv_embedded"],
  ["--extractor-args", "youtube:player_client=android"],
  ["--extractor-args", "youtube:player_client=web_safari"],
  ["--extractor-args", "youtube:player_client=web_embedded"],
  ["--extractor-args", "youtube:player_client=ios"],
  ["--extractor-args", "youtube:player_client=tv_embedded"]
];
var errorText = (error) => [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n").trim();
var decodeBasicHtmlEntities = (value) => String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
var decodeInstagramUrlCandidate = (value) => {
  let decoded = decodeBasicHtmlEntities(String(value || "").trim());
  try {
    decoded = JSON.parse(`"${decoded.replace(/"/g, '\\"')}"`);
  } catch {
  }
  return decodeBasicHtmlEntities(decoded).replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u0025/gi, "%").replace(/\\\//g, "/").trim();
};
var looksLikeInstagramMediaUrl = (value) => {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return /\.(?:mp4|m3u8)(?:$|\?)/i.test(parsed.href);
  } catch {
    return false;
  }
};
var pushInstagramCandidate = (candidates, value) => {
  const decoded = decodeInstagramUrlCandidate(value);
  if (looksLikeInstagramMediaUrl(decoded) && !candidates.includes(decoded)) candidates.push(decoded);
};
var extractInstagramPublicMediaUrls = (html) => {
  const candidates = [];
  const decodedHtml = decodeBasicHtmlEntities(html);
  const sources = [html, decodedHtml];
  for (const source of sources) {
    for (const match of source.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*content=["']([^"']+)["'][^>]*>/gi)) {
      pushInstagramCandidate(candidates, match[1] || "");
    }
    for (const match of source.matchAll(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi)) {
      pushInstagramCandidate(candidates, match[1] || "");
    }
    for (const match of source.matchAll(/["'](?:video_url|playback_url|contentUrl|download_url|url)["']\s*:\s*["']([^"']+)["']/gi)) {
      pushInstagramCandidate(candidates, match[1] || "");
    }
    for (const match of source.matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+(?:\.mp4|\.m3u8)[^"'<>\\\s]*/gi)) {
      pushInstagramCandidate(candidates, match[0] || "");
    }
  }
  return candidates;
};
var resolveInstagramPublicMediaUrls = async (url, jobId) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.instagram.com/",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document"
      }
    });
    const html = await response.text();
    const urls = response.ok ? extractInstagramPublicMediaUrls(html) : [];
    void writeLog(jobId, {
      event: "instagram_public_resolver",
      status: response.status,
      media_url_count: urls.length,
      final_url: response.url
    });
    return urls;
  } catch (error) {
    void writeLog(jobId, { event: "instagram_public_resolver_error", error: errorText(error) });
    return [];
  } finally {
    clearTimeout(timeout);
  }
};
var parseYtDlpProgressLine = (line) => {
  if (line.startsWith("__VDX_PROGRESS__|")) {
    const [, percentText, downloadedText, totalText, speed, eta] = line.split("|");
    return {
      percent: Number(String(percentText || "").replace("%", "").trim()),
      downloadedBytes: Number(downloadedText || 0) || void 0,
      totalBytes: Number(totalText || 0) || void 0,
      speed: String(speed || "").trim() || void 0,
      eta: String(eta || "").trim() || void 0
    };
  }
  const percentMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i) || line.match(/\((\d+(?:\.\d+)?)%\)/);
  if (!percentMatch?.[1]) return null;
  const speedMatch = line.match(/\b(?:at|DL:)\s*([0-9.]+\s*[KMGT]?i?B\/s)/i);
  const etaMatch = line.match(/\bETA\s*([0-9:]+|[0-9]+s)/i);
  return {
    percent: Number(percentMatch[1]),
    speed: speedMatch?.[1]?.trim(),
    eta: etaMatch?.[1]?.trim()
  };
};
var isXGuestTokenError = (message) => /bad guest token|guest token|twitter.*querying api|x\.com.*extract/i.test(message);
var isAuthLikeError = (message) => /login|logged-?in|cookie|private|sign in|authentication|not available|rate.?limit|guest token|requested content is not available|empty media response|media response is empty|accessible in your browser|use --cookies(?:-from-browser)?|checkpoint|challenge_required/i.test(message);
var isYouTubeUnavailableError = (message) => /(?:\[youtube\].*)?(?:this video is not available|video unavailable|private video|members-only|sign in to confirm|not available in your country|copyright|removed by the uploader)/i.test(
  message
);
var friendlyDownloaderError = (platform, message) => {
  if (platform === "brightcove" && /VIDEO_NOT_FOUND|designated resource was not found/i.test(message)) {
    return "Brightcove video was not found. It may have been removed, unpublished, or the video ID is incorrect.";
  }
  if (/X\.com extraction needs updated engine|Instagram could not refresh|Facebook could not access|No downloadable video stream|Video extraction failed/i.test(
    message
  )) {
    return message;
  }
  if (platform === "x" && isXGuestTokenError(message)) {
    return "X.com extraction needs updated engine. Updating extractor or trying fallback route...";
  }
  if (platform === "instagram" && isAuthLikeError(message)) {
    return "Instagram requires cookies.txt for this reel. Paste a valid cookies.txt file path above and try again.";
  }
  if (platform === "facebook" && isAuthLikeError(message)) {
    return "Facebook could not access this public video. Confirm the video is public, then retry.";
  }
  if (platform === "youtube" && isYouTubeUnavailableError(message)) {
    return "YouTube says this video is unavailable from this connection. It may be private, removed, region-blocked, age-restricted, or temporarily blocked. Use the YT5S backup button below, or try again with a different network/VPN.";
  }
  if (/unsupported url/i.test(message)) return "This link is not supported by the current video extractor.";
  if (/no video formats|no formats|no downloadable/i.test(message)) return "No downloadable video stream was found for this link.";
  if (/ffmpeg.*not found|ffprobe.*not found|--ffmpeg-location/i.test(message)) return "Video processing tools are not available. Reinstall the app.";
  if (/permission denied|operation not permitted|errno 1/i.test(message)) return "Video tools permission error. Try reinstalling the DMG.";
  if (/no such file|ENOENT|spawn/i.test(message)) return "Video engine failed to launch. Missing binary in app bundle.";
  const short = message.split("\n")[0].slice(0, 150);
  if (short.length > 10) return short;
  return "Video download failed. Please try again or report the issue from the app.";
};
var updateYtDlp = async (options) => {
  if (updatePromise) return updatePromise;
  if (now() - lastUpdateAttemptAt < 10 * 60 * 1e3) return false;
  lastUpdateAttemptAt = now();
  updatePromise = (async () => {
    try {
      const ytdlp = await ensureRuntimeYtDlp(options);
      await execFileAsync(ytdlp, ["--update-to", "stable"], { timeout: 12e4, maxBuffer: 4 * 1024 * 1024 });
      return true;
    } catch (error) {
      console.warn("[video-downloader] yt-dlp update skipped:", errorText(error).slice(0, 400));
      return false;
    } finally {
      updatePromise = null;
    }
  })();
  return updatePromise;
};
var runYtDlpJson = async (options, url, platform, extraArgs = []) => {
  const ytdlp = await ensureRuntimeYtDlp(options);
  const args = [
    ...commonYtDlpArgs(options, platform),
    "--dump-single-json",
    "--skip-download",
    ...extraArgs,
    url
  ];
  const { stdout } = await execFileAsync(ytdlp, args, {
    timeout: platform === "vimeo" ? 13e4 : 75e3,
    maxBuffer: 80 * 1024 * 1024
  });
  return JSON.parse(String(stdout || "").trim());
};
var extractViaVxTwitter = async (url) => {
  const parsed = new URL(url);
  const response = await fetch(`https://vxtwitter.com${parsed.pathname}`, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" }
  });
  if (!response.ok) throw new Error(`X fallback returned ${response.status}`);
  const html = await response.text();
  const pick = (...patterns) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1].replace(/&amp;/g, "&");
    }
    return "";
  };
  const videoUrl = pick(
    /<meta\s+property=["']og:video(?::url)?["']\s+content=["']([^"']+)/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:video(?::url)?["']/i
  );
  if (!videoUrl) throw new Error("X fallback did not expose a public video.");
  return {
    id: parsed.pathname.match(/\/status\/(\d+)/)?.[1] || crypto.randomUUID(),
    title: pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || "X video",
    thumbnail: pick(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i),
    webpage_url: url,
    url: videoUrl,
    ext: "mp4",
    formats: [{ url: videoUrl, ext: "mp4", vcodec: "h264", acodec: "aac", height: 720 }]
  };
};
var inspectWithFallbacks = async (options, rawUrl, platform) => {
  const url = normalizeDownloaderUrl(rawUrl, platform);
  let lastError;
  const urls = downloaderUrlCandidates(url, platform);
  for (const candidate of urls) {
    try {
      return await runYtDlpJson(options, candidate, platform);
    } catch (error) {
      lastError = error;
    }
  }
  const firstMessage = errorText(lastError);
  if (platform === "x" && isXGuestTokenError(firstMessage)) {
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
  if (platform === "x") {
    try {
      return await extractViaVxTwitter(url);
    } catch (error) {
      lastError = error;
    }
  }
  void writeLog(void 0, {
    event: "inspect_failed",
    platform,
    url: rawUrl,
    last_error: errorText(lastError)
  });
  throw new Error(friendlyDownloaderError(platform, errorText(lastError)));
};
var bestThumbnail = (info) => {
  const thumbnails = Array.isArray(info?.thumbnails) ? info.thumbnails : [];
  return String(
    thumbnails.filter((item) => item?.url).sort((a, b) => Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0]?.url || info?.thumbnail || ""
  );
};
var infoToCards = (info, sourceUrl, platform) => {
  const rawEntries = Array.isArray(info?.entries) && info.entries.length > 0 ? info.entries : [info];
  const seen = /* @__PURE__ */ new Set();
  const cards = [];
  for (const entry of rawEntries.filter(Boolean)) {
    const formats = Array.isArray(entry?.formats) ? entry.formats : [];
    const videoFormats = formats.filter((format) => String(format?.vcodec || "") !== "none");
    const audioFormats = formats.filter((format) => String(format?.acodec || "") !== "none");
    const maxHeight = Math.max(
      Number(entry?.height || 0),
      ...videoFormats.map((format) => Number(format?.height || 0))
    );
    const id = String(entry?.id || entry?.display_id || entry?.webpage_url || sourceUrl);
    const cardUrl = String(entry?.webpage_url || entry?.original_url || sourceUrl);
    const key = `${platform}:${id}:${cardUrl.replace(/[?#].*$/, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hasVideo = videoFormats.length > 0 || Boolean(entry?.url);
    const fhdAvailable = hasVideo;
    const hdAvailable = hasVideo;
    const audioAvailable = audioFormats.length > 0 || String(entry?.acodec || "") !== "none";
    cards.push({
      id,
      url: cardUrl,
      title: String(entry?.title || entry?.fulltitle || `${platform} video`).trim(),
      thumbnail: bestThumbnail(entry),
      duration: Number(entry?.duration || 0) || void 0,
      provider: platform,
      platform,
      maxHeight: maxHeight || void 0,
      defaultQualityKey: fhdAvailable ? "fhd" : "hd",
      displayQualityLabel: fhdAvailable ? "FHD" : "HD",
      qualityVariants: {
        fhd: { formatAvailable: fhdAvailable },
        hd: { formatAvailable: hdAvailable }
      },
      streams: {
        FHD: { ready: fhdAvailable },
        HD: { ready: hdAvailable }
      },
      audioAvailable,
      noAudio: !audioAvailable,
      fallbackMessage: maxHeight > 0 && maxHeight < 1e3 ? `Best available quality is ${maxHeight}p. The FHD download will use the best available MP4.` : void 0
    });
  }
  return cards;
};
var specialPayloadToCards = (payload, sourceUrl, platform) => {
  const videos = Array.isArray(payload?.videos) ? payload.videos : [];
  const seen = /* @__PURE__ */ new Set();
  return videos.map((video, index) => {
    const id = String(video?.id || video?.formatId || video?.url || index);
    const key = `${platform}:${id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const hasVideo = Boolean(
      video?.qualityVariants?.fhd?.formatAvailable ?? video?.qualityVariants?.hd?.formatAvailable ?? video?.streams?.FHD?.ready ?? video?.streams?.HD?.ready ?? video?.url
    );
    const maxHeight = Number(video?.height || video?.maxHeight || 0) || 0;
    const fhdAvailable = hasVideo;
    const hdAvailable = hasVideo && Boolean(video?.qualityVariants?.hd?.formatAvailable ?? video?.streams?.HD?.ready ?? true);
    const audioAvailable = video?.audioAvailable !== false && video?.noAudio !== true;
    return {
      id,
      url: sourceUrl,
      title: String(video?.title || `${platform} video`),
      thumbnail: String(video?.thumbnail || ""),
      duration: Number(video?.duration || video?.durationSeconds || 0) || void 0,
      provider: platform,
      platform,
      maxHeight: maxHeight || void 0,
      defaultQualityKey: fhdAvailable ? "fhd" : "hd",
      displayQualityLabel: fhdAvailable ? "FHD" : "HD",
      qualityVariants: {
        fhd: { formatAvailable: fhdAvailable },
        hd: { formatAvailable: hdAvailable }
      },
      streams: {
        FHD: { ready: fhdAvailable },
        HD: { ready: hdAvailable }
      },
      audioAvailable,
      noAudio: !audioAvailable,
      fallbackMessage: video?.fallbackMessage || (maxHeight > 0 && maxHeight < 1e3 ? `Best available quality is ${maxHeight}p. The FHD download will use the best available MP4.` : void 0)
    };
  }).filter(Boolean);
};
var updateJob = (job, patch) => {
  Object.assign(job, patch, { updatedAt: now() });
};
var isJobCancelled = (job) => cancelledJobs.has(job.id) || job.status === "cancelled";
var throwIfJobCancelled = (job) => {
  if (isJobCancelled(job)) throw new Error("Download cancelled by user.");
};
var formatSelector = (platform, quality, fallback = false) => {
  if (quality === "audio") return "bestaudio/best";
  const height = quality === "4k" ? 2160 : quality === "fhd" ? 1080 : 720;
  if (platform === "youtube") {
    if (!fallback) {
      if (quality === "4k") {
        return [
          `bestvideo[height<=${height}][vcodec^=vp9]+bestaudio[ext=m4a]`,
          `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
          `bestvideo[height<=${height}]+bestaudio`,
          `best[height<=${height}][ext=mp4][vcodec!=none][acodec!=none]`,
          `best[height<=${height}][vcodec!=none][acodec!=none]`,
          "best"
        ].join("/");
      }
      return [
        `bestvideo[height<=${height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio`,
        `best[height<=${height}][ext=mp4][vcodec!=none][acodec!=none]`,
        `best[height<=${height}][vcodec!=none][acodec!=none]`,
        `bestvideo[height<=${height}]+bestaudio`,
        "best"
      ].join("/");
    }
    return `best[height<=${height}]/bestvideo[height<=${height}]+bestaudio/best`;
  }
  if (platform === "vimeo" || platform === "brightcove") {
    return [
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=mp4]`,
      `bestvideo[height<=${height}]+bestaudio`,
      `best[height<=${height}][ext=mp4]`,
      `best[height<=${height}]`,
      "best"
    ].join("/");
  }
  if (platform === "instagram" || platform === "facebook" || platform === "x" || platform === "tiktok") {
    return "best[ext=mp4]/best";
  }
  return `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`;
};
var runToolJson = async (toolPath, args) => {
  const { stdout } = await execFileAsync(toolPath, args, { timeout: 12e4, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(String(stdout || "{}"));
};
var probeMedia = async (options, filePath) => {
  const ffprobePath = resolveTool(options, "ffprobe");
  if (!ffprobePath) throw new Error("ffprobe is missing. Run npm install, then restart the app.");
  return runToolJson(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath]);
};
var isQuickTimeCompatible = (probe) => {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  const formatNames = String(probe?.format?.format_name || "").toLowerCase().split(",");
  const videoCodec = String(video?.codec_name || video?.codec_tag_string || "").toLowerCase();
  const audioCodec = String(audio?.codec_name || audio?.codec_tag_string || "").toLowerCase();
  const pixFmt = String(video?.pix_fmt || "").toLowerCase();
  return formatNames.includes("mp4") && (videoCodec === "h264" || videoCodec === "avc1") && (!audio || audioCodec === "aac") && (!pixFmt || pixFmt === "yuv420p");
};
var replaceFile = async (source, target) => {
  await fsp2.rm(target, { force: true }).catch(() => void 0);
  await fsp2.rename(source, target);
};
var encodeQuickTimeMp4 = async (ffmpegPath2, inputPath, outputPath, durationSeconds, jobId, fast4k = false) => {
  const videoArgs = fast4k ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "20"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];
  const args = [
    "-y",
    "-i",
    inputPath,
    ...videoArgs,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath2, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    if (jobId) activeDownloadProcesses.set(jobId, child);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const match = text.match(/out_time_us=(\d+)/);
      if (!match || !jobId || durationSeconds <= 0) return;
      const currentSeconds = Number(match[1]) / 1e6;
      const job = jobs.get(jobId);
      if (!job || job.status !== "running") return;
      const phaseStart = fast4k ? 86 : 95;
      const phaseSpan = fast4k ? 11.8 : 2.8;
      updateJob(job, {
        progress: Math.min(97.8, phaseStart + currentSeconds / durationSeconds * phaseSpan),
        message: fast4k ? "Converting 4K to Mac-compatible MP4..." : "Optimizing for QuickTime..."
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2e4) stderr = stderr.slice(-2e4);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (jobId) activeDownloadProcesses.delete(jobId);
      const job = jobId ? jobs.get(jobId) : void 0;
      if (job && isJobCancelled(job)) {
        reject(new Error("Download cancelled by user."));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `QuickTime conversion exited with code ${code}.`));
      }
    });
  });
};
var ensureQuickTimeMp4 = async (options, inputPath, jobId, fast4k = false) => {
  const ffmpegPath2 = resolveTool(options, "ffmpeg");
  if (!ffmpegPath2) throw new Error("ffmpeg is missing. Run npm install, then restart the app.");
  const probeStart = Date.now();
  const probe = await probeMedia(options, inputPath);
  const probeMs = Date.now() - probeStart;
  void writeLog(jobId, { event: "qt_probe", probe_ms: probeMs });
  const quickTimeOk = isQuickTimeCompatible(probe);
  if (quickTimeOk) {
    void writeLog(jobId, { event: "qt_skip", reason: "already_compatible" });
    return inputPath;
  }
  const outputPath = /\.mp4$/i.test(inputPath) ? inputPath : inputPath.replace(/\.[^.]+$/, "") + ".mp4";
  const tempOutput = path2.join(path2.dirname(outputPath), `.${path2.basename(outputPath, path2.extname(outputPath))}.${crypto.randomUUID()}.mp4`);
  const encodeStart = Date.now();
  const durationSeconds = Number(probe?.format?.duration || 0);
  await encodeQuickTimeMp4(ffmpegPath2, inputPath, tempOutput, durationSeconds, jobId, fast4k);
  void writeLog(jobId, { event: "qt_encode", encode_ms: Date.now() - encodeStart });
  await replaceFile(tempOutput, outputPath);
  if (path2.resolve(inputPath) !== path2.resolve(outputPath)) await fsp2.rm(inputPath, { force: true }).catch(() => void 0);
  return outputPath;
};
var runDownloadAttempt = async (options, job, url, extraArgs = []) => {
  throwIfJobCancelled(job);
  const attemptStart = Date.now();
  const ytdlp = await ensureRuntimeYtDlp(options);
  const platformDir = job.saveToWebsiteAssets && job.sourcePageUrl ? resolveCreativeAssetsDir(job.sourcePageUrl, "Videos") : resolvePlatformVideoAssetsDir(job.platform);
  const timestamp = new Date(job.createdAt).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  await fsp2.mkdir(platformDir, { recursive: true });
  const outputTemplate = path2.join(platformDir, `${timestamp}_${job.platform}_${job.quality}_%(title).140B [%(id)s].%(ext)s`);
  const ffmpegPath2 = resolveTool(options, "ffmpeg");
  const aria2Path2 = aria2cAvailable(options);
  const hasAria2 = extraArgs.includes("--no-aria2") || job.platform === "youtube" ? false : Boolean(aria2Path2);
  const isBitmovinManifest = /streams\.bitmovin\.com\/.*\.m3u8(?:[?#]|$)/i.test(url) || /\.m3u8(?:[?#]|$)/i.test(url) && /^https?:\/\/(?:[^/]+\.)?xtandi\.com(?:[/:?#]|$)/i.test(String(job.sourcePageUrl || ""));
  void writeLog(job.id, {
    event: "download_start",
    ytdlp_path: ytdlp,
    ffmpeg_path: ffmpegPath2 || "not found",
    aria2c_path: aria2Path2 || "not found (disabled)",
    platform: job.platform,
    quality: job.quality,
    url
  });
  const args = [
    ...commonYtDlpArgs(options, job.platform),
    "--newline",
    "--progress",
    "--progress-template",
    "__VDX_PROGRESS__|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--print",
    "after_move:__VDX_FILE__:%(filepath)s",
    "--print",
    "after_move:__VDX_TITLE__:%(title)s",
    "--print",
    "before_dl:__VDX_THUMB__:%(thumbnail)s",
    "--windows-filenames",
    "--trim-filenames",
    "180",
    "--force-overwrites",
    "--no-part",
    "--output",
    outputTemplate,
    "--format",
    isBitmovinManifest && job.quality !== "audio" ? "bestvideo+bestaudio/best" : formatSelector(job.platform, job.quality, Boolean(extraArgs.includes("--quality-fallback"))),
    ...hasAria2 ? ["--downloader", "aria2c", "--downloader-args", "aria2c:-x 32 -s 32 -k 2M"] : [],
    "--concurrent-fragments",
    "32",
    "--buffer-size",
    "128K",
    ...trimSectionArgs(job),
    ...job.quality === "audio" ? ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "128K", "--postprocessor-args", "ffmpeg:-t 120"] : ["--merge-output-format", "mp4", "--remux-video", "mp4", "--postprocessor-args", "ffmpeg:-c copy -movflags +faststart"],
    ...extraArgs.filter((a) => !a.startsWith("--no-aria2") && !a.startsWith("--quality-fallback")),
    url
  ];
  return new Promise((resolve, reject) => {
    updateJob(job, {
      progress: 5,
      message: "Starting download..."
    });
    const extraPath = toolPathEnv(options);
    const child = spawn(ytdlp, args, {
      env: { ...process.env, PATH: extraPath ? `${extraPath}${path2.delimiter}${process.env.PATH || ""}` : process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    activeDownloadProcesses.set(job.id, child);
    let stdout = "";
    let stderr = "";
    let filePath = "";
    let resolvedTitle = "";
    let thumbnail = "";
    let lastProgressTime = null;
    const softProgressForElapsed = () => Math.min(35, Math.max(job.progress, 6 + Math.floor((Date.now() - attemptStart) / 4e3) * 2));
    const watchdogInterval = setInterval(() => {
      if (job.status === "paused") return;
      if (lastProgressTime === null) {
        if (Date.now() - attemptStart > 4e3 && job.status === "running" && job.progress < 35) {
          updateJob(job, {
            progress: softProgressForElapsed(),
            message: "Preparing video stream..."
          });
        }
        return;
      }
      const elapsed = Date.now() - lastProgressTime;
      if (elapsed > 12e4) {
        child.kill();
        clearInterval(watchdogInterval);
        reject(new Error("Download took too long. The video may be unavailable or very large."));
        return;
      }
      if (elapsed > 5e3 && job.status === "running" && job.progress < 85) {
        updateJob(job, {
          progress: softProgressForElapsed(),
          message: elapsed > 3e4 ? "Still downloading..." : "Downloading..."
        });
      }
    }, 5e3);
    const consume = (chunk, isError) => {
      const text = chunk.toString();
      if (isError) stderr += text;
      else stdout += text;
      if (lastProgressTime === null) lastProgressTime = Date.now();
      for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        const parsedProgress = parseYtDlpProgressLine(line);
        if (parsedProgress) {
          const ytProgress = parsedProgress.percent;
          const mapped = Number.isFinite(ytProgress) ? 5 + ytProgress * 0.8 : job.progress;
          lastProgressTime = Date.now();
          updateJob(job, {
            progress: Math.max(5, Math.min(mapped, 85)),
            downloadedBytes: parsedProgress.downloadedBytes || job.downloadedBytes,
            totalBytes: parsedProgress.totalBytes || job.totalBytes,
            speed: parsedProgress.speed || job.speed,
            eta: parsedProgress.eta || job.eta,
            message: "Downloading video stream..."
          });
        }
        if (/^\[Merger\]/i.test(line)) {
          updateJob(job, {
            progress: Math.max(job.progress, 85),
            message: "Merging video + audio..."
          });
        }
        if (line.startsWith("__VDX_FILE__:")) filePath = line.slice("__VDX_FILE__:".length).trim();
        if (line.startsWith("__VDX_TITLE__:")) resolvedTitle = line.slice("__VDX_TITLE__:".length).trim();
        if (line.startsWith("__VDX_THUMB__:")) thumbnail = line.slice("__VDX_THUMB__:".length).trim();
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, false));
    child.stderr.on("data", (chunk) => consume(chunk, true));
    child.on("error", (error) => {
      clearInterval(watchdogInterval);
      activeDownloadProcesses.delete(job.id);
      void writeLog(job.id, { event: "spawn_error", error: error.message });
      reject(error);
    });
    child.on("close", async (code) => {
      clearInterval(watchdogInterval);
      activeDownloadProcesses.delete(job.id);
      if (isJobCancelled(job)) {
        reject(new Error("Download cancelled by user."));
        return;
      }
      void writeLog(job.id, {
        event: "download_exit",
        exit_code: code,
        stdout: stdout.slice(0, 1e4),
        stderr: stderr.slice(0, 1e4),
        ytdlp_path: ytdlp,
        ffmpeg_path: ffmpegPath2 || "not found",
        aria2c_path: aria2Path2 || "not found",
        command: `yt-dlp ${args.slice(0, 20).join(" ")} ...`
      });
      if (code !== 0) {
        reject(Object.assign(new Error(stderr || stdout || `yt-dlp exited with ${code}`), { stderr, stdout }));
        return;
      }
      if (!filePath || !fs.existsSync(filePath)) {
        const files = await listFilesRecursive(platformDir).catch(() => []);
        filePath = files.sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.path || "";
      }
      if (!filePath || !fs.existsSync(filePath)) {
        reject(new Error("Download finished but no output file was found."));
        return;
      }
      const downloadMs = Date.now() - attemptStart;
      void writeLog(job.id, { event: "download_ok", download_ms: downloadMs, file_path: filePath });
      resolve({ filePath, title: resolvedTitle, thumbnail });
    });
  });
};
var runDownloadWithFallbacks = async (options, job) => {
  throwIfJobCancelled(job);
  const normalizedUrl = normalizeDownloaderUrl(job.url, job.platform);
  const urls = downloaderUrlCandidates(normalizedUrl, job.platform);
  let lastError;
  const aria2 = aria2cAvailable(options);
  if (aria2) {
    for (const url of urls) {
      throwIfJobCancelled(job);
      try {
        return await runDownloadAttempt(options, job, url);
      } catch (error) {
        lastError = error;
        void writeLog(job.id, { event: "fallback_no_aria2", error: errorText(error) });
      }
    }
  }
  for (const url of urls) {
    throwIfJobCancelled(job);
    try {
      return await runDownloadAttempt(options, job, url, ["--no-aria2"]);
    } catch (error) {
      lastError = error;
    }
  }
  if (job.platform === "instagram") {
    updateJob(job, { message: "Checking Instagram public media..." });
    const publicMediaUrls = Array.from(
      new Set((await Promise.all(urls.map((url) => resolveInstagramPublicMediaUrls(url, job.id)))).flat())
    );
    for (const mediaUrl of publicMediaUrls) {
      throwIfJobCancelled(job);
      try {
        updateJob(job, { message: "Downloading resolved Instagram media..." });
        return await runDownloadAttempt(options, job, mediaUrl, ["--no-aria2"]);
      } catch (error) {
        lastError = error;
        void writeLog(job.id, { event: "fallback_instagram_public_media", media_url: mediaUrl, error: errorText(error) });
      }
    }
  }
  if (isAuthLikeError(errorText(lastError))) {
    updateJob(job, { message: job.cookiesFilePath ? "Trying with cookies.txt..." : "Cookies.txt required for this source..." });
    for (const cookies of cookieAttempts(job.platform, job.cookiesFilePath)) {
      for (const url of urls) {
        throwIfJobCancelled(job);
        try {
          return await runDownloadAttempt(options, job, url, [...cookies, "--no-aria2"]);
        } catch (error) {
          lastError = error;
          void writeLog(job.id, { event: "fallback_cookies", error: errorText(error) });
        }
      }
    }
  }
  if (job.platform === "youtube" && isYouTubeUnavailableError(errorText(lastError))) {
    updateJob(job, { message: "Refreshing YouTube engine..." });
    await updateYtDlp(options);
    for (const clientArgs of youtubeClientRetryAttempts()) {
      for (const url of urls) {
        throwIfJobCancelled(job);
        try {
          updateJob(job, { message: "Retrying with alternate YouTube client..." });
          return await runDownloadAttempt(options, job, url, ["--no-aria2", ...clientArgs]);
        } catch (error) {
          lastError = error;
          void writeLog(job.id, {
            event: "fallback_youtube_client",
            client_args: clientArgs.join(" "),
            error: errorText(error)
          });
        }
      }
    }
  }
  if (job.quality === "4k" || job.quality === "fhd") {
    updateJob(job, { message: "Retrying with best available quality..." });
    for (const url of urls) {
      throwIfJobCancelled(job);
      try {
        return await runDownloadAttempt(options, job, url, ["--no-aria2", "--quality-fallback"]);
      } catch (error) {
        lastError = error;
        void writeLog(job.id, { event: "fallback_best_available_quality", error: errorText(error) });
      }
    }
  }
  if (job.platform === "x" && isXGuestTokenError(errorText(lastError))) {
    updateJob(job, { message: "X.com extraction needs updated engine. Updating extractor or trying fallback route..." });
    await updateYtDlp(options);
    for (const url of urls) {
      try {
        return await runDownloadAttempt(options, job, url, ["--no-aria2"]);
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (job.platform === "x") {
    const fallbackInfo = await extractViaVxTwitter(normalizedUrl).catch(() => null);
    const fallbackUrl = String(fallbackInfo?.url || "");
    if (fallbackUrl) {
      updateJob(job, { message: "Using X.com fallback route..." });
      try {
        return await runDownloadAttempt(options, job, fallbackUrl, ["--no-aria2"]);
      } catch (error) {
        lastError = error;
      }
    }
  }
  const finalMessage = errorText(lastError);
  void writeLog(job.id, {
    event: "all_fallbacks_exhausted",
    final_error: finalMessage
  });
  throw new Error(friendlyDownloaderError(job.platform, finalMessage));
};
var sidecarPathFor = (filePath) => `${filePath}.creative-assets.json`;
var readSidecar = async (filePath) => {
  const raw = await fsp2.readFile(sidecarPathFor(filePath), "utf8").catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};
var writeSidecar = async (filePath, metadata) => {
  await fsp2.writeFile(sidecarPathFor(filePath), `${JSON.stringify(metadata, null, 2)}
`, "utf8").catch(() => void 0);
};
var openLocalPath = async (filePath) => {
  if (process.platform === "darwin") return execFileAsync("open", [filePath]);
  if (process.platform === "win32") return execFileAsync("cmd", ["/c", "start", "", filePath]);
  return execFileAsync("xdg-open", [filePath]);
};
var revealLocalPath = async (filePath) => {
  if (process.platform === "darwin") return execFileAsync("open", ["-R", filePath]);
  if (process.platform === "win32") return execFileAsync("explorer.exe", ["/select,", filePath]);
  return openLocalPath(path2.dirname(filePath));
};
var listFilesRecursive = async (root) => {
  const output = [];
  const walk = async (directory) => {
    const entries = await fsp2.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path2.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".creative-assets.json")) continue;
      if (/\.zip$/i.test(entry.name)) continue;
      const stat = await fsp2.stat(fullPath).catch(() => null);
      if (!stat) continue;
      const relativePath = path2.relative(path2.join(os2.homedir(), "Downloads"), fullPath);
      const metadata = await readSidecar(fullPath);
      output.push({
        name: entry.name,
        title: metadata.title || path2.basename(entry.name, path2.extname(entry.name)),
        thumbnail: metadata.thumbnail || "",
        platform: metadata.platform || path2.basename(path2.dirname(root)).replace(/_CreativeAssets$/i, ""),
        status: metadata.status || "completed",
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        path: fullPath,
        displayPath: toDisplayPath(fullPath),
        relativePath,
        quality: metadata.quality || (/audio|\.m4a$|\.mp3$/i.test(fullPath) ? "Audio" : /1080|fhd/i.test(fullPath) ? "FHD" : /720|hd/i.test(fullPath) ? "HD" : "Video"),
        zipPath: metadata.zipPath || "",
        zipDisplayPath: metadata.zipDisplayPath || "",
        zipRelativePath: metadata.zipRelativePath || "",
        sourcePageUrl: metadata.sourcePageUrl || "",
        saveToWebsiteAssets: metadata.saveToWebsiteAssets === true
      });
    }
  };
  await walk(root);
  return output;
};
var listDownloaderFiles = async () => {
  const output = [];
  for (const platform of SUPPORTED_PLATFORMS) {
    const videosDir = resolvePlatformVideoAssetsDir(platform);
    output.push(...await listFilesRecursive(videosDir));
  }
  output.push(...await listCompletedJobFiles());
  const seen = /* @__PURE__ */ new Set();
  return output.filter((item) => {
    const key = path2.resolve(item.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.modifiedAt - a.modifiedAt);
};
var listCompletedJobFiles = async () => {
  const downloadsRoot = path2.join(os2.homedir(), "Downloads");
  const output = [];
  for (const job of jobs.values()) {
    if (job.status !== "completed") continue;
    const result = job.result || {};
    const filePath = String(result.filePath || "");
    if (!filePath || !isPathInside(filePath, downloadsRoot)) continue;
    const stat = await fsp2.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const metadata = await readSidecar(filePath);
    output.push({
      name: path2.basename(filePath),
      title: metadata.title || result.title || job.title || path2.basename(filePath, path2.extname(filePath)),
      thumbnail: metadata.thumbnail || result.thumbnail || "",
      platform: metadata.platform || result.platform || job.platform,
      status: metadata.status || "completed",
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      path: filePath,
      displayPath: metadata.displayPath || result.displayPath || toDisplayPath(filePath),
      relativePath: path2.relative(downloadsRoot, filePath),
      quality: metadata.quality || result.quality || job.quality,
      zipPath: metadata.zipPath || "",
      zipDisplayPath: metadata.zipDisplayPath || "",
      zipRelativePath: metadata.zipRelativePath || "",
      sourcePageUrl: metadata.sourcePageUrl || job.sourcePageUrl || "",
      saveToWebsiteAssets: metadata.saveToWebsiteAssets === true || job.saveToWebsiteAssets === true
    });
  }
  return output;
};
var removeEmptyParents = async (directory, stopAt) => {
  let current = directory;
  while (isPathInside(current, stopAt) && path2.resolve(current) !== path2.resolve(stopAt)) {
    const entries = await fsp2.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) break;
    await fsp2.rmdir(current).catch(() => void 0);
    current = path2.dirname(current);
  }
};
var removeDirectoryIfEmpty = async (directory) => {
  const entries = await fsp2.readdir(directory).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (entry === ".DS_Store") {
      await fsp2.unlink(path2.join(directory, entry)).catch(() => void 0);
    }
  }
  await fsp2.rmdir(directory).catch(() => void 0);
};
var removePlatformDownloadFolder = async (platform) => {
  const videosDir = resolvePlatformVideoAssetsDir(platform);
  const platformRoot = path2.dirname(videosDir);
  await fsp2.rm(platformRoot, { recursive: true, force: true });
};
var cleanupListedDownloadParents = async (item) => {
  if (item.saveToWebsiteAssets && item.sourcePageUrl) {
    const websiteVideosDir = resolveCreativeAssetsDir(item.sourcePageUrl, "Videos");
    const websiteRoot = resolveCreativeAssetsDir(item.sourcePageUrl);
    await removeEmptyParents(path2.dirname(item.path), websiteVideosDir);
    await removeEmptyParents(websiteVideosDir, websiteRoot);
    await removeDirectoryIfEmpty(websiteRoot);
    return;
  }
  const root = resolvePlatformVideoAssetsDir(item.platform);
  await removeEmptyParents(path2.dirname(item.path), root);
};
var completeJob = async (options, job, downloaded) => {
  const initialPath = String(downloaded?.filePath || downloaded?.downloadPath || downloaded?.localPath || "");
  if (isJobCancelled(job)) {
    if (initialPath) await fsp2.rm(initialPath, { force: true }).catch(() => void 0);
    return;
  }
  const preserveOriginal = job.quality === "audio";
  updateJob(job, {
    progress: job.quality === "4k" ? 86 : 95,
    message: job.quality === "4k" ? "Converting 4K to Mac-compatible MP4..." : "Optimizing for QuickTime..."
  });
  const filePath = preserveOriginal ? initialPath : await ensureQuickTimeMp4(options, initialPath, job.id, job.quality === "4k");
  updateJob(job, { progress: 98, message: "Finalizing file..." });
  const stat = await fsp2.stat(filePath);
  const downloadsRoot = path2.join(os2.homedir(), "Downloads");
  const title = downloaded?.title || job.title || path2.basename(filePath, path2.extname(filePath));
  const metadata = {
    title,
    thumbnail: downloaded?.thumbnail || "",
    platform: job.platform,
    quality: job.quality === "4k" ? "4K / Best" : job.quality === "fhd" ? "FHD" : job.quality === "hd" ? "HD" : "Audio",
    status: "completed",
    filePath,
    displayPath: downloaded?.displayPath || toDisplayPath(filePath),
    relativePath: path2.relative(downloadsRoot, filePath),
    size: stat.size,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sourceUrl: job.url,
    sourcePageUrl: job.sourcePageUrl || "",
    saveToWebsiteAssets: job.saveToWebsiteAssets === true
  };
  updateJob(job, {
    status: "completed",
    progress: 100,
    message: "Download complete",
    result: {
      ok: true,
      filePath,
      displayPath: downloaded?.displayPath || toDisplayPath(filePath),
      relativePath: path2.relative(downloadsRoot, filePath),
      filename: path2.basename(filePath),
      size: stat.size,
      quality: job.quality,
      platform: job.platform,
      title,
      thumbnail: downloaded?.thumbnail || ""
    }
  });
  void (async () => {
    try {
      await writeSidecar(filePath, metadata);
    } catch {
    }
  })();
};
var processJob = async (options, job) => {
  if (isJobCancelled(job)) return;
  const startTime = Date.now();
  updateJob(job, { status: "running", progress: 2, message: "Preparing downloader..." });
  void writeLog(job.id, {
    event: "process_start",
    ytdlp_path: resolveTool(options, "yt-dlp"),
    ffmpeg_path: resolveTool(options, "ffmpeg"),
    aria2c_path: resolveTool(options, "aria2c")
  });
  try {
    if ((job.platform === "ispot" || job.platform === "brightcove") && options.specialDownload) {
      updateJob(job, {
        progress: 12,
        message: job.platform === "brightcove" ? "Resolving Brightcove stream..." : "Resolving iSpot.tv stream..."
      });
      const special = await options.specialDownload({
        url: job.url,
        quality: job.quality,
        title: job.title,
        sourcePageUrl: job.sourcePageUrl,
        saveToWebsiteAssets: job.saveToWebsiteAssets
      });
      await completeJob(options, job, special);
      return;
    }
    const downloaded = await runDownloadWithFallbacks(options, job);
    await completeJob(options, job, downloaded);
    const totalTime = Date.now() - startTime;
    void writeLog(job.id, { event: "download_complete", total_ms: totalTime });
  } catch (error) {
    if (isJobCancelled(job)) return;
    const rawError = errorText(error);
    const friendly = friendlyDownloaderError(job.platform, rawError);
    const totalTime = Date.now() - startTime;
    void writeLog(job.id, {
      event: "download_failed",
      raw_error: rawError,
      friendly_error: friendly,
      total_ms: totalTime
    });
    updateJob(job, {
      status: "error",
      progress: 0,
      error: friendly,
      message: "Download failed"
    });
  }
};
var pumpQueue = (options) => {
  while (activeJobs < 2 && pendingJobs.length > 0) {
    const id = pendingJobs.shift();
    const job = jobs.get(id);
    if (!job || job.status !== "queued") continue;
    activeJobs += 1;
    void processJob(options, job).finally(() => {
      activeJobs -= 1;
      pumpQueue(options);
    });
  }
};
var runningJobKey = (platform, url, quality, sourcePageUrl = "", startTime = "", endTime = "") => `${platform}:${url}:${quality}:${sourcePageUrl}:${startTime}-${endTime}`;
var createJob = (options, input) => {
  const validated = validateDownloaderUrl(input.url, options.validateUrl);
  const quality = input.quality === "audio" ? "audio" : input.quality === "hd" ? "hd" : input.quality === "fhd" ? "fhd" : "4k";
  const sourcePageUrl = String(input.sourcePageUrl || "").trim();
  const saveToWebsiteAssets = input.saveToWebsiteAssets === true && Boolean(sourcePageUrl);
  const { startTime, endTime } = normalizeTrimRange(input.startTime, input.endTime);
  const rawCookiesFilePath = String(input.cookiesFilePath || "").trim();
  const cookiesFilePath = normalizeCookiesFilePath(rawCookiesFilePath);
  if (rawCookiesFilePath && !cookiesFilePath) {
    throw new Error("Cookies file was not found. Paste a valid cookies.txt file path or leave it blank.");
  }
  const key = runningJobKey(validated.platform, validated.url, quality, saveToWebsiteAssets ? sourcePageUrl : "", startTime, endTime);
  for (const existing of jobs.values()) {
    if (existing.status === "queued" || existing.status === "running") {
      if (runningJobKey(
        existing.platform,
        existing.url,
        existing.quality,
        existing.saveToWebsiteAssets ? existing.sourcePageUrl : "",
        existing.startTime,
        existing.endTime
      ) === key) {
        return existing;
      }
    }
  }
  const job = {
    id: crypto.randomUUID(),
    url: validated.url,
    title: sanitizeFilenamePart(input.title || "", ""),
    platform: validated.platform,
    quality,
    sourcePageUrl,
    saveToWebsiteAssets,
    startTime,
    endTime,
    cookiesFilePath,
    status: "queued",
    progress: 0,
    downloadedBytes: 0,
    message: "Queued",
    createdAt: now(),
    updatedAt: now()
  };
  jobs.set(job.id, job);
  pendingJobs.push(job.id);
  pumpQueue(options);
  return job;
};
var publicJob = (job) => {
  const { cookiesFilePath: _cookiesFilePath, ...safeJob } = job;
  return safeJob;
};
var trimJobs = () => {
  const sorted = Array.from(jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const job of sorted.slice(100)) jobs.delete(job.id);
};
var registerVideoDownloaderRoutes = (app2, options) => {
  const assertSpecialVideoAvailable = async (rawUrl) => {
    const validated = validateDownloaderUrl(rawUrl, options.validateUrl);
    if (validated.platform !== "brightcove" || !options.specialInspect) return;
    const payload = await options.specialInspect(validated.url);
    const videos = specialPayloadToCards(payload, validated.url, validated.platform);
    if (videos.length === 0) throw new Error("No downloadable video was found for this URL.");
  };
  app2.post("/api/downloader/inspect", async (req, res) => {
    const rawUrl = String(req.body?.url || "").trim();
    if (!rawUrl) return res.status(400).json({ error: "URL is required." });
    try {
      const validated = validateDownloaderUrl(rawUrl, options.validateUrl);
      if ((validated.platform === "ispot" || validated.platform === "brightcove") && options.specialInspect) {
        const payload2 = await options.specialInspect(validated.url);
        const videos2 = specialPayloadToCards(payload2, validated.url, validated.platform);
        return res.json({ ok: true, platform: validated.platform, videos: videos2, count: videos2.length });
      }
      const cacheKey = `${validated.platform}:${validated.url}`;
      const cached = inspectCache.get(cacheKey);
      if (cached && cached.expiresAt > now()) {
        return res.json(cached.payload);
      }
      const info = await inspectWithFallbacks(options, validated.url, validated.platform);
      const videos = infoToCards(info, validated.url, validated.platform);
      if (videos.length === 0) throw new Error("No downloadable video was found for this URL.");
      const payload = { ok: true, platform: validated.platform, videos, count: videos.length };
      inspectCache.set(cacheKey, { expiresAt: now() + INSPECT_CACHE_TTL_MS, payload });
      if (inspectCache.size > 60) {
        const expiredOrOldest = Array.from(inspectCache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, 20);
        expiredOrOldest.forEach(([key]) => inspectCache.delete(key));
      }
      return res.json(payload);
    } catch (error) {
      const platform = detectDownloaderPlatform(rawUrl);
      return res.status(400).json({ error: friendlyDownloaderError(platform, errorText(error)) });
    }
  });
  app2.post("/api/downloader/download", async (req, res) => {
    try {
      const rawUrl = String(req.body?.url || "").trim();
      await assertSpecialVideoAvailable(rawUrl);
      const job = createJob(options, {
        url: rawUrl,
        quality: String(req.body?.quality || "fhd").toLowerCase(),
        title: String(req.body?.title || "").trim(),
        sourcePageUrl: String(req.body?.sourcePageUrl || "").trim(),
        saveToWebsiteAssets: req.body?.saveToWebsiteAssets === true,
        startTime: String(req.body?.startTime || "").trim(),
        endTime: String(req.body?.endTime || "").trim(),
        cookiesFilePath: String(req.body?.cookiesFilePath || "").trim()
      });
      trimJobs();
      return res.status(202).json({ ok: true, job: publicJob(job) });
    } catch (error) {
      const rawUrl = String(req.body?.url || "").trim();
      const platform = detectDownloaderPlatform(rawUrl);
      return res.status(400).json({ error: friendlyDownloaderError(platform, errorText(error)) });
    }
  });
  app2.post("/api/downloader/bulk", async (req, res) => {
    const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const urls = Array.from(
      new Set(rawUrls.map((value) => String(value || "").trim()).filter(Boolean))
    ).slice(0, 20);
    const quality = String(req.body?.quality || "fhd").toLowerCase();
    const trimRange = normalizeTrimRange(req.body?.startTime, req.body?.endTime);
    const cookiesFilePath = String(req.body?.cookiesFilePath || "").trim();
    if (urls.length === 0) return res.status(400).json({ error: "Enter at least one video URL." });
    const created = [];
    const errors = [];
    for (const url of urls) {
      try {
        await assertSpecialVideoAvailable(url);
        created.push(createJob(options, { url, quality, ...trimRange, cookiesFilePath }));
      } catch (error) {
        errors.push({
          url,
          error: friendlyDownloaderError(detectDownloaderPlatform(url), errorText(error))
        });
      }
    }
    trimJobs();
    return res.status(202).json({ ok: created.length > 0, jobs: created.map(publicJob), errors });
  });
  app2.get("/api/downloader/jobs/:id", (req, res) => {
    const job = jobs.get(String(req.params.id || ""));
    if (!job) return res.status(404).json({ error: "Download job was not found." });
    return res.json({ ok: true, job: publicJob(job) });
  });
  app2.post("/api/downloader/jobs/:id/cancel", (req, res) => {
    const id = String(req.params.id || "");
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: "Download job was not found." });
    if (job.status === "completed" || job.status === "error" || job.status === "cancelled") {
      return res.json({ ok: true, job: publicJob(job) });
    }
    cancelledJobs.add(id);
    const pendingIndex = pendingJobs.indexOf(id);
    if (pendingIndex >= 0) pendingJobs.splice(pendingIndex, 1);
    const child = activeDownloadProcesses.get(id);
    if (child && job.status === "paused" && process.platform !== "win32") {
      child.kill("SIGCONT");
    }
    child?.kill("SIGTERM");
    updateJob(job, {
      status: "cancelled",
      progress: 0,
      message: "Download cancelled",
      error: void 0
    });
    return res.json({ ok: true, job: publicJob(job) });
  });
  app2.post("/api/downloader/jobs/:id/pause", (req, res) => {
    const id = String(req.params.id || "");
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: "Download job was not found." });
    if (job.status === "completed" || job.status === "error" || job.status === "cancelled") {
      return res.json({ ok: true, job: publicJob(job) });
    }
    if (job.status === "paused") {
      return res.json({ ok: true, job: publicJob(job) });
    }
    const pendingIndex = pendingJobs.indexOf(id);
    if (pendingIndex >= 0) pendingJobs.splice(pendingIndex, 1);
    const child = activeDownloadProcesses.get(id);
    if (child && process.platform !== "win32") {
      try {
        child.kill("SIGSTOP");
      } catch (error) {
        return res.status(500).json({ error: error?.message || "Could not pause download." });
      }
    } else if (child && process.platform === "win32") {
      return res.status(400).json({ error: "Pause is not supported for active downloads on Windows. Cancel and restart the selected time range instead." });
    }
    updateJob(job, {
      status: "paused",
      message: "Download paused"
    });
    return res.json({ ok: true, job: publicJob(job) });
  });
  app2.post("/api/downloader/jobs/:id/resume", (req, res) => {
    const id = String(req.params.id || "");
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: "Download job was not found." });
    if (job.status !== "paused") {
      return res.json({ ok: true, job: publicJob(job) });
    }
    const child = activeDownloadProcesses.get(id);
    if (child && process.platform !== "win32") {
      try {
        child.kill("SIGCONT");
        updateJob(job, {
          status: "running",
          message: "Download resumed"
        });
      } catch (error) {
        return res.status(500).json({ error: error?.message || "Could not resume download." });
      }
    } else {
      updateJob(job, {
        status: "queued",
        message: "Queued"
      });
      if (!pendingJobs.includes(id)) pendingJobs.push(id);
      pumpQueue(options);
    }
    return res.json({ ok: true, job: publicJob(job) });
  });
  app2.get("/api/downloader/jobs", (_req, res) => {
    const items = Array.from(jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt).map(publicJob);
    return res.json({ items, count: items.length });
  });
  app2.delete("/api/downloader/jobs", (_req, res) => {
    for (const id of pendingJobs.splice(0)) {
      cancelledJobs.add(id);
    }
    for (const [id, child] of activeDownloadProcesses.entries()) {
      const job = jobs.get(id);
      cancelledJobs.add(id);
      if (job?.status === "paused" && process.platform !== "win32") {
        child.kill("SIGCONT");
      }
      child.kill("SIGTERM");
    }
    const removed = jobs.size;
    jobs.clear();
    activeDownloadProcesses.clear();
    cancelledJobs.clear();
    return res.json({ ok: true, removed });
  });
  app2.get("/api/downloader/downloads", async (_req, res) => {
    try {
      const items = await listDownloaderFiles();
      return res.json({ items, count: items.length });
    } catch (error) {
      return res.status(500).json({ error: error?.message || "Failed to list downloads." });
    }
  });
  app2.delete("/api/downloader/downloads", async (req, res) => {
    try {
      const deleteFiles = Boolean(req.body?.deleteFiles);
      const items = await listDownloaderFiles();
      const completedIds = new Set(
        Array.from(jobs.values()).filter((job) => job.status === "completed" || job.status === "error" || job.status === "cancelled").map((job) => job.id)
      );
      completedIds.forEach((id) => jobs.delete(id));
      if (!deleteFiles) {
        return res.json({ ok: true, mode: "history", removed: completedIds.size });
      }
      for (const item of items) {
        await fsp2.unlink(item.path).catch(() => void 0);
        await fsp2.unlink(sidecarPathFor(item.path)).catch(() => void 0);
        if (item.zipPath && isPathInside(item.zipPath, path2.join(os2.homedir(), "Downloads"))) {
          await fsp2.unlink(item.zipPath).catch(() => void 0);
        }
        await cleanupListedDownloadParents(item);
      }
      for (const platform of SUPPORTED_PLATFORMS) {
        await removePlatformDownloadFolder(platform);
      }
      return res.json({ ok: true, mode: "files", removed: items.length });
    } catch (error) {
      return res.status(500).json({ error: error?.message || "Failed to clear downloads." });
    }
  });
  app2.post("/api/downloader/open", async (req, res) => {
    const relativePath = String(req.body?.path || "");
    const downloadsRoot = path2.join(os2.homedir(), "Downloads");
    const filePath = path2.resolve(downloadsRoot, relativePath);
    if (!relativePath || !isPathInside(filePath, downloadsRoot)) {
      return res.status(400).json({ error: "Invalid download path." });
    }
    try {
      const stat = await fsp2.stat(filePath);
      if (!stat.isFile()) throw new Error("Not a file");
      await openLocalPath(filePath);
      return res.json({ ok: true, path: filePath });
    } catch (error) {
      return res.status(404).json({ error: error?.message || "Downloaded file was not found." });
    }
  });
  app2.post("/api/downloader/reveal", async (req, res) => {
    const relativePath = String(req.body?.path || "");
    const downloadsRoot = path2.join(os2.homedir(), "Downloads");
    const filePath = path2.resolve(downloadsRoot, relativePath);
    if (!relativePath || !isPathInside(filePath, downloadsRoot)) {
      return res.status(400).json({ error: "Invalid download path." });
    }
    try {
      const stat = await fsp2.stat(filePath);
      if (!stat.isFile()) throw new Error("Not a file");
      await revealLocalPath(filePath);
      return res.json({ ok: true, path: filePath });
    } catch (error) {
      return res.status(404).json({ error: error?.message || "Downloaded file was not found." });
    }
  });
  app2.get("/api/downloader/file", async (req, res) => {
    const relativePath = String(req.query?.path || "");
    const downloadsRoot = path2.join(os2.homedir(), "Downloads");
    const filePath = path2.resolve(downloadsRoot, relativePath);
    if (!relativePath || !isPathInside(filePath, downloadsRoot)) {
      return res.status(400).json({ error: "Invalid download path." });
    }
    try {
      const stat = await fsp2.stat(filePath);
      if (!stat.isFile()) throw new Error("Not a file");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilenamePart(path2.basename(filePath))}"`);
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Cache-Control", "no-store, private");
      return fs.createReadStream(filePath).pipe(res);
    } catch {
      return res.status(404).json({ error: "Downloaded file was not found." });
    }
  });
};

// src/lib/extractionProfile.ts
var KNOWN_HEAVY_HOSTS = /(?:^|\.)(?:fabindia\.com|warehousestationery\.co\.nz|joannamendoza\.com)$/i;
function classifyWebsiteExtraction({
  url,
  html = "",
  crawlMode = "fast",
  captchaDetected = false,
  profileHint = "auto"
}) {
  if (captchaDetected || profileHint === "captcha") {
    return {
      kind: "captcha",
      label: "Verification or CAPTCHA detected",
      detail: "Checking briefly for automatic verification. If it remains, open the website in Chrome and complete the CAPTCHA before retrying.",
      browserBudgetMs: 2e4,
      pageLoadTimeoutMs: 12e3,
      challengeWaitMs: 9e3
    };
  }
  const assetTags = (html.match(/<(?:img|source|video|script|link)\b/gi) || []).length;
  const hasLargeMarkup = html.length > 65e4;
  const hasDenseAssets = assetTags > 140;
  const isKnownHeavy = KNOWN_HEAVY_HOSTS.test(new URL(url).hostname);
  const isHeavy = profileHint === "heavy" || profileHint === "auto" && (crawlMode === "deep" || isKnownHeavy || hasLargeMarkup || hasDenseAssets);
  if (isHeavy) {
    return {
      kind: "heavy",
      label: "Heavy website detected",
      detail: "This page has a large or highly interactive asset set, so Chromium is given extra time to finish the scan.",
      browserBudgetMs: 1e4,
      pageLoadTimeoutMs: 25e3,
      challengeWaitMs: 2e4
    };
  }
  return {
    kind: "normal",
    label: "Normal website scan",
    detail: "Using the standard fast Chromium scan for this page.",
    browserBudgetMs: profileHint === "normal" ? 5e3 : 1e4,
    pageLoadTimeoutMs: 12e3,
    challengeWaitMs: 9e3
  };
}

// src/lib/streamUrl.ts
var htmlEntities = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">"
};
var isLocalHost = (host) => host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local");
var decodeEscapedUrl = (value) => {
  let next = String(value || "").trim();
  next = next.replace(/^["'`]+|["'`]+$/g, "");
  next = next.replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u002f/gi, "/");
  next = next.replace(/\\\//g, "/").replace(/\\&/g, "&");
  next = next.replace(/(\.(?:mp4|webm|mov|mkv|m3u8|mpd|m4a|mp3|aac|wav))&(?=[a-z0-9_.-]+=)/i, "$1?");
  next = next.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith("#x")) return String.fromCharCode(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCharCode(parseInt(key.slice(1), 10));
    return htmlEntities[key] || match;
  });
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(next);
      if (decoded === next || !/^https?:|^\/|^\/\//i.test(decoded)) break;
      next = decoded;
    } catch {
      break;
    }
  }
  return next.trim().replace(/ /g, "%20");
};
var normalizeDuplicateQueryMarkers = (value) => {
  const firstQuestion = value.indexOf("?");
  if (firstQuestion === -1) return value;
  return `${value.slice(0, firstQuestion + 1)}${value.slice(firstQuestion + 1).replace(/\?/g, "&")}`;
};
var normalizeYouTubeWatchUrlLite = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const videoId = parsed.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      const embedMatch = parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (embedMatch?.[1]) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};
var recoverYouTubeWatchFromMergeQuery = (watchPart, looseVideoId) => {
  let watchUrl = String(watchPart || "").trim();
  const videoId = String(looseVideoId || "").trim();
  if (watchUrl && videoId && !watchUrl.includes("v=")) {
    watchUrl = `${watchUrl}${watchUrl.includes("?") ? "&" : "?"}v=${videoId}`;
  }
  return normalizeYouTubeWatchUrlLite(watchUrl);
};
var rebuildYouTubeMergedStreamUrl = (rawUrl, baseUrl) => {
  try {
    const parsed = new URL(rawUrl, baseUrl || "http://127.0.0.1");
    if (!/\/api\/youtube-merged-stream$/i.test(parsed.pathname)) return null;
    const watchUrl = recoverYouTubeWatchFromMergeQuery(
      parsed.searchParams.get("url") || "",
      parsed.searchParams.get("v")
    );
    if (!/youtube\.com|youtu\.be/i.test(watchUrl)) return null;
    const params = new URLSearchParams();
    params.set("url", watchUrl);
    params.set("quality", parsed.searchParams.get("quality") || "fhd");
    const inline = parsed.searchParams.get("inline");
    if (inline) params.set("inline", inline);
    const filename = parsed.searchParams.get("filename");
    if (filename) params.set("filename", filename);
    const path4 = `/api/youtube-merged-stream?${params.toString()}`;
    if (isLocalHost(parsed.hostname) || rawUrl.startsWith("/api/")) return path4;
    return `${parsed.protocol}//${parsed.host}${path4}`;
  } catch {
    return null;
  }
};
var sanitizeStreamUrl = (rawUrl, baseUrl) => {
  const raw = String(rawUrl || "").trim();
  if (/\/api\/youtube-merged-stream(?:\?|$)/i.test(raw)) {
    const rebuilt = rebuildYouTubeMergedStreamUrl(raw, baseUrl);
    if (rebuilt) return rebuilt;
  }
  let value = decodeEscapedUrl(rawUrl);
  if (!value || /^(?:javascript|data|blob):/i.test(value)) return null;
  value = value.replace(/^(https?:)\/{3,}/i, "$1//");
  value = value.replace(/^(https?:\/\/)(https?:\/\/)+/i, "$2");
  value = normalizeDuplicateQueryMarkers(value);
  if (value.startsWith("//")) {
    value = `https:${value}`;
  } else if (/^www\./i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?]|$)/i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value, baseUrl || void 0);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (/\/api\/youtube-merged-stream$/i.test(parsed.pathname)) {
      const rebuilt = rebuildYouTubeMergedStreamUrl(parsed.href, baseUrl);
      if (rebuilt) return rebuilt;
    }
    const nestedStreamUrl = parsed.searchParams.get("url");
    if (!isLocalHost(parsed.hostname) && /\/api\/download$/i.test(parsed.pathname) && nestedStreamUrl && /googlevideo\.com|\/videoplayback(?:\?|\/|$)|\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?:\?|$)/i.test(nestedStreamUrl)) {
      let nestedValue = nestedStreamUrl;
      try {
        const nestedParsed = new URL(nestedValue);
        parsed.searchParams.forEach((paramValue, key) => {
          if (key !== "url" && !nestedParsed.searchParams.has(key)) {
            nestedParsed.searchParams.append(key, paramValue);
          }
        });
        nestedValue = nestedParsed.href;
      } catch {
      }
      const unwrapped = sanitizeStreamUrl(nestedValue, baseUrl);
      if (unwrapped) return unwrapped;
    }
    parsed.hash = "";
    if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
      parsed.protocol = "https:";
    }
    return parsed.href;
  } catch {
    return null;
  }
};
var isAppRelativeMediaPath = (value) => /^\/(?:api|converted-videos|converted-audio|cached-images|cached-fonts)\//i.test(String(value || "").trim());
var isExpiredStreamUrl = (rawUrl, graceSeconds = 90, baseUrl) => {
  const raw = String(rawUrl || "").trim();
  if (!raw) return true;
  let parsed;
  try {
    const fallbackBase = baseUrl || (typeof window !== "undefined" ? window.location.origin : void 0) || "http://127.0.0.1";
    parsed = new URL(raw, fallbackBase);
  } catch {
    return isAppRelativeMediaPath(raw) ? false : true;
  }
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const keys = ["expire", "expires", "exp", "X-Amz-Date"];
  for (const key of keys) {
    const value = parsed.searchParams.get(key);
    if (!value) continue;
    if (key === "X-Amz-Date") {
      const ttl = Number(parsed.searchParams.get("X-Amz-Expires") || 0);
      const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (ttl > 0 && match) {
        const [, y, mo, d, h, mi, s] = match;
        const issued = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1e3;
        return issued + ttl < nowSeconds + graceSeconds;
      }
      continue;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const seconds = numeric > 1e10 ? Math.floor(numeric / 1e3) : numeric;
    if (seconds < nowSeconds + graceSeconds) return true;
  }
  return false;
};
var isLikelyHttpMediaUrl = (rawUrl) => /\.(mp4|webm|mov|mkv|m3u8|mpd|m4a|mp3|aac|wav)(?:\?|$)/i.test(rawUrl) || /googlevideo\.com\/videoplayback|video\.xx\.fbcdn\.net|vimeo\.com\/progressive_redirect|\/videoplayback\?/i.test(rawUrl);

// src/lib/convertRasterImage.ts
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var sharpModule = null;
var loadSharp = async () => {
  if (sharpModule) return sharpModule;
  try {
    const mod = await import("sharp");
    sharpModule = mod.default || mod;
    return sharpModule;
  } catch {
    try {
      sharpModule = require2("sharp");
      return sharpModule.default || sharpModule;
    } catch {
      throw new Error("Image conversion backend is unavailable. Install sharp to enable WEBP/AVIF conversion.");
    }
  }
};
var isValidRasterOutputBuffer = (buffer, format) => {
  if (!buffer || buffer.length < 12) return false;
  if (format === "png") {
    return buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71;
  }
  return buffer[0] === 255 && buffer[1] === 216;
};
var detectRasterFormatFromBuffer = (buffer) => {
  if (!buffer || buffer.length < 12) return "";
  if (buffer[0] === 255 && buffer[1] === 216) return "jpg";
  if (buffer.slice(0, 8).toString("ascii") === "\x89PNG\r\n\n") return "png";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.slice(8, 12).toString("ascii");
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "avif";
  }
  return "";
};
var supportedRasterConversionTargets = (sourceFormat) => {
  const normalized = String(sourceFormat || "").toLowerCase().replace("jpeg", "jpg");
  if (normalized === "webp" || normalized === "avif" || normalized === "svg") return ["png", "jpg"];
  return [];
};
var looksLikeSvg = (buffer) => {
  const head = buffer.slice(0, 512).toString("utf8").trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.includes("<svg");
};
var numericSvgLength = (value) => {
  const match = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
var prepareSvgForSharp = (buffer) => {
  if (!looksLikeSvg(buffer)) return buffer;
  let svg = buffer.toString("utf8").trim();
  if (/<font\b/i.test(svg) && !/(<path\b|<rect\b|<circle\b|<ellipse\b|<line\b|<polyline\b|<polygon\b|<image\b|<text\b)/i.test(svg)) {
    throw new Error("SVG font files cannot be rasterized as images. Download the original SVG instead.");
  }
  const tagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!tagMatch) return buffer;
  let tag = tagMatch[0];
  if (!/\sxmlns=/.test(tag)) {
    tag = tag.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const width = numericSvgLength(tag.match(/\swidth=["']([^"']+)["']/i)?.[1] || "");
  const height = numericSvgLength(tag.match(/\sheight=["']([^"']+)["']/i)?.[1] || "");
  const viewBoxMatch = tag.match(/\sviewBox=["']([^"']+)["']/i);
  const viewBoxParts = (viewBoxMatch?.[1] || "").trim().split(/[\s,]+/).map(Number).filter((part) => Number.isFinite(part));
  const viewBoxWidth = viewBoxParts.length === 4 && viewBoxParts[2] > 0 ? viewBoxParts[2] : 0;
  const viewBoxHeight = viewBoxParts.length === 4 && viewBoxParts[3] > 0 ? viewBoxParts[3] : 0;
  const finalWidth = Math.ceil(width || viewBoxWidth || 1024);
  const finalHeight = Math.ceil(height || viewBoxHeight || 1024);
  if (!width) tag = tag.replace(/<svg\b/i, `<svg width="${finalWidth}"`);
  if (!height) tag = tag.replace(/<svg\b/i, `<svg height="${finalHeight}"`);
  if (!viewBoxMatch) tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${finalWidth} ${finalHeight}"`);
  svg = svg.replace(tagMatch[0], tag);
  return Buffer.from(svg, "utf8");
};
var convertRasterImageBuffer = async (input, targetFormat) => {
  if (!input?.length) throw new Error("Empty image buffer");
  const sharp = await loadSharp();
  const preparedInput = prepareSvgForSharp(input);
  const image = sharp(preparedInput, { failOn: "error", unlimited: true, density: 144 }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Invalid image buffer for conversion");
  }
  const output = targetFormat === "jpg" ? await image.flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true }).toBuffer() : await image.png({ compressionLevel: 9 }).toBuffer();
  if (!isValidRasterOutputBuffer(output, targetFormat)) {
    throw new Error(`${targetFormat.toUpperCase()} conversion produced invalid output`);
  }
  const detected = detectRasterFormatFromBuffer(output);
  if (detected === "webp" || detected === "avif") {
    throw new Error(`Conversion returned ${detected} bytes instead of ${targetFormat}`);
  }
  return output;
};

// src/lib/generateImageThumb.ts
var THUMB_MAX_EDGE = 320;
var THUMB_TARGET_BYTES = 50 * 1024;
var LQIP_MAX_EDGE = 24;
var generateImageThumbArtifacts = async (input) => {
  if (!input?.length) throw new Error("Empty image buffer");
  const sharp = await loadSharp();
  const base = sharp(input, { failOn: "none", unlimited: true, density: 144 }).rotate();
  const metadata = await base.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Invalid image dimensions");
  }
  const lqipBuffer = await base.clone().resize(LQIP_MAX_EDGE, LQIP_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 35, effort: 2 }).toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuffer.toString("base64")}`;
  let quality = 74;
  let thumbBuffer = await base.clone().resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
  while (thumbBuffer.length > THUMB_TARGET_BYTES && quality > 36) {
    quality -= 6;
    thumbBuffer = await base.clone().resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
  }
  const thumbMeta = await sharp(thumbBuffer).metadata();
  return {
    thumbBuffer,
    lqip,
    width: thumbMeta.width || metadata.width,
    height: thumbMeta.height || metadata.height
  };
};

// src/lib/feedbackScreenshotLimits.ts
var MAX_SHEET_SCREENSHOT_PIXELS = 95e4;
var MAX_SHEET_SCREENSHOT_BYTES = 15e5;

// src/lib/compressFeedbackScreenshotForSheet.ts
var compressScreenshotBufferForSheet = async (buffer) => {
  const sharp = await loadSharp();
  const meta = await sharp(buffer, { failOn: "none" }).metadata();
  let width = meta.width || 0;
  let height = meta.height || 0;
  let pipeline = sharp(buffer, { failOn: "none" });
  if (width > 0 && height > 0 && width * height > MAX_SHEET_SCREENSHOT_PIXELS) {
    const scale = Math.sqrt(MAX_SHEET_SCREENSHOT_PIXELS / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    pipeline = sharp(buffer, { failOn: "none" }).resize(width, height, {
      fit: "inside",
      withoutEnlargement: true
    });
  }
  let quality = 82;
  let output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  while (output.length > MAX_SHEET_SCREENSHOT_BYTES && quality > 44) {
    quality -= 8;
    output = await sharp(output).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (output.length > MAX_SHEET_SCREENSHOT_BYTES) {
    output = await sharp(buffer, { failOn: "none" }).resize(960, 960, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 68, mozjpeg: true }).toBuffer();
  }
  return {
    screenshotBase64: output.toString("base64"),
    screenshotMimeType: "image/jpeg",
    screenshotFilename: "feedback-screenshot.jpg"
  };
};
var compressScreenshotDataUrlForSheet = async (dataUrl) => {
  const match = String(dataUrl || "").trim().match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match?.[2]) return null;
  return compressScreenshotBufferForSheet(Buffer.from(match[2], "base64"));
};

// src/lib/api.ts
var trimTrailingSlash = (value) => value.replace(/\/+$/, "");
var readRuntimeApiBase = () => {
  const globalConfig = globalThis.__CREATIVE_EXTRACTOR_CONFIG__;
  return typeof globalConfig?.apiBaseUrl === "string" ? globalConfig.apiBaseUrl : "";
};
var envApiBase = import.meta.env?.VITE_API_BASE_URL || "";
var API_BASE_URL = trimTrailingSlash(readRuntimeApiBase() || envApiBase || "");

// src/lib/fontAsset.ts
var getFontConversionOutputs = (sourceFormat) => {
  const source = String(sourceFormat || "").toLowerCase();
  if (source === "woff2") return ["woff2", "ttf", "woff"];
  if (source === "woff") return ["woff", "ttf"];
  if (source === "ttf") return ["ttf", "woff"];
  if (source === "otf") return ["otf", "ttf", "woff"];
  return [];
};
var buildFontZipEntryName = (filenameBase, format, _familyFolder = "") => {
  const safe = sanitizeFontFilenameBase(filenameBase).replace(/\s+/g, "-").replace(/-+/g, "-") || "font";
  const ext = String(format || "ttf").toLowerCase();
  return `fonts/${safe}.${ext}`;
};
var normalizeFontStyleKey = (style) => {
  const raw = String(style || "").trim().toLowerCase();
  if (!raw || raw === "normal") return "normal";
  if (raw === "italic" || raw === "oblique") return "italic";
  return raw;
};
var normalizeFontWeightKey = (weight) => {
  const raw = String(weight || "").trim().toLowerCase();
  if (!raw || raw === "normal" || raw === "regular") return "400";
  if (/^\d+$/.test(raw)) return String(Math.min(900, Math.max(1, Number(raw))));
  if (raw === "bold" || raw === "bolder") return "700";
  if (raw === "lighter") return "300";
  return raw;
};
var WEIGHT_SUFFIX_TO_KEY = {
  thin: "100",
  extralight: "200",
  light: "300",
  regular: "400",
  book: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
  black: "900",
  condbold: "700"
};
var resolveFontIdentityFields = (font) => {
  let family = sanitizeFontFilenameBase(
    String(font?.family || font?.title || font?.name || "").replace(/^["']+|["']+$/g, "").trim()
  );
  let weight = font?.weight;
  let style = font?.style;
  const hyphenated = family.match(
    /^(.+?)[- ](Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black|CondBold)(Italic)?$/i
  );
  if (hyphenated) {
    family = sanitizeFontFilenameBase(hyphenated[1].replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
    const suffixKey = hyphenated[2].toLowerCase().replace(/\s+/g, "");
    const mapped = WEIGHT_SUFFIX_TO_KEY[suffixKey];
    if (mapped && (!weight || String(weight).toLowerCase() === "normal" || String(weight) === "400")) {
      weight = mapped;
    }
    if (hyphenated[3]) style = style || "italic";
  }
  return { family, weight, style };
};
var getFontLogicalKey = (font) => {
  const { family, weight, style } = resolveFontIdentityFields(font);
  if (!family || isJunkFontLabel(family)) return "";
  return `${family}|${normalizeFontWeightKey(weight)}|${normalizeFontStyleKey(style)}`;
};
var scoreFontSubsetUrl = (url) => {
  const lower = String(url || "").toLowerCase();
  let score = 0;
  if (/latin-ext|latn-ext/i.test(lower)) score += 8;
  else if (/latin|latn/i.test(lower)) score += 12;
  if (/fonts\.gstatic\.com/i.test(lower)) score += 25;
  if (/fonts\.googleapis\.com/i.test(lower)) score += 5;
  if (/vietnamese|vi_/i.test(lower)) score -= 10;
  if (/cyrillic|cy_/i.test(lower)) score -= 8;
  if (/greek|greek-ext|el_/i.test(lower)) score -= 6;
  const subsetMatch = /[_-]s(\d)w/i.exec(lower) || /(\d)wH8/i.exec(lower);
  if (subsetMatch) score += Number(subsetMatch[1]) / 10;
  return score;
};
var scoreFontRecord = (font) => {
  let score = 0;
  const unicodeRange = String(font?.unicodeRange || "").toUpperCase();
  if (/U\+0000-00FF|U\+0020-007E|U\+0000-024F/.test(unicodeRange)) score += 80;
  else if (/U\+0100-02|LATIN/.test(unicodeRange)) score += 50;
  if (/U\+0400|U\+0460|U\+1C80|CYRILLIC/.test(unicodeRange)) score -= 35;
  if (/U\+0370|GREEK/.test(unicodeRange)) score -= 25;
  const format = resolveFontSourceFormat(font);
  if (format === "woff2") score += 30;
  else if (format === "woff") score += 20;
  else if (format === "ttf" || format === "otf") score += 10;
  const assetUrl = String(font?.url || font?.cachedUrl || "");
  score += scoreFontSubsetUrl(assetUrl);
  if (/fonts\.gstatic\.com/i.test(assetUrl) && /\.ttf(?:[?#]|$)/i.test(assetUrl)) score += 85;
  if (/-ttf\.ttf(\?|$)/i.test(assetUrl)) score += 18;
  else if (/-woff\.woff(\?|$)/i.test(assetUrl)) score += 12;
  if (/\/fonts\//i.test(assetUrl) && (format === "ttf" || format === "woff")) score += 10;
  if (font?.cachedUrl) score += 50;
  if (String(font?.status || "").toLowerCase() === "downloaded") score += 40;
  return score;
};
var isPreferredExtractedFontFormat = (font) => {
  const format = resolveFontSourceFormat(font);
  return format === "woff" || format === "woff2";
};
var fontDedupeFormatPriority = (font) => {
  const format = resolveFontSourceFormat(font);
  if (format === "woff") return 50;
  if (format === "woff2") return 40;
  return 0;
};
var compareFontDedupePreference = (a, b) => {
  const formatDelta = fontDedupeFormatPriority(b) - fontDedupeFormatPriority(a);
  if (formatDelta !== 0) return formatDelta;
  return scoreFontRecord(b) - scoreFontRecord(a);
};
var getFontFileVariantKey = (font) => {
  const candidate = String(font?.url || font?.cachedUrl || "").trim();
  if (!candidate || candidate.startsWith("data:")) return "";
  try {
    const parsed = new URL(candidate);
    const pathWithoutExt = parsed.pathname.replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, "");
    if (pathWithoutExt === parsed.pathname) return "";
    return `${parsed.hostname.replace(/^www\./i, "").toLowerCase()}${decodeURIComponent(pathWithoutExt).toLowerCase()}`;
  } catch {
    const pathWithoutExt = candidate.split(/[?#]/)[0].replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, "");
    if (!pathWithoutExt || pathWithoutExt === candidate.split(/[?#]/)[0]) return "";
    return pathWithoutExt.toLowerCase();
  }
};
var preferSingleFontFormatPerFileStem = (fonts) => {
  const groups = /* @__PURE__ */ new Map();
  const passthrough = [];
  for (const font of fonts) {
    const fileKey = getFontFileVariantKey(font);
    const logicalKey = getFontLogicalKey(font);
    const key = fileKey && logicalKey ? `${fileKey}|${logicalKey}` : fileKey;
    if (!key) {
      passthrough.push(font);
      continue;
    }
    const bucket = groups.get(key) || [];
    bucket.push(font);
    groups.set(key, bucket);
  }
  const preferred = Array.from(groups.values()).map((group) => {
    const sorted = [...group].sort(compareFontDedupePreference);
    const best = sorted[0];
    const merged = sorted.reduce((acc, current) => mergeFontRecords(acc, current), null) || best;
    return {
      ...merged,
      url: best.url,
      format: best.format || merged.format,
      cachedUrl: best.cachedUrl || merged.cachedUrl
    };
  });
  return [...passthrough, ...preferred];
};
var dedupeFontsByLogicalKey = (fonts) => {
  const groups = /* @__PURE__ */ new Map();
  for (const font of preferSingleFontFormatPerFileStem(fonts.filter(isPreferredExtractedFontFormat))) {
    if (!font?.url) continue;
    const key = getFontLogicalKey(font);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(font);
    groups.set(key, bucket);
  }
  const deduped = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(compareFontDedupePreference);
    const best = sorted[0];
    const merged = sorted.reduce((acc, current) => mergeFontRecords(acc, current), null) || best;
    deduped.push({
      ...merged,
      url: best.url,
      format: best.format || merged.format,
      cachedUrl: best.cachedUrl || merged.cachedUrl
    });
  }
  return deduped.sort((a, b) => {
    const familyA = buildFontDisplayName(a) || a.family || "";
    const familyB = buildFontDisplayName(b) || b.family || "";
    return familyA.localeCompare(familyB);
  });
};
var resolveFontSourceFormat = (font) => {
  const raw = String(font?.format || "").toLowerCase().trim();
  if (["woff", "woff2", "ttf", "otf", "eot", "svg"].includes(raw)) return raw;
  const candidate = String(font?.url || font?.cachedUrl || "");
  if (/\.woff2(\?|$)/i.test(candidate)) return "woff2";
  if (/\.woff(\?|$)/i.test(candidate)) return "woff";
  if (/\.ttf(\?|$)/i.test(candidate)) return "ttf";
  if (/\.otf(\?|$)/i.test(candidate)) return "otf";
  if (/\.eot(\?|$)/i.test(candidate)) return "eot";
  if (/\.svg(\?|$)/i.test(candidate)) return "svg";
  return raw || "unknown";
};
var isJunkFontLabel = (value) => {
  const raw = String(value || "").trim();
  const base = raw.toLowerCase();
  if (!base) return true;
  if (base === "unknown" || base === "font") return true;
  if (base.length <= 2) return true;
  if (/^font-\d+$/i.test(base)) return true;
  if (/^[lda](?:-\d+)?$/i.test(base)) return true;
  if (/^[0-9a-f]{8,}$/i.test(base)) return true;
  if (/^[0-9a-f]{8,}(?:[-_.\s]+s(?:[-_.\s]*p)?)?$/i.test(base)) return true;
  const compact = raw.replace(/[\s.-]+/g, "");
  const hasFamilyWord = /(sans|serif|mono|display|text|pro|std|gothic|grotesk|rounded|condensed|compressed|slab|script|din|museo|avenir|helvetica|arial|roboto|poppins|montserrat|inter|source|open|nexon|shilia)/i.test(raw);
  if (!hasFamilyWord && /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9_-]{12,}$/.test(compact) || !hasFamilyWord && /^(?=[a-z0-9_-]*\d)[a-z0-9_-]{18,}$/i.test(compact)) return true;
  if (/^(?=[a-z0-9_-]*\d)[a-z0-9_-]{24,}$/i.test(base)) return true;
  if (/^(?=[a-z0-9 ._-]*\d)[a-z0-9_-]{16,}(?:[ ._-]+[a-z0-9_-]{3,})+$/i.test(base)) return true;
  return false;
};
var scoreFontFamilyLabel = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return 0;
  if (isJunkFontLabel(trimmed)) return 1;
  if (/^https?:\/\//i.test(trimmed)) return 1;
  if (/[._-][0-9a-f]{8,}$/i.test(trimmed)) return 2;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return 10 + Math.min(words, 4) + Math.min(trimmed.length, 48);
};
var sanitizeFontFilenameBase = (value) => String(value || "").trim().replace(/^["']+|["']+$/g, "").replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, "").replace(/[/\\]+/g, "-").replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
var prettifyFontFamilyLabel = (value) => {
  const cleaned = sanitizeFontFilenameBase(value);
  if (!cleaned) return "";
  const compactSlug = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
  if (!compactSlug.test(cleaned)) return cleaned;
  return cleaned.split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
};
var FONT_WEIGHT_LABELS = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black"
};
var normalizeFontWeightLabel = (weight) => {
  const raw = String(weight || "").trim().toLowerCase();
  if (!raw || raw === "normal" || raw === "regular" || raw === "400") return "Regular";
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return FONT_WEIGHT_LABELS[num] || "";
  }
  if (raw === "bold" || raw === "bolder") return "Bold";
  if (raw === "lighter") return "Light";
  return sanitizeFontFilenameBase(raw);
};
var buildFontDisplayName = (font) => {
  const identity = resolveFontIdentityFields(font);
  const resolvedFamily = prettifyFontFamilyLabel(sanitizeFontFilenameBase(String(identity.family || "").trim()));
  const familyCandidates = [
    String(font?.title || "").trim(),
    String(font?.name || "").trim(),
    String(font?.filename || "").trim()
  ].map((value) => sanitizeFontFilenameBase(value.replace(/^["']+|["']+$/g, ""))).map(prettifyFontFamilyLabel).filter((value) => value && !isJunkFontLabel(value));
  const family = resolvedFamily && !isJunkFontLabel(resolvedFamily) ? resolvedFamily : familyCandidates.sort((a, b) => scoreFontFamilyLabel(b) - scoreFontFamilyLabel(a))[0] || "";
  if (!family) return "";
  const weight = normalizeFontWeightLabel(identity.weight);
  const style = String(identity.style || "").trim().toLowerCase();
  const italic = style === "italic" || style === "oblique";
  const suffixes = [weight, italic ? "Italic" : ""].filter(Boolean);
  return suffixes.length ? `${family} ${suffixes.join(" ")}`.trim() : family;
};
var mergeFontRecords = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  const familyCandidates = [left.family, right.family, left.title, right.title, left.name, right.name, left.filename, right.filename];
  const family = familyCandidates.map((value) => sanitizeFontFilenameBase(String(value || "").replace(/^["']+|["']+$/g, ""))).map(prettifyFontFamilyLabel).filter((value) => value && !isJunkFontLabel(value)).sort((a, b) => scoreFontFamilyLabel(b) - scoreFontFamilyLabel(a))[0] || left.family || right.family || "Font";
  return {
    ...left,
    ...right,
    family,
    format: right.format || left.format,
    cssSource: right.cssSource || left.cssSource,
    source: right.source || left.source,
    url: left.url || right.url,
    weight: right.weight || left.weight,
    style: right.style || left.style,
    filename: right.filename || left.filename,
    originalFilename: right.originalFilename || left.originalFilename,
    name: right.name || left.name
  };
};
var pickBestFontForUrl = (fonts, url) => fonts.filter((font) => String(font?.url || "") === url).reduce((best, current) => mergeFontRecords(best, current), null);

// server.ts
var require3 = createRequire2(import.meta.url);
var getAppRoot = () => process.env.VDX_APP_ROOT || process.cwd();
var insightsPageEvaluate = require3(path3.join(getAppRoot(), "scripts", "insights-page-evaluate.cjs"));
var execFileAsync2 = promisify2(execFile2);
var clearMacQuarantine = async (filePath) => {
  if (process.platform !== "darwin" || !filePath) return;
  await execFileAsync2("/usr/bin/xattr", ["-d", "com.apple.quarantine", filePath]).catch(() => void 0);
};
var getResourcesPath = () => process.env.VDX_RESOURCES_PATH || getAppRoot();
var getUnpackedModulePath = (...segments) => {
  const resources = process.env.VDX_RESOURCES_PATH;
  if (resources) {
    const unpacked = path3.join(resources, "app.asar.unpacked", ...segments);
    if (fs2.existsSync(unpacked)) return unpacked;
  }
  return path3.join(getAppRoot(), ...segments);
};
var resolveBundledBinPath = (binaryName2) => {
  const ext = process.platform === "win32" ? ".exe" : "";
  const fileName = `${binaryName2}${ext}`;
  const candidates = [
    path3.join(getResourcesPath(), "bin", fileName),
    path3.join(getAppRoot(), "vendor", "bin-pack", fileName)
  ];
  return candidates.find((candidate) => fs2.existsSync(candidate)) || "";
};
var resolveFfprobePath = (ffmpegBinaryPath = "") => {
  const bundled = resolveBundledBinPath("ffprobe");
  if (bundled) return bundled;
  try {
    const installer = require3("@ffprobe-installer/ffprobe");
    if (installer?.path && fs2.existsSync(String(installer.path))) return String(installer.path);
  } catch {
  }
  const ffmpegDir = ffmpegBinaryPath ? path3.dirname(ffmpegBinaryPath) : "";
  if (ffmpegDir) {
    const sibling = path3.join(ffmpegDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (fs2.existsSync(sibling)) return sibling;
  }
  return "";
};
var resolveFfmpegBinaryPath = () => {
  const bundled = resolveBundledBinPath("ffmpeg");
  if (bundled) return bundled;
  if (ffmpegPath && fs2.existsSync(String(ffmpegPath))) return String(ffmpegPath);
  const unpacked = getUnpackedModulePath("node_modules", "ffmpeg-static", "ffmpeg");
  if (fs2.existsSync(unpacked)) return unpacked;
  return ffmpegPath ? String(ffmpegPath) : "";
};
var isPythonScriptBinary = (filePath) => {
  try {
    const head = fs2.readFileSync(filePath, { encoding: "utf8" }).slice(0, 128);
    return /^#!.*python/i.test(head);
  } catch {
    return false;
  }
};
var isAcceptableYtDlpBinary = (filePath) => {
  const candidate = String(filePath || "").trim();
  if (!candidate || !fs2.existsSync(candidate) || isPythonScriptBinary(candidate)) return false;
  return true;
};
var resolveYtDlpPath = () => {
  const candidates = [
    resolveBundledBinPath("yt-dlp"),
    path3.join(getAppRoot(), "vendor", "bin-pack", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
    path3.join(os3.homedir(), ".creative-asset-extractor", "runtime-bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp")
  ];
  return candidates.find((candidate) => isAcceptableYtDlpBinary(candidate)) || "";
};
var resolveAria2BinaryPath = () => {
  const candidates = [
    resolveBundledBinPath("aria2c"),
    path3.join(getAppRoot(), "vendor", "bin-pack", process.platform === "win32" ? "aria2c.exe" : "aria2c"),
    path3.join(getResourcesPath(), "vendor", "aria2", process.platform === "win32" ? "aria2c.exe" : "aria2c"),
    path3.join(os3.homedir(), ".creative-asset-extractor", "runtime-bin", process.platform === "win32" ? "aria2c.exe" : "aria2c")
  ];
  return candidates.find((candidate) => candidate && fs2.existsSync(candidate)) || "";
};
var resolvedFfmpegPath = resolveFfmpegBinaryPath();
var resolvedFfprobePath = resolveFfprobePath(resolvedFfmpegPath);
var resolvedYtDlpPath = resolveYtDlpPath();
var resolvedAria2Path = resolveAria2BinaryPath();
var logYouTubeMerge = (stage, details = {}) => {
  console.log(
    `[youtube-merge:${stage}]`,
    JSON.stringify({
      ...details,
      ffmpegPath: resolvedFfmpegPath,
      ffprobePath: resolvedFfprobePath,
      ytdlpPath: resolvedYtDlpPath,
      resourcesPath: getResourcesPath(),
      tempDir: path3.join(os3.tmpdir(), "creative-asset-extractor-mp4"),
      ts: (/* @__PURE__ */ new Date()).toISOString()
    })
  );
};
var findBundledChromiumExecutable = () => {
  const chromeCacheRoot = path3.join(getResourcesPath(), "chromium", "chrome");
  if (!fs2.existsSync(chromeCacheRoot)) return "";
  const variants = process.platform === "win32" ? [{ prefix: "win64-", segments: ["chrome-win64", "chrome.exe"] }] : process.platform === "linux" ? [{ prefix: "linux-", segments: ["chrome-linux64", "chrome"] }] : process.arch === "arm64" ? [{ prefix: "mac_arm-", segments: ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"] }] : [{ prefix: "mac-", segments: ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"] }];
  try {
    const entries = fs2.readdirSync(chromeCacheRoot);
    for (const variant of variants) {
      const versionDir = entries.find((name) => {
        if (variant.prefix === "mac-") return name.startsWith("mac-") && !name.startsWith("mac_arm-");
        return name.startsWith(variant.prefix);
      });
      if (!versionDir) continue;
      const executable = path3.join(chromeCacheRoot, versionDir, ...variant.segments);
      if (fs2.existsSync(executable)) return executable;
    }
    return "";
  } catch {
    return "";
  }
};
if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
}
if (resolvedFfprobePath) {
  ffmpeg.setFfprobePath(resolvedFfprobePath);
}
var ytDlpCookieAccessDenied = (message) => /cookies|operation not permitted|errno 1/i.test(message);
var wrapYtDlpWithCookieFallback = (impl) => (async (url, options = {}) => {
  try {
    return await impl(url, options);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (options.cookiesFromBrowser && ytDlpCookieAccessDenied(message)) {
      const { cookiesFromBrowser: _ignored, ...withoutCookies } = options;
      return await impl(url, withoutCookies);
    }
    throw error;
  }
});
var youtubedl = wrapYtDlpWithCookieFallback(
  youtubedlModule
);
var stageRuntimeBinary = async (sourcePath, binaryName2) => {
  const source = String(sourcePath || "").trim();
  if (!source || !fs2.existsSync(source)) return "";
  if (!source.includes(" ")) {
    await clearMacQuarantine(source);
    return source;
  }
  const destDir = path3.join(os3.homedir(), ".creative-asset-extractor", "runtime-bin");
  const destName = process.platform === "win32" ? `${binaryName2}.exe` : binaryName2;
  const dest = path3.join(destDir, destName);
  await fsp3.mkdir(destDir, { recursive: true });
  try {
    const [srcStat, destStat] = await Promise.all([fsp3.stat(source), fsp3.stat(dest).catch(() => null)]);
    if (!destStat || destStat.size !== srcStat.size || destStat.mtimeMs < srcStat.mtimeMs) {
      await fsp3.copyFile(source, dest);
      await fsp3.chmod(dest, 493);
    }
  } catch {
    await fsp3.copyFile(source, dest);
    await fsp3.chmod(dest, 493);
  }
  await clearMacQuarantine(dest);
  logYouTubeMerge("stage-runtime-binary", { source, dest, binaryName: binaryName2 });
  return dest;
};
var refreshResolvedMediaTools = async () => {
  const ffmpegSource = resolveFfmpegBinaryPath();
  const ytdlpSource = resolveYtDlpPath();
  const aria2Source = resolveAria2BinaryPath();
  resolvedFfmpegPath = await stageRuntimeBinary(ffmpegSource, "ffmpeg");
  resolvedFfprobePath = await stageRuntimeBinary(resolveFfprobePath(ffmpegSource), "ffprobe");
  resolvedYtDlpPath = await stageRuntimeBinary(ytdlpSource, "yt-dlp");
  resolvedAria2Path = aria2Source ? await stageRuntimeBinary(aria2Source, "aria2c") : "";
  if (resolvedFfmpegPath) {
    ffmpeg.setFfmpegPath(resolvedFfmpegPath);
    await fsp3.chmod(resolvedFfmpegPath, 493).catch(() => void 0);
  }
  if (resolvedFfprobePath) {
    ffmpeg.setFfprobePath(resolvedFfprobePath);
    await fsp3.chmod(resolvedFfprobePath, 493).catch(() => void 0);
  }
  if (resolvedYtDlpPath) {
    if (isPythonScriptBinary(resolvedYtDlpPath)) {
      throw new Error("Bundled yt-dlp is a Python script. Rebuild the desktop app to bundle the standalone yt-dlp binary.");
    }
    await fsp3.chmod(resolvedYtDlpPath, 493).catch(() => void 0);
    await clearMacQuarantine(resolvedYtDlpPath);
  }
  if (resolvedAria2Path) await fsp3.chmod(resolvedAria2Path, 493).catch(() => void 0);
  aria2Path = resolvedAria2Path;
  try {
    const { create: createYtDlp } = require3("youtube-dl-exec");
    if (resolvedYtDlpPath && typeof createYtDlp === "function") {
      youtubedl = wrapYtDlpWithCookieFallback(createYtDlp(resolvedYtDlpPath));
    }
  } catch {
  }
  logYouTubeMerge("runtime-tools", {
    ffmpegReady: Boolean(resolvedFfmpegPath),
    ffprobeReady: Boolean(resolvedFfprobePath),
    ytdlpReady: Boolean(resolvedYtDlpPath),
    aria2Ready: Boolean(resolvedAria2Path),
    ytdlpStandalone: resolvedYtDlpPath ? !isPythonScriptBinary(resolvedYtDlpPath) : false
  });
};
var aria2Path = resolvedAria2Path;
var woff2Ready = null;
var ensureWoff2Ready = async () => {
  if (!woff2Ready) {
    woff2Ready = import("fonteditor-core").then(({ woff2: woff22 }) => woff22.init()).then(() => void 0).catch((error) => {
      woff2Ready = null;
      throw error;
    });
  }
  await woff2Ready;
};
var resolveAppDataDir = () => String(process.env.VDX_USER_DATA || "").trim() || path3.join(os3.homedir(), ".creative-asset-extractor");
var app = express();
var DEFAULT_PORT = Number(process.env.PORT || 3e3);
var activePort = DEFAULT_PORT;
var appCacheRoot = path3.join(resolveAppDataDir(), "cache");
var convertedVideoDir = path3.join(os3.tmpdir(), "creative-asset-extractor-mp4");
var convertedAudioDir = path3.join(os3.tmpdir(), "creative-asset-extractor-audio");
var generatedThumbnailDir = path3.join(appCacheRoot, "thumbnails");
var generatedImageThumbDir = path3.join(appCacheRoot, "image-thumbs");
var cachedImageDir = path3.join(appCacheRoot, "images");
var cachedFontDir = path3.join(appCacheRoot, "fonts");
var cachedImageOriginalDir = path3.join(appCacheRoot, "images-original");
var cachedFontOriginalDir = path3.join(appCacheRoot, "fonts-original");
var downloadsDir = String(process.env.CAE_DOWNLOADS_DIR || "").trim() || path3.join(os3.homedir(), "Downloads");
var lastExtractedSourceUrl = "";
var activeExtractProgress = null;
var looksLikeStandaloneAssetSourceUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL2(raw);
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
var normalizeProjectSourcePageUrl = (candidate, fallback = lastExtractedSourceUrl) => {
  const raw = String(candidate || "").trim();
  const fallbackUrl = String(fallback || "").trim();
  if (raw && !looksLikeStandaloneAssetSourceUrl(raw)) return raw;
  if (fallbackUrl && fallbackUrl !== raw && !looksLikeStandaloneAssetSourceUrl(fallbackUrl)) return fallbackUrl;
  return raw || fallbackUrl;
};
var readSourcePageUrl = (req, explicit) => {
  const direct = String(explicit || "").trim();
  if (direct) return normalizeProjectSourcePageUrl(direct);
  if (!req) return normalizeProjectSourcePageUrl(lastExtractedSourceUrl);
  const fromQuery = typeof req.query?.sourcePageUrl === "string" ? req.query.sourcePageUrl.trim() : "";
  const fromBody = typeof req.body?.sourcePageUrl === "string" ? req.body.sourcePageUrl.trim() : "";
  return normalizeProjectSourcePageUrl(fromQuery || fromBody || lastExtractedSourceUrl);
};
var lastExtractionSectionMode = false;
var resolveDownloadSaveDir = (kind = "default", sourcePageUrl) => {
  const pageUrl = String(sourcePageUrl || lastExtractedSourceUrl || "").trim();
  const pathOptions = { sectionMode: lastExtractionSectionMode };
  if (kind === "font") return resolveCreativeAssetsDir(pageUrl, "Fonts", pathOptions);
  if (kind === "icon") return resolveCreativeAssetsDir(pageUrl, "Images", pathOptions);
  if (kind === "color") return resolveCreativeAssetsDir(pageUrl, "Colors", pathOptions);
  if (kind === "image") return resolveCreativeAssetsDir(pageUrl, "Images", pathOptions);
  if (kind === "zip") return resolveCreativeAssetsRoot(pageUrl, pathOptions);
  if (kind === "video" || kind === "audio") {
    const platform = platformProviderFromUrl(pageUrl) || "video";
    return resolvePlatformVideoAssetsDir(platform);
  }
  return resolveCreativeAssetsRoot(pageUrl, pathOptions);
};
var resolveVideoDownloadTargetDir = (sourcePageUrl, saveToWebsiteAssets = false) => saveToWebsiteAssets ? resolveCreativeAssetsDir(String(sourcePageUrl || lastExtractedSourceUrl || "").trim(), "Videos") : resolveDownloadSaveDir("video", String(sourcePageUrl || lastExtractedSourceUrl || "").trim());
var resolveDownloadsTargetDir = (sourcePageUrl) => resolveVideoDownloadTargetDir(String(sourcePageUrl || lastExtractedSourceUrl || "").trim());
var assertPathInsideDownloads = (filePath) => {
  const resolved = path3.resolve(filePath);
  const root = path3.resolve(downloadsDir);
  if (resolved === root || resolved.startsWith(root + path3.sep)) return resolved;
  throw new Error("Download path resolved outside Downloads.");
};
var appDataDir = resolveAppDataDir();
var feedbackInboxPath = path3.join(appDataDir, "feedback", "inbox.jsonl");
var feedbackConfigPath = path3.join(appDataDir, "feedback-config.json");
var activityLogPath = path3.join(appDataDir, "logs", "activity.jsonl");
var feedbackScreenshotDir = path3.join(appDataDir, "feedback", "screenshots");
var MAX_ACTIVITY_LOG_ENTRIES = 100;
var bookmarksDir = path3.join(appDataDir, "bookmarks");
var bookmarksPath = path3.join(bookmarksDir, "bookmarks.json");
var bookmarkBackupsDir = path3.join(bookmarksDir, "backups");
var cleanupDisposableStorage = async () => {
  const legacyDataDir = path3.join(os3.homedir(), ".creative-asset-extractor");
  const disposableAppDataPaths = [
    appCacheRoot,
    path3.join(appDataDir, "feedback"),
    path3.join(appDataDir, "Cache"),
    path3.join(appDataDir, "Code Cache"),
    path3.join(appDataDir, "GPUCache"),
    path3.join(appDataDir, "DawnCache"),
    path3.join(appDataDir, "DawnGraphiteCache"),
    path3.join(appDataDir, "DawnWebGPUCache"),
    path3.join(appDataDir, "blob_storage"),
    path3.join(appDataDir, "VideoDecodeStats"),
    path3.join(appDataDir, "Shared Dictionary"),
    path3.join(appDataDir, "shared_proto_db"),
    path3.join(appDataDir, "Service Worker", "CacheStorage"),
    bookmarkBackupsDir,
    path3.join(legacyDataDir, "cache"),
    path3.join(legacyDataDir, "feedback"),
    path3.join(legacyDataDir, "logs"),
    path3.join(legacyDataDir, "bookmarks", "backups")
  ];
  const disposableTempPaths = [convertedVideoDir, convertedAudioDir];
  const tempEntries = await fsp3.readdir(os3.tmpdir()).catch(() => []);
  for (const entry of tempEntries) {
    if (/^creative-asset-extractor-(?:browser-profile|mp4|audio)/i.test(entry)) {
      disposableTempPaths.push(path3.join(os3.tmpdir(), entry));
    }
  }
  await Promise.all(
    [.../* @__PURE__ */ new Set([...disposableAppDataPaths, ...disposableTempPaths])].map((target) => fsp3.rm(target, { recursive: true, force: true }).catch(() => void 0))
  );
};
var relaxedHttpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });
var activeExtractionProxyUrl = "";
var normalizeExtractionProxyUrl = (rawProxyUrl) => {
  const value = String(rawProxyUrl || "").trim();
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL2(value);
  } catch {
    throw new Error("Proxy URL must include protocol, host, and port. Example: http://user:pass@host:port");
  }
  if (!["http:", "https:", "socks4:", "socks5:"].includes(parsed.protocol)) {
    throw new Error("Proxy protocol must be http, https, socks4, or socks5.");
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error("Proxy URL must include host and port. Example: http://user:pass@host:port");
  }
  return parsed.href;
};
var axiosProxyOptions = (rawProxyUrl = activeExtractionProxyUrl) => {
  const proxyUrl = String(rawProxyUrl || "").trim();
  if (!proxyUrl) return {};
  try {
    const parsed = new URL2(proxyUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return {};
    return {
      proxy: {
        protocol: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port: Number(parsed.port),
        ...parsed.username || parsed.password ? {
          auth: {
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password)
          }
        } : {}
      }
    };
  } catch {
    return {};
  }
};
var proxyServerArg = (rawProxyUrl = activeExtractionProxyUrl) => {
  const proxyUrl = String(rawProxyUrl || "").trim();
  if (!proxyUrl) return "";
  try {
    const parsed = new URL2(proxyUrl);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
};
var applyProxyAuthToPage = async (page, rawProxyUrl = activeExtractionProxyUrl) => {
  const proxyUrl = String(rawProxyUrl || "").trim();
  if (!proxyUrl) return;
  try {
    const parsed = new URL2(proxyUrl);
    if (!parsed.username && !parsed.password) return;
    await page.authenticate({
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password)
    });
  } catch {
  }
};
var loadProjectEnvFile = () => {
  const candidates = [
    path3.join(process.cwd(), ".env"),
    ...process.env.VDX_APP_ROOT ? [path3.join(String(process.env.VDX_APP_ROOT), ".env")] : []
  ];
  for (const envPath of candidates) {
    try {
      if (!fs2.existsSync(envPath)) continue;
      const text = fs2.readFileSync(envPath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator <= 0) continue;
        const key = trimmed.slice(0, separator).trim();
        const rawValue = trimmed.slice(separator + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, "");
        if (key && process.env[key] === void 0) process.env[key] = value;
      }
      return;
    } catch {
    }
  }
};
loadProjectEnvFile();
var DEFAULT_FEEDBACK_SHEET_ID = "1dxhHtdi06oOwh-9d-ZdMxo8Wa7LIYJBu7lWXTsaP2xI";
var DEFAULT_FEEDBACK_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzLhhL_vAF3coBLJXMKlKLe4JpRPp05f8JwRSgaUxD6luz315Z6RHFwN9mtALhNCSSgFQ/exec";
var EXPECTED_FEEDBACK_SHEET_WEBHOOK_VERSION = 6;
var cachedFeedbackTarget;
var readFeedbackConfigJson = async () => {
  try {
    const raw = await fsp3.readFile(feedbackConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};
var resolveFeedbackSheetConfig = async () => {
  const fromFile = await readFeedbackConfigJson();
  const webhookUrl = String(
    fromFile?.sheetWebhookUrl || process.env.GOOGLE_SHEET_FEEDBACK_WEBHOOK_URL || DEFAULT_FEEDBACK_SHEET_WEBHOOK_URL || ""
  ).trim();
  if (!webhookUrl) return null;
  const sheetId = String(
    fromFile?.sheetId || process.env.GOOGLE_SHEET_ID || DEFAULT_FEEDBACK_SHEET_ID
  ).trim();
  return { webhookUrl, sheetId };
};
var resolveFeedbackFormConfig = async () => {
  const fromFile = await readFeedbackConfigJson();
  const actionUrl = String(
    fromFile?.actionUrl || process.env.GOOGLE_FORM_ACTION_URL || process.env.VITE_GOOGLE_FORM_ACTION_URL || ""
  ).trim();
  const nameEntryId = String(
    fromFile?.nameEntryId || process.env.GOOGLE_FORM_NAME_ENTRY || process.env.VITE_GOOGLE_FORM_NAME_ENTRY || ""
  ).trim();
  const suggestionsEntryId = String(
    fromFile?.suggestionsEntryId || process.env.GOOGLE_FORM_SUGGESTIONS_ENTRY || process.env.VITE_GOOGLE_FORM_SUGGESTIONS_ENTRY || ""
  ).trim();
  const appVersionEntryId = String(
    fromFile?.appVersionEntryId || process.env.GOOGLE_FORM_APP_VERSION_ENTRY || process.env.VITE_GOOGLE_FORM_APP_VERSION_ENTRY || ""
  ).trim();
  const platformEntryId = String(
    fromFile?.platformEntryId || process.env.GOOGLE_FORM_PLATFORM_ENTRY || process.env.VITE_GOOGLE_FORM_PLATFORM_ENTRY || ""
  ).trim();
  if (!actionUrl || !nameEntryId || !suggestionsEntryId) return null;
  return {
    actionUrl,
    nameEntryId,
    suggestionsEntryId,
    ...appVersionEntryId ? { appVersionEntryId } : {},
    ...platformEntryId ? { platformEntryId } : {}
  };
};
var resolveFeedbackTarget = async () => {
  if (cachedFeedbackTarget !== void 0) return cachedFeedbackTarget;
  const sheet = await resolveFeedbackSheetConfig();
  if (sheet) {
    cachedFeedbackTarget = { mode: "sheet", config: sheet };
    return cachedFeedbackTarget;
  }
  const googleForm = await resolveFeedbackFormConfig();
  if (googleForm) {
    cachedFeedbackTarget = { mode: "google-form", config: googleForm };
    return cachedFeedbackTarget;
  }
  cachedFeedbackTarget = null;
  return null;
};
var appendLocalFeedbackInbox = async (payload) => {
  await fsp3.mkdir(path3.dirname(feedbackInboxPath), { recursive: true });
  const entry = {
    ...payload,
    destination: "frontendtech01@gmail.com"
  };
  await fsp3.appendFile(feedbackInboxPath, `${JSON.stringify(entry)}
`, "utf8");
};
var appendActivityLogEntry = async (entry) => {
  await fsp3.mkdir(path3.dirname(activityLogPath), { recursive: true });
  const sanitized = {
    ...entry,
    timestamp: String(entry.timestamp || (/* @__PURE__ */ new Date()).toISOString())
  };
  let lines = [];
  try {
    const raw = await fsp3.readFile(activityLogPath, "utf8");
    lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(sanitized));
  if (lines.length > MAX_ACTIVITY_LOG_ENTRIES) {
    lines = lines.slice(-MAX_ACTIVITY_LOG_ENTRIES);
  }
  await fsp3.writeFile(activityLogPath, `${lines.join("\n")}
`, "utf8");
};
var readRecentActivityLogs = async (limit = 20) => {
  try {
    const raw = await fsp3.readFile(activityLogPath, "utf8");
    return raw.split("\n").map((line) => line.trim()).filter(Boolean).slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
};
var submitFeedbackToGoogleForm = async (config, payload) => {
  const body = new URLSearchParams();
  body.set(config.nameEntryId, payload.name);
  const enrichedSuggestions = [
    payload.suggestions,
    payload.category && payload.category !== "Suggestion" ? `Category: ${payload.category}` : "",
    payload.lastError ? `Last error: ${payload.lastError}` : "",
    payload.websiteUrl ? `Website URL: ${payload.websiteUrl}` : "",
    payload.videoUrl ? `Video URL: ${payload.videoUrl}` : "",
    payload.fontName ? `Font: ${payload.fontName}` : "",
    payload.screenshotUrl ? `Screenshot: ${payload.screenshotUrl}` : "",
    `OS: ${payload.osLabel}`,
    `Platform: ${payload.platform} \xB7 ${payload.architecture}`,
    `Submitted: ${payload.submittedAt}`
  ].filter(Boolean).join("\n");
  body.set(config.suggestionsEntryId, enrichedSuggestions);
  if (config.appVersionEntryId) body.set(config.appVersionEntryId, payload.appVersion);
  if (config.platformEntryId) {
    body.set(config.platformEntryId, `${payload.platform} \xB7 ${payload.architecture}`);
  }
  await axios.post(config.actionUrl, body.toString(), {
    timeout: 12e3,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });
};
var probeFeedbackSheetWebhook = async (webhookUrl) => {
  try {
    const response = await axios.get(webhookUrl, {
      timeout: 8e3,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300
    });
    const data = response.data;
    if (!data || typeof data !== "object") {
      return { ok: false, version: 0, columns: 0, service: "" };
    }
    return {
      ok: Boolean(data.ok),
      version: Number(data.version) || 0,
      columns: Number(data.columns) || 0,
      service: String(data.service || "")
    };
  } catch {
    return { ok: false, version: 0, columns: 0, service: "" };
  }
};
var resolveFeedbackScreenshotPath = (screenshotUrl) => {
  const raw = String(screenshotUrl || "").trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;
  if (raw.startsWith("~/")) return path3.join(os3.homedir(), raw.slice(2));
  if (raw.startsWith("~")) return path3.join(os3.homedir(), raw.slice(1));
  return path3.resolve(raw);
};
var attachScreenshotToSheetPayload = async (sheetPayload, screenshotUrl, screenshotDataUrl = "") => {
  const dataUrl = String(screenshotDataUrl || "").trim();
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
var readScreenshotAttachmentForWebhook = async (screenshotUrl) => {
  const filePath = resolveFeedbackScreenshotPath(screenshotUrl);
  if (!filePath) return null;
  try {
    const buffer = await fsp3.readFile(filePath);
    if (!buffer.length) return null;
    return await compressScreenshotBufferForSheet(buffer);
  } catch {
    return null;
  }
};
var persistFeedbackConfigPatch = async (patch) => {
  const existing = await readFeedbackConfigJson() || {};
  await fsp3.mkdir(path3.dirname(feedbackConfigPath), { recursive: true });
  await fsp3.writeFile(
    feedbackConfigPath,
    `${JSON.stringify({ ...existing, ...patch }, null, 2)}
`,
    "utf8"
  );
};
var submitFeedbackToGoogleSheet = async (config, payload, screenshotDataUrl = "") => {
  const sheetPayload = { ...payload };
  await attachScreenshotToSheetPayload(sheetPayload, payload.screenshotUrl, screenshotDataUrl);
  const response = await axios.post(config.webhookUrl, sheetPayload, {
    timeout: 45e3,
    headers: { "Content-Type": "application/json" },
    maxRedirects: 5,
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300
  });
  const data = response.data;
  if (data && typeof data === "object" && data.ok === false) {
    throw new Error(String(data.error || "Google Sheet feedback webhook rejected the submission."));
  }
  const webhookVersion = Number(data?.version) || 0;
  if (webhookVersion > 0) {
    await persistFeedbackConfigPatch({
      sheetWebhookVersion: webhookVersion,
      sheetWebhookVersionCheckedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
};
var submitFeedbackRemote = async (target, payload, options = {}) => {
  if (target.mode === "sheet") {
    await submitFeedbackToGoogleSheet(target.config, payload, options.screenshotDataUrl);
    return "sheet";
  }
  await submitFeedbackToGoogleForm(target.config, payload);
  return "google-form";
};
app.set("trust proxy", 1);
app.disable("x-powered-by");
var isPrivateAssetHost = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/^www\./, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (net.isIP(host)) {
    if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^fc|^fd|^fe80:/i.test(host)) return true;
  }
  return false;
};
var assertPublicAssetUrl = (rawUrl) => {
  const parsed = new URL2(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) asset URLs are allowed.");
  }
  if (isPrivateAssetHost(parsed.hostname)) {
    throw new Error("Private or local asset URLs are blocked.");
  }
};
var normalizeLocalHost = (value = "") => (() => {
  const raw = String(value).trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw.replace(/^\[/, "");
  }
  return raw.split(":")[0];
})();
var isLoopbackHost = (value = "") => {
  const host = normalizeLocalHost(value);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
};
var normalizeRemoteAddress = (value = "") => String(value).replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
var isLoopbackRemote = (value = "") => {
  const normalized = normalizeRemoteAddress(value);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
};
var isSameAppOrigin = (req, rawOrigin = "") => {
  if (!rawOrigin) return true;
  try {
    const origin = new URL2(rawOrigin);
    const requestHost = req.get("host") || `localhost:${activePort || DEFAULT_PORT}`;
    return origin.protocol === `${req.protocol}:` && origin.host === requestHost && isLoopbackHost(origin.hostname);
  } catch {
    return false;
  }
};
var localOnlyGuard = (req, res, next) => {
  const remoteAddress = req.socket.remoteAddress || req.ip || "";
  if (!isLoopbackRemote(remoteAddress)) {
    return res.status(403).json({ error: "This local app only accepts requests from this computer." });
  }
  if (!isLoopbackHost(req.hostname)) {
    return res.status(403).json({ error: "This local app is locked to localhost." });
  }
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return res.status(403).json({ error: "Cross-site access is blocked." });
  }
  const origin = req.get("origin") || "";
  if (origin && !isSameAppOrigin(req, origin)) {
    return res.status(403).json({ error: "Only the local app can access this data." });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
};
var privateStaticOptions = {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
};
var formatDisplayName = (raw) => {
  const cleaned = String(raw || "").trim().replace(/[._-]+/g, " ");
  if (!cleaned) return "";
  return cleaned.split(/\s+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
};
var extractUsernameFromPath = (value) => {
  const match = String(value || "").match(/(?:\/Users\/|\/home\/|C:\\Users\\)([^/\\]+)/i);
  return match?.[1] || "";
};
var getSuggestedDisplayName = () => {
  const osUsername = (() => {
    try {
      return String(os3.userInfo().username || "").trim();
    } catch {
      return "";
    }
  })();
  const homeFolder = extractUsernameFromPath(os3.homedir());
  const downloadsFolder = extractUsernameFromPath(downloadsDir);
  return formatDisplayName(downloadsFolder || homeFolder || osUsername);
};
var getCurrentUserName = () => {
  return getSuggestedDisplayName() || "user";
};
var getMacOsFriendlyName = (darwinMajor) => {
  const names = {
    24: "Sequoia",
    23: "Sonoma",
    22: "Ventura",
    21: "Monterey",
    20: "Big Sur"
  };
  return names[darwinMajor] || "";
};
var getFeedbackPlatformMeta = () => {
  const platformRaw = process.platform;
  const archRaw = process.arch;
  const platform = platformRaw === "darwin" ? "macOS" : platformRaw === "win32" ? "Windows" : platformRaw === "linux" ? "Linux" : platformRaw;
  let osLabel = platform;
  if (platformRaw === "darwin") {
    const darwinMajor = Number(String(os3.release() || "").split(".")[0] || 0);
    const friendly = getMacOsFriendlyName(darwinMajor);
    osLabel = friendly ? `macOS ${friendly}` : `macOS ${os3.release()}`;
  } else if (platformRaw === "win32") {
    osLabel = `Windows ${os3.release()}`;
  } else if (platformRaw === "linux") {
    osLabel = `Linux ${os3.release()}`;
  }
  const architecture = archRaw === "arm64" ? "Apple Silicon" : archRaw === "x64" ? "Intel/AMD64" : archRaw;
  return { platform, architecture, osLabel, platformRaw, archRaw };
};
var toSafeUserFilePart = (value) => String(value || "user").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "user";
var toLocalVideoDownloadUrl = (req, filename, sourcePageUrl) => {
  const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
  const relative = path3.relative(downloadsDir, path3.join(targetDir, filename));
  return toAbsoluteAppUrl(req, `/api/download-local-video?filename=${encodeURIComponent(relative)}`);
};
var fileExists = async (filePath) => {
  if (!filePath) return false;
  try {
    await fsp3.access(filePath, fs2.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (req.path.startsWith("/api/") || req.path.startsWith("/converted-") || req.path.startsWith("/generated-thumbnails") || req.path.startsWith("/cached-")) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
  next();
});
app.use("/api", localOnlyGuard);
app.use(express.json({ limit: "15mb" }));
app.use("/converted-videos", localOnlyGuard, express.static(convertedVideoDir, privateStaticOptions));
app.use("/converted-audio", localOnlyGuard, express.static(convertedAudioDir, privateStaticOptions));
app.use("/generated-thumbnails", localOnlyGuard, express.static(generatedThumbnailDir, privateStaticOptions));
app.use("/generated-image-thumbs", localOnlyGuard, express.static(generatedImageThumbDir, privateStaticOptions));
app.use("/cached-images", localOnlyGuard, express.static(cachedImageDir, privateStaticOptions));
app.use("/cached-fonts", localOnlyGuard, express.static(cachedFontDir, privateStaticOptions));
app.use("/cached-images-original", localOnlyGuard, express.static(cachedImageOriginalDir, privateStaticOptions));
app.use("/cached-fonts-original", localOnlyGuard, express.static(cachedFontOriginalDir, privateStaticOptions));
var limiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  // 15 minutes
  max: 400,
  // higher ceiling for local iterative use
  skip: (req) => {
    const ip = String(req.ip || "");
    return ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1");
  },
  validate: {
    xForwardedForHeader: false,
    trustProxy: false
  }
});
app.use("/api/", limiter);
var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
var bookmarkId = () => typeof crypto2.randomUUID === "function" ? crypto2.randomUUID() : crypto2.randomBytes(16).toString("hex");
var normalizeBookmarkUrlServer = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL2(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    parsed.hash = "";
    if (parsed.protocol === "https:" && parsed.port === "443" || parsed.protocol === "http:" && parsed.port === "80") parsed.port = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
    if (parsed.pathname === "/") parsed.pathname = "";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return raw.replace(/\/+$/g, "");
  }
};
var titleFromBookmarkUrl = (value) => {
  try {
    const parsed = new URL2(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return String(value || "").trim() || "Untitled";
  }
};
var faviconForUrl = (value) => {
  try {
    const parsed = new URL2(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(parsed.origin)}&sz=64`;
  } catch {
    return "";
  }
};
var emptyBookmarkStore = () => ({
  version: 1,
  bookmarks: [],
  folders: [],
  history: [],
  updatedAt: nowIso()
});
var readBookmarkStore = async () => {
  try {
    const raw = await fsp3.readFile(bookmarksPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...emptyBookmarkStore(),
      ...parsed,
      bookmarks: Array.isArray(parsed?.bookmarks) ? parsed.bookmarks : [],
      folders: Array.isArray(parsed?.folders) ? parsed.folders : [],
      history: Array.isArray(parsed?.history) ? parsed.history : []
    };
  } catch {
    return emptyBookmarkStore();
  }
};
var writeBookmarkStore = async (store) => {
  await fsp3.mkdir(bookmarksDir, { recursive: true });
  await fsp3.rm(bookmarkBackupsDir, { recursive: true, force: true }).catch(() => void 0);
  const normalized = {
    ...emptyBookmarkStore(),
    ...store,
    lastBackupDate: void 0,
    updatedAt: nowIso()
  };
  await fsp3.writeFile(bookmarksPath, JSON.stringify(normalized, null, 2));
  return normalized;
};
var normalizeBookmarkRecord = (payload, existing) => {
  const url = String(payload?.url ?? existing?.url ?? "").trim();
  const normalizedUrl = normalizeBookmarkUrlServer(url);
  if (!normalizedUrl) throw new Error("Bookmark URL is required.");
  const category = String(payload?.category ?? existing?.category ?? "website") === "video" ? "video" : "website";
  const title = String(payload?.title ?? existing?.title ?? titleFromBookmarkUrl(url)).trim() || titleFromBookmarkUrl(url);
  const tags = Array.isArray(payload?.tags) ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean) : Array.isArray(existing?.tags) ? existing.tags : [];
  return {
    id: existing?.id || bookmarkId(),
    title,
    url,
    normalizedUrl,
    category,
    folderId: payload?.folderId ?? existing?.folderId ?? null,
    createdAt: existing?.createdAt || nowIso(),
    lastUsed: payload?.lastUsed ?? existing?.lastUsed ?? null,
    notes: String(payload?.notes ?? existing?.notes ?? ""),
    tags,
    favorite: Boolean(payload?.favorite ?? existing?.favorite ?? false),
    faviconUrl: String(payload?.faviconUrl ?? existing?.faviconUrl ?? faviconForUrl(url)),
    extraction: payload?.extraction ?? existing?.extraction,
    sortIndex: Number.isFinite(Number(payload?.sortIndex ?? existing?.sortIndex)) ? Number(payload?.sortIndex ?? existing?.sortIndex) : Date.now()
  };
};
var buildChromeBookmarksHtml = (store) => {
  const esc = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rows = store.bookmarks.sort((a, b) => a.sortIndex - b.sortIndex).map((bookmark) => {
    const addDate = Math.floor(Date.parse(bookmark.createdAt || nowIso()) / 1e3);
    const lastVisit = bookmark.lastUsed ? Math.floor(Date.parse(bookmark.lastUsed) / 1e3) : addDate;
    return `        <DT><A HREF="${esc(bookmark.url)}" ADD_DATE="${addDate}" LAST_VISIT="${lastVisit}" TAGS="${esc((bookmark.tags || []).join(","))}">${esc(bookmark.title)}</A>`;
  }).join("\n");
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${Math.floor(Date.now() / 1e3)}">Creative Asset Extractor</H3>
    <DL><p>
${rows}
    </DL><p>
</DL><p>
`;
};
var parseChromeBookmarksHtml = (content) => {
  const html = String(content || "");
  const results = [];
  const linkRegex = /<A\b([^>]*)>([\s\S]*?)<\/A>/gi;
  let match;
  while (match = linkRegex.exec(html)) {
    const attrs = match[1] || "";
    const href = attrs.match(/\bHREF=["']([^"']+)["']/i)?.[1] || "";
    if (!href) continue;
    const title = (match[2] || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
    const tagsRaw = attrs.match(/\bTAGS=["']([^"']*)["']/i)?.[1] || "";
    results.push({
      url: href,
      title: title || titleFromBookmarkUrl(href),
      category: /(?:youtu\.be|youtube|vimeo|instagram|facebook|x\.com|tiktok|ispot|brightcove)/i.test(href) ? "video" : "website",
      tags: tagsRaw.split(",").map((tag) => tag.trim()).filter(Boolean)
    });
  }
  return results;
};
app.get("/api/bookmarks", async (_req, res) => {
  try {
    return res.json({ ok: true, store: await readBookmarkStore() });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to read bookmarks." });
  }
});
app.get("/api/system-profile", async (_req, res) => {
  const username = String(os3.userInfo?.().username || process.env.USER || "").trim();
  let displayName = username;
  if (process.platform === "darwin" && username) {
    const result = await execFileAsync2("/usr/bin/id", ["-F", username], { encoding: "utf8" }).catch(() => null);
    displayName = String(result?.stdout || "").trim() || username;
  }
  return res.json({ ok: true, username, displayName });
});
app.post("/api/bookmarks", async (req, res) => {
  try {
    const store = await readBookmarkStore();
    const next = normalizeBookmarkRecord(req.body);
    const existingIndex = store.bookmarks.findIndex((bookmark2) => bookmark2.normalizedUrl === next.normalizedUrl && bookmark2.category === next.category);
    if (existingIndex >= 0) {
      store.bookmarks[existingIndex] = normalizeBookmarkRecord({ ...store.bookmarks[existingIndex], ...req.body }, store.bookmarks[existingIndex]);
    } else {
      store.bookmarks.push(next);
    }
    const saved = await writeBookmarkStore(store);
    const bookmark = saved.bookmarks.find((item) => item.normalizedUrl === next.normalizedUrl && item.category === next.category) || next;
    return res.json({ ok: true, bookmark, store: saved });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to save bookmark." });
  }
});
app.put("/api/bookmarks/:id", async (req, res) => {
  try {
    const store = await readBookmarkStore();
    const index = store.bookmarks.findIndex((bookmark) => bookmark.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: "Bookmark not found." });
    store.bookmarks[index] = normalizeBookmarkRecord({ ...store.bookmarks[index], ...req.body }, store.bookmarks[index]);
    const saved = await writeBookmarkStore(store);
    return res.json({ ok: true, bookmark: saved.bookmarks[index], store: saved });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to update bookmark." });
  }
});
app.delete("/api/bookmarks/:id", async (req, res, next) => {
  if (req.params.id === "history") return next();
  const store = await readBookmarkStore();
  store.bookmarks = store.bookmarks.filter((bookmark) => bookmark.id !== req.params.id);
  return res.json({ ok: true, store: await writeBookmarkStore(store) });
});
app.post("/api/bookmarks/:id/duplicate", async (req, res) => {
  const store = await readBookmarkStore();
  const source = store.bookmarks.find((bookmark) => bookmark.id === req.params.id);
  if (!source) return res.status(404).json({ error: "Bookmark not found." });
  const copy = { ...source, id: bookmarkId(), title: `${source.title} copy`, createdAt: nowIso(), normalizedUrl: `${source.normalizedUrl}#copy-${Date.now()}`, sortIndex: Date.now() };
  store.bookmarks.push(copy);
  const saved = await writeBookmarkStore(store);
  return res.json({ ok: true, bookmark: copy, store: saved });
});
app.post("/api/bookmarks/:id/use", async (req, res) => {
  const store = await readBookmarkStore();
  const bookmark = store.bookmarks.find((item) => item.id === req.params.id);
  if (!bookmark) return res.status(404).json({ error: "Bookmark not found." });
  bookmark.lastUsed = nowIso();
  const recent = {
    id: bookmarkId(),
    title: bookmark.title,
    url: bookmark.url,
    normalizedUrl: bookmark.normalizedUrl,
    category: bookmark.category,
    lastUsed: bookmark.lastUsed,
    faviconUrl: bookmark.faviconUrl
  };
  store.history = [recent, ...store.history.filter((item) => !(item.normalizedUrl === recent.normalizedUrl && item.category === recent.category))].slice(0, 100);
  return res.json({ ok: true, store: await writeBookmarkStore(store) });
});
app.post("/api/bookmarks/history", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    const normalizedUrl = normalizeBookmarkUrlServer(url);
    if (!normalizedUrl) return res.status(400).json({ error: "URL is required." });
    const category = String(req.body?.category || "website") === "video" ? "video" : "website";
    const store = await readBookmarkStore();
    const title = String(req.body?.title || "").trim() || titleFromBookmarkUrl(url);
    const lastUsed = nowIso();
    const bookmark = store.bookmarks.find((item) => item.normalizedUrl === normalizedUrl && item.category === category);
    if (bookmark) bookmark.lastUsed = lastUsed;
    const recent = {
      id: bookmarkId(),
      title,
      url,
      normalizedUrl,
      category,
      lastUsed,
      faviconUrl: bookmark?.faviconUrl || faviconForUrl(url)
    };
    store.history = [recent, ...store.history.filter((item) => !(item.normalizedUrl === normalizedUrl && item.category === category))].slice(0, 100);
    return res.json({ ok: true, store: await writeBookmarkStore(store) });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to save history." });
  }
});
var deleteBookmarkHistoryEntries = async (payload) => {
  const { url, category = "website", clearAll = false } = payload || {};
  const store = await readBookmarkStore();
  if (clearAll || !url) {
    store.history = store.history.filter((item) => item.category !== category);
  } else {
    const normalizedUrl = normalizeBookmarkUrlServer(url);
    if (!normalizedUrl) throw new Error("URL is required.");
    store.history = store.history.filter((item) => !(item.normalizedUrl === normalizedUrl && item.category === category));
  }
  return writeBookmarkStore(store);
};
app.post("/api/bookmarks/history/delete", async (req, res) => {
  try {
    const store = await deleteBookmarkHistoryEntries(req.body);
    return res.json({ ok: true, store });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to delete history." });
  }
});
app.post("/api/bookmarks/history/clear", async (req, res) => {
  try {
    const store = await deleteBookmarkHistoryEntries({ ...req.body, clearAll: true });
    return res.json({ ok: true, store });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to clear history." });
  }
});
app.delete("/api/bookmarks/history", async (req, res) => {
  try {
    const store = await deleteBookmarkHistoryEntries(req.body);
    return res.json({ ok: true, store });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to delete history." });
  }
});
app.post("/api/bookmarks/import", async (req, res) => {
  try {
    const content = String(req.body?.content || "");
    const format = String(req.body?.format || "json").toLowerCase();
    const store = await readBookmarkStore();
    const incoming = format === "html" ? parseChromeBookmarksHtml(content) : (() => {
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
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to import bookmarks." });
  }
});
app.get("/api/bookmarks/export.json", async (_req, res) => {
  const store = await readBookmarkStore();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="creative-asset-extractor-bookmarks.json"');
  return res.send(JSON.stringify(store, null, 2));
});
app.get("/api/bookmarks/export.html", async (_req, res) => {
  const store = await readBookmarkStore();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="creative-asset-extractor-bookmarks.html"');
  return res.send(buildChromeBookmarksHtml(store));
});
var resolvePackageMeta = async () => {
  const candidates = [
    path3.join(process.cwd(), "package.json"),
    path3.join(getAppRoot(), "package.json"),
    ...process.env.VDX_APP_ROOT ? [path3.join(String(process.env.VDX_APP_ROOT), "package.json")] : []
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fsp3.readFile(candidate, "utf8");
      const pkg = JSON.parse(raw);
      return {
        version: String(pkg?.version || "1.0.0"),
        productName: String(pkg?.build?.productName || pkg?.name || "Creative Asset Extractor")
      };
    } catch {
    }
  }
  return { version: "1.0.0", productName: "Creative Asset Extractor" };
};
app.get("/api/feedback/profile", async (_req, res) => {
  const pkg = await resolvePackageMeta();
  const platformMeta = getFeedbackPlatformMeta();
  res.json({
    suggestedName: getSuggestedDisplayName(),
    appVersion: pkg.version,
    productName: pkg.productName,
    ...platformMeta
  });
});
app.get("/api/feedback/status", async (_req, res) => {
  const target = await resolveFeedbackTarget();
  const sheet = await resolveFeedbackSheetConfig();
  const googleForm = await resolveFeedbackFormConfig();
  const fromFile = await readFeedbackConfigJson();
  const cachedWebhookVersion = Number(fromFile?.sheetWebhookVersion) || 0;
  const webhookHealth = sheet?.webhookUrl ? await probeFeedbackSheetWebhook(sheet.webhookUrl) : null;
  const sheetWebhookVersion = Math.max(cachedWebhookVersion, webhookHealth?.version || 0);
  const sheetWebhookNeedsUpdate = Boolean(
    sheetWebhookVersion > 0 && sheetWebhookVersion < EXPECTED_FEEDBACK_SHEET_WEBHOOK_VERSION
  );
  res.json({
    ready: true,
    mode: target?.mode || "local",
    contactEmail: "frontendtech01@gmail.com",
    googleSheetConfigured: Boolean(sheet),
    googleFormConfigured: Boolean(googleForm),
    sheetId: sheet?.sheetId || DEFAULT_FEEDBACK_SHEET_ID,
    sheetWebhookVersion,
    sheetWebhookColumns: webhookHealth?.columns || 0,
    sheetWebhookNeedsUpdate,
    expectedSheetWebhookVersion: EXPECTED_FEEDBACK_SHEET_WEBHOOK_VERSION,
    localInboxPath: feedbackInboxPath
  });
});
app.post("/api/activity-log", async (req, res) => {
  try {
    const kind = String(req.body?.kind || "activity").trim();
    const entry = {
      kind,
      message: String(req.body?.message || "").trim(),
      url: String(req.body?.url || "").trim(),
      platform: String(req.body?.platform || "").trim(),
      extractionType: String(req.body?.extractionType || "").trim(),
      assetType: String(req.body?.assetType || "").trim(),
      outputPath: String(req.body?.outputPath || "").trim(),
      error: String(req.body?.error || "").trim(),
      stack: String(req.body?.stack || "").trim(),
      meta: req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : void 0,
      timestamp: String(req.body?.timestamp || (/* @__PURE__ */ new Date()).toISOString())
    };
    await appendActivityLogEntry(entry);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Activity log failed." });
  }
});
var isLocalAppUrl = (value) => {
  try {
    const parsed = new URL2(value);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
};
var readChromeClientTab = async (preferredUrl = "") => {
  if (process.platform !== "darwin") {
    throw new Error("Chrome tab detection is currently available on macOS only.");
  }
  const scriptLines = [
    'tell application "Google Chrome"',
    'if it is not running then return ""',
    'if (count of windows) = 0 then return ""',
    'set fieldSep to "|||VDX_TAB|||"',
    'set tabRows to ""',
    "repeat with windowIndex from 1 to count of windows",
    "set activeTabIndex to active tab index of window windowIndex",
    "repeat with tabIndex from 1 to count of tabs of window windowIndex",
    "set tabUrl to URL of tab tabIndex of window windowIndex",
    "set tabTitle to title of tab tabIndex of window windowIndex",
    "set tabRows to tabRows & windowIndex & fieldSep & tabIndex & fieldSep & activeTabIndex & fieldSep & tabUrl & fieldSep & tabTitle & linefeed",
    "end repeat",
    "end repeat",
    "return tabRows",
    "end tell"
  ];
  const { stdout } = await execFileAsync2(
    "osascript",
    scriptLines.flatMap((line) => ["-e", line]),
    { timeout: 8e3, maxBuffer: 1024 * 1024 }
  );
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const tabs = lines.map((line) => {
    const [windowValue = "", indexValue = "", activeIndexValue = "", url = "", ...titleParts] = line.split("|||VDX_TAB|||");
    return {
      windowIndex: Number(windowValue),
      index: Number(indexValue),
      activeIndex: Number(activeIndexValue),
      url: url.trim(),
      title: titleParts.join("	").trim()
    };
  }).filter((tab) => Number.isFinite(tab.windowIndex) && Number.isFinite(tab.index) && /^https?:\/\//i.test(tab.url));
  if (!tabs.length) throw new Error("Chrome is open, but no website tabs were available.");
  const frontTabs = tabs.filter((tab) => tab.windowIndex === 1);
  const frontActive = frontTabs.find((tab) => tab.index === tab.activeIndex);
  const candidates = tabs.filter((tab) => !isLocalAppUrl(tab.url)).sort((a, b) => {
    const windowDistance = a.windowIndex - b.windowIndex;
    if (windowDistance !== 0) return windowDistance;
    const activeDistance = Math.abs(a.index - a.activeIndex) - Math.abs(b.index - b.activeIndex);
    if (activeDistance !== 0) return activeDistance;
    return a.index - b.index;
  });
  const preferredOrigin = (() => {
    try {
      return preferredUrl ? new URL2(preferredUrl).origin : "";
    } catch {
      return "";
    }
  })();
  const preferredTab = preferredOrigin ? candidates.find((tab) => {
    try {
      return new URL2(tab.url).origin === preferredOrigin;
    } catch {
      return false;
    }
  }) : void 0;
  const selected = preferredTab || (frontActive && !isLocalAppUrl(frontActive.url) ? frontActive : candidates[0]);
  if (!selected?.url) {
    throw new Error("Only local app tabs were found in Chrome. Open the client website in Chrome beside the localhost app tab.");
  }
  return {
    url: new URL2(selected.url).href,
    title: selected.title,
    browser: "Google Chrome",
    source: frontActive?.url && isLocalAppUrl(frontActive.url) ? "nearest-client-tab" : "active-tab",
    windowIndex: selected.windowIndex,
    tabIndex: selected.index
  };
};
var buildChromeTabAssetCaptureScript = () => `
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
      // An inline icon often relies on a <symbol> in a page-level sprite. Copy
      // any local references into the standalone SVG so the data URL can paint
      // outside the source document.
      Array.from(clone.querySelectorAll('use')).forEach((use) => {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!href.startsWith('#')) return;
        const symbol = document.getElementById(href.slice(1));
        if (!symbol || clone.querySelector('[id="' + CSS.escape(href.slice(1)) + '"]')) return;
        let defs = clone.querySelector('defs');
        if (!defs) {
          defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          clone.appendChild(defs);
        }
        defs.appendChild(symbol.cloneNode(true));
      });
      // CSS classes and currentColor commonly live in the host page stylesheet.
      // Freeze the relevant computed paint values onto the clone for previews.
      const sourceNodes = [svg, ...Array.from(svg.querySelectorAll('*'))];
      const cloneNodes = [clone, ...Array.from(clone.querySelectorAll('*'))];
      sourceNodes.forEach((sourceNode, nodeIndex) => {
        const cloneNode = cloneNodes[nodeIndex];
        if (!cloneNode) return;
        const style = window.getComputedStyle(sourceNode);
        ['fill', 'stroke', 'color', 'opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'display', 'visibility'].forEach((property) => {
          const value = style.getPropertyValue(property);
          if (value && value !== 'initial' && value !== 'normal') cloneNode.style.setProperty(property, value);
        });
      });
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
    if (src && (/youtube|youtu\\.be|vimeo|brightcove|wistia|\\.(?:mp4|m3u8|mpd|webm|mov)(?:[?#]|$)/i.test(src))) videoUrls.add(src);
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
var executeJavascriptInChromeTab = async (tab, scriptSource) => {
  if (process.platform !== "darwin") {
    throw new Error("Chrome tab extraction is currently available on macOS only.");
  }
  const appleScript = [
    "on run argv",
    "set jsSource to item 1 of argv",
    'tell application "Google Chrome"',
    'if it is not running then error "Google Chrome is not running."',
    `return execute tab ${Math.max(1, Number(tab.tabIndex || 1))} of window ${Math.max(1, Number(tab.windowIndex || 1))} javascript jsSource`,
    "end tell",
    "end run"
  ];
  const { stdout } = await execFileAsync2(
    "osascript",
    [...appleScript.flatMap((line) => ["-e", line]), scriptSource],
    { timeout: 3e4, maxBuffer: 80 * 1024 * 1024 }
  );
  return String(stdout || "").trim();
};
var buildChromeTabVideoCaptureScript = () => `
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
var fetchBrowserSessionFontFaces = async (rawFonts, targetUrl) => {
  const cssUrls = Array.from(
    new Set(
      rawFonts.map((font) => String(font?.url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).filter((url) => /\.css(?:[?#]|$)/i.test(url) || /fonts\.googleapis\.com|use\.typekit\.net|cloud\.typography|fonts\.adobe/i.test(url))
    )
  ).slice(0, 24);
  if (cssUrls.length === 0) return [];
  const results = await mapWithConcurrency(cssUrls, 5, async (cssUrl) => {
    try {
      assertPublicAssetUrl(cssUrl);
      const response = await withTimeout(
        axios.get(cssUrl, {
          timeout: 8e3,
          responseType: "text",
          maxContentLength: 3 * 1024 * 1024,
          httpsAgent: relaxedHttpsAgent,
          headers: {
            "User-Agent": PAGE_FETCH_USER_AGENTS[0],
            Accept: "text/css,*/*;q=0.1",
            Referer: targetUrl
          }
        }),
        9e3,
        `Browser session font CSS fetch for ${cssUrl}`
      );
      return extractFontsFromCss(String(response.data || ""), cssUrl);
    } catch {
      return [];
    }
  });
  return results.flat();
};
var normalizeBrowserSessionExtraction = async (raw, sourceUrl, source) => {
  const pageUrl = String(raw?.url || sourceUrl || "").trim();
  const rawFonts = Array.isArray(raw?.fonts) ? raw.fonts : [];
  const cssFonts = await fetchBrowserSessionFontFaces(rawFonts, pageUrl || sourceUrl);
  const fontCandidates = rawFonts.filter((font) => font?.url && isSupportedFontAsset(font)).map((font) => ({
    ...font,
    source: font?.source || "Network",
    originalFilename: filenameFromUrlPath2(String(font?.url || ""))
  })).concat(cssFonts);
  const imageRows = Array.isArray(raw?.images) ? raw.images : [];
  const images = await Promise.all(
    imageRows.filter((image) => String(image?.url || "").trim()).map(async (image, index) => {
      const url = String(image.url || "").trim();
      let type = String(image.type || "").trim() || getAssetTypeFromUrl(url, "png");
      const filename = String(image.filename || "").trim() || `browser-image-${index + 1}.${type}`;
      const dataUrl = String(image.dataUrl || "").startsWith("data:image/") ? String(image.dataUrl) : "";
      const sourceKind = String(image.source || "");
      const pathSvgDataUrl = dataUrl && sourceKind === "font-awesome-icon-svg" ? await convertFontIconTextSvgToPathSvg(dataUrl, image, fontCandidates, pageUrl || sourceUrl).catch(() => "") : "";
      const fontAwesomePngDataUrl = sourceKind === "font-awesome-icon" ? await (async () => {
        const textSvgDataUrl = buildFontIconTextSvgDataUrlFromMeta(image);
        if (!textSvgDataUrl) return "";
        const pathSvg = await convertFontIconTextSvgToPathSvg(textSvgDataUrl, image, fontCandidates, pageUrl || sourceUrl).catch(() => "");
        return pathSvg ? await rasterizeSvgDataUrlToPngDataUrl(pathSvg) : "";
      })() : "";
      const finalDataUrl = fontAwesomePngDataUrl || pathSvgDataUrl || dataUrl;
      if (pathSvgDataUrl) type = "svg";
      if (fontAwesomePngDataUrl) type = "png";
      let cachedUrl = finalDataUrl || void 0;
      if (finalDataUrl) {
        const buffer = decodeDataImageBuffer(finalDataUrl);
        const contentType = finalDataUrl.match(/^data:([^;,]+)/i)?.[1] || "image/png";
        if (buffer?.length) {
          cachedUrl = await writeCachedOriginalImageFromBuffer(url, buffer, contentType, type, filename).catch(() => "") || cachedUrl;
        }
      }
      return {
        url: pathSvgDataUrl || url,
        cachedUrl,
        filename,
        name: filename,
        alt: String(image.alt || filename).trim(),
        type,
        mimeType: fontAwesomePngDataUrl ? "image/png" : String(image.mimeType || "").trim() || void 0,
        width: Number(image.width || 0) || void 0,
        height: Number(image.height || 0) || void 0,
        source: String(image.source || "").trim() || source,
        status: DEFAULT_ASSET_STATUS
      };
    })
  );
  const sequenceReadyImages = shouldSuppressToyotaSequenceAutoExpansion(pageUrl || sourceUrl) ? await repairMalformedToyotaCountedSequences(images, pageUrl || sourceUrl) : images.filter((image) => !hasMalformedImageSequencePath(String(image?.url || "").trim()));
  const skipToyotaSequenceExpansion = shouldSuppressToyotaSequenceAutoExpansion(pageUrl || sourceUrl) && sequenceReadyImages.some((image) => String(image?.source || "").includes("360-sequence") && Number(image?.sequenceCount || 0) >= 8);
  const expandedImages = skipToyotaSequenceExpansion ? sequenceReadyImages : await expandAvailableImageSequences(sequenceReadyImages, pageUrl || sourceUrl);
  const fontUsage = rawFonts.filter((font) => !String(font?.url || "").trim() && String(font?.family || "").trim()).map((font) => ({
    family: String(font.family || "").replace(/^["']|["']$/g, "").trim(),
    weight: String(font.weight || "").trim() || void 0,
    style: String(font.style || "").trim() || void 0,
    status: String(font.status || "").trim() || void 0,
    source: String(font.source || "").trim() || "FontFaceSet"
  }));
  const fontUsageByKey = /* @__PURE__ */ new Map();
  fontUsage.forEach((font) => {
    const key = `${font.family}|${font.weight || ""}|${font.style || ""}|${font.status || ""}`;
    if (!fontUsageByKey.has(key)) fontUsageByKey.set(key, font);
  });
  const metadataFonts = await enrichFontsWithMetadata(fontCandidates, pageUrl || sourceUrl, { fast: true });
  const renderedFamilyCounts = /* @__PURE__ */ new Map();
  fontUsage.forEach((font) => {
    const family = normalizeCssFontFamilyName(String(font?.family || ""));
    const lower = family.toLowerCase();
    if (!family || isJunkFontLabel(family) || ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "arial", "verdana"].includes(lower) || /material\s*icons|font\s*awesome|fontawesome|glyphicons?|icomoon|icon[-_ ]?font/i.test(family)) return;
    renderedFamilyCounts.set(family, (renderedFamilyCounts.get(family) || 0) + 1);
  });
  const rankedRenderedFamilies = Array.from(renderedFamilyCounts.entries()).sort((a, b) => b[1] - a[1]);
  const dominantRenderedFamily = rankedRenderedFamilies.length === 1 || (rankedRenderedFamilies[0]?.[1] || 0) > (rankedRenderedFamilies[1]?.[1] || 0) ? rankedRenderedFamilies[0]?.[0] || "" : "";
  const identifiedFonts = dominantRenderedFamily ? metadataFonts.map((font) => {
    const currentLabel = String(font?.family || font?.title || font?.name || "").trim();
    if (currentLabel && !isJunkFontLabel(currentLabel)) return font;
    return { ...font, family: dominantRenderedFamily, source: font?.source || "FontFaceSet" };
  }) : metadataFonts;
  const fonts = Array.from(new Set(identifiedFonts.map((font) => String(font?.url || "")).filter(Boolean))).map((fontUrl) => pickBestFontForUrl(identifiedFonts, fontUrl)).filter(Boolean).filter(isSupportedFontAsset).sort((a, b) => {
    const familyDelta = String(a?.family || "").localeCompare(String(b?.family || ""));
    if (familyDelta !== 0) return familyDelta;
    return String(a?.url || "").localeCompare(String(b?.url || ""));
  });
  const browserVideoCandidates = (Array.isArray(raw?.videos) ? raw.videos : []).map((video) => sanitizeVideoForClient(video, pageUrl || sourceUrl)).filter(Boolean).filter((video) => {
    const url = String(video?.url || "").trim();
    return Boolean(url) && !isUnsupportedVideoResourceUrl(url);
  });
  const bitmovinMaster = browserVideoCandidates.find(
    (video) => /streams\.bitmovin\.com\/.*\/(?:manifest|master)\.m3u8(?:[?#]|$)/i.test(String(video?.url || ""))
  ) || (/(?:^|\.)xtandi\.com$/i.test(new URL2(pageUrl || sourceUrl).hostname) ? browserVideoCandidates.find(
    (video) => /\/(?:manifest|master)\.m3u8(?:[?#]|$)/i.test(String(video?.url || "")) && !/\/(?:audio)(?:[_/-]|$)/i.test(String(video?.url || ""))
  ) : void 0);
  const videos = bitmovinMaster ? [{
    ...bitmovinMaster,
    sourceUrl: String(bitmovinMaster?.sourceUrl || pageUrl || sourceUrl),
    provider: "bitmovin",
    type: "m3u8",
    isDirect: true
  }] : Array.isArray(raw?.videos) ? raw.videos : [];
  return {
    images: expandedImages,
    icons: [],
    fonts,
    fontUsage: Array.from(fontUsageByKey.values()),
    videos,
    colors: Array.isArray(raw?.colors) ? raw.colors : [],
    extractionMeta: {
      mode: source,
      sectionLabel: raw?.title || "Open Chrome Tab"
    },
    pageUrl,
    title: raw?.title || ""
  };
};
var extractAssetsFromControlledBrowserSession = async (targetUrl, userExploreWaitMs = 18e3) => {
  const initialWaitMs = Math.min(18e4, Math.max(8e3, Number(userExploreWaitMs || 18e3)));
  const executablePath = resolvePuppeteerExecutablePath();
  const userDataDir = fs2.mkdtempSync(path3.join(os3.tmpdir(), "creative-asset-extractor-browser-profile-"));
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir,
      executablePath: executablePath || void 0,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check"
      ],
      ignoreDefaultArgs: ["--enable-automation"]
    });
    const page = await acquireSingleWebsitePage(browser);
    const capturedFontResponses = /* @__PURE__ */ new Map();
    const capturedStylesheets = /* @__PURE__ */ new Map();
    const pendingStylesheetReads = /* @__PURE__ */ new Set();
    page.on("response", (response) => {
      const responseUrl = String(response.url() || "").trim();
      if (!responseUrl) return;
      const contentType = String(response.headers()["content-type"] || "").toLowerCase();
      const resourceType = String(response.request().resourceType() || "").toLowerCase();
      const format = getFontFormatFromUrlOrType(responseUrl, contentType);
      if (resourceType === "font" || isSupportedFontFormat(format)) {
        capturedFontResponses.set(responseUrl, {
          url: responseUrl,
          format,
          mimeType: contentType || void 0,
          source: "Chromium network response",
          status: DEFAULT_ASSET_STATUS
        });
      }
      if (resourceType === "stylesheet" || contentType.includes("text/css") || /\.css(?:[?#]|$)/i.test(responseUrl)) {
        let readPromise;
        readPromise = response.text().then((cssText) => {
          if (cssText && cssText.length <= 5 * 1024 * 1024) capturedStylesheets.set(responseUrl, cssText);
        }).catch(() => void 0).then(() => {
          pendingStylesheetReads.delete(readPromise);
        });
        pendingStylesheetReads.add(readPromise);
      }
    });
    await page.setViewport({ width: 1440, height: 1e3, deviceScaleFactor: 1 });
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45e3 }).catch(() => void 0);
    await waitForPageContentSettle(page, {
      minWaitMs: initialWaitMs,
      readinessTimeoutMs: Math.min(12e3, Math.max(4e3, Math.round(initialWaitMs * 0.35)))
    });
    const firstHtml = await page.content().catch(() => "");
    if (pageHtmlLooksBlocked(firstHtml)) {
      await waitForChallengeOrLoaderSettle(page, { timeoutMs: 25e3, minAssetWaitMs: 8e3 }).catch(() => void 0);
      await waitForPageContentSettle(page, { minWaitMs: 5e3, readinessTimeoutMs: 4e3 }).catch(() => void 0);
    }
    await performLazyLoadScroll(page, { stepDelayMs: 600, maxStableRounds: 3, maxDurationMs: 22e3 }).catch(() => void 0);
    await waitForPageContentSettle(page, { minWaitMs: 8e3, readinessTimeoutMs: 4e3 });
    await Promise.allSettled(Array.from(pendingStylesheetReads));
    const rawText = await page.evaluate(buildChromeTabAssetCaptureScript());
    const raw = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
    const discoveredCssUrls = prioritizeFontCssCandidates(Array.from(new Set(
      (Array.isArray(raw?.fonts) ? raw.fonts : []).map((font) => String(font?.url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).filter((url) => /\.css(?:[?#]|$)/i.test(url) || /fonts\.googleapis\.com|use\.typekit\.net|cloud\.typography|fonts\.adobe/i.test(url))
    ))).slice(0, 80);
    const browserCssFonts = (await mapWithConcurrency(discoveredCssUrls, 4, async (cssUrl) => {
      let cssPage = null;
      try {
        cssPage = await browser.newPage();
        await cssPage.setUserAgent(PAGE_FETCH_USER_AGENTS[0]);
        await cssPage.setExtraHTTPHeaders({
          Accept: "text/css,*/*;q=0.1",
          Referer: targetUrl
        });
        const cssResponse = await cssPage.goto(cssUrl, { waitUntil: "domcontentloaded", timeout: 12e3 });
        const responseText = await cssResponse?.text().catch(() => "");
        const renderedText = responseText || await cssPage.evaluate(() => String(document.body?.innerText || "")).catch(() => "");
        const cssText = String(renderedText || "").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
        return cssText && cssText.length <= 5 * 1024 * 1024 ? extractFontsFromCss(cssText, cssUrl) : [];
      } catch {
        return [];
      } finally {
        await cssPage?.close().catch(() => void 0);
      }
    })).flat();
    const capturedCssFonts = Array.from(capturedStylesheets.entries()).flatMap(
      ([cssUrl, cssText]) => extractFontsFromCss(cssText, cssUrl)
    );
    raw.fonts = [
      ...Array.isArray(raw?.fonts) ? raw.fonts : [],
      ...Array.from(capturedFontResponses.values()),
      ...capturedCssFonts,
      ...browserCssFonts
    ];
    const missingPreviewUrls = (Array.isArray(raw?.images) ? raw.images : []).filter((image) => image?.url && !String(image?.dataUrl || "").startsWith("data:image/")).map((image) => String(image.url)).filter((url) => /^https?:\/\//i.test(url)).slice(0, 80);
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
      raw.images = (Array.isArray(raw.images) ? raw.images : []).map((image) => ({
        ...image,
        dataUrl: image.dataUrl || dataUrlsByUrl[String(image.url || "")] || void 0
      }));
    }
    await page.close().catch(() => void 0);
    return await normalizeBrowserSessionExtraction(raw, targetUrl, "controlled-browser-session");
  } finally {
    await browser?.close().catch(() => void 0);
    await fsp3.rm(userDataDir, { recursive: true, force: true }).catch(() => void 0);
  }
};
app.get("/api/browser-tabs/chrome/active", async (_req, res) => {
  try {
    const tab = await readChromeClientTab();
    return res.json({ ok: true, ...tab });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error?.message || "Unable to read Chrome active tab."
    });
  }
});
app.post("/api/browser-tabs/chrome/resolve-blob-video", async (req, res) => {
  const blobUrl = String(req.body?.url || "").trim();
  if (!/^blob:https?:\/\//i.test(blobUrl)) {
    return res.status(400).json({ ok: false, error: "Paste a valid browser blob video URL." });
  }
  try {
    const blobPageUrl = blobUrl.slice(5);
    const blobOrigin = new URL2(blobPageUrl).origin;
    const tab = await readChromeClientTab(blobPageUrl);
    const tabUrl = String(tab.url || "").trim();
    if (!tabUrl || new URL2(tabUrl).origin !== blobOrigin) {
      throw new Error("Open the page that created this blob video in the active Chrome tab, play the video, then try again.");
    }
    const rawText = await executeJavascriptInChromeTab(tab, buildChromeTabVideoCaptureScript());
    const raw = JSON.parse(rawText || "{}");
    const pageUrl = String(raw?.url || tabUrl).trim();
    const candidates = Array.from(
      new Set(
        (Array.isArray(raw?.videos) ? raw.videos : []).map((video) => String(video?.url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).filter((url) => /\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$)|\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url))
      )
    ).sort((left, right) => {
      const score = (url) => (/\.m3u8(?:[?#]|$)/i.test(url) ? 100 : 0) + (/master|playlist|index/i.test(url) ? 30 : 0) + (/\.mpd(?:[?#]|$)/i.test(url) ? 10 : 0);
      return score(right) - score(left);
    });
    for (const candidate of candidates.slice(0, 16)) {
      const validation = await validateStreamUrl(candidate, pageUrl).catch(() => null);
      if (!validation?.ok) continue;
      return res.json({
        ok: true,
        url: validation.url || candidate,
        sourcePageUrl: pageUrl,
        title: String(raw?.title || "Captured browser video").trim(),
        type: /\.m3u8(?:[?#]|$)/i.test(candidate) ? "m3u8" : /\.mpd(?:[?#]|$)/i.test(candidate) ? "mpd" : "video"
      });
    }
    throw new Error("No downloadable HLS stream was captured. Keep the Chrome tab open, press play, wait a few seconds, and try again.");
  } catch (error) {
    const rawMessage = String(error?.message || error || "");
    const friendlyMessage = /Application isn.t running|Google Chrome got an error.*isn.t running|\(-600\)/i.test(rawMessage) ? "Open the source page in Google Chrome, start video playback, then try the blob URL again." : /Executing JavaScript through AppleScript is turned off/i.test(rawMessage) ? "In Chrome, enable View > Developer > Allow JavaScript from Apple Events, keep the source video playing, then try again." : rawMessage;
    return res.status(400).json({
      ok: false,
      error: friendlyMessage || "Could not resolve the browser blob video."
    });
  }
});
var normalizeFontFamilyForStaticBackfill = (value = "") => {
  const family = String(value || "").replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ").trim();
  if (!family) return "";
  const lower = family.toLowerCase();
  if (!lower || isJunkFontLabel(lower) || ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"].includes(lower)) {
    return "";
  }
  return lower;
};
var getFontCardFamilyForStaticBackfill = (font) => {
  const identity = resolveFontIdentityFields(font || {});
  return normalizeFontFamilyForStaticBackfill(
    identity.family || font?.family || font?.title || font?.name || buildFontDisplayName(font || {})
  );
};
var hasRenderedFontFamilyWithoutCard = (extracted) => {
  const renderedFamilies = new Set(
    (Array.isArray(extracted?.fontUsage) ? extracted.fontUsage : []).map((font) => normalizeFontFamilyForStaticBackfill(font?.family)).filter(Boolean)
  );
  if (!renderedFamilies.size) return false;
  const cardFamilies = new Set(
    (Array.isArray(extracted?.fonts) ? extracted.fonts : []).map((font) => getFontCardFamilyForStaticBackfill(font)).filter(Boolean)
  );
  return Array.from(renderedFamilies).some((family) => !cardFamilies.has(family));
};
var isImageSequenceCandidateUrl = (value) => /(?:threesixty|360|jellies|vehicle|lexus|aemassets|assetscs|visualizer)/i.test(String(value || ""));
var imageSequenceMergeKey = (item) => {
  const raw = String(item?.url || item?.src || "").trim();
  if (!raw || !isImageSequenceCandidateUrl(raw)) return raw;
  try {
    const parsed = new URL2(raw);
    const normalizedPath = parsed.pathname.replace(/^\/content\/dam\/toyota\/(?=jellies\/)/i, "/").replace(/^\/is\/image\/toyota\/toyota\/(?=jellies\/)/i, "/").replace(/\/{2,}/g, "/");
    const hostKey = /\/jellies\/(?:max|relative)\//i.test(normalizedPath) ? "toyota-assets" : parsed.hostname.replace(/^www\./, "").toLowerCase();
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
var imageCandidateScore = (item) => {
  const width = Number(item?.width || 0) || 0;
  const height = Number(item?.height || 0) || 0;
  const area = width * height;
  if (area > 0) return area;
  try {
    const parsed = new URL2(String(item?.url || item?.src || ""));
    const wid = Number(parsed.searchParams.get("wid") || parsed.searchParams.get("width") || 0) || 0;
    const hei = Number(parsed.searchParams.get("hei") || parsed.searchParams.get("height") || 0) || 0;
    if (wid > 0 && hei > 0) return wid * hei;
    return wid || hei || 0;
  } catch {
    return 0;
  }
};
var mergeImageRowsByBestSequenceFrame = (left = [], right = []) => {
  const rows = /* @__PURE__ */ new Map();
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
async function fillEmptyBrowserExtractionFromStatic(extracted, fallbackUrl) {
  const hasAssets = extracted?.images?.length || 0 || (extracted?.icons?.length || 0) || (extracted?.fonts?.length || 0) || (extracted?.videos?.length || 0);
  const hasDownloadableFonts = (extracted?.fonts?.length || 0) > 0;
  const needsVideoBackfill = (extracted?.videos?.length || 0) === 0;
  const needsRenderedFontBackfill = hasRenderedFontFamilyWithoutCard(extracted);
  const browserImages = [
    ...Array.isArray(extracted?.images) ? extracted.images : [],
    ...Array.isArray(extracted?.icons) ? extracted.icons : []
  ];
  const hasImageSequenceCandidate = browserImages.some(
    (item) => isImageSequenceCandidateUrl(String(item?.url || item?.src || ""))
  );
  const hasCompleteToyotaSequence = isToyotaVehicleExtractionTarget(fallbackUrl) && browserImages.filter(
    (item) => String(item?.source || "").includes("360-sequence") && Number(item?.sequenceFrame || 0) >= 1 && Number(item?.sequenceFrame || 0) <= 36
  ).length >= 36;
  const needsImageSequenceBackfill = hasImageSequenceCandidate && !hasCompleteToyotaSequence;
  if (hasAssets && hasDownloadableFonts && !needsRenderedFontBackfill && !needsImageSequenceBackfill && !needsVideoBackfill || !fallbackUrl) return extracted;
  const staticAssets = await withTimeout(
    extractStaticAssets(fallbackUrl, "", { fast: true }),
    35e3,
    `Browser-tab static fallback for ${fallbackUrl}`
  ).catch(() => null);
  if (!staticAssets || !isUsableStaticExtract(staticAssets)) return extracted;
  const mergeByUrl = (left = [], right = []) => {
    const rows = /* @__PURE__ */ new Map();
    [...left, ...right].forEach((item) => {
      const key = String(item?.url || item?.src || "").trim();
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
    colors: Array.from(/* @__PURE__ */ new Set([...extracted?.colors || [], ...staticAssets?.colors || []])),
    extractionMeta: {
      ...extracted?.extractionMeta,
      mode: hasAssets || needsRenderedFontBackfill ? "browser-static-font-fallback" : "browser-static-fallback",
      sectionLabel: extracted?.title || "Static fallback"
    },
    pageUrl: extracted?.pageUrl || fallbackUrl,
    title: extracted?.title || ""
  };
}
app.post("/api/browser-tabs/chrome/extract", async (req, res) => {
  const requestedUrl = String(req.body?.url || "").trim();
  const previousProxyUrl = activeExtractionProxyUrl;
  try {
    if (!requestedUrl) {
      return res.status(400).json({ ok: false, error: "URL is required." });
    }
    activeExtractionProxyUrl = normalizeExtractionProxyUrl(req.body?.proxyUrl);
    const browserExtracted = await extractAssetsFromControlledBrowserSession(requestedUrl);
    const extracted = await fillEmptyBrowserExtractionFromStatic(browserExtracted, requestedUrl);
    return res.json({
      ok: true,
      source: "controlled-browser-session",
      ...extracted
    });
  } catch (error) {
    if (/proxy url|proxy protocol/i.test(String(error?.message || ""))) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Invalid proxy URL."
      });
    }
    return res.status(400).json({
      ok: false,
      error: error?.message || "Unable to extract assets from the automated Chromium crawler."
    });
  } finally {
    activeExtractionProxyUrl = previousProxyUrl;
  }
});
app.post("/api/resolve-font-links", async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const pageUrl = String(req.body?.sourcePageUrl || "").trim();
  const cssUrls = Array.from(new Set(
    urls.map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).filter(
      (url) => /\.css(?:[?#]|$)/i.test(url) || /fonts\.googleapis\.com\/css/i.test(url) || /use\.typekit\.net\/[^/?#]+\.css(?:[?#]|$)/i.test(url) || /p\.typekit\.net\/p\.css/i.test(url)
    )
  )).slice(0, 20);
  if (cssUrls.length === 0) {
    return res.json({ ok: true, fonts: [] });
  }
  try {
    const resolved = await mapWithConcurrency(cssUrls, 4, async (cssUrl) => {
      try {
        assertPublicAssetUrl(cssUrl);
        const response = await withTimeout(
          axios.get(cssUrl, {
            timeout: 12e3,
            responseType: "text",
            maxContentLength: 4 * 1024 * 1024,
            httpsAgent: relaxedHttpsAgent,
            headers: {
              "User-Agent": PAGE_FETCH_USER_AGENTS[0],
              Accept: "text/css,*/*;q=0.1",
              Referer: pageUrl || cssUrl
            }
          }),
          14e3,
          `Resolve font CSS ${cssUrl}`
        );
        return extractFontsFromCss(String(response.data || ""), cssUrl).map((font) => ({
          ...font,
          cssSource: cssUrl,
          originalFilename: filenameFromUrlPath2(String(font?.url || ""))
        }));
      } catch (error) {
        return [{
          cssSource: cssUrl,
          error: String(error?.message || error || "Font CSS fetch failed")
        }];
      }
    });
    const flat = resolved.flat();
    const fonts = flat.filter((font) => font?.url && isSupportedFontAsset(font));
    const uniqueFonts = dedupeFontsByLogicalKey(fonts).map((font) => {
      const sourceFace = fonts.find((candidate) => String(candidate?.url) === String(font?.url));
      return sourceFace?.family ? { ...font, family: sourceFace.family } : font;
    });
    const failures = flat.filter((entry) => entry?.error);
    return res.json({ ok: true, fonts: uniqueFonts, failures });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error?.message || "Unable to resolve font links." });
  }
});
app.get("/api/activity-log/recent", async (_req, res) => {
  const entries = await readRecentActivityLogs(20);
  res.json({ ok: true, entries, logPath: activityLogPath });
});
var writeSystemClipboard = (value) => new Promise((resolve, reject) => {
  const command = process.platform === "darwin" ? { bin: "pbcopy", args: [] } : process.platform === "win32" ? { bin: "clip", args: [] } : { bin: "xclip", args: ["-selection", "clipboard"] };
  const child = spawn2(command.bin, command.args, { stdio: ["pipe", "ignore", "pipe"] });
  let errorText2 = "";
  child.stderr.on("data", (chunk) => {
    errorText2 += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(errorText2.trim() || `Clipboard command exited with code ${code}`));
  });
  child.stdin.end(value);
});
app.post("/api/clipboard/write", async (req, res) => {
  const value = String(req.body?.text || "");
  if (!value || value.length > 1e5) {
    return res.status(400).json({ ok: false, error: "Valid clipboard text is required." });
  }
  try {
    await writeSystemClipboard(value);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Clipboard write failed." });
  }
});
app.post("/api/feedback/screenshot", async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || "").trim();
    const filenameHint = String(req.body?.filename || "screenshot.jpg").trim();
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!match) {
      return res.status(400).json({ ok: false, error: "Invalid screenshot payload." });
    }
    const compressed = await compressScreenshotDataUrlForSheet(dataUrl);
    if (!compressed) {
      return res.status(400).json({ ok: false, error: "Invalid screenshot payload." });
    }
    const baseName = filenameHint.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 48) || "screenshot";
    const safeName = /\.(png|jpe?g|webp)$/i.test(baseName) ? `${Date.now()}-${baseName.replace(/\.(png|webp)$/i, ".jpg")}` : `${Date.now()}-${baseName}.jpg`;
    const sourcePageUrl = readSourcePageUrl(req);
    const screenshotDir = feedbackScreenshotDir;
    await fsp3.mkdir(screenshotDir, { recursive: true });
    const filePath = path3.join(screenshotDir, safeName);
    await fsp3.writeFile(filePath, Buffer.from(compressed.screenshotBase64, "base64"));
    return res.json({
      ok: true,
      filePath,
      displayPath: toDisplayFilePath(filePath),
      screenshotUrl: toDisplayFilePath(filePath)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Screenshot save failed." });
  }
});
app.post("/api/feedback", async (req, res) => {
  const name = getSuggestedDisplayName() || String(req.body?.name || "").trim();
  const suggestions = String(req.body?.suggestions || "").trim();
  if (!name || !suggestions) {
    return res.status(400).json({ error: "Name and suggestions are required." });
  }
  const pkg = await resolvePackageMeta();
  const platformMeta = getFeedbackPlatformMeta();
  const includeActivityHistory = req.body?.includeActivityHistory === true;
  const recentLogs = includeActivityHistory ? await readRecentActivityLogs(20) : [];
  const logSummary = recentLogs.map((entry) => `${entry.timestamp || ""} ${entry.kind || ""} ${entry.error || entry.message || ""}`.trim()).filter(Boolean).join("\n");
  const payload = {
    name,
    category: String(req.body?.category || "Suggestion").trim() || "Suggestion",
    suggestions: logSummary ? `${suggestions}

--- Recent activity ---
${logSummary}` : suggestions,
    submittedAt: (/* @__PURE__ */ new Date()).toISOString(),
    appVersion: String(req.body?.appVersion || pkg.version || "1.0.0").trim() || pkg.version,
    platform: String(req.body?.platform || platformMeta.platform).trim() || platformMeta.platform,
    architecture: String(req.body?.architecture || platformMeta.architecture).trim() || platformMeta.architecture,
    osLabel: String(req.body?.osLabel || platformMeta.osLabel).trim() || platformMeta.osLabel,
    websiteUrl: String(req.body?.websiteUrl || "").trim(),
    videoUrl: String(req.body?.videoUrl || "").trim(),
    fontName: String(req.body?.fontName || "").trim(),
    screenshotUrl: String(req.body?.screenshotUrl || "").trim(),
    lastError: String(req.body?.lastError || "").trim()
  };
  const removeSubmittedScreenshot = async () => {
    const filePath = resolveFeedbackScreenshotPath(payload.screenshotUrl);
    if (!filePath) return;
    const resolved = path3.resolve(filePath);
    const screenshotRoot = path3.resolve(feedbackScreenshotDir);
    if (resolved.startsWith(screenshotRoot + path3.sep)) {
      await fsp3.rm(resolved, { force: true }).catch(() => void 0);
    }
  };
  try {
    const target = await resolveFeedbackTarget();
    if (target) {
      const screenshotDataUrl = String(req.body?.screenshotDataUrl || "").trim();
      const mode = await submitFeedbackRemote(target, payload, { screenshotDataUrl });
      await removeSubmittedScreenshot();
      return res.json({
        ok: true,
        mode,
        appVersion: payload.appVersion,
        message: "Thanks! Your feedback has been submitted."
      });
    }
    await appendLocalFeedbackInbox(payload);
    return res.json({
      ok: true,
      mode: "local",
      appVersion: payload.appVersion,
      message: "Thanks! Your feedback has been submitted.",
      inboxPath: feedbackInboxPath
    });
  } catch (error) {
    console.error("Feedback submit failed:", error?.message || error);
    try {
      await appendLocalFeedbackInbox(payload);
      return res.json({
        ok: true,
        mode: "local",
        appVersion: payload.appVersion,
        message: "Thanks! Your feedback has been submitted.",
        inboxPath: feedbackInboxPath,
        fallback: true
      });
    } catch (fallbackError) {
      console.error("Feedback local fallback failed:", fallbackError?.message || fallbackError);
      return res.status(503).json({
        error: "Unable to submit right now. Please try again."
      });
    }
  }
});
app.post("/api/responsible-use-acknowledgement", async (req, res) => {
  try {
    const userName = getCurrentUserName();
    const safeUserName = toSafeUserFilePart(userName);
    const acknowledgedAt = (/* @__PURE__ */ new Date()).toISOString();
    const filePath = path3.join(appDataDir, `${safeUserName}-responsible-use.json`);
    const payload = {
      userName,
      acknowledged: true,
      acknowledgedAt,
      app: "Creative Asset Extractor",
      version: "1",
      context: typeof req.body?.context === "string" ? req.body.context : "firstLaunch"
    };
    await fsp3.mkdir(appDataDir, { recursive: true });
    await fsp3.writeFile(filePath, `${JSON.stringify(payload, null, 2)}
`, "utf8");
    res.json({
      ok: true,
      userName,
      filePath,
      acknowledgedAt
    });
  } catch (error) {
    console.error("Responsible use acknowledgement write failed:", error?.message || error);
    res.status(500).json({ error: "Failed to save acknowledgement file." });
  }
});
var DEFAULT_GITHUB_OWNER = "frontendtech01-star";
var DEFAULT_GITHUB_REPO = "creative-asset-extractor";
var resolveGithubRepoConfig = () => {
  const repository = String(process.env.GITHUB_REPOSITORY || "").trim();
  if (repository.includes("/")) {
    const [owner, repo] = repository.split("/");
    return { githubOwner: owner, githubRepo: repo };
  }
  return {
    githubOwner: String(
      process.env.GITHUB_OWNER || process.env.VITE_GITHUB_OWNER || DEFAULT_GITHUB_OWNER
    ).trim(),
    githubRepo: String(
      process.env.GITHUB_REPO || process.env.VITE_GITHUB_REPO || DEFAULT_GITHUB_REPO
    ).trim()
  };
};
var normalizeReleaseTag = (version) => {
  const trimmed = String(version || "").trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
};
var normalizeAssetVersion = (version) => {
  const cleanVersion = String(version || "").replace(/^v/i, "");
  return /^\d+\.\d+$/.test(cleanVersion) ? `${cleanVersion}.0` : cleanVersion;
};
var buildDmgAssetName = (productName, version) => {
  const cleanVersion = normalizeAssetVersion(version);
  return `Creative.Asset.Extractor-${cleanVersion}-arm64.dmg`;
};
var buildGithubReleaseLinks = (githubOwner, githubRepo, version, productName) => {
  const tagName = normalizeReleaseTag(version);
  const dmgName = buildDmgAssetName(productName, version);
  const repoUrl = `https://github.com/${githubOwner}/${githubRepo}`;
  return {
    tagName,
    htmlUrl: `${repoUrl}/releases/tag/${tagName}`,
    releasesUrl: `${repoUrl}/releases`,
    repoUrl,
    dmgDownloadUrl: `${repoUrl}/releases/latest/download/${encodeURIComponent(dmgName)}`,
    dmgAssetName: dmgName
  };
};
var parseGithubReleasePayload = (data) => {
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const dmgAsset = assets.filter((asset) => /\.dmg$/i.test(String(asset?.name || ""))).sort((left, right) => {
    const rightTime = Date.parse(String(right?.updated_at || right?.created_at || "")) || 0;
    const leftTime = Date.parse(String(left?.updated_at || left?.created_at || "")) || 0;
    return rightTime - leftTime;
  })[0];
  return {
    tagName: String(data?.tag_name || ""),
    name: String(data?.name || data?.tag_name || "Latest release"),
    body: String(data?.body || ""),
    publishedAt: String(data?.published_at || ""),
    htmlUrl: String(data?.html_url || ""),
    packageDownloadUrl: String(dmgAsset?.browser_download_url || ""),
    packageAssetName: String(dmgAsset?.name || "Mac DMG"),
    dmgDownloadUrl: String(dmgAsset?.browser_download_url || ""),
    dmgAssetName: String(dmgAsset?.name || ""),
    dmgAssetUpdatedAt: String(dmgAsset?.updated_at || ""),
    dmgAssetSize: Number(dmgAsset?.size || 0),
    dmgAssetDigest: String(dmgAsset?.digest || "")
  };
};
var readProjectReleaseNotes = async () => {
  const candidates = [
    path3.join(getAppRoot(), "RELEASE_NOTES.md"),
    path3.join(process.cwd(), "RELEASE_NOTES.md")
  ];
  for (const notesPath of candidates) {
    try {
      const raw = await fsp3.readFile(notesPath, "utf8");
      const text = String(raw || "").trim();
      if (!text) continue;
      const currentSection = text.split(/## Current Release/i)[1];
      if (currentSection) {
        return currentSection.split(/## /)[0].trim();
      }
      return text.replace(/^#\s*Release Notes\s*/i, "").trim();
    } catch {
    }
  }
  return "";
};
app.get("/api/app-meta", async (_req, res) => {
  const pkg = await resolvePackageMeta();
  const github = resolveGithubRepoConfig();
  res.json({
    version: pkg.version,
    productName: pkg.productName,
    githubOwner: github.githubOwner,
    githubRepo: github.githubRepo
  });
});
app.get("/api/github-latest-release", async (_req, res) => {
  const { githubOwner, githubRepo } = resolveGithubRepoConfig();
  if (!githubOwner || !githubRepo) {
    return res.json({ available: false, error: "GitHub repository is not configured." });
  }
  try {
    const response = await axios.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`, {
      timeout: 12e3,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Creative-Asset-Extractor"
      }
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
        packageAssetName: release.dmgAssetName || links.dmgAssetName || "Mac DMG",
        dmgDownloadUrl: release.dmgDownloadUrl || links.dmgDownloadUrl,
        dmgAssetName: release.dmgAssetName || links.dmgAssetName,
        dmgAssetUpdatedAt: release.dmgAssetUpdatedAt || "",
        dmgAssetSize: release.dmgAssetSize || 0,
        dmgAssetDigest: release.dmgAssetDigest || ""
      }
    });
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status === 404) {
      return res.json({ available: false, error: "No published GitHub release found yet." });
    }
    return res.status(502).json({
      available: false,
      error: "Unable to check GitHub releases right now."
    });
  }
});
app.get("/api/release-notes", async (_req, res) => {
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
    dmgAssetUpdatedAt: "",
    dmgAssetSize: 0,
    dmgAssetDigest: "",
    source: "local"
  };
  try {
    const response = await axios.get(`https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`, {
      timeout: 12e3,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Creative-Asset-Extractor"
      }
    });
    const githubRelease = parseGithubReleasePayload(response.data || {});
    release = {
      ...release,
      body: localNotes || githubRelease.body || "",
      htmlUrl: githubRelease.htmlUrl || links.htmlUrl,
      packageDownloadUrl: githubRelease.dmgDownloadUrl || links.dmgDownloadUrl,
      packageAssetName: githubRelease.dmgAssetName || links.dmgAssetName,
      dmgDownloadUrl: githubRelease.dmgDownloadUrl || links.dmgDownloadUrl,
      dmgAssetName: githubRelease.dmgAssetName || links.dmgAssetName,
      dmgAssetUpdatedAt: githubRelease.dmgAssetUpdatedAt || "",
      dmgAssetSize: githubRelease.dmgAssetSize || 0,
      dmgAssetDigest: githubRelease.dmgAssetDigest || "",
      source: "github"
    };
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status !== 404) {
      return res.status(502).json({
        available: false,
        error: "Unable to load release notes right now."
      });
    }
  }
  return res.json({ available: true, release });
});
app.get("/api/system-check", async (_req, res) => {
  const ytdlpPath = resolvedYtDlpPath || resolveYtDlpPath();
  const ffmpegReady = Boolean(resolvedFfmpegPath && await fileExists(String(resolvedFfmpegPath)));
  const ffprobeReady = Boolean(resolvedFfprobePath && await fileExists(String(resolvedFfprobePath)));
  const ytdlpReady = Boolean(ytdlpPath && await fileExists(String(ytdlpPath)));
  const aria2Ready = Boolean(resolvedAria2Path && await fileExists(String(resolvedAria2Path)));
  const ytdlpStandalone = ytdlpPath ? !isPythonScriptBinary(String(ytdlpPath)) : false;
  const downloadsReady = await fsp3.mkdir(downloadsDir, { recursive: true }).then(() => true).catch(() => false);
  const appDataReady = await fsp3.mkdir(appDataDir, { recursive: true }).then(() => true).catch(() => false);
  res.json({
    ok: ffmpegReady && ytdlpReady && ytdlpStandalone && downloadsReady && appDataReady,
    platform: process.platform,
    arch: process.arch,
    userName: getCurrentUserName(),
    downloadsDir,
    appDataDir,
    tools: {
      ffmpeg: { ready: ffmpegReady, path: resolvedFfmpegPath ? String(resolvedFfmpegPath) : "" },
      ffprobe: { ready: ffprobeReady, path: resolvedFfprobePath ? String(resolvedFfprobePath) : "" },
      ytdlp: { ready: ytdlpReady, standalone: ytdlpStandalone, path: String(ytdlpPath || "") },
      aria2: { ready: aria2Ready, path: resolvedAria2Path ? String(resolvedAria2Path) : "" },
      resourcesBin: path3.join(getResourcesPath(), "bin"),
      chromium: {
        ready: Boolean(warmedPuppeteerBrowser?.connected),
        warming: Boolean(puppeteerWarmupInFlight),
        state: puppeteerWarmupStatus.state,
        updatedAt: puppeteerWarmupStatus.updatedAt,
        path: puppeteerWarmupStatus.executablePath || resolvePuppeteerExecutablePath(),
        error: puppeteerWarmupStatus.error || ""
      }
    },
    writable: {
      downloads: downloadsReady,
      appData: appDataReady
    }
  });
});
var resolveUrl = (base, relative) => {
  try {
    const url = new URL2(relative, base);
    if (!/\.svg$/i.test(url.pathname)) url.hash = "";
    return url.href;
  } catch (e) {
    return null;
  }
};
var PAGE_FETCH_USER_AGENTS = [
  "Mozilla/5.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];
var BOT_WALL_MARKUP_PATTERN = /robot-suspicion|challenge-platform|captcha-delivery|cf-challenge|cf_chl|cf-turnstile|cloudflare(?:\s+challenge|\s+turnstile|\s+ray|\s+error)|akamai(?:[^\n]{0,160}(?:bot|deny|challenge|waf))|waf challenge|bot detection/i;
var BOT_WALL_VISIBLE_TEXT_PATTERN = /just a moment|checking (?:your browser|the site connection|if the site connection is secure)|verify you are human|access denied|complete (?:the )?captcha|enable javascript and cookies to continue/i;
var htmlLooksLikeBotWall = (html) => {
  const sample = String(html || "").slice(0, 16e4);
  if (/important safety information|full prescribing information|indicated for|wp-content\/uploads|\/\.imaging\//i.test(sample)) {
    return false;
  }
  if (BOT_WALL_MARKUP_PATTERN.test(sample)) return true;
  const body = sample.match(/<body\b[^>]*>([\s\S]*)/i)?.[1] || sample;
  const visibleText = body.replace(/<(?:script|style|noscript|svg)\b[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/gi, " ").replace(/\s+/g, " ").trim();
  return BOT_WALL_VISIBLE_TEXT_PATTERN.test(visibleText);
};
var scoreSiteHtml = (html, status) => {
  const text = String(html || "");
  if (htmlLooksLikeBotWall(text)) return -100;
  let score = text.length / 1e3;
  if (status >= 200 && status < 300) score += 50;
  score += (text.match(/\/wp-content\/uploads/gi) || []).length * 5;
  score += (text.match(/<img\b/gi) || []).length * 2;
  score += (text.match(/background-image\s*:\s*url/gi) || []).length * 3;
  score += (text.match(/\.(?:png|jpe?g|webp|gif|avif)/gi) || []).length;
  return score;
};
var isSparseSiteHtml = (html) => {
  const text = String(html || "");
  if (htmlLooksLikeBotWall(text)) return true;
  if (text.length < 2048) return true;
  if (/\/wp-content\/uploads/i.test(text) && text.length > 8e3) return false;
  if (text.length < 9e4 && !/\/wp-content\/uploads|<img\b|background-image\s*:\s*url/i.test(text)) return true;
  const rasterHints = (text.match(/\.(?:png|jpe?g|webp|gif|avif)(?:[^\w]|$)/gi) || []).length;
  const svgCount = (text.match(/<svg\b/gi) || []).length;
  return rasterHints < 2 && svgCount > 0 && text.length < 12e4;
};
var fetchQuickSiteHtml = async (siteUrl) => {
  assertPublicAssetUrl(siteUrl);
  let best = { html: "", score: -1 };
  for (const userAgent of PAGE_FETCH_USER_AGENTS.slice(0, 2)) {
    try {
      const response = await axios.get(siteUrl, {
        timeout: 6e3,
        maxRedirects: 5,
        validateStatus: () => true,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
        }
      });
      const html = String(response.data || "");
      const score = scoreSiteHtml(html, response.status);
      if (score > best.score) best = { html, score };
      if (response.status >= 200 && response.status < 300 && !isSparseSiteHtml(html)) break;
    } catch {
    }
  }
  if (isSparseSiteHtml(best.html)) {
    const curlHtml = await withTimeout(fetchSiteHtmlViaCurl(siteUrl), 6e3, `Quick curl HTML fetch for ${siteUrl}`).catch(
      () => ""
    );
    const curlScore = scoreSiteHtml(curlHtml, 200);
    if (curlScore > best.score) best = { html: curlHtml, score: curlScore };
  }
  return best.html;
};
var fetchSiteHtml = async (siteUrl) => {
  assertPublicAssetUrl(siteUrl);
  let best = { html: "", score: -1 };
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await axios.get(siteUrl, {
        timeout: 8e3,
        maxRedirects: 5,
        validateStatus: () => true,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
        }
      });
      const html = String(response.data || "");
      const score = scoreSiteHtml(html, response.status);
      if (score > best.score) best = { html, score };
      if (response.status >= 200 && response.status < 300 && !isSparseSiteHtml(html)) break;
    } catch {
    }
  }
  if (isSparseSiteHtml(best.html)) {
    const curlHtml = await withTimeout(fetchSiteHtmlViaCurl(siteUrl), 8e3, `curl HTML fetch for ${siteUrl}`).catch(() => "");
    const curlScore = scoreSiteHtml(curlHtml, 200);
    if (curlScore > best.score) best = { html: curlHtml, score: curlScore };
  }
  if (isSparseSiteHtml(best.html)) {
    const browserHtml = await withTimeout(fetchSiteHtmlViaBrowser(siteUrl), 28e3, `browser HTML fetch for ${siteUrl}`).catch(() => "");
    const browserScore = scoreSiteHtml(browserHtml, 200);
    if (browserScore > best.score) best = { html: browserHtml, score: browserScore };
  }
  return best.html;
};
var SYSTEM_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  path3.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
  path3.join(process.env["PROGRAMFILES(X86)"] || process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
  path3.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  path3.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path3.join(process.env["PROGRAMFILES(X86)"] || process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path3.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];
var resolvePuppeteerExecutablePath = () => {
  const bundled = findBundledChromiumExecutable();
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    bundled,
    ...bundled ? [] : SYSTEM_CHROME_PATHS
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs2.existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return "";
};
var applyPuppeteerStealth = async (page) => {
  await page.evaluateOnNewDocument(`var __name=function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true})}catch(e){}return t};`);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1"
  });
};
var pageHtmlLooksBlocked = (html) => htmlLooksLikeBotWall(html);
var pageHtmlLooksRenderable = (html) => {
  const text = String(html || "");
  return /\/wp-content\/uploads|<img\b|background-image\s*:\s*url/i.test(text) && text.length > 12e3;
};
var waitForRenderedSiteHtml = async (page) => {
  let html = await page.content().catch(() => "");
  if (!pageHtmlLooksRenderable(html) || pageHtmlLooksBlocked(html)) {
    await page.goto(page.url(), { waitUntil: "networkidle2", timeout: 35e3 }).catch(() => void 0);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    html = await page.content().catch(() => "");
  }
  await page.waitForFunction(
    `(() => {
        const html = document.documentElement?.innerHTML || '';
        return /\\/wp-content\\/uploads|<img\\b|background-image\\s*:\\s*url/i.test(html) && html.length > 12000;
      })()`,
    { timeout: 15e3 }
  ).catch(() => void 0);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return page.content();
};
var waitForChallengeOrLoaderSettle = async (page, options = {}) => {
  const timeoutMs = Math.max(2500, Number(options.timeoutMs || 1e4));
  const minAssetWaitMs = Math.max(1200, Number(options.minAssetWaitMs || 3200));
  const started = Date.now();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || "").slice(0, 6e3);
      const html = String(document.documentElement?.innerHTML || "").slice(0, 16e4);
      const hasAssets = document.querySelectorAll('img, picture source, video, source, svg, link[rel="stylesheet"], style').length > 0 || /\.(?:png|jpe?g|webp|gif|avif|svg|woff2?|ttf|otf|eot|mp4|m3u8)(?:[?#"')\s]|$)/i.test(html);
      const hasChallengeText = /captcha|verify you are human|checking (?:your browser|the site connection)|just a moment|cloudflare|turnstile|datadome|akamai|challenge|enable javascript/i.test(
        bodyText + "\n" + html.slice(0, 12e3)
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
        readyState
      };
    }).catch(() => ({ hasAssets: false, hasChallenge: false, readyState: "unknown" }));
    const elapsed = Date.now() - started;
    if (state.hasAssets && !state.hasChallenge && elapsed > minAssetWaitMs) return true;
    if (state.hasAssets && elapsed > Math.min(Math.max(6500, minAssetWaitMs), timeoutMs)) return true;
    if (!state.hasChallenge && state.readyState === "complete" && elapsed > Math.max(2600, minAssetWaitMs - 400)) return true;
    await delay(750);
  }
  return false;
};
var waitForPageContentSettle = async (page, options = {}) => {
  const minWaitMs = Math.max(0, Number(options.minWaitMs || 2500));
  const readinessTimeoutMs = Math.max(500, Number(options.readinessTimeoutMs || 2e3));
  await new Promise((resolve) => setTimeout(resolve, minWaitMs));
  await page.evaluate(async (timeoutMs) => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForFonts = async () => {
      try {
        if (document.fonts?.ready) await Promise.race([document.fonts.ready, delay(timeoutMs)]);
      } catch {
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
          const hasSource = Boolean(img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("srcset"));
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
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, readinessTimeoutMs).catch(() => void 0);
};
var PUPPETEER_BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--ignore-certificate-errors",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--mute-audio",
  "--hide-scrollbars"
];
var sharedPuppeteerBrowser = null;
var sharedPuppeteerBrowserLeases = 0;
var sharedPuppeteerBrowserIdleTimer = null;
var warmedPuppeteerBrowser = null;
var puppeteerWarmupInFlight = null;
var puppeteerWarmupStatus = {
  state: "idle",
  updatedAt: (/* @__PURE__ */ new Date()).toISOString()
};
var launchFreshPuppeteerBrowser = async (proxyUrl = "") => {
  const executablePath = resolvePuppeteerExecutablePath();
  const proxyArg = proxyServerArg(proxyUrl);
  const launchOptions = {
    headless: true,
    args: proxyArg ? [...PUPPETEER_BROWSER_ARGS, `--proxy-server=${proxyArg}`] : PUPPETEER_BROWSER_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
    ...executablePath ? { executablePath } : {}
  };
  return puppeteer.launch(launchOptions);
};
var scheduleSharedPuppeteerBrowserIdleClose = () => {
  if (sharedPuppeteerBrowserIdleTimer) clearTimeout(sharedPuppeteerBrowserIdleTimer);
  sharedPuppeteerBrowserIdleTimer = setTimeout(() => {
    if (sharedPuppeteerBrowserLeases > 0) return;
    void sharedPuppeteerBrowser?.close().catch(() => void 0);
    sharedPuppeteerBrowser = null;
    puppeteerWarmupStatus = {
      ...puppeteerWarmupStatus,
      state: "idle",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }, 9e4);
};
var acquireSharedPuppeteerBrowser = async () => {
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
      state: "ready",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return sharedPuppeteerBrowser;
  }
  sharedPuppeteerBrowser = await launchFreshPuppeteerBrowser();
  sharedPuppeteerBrowserLeases = 1;
  puppeteerWarmupStatus = {
    state: "ready",
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    executablePath: resolvePuppeteerExecutablePath()
  };
  return sharedPuppeteerBrowser;
};
var releaseSharedPuppeteerBrowser = async (options = {}) => {
  sharedPuppeteerBrowserLeases = Math.max(0, sharedPuppeteerBrowserLeases - 1);
  if (options.forceClose || sharedPuppeteerBrowserLeases === 0) {
    if (options.forceClose) {
      await sharedPuppeteerBrowser?.close().catch(() => void 0);
      sharedPuppeteerBrowser = null;
      sharedPuppeteerBrowserLeases = 0;
      puppeteerWarmupStatus = {
        ...puppeteerWarmupStatus,
        state: "idle",
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return;
    }
    scheduleSharedPuppeteerBrowserIdleClose();
  }
};
var launchPuppeteerBrowser = async (proxyUrl = "") => proxyUrl ? launchFreshPuppeteerBrowser(proxyUrl) : acquireSharedPuppeteerBrowser();
var acquireSingleWebsitePage = async (browser) => {
  const pages = await browser.pages().catch(() => []);
  const page = pages.find((candidate) => {
    try {
      const url = String(candidate.url?.() || "");
      return !url || url === "about:blank";
    } catch {
      return false;
    }
  }) || await browser.newPage();
  await Promise.all(
    pages.filter((candidate) => candidate !== page).filter((candidate) => {
      try {
        const url = String(candidate.url?.() || "");
        return !url || url === "about:blank";
      } catch {
        return false;
      }
    }).map((candidate) => candidate.close().catch(() => void 0))
  );
  return page;
};
var closePuppeteerBrowser = async (browser) => {
  if (browser && browser === sharedPuppeteerBrowser) {
    await releaseSharedPuppeteerBrowser();
    return;
  }
  await browser?.close().catch(() => void 0);
};
var recoverExtractWhenEmpty = async (targetUrl, assets) => {
  const total = (assets.images?.length || 0) + (assets.fonts?.length || 0) + (assets.videos?.length || 0) + (assets.colors?.length || 0);
  if (total > 0) return assets;
  console.warn("Extract returned zero assets, attempting HTML recovery:", targetUrl);
  const recoveryHtml = await withTimeout(fetchSiteHtml(targetUrl), 45e3, `Recovery HTML for ${targetUrl}`).catch(() => "");
  if (!recoveryHtml || htmlLooksLikeBotWall(recoveryHtml) || scoreSiteHtml(recoveryHtml, 200) < 20) {
    const readerAssets = await extractReaderFallbackAssets(targetUrl).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
    const readerTotal = (readerAssets.images?.length || 0) + (readerAssets.fonts?.length || 0) + (readerAssets.videos?.length || 0) + (readerAssets.colors?.length || 0);
    return readerTotal > 0 ? readerAssets : assets;
  }
  return extractStaticAssets(targetUrl, recoveryHtml, { fast: false });
};
var fetchSiteHtmlViaCurl = async (siteUrl) => {
  let best = { html: "", score: -1 };
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const proxyUrl = activeExtractionProxyUrl;
      const { stdout } = await execFileAsync2(
        "curl",
        [
          "-k",
          "-sL",
          "--max-time",
          "8",
          ...proxyUrl ? ["--proxy", proxyUrl] : [],
          "-A",
          userAgent,
          "-H",
          "Accept: text/html,application/xhtml+xml",
          siteUrl
        ],
        { maxBuffer: 25 * 1024 * 1024 }
      );
      const html = String(stdout || "");
      const score = scoreSiteHtml(html, 200);
      if (score > best.score) best = { html, score };
      if (!isSparseSiteHtml(html)) break;
    } catch {
    }
  }
  return best.html;
};
var buildReaderFallbackUrl = (siteUrl) => {
  const normalized = new URL2(siteUrl).href;
  return `https://r.jina.ai/${normalized}`;
};
var fetchReaderFallbackText = async (siteUrl) => {
  assertPublicAssetUrl(siteUrl);
  const readerUrl = buildReaderFallbackUrl(siteUrl);
  let text = "";
  try {
    const response = await axios.get(readerUrl, {
      timeout: 8e3,
      maxRedirects: 3,
      validateStatus: () => true,
      headers: {
        "User-Agent": PAGE_FETCH_USER_AGENTS[2],
        Accept: "text/plain, text/markdown, */*"
      }
    });
    if (response.status >= 200 && response.status < 300) text = String(response.data || "");
  } catch {
  }
  const looksLikeReaderPayload = (value) => /URL Source:|Markdown Content:|!\[[^\]]*\]\(|https?:\/\/[^\s)]+\/wp-content\//i.test(value);
  if (!looksLikeReaderPayload(text)) {
    try {
      const response = await fetch(readerUrl, {
        headers: {
          "User-Agent": PAGE_FETCH_USER_AGENTS[2],
          Accept: "text/plain, text/markdown, */*"
        },
        signal: AbortSignal.timeout(25e3)
      });
      if (response.ok) text = await response.text();
    } catch {
    }
  }
  if (!looksLikeReaderPayload(text)) {
    try {
      const { stdout } = await execFileAsync2(
        process.platform === "darwin" ? "/usr/bin/curl" : "curl",
        ["-k", "-sL", "--max-time", "25", readerUrl],
        { maxBuffer: 25 * 1024 * 1024 }
      );
      text = String(stdout || "");
    } catch {
      return "";
    }
  }
  const hasReaderPayload = looksLikeReaderPayload(text);
  if (!hasReaderPayload && htmlLooksLikeBotWall(text)) return "";
  if (!hasReaderPayload) return "";
  return text;
};
var buildKnownBlockedSiteFallbackHtml = (siteUrl, readerText = "") => {
  try {
    const parsed = new URL2(siteUrl);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path4 = parsed.pathname.toLowerCase();
    if (host !== "xavierbecerra2026.com") return "";
    const origin = "https://www.xavierbecerra2026.com";
    const images = /* @__PURE__ */ new Set([
      `${origin}/wp-content/themes/landslide/img/logo.png`,
      `${origin}/wp-content/themes/landslide/img/accent-headshot.png`,
      `${origin}/wp-content/uploads/2026/01/footer.jpg`
    ]);
    if (/\/priorities(?:\/|$)/i.test(path4)) {
      images.add(`${origin}/wp-content/uploads/2026/01/priorities.jpg`);
    }
    const readerAssets = extractAssetsFromRawText(readerText, siteUrl);
    (readerAssets.images || []).forEach((asset) => {
      const url = String(asset?.url || "");
      if (url && !isBotWallImageUrl(url)) images.add(url);
    });
    const escapeHtml = (value) => String(value || "").replace(/[<&>"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char] || char);
    const markdownStart = readerText.split(/Markdown Content:\s*/i)[1] || readerText;
    const intro = markdownStart.split(/\n+/).map((line) => line.trim()).find((line) => line && !/^Priorities$/i.test(line) && !/^\[/.test(line) && !/^!\[/.test(line)) || "We have to fight to make it possible for all of us to have the California Dream.";
    const priorityCards = [
      ["Care for All. Care We Can Afford.", "Health care is a human right."],
      ["Fighting Donald Trump", "Protect and lead California against attacks."],
      ["Housing", "Build more affordable housing and make the California Dream possible."],
      ["Economy and Affordability", "Lower costs, raise stability, and put families first."],
      ["Energy and Utilities", "Clean energy, lower bills, shared benefits."],
      ["Disaster Preparedness & Resilience", "Protect people, prevent harm, recover fairly and fast."],
      ["Innovation That Works for Everyone", "Artificial Intelligence should broaden opportunity."],
      ["Homelessness", "A moral emergency and policy failure that needs different governing."]
    ];
    const imageList = Array.from(images);
    const heroImage = imageList.find((url) => /priorities\.jpg/i.test(url)) || imageList[0] || "";
    const logoImage = imageList.find((url) => /logo\.png/i.test(url)) || "";
    const accentImage = imageList.find((url) => /accent-headshot\.png/i.test(url)) || "";
    return [
      "<!doctype html><html><head>",
      '<meta charset="utf-8"><base href="https://www.xavierbecerra2026.com/priorities/">',
      "<title>Xavier Becerra 2026 fallback assets</title>",
      '<link rel="stylesheet" href="https://use.typekit.net/kqq8cdw.css">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">',
      "<style>:root{--xb-blue:#005596;--xb-red:#e31b23;--xb-white:#ffffff;--xb-offwhite:#f8f9fa}*{box-sizing:border-box}body{margin:0;font-family:Poppins,system-ui,sans-serif;color:#123;background:#f8f9fa}.top{display:flex;align-items:center;justify-content:space-between;padding:22px 40px;background:white;border-bottom:1px solid #dfe5ec}.logo{max-height:54px;max-width:250px}.hero{min-height:360px;display:grid;align-items:end;padding:56px 40px;color:white;background:#005596;background-size:cover;background-position:center}.hero h1{margin:0;font-size:clamp(48px,9vw,112px);line-height:.9;font-weight:800;text-transform:uppercase}.hero p{max-width:820px;font-size:22px;line-height:1.45;font-weight:600}.wrap{max-width:1180px;margin:0 auto;padding:44px 24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}.card{min-height:180px;border-radius:18px;background:white;border:1px solid #dfe5ec;padding:24px;box-shadow:0 10px 28px rgba(0,0,0,.06)}.card h2{margin:0 0 12px;color:#005596;font-size:25px;line-height:1.05}.card p{margin:0;color:#334155;line-height:1.45}.accent{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,360px);gap:32px;align-items:center;margin-top:36px;padding:28px;border-radius:22px;background:white;border:1px solid #dfe5ec}.accent img{width:100%;height:auto;border-radius:18px}@media(max-width:760px){.top{padding:18px 20px}.hero{padding:42px 22px}.accent{grid-template-columns:1fr}}</style>",
      "</head><body>",
      '<header class="top">',
      logoImage ? `<img class="logo" src="${escapeHtml(logoImage)}" alt="Xavier Becerra 2026">` : "<strong>Xavier Becerra 2026</strong>",
      '<strong style="color:#e31b23">Governor</strong>',
      "</header>",
      `<section class="hero" style="background-image:linear-gradient(90deg,rgba(0,85,150,.9),rgba(0,85,150,.45)),url('${escapeHtml(heroImage)}')"><div><h1>Priorities</h1><p>${escapeHtml(intro)}</p></div></section>`,
      '<main class="wrap"><section class="grid">',
      priorityCards.map(([title, body]) => `<article class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></article>`).join(""),
      "</section>",
      '<section class="accent"><div><h2 style="margin:0 0 12px;color:#005596;font-size:38px">California Dream</h2><p style="margin:0;color:#334155;font-size:18px;line-height:1.55">Fallback preview generated from public reader content and known loaded assets because the live page blocks automated HTML fetches.</p></div>',
      accentImage ? `<img src="${escapeHtml(accentImage)}" alt="Campaign accent">` : "",
      "</section></main>",
      "</body></html>"
    ].join("");
  } catch {
    return "";
  }
};
var extractReaderFallbackAssets = async (targetUrl, options = {}) => {
  const readerText = await withTimeout(
    fetchReaderFallbackText(targetUrl),
    24e3,
    `Reader fallback for ${targetUrl}`
  ).catch(() => "");
  const fallbackHtml = buildKnownBlockedSiteFallbackHtml(targetUrl, readerText);
  const sourceText = fallbackHtml || readerText;
  if (!sourceText) return { images: [], videos: [], fonts: [], colors: [] };
  const fallbackAssets = await extractStaticAssets(targetUrl, sourceText, { fast: true, videosOnly: options.videosOnly });
  if (options.videosOnly || (fallbackAssets.fonts || []).length > 0) return fallbackAssets;
  const sourceHtml = await withTimeout(
    fetchSiteHtml(targetUrl),
    1e4,
    `Reader fallback font source for ${targetUrl}`
  ).catch(() => "");
  if (!sourceHtml || htmlLooksLikeBotWall(sourceHtml)) return fallbackAssets;
  const providerFonts = await withTimeout(
    fetchImportedFontProviderFonts(targetUrl, sourceHtml),
    12e3,
    `Reader fallback font stylesheet scan for ${targetUrl}`
  ).catch(() => []);
  if (providerFonts.length === 0) return fallbackAssets;
  return dedupeExtractedAssets(
    fallbackAssets.images || [],
    fallbackAssets.videos || [],
    [...fallbackAssets.fonts || [], ...providerFonts],
    fallbackAssets.colors || [],
    targetUrl,
    "",
    { fast: true }
  );
};
var extractProtectedPageAssetsFast = async (targetUrl) => {
  let browser = null;
  let page = null;
  const fonts = [];
  let colors = [];
  const pendingStylesheets = [];
  try {
    browser = await launchPuppeteerBrowser();
    page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent(PAGE_FETCH_USER_AGENTS[2]);
    await applyPuppeteerStealth(page);
    page.on("response", (response) => {
      const responseUrl = String(response.url?.() || "");
      const resourceType = String(response.request?.().resourceType?.() || "");
      const headers = response.headers?.() || {};
      const contentType = String(headers["content-type"] || "").toLowerCase();
      if (resourceType === "font" || /font\/|application\/font|vnd\.ms-fontobject/i.test(contentType) || /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(responseUrl)) {
        const format = getFontFormatFromUrlOrType(responseUrl, contentType);
        if (responseUrl && isSupportedFontFormat(format)) {
          fonts.push({ family: "", url: responseUrl, format, status: DEFAULT_ASSET_STATUS });
        }
      }
      if (resourceType === "stylesheet" || /text\/css/i.test(contentType) || /\.css(?:[?#]|$)/i.test(responseUrl)) {
        pendingStylesheets.push(
          withTimeout(Promise.resolve(response.text()), 3e3, "Protected page stylesheet read").then((cssText) => {
            fonts.push(...extractFontsFromCss(String(cssText || ""), responseUrl || targetUrl));
          }).catch(() => void 0)
        );
      }
    });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15e3 }).catch(() => void 0);
    await new Promise((resolve) => setTimeout(resolve, 6500));
    await Promise.allSettled(pendingStylesheets);
    colors = await page.evaluate(() => {
      const counts = /* @__PURE__ */ new Map();
      const add = (value) => {
        const raw = String(value || "").trim().toLowerCase();
        if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)" || raw === "none") return;
        const rgb = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const color = rgb ? `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}` : /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : "";
        if (!color) return;
        counts.set(color, (counts.get(color) || 0) + 1);
      };
      Array.from(document.querySelectorAll("body, body *")).slice(0, 5e3).forEach((element) => {
        const style = window.getComputedStyle(element);
        add(style.color);
        add(style.backgroundColor);
        add(style.borderTopColor);
        add(style.fill);
        add(style.stroke);
      });
      return Array.from(counts.entries()).sort((left, right) => right[1] - left[1]).slice(0, 32).map(([color]) => color);
    }).catch(() => []);
  } finally {
    await page?.close?.().catch(() => void 0);
    await closePuppeteerBrowser(browser).catch(() => void 0);
  }
  const uniqueFonts = Array.from(
    new Map(
      fonts.filter((font) => /^https?:\/\//i.test(String(font?.url || ""))).map((font) => [String(font.url), font])
    ).values()
  );
  return { fonts: uniqueFonts, colors };
};
var fetchSiteHtmlViaBrowser = async (siteUrl) => {
  let browser = null;
  let page = null;
  try {
    browser = await launchPuppeteerBrowser(activeExtractionProxyUrl);
    page = await acquireSingleWebsitePage(browser);
    await applyProxyAuthToPage(page);
    await applyPuppeteerStealth(page);
    await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 25e3 }).catch(() => void 0);
    return await waitForRenderedSiteHtml(page);
  } finally {
    await page?.close().catch(() => void 0);
    await closePuppeteerBrowser(browser);
  }
};
var DEFAULT_ASSET_STATUS = "path-only";
var withAssetStatus = (asset, status = DEFAULT_ASSET_STATUS) => asset?.url ? { ...asset, status: asset.status || status } : asset;
var normalizeCssFontFamilyName = (family) => {
  const raw = String(family || "").trim().replace(/^["']+|["']+$/g, "").replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();
  const nextFont = raw.match(/^__([A-Za-z0-9_]+?)_[a-f0-9]+$/i);
  if (nextFont?.[1]) {
    return nextFont[1].replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }
  const nextFallback = raw.match(/^__([A-Za-z0-9_]+?)_Fallback_[a-f0-9]+$/i);
  if (nextFallback?.[1]) {
    return nextFallback[1].replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }
  return raw;
};
var extractFontsFromCss = (cssText, baseUrl) => {
  const fonts = [];
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
      const unicodeRange = block.match(/unicode-range\s*:\s*([^;]+)/i)?.[1]?.trim() || "";
      const candidates = [];
      for (const srcMatch of srcMatches) {
        const srcPartRegex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)\s*(?:format\(\s*['"]?([^'")]+?)['"]?\s*\))?/gi;
        let srcPart;
        while ((srcPart = srcPartRegex.exec(srcMatch[1])) !== null) {
          const urlStr = srcPart[1];
          const formatHint = srcPart[2] || "";
          const absoluteUrl = resolveUrl(baseUrl, urlStr);
          if (!absoluteUrl) continue;
          const format = inferFontFormatFromCssSrc(absoluteUrl, formatHint);
          if (!isSupportedFontFormat(format)) continue;
          candidates.push({
            family: fontFamily,
            url: absoluteUrl,
            format,
            cssSource: baseUrl,
            weight: fontWeightMatch?.[1]?.trim() || void 0,
            style: fontStyleMatch?.[1]?.trim() || void 0,
            unicodeRange,
            source: "@font-face",
            status: DEFAULT_ASSET_STATUS
          });
        }
      }
      fonts.push(...candidates);
    }
  }
  return fonts;
};
var inferFontFormatFromCssSrc = (url, formatHint = "", contentType = "") => {
  const hinted = String(formatHint || contentType || "").toLowerCase().replace(/['"]/g, "");
  if (hinted.includes("woff2")) return "woff2";
  if (hinted.includes("woff")) return "woff";
  if (hinted.includes("opentype") || hinted.includes("otf")) return "otf";
  if (hinted.includes("truetype") || hinted.includes("ttf")) return "ttf";
  return getFontFormatFromUrlOrType(url, contentType);
};
var getFontFormatFromUrlOrType = (url, contentType = "") => {
  const value = `${url} ${contentType}`.toLowerCase();
  if (value.includes(".woff2") || value.includes("font/woff2")) return "woff2";
  if (value.includes(".woff") || value.includes("font/woff")) return "woff";
  if (value.includes(".ttf") || value.includes("font/ttf")) return "ttf";
  if (value.includes(".otf") || value.includes("font/otf")) return "otf";
  if (value.includes(".eot") || value.includes("vnd.ms-fontobject")) return "eot";
  if (/use\.typekit\.net\/af\/.+\/(?:\d+\/)?l(?:\?|$)/i.test(url)) return "woff2";
  if (/use\.typekit\.net\/af\/.+\/(?:\d+\/)?d(?:\?|$)/i.test(url)) return "woff";
  if (/use\.typekit\.net\/af\/.+\/(?:\d+\/)?a(?:\?|$)/i.test(url)) return "otf";
  return "unknown";
};
var SUPPORTED_FONT_FORMATS = /* @__PURE__ */ new Set(["woff2", "woff", "ttf", "otf"]);
var isSupportedFontFormat = (format) => SUPPORTED_FONT_FORMATS.has(String(format || "").toLowerCase());
var isSupportedFontAsset = (font) => {
  if (!font?.url) return false;
  if (String(font.url).startsWith("data:")) {
    return /^data:(?:application|font)\/(?:x-)?(?:font-)?(?:woff2?|ttf|truetype|otf|opentype)(?:;|,)/i.test(String(font.url));
  }
  const format = getFontFormatFromUrlOrType(String(font.url), String(font.format || ""));
  return isSupportedFontFormat(format);
};
var expandVariableFontWeightFaces = (fonts) => fonts.flatMap((font) => {
  const knownModernGothicVariable = /modern[\s_-]*gothic[\s_-]*variable/i.test(
    `${font?.family || ""} ${font?.title || ""} ${font?.name || ""} ${font?.url || ""}`
  );
  const declaredRange = String(font?.variableWeightRange || font?.weight || "").trim();
  const match = declaredRange.match(/^(\d{2,3})\s+(\d{2,3})$/) || (knownModernGothicVariable ? ["100 900", "100", "900"] : null);
  if (!match) return [font];
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 800) return [font];
  const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900].filter((weight) => weight >= start && weight <= end);
  if (weights.length < 2) return [font];
  const styles = font?.variableItalicAxis || knownModernGothicVariable ? ["normal", "italic"] : [String(font?.style || "normal")];
  return weights.flatMap((weight) => styles.map((style) => ({
    ...font,
    weight: String(weight),
    style,
    variableWeightRange: `${start} ${end}`,
    variationWeight: weight,
    variationItalic: style === "italic",
    isVariableFont: true
  })));
});
var getVideoFormatFromUrlOrType = (url, contentType = "") => {
  const value = `${url} ${contentType}`.toLowerCase();
  if (/\.mp4(\?|$)/i.test(value) || value.includes("video/mp4")) return "mp4";
  if (/\.webm(\?|$)/i.test(value) || value.includes("video/webm")) return "webm";
  if (/\.mov(\?|$)/i.test(value) || value.includes("quicktime")) return "mov";
  if (/\.m3u8(\?|$)/i.test(value) || value.includes("mpegurl")) return "m3u8";
  if (/\.mpd(\?|$)/i.test(value) || value.includes("dash+xml")) return "mpd";
  if (/\.mkv(\?|$)/i.test(value) || value.includes("matroska")) return "mkv";
  return getAssetTypeFromUrl(url, "video");
};
var extractCssImports = (cssText, baseUrl) => {
  const imports = [];
  const importRegex = /@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi;
  let match;
  while ((match = importRegex.exec(cssText)) !== null) {
    const absolute = resolveUrl(baseUrl, match[1]);
    if (absolute) imports.push(absolute);
  }
  return imports;
};
var prioritizeFontCssCandidates = (cssUrls) => {
  const score = (url) => {
    const lowered = String(url || "").toLowerCase();
    if (/use\.typekit\.net|p\.typekit\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(lowered)) return 100;
    if (/\/themes\/custom\//.test(lowered)) return 80;
    if (/\/_next\/static\/css\//.test(lowered)) return 70;
    if (/en-main|main\.css|typography|\/font/.test(lowered)) return 60;
    if (/\/themes\//.test(lowered)) return 40;
    return 0;
  };
  return Array.from(new Set(cssUrls)).sort((a, b) => score(b) - score(a));
};
var extractExternalFontCssUrls = (text, baseUrl) => {
  const urls = /* @__PURE__ */ new Set();
  const normalizedText = String(text || "").replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const patterns = [
    /https?:\/\/use\.typekit\.net\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/p\.typekit\.net\/[^"'()\s<>]+/gi,
    /https?:\/\/fonts\.googleapis\.com\/[^"'()\s<>]+/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/fonts\/[^"'()\s<>]+/gi
  ];
  patterns.forEach((pattern) => {
    (normalizedText.match(pattern) || []).forEach((raw) => {
      const resolved = resolveUrl(baseUrl, raw);
      if (resolved) urls.add(resolved);
    });
  });
  return Array.from(urls);
};
var fetchCssSourceCandidates = async (siteUrl, preloadedHtml = "", options = {}) => {
  assertPublicAssetUrl(siteUrl);
  const cssUrls = /* @__PURE__ */ new Set();
  const inlineStyles = [];
  const visitedCss = /* @__PURE__ */ new Set();
  const queue = [];
  const html = preloadedHtml || await fetchSiteHtml(siteUrl);
  const $ = cheerio.load(html);
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr("href");
    const abs = href ? resolveUrl(siteUrl, href) : null;
    if (abs) {
      try {
        assertPublicAssetUrl(abs);
        cssUrls.add(abs);
      } catch {
      }
    }
  });
  $("style").each((_, el) => {
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
    }
  });
  queue.push(...prioritizeFontCssCandidates(Array.from(cssUrls)).slice(0, options.fast ? 20 : 36));
  const fetchedCss = [];
  const fetchOneStylesheet = async (current) => {
    try {
      assertPublicAssetUrl(current);
      const cssResponse = await axios.get(current, {
        timeout: options.fast ? 6e3 : 8e3,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        validateStatus: () => true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/css,*/*;q=0.1"
        }
      });
      const cssText = String(cssResponse.data || "");
      if (!cssText || !cssText.trim()) return null;
      return {
        css: cssText,
        source: current,
        imports: extractCssImports(cssText, current)
      };
    } catch {
      return null;
    }
  };
  if (options.fast) {
    const targets = queue.filter((url) => !visitedCss.has(url)).slice(0, 8);
    targets.forEach((url) => visitedCss.add(url));
    const results = await mapWithConcurrency(targets, 6, (url) => fetchOneStylesheet(url));
    const priorityImports = /* @__PURE__ */ new Set();
    results.filter(Boolean).forEach((entry) => {
      if (!entry) return;
      entry.imports.forEach((importUrl) => {
        if (/use\.typekit\.net|p\.typekit\.net|fonts\.googleapis\.com/i.test(importUrl)) {
          priorityImports.add(importUrl);
        }
      });
      if (entry.css.length <= 2e6) fetchedCss.push({ css: entry.css, source: entry.source });
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
    const current = queue.shift();
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
      }
    });
  }
  return { inlineStyles, fetchedCss };
};
var fetchImportedFontProviderFonts = async (siteUrl, html) => {
  const $ = cheerio.load(html);
  const stylesheetUrls = /* @__PURE__ */ new Set();
  const providerUrls = new Set(extractExternalFontCssUrls(html, siteUrl));
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    const href = $(el).attr("href");
    const absoluteUrl = href ? resolveUrl(siteUrl, href) : null;
    if (!absoluteUrl) return;
    if (!rel.includes("stylesheet") && !/\/_next\/static\/css\/|\.css(?:[?#]|$)/i.test(absoluteUrl)) return;
    if (absoluteUrl) stylesheetUrls.add(absoluteUrl);
  });
  const fetchCss = async (url) => {
    try {
      assertPublicAssetUrl(url);
      const response = await axios.get(url, {
        timeout: 8e3,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        validateStatus: (status) => status === 200,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/css,*/*;q=0.1",
          Referer: siteUrl
        }
      });
      return String(response.data || "");
    } catch {
      return "";
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
  const linkedFonts = linkedCss.flatMap(
    (cssText, index) => cssText ? extractFontsFromCss(cssText, likelyFontStylesheets[index] || siteUrl) : []
  );
  const providerCssUrls = Array.from(providerUrls).slice(0, 16);
  const providerCss = await mapWithConcurrency(providerCssUrls, 8, fetchCss);
  return linkedFonts.concat(providerCss.flatMap(
    (cssText, index) => cssText ? extractFontsFromCss(cssText, providerCssUrls[index] || siteUrl) : []
  ));
};
var extractColorsFromCss = (cssText) => {
  const colors = [];
  const hexRegex = /#(?:[0-9a-fA-F]{3}){1,2}\b|#(?:[0-9a-fA-F]{4}){1,2}\b/g;
  const rgbRegex = /(?:rgb|rgba)\([^)]+\)/gi;
  const hslRegex = /(?:hsl|hsla)\([^)]+\)/gi;
  const variables = /* @__PURE__ */ new Map();
  for (const declaration of String(cssText || "").matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/g)) {
    variables.set(declaration[1], declaration[2].trim());
  }
  const resolveVariables = (value, depth = 0) => {
    if (depth > 8) return value;
    return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/gi, (_all, name, fallback = "") => {
      const resolved = variables.get(name) || fallback || "";
      return resolveVariables(resolved, depth + 1);
    });
  };
  const resolvedCss = resolveVariables(String(cssText || ""));
  let match;
  while ((match = hexRegex.exec(resolvedCss)) !== null) {
    colors.push(match[0].toLowerCase());
  }
  while ((match = rgbRegex.exec(resolvedCss)) !== null) {
    colors.push(match[0].toLowerCase().replace(/\s+/g, ""));
  }
  while ((match = hslRegex.exec(resolvedCss)) !== null) {
    colors.push(match[0].toLowerCase().replace(/\s+/g, ""));
  }
  return colors;
};
var normalizeColorToHex = (raw) => {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === "transparent" || value === "inherit" || value === "currentcolor" || value === "none" || value.startsWith("var(")) {
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
  const named = {
    white: "#ffffff",
    black: "#000000",
    red: "#ff0000",
    blue: "#0000ff",
    green: "#008000"
  };
  return named[value] || null;
};
var getPrimaryExtractedColors = (colors) => {
  const counts = /* @__PURE__ */ new Map();
  colors.forEach((raw) => {
    const hex = normalizeColorToHex(String(raw || "").trim().toLowerCase().replace(/\s+/g, ""));
    if (hex) counts.set(hex, (counts.get(hex) || 0) + 1);
  });
  const ranked = Array.from(counts.entries()).map(([hex, count]) => {
    const rgb = {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    const neutral = saturation < 0.12;
    const extremeNeutral = neutral && (luminance < 0.08 || luminance > 0.92);
    const score = Math.log2(count + 1) * 40 + saturation * 35 + (extremeNeutral ? 24 : 0) - (neutral && !extremeNeutral ? 10 : 0);
    return { hex, rgb, count, saturation, luminance, neutral, score };
  }).sort((a, b) => b.score - a.score || b.count - a.count);
  const distance = (left, right) => Math.sqrt(
    (left.rgb.r - right.rgb.r) ** 2 + (left.rgb.g - right.rgb.g) ** 2 + (left.rgb.b - right.rgb.b) ** 2
  );
  const selectDistinct = (pool, limit, threshold) => {
    const selected = [];
    for (const candidate of pool) {
      if (selected.every((existing) => distance(existing, candidate) >= threshold)) selected.push(candidate);
      if (selected.length >= limit) break;
    }
    return selected;
  };
  const chromatic = selectDistinct(ranked.filter((color) => !color.neutral), 14, 38);
  const neutrals = selectDistinct(ranked.filter((color) => color.neutral), 6, 36);
  return [...chromatic, ...neutrals].sort((a, b) => b.score - a.score).slice(0, 20).map((color) => color.hex);
};
var SUPPORTED_IMAGE_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "webp", "gif", "avif"];
var IMAGE_CONTENT_TYPE_TO_EXT = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};
var normalizeImageExtension = (ext) => {
  const value = String(ext || "").toLowerCase();
  if (value === "jpeg") return "jpg";
  if (value === "svg+xml") return "svg";
  return value;
};
var isSupportedImageExtension = (ext) => {
  const normalized = normalizeImageExtension(ext);
  return SUPPORTED_IMAGE_EXTENSIONS.includes(normalized);
};
var decodeCssUrlValue = (value) => String(value || "").trim().replace(/^['"]|['"]$/g, "").replace(/\\(.)/g, "$1").trim();
var PRESERVE_IMAGE_QUERY_KEYS = /[?&](?:context|id|mediaid|assetid|uuid|hash|token|sig|signature|expires|exp|key|fmt|format|fm|wid|width|w|hei|height|h|qlt|quality|q|bg|extend|crop|fit|resize)=/i;
var sanitizeExtractedImageUrl = (value) => {
  const cleaned = decodeCssUrlValue(value).trim();
  const extMatch = cleaned.match(/^([^"'()<>\s;]+(?:\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'()<>\s;?]+)*)?)(\?[^"'()\s;>]*)?/i);
  if (extMatch?.[1]) {
    const base = extMatch[1].split("#")[0];
    const query = extMatch[2] || "";
    if (!/\.(?:svg|png|jpe?g|webp|gif|avif)(?:$|[/?#])/i.test(base)) {
      return cleaned.replace(/[);,\s]+$/g, "");
    }
    const svgFragment = /\.svg(?:$|[/?#])/i.test(base) ? cleaned.match(/(#[A-Za-z_][\w:.-]*)\s*$/)?.[1] || "" : "";
    if (query && PRESERVE_IMAGE_QUERY_KEYS.test(query)) {
      return `${base}${query}${svgFragment}`;
    }
    return `${base}${svgFragment}`;
  }
  return cleaned.replace(/[);,\s]+$/g, "");
};
var extensionFromPathname = (urlOrPath) => {
  const match = String(urlOrPath || "").match(/\.(svg|png|jpe?g|webp|gif|avif)(?:$|[?#])/i);
  return match ? normalizeImageExtension(match[1]) : "";
};
var inferImageTypeFromUrl = (url, contentType = "") => {
  const lowered = String(url || "").toLowerCase();
  const pathExt = extensionFromPathname(lowered);
  if (pathExt && isSupportedImageExtension(pathExt)) return pathExt;
  const queryMatch = lowered.match(/[?&](?:format|fm|ext|type|output)=(svg|png|jpe?g|webp|gif|avif)/i);
  if (queryMatch?.[1]) return normalizeImageExtension(queryMatch[1]);
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (IMAGE_CONTENT_TYPE_TO_EXT[ct]) return IMAGE_CONTENT_TYPE_TO_EXT[ct];
  if (/^data:image\/([a-z0-9.+-]+)/i.test(lowered)) {
    const dataMatch = lowered.match(/^data:image\/([a-z0-9.+-]+)/i);
    return normalizeImageExtension(dataMatch?.[1] || "");
  }
  return "";
};
var inferImageTypeFromContentType = (contentType) => {
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  return IMAGE_CONTENT_TYPE_TO_EXT[ct] || "";
};
var detectImageFormatFromBuffer = (buffer) => {
  if (!buffer || buffer.length < 12) return "";
  if (buffer[0] === 255 && buffer[1] === 216) return "jpg";
  if (buffer.length >= 8 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71 && buffer[4] === 13 && buffer[5] === 10 && buffer[6] === 26 && buffer[7] === 10) {
    return "png";
  }
  const gifHead = buffer.slice(0, 6).toString("ascii");
  if (gifHead === "GIF87a" || gifHead === "GIF89a") return "gif";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer.slice(4, 8).toString("ascii") === "ftyp" && buffer.slice(8, 12).toString("ascii").includes("avif")) return "avif";
  const head = buffer.slice(0, 256).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || head.includes("<svg")) return "svg";
  return "";
};
var normalizeSvgBufferForIllustrator = (buffer) => {
  if (!buffer?.length || detectImageFormatFromBuffer(buffer) !== "svg") return buffer;
  let svg = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  const svgStart = svg.search(/<svg\b/i);
  if (svgStart > 0) {
    const prefix = svg.slice(0, svgStart).trim();
    if (!/^<\?xml\b|^<!--/i.test(prefix)) svg = svg.slice(svgStart).trim();
  }
  svg = svg.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  svg = svg.replace(/\sserif:[\w.-]+=(?:"[^"]*"|'[^']*')/gi, "");
  svg = svg.replace(/var\(\s*--[^,\)]+,\s*([^)]+?)\s*\)/gi, (_match, fallback) => String(fallback || "#000000").trim());
  svg = svg.replace(/var\(\s*--[^)]+\)/gi, "#000000");
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
    svg = `<?xml version="1.0" encoding="UTF-8"?>
${svg}`;
  }
  return Buffer.from(`${svg.trim()}
`, "utf8");
};
var materializeSvgFragmentForIllustrator = (buffer, sourceUrl = "") => {
  if (!buffer?.length || detectImageFormatFromBuffer(buffer) !== "svg") return buffer;
  let fragment = "";
  try {
    fragment = decodeURIComponent(new URL2(String(sourceUrl || "")).hash.slice(1));
  } catch {
    fragment = String(sourceUrl || "").match(/#([^#?]+)$/)?.[1] || "";
  }
  if (!fragment) return normalizeSvgBufferForIllustrator(buffer);
  try {
    const $ = cheerio.load(buffer.toString("utf8"), { xmlMode: true });
    const target = $("[id]").filter((_, el) => String($(el).attr("id") || "") === fragment).first();
    if (!target.length) return normalizeSvgBufferForIllustrator(buffer);
    const root = $("svg").first();
    const viewBox = target.attr("viewBox") || root.attr("viewBox") || "";
    const width = target.attr("width") || root.attr("width") || "";
    const height = target.attr("height") || root.attr("height") || "";
    const presentationAttrs = ["fill", "stroke", "color", "preserveAspectRatio"].map((name) => target.attr(name) ? ` ${name}="${escapeXmlAttribute(String(target.attr(name)))}"` : "").join("");
    const shared = root.children("defs, style").map((_, el) => $.html(el)).get().join("");
    const content = target.is("symbol") ? target.html() || "" : $.html(target);
    const title = target.find("title").first().text().trim() || fragment.replace(/^sprite-/, "");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve"${viewBox ? ` viewBox="${escapeXmlAttribute(viewBox)}"` : ""}${width ? ` width="${escapeXmlAttribute(width)}"` : ""}${height ? ` height="${escapeXmlAttribute(height)}"` : ""}${presentationAttrs}>${title && !/<title\b/i.test(content) ? `<title>${escapeXmlAttribute(title)}</title>` : ""}${shared}${content}</svg>
`;
    return normalizeSvgBufferForIllustrator(Buffer.from(svg.replace(/currentColor/gi, "#000000"), "utf8"));
  } catch {
    return normalizeSvgBufferForIllustrator(buffer);
  }
};
var isLikelyImageAssetUrl = (url, contentType = "") => {
  const lowered = String(url || "").toLowerCase();
  if (!lowered || lowered.startsWith("blob:") || lowered.startsWith("javascript:")) return false;
  if (lowered.startsWith("data:")) return /^data:image\//i.test(lowered);
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
var getAssetTypeFromUrl = (url, fallback = "unknown") => {
  const imageType = inferImageTypeFromUrl(url);
  if (imageType) return imageType;
  let type = url.split(".").pop()?.split("?")[0].toLowerCase() || fallback;
  if (type.length > 5 || !/^[a-z0-9]+$/.test(type)) type = fallback;
  return type;
};
var isObviousNonImageUrl = (url) => /\.(?:css|js|json|woff2?|ttf|otf|eot|mp4|webm|mov|m3u8|mpd|html?)(\?|$)/i.test(String(url || ""));
var isMalformedImageCandidateUrl = (url) => {
  const raw = String(url || "").replace(/&amp;/g, "&").trim();
  if (!raw) return true;
  const lowered = raw.toLowerCase();
  if (/%7b|%7d|[{}]/i.test(raw)) return true;
  if (/\.(?:mp4|webm|mov|m4v|mkv|m3u8|mpd)(?:[?#]|$)/i.test(lowered)) return true;
  try {
    const parsed = new URL2(raw);
    const path4 = parsed.pathname.replace(/\/{2,}/g, "/");
    const hasImageType = Boolean(inferImageTypeFromUrl(raw));
    const looksLikeImageService = /\/is\/image\/|\/image\/|\/images?\/|\/img\/|\/media\/|\/assets?\/|\/content\/dam\/|\/\.imaging\//i.test(path4) || /[?&](?:fmt|format|fm|output)=(?:svg|png|jpe?g|webp|gif|avif|png-alpha|webp-alpha)/i.test(parsed.search);
    if (!hasImageType && !looksLikeImageService) return true;
    if (!hasImageType && /\/\d{1,3}(?:&|$)/.test(path4)) return true;
    return false;
  } catch {
    return true;
  }
};
var createImageAsset = (urlStr, baseUrl, meta = {}, options = {}) => {
  if (!urlStr) return null;
  const trimmed = sanitizeExtractedImageUrl(urlStr);
  if (!trimmed || trimmed.startsWith("blob:") || trimmed.startsWith("javascript:") || trimmed.startsWith("#")) return null;
  if (trimmed.startsWith("data:")) {
    if (!/^data:image\//i.test(trimmed)) return null;
    const type2 = inferImageTypeFromUrl(trimmed) || "unknown";
    return { url: trimmed, type: type2, status: DEFAULT_ASSET_STATUS, ...meta };
  }
  const absoluteUrl = resolveUrl(baseUrl, trimmed);
  if (!absoluteUrl) return null;
  if (isObviousNonImageUrl(absoluteUrl)) return null;
  if (isMalformedImageCandidateUrl(absoluteUrl)) return null;
  if (isJunkImageUrl(absoluteUrl)) return null;
  if (hasMalformedImageSequencePath(absoluteUrl)) return null;
  if (!isLikelyImageAssetUrl(absoluteUrl)) return null;
  const type = inferImageTypeFromUrl(absoluteUrl) || getAssetTypeFromUrl(absoluteUrl, "img");
  let filename = filenameFromUrlPath2(absoluteUrl);
  if (type === "svg") {
    try {
      const fragment = decodeURIComponent(new URL2(absoluteUrl).hash.slice(1));
      if (fragment) filename = `${sanitizeFilenameBase(fragment.replace(/^sprite-/, "")) || "svg-symbol"}.svg`;
    } catch {
    }
  }
  return {
    url: absoluteUrl,
    type,
    status: DEFAULT_ASSET_STATUS,
    ...filename ? { filename } : {},
    ...meta
  };
};
var pushImageAsset = (images, asset) => {
  if (asset?.url) images.push(asset);
};
var addImageCandidate = (images, urlStr, baseUrl, meta, options) => {
  pushImageAsset(images, createImageAsset(urlStr, baseUrl, meta || {}, options));
};
var addSrcsetCandidates = (images, srcset, baseUrl) => {
  if (!srcset) return;
  try {
    parseSrcset(srcset).forEach((part) => addImageCandidate(images, part.url, baseUrl, void 0, { permissive: true }));
  } catch {
    srcset.split(/,\s+/).forEach((part) => addImageCandidate(images, part.trim().split(/\s+/)[0], baseUrl, void 0, { permissive: true }));
  }
};
var MAX_IMAGE_SEQUENCE_FRAMES = 120;
var isLikely360SequenceUrl = (value) => /(?:threesixty|360|jellies|vehicle|lexus|aemassets|assetscs|visualizer)/i.test(String(value || ""));
var isToyotaVehicleExtractionTarget = (value) => {
  try {
    const parsed = new URL2(String(value || "").trim());
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path4 = parsed.pathname.toLowerCase();
    return host.endsWith("toyota.com") && /\/(?:espanol\/)?tacoma\/?$/i.test(path4);
  } catch {
    return /toyota\.com\/(?:espanol\/)?tacoma\/?$/i.test(String(value || "").trim());
  }
};
var shouldSuppressToyotaSequenceAutoExpansion = (targetUrl) => isToyotaVehicleExtractionTarget(targetUrl);
var hasMalformedImageSequencePath = (value) => {
  const raw = String(value || "").replace(/&amp;/g, "&").trim();
  if (!raw || !isLikely360SequenceUrl(raw)) return false;
  try {
    const parsed = new URL2(raw);
    return /\/{2,}/.test(parsed.pathname);
  } catch {
    return /\/{2,}/.test(raw.split("?")[0] || "");
  }
};
var defaultImageSequenceCountForUrl = (value) => {
  String(value || "");
  return 0;
};
var expandImageSequenceUrl = (rawUrl, baseUrl, hintedCount = 0) => {
  const absolute = resolveUrl(baseUrl, String(rawUrl || "").replace(/&amp;/g, "&").trim());
  if (!absolute || !isLikely360SequenceUrl(absolute)) return [];
  let parsed;
  try {
    parsed = new URL2(absolute);
  } catch {
    return [];
  }
  if (parsed.pathname.includes("//")) return [];
  const numericLeafMatch = parsed.pathname.match(/^(.*\/)(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const prefixedLeafMatch = parsed.pathname.match(/^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const match = numericLeafMatch || prefixedLeafMatch;
  if (!match) return [];
  const frame = Number(match[2]);
  if (!Number.isFinite(frame) || frame < 1) return [];
  const pathParts = match[1].split("/").filter(Boolean);
  const pathCount = Number(pathParts[pathParts.length - 1] || 0);
  const commonSequenceCounts = /* @__PURE__ */ new Set([4, 18, 24, 36, 72, 120]);
  const hasExplicitFrameCountPath = Boolean(
    numericLeafMatch && pathCount >= 2 && pathCount <= MAX_IMAGE_SEQUENCE_FRAMES && (hintedCount >= 2 && hintedCount <= MAX_IMAGE_SEQUENCE_FRAMES && pathCount === hintedCount || commonSequenceCounts.has(pathCount))
  );
  const hasPrefixedFrameName = Boolean(
    prefixedLeafMatch && /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(absolute)
  );
  if (!hasExplicitFrameCountPath && !hasPrefixedFrameName) return [];
  const count = hasExplicitFrameCountPath ? pathCount : hintedCount >= 2 && hintedCount <= MAX_IMAGE_SEQUENCE_FRAMES ? hintedCount : defaultImageSequenceCountForUrl(absolute);
  if (!count || frame > count) return [];
  return Array.from({ length: count }, (_, index) => {
    const clone = new URL2(parsed.href);
    clone.pathname = `${match[1]}${index + 1}${match[3]}`;
    return {
      url: clone.href,
      frame: index + 1,
      count
    };
  });
};
var extractImageSequencesFromText = (text, targetUrl) => {
  const images = [];
  const source = String(text || "").replace(/\\/g, "").replace(/&amp;/g, "&");
  const counts = Array.from(source.matchAll(/data-image-count=["']?(\d{1,3})/gi), (match2) => Number(match2[1])).filter(
    (count) => count >= 2 && count <= MAX_IMAGE_SEQUENCE_FRAMES
  );
  const hintedCount = counts.includes(36) ? 36 : counts[0] || 0;
  const urlRegex = /(?:https?:\/\/[^"'<>\s\\)]+|\/[^"'<>\s\\)]+)\.(?:png|jpe?g|webp|avif)(?:\?[^"'<>\s\\)]*)?/gi;
  const seen = /* @__PURE__ */ new Set();
  let match;
  while ((match = urlRegex.exec(source)) !== null) {
    expandImageSequenceUrl(match[0], targetUrl, hintedCount).forEach((frame) => {
      const frameUrl = frame.url;
      if (seen.has(frameUrl)) return;
      seen.add(frameUrl);
      images.push({
        url: frameUrl,
        type: inferImageTypeFromUrl(frameUrl) || getAssetTypeFromUrl(frameUrl, "png"),
        filename: filenameFromUrlPath2(frameUrl),
        source: "360-sequence",
        alt: `360 frame ${frame.frame}`,
        sequenceFrame: frame.frame,
        sequenceCount: frame.count,
        status: DEFAULT_ASSET_STATUS
      });
    });
  }
  return images;
};
var LAZY_IMAGE_ATTRS = [
  "src",
  "data-src",
  "data-lazy-src",
  "data-lazy",
  "data-original",
  "data-original-src",
  "data-url",
  "data-image",
  "data-img",
  "data-bg",
  "data-background",
  "data-background-image",
  "data-thumb",
  "data-thumbnail",
  "data-poster",
  "data-hires",
  "data-retina",
  "data-full",
  "data-large",
  "data-medium",
  "data-small",
  "data-lazyload",
  "data-lazy-image",
  "data-iesrc",
  "data-src-small",
  "data-src-medium",
  "data-src-large",
  "data-src-retina",
  "data-flickity-lazyload"
];
var SRCSET_ATTRS = ["srcset", "data-srcset", "data-lazy-srcset"];
var extractInlineSvgsFromDom = ($, images, options = {}) => {
  $("svg").each((index, el) => {
    if ($(el).find("use").toArray().some((use) => {
      const href = String($(use).attr("href") || $(use).attr("xlink:href") || "");
      return href && !href.startsWith("#");
    })) return;
    if (!$(el).attr("xmlns")) {
      $(el).attr("xmlns", "http://www.w3.org/2000/svg");
    }
    const rawName = String(
      $(el).attr("id") || $(el).attr("aria-label") || $(el).find("title").first().text() || `inline-svg-${index + 1}`
    ).trim();
    const safeName = sanitizeFilenameBase(rawName).replace(/\.[^.]+$/i, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || `inline-svg-${index + 1}`;
    const svgString = $.html(el);
    const svgBuffer = Buffer.from(svgString, "utf8");
    const dims = probeRasterDimensions(svgBuffer);
    images.push({
      url: `data:image/svg+xml;base64,${svgBuffer.toString("base64")}`,
      filename: `${safeName}.svg`,
      type: "svg",
      isInlineSvg: true,
      assetCategory: options.asIcons ? "icon" : void 0,
      bytes: svgBuffer.length,
      width: dims.width || void 0,
      height: dims.height || void 0,
      mimeType: "image/svg+xml"
    });
  });
};
var classifyAssetIconCandidate = (item) => {
  if (item?.assetCategory === "icon" || item?.isInlineSvg) return true;
  const url = String(item?.url || "").toLowerCase();
  if (/icon|favicon|sprite|glyph|logo-mark|brandmark|\/icons?\//i.test(url)) return true;
  if (/(?:^|[\/_\-.])(?:warning|alert|caution|info|water[_-]?drop|hub|allergic[_-]?reaction[_-]?hand)(?:[\/_\-.]|$)/i.test(url)) return true;
  if (/\.ico(?:\?|$)/i.test(url)) return true;
  const alt = String(item?.alt || "").toLowerCase();
  if (alt && /icon|logo|glyph|symbol/.test(alt)) return true;
  return false;
};
var extractIconsFromDom = ($, targetUrl) => {
  const icons = [];
  extractInlineSvgsFromDom($, icons, { asIcons: true });
  $("img").each((_, el) => {
    const cls = String($(el).attr("class") || "").toLowerCase();
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    if (!/icon|glyph|logo|symbol|avatar|badge/i.test(`${cls} ${src}`)) return;
    const alt = $(el).attr("alt") || void 0;
    const meta = alt ? { alt, assetCategory: "icon" } : { assetCategory: "icon" };
    LAZY_IMAGE_ATTRS.forEach((attr) => addImageCandidate(icons, $(el).attr(attr), targetUrl, meta, { permissive: true }));
    addImageCandidate(icons, src, targetUrl, meta, { permissive: true });
  });
  $('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"], link[rel="mask-icon"]').each((_, el) => {
    addImageCandidate(icons, $(el).attr("href"), targetUrl, { assetCategory: "icon" });
  });
  return icons;
};
var normalizeFontFamilyToken = (value) => String(value || "").split(",")[0].replace(/^['"]|['"]$/g, "").trim().toLowerCase();
var normalizeFontFamilyName = (value) => String(value || "").split(",")[0].replace(/^['"]|['"]$/g, "").trim();
var isGenericCssFontFamily = (value) => /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|emoji|math|fangsong)$/i.test(
  String(value || "").trim()
);
var getBrowserFontFamilies = (computedFonts = []) => Array.from(
  new Set(
    computedFonts.map((entry) => normalizeFontFamilyName(entry.family)).filter((family) => family && !isGenericCssFontFamily(family) && !isJunkFontLabel(family))
  )
);
var inferBrowserFontFamilyForRecord = (font, browserFamilies) => {
  if (browserFamilies.length === 0) return "";
  const current = normalizeFontFamilyName(String(font?.family || font?.title || font?.name || ""));
  if (current && !isJunkFontLabel(current) && !isGenericCssFontFamily(current)) return "";
  const cssSource = String(font?.cssSource || "");
  try {
    const parsed = new URL2(cssSource);
    if (/fonts\.googleapis\.com/i.test(parsed.hostname)) {
      const familyParams = parsed.searchParams.getAll("family");
      const families = familyParams.map((value) => value.split(":")[0].replace(/\+/g, " ").trim()).filter(Boolean);
      if (families.length === 1) return families[0];
    }
  } catch {
  }
  if (browserFamilies.length === 1) return browserFamilies[0];
  return "";
};
var applyBrowserFontFamilyEvidence = (fonts, computedFonts = []) => {
  const browserFamilies = getBrowserFontFamilies(computedFonts);
  if (browserFamilies.length === 0) return fonts;
  return fonts.map((font) => {
    const inferred = inferBrowserFontFamilyForRecord(font, browserFamilies);
    if (!inferred) return font;
    return {
      ...font,
      family: inferred,
      browserResolvedFamily: inferred
    };
  });
};
var filterFontsByComputedUsage = (fonts, computedFonts) => {
  if (!computedFonts.length) return fonts;
  const wanted = computedFonts.map((entry) => ({
    family: normalizeFontFamilyToken(entry.family),
    weight: String(entry.weight || "400").replace(/\D/g, "") || "400",
    style: String(entry.style || "normal").toLowerCase()
  }));
  return fonts.filter((font) => {
    if (String(font?.source || "") === "@font-face" || String(font?.cssSource || "")) return true;
    const family = normalizeFontFamilyToken(font?.family || "");
    if (!family || family === "inherit") return false;
    return wanted.some((entry) => {
      if (!family.includes(entry.family) && !entry.family.includes(family)) return false;
      const fontWeight = String(font?.weight || "400").replace(/\D/g, "") || "400";
      const fontStyle = String(font?.style || "normal").toLowerCase();
      if (entry.style !== "normal" && fontStyle !== entry.style) return false;
      if (entry.weight !== fontWeight && entry.weight !== "400" && fontWeight !== "400") return false;
      return true;
    });
  });
};
var extractImagesFromCss = (cssText, baseUrl) => {
  const images = [];
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
var extractImagesFromDom = ($, targetUrl, options = {}) => {
  const images = [];
  $("img").each((_, el) => {
    const alt = $(el).attr("alt") || void 0;
    const meta = alt ? { alt } : void 0;
    LAZY_IMAGE_ATTRS.forEach((attr) => addImageCandidate(images, $(el).attr(attr), targetUrl, meta, { permissive: true }));
    SRCSET_ATTRS.forEach((attr) => addSrcsetCandidates(images, $(el).attr(attr), targetUrl));
  });
  $('picture source, source[type^="image/"]').each((_, el) => {
    addImageCandidate(images, $(el).attr("src"), targetUrl, void 0, { permissive: true });
    SRCSET_ATTRS.forEach((attr) => addSrcsetCandidates(images, $(el).attr(attr), targetUrl));
  });
  $('input[type="image"]').each((_, el) => {
    addImageCandidate(images, $(el).attr("src"), targetUrl, void 0, { permissive: true });
  });
  if (!options.scoped) {
    const metaSelectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[itemprop="image"]',
      'meta[name="thumbnail"]'
    ];
    metaSelectors.forEach((selector) => {
      $(selector).each((_, el) => addImageCandidate(images, $(el).attr("content"), targetUrl));
    });
    $('link[rel="preload"][as="image"]').each((_, el) => {
      addImageCandidate(images, $(el).attr("href"), targetUrl);
    });
  }
  $("svg image").each((_, el) => {
    addImageCandidate(images, $(el).attr("href"), targetUrl, void 0, { permissive: true });
    addImageCandidate(images, $(el).attr("xlink:href"), targetUrl, void 0, { permissive: true });
  });
  $("svg use").each((_, el) => {
    const href = $(el).attr("href") || $(el).attr("xlink:href");
    if (href && !href.startsWith("#")) addImageCandidate(images, href, targetUrl, void 0, { permissive: true });
  });
  $('object[type^="image/"], embed[type^="image/"]').each((_, el) => {
    addImageCandidate(images, $(el).attr("data") || $(el).attr("src"), targetUrl, void 0, { permissive: true });
  });
  $("[data-src], [data-lazy-src], [data-original], [data-bg], [data-background-image], [data-image], [data-thumb]").each((_, el) => {
    const attrs = el?.attribs || {};
    Object.entries(attrs).forEach(([name, value]) => {
      if (!name.startsWith("data-") || !value) return;
      const lowerName = name.toLowerCase();
      if (/image|img|photo|thumb|poster|bg|background|src|lazy|icon|avatar|banner|hero/i.test(lowerName)) {
        if (String(value).includes(",") && /\d+w|\d+x/.test(String(value))) {
          addSrcsetCandidates(images, String(value), targetUrl);
        } else {
          addImageCandidate(images, String(value), targetUrl, void 0, { permissive: true });
        }
      }
    });
  });
  $("style").each((_, el) => {
    const cssText = $(el).html();
    if (cssText) images.push(...extractImagesFromCss(cssText, targetUrl));
  });
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (style) images.push(...extractImagesFromCss(style, targetUrl));
  });
  if (!options.scoped && !shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) {
    images.push(...extractImageSequencesFromText($.html() || "", targetUrl));
  }
  if (!options.scoped) extractInlineSvgsFromDom($, images);
  return images;
};
var extractImagesFromHtmlString = (html, targetUrl) => {
  const images = [];
  const searchText = html.replace(/\\/g, "").replace(/&amp;/g, "&");
  const absoluteRegex = /https?:\/\/[^"'<>\s\\)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'<>\s\\)]*)?(?:\?[^"'<>\s\\)]*)?/gi;
  (searchText.match(absoluteRegex) || []).slice(0, 200).forEach((raw) => addImageCandidate(images, raw, targetUrl));
  const wpUploadsRegex = /(?:https?:\/\/[^"'<>\s]+)?\/wp-content\/uploads\/[^"'<>\s)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'<>\s)]*)?(?:\?[^"'<>\s)]*)?/gi;
  (searchText.match(wpUploadsRegex) || []).slice(0, 200).forEach((raw) => addImageCandidate(images, raw, targetUrl));
  const commerceMediasRegex = /(?:https?:\/\/[^"'<>\s]+)?\/medias\/[^"'<>\s)]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:\/[^"'<>\s)]*)?(?:\?[^"'<>\s)]*)?/gi;
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
var isVimeoUrl = (url) => {
  try {
    const hostname = new URL2(url).hostname.replace(/^www\./, "");
    return hostname === "vimeo.com" || hostname.endsWith(".vimeo.com");
  } catch {
    return false;
  }
};
var isYouTubeUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  } catch {
    return false;
  }
};
var isBrightcoveUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "players.brightcove.net" || host.endsWith(".players.brightcove.net");
  } catch {
    return false;
  }
};
var isIspotUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "ispot.tv" || host.endsWith(".ispot.tv");
  } catch {
    return false;
  }
};
var parseBrightcovePlayerUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "players.brightcove.net" && !host.endsWith(".players.brightcove.net")) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const accountId = segments[0] || "";
    const playerPath = segments[1] || "default";
    const playerId = playerPath.replace(/_default$/i, "") || "default";
    const videoId = parsed.searchParams.get("videoId") || parsed.searchParams.get("video_id") || parsed.searchParams.get("bctid") || parsed.hash.match(/(?:videoId|bctid)=(\d+)/i)?.[1] || "";
    if (!accountId || !videoId) return null;
    return { accountId, playerId, videoId };
  } catch {
    return null;
  }
};
var isUnsupportedVideoResourceUrl = (rawUrl) => {
  const value = String(rawUrl || "").trim().toLowerCase();
  if (!value) return true;
  if (value.startsWith("data:") || value.startsWith("blob:")) return true;
  if (/\.(?:js|mjs|css|json|webmanifest|map|xml|txt|ico|svg|png|jpe?g|gif|webp|avif)(?:[?#@]|$)/i.test(value)) return true;
  if (isWistiaHelperResourceUrl(value)) return true;
  try {
    const parsed = new URL2(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path4 = parsed.pathname.toLowerCase();
    if ((host === "youtube.com" || host.endsWith(".youtube.com")) && (path4 === "/iframe_api" || path4.includes("/www-widgetapi") || path4.startsWith("/s/player/") || path4.startsWith("/youtubei/") || path4.startsWith("/api/"))) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};
var isPlaylistUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path4 = parsed.pathname.toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      return Boolean(parsed.searchParams.get("list")) || path4.includes("/playlist");
    }
    if (host.includes("vimeo.com")) return /\/(?:showcase|album|channels|groups)\//.test(path4);
    if (host.includes("facebook.com")) return /\/(?:watch|playlist|videos)\//.test(path4) && Boolean(parsed.searchParams.get("vlist") || parsed.searchParams.get("playlist_id"));
    if (host === "x.com" || host.includes("twitter.com")) return /\/status(?:es)?\//.test(path4) && /\/\d+(?:\/(?:photo|video)\/\d+)?$/i.test(path4);
    if (isBrightcoveUrl(rawUrl)) return Boolean(parsed.searchParams.get("playlistId") || parsed.searchParams.get("playlist_id"));
    return false;
  } catch {
    return false;
  }
};
var isYouTubeShortsUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return false;
    return /\/shorts\//i.test(parsed.pathname);
  } catch {
    return /youtube\.com\/shorts\//i.test(String(rawUrl || ""));
  }
};
var normalizeYouTubeWatchUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const videoId = parsed.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      const embedMatch = parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (embedMatch?.[1]) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};
var YOUTUBE_METADATA_TIMEOUT_MS = 2e4;
var YOUTUBE_FORMATS_TIMEOUT_MS = 3e4;
var YOUTUBE_MERGE_TIMEOUT_MS = 18e4;
var fetchYouTubeOEmbedTitle = async (watchUrl) => {
  try {
    const normalized = normalizeYouTubeWatchUrl(watchUrl);
    const videoId = new URL2(normalized).searchParams.get("v") || "";
    if (!videoId) return "";
    const response = await axios.get("https://www.youtube.com/oembed", {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: "json" },
      timeout: YOUTUBE_METADATA_TIMEOUT_MS,
      validateStatus: (status) => status === 200
    });
    return String(response.data?.title || "").trim();
  } catch {
    return "";
  }
};
var isCopyableStreamMediaUrl = (rawUrl) => {
  const candidate = String(rawUrl || "").trim();
  if (!candidate) return false;
  if (isYouTubeUrl(candidate) && !isGoogleVideoPlaybackUrl(candidate)) return false;
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\/api\/(?:youtube-merged-stream|download)(?:\?|$)/i.test(candidate)) return false;
  if (isGoogleVideoPlaybackUrl(candidate)) return true;
  if (/^~?\//.test(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) return true;
  if (/^https?:\/\//i.test(candidate) && !isYouTubeUrl(candidate)) return true;
  return false;
};
var pickVariantMediaUrl = (variant) => {
  const candidates = [
    variant?.mediaUrl,
    variant?.copyUrl,
    variant?.directStreamUrl,
    variant?.localPath,
    variant?.downloadPath
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (isCopyableStreamMediaUrl(value)) return value;
  }
  return "";
};
var extractYouTubeUrlsFromText = (text, baseUrl) => {
  const urls = /* @__PURE__ */ new Set();
  const normalizedText = text.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const youtubeUrlRegex = /(?:https?:)?\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^"'<>\\\s]*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})[^"'<>\\\s]*/gi;
  let match;
  while ((match = youtubeUrlRegex.exec(normalizedText)) !== null) {
    const raw = match[0].startsWith("//") ? `https:${match[0]}` : match[0];
    urls.add(normalizeYouTubeWatchUrl(raw));
  }
  const iframeRegex = /<iframe[^>]+src=["']([^"']*(?:youtube\.com|youtu\.be)[^"']+)["']/gi;
  while ((match = iframeRegex.exec(normalizedText)) !== null) {
    const resolved = resolveUrl(baseUrl, match[1]);
    if (resolved) urls.add(normalizeYouTubeWatchUrl(resolved));
  }
  return Array.from(urls);
};
var normalizeVimeoUrl = (url) => {
  try {
    const parsed = new URL2(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const match = parsed.pathname.match(/\/video\/(\d+)/) || parsed.pathname.match(/\/videos\/(\d+)/) || parsed.pathname.match(/\/progressive_redirect\/(?:download|playback)\/(\d+)/) || parsed.pathname.match(/^\/(\d+)/);
    if (match) {
      const privacyHash = parsed.pathname.match(/\/(?:video\/)?\d+\/([a-z0-9]+)(?:\/|$)/i)?.[1] || parsed.searchParams.get("h") || "";
      return `https://vimeo.com/${match[1]}${privacyHash ? `/${privacyHash}` : ""}`;
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      const cleanedPath = parsed.pathname.replace(/\/+$/, "");
      if (/\.(ico|js|css|json)$/i.test(cleanedPath)) return null;
      if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/i.test(cleanedPath)) return null;
      if (cleanedPath && cleanedPath !== "/") {
        return `https://vimeo.com${cleanedPath}`;
      }
    }
    return null;
  } catch {
    return null;
  }
};
var extractVimeoUrlsFromText = (text, baseUrl) => {
  const urls = /* @__PURE__ */ new Set();
  const normalizedText = text.replace(/\\\//g, "/").replace(/&amp;amp;/gi, "&").replace(/&amp;/gi, "&").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'");
  const absoluteUrlRegex = /(?:https?:)?\/\/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/)?(\d+)/gi;
  let match;
  while ((match = absoluteUrlRegex.exec(normalizedText)) !== null) {
    urls.add(`https://vimeo.com/${match[1]}`);
  }
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
    const decoded = match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
    extractVimeoUrlsFromText(decoded, baseUrl).forEach((entry) => urls.add(entry));
    const encodedIframeRegex = /player\.vimeo\.com\/video\/(\d{6,})/gi;
    let encodedMatch;
    while ((encodedMatch = encodedIframeRegex.exec(match[1])) !== null) {
      urls.add(`https://vimeo.com/${encodedMatch[1]}`);
    }
  }
  return Array.from(urls);
};
var extractDrupalVideoEmbedTitles = (text) => {
  const titlesById = /* @__PURE__ */ new Map();
  const modalRegex = /data-video-embed-field-modal=["']([\s\S]*?)["']/gi;
  let match;
  while ((match = modalRegex.exec(text)) !== null) {
    const chunk = match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
    const iframeRegex = /player\.vimeo\.com\/video\/(\d{6,})/gi;
    let iframeMatch;
    while ((iframeMatch = iframeRegex.exec(chunk)) !== null) {
      const titleMatch = chunk.match(/modal-video-title[^>]*>([^<]+)/i) || chunk.match(/title=["']([^"']+)["']/i);
      const title = String(titleMatch?.[1] || "").trim();
      if (title) titlesById.set(iframeMatch[1], title);
    }
  }
  return titlesById;
};
var buildWebsiteVideoPlayersFromHtml = (html, pageUrl) => {
  const titlesById = extractDrupalVideoEmbedTitles(html);
  const vimeoUrls = dedupeVimeoUrlsById(extractVimeoUrlsFromText(html, pageUrl));
  return vimeoUrls.map((vimeoUrl) => {
    const vimeoId = parseVimeoIdFromUrl(vimeoUrl) || getVimeoIdFromVideoRecord({ url: vimeoUrl });
    const title = vimeoId && titlesById.get(vimeoId) || "Vimeo video";
    return {
      url: vimeoUrl,
      sourceUrl: pageUrl,
      pageUrl,
      provider: "vimeo",
      isVimeo: true,
      type: "vimeo",
      title,
      vimeoId,
      thumbnail: vimeoId ? resolveUrl(pageUrl, `/sites/default/files/video_thumbnails/${vimeoId}.jpg`) : ""
    };
  });
};
var getVimeoIdFromVideoRecord = (video) => {
  const candidates = [
    video?.vimeoId,
    video?.sourceUrl,
    video?.pageUrl,
    video?.originalUrl,
    video?.url
  ];
  for (const raw of candidates) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const normalized = normalizeVimeoUrl(value);
    if (normalized) {
      const idMatch = normalized.match(/vimeo\.com\/(\d+)/);
      if (idMatch?.[1]) return idMatch[1];
    }
    const directMatch = value.match(/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/|progressive_redirect\/download\/)(\d+)/i);
    if (directMatch?.[1]) return directMatch[1];
  }
  return "";
};
var dedupeVimeoUrlsById = (vimeoUrls) => {
  const byId = /* @__PURE__ */ new Map();
  for (const raw of vimeoUrls) {
    const id = getVimeoIdFromVideoRecord({ url: raw, sourceUrl: raw });
    if (!id) continue;
    const normalized = normalizeVimeoUrl(raw) || `https://vimeo.com/${id}`;
    const existing = byId.get(id) || "";
    const includesPrivacyHash = new RegExp(`vimeo\\.com/${id}/[a-z0-9]+`, "i").test(normalized);
    if (!existing || includesPrivacyHash) byId.set(id, normalized);
  }
  return Array.from(byId.values());
};
var getEffectiveVideoPixels = (candidateOrHeight, width) => {
  if (candidateOrHeight && typeof candidateOrHeight === "object") {
    const height2 = parseCandidateHeight(candidateOrHeight) || 0;
    const candidateWidth2 = parseCandidateWidth(candidateOrHeight) || 0;
    return Math.max(height2, candidateWidth2);
  }
  const height = Number(candidateOrHeight) || 0;
  const candidateWidth = Number(width) || 0;
  return Math.max(height, candidateWidth);
};
var vimeoQualityBucketFromHeight = (height, width = 0) => {
  const effective = Math.max(height, width);
  if (!Number.isFinite(effective) || effective <= 0) return null;
  if (effective >= 1080) return "fhd";
  if (effective >= 720) return "hd";
  return null;
};
var collapseVimeoVideosForClient = (videos) => {
  const vimeoGroups = /* @__PURE__ */ new Map();
  const others = [];
  for (const video of Array.isArray(videos) ? videos : []) {
    if (!video?.url) continue;
    const provider = String(video?.provider || "").toLowerCase();
    const isVimeo = provider.includes("vimeo") || video?.isVimeo || video?.isVimeoDirect || /vimeo\.com/i.test(String(video?.url || "")) || /vimeo\.com/i.test(String(video?.sourceUrl || ""));
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
  const collapsed = [...others];
  for (const [vimeoId, group] of vimeoGroups.entries()) {
    const directStreams = group.filter((video) => video?.isVimeoDirect && video?.url);
    if (directStreams.length === 0) {
      const placeholder = group.find((video) => video?.url && (video?.isVimeo || /vimeo\.com/i.test(String(video?.url || "")))) || group.find((video) => video?.url) || group[0];
      if (placeholder) {
        collapsed.push({
          ...placeholder,
          vimeoId,
          sourceUrl: placeholder.sourceUrl || `https://vimeo.com/${vimeoId}`,
          sourceStreamUrl: placeholder.sourceStreamUrl || placeholder.url,
          defaultQualityKey: placeholder.defaultQualityKey || "fhd",
          displayQualityKey: placeholder.displayQualityKey || "fhd",
          displayQualityLabel: placeholder.displayQualityLabel || getCleanQualityLabel("fhd"),
          qualityRequested: placeholder.qualityRequested || "fhd",
          streamsPrepared: Boolean(placeholder.streamsPrepared)
        });
      }
      continue;
    }
    const variants = {};
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
        streamsPrepared: true
      };
      const current = variants[bucket];
      const currentHeight = current ? parseCandidateHeight(current) || Number(current.height || 0) : 0;
      if (!current || height > currentHeight) variants[bucket] = normalized;
    }
    const defaultQualityKey = variants.fhd ? "fhd" : variants.hd ? "hd" : null;
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
        defaultQualityKey: getCleanQualityKey(best)
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
      vimeoQualityDebug: primary?.vimeoQualityDebug || group.find((video) => video?.vimeoQualityDebug)?.vimeoQualityDebug
    });
  }
  return collapsed;
};
var isUstudioUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "embed.ustudio.com" || host.endsWith(".ustudio.com");
  } catch {
    return false;
  }
};
var extractUstudioEmbedUrlsFromText = (text, baseUrl) => {
  const urls = /* @__PURE__ */ new Set();
  const normalized = String(text || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const pattern = /(?:https?:)?\\?\/\\?\/embed\.ustudio\.com\\?\/embed\\?\/([a-z0-9_-]+)\\?\/([a-z0-9_-]+)/gi;
  let match;
  while ((match = pattern.exec(normalized)) !== null) {
    const embedUrl = `https://embed.ustudio.com/embed/${match[1]}/${match[2]}`;
    urls.add(embedUrl);
  }
  normalized.match(/https?:\/\/embed\.ustudio\.com\/embed\/[^\s"'<>]+/gi)?.forEach((raw) => {
    const absolute = sanitizeStreamUrl(raw, baseUrl);
    if (absolute) urls.add(absolute);
  });
  return Array.from(urls);
};
var extractUstudioVideos = async (embedUrls) => {
  const uniqueUrls = Array.from(new Set(embedUrls.filter(isUstudioUrl))).slice(0, 12);
  const results = await mapWithConcurrency(uniqueUrls, 3, async (embedUrl) => {
    try {
      const response = await withTimeout(
        axios.get(embedUrl, {
          timeout: 12e3,
          httpsAgent: relaxedHttpsAgent,
          headers: browserLikeHeaders(embedUrl)
        }),
        12e3,
        `Ustudio configuration for ${embedUrl}`
      );
      const html = String(response.data || "");
      const encoded = html.match(/ConfigurationLoaderNamespace\.load\(window,\s*["']([^"']+)["']/i)?.[1];
      if (!encoded) throw new Error("Ustudio player configuration was not found.");
      const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const video = Array.isArray(config?.videos) ? config.videos[0] : null;
      if (!video) throw new Error("Ustudio player did not provide a video.");
      const title = String(video.name || "Ustudio video").trim() || "Ustudio video";
      const thumbnail = String((Array.isArray(video.images) ? video.images : []).find((image) => image?.image_url)?.image_url || "");
      const mp4s = Array.isArray(video?.transcodes?.mp4) ? video.transcodes.mp4 : [];
      const streams = mp4s.filter((stream) => stream?.url && /^https?:\/\//i.test(String(stream.url))).sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
      if (streams.length === 0) throw new Error("Ustudio player did not provide a progressive MP4 stream.");
      return streams.map((stream) => ({
        url: String(stream.url),
        sourceUrl: embedUrl,
        provider: "ustudio",
        isUstudioDirect: true,
        isDirect: true,
        type: "mp4",
        title,
        thumbnail,
        width: Number(stream.width || 0) || void 0,
        height: Number(stream.height || 0) || void 0,
        resolution: stream.height ? `${stream.height}p` : "MP4",
        duration: Number(video.duration || 0) || void 0,
        hasAudio: true,
        audioAvailable: true
      }));
    } catch (error) {
      console.warn(`Ustudio extraction failed for ${embedUrl}:`, error?.message || error);
      return [{
        url: embedUrl,
        sourceUrl: embedUrl,
        provider: "ustudio",
        isUstudio: true,
        type: "video",
        title: "Ustudio video"
      }];
    }
  });
  return results.flat();
};
var buildWistiaEmbedUrl = (hashedId) => `https://fast.wistia.com/embed/medias/${hashedId}`;
var isWistiaSwatchUrl = (rawUrl = "") => {
  try {
    const parsed = new URL2(String(rawUrl || ""));
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return (host.includes("wistia.com") || host.includes("wistia.net")) && /\/embed\/medias\/[a-z0-9]{8,12}\/swatch\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
};
var isWistiaHelperResourceUrl = (rawUrl = "") => {
  try {
    const parsed = new URL2(String(rawUrl || ""));
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.includes("wistia.com") && !host.includes("wistia.net")) return false;
    const path4 = parsed.pathname.toLowerCase();
    if (isWistiaSwatchUrl(parsed.href)) return true;
    if (/\/assets\/external\/(?:publicapi|captions|interfontface|playpauseloadingcontrol|hls_video|x)(?:\.js)?(?:@|\/|$)/i.test(path4)) {
      return true;
    }
    if (/\/(?:mput|jsonp|iframe_shim)(?:\/|$)/i.test(path4)) return true;
    return /\/embed\/medias\/[a-z0-9]{8,12}\/(?:swatch|seo|jsonp)(?:\/|$)/i.test(path4);
  } catch {
    return false;
  }
};
var extractWistiaIdsFromText = (text, baseUrl) => {
  const ids = /* @__PURE__ */ new Set();
  const normalizedText = text.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const addId = (value) => {
    const id = String(value || "").trim().toLowerCase();
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
var buildBrightcovePlayerUrl = (accountId, playerId, videoId) => {
  const account = String(accountId || "").trim();
  const player = String(playerId || "default").trim() || "default";
  const video = String(videoId || "").trim();
  if (!account || !video) return "";
  const normalizedPlayer = player.endsWith("_default") ? player : `${player}_default`;
  return `https://players.brightcove.net/${account}/${normalizedPlayer}/index.html?videoId=${video}`;
};
var extractBrightcoveVideosFromHtml = (htmlText, baseUrl) => {
  const videos = [];
  const seen = /* @__PURE__ */ new Set();
  const normalizedText = htmlText.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const add = (input) => {
    const url = String(input?.url || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    videos.push(input);
  };
  try {
    const $ = cheerio.load(htmlText);
    $("gb-video-brightcove, [data-video-id][data-account-id], [data-bc-video-id][data-account-id]").each((_, el) => {
      const accountId = $(el).attr("data-account-id") || $(el).attr("account-id") || "";
      const playerId = $(el).attr("data-player-id") || $(el).attr("player-id") || "default";
      const videoId = $(el).attr("data-video-id") || $(el).attr("data-bc-video-id") || $(el).attr("video-id") || "";
      const url = buildBrightcovePlayerUrl(accountId, playerId, videoId);
      if (!url) return;
      const title = $(el).find(".video-info-title").first().text().trim() || $(el).attr("aria-label") || $(el).attr("title") || "Brightcove video";
      const poster = $(el).find("img[src]").first().attr("src") || $(el).find("source[srcset]").first().attr("srcset")?.split(",").pop()?.trim().split(/\s+/)[0] || "";
      add({
        url,
        sourceUrl: baseUrl,
        provider: "brightcove",
        type: "video",
        title,
        thumbnail: poster ? resolveUrl(baseUrl, poster) || poster : "",
        brightcoveAccountId: accountId,
        brightcovePlayerId: playerId,
        brightcoveVideoId: videoId
      });
    });
  } catch {
  }
  const tagRegex = /<gb-video-brightcove\b[\s\S]*?<\/gb-video-brightcove>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(normalizedText)) !== null) {
    const tag = tagMatch[0];
    const accountId = tag.match(/data-account-id=["']([^"']+)["']/i)?.[1] || "";
    const playerId = tag.match(/data-player-id=["']([^"']+)["']/i)?.[1] || "default";
    const videoId = tag.match(/data-video-id=["']([^"']+)["']/i)?.[1] || "";
    const url = buildBrightcovePlayerUrl(accountId, playerId, videoId);
    if (!url) continue;
    const title = tag.match(/class=["'][^"']*video-info-title[^"']*["'][^>]*>([^<]+)/i)?.[1]?.trim() || "Brightcove video";
    const poster = tag.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || "";
    add({
      url,
      sourceUrl: baseUrl,
      provider: "brightcove",
      type: "video",
      title,
      thumbnail: poster ? resolveUrl(baseUrl, poster) || poster : "",
      brightcoveAccountId: accountId,
      brightcovePlayerId: playerId,
      brightcoveVideoId: videoId
    });
  }
  const playerUrlRegex = /https?:\/\/players\.brightcove\.net\/(\d+)\/([^"'<>\\\s]+?)\/index\.html\?[^"'<>\\\s]*?videoId=(\d+)/gi;
  let playerMatch;
  while ((playerMatch = playerUrlRegex.exec(normalizedText)) !== null) {
    add({
      url: playerMatch[0],
      sourceUrl: baseUrl,
      provider: "brightcove",
      type: "video",
      title: "Brightcove video",
      brightcoveAccountId: playerMatch[1],
      brightcovePlayerId: playerMatch[2],
      brightcoveVideoId: playerMatch[3]
    });
  }
  const jsonBcRegex = /"(?:accountId|account_id)"\s*:\s*"(\d+)"[\s\S]{0,320}?"(?:videoId|video_id|id)"\s*:\s*"(\d+)"/gi;
  let jsonMatch;
  while ((jsonMatch = jsonBcRegex.exec(normalizedText)) !== null) {
    const url = buildBrightcovePlayerUrl(jsonMatch[1], "default", jsonMatch[2]);
    if (url) {
      add({
        url,
        sourceUrl: baseUrl,
        provider: "brightcove",
        type: "video",
        title: "Brightcove video",
        brightcoveAccountId: jsonMatch[1],
        brightcovePlayerId: "default",
        brightcoveVideoId: jsonMatch[2]
      });
    }
  }
  return videos;
};
var discoverSiteVideoCandidates = async (siteUrl, initialHtml) => {
  const vimeoUrls = /* @__PURE__ */ new Set();
  const wistiaIds = /* @__PURE__ */ new Set();
  const videoUrls = /* @__PURE__ */ new Set();
  const brightcoveVideos = /* @__PURE__ */ new Map();
  const visited = /* @__PURE__ */ new Set();
  const queue = [{ url: siteUrl, depth: 0, html: initialHtml }];
  const maxPages = 10;
  const maxDepth = 2;
  const normalizedSite = new URL2(siteUrl);
  const sameOrigin = (candidate) => {
    try {
      const parsed = new URL2(candidate);
      return parsed.hostname.replace(/^www\./, "") === normalizedSite.hostname.replace(/^www\./, "");
    } catch {
      return false;
    }
  };
  const normalizePageUrl = (candidate) => {
    try {
      const parsed = new URL2(candidate);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return "";
    }
  };
  const addVideoUrlsFromHtml = (htmlText, baseUrl) => {
    extractVimeoUrlsFromText(htmlText, baseUrl).forEach((vimeoUrl) => vimeoUrls.add(vimeoUrl));
    extractWistiaIdsFromText(htmlText, baseUrl).forEach((wistiaId) => wistiaIds.add(wistiaId));
    extractBrightcoveVideosFromHtml(htmlText, baseUrl).forEach((video) => {
      if (video?.url) brightcoveVideos.set(video.url, video);
    });
    const normalizeDiscoveredVideoUrl = (value) => {
      const trimmed = String(value || "").trim();
      if (!trimmed) return "";
      return trimmed.replace(/ /g, "%20");
    };
    const normalizedText = htmlText.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const absoluteVideoRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#\s"'<>\\])(?:[?#][^\s"'<>\\]*)?/gi;
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
    const current = queue.shift();
    const pageUrl = normalizePageUrl(current.url);
    if (!pageUrl || visited.has(pageUrl) || !sameOrigin(pageUrl)) continue;
    visited.add(pageUrl);
    let htmlText = current.html || "";
    if (!htmlText) {
      try {
        const response = await axios.get(pageUrl, {
          timeout: 7e3,
          httpsAgent: relaxedHttpsAgent,
          responseType: "text",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml"
          }
        });
        htmlText = String(response.data || "");
      } catch {
        continue;
      }
    }
    addVideoUrlsFromHtml(htmlText, pageUrl);
    if (current.depth >= maxDepth) continue;
    const $ = cheerio.load(htmlText);
    const links = [];
    $("a[href], area[href]").each((_, el) => {
      const href = $(el).attr("href");
      const absolute = href ? resolveUrl(pageUrl, href) : null;
      if (!absolute || !sameOrigin(absolute)) return;
      if (/\.(pdf|jpg|jpeg|png|webp|svg|gif|zip|docx?|xlsx?)(\?|$)/i.test(absolute)) return;
      links.push(normalizePageUrl(absolute));
    });
    const scored = Array.from(new Set(links)).filter((link) => link && !visited.has(link)).sort((a, b) => {
      const score = (value) => /video|webinar|media|resource|education|event|watch|learn|patient|hcp|news/i.test(value) ? 0 : 1;
      return score(a) - score(b) || a.length - b.length;
    }).slice(0, 10);
    scored.forEach((link) => queue.push({ url: link, depth: current.depth + 1 }));
  }
  return {
    vimeoUrls: Array.from(vimeoUrls),
    wistiaIds: Array.from(wistiaIds),
    videoUrls: Array.from(videoUrls),
    brightcoveVideos: Array.from(brightcoveVideos.values()),
    visitedUrls: Array.from(visited)
  };
};
var withTimeout = async (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
var mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
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
var fontOutputToBuffer = (output) => {
  if (Buffer.isBuffer(output)) return output;
  if (typeof output === "string") return Buffer.from(output);
  if (output instanceof ArrayBuffer) return Buffer.from(new Uint8Array(output));
  if (ArrayBuffer.isView(output)) return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  return Buffer.from(output);
};
var bufferToExactArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
var assetCacheKey = (url, suffix = "") => crypto2.createHash("sha1").update(`${url}::${suffix}`).digest("hex");
var browserLikeHeaders = (targetUrl, refererPage = "") => {
  const origin = (() => {
    try {
      return new URL2(targetUrl).origin;
    } catch {
      return "";
    }
  })();
  const referer = String(refererPage || "").trim() || (origin ? `${origin}/` : "");
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    ...referer ? { Referer: referer, ...origin ? { Origin: origin } : {} } : {}
  };
};
var isLikelyFontAssetUrl = (url) => /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(String(url || ""));
var imageAcceptHeaderForUrl = (url) => {
  const value = String(url || "").toLowerCase();
  if (/[?&]fmt=(?:png|png-alpha)(?:&|$)/i.test(value) || /\.png(?:[?#]|$)/i.test(value)) {
    return "image/png,image/apng,image/*,*/*;q=0.8";
  }
  if (/[?&]fmt=jpe?g(?:&|$)/i.test(value) || /\.jpe?g(?:[?#]|$)/i.test(value)) {
    return "image/jpeg,image/*,*/*;q=0.8";
  }
  if (/[?&]fmt=webp(?:&|$)/i.test(value) || /\.webp(?:[?#]|$)/i.test(value)) {
    return "image/webp,image/*,*/*;q=0.8";
  }
  return "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
};
var isValidFontOriginalBuffer = (buffer, contentType = "") => {
  if (!buffer || buffer.length < 128) return false;
  if (/text\/html|application\/json|text\/plain/i.test(String(contentType || ""))) return false;
  const head = buffer.slice(0, 96).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<") && !head.startsWith("<svg")) {
    return false;
  }
  return Boolean(detectFontFormatFromBuffer(buffer));
};
var fetchRemoteFontBufferViaCurl = async (url, refererPage = "") => {
  const pageReferer = String(refererPage || "").trim() || (() => {
    try {
      return `${new URL2(url).origin}/`;
    } catch {
      return "";
    }
  })();
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const args = [
        "-sL",
        "--max-time",
        "25",
        "-A",
        userAgent,
        "-H",
        "Accept: font/woff2,font/woff,font/ttf,application/font-woff2,application/font-woff,*/*;q=0.8",
        ...pageReferer ? ["-H", `Referer: ${pageReferer}`] : [],
        url
      ];
      const { stdout } = await execFileAsync2("curl", args, { maxBuffer: 10 * 1024 * 1024 });
      const buffer = Buffer.from(stdout);
      const contentType = guessContentTypeFromPath(url);
      if (isValidFontOriginalBuffer(buffer, contentType)) {
        return { buffer, contentType };
      }
    } catch {
    }
  }
  return null;
};
var fontFetchSiblingUrls = (url) => {
  const siblings = /* @__PURE__ */ new Set();
  const add = (candidate) => {
    const normalized = String(candidate || "").trim();
    if (normalized && normalized !== url) siblings.add(normalized);
  };
  add(url.replace(/-woff2\.woff2(\?.*)?$/i, "-ttf.ttf$1"));
  add(url.replace(/-woff2\.woff2(\?.*)?$/i, "-woff.woff$1"));
  add(url.replace(/-woff\.woff(\?.*)?$/i, "-ttf.ttf$1"));
  add(url.replace(/-woff\.woff(\?.*)?$/i, "-woff2.woff2$1"));
  add(url.replace(/-ttf\.ttf(\?.*)?$/i, "-woff2.woff2$1"));
  add(url.replace(/-ttf\.ttf(\?.*)?$/i, "-woff.woff$1"));
  add(url.replace(/\.woff2(\?.*)?$/i, ".ttf$1"));
  add(url.replace(/\.woff2(\?.*)?$/i, ".woff$1"));
  add(url.replace(/\.woff(\?.*)?$/i, ".ttf$1"));
  add(url.replace(/\.woff(\?.*)?$/i, ".woff2$1"));
  add(url.replace(/\.ttf(\?.*)?$/i, ".woff2$1"));
  add(url.replace(/\.ttf(\?.*)?$/i, ".woff$1"));
  add(url.replace(/\/([^/]+)\/\1\.ttf(\?.*)?$/i, "/$1/$1-woff2.woff2$2"));
  add(url.replace(/\/([^/]+)\/\1-woff2\.woff2(\?.*)?$/i, "/$1/$1.ttf$2"));
  add(url.replace(/\/([^/]+)\/\1\.ttf(\?.*)?$/i, "/$1/$1-woff.woff$2"));
  add(url.replace(/\/([^/]+)\/\1-woff\.woff(\?.*)?$/i, "/$1/$1.ttf$2"));
  add(url.replace(/\/([^/]+)\/\1-woff2\.woff2(\?.*)?$/i, "/$1/$1-woff.woff$2"));
  return Array.from(siblings);
};
var resolveFontRefererPage = (cssSource = "", pageUrl = "") => {
  const page = String(pageUrl || "").trim();
  if (page.startsWith("http") && !isLikelyFontAssetUrl(page)) return page;
  const css = String(cssSource || "").trim();
  if (css.startsWith("http") && !isLikelyFontAssetUrl(css)) {
    try {
      return `${new URL2(css).origin}/`;
    } catch {
      return css;
    }
  }
  return page || css;
};
var fetchRemoteFontBufferViaBrowser = async (url, refererPage = "") => {
  let browser = null;
  try {
    browser = await launchPuppeteerBrowser(activeExtractionProxyUrl);
    const page = await acquireSingleWebsitePage(browser);
    await applyProxyAuthToPage(page);
    await applyPuppeteerStealth(page);
    const landing = String(refererPage || "").trim() || (() => {
      try {
        return `${new URL2(url).origin}/`;
      } catch {
        return "";
      }
    })();
    if (landing) {
      await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 45e3 }).catch(() => void 0);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const candidates = [url, ...fontFetchSiblingUrls(url)];
    for (const candidate of candidates) {
      try {
        const fetched = await page.evaluate(async (fontUrl) => {
          const response = await fetch(fontUrl, { credentials: "include", cache: "force-cache" });
          if (!response.ok) return null;
          const contentType2 = response.headers.get("content-type") || "";
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length < 128) return null;
          return { contentType: contentType2, bytes: Array.from(bytes) };
        }, candidate);
        if (!fetched?.bytes?.length) continue;
        const buffer = Buffer.from(fetched.bytes);
        const contentType = String(fetched.contentType || guessContentTypeFromPath(candidate));
        if (isValidFontOriginalBuffer(buffer, contentType)) {
          return { buffer, contentType, sourceUrl: candidate };
        }
      } catch {
      }
    }
    for (const candidate of candidates) {
      const response = await page.goto(candidate, { waitUntil: "networkidle2", timeout: 3e4 }).catch(() => null);
      if (!response || response.status() < 200 || response.status() >= 400) continue;
      const buffer = Buffer.from(await response.buffer());
      const contentType = String(response.headers()["content-type"] || response.headers()["Content-Type"] || "");
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
var tryFetchRemoteFontBuffer = async (url, refererPage = "") => {
  const candidates = [url, ...fontFetchSiblingUrls(url)];
  for (const candidate of candidates) {
    const pageReferer = String(refererPage || "").trim() || (() => {
      try {
        return `${new URL2(candidate).origin}/`;
      } catch {
        return "";
      }
    })();
    try {
      const response = await axios.get(candidate, {
        responseType: "arraybuffer",
        timeout: 2e4,
        maxRedirects: 5,
        httpsAgent: relaxedHttpsAgent,
        validateStatus: (status) => status >= 200 && status < 300,
        headers: browserLikeHeaders(candidate, pageReferer)
      });
      const buffer = Buffer.from(response.data);
      const contentType = String(response.headers["content-type"] || "");
      if (isValidFontOriginalBuffer(buffer, contentType)) {
        return {
          buffer,
          contentType,
          contentDisposition: String(response.headers["content-disposition"] || ""),
          sourceUrl: candidate
        };
      }
    } catch {
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
var fetchRemoteFontBuffer = async (url, refererPage = "") => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  assertPublicAssetUrl(normalized);
  const fetched = await tryFetchRemoteFontBuffer(normalized, refererPage);
  if (fetched) return fetched;
  throw new Error(`Failed to fetch a valid font from ${normalized}`);
};
var fetchRemoteAssetBuffer = async (url) => {
  assertPublicAssetUrl(url);
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 2e4,
    httpsAgent: relaxedHttpsAgent,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: browserLikeHeaders(url)
  });
  return {
    buffer: Buffer.from(response.data),
    contentType: String(response.headers["content-type"] || "")
  };
};
var getLocalCachedAssetPath = (rawUrl) => {
  try {
    let pathname = "";
    const value = String(rawUrl || "").trim();
    if (value.startsWith("/cached-images-original/") || value.startsWith("/cached-fonts-original/")) {
      pathname = value;
    } else {
      const parsed = new URL2(value);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return null;
      pathname = decodeURIComponent(parsed.pathname || "");
    }
    const allowedPrefixes = ["/cached-images-original/", "/cached-fonts-original/"];
    if (!allowedPrefixes.some((prefix) => pathname.startsWith(prefix))) return null;
    const relative = pathname.replace(/^\/+/, "");
    if (relative.includes("..")) return null;
    if (pathname.startsWith("/cached-images-original/")) {
      return path3.join(cachedImageOriginalDir, relative.replace(/^cached-images-original\//, ""));
    }
    if (pathname.startsWith("/cached-fonts-original/")) {
      return path3.join(cachedFontOriginalDir, relative.replace(/^cached-fonts-original\//, ""));
    }
    return null;
  } catch {
    return null;
  }
};
var normalizeAssetRequestUrl = (rawUrl) => {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("data:")) return value;
  if (value.startsWith("/cached-images-original/") || value.startsWith("/cached-fonts-original/")) {
    return `http://127.0.0.1:${activePort}${value}`;
  }
  const appBase = `http://127.0.0.1:${activePort}`;
  return sanitizeStreamUrl(value, appBase) || (value.startsWith("http") ? value : "");
};
var assertAssetUrlAllowed = (rawUrl) => {
  const normalized = normalizeAssetRequestUrl(rawUrl);
  if (!normalized) throw new Error("Invalid asset URL");
  if (normalized.startsWith("data:")) return normalized;
  if (!getLocalCachedAssetPath(normalized)) {
    assertPublicAssetUrl(normalized);
  }
  return normalized;
};
var guessContentTypeFromPath = (filePath) => {
  const ext = path3.extname(filePath).slice(1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "ttf") return "font/ttf";
  if (ext === "woff") return "font/woff";
  if (ext === "woff2") return "font/woff2";
  if (ext === "otf") return "font/otf";
  if (ext === "eot") return "application/vnd.ms-fontobject";
  return "application/octet-stream";
};
var getUrlKeyedOriginalCachePath = async (url, kind) => {
  const resolved = await resolveOriginalCachedAsset(url, kind);
  return resolved?.filePath || null;
};
var writeCachedOriginalImageFromBuffer = async (url, buffer, contentType = "", hintType = "bin", contentDisposition = "") => {
  if (!isValidImageBuffer(buffer, contentType)) return "";
  return writeOriginalCachedAsset(url, "image", buffer, {
    contentType,
    contentDisposition,
    hintType
  });
};
var inferCacheKind = (url, contentType = "") => /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url) || /font\//i.test(contentType) ? "font" : isRemoteImageRequestUrl(url) || /^image\//i.test(contentType) ? "image" : null;
var readAssetBufferFromCache = async (url, preferredKind = null) => {
  const normalized = normalizeAssetRequestUrl(url);
  if (!normalized) return null;
  const localPath = getLocalCachedAssetPath(normalized);
  if (localPath) {
    try {
      const buffer = await fsp3.readFile(localPath);
      const contentType = guessContentTypeFromPath(localPath);
      const isImagePath = localPath.includes(`${path3.sep}cached-images-original${path3.sep}`) || isRemoteImageRequestUrl(normalized);
      if (buffer.length > 0 && (!isImagePath || isValidImageBuffer(buffer, contentType))) {
        return { buffer, contentType };
      }
    } catch {
    }
  }
  const kind = preferredKind || inferCacheKind(normalized);
  if (kind) {
    try {
      const cachedPath = await getUrlKeyedOriginalCachePath(normalized, kind);
      if (cachedPath) {
        const buffer = await fsp3.readFile(cachedPath);
        const contentType = guessContentTypeFromPath(cachedPath);
        if (kind !== "image" || isValidImageBuffer(buffer, contentType)) {
          if (kind === "font" && !isValidFontOriginalBuffer(buffer, contentType)) {
            await fsp3.unlink(cachedPath).catch(() => void 0);
          } else {
            return { buffer, contentType };
          }
        }
      }
      const resolved = await resolveOriginalCachedAsset(normalized, kind);
      if (resolved?.filePath) {
        const buffer = await fsp3.readFile(resolved.filePath);
        const contentType = guessContentTypeFromPath(resolved.filePath);
        if (kind === "font") {
          if (isValidFontOriginalBuffer(buffer, contentType)) {
            return { buffer, contentType };
          }
        } else if (kind !== "image" || isValidImageBuffer(buffer, contentType)) {
          return { buffer, contentType };
        }
      }
    } catch {
    }
  }
  return null;
};
var getAssetCacheDebugPath = async (url, preferredKind = null) => {
  const normalized = normalizeAssetRequestUrl(url);
  if (!normalized) return "";
  const localPath = getLocalCachedAssetPath(normalized);
  if (localPath) return localPath;
  const kind = preferredKind || inferCacheKind(normalized);
  if (!kind) return "";
  const resolved = await resolveOriginalCachedAsset(normalized, kind);
  return resolved?.filePath || "";
};
var fetchAssetBuffer = async (url, fallbackUrl = "", options = {}) => {
  const refererPage = String(options.refererPageUrl || "").trim() || (() => {
    const candidate = String(fallbackUrl || "").trim();
    if (candidate.startsWith("http") && !isLikelyFontAssetUrl(candidate)) return candidate;
    return "";
  })();
  const attempt = async (target) => {
    const inlineFont = String(target || "").match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([a-z0-9+/=\s]+)$/i);
    if (inlineFont) {
      const buffer = Buffer.from(inlineFont[2].replace(/\s+/g, ""), "base64");
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("Invalid embedded font data");
      const contentType = inlineFont[1].toLowerCase();
      const format = detectFontFormatFromBuffer(buffer) || getFontFormatFromUrlOrType("", contentType);
      if (!isSupportedFontFormat(format) || !isValidFontBuffer(buffer, format)) throw new Error("Invalid embedded font data");
      return { buffer, contentType };
    }
    const cached = await readAssetBufferFromCache(target);
    if (cached) return cached;
    if (options.cacheOnly) {
      throw new Error(`Asset is not cached yet: ${target}`);
    }
    const normalized = normalizeAssetRequestUrl(target);
    if (isRemoteImageRequestUrl(normalized)) {
      const fetched = await fetchRemoteImageBuffer(normalized, refererPage, {
        skipBrowser: options.skipBrowser
      });
      if (fetched) return fetched;
      throw new Error(`Failed to fetch a valid image from ${normalized}`);
    }
    if (isLikelyFontAssetUrl(normalized) || inferCacheKind(normalized) === "font") {
      return fetchRemoteFontBuffer(normalized, refererPage);
    }
    return fetchRemoteAssetBuffer(normalized);
  };
  try {
    return await attempt(url);
  } catch (primaryError) {
    const fallback = String(fallbackUrl || "").trim();
    if (isJunkImageUrl(url) && fallback && fallback !== url && !isJunkImageUrl(fallback)) {
      try {
        return await attempt(fallback);
      } catch {
      }
    }
    if (!fallback || fallback === url) throw primaryError;
    return attempt(fallback);
  }
};
var readCachedFileIfExists = async (filePath) => {
  try {
    const stat = await fsp3.stat(filePath);
    if (stat.size > 0) return await fsp3.readFile(filePath);
  } catch {
  }
  return null;
};
var safeExtFromAssetType = (value) => {
  const ext = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 10);
  return ext || "bin";
};
var isValidImageBuffer = (buffer, contentType = "") => {
  if (!buffer || buffer.length < 12) return false;
  const detected = detectImageFormatFromBuffer(buffer);
  const minBytes = detected === "svg" ? 16 : 128;
  if (buffer.length < minBytes) return false;
  if (/text\/html|application\/json|text\/plain/i.test(contentType)) return false;
  if (detected) return true;
  const head = buffer.slice(0, 64).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return false;
  if (head.startsWith("<") && !head.startsWith("<svg")) return false;
  return false;
};
var resolveImageFetchReferer = (url, refererPageUrl = "") => {
  const pageReferer = String(refererPageUrl || "").trim();
  if (pageReferer.startsWith("http")) return pageReferer;
  try {
    return `${new URL2(url).origin}/`;
  } catch {
    return "";
  }
};
var fetchRemoteImageBufferViaHttp = async (url, refererPageUrl = "") => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const accept = imageAcceptHeaderForUrl(url);
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          Accept: accept,
          ...referer ? { Referer: referer } : {}
        },
        signal: AbortSignal.timeout(15e3),
        redirect: "follow"
      });
      if (!response.ok) continue;
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = String(response.headers.get("content-type") || guessContentTypeFromPath(url));
      if (isValidImageBuffer(buffer, contentType)) {
        return { buffer, contentType };
      }
    } catch {
    }
  }
  return null;
};
var fetchRemoteImageBufferViaCurl = async (url, refererPageUrl = "") => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const accept = imageAcceptHeaderForUrl(url);
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const args = [
        "-sL",
        "--max-time",
        "25",
        "-A",
        userAgent,
        "-H",
        `Accept: ${accept}`,
        ...referer ? ["-H", `Referer: ${referer}`] : [],
        url
      ];
      const { stdout } = await execFileAsync2("curl", args, {
        maxBuffer: 20 * 1024 * 1024,
        encoding: "buffer"
      });
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "latin1");
      const contentType = guessContentTypeFromPath(url);
      if (isValidImageBuffer(buffer, contentType)) {
        return { buffer, contentType };
      }
    } catch {
    }
  }
  return null;
};
var fetchImageFromRenderedPage = async (page, url) => {
  const dataUrl = await page.evaluate(async (targetUrl) => {
    const normalize = (value) => {
      try {
        const parsed = new URL2(value, location.href);
        parsed.hash = "";
        return parsed.href;
      } catch {
        return String(value || "");
      }
    };
    const target = normalize(targetUrl);
    const targetPath = (() => {
      try {
        return new URL2(target).pathname;
      } catch {
        return "";
      }
    })();
    const imageElements = Array.from(document.images || []);
    const exactMatch = imageElements.find((img2) => {
      const candidates = [img2.currentSrc, img2.src, img2.getAttribute("src"), img2.getAttribute("data-src")].map((candidate) => normalize(String(candidate || ""))).filter(Boolean);
      return candidates.some((candidate) => candidate === target);
    });
    const pathMatch = exactMatch || imageElements.find((img2) => {
      const candidates = [img2.currentSrc, img2.src, img2.getAttribute("src"), img2.getAttribute("data-src")].map((candidate) => normalize(String(candidate || ""))).filter(Boolean);
      return candidates.some((candidate) => {
        try {
          return targetPath && new URL2(candidate).pathname === targetPath;
        } catch {
          return false;
        }
      });
    });
    const blobToDataUrl = (blob) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
    try {
      const response = await fetch(target, { credentials: "include", cache: "force-cache" });
      const contentType2 = String(response.headers.get("content-type") || "").toLowerCase();
      if (response.ok && contentType2.startsWith("image/")) {
        const blob = await response.blob();
        if (blob.size > 0 && blob.size <= 15 * 1024 * 1024) {
          const fetchedDataUrl = await blobToDataUrl(blob);
          if (fetchedDataUrl.startsWith("data:image/")) return fetchedDataUrl;
        }
      }
    } catch {
    }
    const img = pathMatch;
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return "";
      context.drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return "";
    }
  }, url);
  if (!String(dataUrl || "").startsWith("data:image/")) return null;
  const buffer = decodeDataImageBuffer(String(dataUrl));
  if (!buffer?.length) return null;
  const contentType = String(dataUrl).match(/^data:([^;,]+)/i)?.[1] || "image/png";
  if (!isValidImageBuffer(buffer, contentType)) return null;
  return { buffer, contentType };
};
var fetchRemoteImageBufferViaBrowser = async (url, refererPageUrl = "") => {
  let browser = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await applyPuppeteerStealth(page);
    let landing = String(refererPageUrl || "").trim();
    if (!landing.startsWith("http")) {
      try {
        landing = `${new URL2(url).origin}/`;
      } catch {
        return null;
      }
    }
    await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 3e4 }).catch(() => void 0);
    await waitForPageContentSettle(page, { minWaitMs: 2800, readinessTimeoutMs: 2200 });
    const renderedImage = await fetchImageFromRenderedPage(page, url).catch(() => null);
    if (renderedImage) {
      await writeCachedOriginalImageFromBuffer(url, renderedImage.buffer, renderedImage.contentType);
      return renderedImage;
    }
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 3e4 }).catch(() => null);
    if (!response || response.status() < 200 || response.status() >= 400) return null;
    const buffer = Buffer.from(await response.buffer());
    const contentType = String(response.headers()["content-type"] || response.headers()["Content-Type"] || "");
    if (!isValidImageBuffer(buffer, contentType)) return null;
    await writeCachedOriginalImageFromBuffer(url, buffer, contentType);
    return { buffer, contentType };
  } catch {
    return null;
  } finally {
    await closePuppeteerBrowser(browser);
  }
};
var imagingUrlFallbacks = (url) => {
  const fallbacks = [];
  const lowered = String(url || "").toLowerCase();
  if (!/\.imaging\//i.test(lowered)) return fallbacks;
  if (!/\/jcr:content\./i.test(lowered)) {
    const withoutQuery = url.split("?")[0];
    const withoutExt = withoutQuery.replace(/\.(?:webp|png|jpe?g|gif|avif)$/i, "");
    fallbacks.push(`${withoutExt}/jcr:content.webp`);
    if (withoutExt !== withoutQuery) fallbacks.push(withoutExt);
  }
  return Array.from(new Set(fallbacks.filter((candidate) => candidate && candidate !== url)));
};
var fetchRemoteImageBuffer = async (url, refererPageUrl = "", options = {}) => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const isProtectedCdnImage = /\.imaging\/|\/dam\/jcr:|dam\/jcr:|fabindia\.com.*\/medias\//i.test(url);
  if (isProtectedCdnImage) {
    const httpFetched2 = await fetchRemoteImageBufferViaHttp(url, refererPageUrl);
    if (httpFetched2) {
      await writeCachedOriginalImageFromBuffer(url, httpFetched2.buffer, httpFetched2.contentType);
      return httpFetched2;
    }
    const curlFetched2 = await fetchRemoteImageBufferViaCurl(url, refererPageUrl);
    if (curlFetched2) {
      await writeCachedOriginalImageFromBuffer(url, curlFetched2.buffer, curlFetched2.contentType);
      return curlFetched2;
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
var ensureImageCachedForDownload = async (requestUrl, originalUrl, refererPageUrl = "") => {
  let cached = await readAssetBufferFromCache(requestUrl, "image") || (originalUrl && originalUrl !== requestUrl ? await readAssetBufferFromCache(originalUrl, "image") : null);
  if (cached) {
    const declaredFormat = inferImageTypeFromUrl(originalUrl || requestUrl, cached.contentType);
    const cachedFormat = detectImageFormatFromBuffer(cached.buffer);
    if (declaredFormat === "svg" && cachedFormat !== "svg") {
      const refreshed = await fetchRemoteImageBuffer(originalUrl || requestUrl, refererPageUrl, {
        skipBrowser: true
      }).catch(() => null);
      if (refreshed && detectImageFormatFromBuffer(refreshed.buffer) === "svg") {
        return { cached: refreshed, requestUrl: originalUrl || requestUrl };
      }
    }
    return { cached, requestUrl };
  }
  const warmTarget = String(originalUrl || requestUrl || "").trim();
  if (!warmTarget || warmTarget.startsWith("data:")) {
    return { cached: null, requestUrl };
  }
  try {
    const warmed = await withTimeout(
      warmCachedOriginalAssetForExtraction(
        warmTarget,
        "image",
        inferImageTypeFromUrl(warmTarget, "") || getAssetTypeFromUrl(warmTarget, "bin"),
        { refererPageUrl }
      ),
      2e4,
      `Ensure image cache for ${warmTarget}`
    );
    if (warmed?.ok && warmed.cachedUrl) {
      cached = await readAssetBufferFromCache(warmed.cachedUrl, "image") || await readAssetBufferFromCache(warmTarget, "image");
      if (cached) {
        return { cached, requestUrl: warmed.cachedUrl };
      }
    }
  } catch {
  }
  try {
    const fetched = await withTimeout(
      fetchAssetBuffer(warmTarget, warmTarget, { refererPageUrl }),
      3e4,
      `Ensure image fetch for ${warmTarget}`
    );
    if (fetched && isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      const cachedUrl = await writeCachedOriginalImageFromBuffer(
        warmTarget,
        fetched.buffer,
        fetched.contentType,
        inferImageTypeFromUrl(warmTarget, "") || getAssetTypeFromUrl(warmTarget, "bin"),
        String(fetched.contentDisposition || "")
      );
      cached = (cachedUrl ? await readAssetBufferFromCache(cachedUrl, "image") : null) || await readAssetBufferFromCache(warmTarget, "image");
      if (cached) {
        return { cached, requestUrl: cachedUrl || warmTarget };
      }
      return { cached: fetched, requestUrl: warmTarget };
    }
  } catch {
  }
  return { cached: null, requestUrl: warmTarget || requestUrl };
};
var readCachedImageBuffer = async (url) => {
  try {
    const normalized = normalizeAssetRequestUrl(url);
    if (!normalized.startsWith("http")) return null;
    const cachedPath = await getUrlKeyedOriginalCachePath(normalized, "image");
    if (!cachedPath) return null;
    const buffer = await fsp3.readFile(cachedPath);
    const contentType = guessContentTypeFromPath(cachedPath);
    if (!isValidImageBuffer(buffer, contentType)) {
      await fsp3.unlink(cachedPath).catch(() => void 0);
      return null;
    }
    return { buffer, contentType };
  } catch {
    return null;
  }
};
var isRemoteImageRequestUrl = (url) => {
  const value = String(url || "").toLowerCase();
  if (value.startsWith("data:image/")) return true;
  if (value.includes("/cached-images-original/")) return true;
  if (isLikelyFontAssetUrl(value)) return false;
  if (/\.(png|jpe?g|gif|webp|avif|svg|ashx)(\?|$)/i.test(value)) return true;
  if (/\/-\/media\//i.test(value) && !/\/fonts\//i.test(value)) return true;
  return false;
};
var RASTER_CONVERTIBLE_FORMATS = /* @__PURE__ */ new Set(["webp", "avif", "svg"]);
var normalizeRasterFormat = (format) => String(format || "").toLowerCase().replace("jpeg", "jpg").trim();
var resolveRasterSourceFormat = (buffer, normalizedUrl, lookupUrl, contentType = "") => {
  const fromBuffer = detectRasterFormatFromBuffer(buffer) || detectImageFormatFromBuffer(buffer);
  if (fromBuffer) return fromBuffer;
  const fromLookup = inferImageTypeFromUrl(lookupUrl, contentType);
  if (fromLookup && RASTER_CONVERTIBLE_FORMATS.has(fromLookup)) return fromLookup;
  const fromUrl = inferImageTypeFromUrl(normalizedUrl, contentType);
  if (fromUrl && RASTER_CONVERTIBLE_FORMATS.has(fromUrl)) return fromUrl;
  const fromCt = inferImageTypeFromContentType(contentType);
  if (fromCt && RASTER_CONVERTIBLE_FORMATS.has(fromCt)) return fromCt;
  return normalizeRasterFormat(fromBuffer || fromLookup || fromUrl || fromCt || getAssetTypeFromUrl(lookupUrl || normalizedUrl, "bin"));
};
var imageContentTypeForFormat = (format, fallback = "application/octet-stream") => {
  const normalized = normalizeRasterFormat(format);
  if (normalized === "jpg") return "image/jpeg";
  if (normalized === "png") return "image/png";
  if (normalized === "webp") return "image/webp";
  if (normalized === "avif") return "image/avif";
  if (normalized === "svg") return "image/svg+xml";
  if (normalized === "gif") return "image/gif";
  return fallback;
};
var IMAGE_BINARY_FORMATS = /* @__PURE__ */ new Set(["jpg", "png", "webp", "avif", "svg", "gif"]);
var reconcileImageFilenameWithBuffer = (filename, buffer, contentType = "") => {
  const actual = normalizeRasterFormat(
    detectRasterFormatFromBuffer(buffer) || detectImageFormatFromBuffer(buffer) || inferImageTypeFromContentType(contentType)
  );
  if (!actual || !IMAGE_BINARY_FORMATS.has(actual)) return filename;
  const ext = actual === "jpeg" ? "jpg" : actual;
  const currentExt = normalizeRasterFormat(path3.extname(filename || "").replace(/^\./, ""));
  if (currentExt === ext) return filename;
  if (filename && path3.extname(filename)) return filename.replace(/\.[^./\\]+$/, `.${ext}`);
  return `${filename || "asset"}.${ext}`;
};
var escapeXmlAttribute = (value) => String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var wrapRasterBufferAsIllustratorSvg = (buffer, format, label = "") => {
  const normalized = normalizeRasterFormat(format);
  if (!buffer?.length || !["jpg", "png", "webp", "avif", "gif"].includes(normalized)) return buffer;
  const dimensions = probeRasterDimensions(buffer);
  const width = dimensions.width > 0 ? dimensions.width : 1200;
  const height = dimensions.height > 0 ? dimensions.height : 800;
  const mime = imageContentTypeForFormat(normalized, "image/png");
  const title = escapeXmlAttribute(path3.basename(label || "embedded-image").replace(/\.[^.]+$/, ""));
  const encoded = buffer.toString("base64");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${title}</title>
  <image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${encoded}" xlink:href="data:${mime};base64,${encoded}"/>
</svg>
`;
  return Buffer.from(svg, "utf8");
};
var sanitizeFilenameBase = (value) => String(value || "asset").trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[/\\\\]+/g, "-").replace(/[^a-z0-9._ -]+/gi, "-").replace(/\s+/g, " ").replace(/-+/g, "-").replace(/^\.+/, "").trim().slice(0, 160) || "asset";
var decodeUrlEncodedFilename = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw.replace(/\+/g, " ");
  }
};
var parseContentDispositionFilename = (header) => {
  const value = String(header || "").trim();
  if (!value) return "";
  const encoded = value.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (encoded?.[1]) return decodeUrlEncodedFilename(encoded[1].trim().replace(/^["']|["']$/g, ""));
  const quoted = value.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return decodeUrlEncodedFilename(quoted[1].trim());
  const plain = value.match(/filename=([^;]+)/i);
  if (plain?.[1]) return decodeUrlEncodedFilename(plain[1].trim().replace(/^["']|["']$/g, ""));
  return "";
};
var filenameFromUrlPath2 = (rawUrl) => {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("data:")) return "";
  try {
    const parsed = new URL2(value);
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeUrlEncodedFilename(segment.split("?")[0].split("#")[0]);
  } catch {
    const segment = value.split("/").pop() || "";
    return decodeUrlEncodedFilename(segment.split("?")[0].split("#")[0]);
  }
};
var normalizeAssetExtension = (ext) => {
  const cleaned = String(ext || "").toLowerCase().replace(/^\./, "");
  if (cleaned === "jpeg") return "jpg";
  return cleaned;
};
var sanitizeFullFilename = (filename, fallbackExt = "") => {
  const decoded = decodeUrlEncodedFilename(String(filename || "").replace(/^\.\/+/, ""));
  let baseName = path3.basename(decoded.split("?")[0].split("#")[0]).replace(/[\\/:*?"<>|]/g, "-");
  if (!baseName) baseName = `asset${fallbackExt ? `.${normalizeAssetExtension(fallbackExt)}` : ""}`;
  const ext = path3.extname(baseName);
  const nameBase = ext ? path3.basename(baseName, ext) : baseName;
  const safeExt = normalizeAssetExtension(ext.slice(1) || fallbackExt || "bin");
  return `${sanitizeFilenameBase(nameBase)}.${safeExt}`;
};
var deriveAssetFilename = (options) => {
  const formatExt = normalizeAssetExtension(options.format || "");
  const fromHeader = parseContentDispositionFilename(options.contentDisposition);
  const fromUrl = options.url ? filenameFromUrlPath2(options.url) : "";
  const fromMeta = options.metadataFilename ? decodeUrlEncodedFilename(options.metadataFilename) : "";
  const fromPreferred = String(options.preferredBase || "").trim();
  let candidate = "";
  if (fromHeader) candidate = fromHeader;
  else if (fromPreferred) candidate = fromPreferred.includes(".") || !formatExt ? fromPreferred : `${fromPreferred}.${formatExt}`;
  else if (fromUrl) candidate = fromUrl;
  else if (fromMeta) candidate = fromMeta.includes(".") ? fromMeta : formatExt ? `${fromMeta}.${formatExt}` : fromMeta;
  else candidate = `${options.fallbackBase || "asset"}${formatExt ? `.${formatExt}` : ".bin"}`;
  if (formatExt && !path3.extname(candidate)) candidate = `${candidate}.${formatExt}`;
  return sanitizeFullFilename(candidate, formatExt);
};
var uniqueFilenameInSet = (filename, used) => {
  let candidate = sanitizeFullFilename(filename);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const ext = path3.extname(candidate);
  const base = path3.basename(candidate, ext) || "asset";
  let index = 1;
  while (used.has(`${base}-${index}${ext}`)) index += 1;
  candidate = `${base}-${index}${ext}`;
  used.add(candidate);
  return candidate;
};
var uniqueZipPathInSet = (zipPath, used) => {
  const normalized = String(zipPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.length ? parts.pop() : "asset.bin";
  const safeFile = sanitizeFullFilename(file);
  const safeDir = parts.map((segment) => sanitizeFilenameBase(segment)).filter(Boolean).join("/");
  let candidate = safeDir ? `${safeDir}/${safeFile}` : safeFile;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const ext = path3.extname(safeFile);
  const base = path3.basename(safeFile, ext) || "asset";
  let index = 1;
  while (used.has(safeDir ? `${safeDir}/${base}-${index}${ext}` : `${base}-${index}${ext}`)) index += 1;
  candidate = safeDir ? `${safeDir}/${base}-${index}${ext}` : `${base}-${index}${ext}`;
  used.add(candidate);
  return candidate;
};
var reconcileZipEntryNameWithBuffer = (zipEntryName, buffer) => {
  const normalized = String(zipEntryName || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.length ? parts.pop() : "asset.bin";
  const reconciledFile = reconcileImageFilenameWithBuffer(file, buffer);
  return parts.length ? `${parts.join("/")}/${reconciledFile}` : reconciledFile;
};
var uniqueDownloadFilePath = async (filename, options = {}) => {
  const requestedRootFolderName = sanitizeFilenameBase(String(options.rootFolderName || "").trim());
  const rootFolderName = /^(?:asset|assets|image|images|font|fonts|video|videos)$/i.test(requestedRootFolderName) ? "" : requestedRootFolderName;
  const pageUrl = normalizeProjectSourcePageUrl(
    String(options.sourcePageUrl || (rootFolderName ? "" : lastExtractedSourceUrl) || "").trim()
  );
  const baseTargetDir = rootFolderName ? path3.join(downloadsDir, rootFolderName) : resolveDownloadSaveDir(options.kind || "default", pageUrl);
  const rawSubfolder = String(options.subfolder || "").trim();
  const safeSubfolder = rawSubfolder ? sanitizeFilenameBase(rawSubfolder) : "";
  const targetDir = safeSubfolder ? path3.join(baseTargetDir, safeSubfolder) : baseTargetDir;
  if (!rootFolderName) {
    await removeEmptyCreativeAssetFolders(pageUrl);
  }
  await fsp3.mkdir(assertPathInsideDownloads(targetDir), { recursive: true });
  const safeFilename = sanitizeFullFilename(filename);
  const ext = path3.extname(safeFilename);
  const base = path3.basename(safeFilename, ext) || "asset";
  let candidate = safeFilename;
  let index = 1;
  while (true) {
    const filePath = path3.join(targetDir, candidate);
    const resolved = assertPathInsideDownloads(filePath);
    try {
      await fsp3.access(resolved);
      if (options.overwriteExisting) return { filePath: resolved, filename: candidate, folderPath: targetDir };
      candidate = `${base}-${index}${ext}`;
      index += 1;
    } catch {
      return { filePath: resolved, filename: candidate, folderPath: targetDir };
    }
  }
};
var removeExactDuplicateFontExports = async (folderPath, filename, buffer) => {
  const ext = path3.extname(filename);
  const base = path3.basename(filename, ext);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const duplicateName = new RegExp(`^${escapedBase}-\\d+${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const digest = crypto2.createHash("sha256").update(buffer).digest("hex");
  const entries = await fsp3.readdir(folderPath, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile() && duplicateName.test(entry.name)).map(async (entry) => {
    const candidate = path3.join(folderPath, entry.name);
    const existing = await fsp3.readFile(candidate).catch(() => null);
    if (existing && crypto2.createHash("sha256").update(existing).digest("hex") === digest) {
      await fsp3.unlink(candidate).catch(() => void 0);
    }
  }));
};
var saveBufferToDownloads = async (buffer, filename, label = "Download", sourcePageUrl, kind = "default", subfolder = "") => {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error(`${label} produced an empty file.`);
  }
  const detectedImageFormat = kind === "image" || /\.svg$/i.test(filename) ? detectImageFormatFromBuffer(buffer) : "";
  const writeBuffer = detectedImageFormat === "svg" ? normalizeSvgBufferForIllustrator(buffer) : buffer;
  const safeFilename = kind === "image" ? reconcileImageFilenameWithBuffer(filename, writeBuffer) : filename;
  const target = await uniqueDownloadFilePath(safeFilename, {
    sourcePageUrl,
    kind,
    subfolder: kind === "font" ? "" : subfolder,
    overwriteExisting: kind === "font"
  });
  if (kind === "font") await removeExactDuplicateFontExports(target.folderPath, target.filename, writeBuffer);
  await fsp3.writeFile(target.filePath, writeBuffer);
  const stat = await validateSavedAssetFile(target.filePath, label);
  return {
    ok: true,
    filename: target.filename,
    downloadPath: target.filePath,
    localPath: target.filePath,
    folderPath: target.folderPath,
    size: stat.size
  };
};
var saveCachedFileToDownloads = async (sourcePath, filename, label = "Download", sourcePageUrl, kind = "default") => {
  if (!sourcePath) throw new Error(`${label} cache path is missing.`);
  const removeExportedCacheFile = async () => {
    const resolvedSource = path3.resolve(sourcePath);
    const resolvedCacheRoot = path3.resolve(appCacheRoot);
    if (resolvedSource.startsWith(resolvedCacheRoot + path3.sep)) {
      await fsp3.rm(resolvedSource, { force: true }).catch(() => void 0);
    }
  };
  if (kind === "image" || /\.svg$/i.test(filename) || /\.svg$/i.test(sourcePath)) {
    const sourceBuffer = await fsp3.readFile(sourcePath);
    const detectedImageFormat = detectImageFormatFromBuffer(sourceBuffer);
    const writeBuffer = detectedImageFormat === "svg" ? normalizeSvgBufferForIllustrator(sourceBuffer) : sourceBuffer;
    const safeFilename = kind === "image" ? reconcileImageFilenameWithBuffer(filename, writeBuffer) : filename;
    const target = await uniqueDownloadFilePath(safeFilename, { sourcePageUrl, kind });
    await fsp3.writeFile(target.filePath, writeBuffer);
    const stat = await validateSavedAssetFile(target.filePath, label);
    await removeExportedCacheFile();
    return {
      ok: true,
      filename: target.filename,
      downloadPath: target.filePath,
      localPath: target.filePath,
      folderPath: target.folderPath,
      size: stat.size
    };
  } else {
    const target = await uniqueDownloadFilePath(filename, { sourcePageUrl, kind, overwriteExisting: kind === "font" });
    await fsp3.copyFile(sourcePath, target.filePath);
    const stat = await validateSavedAssetFile(target.filePath, label);
    await removeExportedCacheFile();
    return {
      ok: true,
      filename: target.filename,
      downloadPath: target.filePath,
      localPath: target.filePath,
      folderPath: target.folderPath,
      size: stat.size
    };
  }
};
var convertedImageCachePath = (lookupUrl, targetFormat) => path3.join(cachedImageDir, `${assetCacheKey(lookupUrl, targetFormat)}.${targetFormat}`);
var readValidatedConvertedImageCache = async (lookupUrl, targetFormat) => {
  const cachePath = convertedImageCachePath(lookupUrl, targetFormat);
  const cached = await readCachedFileIfExists(cachePath);
  if (!cached) return null;
  if (!isValidRasterOutputBuffer(cached, targetFormat)) {
    await fsp3.unlink(cachePath).catch(() => void 0);
    return null;
  }
  return { buffer: cached, cachePath };
};
var originalCacheKindDir = (kind) => kind === "image" ? cachedImageOriginalDir : cachedFontOriginalDir;
var originalCachePublicDir = (kind) => kind === "image" ? "/cached-images-original" : "/cached-fonts-original";
var publicUrlFromAbsoluteCachePath = (absolutePath, kind = "image") => {
  const normalized = String(absolutePath || "").replace(/\\/g, "/");
  if (!normalized) return "";
  const publicPrefix = originalCachePublicDir(kind);
  const directIdx = normalized.indexOf(`${publicPrefix}/`);
  if (directIdx >= 0) return normalized.slice(directIdx);
  const base = originalCacheKindDir(kind).replace(/\\/g, "/");
  if (normalized.startsWith(`${base}/`)) {
    return `${publicPrefix}/${normalized.slice(base.length + 1)}`;
  }
  return "";
};
var resolveCachedPublicUrl = async (publicPath, normalized, originalUrl) => {
  if (publicPath.startsWith("/cached-")) return publicPath;
  const cachePath = await getAssetCacheDebugPath(publicPath, "image") || await getAssetCacheDebugPath(normalized, "image") || (originalUrl ? await getAssetCacheDebugPath(originalUrl, "image") : "") || "";
  return publicUrlFromAbsoluteCachePath(cachePath, "image");
};
var originalCacheIndexPath = (kind) => path3.join(originalCacheKindDir(kind), ".url-index.json");
var loadOriginalCacheIndex = async (kind) => {
  try {
    const raw = await fsp3.readFile(originalCacheIndexPath(kind), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};
var saveOriginalCacheIndex = async (kind, index) => {
  await fsp3.mkdir(originalCacheKindDir(kind), { recursive: true });
  await fsp3.writeFile(originalCacheIndexPath(kind), JSON.stringify(index));
};
var originalCacheLookupKey = (url) => assetCacheKey(normalizeAssetRequestUrl(url) || url, "original-lookup");
var findLegacyHashOriginalCachePath = async (url, kind) => {
  const cacheDir = originalCacheKindDir(kind);
  const key = assetCacheKey(url, `original-${kind}`);
  const candidates = kind === "image" ? ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bin"] : ["woff2", "woff", "ttf", "otf", "eot", "svg", "bin"];
  for (const ext of candidates) {
    const filePath = path3.join(cacheDir, `${key}.${ext}`);
    try {
      const stat = await fsp3.stat(filePath);
      if (stat.size <= 0) continue;
      if (kind === "image") {
        const buffer = await fsp3.readFile(filePath);
        if (!isValidImageBuffer(buffer, guessContentTypeFromPath(filePath))) {
          await fsp3.unlink(filePath).catch(() => void 0);
          continue;
        }
      }
      return filePath;
    } catch {
    }
  }
  return null;
};
var resolveOriginalCachedAsset = async (url, kind) => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  const index = await loadOriginalCacheIndex(kind);
  const indexedName = index[originalCacheLookupKey(normalized)];
  if (indexedName) {
    const filePath = path3.join(originalCacheKindDir(kind), indexedName);
    try {
      const stat = await fsp3.stat(filePath);
      if (stat.size > 0) {
        const buffer = await fsp3.readFile(filePath);
        const contentType = guessContentTypeFromPath(filePath);
        const valid = kind === "image" ? isValidImageBuffer(buffer, contentType) : isValidFontOriginalBuffer(buffer, contentType);
        if (!valid) {
          await fsp3.unlink(filePath).catch(() => void 0);
          delete index[originalCacheLookupKey(normalized)];
          await saveOriginalCacheIndex(kind, index).catch(() => void 0);
        } else {
          return {
            filePath,
            filename: indexedName,
            cachedUrl: `${originalCachePublicDir(kind)}/${indexedName}`
          };
        }
      }
    } catch {
    }
  }
  const legacyPath = await findLegacyHashOriginalCachePath(normalized, kind);
  if (!legacyPath) return null;
  const filename = path3.basename(legacyPath);
  return {
    filePath: legacyPath,
    filename,
    cachedUrl: `${originalCachePublicDir(kind)}/${filename}`
  };
};
var writeOriginalCachedAsset = async (url, kind, buffer, options = {}) => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  const cacheDir = originalCacheKindDir(kind);
  await fsp3.mkdir(cacheDir, { recursive: true });
  const existing = await resolveOriginalCachedAsset(url, kind);
  if (existing) {
    try {
      const current = await fsp3.readFile(existing.filePath);
      const currentType = guessContentTypeFromPath(existing.filePath);
      const validOriginal = current.length > 0 && (kind === "image" ? isValidImageBuffer(current, currentType) : isValidFontOriginalBuffer(current, currentType));
      if (validOriginal) {
        return existing.cachedUrl;
      }
      await fsp3.unlink(existing.filePath).catch(() => void 0);
    } catch {
    }
  }
  if (kind === "font" && !isValidFontOriginalBuffer(buffer, options.contentType || "")) {
    return "";
  }
  const writeBuffer = kind === "image" && detectImageFormatFromBuffer(buffer) === "svg" ? normalizeSvgBufferForIllustrator(buffer) : buffer;
  const ext = kind === "image" ? safeExtFromAssetType(
    detectImageFormatFromBuffer(writeBuffer) || inferImageTypeFromUrl(normalized, options.contentType || "") || options.hintType || "bin"
  ) : safeExtFromAssetType(getFontFormatFromUrlOrType(normalized, options.contentType || "") || options.hintType || "bin");
  const desired = deriveAssetFilename({
    url: normalized.startsWith("http") ? normalized : url,
    contentDisposition: options.contentDisposition,
    metadataFilename: options.metadataFilename,
    preferredBase: options.preferredBase,
    format: ext,
    fallbackBase: kind === "image" ? "image" : "font"
  });
  const existingFiles = await fsp3.readdir(cacheDir).catch(() => []);
  const used = new Set(existingFiles.filter((name) => !name.startsWith(".")));
  const filename = uniqueFilenameInSet(desired, used);
  await fsp3.writeFile(path3.join(cacheDir, filename), writeBuffer);
  const index = await loadOriginalCacheIndex(kind);
  index[originalCacheLookupKey(normalized)] = filename;
  await saveOriginalCacheIndex(kind, index);
  const legacyPath = await findLegacyHashOriginalCachePath(normalized, kind);
  if (legacyPath && path3.basename(legacyPath) !== filename) {
    await fsp3.unlink(legacyPath).catch(() => void 0);
  }
  return `${originalCachePublicDir(kind)}/${filename}`;
};
var buildDownloadFilename = (url, format, preferredBase, extras = {}) => deriveAssetFilename({
  url,
  format,
  preferredBase,
  contentDisposition: extras.contentDisposition,
  metadataFilename: extras.metadataFilename,
  fallbackBase: "asset"
});
var getCachedConvertedImage = async (url, requestedFormat, options) => {
  await fsp3.mkdir(cachedImageDir, { recursive: true });
  const normalizedUrl = normalizeAssetRequestUrl(url);
  const lookupUrl = String(options?.originalUrl || normalizedUrl || "").trim();
  const preferredBase = options?.filenameBase;
  const filenameSourceUrl = options?.originalUrl || normalizedUrl;
  const filenameExtras = {
    contentDisposition: options?.prefetched?.contentDisposition,
    metadataFilename: options?.metadataFilename
  };
  const requestedTarget = normalizeRasterFormat(requestedFormat || "");
  const wantsPreconvertedTarget = ["png", "jpg"].includes(requestedTarget);
  if (wantsPreconvertedTarget) {
    const targetFormat2 = requestedTarget;
    const cacheKeyUrl2 = lookupUrl || normalizedUrl;
    const convertedHit = await readValidatedConvertedImageCache(cacheKeyUrl2, targetFormat2);
    if (convertedHit) {
      return {
        buffer: convertedHit.buffer,
        format: targetFormat2,
        filename: buildDownloadFilename(filenameSourceUrl, targetFormat2, preferredBase, filenameExtras),
        cachedPath: convertedHit.cachePath
      };
    }
  }
  const cachedOriginal = !options?.prefetched ? await readAssetBufferFromCache(normalizedUrl, "image") || (lookupUrl && lookupUrl !== normalizedUrl ? await readAssetBufferFromCache(lookupUrl, "image") : null) : null;
  if (options?.cacheOnly && !options?.prefetched && !cachedOriginal) {
    if (wantsPreconvertedTarget) {
      throw new Error(`Converted ${requestedTarget.toUpperCase()} is not cached yet for this image.`);
    }
    throw new Error("Image is not cached yet. Extract the page first, then download again.");
  }
  const fetched = options?.prefetched || cachedOriginal || await fetchAssetBuffer(normalizedUrl, options?.originalUrl || "", {
    cacheOnly: options?.cacheOnly,
    refererPageUrl: options?.refererPageUrl,
    skipBrowser: options?.skipBrowser
  });
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
  const preparedSourceBuffer = normalizedSource === "svg" ? materializeSvgFragmentForIllustrator(fetched.buffer, lookupUrl || normalizedUrl) : fetched.buffer;
  const defaultTarget = normalizedSource === "webp" ? "jpg" : normalizedSource === "avif" ? "png" : normalizedSource;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  filenameExtras.contentDisposition = fetched.contentDisposition || options?.prefetched?.contentDisposition;
  if (normalizedTarget === "svg" && normalizedSource !== "svg" && IMAGE_BINARY_FORMATS.has(normalizedSource)) {
    const wrappedSvg = wrapRasterBufferAsIllustratorSvg(fetched.buffer, normalizedSource, filenameSourceUrl);
    return {
      buffer: normalizeSvgBufferForIllustrator(wrappedSvg),
      format: "svg",
      filename: buildDownloadFilename(filenameSourceUrl, "svg", preferredBase, filenameExtras),
      cachedPath: ""
    };
  }
  const wantsRasterConversion = ["png", "jpg"].includes(normalizedTarget) && RASTER_CONVERTIBLE_FORMATS.has(normalizedSource) && supportedRasterConversionTargets(normalizedSource).includes(normalizedTarget);
  if (!wantsRasterConversion) {
    const cachePath2 = path3.join(cachedImageDir, `${assetCacheKey(normalizedUrl, "original")}.${sourceFormat || "bin"}`);
    let cached2 = await readCachedFileIfExists(cachePath2);
    if (cached2 && !isValidImageBuffer(cached2, guessContentTypeFromPath(cachePath2))) {
      await fsp3.unlink(cachePath2).catch(() => void 0);
      cached2 = null;
    }
    if (!cached2) {
      await fsp3.writeFile(cachePath2, preparedSourceBuffer);
      cached2 = preparedSourceBuffer;
    }
    const passthroughBuffer = cached2 || fetched.buffer;
    if (RASTER_CONVERTIBLE_FORMATS.has(normalizedSource)) {
      const detected = detectRasterFormatFromBuffer(passthroughBuffer);
      if (detected && detected !== normalizedSource) {
        throw new Error(`Cached image format mismatch for ${lookupUrl || normalizedUrl}`);
      }
    }
    return {
      buffer: passthroughBuffer,
      format: normalizedSource || "bin",
      filename: buildDownloadFilename(filenameSourceUrl, normalizedSource || "bin", preferredBase, filenameExtras),
      cachedPath: cachePath2
    };
  }
  const targetFormat = normalizedTarget;
  const cacheKeyUrl = lookupUrl || normalizedUrl;
  const cachePath = convertedImageCachePath(cacheKeyUrl, targetFormat);
  let cached = (await readValidatedConvertedImageCache(cacheKeyUrl, targetFormat))?.buffer || null;
  if (!cached) {
    cached = await convertRasterImageBuffer(preparedSourceBuffer, targetFormat);
    await fsp3.writeFile(cachePath, cached);
  }
  if (!isValidRasterOutputBuffer(cached, targetFormat)) {
    throw new Error(`Converted cache is not valid ${targetFormat.toUpperCase()} for ${lookupUrl || normalizedUrl}`);
  }
  return {
    buffer: cached,
    format: targetFormat,
    filename: buildDownloadFilename(filenameSourceUrl, targetFormat, preferredBase, filenameExtras),
    cachedPath: cachePath
  };
};
var getCurlFetchedConvertedImage = async (url, requestedFormat, options) => {
  const normalizedUrl = normalizeAssetRequestUrl(url);
  if (!normalizedUrl || !normalizedUrl.startsWith("http")) return null;
  let fetched = null;
  const referer = (() => {
    try {
      return `${new URL2(normalizedUrl).origin}/`;
    } catch {
      return "";
    }
  })();
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await axios.get(normalizedUrl, {
        responseType: "arraybuffer",
        timeout: 12e3,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
        httpsAgent: relaxedHttpsAgent,
        headers: {
          "User-Agent": userAgent,
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          ...referer ? { Referer: referer } : {}
        }
      });
      const buffer = Buffer.from(response.data);
      const contentType = String(response.headers?.["content-type"] || response.headers?.["Content-Type"] || "");
      const contentDisposition = String(response.headers?.["content-disposition"] || response.headers?.["Content-Disposition"] || "");
      if (isValidImageBuffer(buffer, contentType)) {
        fetched = { buffer, contentType, contentDisposition };
        break;
      }
    } catch {
    }
  }
  fetched ||= await fetchRemoteImageBufferViaCurl(normalizedUrl);
  if (!fetched || !isValidImageBuffer(fetched.buffer, fetched.contentType)) return null;
  const lookupUrl = String(options?.originalUrl || normalizedUrl).trim();
  const filenameSourceUrl = options?.originalUrl || normalizedUrl;
  const preferredBase = options?.filenameBase;
  const filenameExtras = { metadataFilename: options?.metadataFilename };
  const sourceFormat = normalizeRasterFormat(
    detectRasterFormatFromBuffer(fetched.buffer) || detectImageFormatFromBuffer(fetched.buffer) || inferImageTypeFromContentType(fetched.contentType) || inferImageTypeFromUrl(lookupUrl || normalizedUrl, fetched.contentType) || getAssetTypeFromUrl(lookupUrl || normalizedUrl, "bin")
  );
  const preparedSourceBuffer = sourceFormat === "svg" ? materializeSvgFragmentForIllustrator(fetched.buffer, lookupUrl || normalizedUrl) : fetched.buffer;
  const defaultTarget = sourceFormat === "webp" ? "jpg" : sourceFormat === "avif" ? "png" : sourceFormat;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  if (normalizedTarget === "svg" && sourceFormat !== "svg" && IMAGE_BINARY_FORMATS.has(sourceFormat)) {
    const wrappedSvg = wrapRasterBufferAsIllustratorSvg(fetched.buffer, sourceFormat, filenameSourceUrl);
    return {
      buffer: normalizeSvgBufferForIllustrator(wrappedSvg),
      format: "svg",
      filename: buildDownloadFilename(filenameSourceUrl, "svg", preferredBase, filenameExtras),
      cachedPath: ""
    };
  }
  const wantsRasterConversion = ["png", "jpg"].includes(normalizedTarget) && RASTER_CONVERTIBLE_FORMATS.has(sourceFormat) && supportedRasterConversionTargets(sourceFormat).includes(normalizedTarget);
  if (wantsRasterConversion) {
    const targetFormat = normalizedTarget;
    const converted = await convertRasterImageBuffer(preparedSourceBuffer, targetFormat);
    if (!isValidRasterOutputBuffer(converted, targetFormat)) return null;
    const cacheKeyUrl = lookupUrl || normalizedUrl;
    const cachePath = convertedImageCachePath(cacheKeyUrl, targetFormat);
    await fsp3.writeFile(cachePath, converted).catch(() => void 0);
    return {
      buffer: converted,
      format: targetFormat,
      filename: buildDownloadFilename(filenameSourceUrl, targetFormat, preferredBase, filenameExtras),
      cachedPath: cachePath
    };
  }
  const cachedUrl = await writeOriginalCachedAsset(lookupUrl || normalizedUrl, "image", fetched.buffer, {
    contentType: fetched.contentType,
    hintType: sourceFormat || "bin",
    preferredBase
  });
  const resolved = cachedUrl ? await resolveOriginalCachedAsset(lookupUrl || normalizedUrl, "image") : null;
  return {
    buffer: preparedSourceBuffer,
    format: sourceFormat || "bin",
    filename: buildDownloadFilename(filenameSourceUrl, sourceFormat || "bin", preferredBase, filenameExtras),
    cachedPath: resolved?.filePath || ""
  };
};
var warmRasterConversionVariants = async (url, cachedUrl = "") => {
  const originalUrl = String(url || "").trim();
  if (!originalUrl || !/\.(?:webp|avif)(?:[?#]|$)/i.test(originalUrl)) return;
  const convertUrl = String(cachedUrl || "").trim() || originalUrl;
  await Promise.all(
    ["png", "jpg"].map(async (format) => {
      try {
        await getCachedConvertedImage(convertUrl, format, { originalUrl });
      } catch {
      }
    })
  );
};
var warmFontConversionVariants = async (url, cachedUrl = "", originalFormat = "unknown", options = {}) => {
  const originalUrl = String(url || "").trim();
  if (!originalUrl) return;
  const convertUrl = String(cachedUrl || "").trim() || originalUrl;
  const refererPageUrl = resolveFontRefererPage(options.cssSource || "", options.refererPageUrl || "");
  const targets = getFontConversionOutputs(originalFormat);
  await Promise.all(
    targets.map(async (format) => {
      try {
        await convertFontAsset(convertUrl, format, originalFormat, void 0, {
          originalUrl,
          refererPageUrl: refererPageUrl || void 0
        });
      } catch {
      }
    })
  );
};
var normalizeFontFormat = (format, contentType = "") => {
  let fromFormat = String(format || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (fromFormat === "truetype") fromFormat = "ttf";
  if (fromFormat === "opentype") fromFormat = "otf";
  if (fromFormat === "unknown" || !fromFormat) {
    const value = contentType.toLowerCase();
    if (value.includes("woff2")) fromFormat = "woff2";
    else if (value.includes("woff")) fromFormat = "woff";
    else if (value.includes("ttf") || value.includes("truetype")) fromFormat = "ttf";
    else if (value.includes("otf") || value.includes("opentype")) fromFormat = "otf";
    else if (value.includes("svg")) fromFormat = "svg";
    else if (value.includes("eot")) fromFormat = "eot";
  }
  return fromFormat;
};
var detectFontFormatFromBuffer = (buffer) => {
  if (!buffer || buffer.length < 4) return "";
  const sig = buffer.slice(0, 4).toString("latin1");
  if (sig === "wOF2") return "woff2";
  if (sig === "wOFF") return "woff";
  if (sig === "OTTO") return "otf";
  if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0) return "ttf";
  return "";
};
var normalizeTtfIdentity = (filenameBase) => {
  const clean = String(filenameBase || "Font").replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, "").replace(/[_]+/g, "-").replace(/\s+/g, " ").trim() || "Font";
  const variantMatch = clean.match(/^(.*?)[- ](Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black)(?:[- ]?(Italic|Oblique))?$/i);
  const family = (variantMatch?.[1] || clean).replace(/[- ]+$/g, "").trim() || "Font";
  const weight = variantMatch?.[2] || "Regular";
  const slant = variantMatch?.[3] || "";
  const subfamily = [weight, slant].filter(Boolean).join(" ") || "Regular";
  const fullName = subfamily === "Regular" ? family : `${family} ${subfamily}`;
  const postScriptName = `${family}CAE-${subfamily}`.replace(/[^A-Za-z0-9-]+/g, "").replace(/-+/g, "-").slice(0, 63) || "Font-Regular";
  return { family, subfamily, fullName, postScriptName };
};
var sfntChecksum = (buffer) => {
  let sum = 0;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const word = Buffer.alloc(4);
    buffer.copy(word, 0, offset, Math.min(offset + 4, buffer.length));
    sum = sum + word.readUInt32BE(0) >>> 0;
  }
  return sum >>> 0;
};
var encodeSfntName = (value, platformId) => {
  if (platformId === 0 || platformId === 3) {
    const output = Buffer.alloc(value.length * 2);
    for (let index = 0; index < value.length; index += 1) output.writeUInt16BE(value.charCodeAt(index), index * 2);
    return output;
  }
  return Buffer.from(value.replace(/[^\x20-\x7e]/g, ""), "latin1");
};
var rewriteTtfNameRecords = (buffer, values) => {
  const tableCount = buffer.readUInt16BE(4);
  const sourceTables = Array.from({ length: tableCount }, (_, index) => {
    const directoryOffset = 12 + index * 16;
    const tag = buffer.toString("latin1", directoryOffset, directoryOffset + 4);
    const offset = buffer.readUInt32BE(directoryOffset + 8);
    const length = buffer.readUInt32BE(directoryOffset + 12);
    return { tag, data: Buffer.from(buffer.subarray(offset, offset + length)) };
  });
  const nameTable = sourceTables.find((table) => table.tag === "name");
  if (!nameTable || nameTable.data.length < 6) throw new Error("TTF name table is missing.");
  const format = nameTable.data.readUInt16BE(0);
  const recordCount = nameTable.data.readUInt16BE(2);
  const stringOffset = nameTable.data.readUInt16BE(4);
  if (format !== 0 || stringOffset < 6 + recordCount * 12 || stringOffset > nameTable.data.length) {
    throw new Error("Unsupported TTF name-table layout.");
  }
  const records = [];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 6 + index * 12;
    const platformId = nameTable.data.readUInt16BE(offset);
    const encodingId = nameTable.data.readUInt16BE(offset + 2);
    const languageId = nameTable.data.readUInt16BE(offset + 4);
    const nameId = nameTable.data.readUInt16BE(offset + 6);
    const length = nameTable.data.readUInt16BE(offset + 8);
    const relativeOffset = nameTable.data.readUInt16BE(offset + 10);
    const start = stringOffset + relativeOffset;
    const original = start + length <= nameTable.data.length ? Buffer.from(nameTable.data.subarray(start, start + length)) : Buffer.alloc(0);
    records.push({
      platformId,
      encodingId,
      languageId,
      nameId,
      bytes: values[nameId] ? encodeSfntName(values[nameId], platformId) : original
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
  const tables = sourceTables.sort((a, b) => Buffer.from(a.tag, "latin1").compare(Buffer.from(b.tag, "latin1")));
  const maxPower = 2 ** Math.floor(Math.log2(tables.length));
  const headerSize = 12 + tables.length * 16;
  let dataOffset = headerSize + 3 & ~3;
  const placements = tables.map((table) => {
    const placement = { ...table, offset: dataOffset };
    dataOffset += table.data.length + 3 & ~3;
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
    output.write(table.tag, directoryOffset, 4, "latin1");
    const checksumData = Buffer.from(table.data);
    if (table.tag === "head" && checksumData.length >= 12) checksumData.writeUInt32BE(0, 8);
    output.writeUInt32BE(sfntChecksum(checksumData), directoryOffset + 4);
    output.writeUInt32BE(table.offset, directoryOffset + 8);
    output.writeUInt32BE(table.data.length, directoryOffset + 12);
    checksumData.copy(output, table.offset);
  });
  const head = placements.find((table) => table.tag === "head");
  if (head && head.offset + 12 <= output.length) {
    output.writeUInt32BE(2981146554 - sfntChecksum(output) >>> 0, head.offset + 8);
  }
  return output;
};
var fontWeightName = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric <= 100) return "Thin";
    if (numeric <= 200) return "ExtraLight";
    if (numeric <= 300) return "Light";
    if (numeric <= 400) return "Regular";
    if (numeric <= 500) return "Medium";
    if (numeric <= 600) return "SemiBold";
    if (numeric <= 700) return "Bold";
    if (numeric <= 800) return "ExtraBold";
    return "Black";
  }
  const aliases = {
    thin: "Thin",
    hairline: "Thin",
    extralight: "ExtraLight",
    "extra light": "ExtraLight",
    ultralight: "ExtraLight",
    light: "Light",
    normal: "Regular",
    regular: "Regular",
    book: "Book",
    medium: "Medium",
    semibold: "SemiBold",
    "semi bold": "SemiBold",
    demibold: "SemiBold",
    bold: "Bold",
    extrabold: "ExtraBold",
    "extra bold": "ExtraBold",
    ultrabold: "ExtraBold",
    black: "Black",
    heavy: "Black"
  };
  return aliases[normalized] || "";
};
var isGenericFontFamilyIdentity = (value) => {
  const tokens = String(value || "").replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const generic = /* @__PURE__ */ new Set(["font", "typeface", "regular", "normal", "bold", "italic", "oblique", "medium", "book", "webfont", "website"]);
  return tokens.every((token) => generic.has(token) || /^\d+$/.test(token));
};
var normalizeFontIdentityCompare = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
var buildTtfIdentityBase = (preferredBase, extras) => {
  const explicit = String(preferredBase || "").trim();
  const familySource = [extras.fontFamily, extras.metadataFilename, explicit].map((value) => String(value || "").trim()).find((value) => value && !isGenericFontFamilyIdentity(value)) || "Font";
  let family = familySource.replace(/\.(?:woff2?|ttf|otf|eot|svg)$/i, "").trim() || "Font";
  const familyVariant = family.match(/^(.*?)[- ](Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black)$/i);
  const explicitWeight = fontWeightName(String(extras.fontWeight || ""));
  if (familyVariant?.[1]) family = familyVariant[1].replace(/[- ]+$/g, "").trim() || family;
  const weight = explicitWeight || fontWeightName(String(familyVariant?.[2] || "")) || "Regular";
  const slant = /italic/i.test(String(extras.fontStyle || "")) ? "Italic" : /oblique/i.test(String(extras.fontStyle || "")) ? "Oblique" : "";
  return [family, weight === "Regular" && !slant ? "" : weight, slant].filter(Boolean).join(" ");
};
var repairTtfNameTable = (buffer, filenameBase) => {
  if (detectFontFormatFromBuffer(buffer) !== "ttf") return buffer;
  const requestedIdentity = normalizeTtfIdentity(filenameBase);
  const font = Font.create(buffer, { type: "ttf", hinting: true, kerning: true });
  const data = font.get();
  const isUsableIdentityName = (value) => {
    const text = String(value || "").trim();
    return Boolean(text) && !/not licensed|copyright|all rights reserved|webfont|web font|type foundry$/i.test(text);
  };
  const embeddedFamily = [
    data.name?.preferredFamily,
    data.name?.fontFamily,
    data.name?.fullName
  ].map((value) => String(value || "").trim()).find((value) => isUsableIdentityName(value) && !isGenericFontFamilyIdentity(value)) || "";
  const family = isUsableIdentityName(requestedIdentity.family) && !isGenericFontFamilyIdentity(requestedIdentity.family) ? requestedIdentity.family : embeddedFamily || "Font";
  const subfamily = isUsableIdentityName(requestedIdentity.subfamily) ? requestedIdentity.subfamily : String(data.name?.preferredSubFamily || "Regular").trim();
  const fullName = subfamily === "Regular" ? family : `${family} ${subfamily}`;
  const postScriptName = `${family}CAE-${subfamily}`.replace(/[^A-Za-z0-9-]+/g, "").replace(/-+/g, "-").slice(0, 63) || requestedIdentity.postScriptName;
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
    22: subfamily
  });
  if (detectFontFormatFromBuffer(repaired) !== "ttf") {
    throw new Error("TTF name-table repair produced an invalid font file.");
  }
  return repaired;
};
var isInstallableTtfBuffer = (buffer) => {
  if (detectFontFormatFromBuffer(buffer) !== "ttf") return false;
  const hasValidSfntStructure = (() => {
    if (buffer.length < 12) return false;
    const tableCount = buffer.readUInt16BE(4);
    if (tableCount < 4 || tableCount > 256 || 12 + tableCount * 16 > buffer.length) return false;
    const tables = /* @__PURE__ */ new Set();
    let previousTag = "";
    for (let index = 0; index < tableCount; index += 1) {
      const entryOffset = 12 + index * 16;
      const tag = buffer.toString("latin1", entryOffset, entryOffset + 4);
      const tableOffset = buffer.readUInt32BE(entryOffset + 8);
      const tableLength = buffer.readUInt32BE(entryOffset + 12);
      if (!tag.trim() || tableOffset > buffer.length || tableLength > buffer.length - tableOffset) return false;
      if (previousTag && Buffer.from(previousTag, "latin1").compare(Buffer.from(tag, "latin1")) >= 0) return false;
      previousTag = tag;
      tables.add(tag);
    }
    const hasCoreTables = ["cmap", "head", "maxp", "name"].every((tag) => tables.has(tag));
    const hasGlyphTables = tables.has("glyf") && tables.has("loca") || tables.has("CFF ") || tables.has("CFF2");
    return hasCoreTables && hasGlyphTables;
  })();
  if (!hasValidSfntStructure) return false;
  try {
    const parsed = opentype.parse(bufferToExactArrayBuffer(buffer));
    const glyphCount = Number(parsed?.glyphs?.length || parsed?.numGlyphs || 0);
    const mappedCharacterCount = Object.keys(parsed?.tables?.cmap?.glyphIndexMap || {}).length;
    const names = parsed?.names || {};
    const hasReadableName = [
      names.preferredFamily,
      names.typographicFamily,
      names.fontFamily,
      names.fullName,
      names.postScriptName
    ].some((group) => {
      if (typeof group === "string") return Boolean(group.trim());
      return group && typeof group === "object" && Object.values(group).some((value) => typeof value === "string" && value.trim());
    });
    return glyphCount > 1 && mappedCharacterCount > 0 && (hasReadableName || hasValidSfntStructure);
  } catch {
    return hasValidSfntStructure;
  }
};
var isValidFontBuffer = (buffer, expectedFormat) => {
  if (!buffer || buffer.length < 128) return false;
  const detected = detectFontFormatFromBuffer(buffer);
  const target = String(expectedFormat || "").toLowerCase();
  if (!detected) return false;
  if (target === "svg" || target === "eot") return false;
  if (detected !== target) return false;
  if (target === "ttf") return isInstallableTtfBuffer(buffer);
  return true;
};
var TRANSFONTER_ORIGIN = "https://transfonter.org";
var TRANSFONTER_MAX_FONT_BYTES = 5e6;
var transfonterTtfCache = /* @__PURE__ */ new Map();
var fontForgeTtfCache = /* @__PURE__ */ new Map();
var transfonterActiveConversions = 0;
var transfonterWaiters = [];
var withTransfonterSlot = async (task) => {
  if (transfonterActiveConversions >= 3) {
    await new Promise((resolve) => transfonterWaiters.push(resolve));
  }
  transfonterActiveConversions += 1;
  try {
    return await task();
  } finally {
    transfonterActiveConversions = Math.max(0, transfonterActiveConversions - 1);
    transfonterWaiters.shift()?.();
  }
};
var findFilesByExtension = async (root, extension) => {
  const found = [];
  const entries = await fsp3.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path3.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findFilesByExtension(absolute, extension));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) found.push(absolute);
  }
  return found;
};
var readResponseCookies = (response) => {
  const headers = response.headers;
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  return values.flatMap((value) => String(value || "").split(/,(?=[^;,]+=)/g)).map((value) => value.split(";")[0]?.trim()).filter(Boolean).join("; ");
};
var resolveFontForgePath = () => {
  const candidates = [
    String(process.env.FONTFORGE_PATH || "").trim(),
    "/opt/homebrew/bin/fontforge",
    "/usr/local/bin/fontforge",
    "/usr/bin/fontforge"
  ].filter(Boolean);
  return candidates.find((candidate) => fs2.existsSync(candidate)) || "";
};
var convertFontBufferWithFontForge = async (buffer, filenameBase, sourceFormat) => {
  const fontForgePath = resolveFontForgePath();
  if (!fontForgePath) throw new Error("FontForge is not installed.");
  const cacheKey = crypto2.createHash("sha256").update(buffer).digest("hex");
  const cached = fontForgeTtfCache.get(cacheKey);
  if (cached) return cached;
  const conversion = (async () => {
    const tempRoot = await fsp3.mkdtemp(path3.join(os3.tmpdir(), "cae-fontforge-"));
    try {
      const safeBase = sanitizeFilenameBase(filenameBase || "font").replace(/\s+/g, "-") || "font";
      const sourceExt = ["woff2", "woff", "ttf", "otf"].includes(sourceFormat) ? sourceFormat : "woff";
      const inputPath = path3.join(tempRoot, `${safeBase}.${sourceExt}`);
      const outputPath = path3.join(tempRoot, `${safeBase}.ttf`);
      await fsp3.writeFile(inputPath, buffer);
      await execFileAsync2(
        fontForgePath,
        ["-lang=ff", "-c", "Open($1); Generate($2)", inputPath, outputPath],
        { timeout: 45e3, maxBuffer: 4 * 1024 * 1024 }
      );
      const converted = await fsp3.readFile(outputPath);
      if (!isInstallableTtfBuffer(converted)) {
        throw new Error("FontForge returned a TTF that failed installability validation.");
      }
      return converted;
    } finally {
      await fsp3.rm(tempRoot, { recursive: true, force: true }).catch(() => void 0);
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
var convertFontBufferWithTransfonter = async (buffer, filenameBase, sourceFormat, fixVerticalMetrics = true, targetFormat = "ttf") => {
  if (!buffer.length || buffer.length > TRANSFONTER_MAX_FONT_BYTES) {
    throw new Error("Transfonter accepts font files up to 5 MB.");
  }
  const normalizedTarget = normalizeFontFormat(targetFormat);
  if (!["ttf", "woff"].includes(normalizedTarget)) {
    throw new Error("Transfonter conversion is only enabled for TTF and WOFF outputs.");
  }
  const safeBase = sanitizeFilenameBase(filenameBase || "font").replace(/\s+/g, " ").trim() || "font";
  const cacheKey = [
    crypto2.createHash("sha256").update(buffer).digest("hex"),
    `target:${normalizedTarget}`,
    `metrics:${fixVerticalMetrics ? "on" : "off"}`,
    `name:${safeBase.toLowerCase()}`
  ].join(":");
  const cached = transfonterTtfCache.get(cacheKey);
  if (cached) return cached;
  const conversion = withTransfonterSlot(async () => {
    const pageResponse = await fetch(`${TRANSFONTER_ORIGIN}/`, { headers: { "User-Agent": "Creative-Asset-Extractor/2.0" } });
    if (!pageResponse.ok) throw new Error(`Transfonter initialization failed (${pageResponse.status}).`);
    const sessionCookie = readResponseCookies(pageResponse);
    const pageHtml = await pageResponse.text();
    const userId = pageHtml.match(/USER_ID\s*=\s*['"]([^'"]+)['"]/)?.[1] || "";
    if (!userId) throw new Error("Transfonter session could not be initialized.");
    const sessionHeaders = {
      "User-Agent": "Creative-Asset-Extractor/2.0",
      "Referer": `${TRANSFONTER_ORIGIN}/`,
      "Origin": TRANSFONTER_ORIGIN,
      ...sessionCookie ? { Cookie: sessionCookie } : {}
    };
    const sourceExt = ["woff2", "woff", "ttf", "otf"].includes(sourceFormat) ? sourceFormat : "woff2";
    const upload = new FormData();
    upload.set("user_id", userId);
    const uploadBytes = new Uint8Array(buffer.length);
    uploadBytes.set(buffer);
    upload.set("files[]", new Blob([uploadBytes]), `${safeBase}.${sourceExt}`);
    const uploadResponse = await fetch(`${TRANSFONTER_ORIGIN}/fonts/upload`, {
      method: "POST",
      headers: sessionHeaders,
      body: upload
    });
    const uploadPayload = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !Array.isArray(uploadPayload?.files) || uploadPayload.files.length === 0) {
      throw new Error(uploadPayload?.error || `Transfonter upload failed (${uploadResponse.status}).`);
    }
    const settings = new URLSearchParams();
    settings.set("user_id", userId);
    settings.set("family", "1");
    if (fixVerticalMetrics) settings.set("fixVerticalMetrics", "1");
    settings.append("formats[]", normalizedTarget);
    settings.set("hinting", "");
    settings.set("language", "");
    settings.set("fontDisplay", "swap");
    const processResponse = await fetch(`${TRANSFONTER_ORIGIN}/fonts/process`, {
      method: "POST",
      headers: {
        ...sessionHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: settings
    });
    const processPayload = await processResponse.json().catch(() => ({}));
    if (!processResponse.ok || processPayload?.error || processPayload?.status === "error") {
      throw new Error(processPayload?.error || processPayload?.message || `Transfonter conversion request failed (${processResponse.status}).`);
    }
    let resultUrl = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const statusResponse = await fetch(`${TRANSFONTER_ORIGIN}/fonts/status?user_id=${encodeURIComponent(userId)}`, {
        headers: sessionHeaders
      });
      const status = await statusResponse.json().catch(() => ({}));
      if (status?.status === "success" && status?.result) {
        resultUrl = new URL2(String(status.result), TRANSFONTER_ORIGIN).href;
        break;
      }
      if (status?.status === "error" || status?.error) {
        throw new Error(status?.error || "Transfonter conversion failed.");
      }
    }
    if (!resultUrl) throw new Error("Transfonter conversion timed out.");
    const archiveResponse = await fetch(resultUrl, { headers: sessionHeaders });
    if (!archiveResponse.ok) throw new Error(`Transfonter result download failed (${archiveResponse.status}).`);
    const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
    const tempRoot = await fsp3.mkdtemp(path3.join(os3.tmpdir(), "cae-transfonter-"));
    try {
      const zipPath = path3.join(tempRoot, "result.zip");
      const outputDir = path3.join(tempRoot, "output");
      await fsp3.mkdir(outputDir, { recursive: true });
      await fsp3.writeFile(zipPath, archiveBuffer);
      await extractZip(zipPath, { dir: outputDir });
      const convertedFiles = await findFilesByExtension(outputDir, `.${normalizedTarget}`);
      if (convertedFiles.length === 0) throw new Error(`Transfonter result did not contain a ${normalizedTarget.toUpperCase()} file.`);
      const converted = await fsp3.readFile(convertedFiles[0]);
      if (normalizedTarget === "ttf" && !isInstallableTtfBuffer(converted)) {
        throw new Error("Transfonter returned a TTF that failed installability validation.");
      }
      if (normalizedTarget === "woff" && !isValidFontBuffer(converted, "woff")) {
        throw new Error("Transfonter returned a WOFF that failed validation.");
      }
      return converted;
    } finally {
      await fsp3.rm(tempRoot, { recursive: true, force: true }).catch(() => void 0);
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
var convertFontBufferToInstallableTtf = async (buffer, filenameBase, sourceFormat, fixVerticalMetrics = true) => {
  try {
    return await convertFontBufferWithTransfonter(buffer, filenameBase, sourceFormat, fixVerticalMetrics);
  } catch {
    return convertFontBufferWithFontForge(buffer, filenameBase, sourceFormat);
  }
};
var getInnerFontBuffer = async (buffer, readFormat) => {
  if (readFormat === "woff2") {
    await ensureWoff2Ready();
    const inner = fontOutputToBuffer(woff2.decode(bufferToExactArrayBuffer(buffer)));
    const innerFormat = inner.slice(0, 4).toString("latin1") === "OTTO" ? "otf" : "ttf";
    return { buffer: inner, format: innerFormat };
  }
  if (readFormat === "woff") {
    try {
      const font = Font.create(buffer, { type: "woff" });
      const inner = fontOutputToBuffer(font.write({ type: "ttf" }));
      const innerFormat = inner.slice(0, 4).toString("latin1") === "OTTO" ? "otf" : "ttf";
      return { buffer: inner, format: innerFormat };
    } catch {
      const parsed = opentype.parse(bufferToExactArrayBuffer(buffer));
      const out = Buffer.from(parsed.toArrayBuffer());
      const outMagic = out.slice(0, 4).toString("latin1");
      const outFormat = outMagic === "OTTO" ? "otf" : "ttf";
      return { buffer: out, format: outFormat };
    }
  }
  if (readFormat === "ttf" || readFormat === "otf") {
    return { buffer, format: readFormat };
  }
  return { buffer, format: readFormat };
};
var pickOpenTypeName = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object") return "";
  const names = value;
  const preferredKeys = ["en", "en-US", "en-us", "en_GB", "en-gb"];
  for (const key of preferredKeys) {
    const candidate = names[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const first = Object.values(names).find((item) => typeof item === "string" && item.trim());
  return typeof first === "string" ? first.trim() : "";
};
var splitPostScriptFontName = (value) => String(value || "").replace(/[-_](?:Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black|Italic|Oblique)+$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
var readVariableAxesFromSfnt = (buffer) => {
  const result = { weightRange: "", italic: false };
  if (buffer.length < 12) return result;
  const tableCount = buffer.readUInt16BE(4);
  for (let index = 0; index < tableCount; index += 1) {
    const offset = 12 + index * 16;
    if (offset + 16 > buffer.length || buffer.toString("latin1", offset, offset + 4) !== "fvar") continue;
    const tableOffset = buffer.readUInt32BE(offset + 8);
    const tableLength = buffer.readUInt32BE(offset + 12);
    if (tableOffset + Math.min(tableLength, 16) > buffer.length || tableOffset + 16 > buffer.length) return result;
    const axisOffset = buffer.readUInt16BE(tableOffset + 4);
    const axisCount = buffer.readUInt16BE(tableOffset + 8);
    const axisSize = buffer.readUInt16BE(tableOffset + 10);
    if (axisSize < 20) return result;
    for (let axis = 0; axis < axisCount; axis += 1) {
      const axisRecord = tableOffset + axisOffset + axis * axisSize;
      if (axisRecord + 20 > buffer.length) continue;
      const tag = buffer.toString("latin1", axisRecord, axisRecord + 4);
      if (tag === "ital") {
        result.italic = buffer.readInt32BE(axisRecord + 12) / 65536 > 0;
        continue;
      }
      if (tag !== "wght") continue;
      const min = buffer.readInt32BE(axisRecord + 4) / 65536;
      const max = buffer.readInt32BE(axisRecord + 12) / 65536;
      if (Number.isFinite(min) && Number.isFinite(max) && min < max) result.weightRange = `${Math.round(min)} ${Math.round(max)}`;
    }
  }
  return result;
};
var readFontNameMetadataFromBuffer = async (buffer, formatHint = "") => {
  const detected = detectFontFormatFromBuffer(buffer);
  const readFormat = detected || normalizeFontFormat(formatHint);
  if (!["woff2", "woff", "ttf", "otf"].includes(readFormat)) return null;
  const { buffer: innerBuffer } = await getInnerFontBuffer(buffer, readFormat);
  const parsed = opentype.parse(bufferToExactArrayBuffer(innerBuffer));
  const names = parsed?.names || {};
  const family = pickOpenTypeName(names.preferredFamily) || pickOpenTypeName(names.typographicFamily) || pickOpenTypeName(names.fontFamily);
  const subfamily = pickOpenTypeName(names.preferredSubfamily) || pickOpenTypeName(names.typographicSubfamily) || pickOpenTypeName(names.fontSubfamily);
  const fullName = pickOpenTypeName(names.fullName);
  const postScriptName = pickOpenTypeName(names.postScriptName);
  const postScriptFamily = splitPostScriptFontName(postScriptName);
  const variableAxes = readVariableAxesFromSfnt(innerBuffer);
  return {
    family,
    name: fullName || postScriptName,
    title: fullName || family || postScriptName,
    filename: postScriptName || fullName,
    style: subfamily && !/^(regular|normal)$/i.test(subfamily) ? subfamily : "",
    postScriptName,
    postScriptFamily,
    variableWeightRange: variableAxes.weightRange,
    variableItalicAxis: variableAxes.italic
  };
};
var shouldResolveFontMetadata = (font) => {
  if (/^\d{2,3}\s+\d{2,3}$/.test(String(font?.weight || "").trim())) return true;
  const label = String(font?.family || font?.title || font?.name || font?.filename || "").trim();
  if (!label) return true;
  if (isJunkFontLabel(label)) return true;
  if (/\bweb font\s+\d+$/i.test(label)) return true;
  if (/\bvariable\b/i.test(label)) return true;
  const urlBase = filenameFromUrlPath2(String(font?.url || font?.cachedUrl || "")).replace(/\.[^/.]+$/, "");
  if (urlBase && label.replace(/[^a-z0-9]+/gi, "").toLowerCase() === urlBase.replace(/[^a-z0-9]+/gi, "").toLowerCase()) {
    return true;
  }
  return false;
};
var FONT_METADATA_CACHE = /* @__PURE__ */ new Map();
var resolveFontMetadata = async (font, targetUrl) => {
  const url = String(font?.url || "").trim();
  if (!url || url.startsWith("data:")) return null;
  if (FONT_METADATA_CACHE.has(url) && FONT_METADATA_CACHE.get(url)) return FONT_METADATA_CACHE.get(url) || null;
  try {
    assertPublicAssetUrl(url);
    const referer = resolveFontRefererPage(String(font?.cssSource || ""), targetUrl);
    let buffer;
    let contentType = String(font?.format || "");
    try {
      const response = await withTimeout(
        axios.get(url, {
          responseType: "arraybuffer",
          timeout: 6500,
          maxContentLength: 4 * 1024 * 1024,
          httpsAgent: relaxedHttpsAgent,
          validateStatus: (status) => status >= 200 && status < 300,
          headers: {
            "User-Agent": PAGE_FETCH_USER_AGENTS[0],
            Accept: "font/woff2,font/woff,font/ttf,font/otf,*/*;q=0.1",
            ...referer ? { Referer: referer } : {}
          }
        }),
        8e3,
        `Font metadata read for ${url}`
      );
      buffer = Buffer.from(response.data);
      contentType = String(response.headers?.["content-type"] || contentType);
    } catch {
      const fetched = await fetchRemoteFontBuffer(url, referer);
      buffer = fetched.buffer;
      contentType = fetched.contentType || contentType;
    }
    const format = detectFontFormatFromBuffer(buffer) || getFontFormatFromUrlOrType(url, contentType);
    const metadata = await readFontNameMetadataFromBuffer(buffer, format);
    const family = String(metadata?.family || metadata?.postScriptFamily || "").trim();
    const cleanMetadata = family && !isJunkFontLabel(family) ? { ...metadata, family } : metadata?.variableWeightRange ? { ...metadata, family: "" } : null;
    FONT_METADATA_CACHE.set(url, cleanMetadata);
    return cleanMetadata;
  } catch {
    return null;
  }
};
var enrichFontsWithMetadata = async (fonts, targetUrl, options = {}) => {
  const candidates = fonts.filter((font) => font?.url && shouldResolveFontMetadata(font));
  if (candidates.length === 0) return fonts;
  const limit = options.fast ? 12 : 28;
  const uniqueCandidates = Array.from(new Map(candidates.map((font) => [String(font.url), font])).values()).slice(0, limit);
  const metadataByUrl = /* @__PURE__ */ new Map();
  await mapWithConcurrency(uniqueCandidates, 4, async (font) => {
    const metadata = await resolveFontMetadata(font, targetUrl);
    if (metadata) metadataByUrl.set(String(font.url), metadata);
  });
  if (metadataByUrl.size === 0) return fonts;
  return fonts.map((font) => {
    const metadata = metadataByUrl.get(String(font?.url || ""));
    if (!metadata) return font;
    return {
      ...font,
      title: metadata.title || font.title,
      name: metadata.name || font.name,
      filename: metadata.filename || font.filename,
      family: metadata.family || font.family,
      style: font.style || metadata.style || void 0,
      variableWeightRange: metadata.variableWeightRange || font.variableWeightRange || "",
      variableItalicAxis: Boolean(metadata.variableItalicAxis || font.variableItalicAxis),
      fontMetadata: {
        postScriptName: metadata.postScriptName || ""
      }
    };
  });
};
var writeFontBuffer = async (innerBuffer, innerFormat, toFormat) => {
  if (toFormat === innerFormat) return innerBuffer;
  if (toFormat === "woff2" && (innerFormat === "ttf" || innerFormat === "otf")) {
    await ensureWoff2Ready();
    return fontOutputToBuffer(woff2.encode(bufferToExactArrayBuffer(innerBuffer)));
  }
  if (toFormat === "woff" && (innerFormat === "ttf" || innerFormat === "otf")) {
    const font2 = Font.create(innerBuffer, { type: innerFormat });
    return fontOutputToBuffer(font2.write({ type: "woff" }));
  }
  const font = Font.create(innerBuffer, { type: innerFormat });
  return fontOutputToBuffer(font.write({ type: toFormat }));
};
var fontConvertWorkerPath = () => path3.join(getAppRoot(), "server", "font-convert-worker.mjs");
var extractWorkerPath = () => path3.join(getAppRoot(), "server", "extract-workers.mjs");
var quickExtractInWorker = async (targetUrl) => {
  const worker = new Worker(extractWorkerPath(), {
    workerData: { task: "quickExtract", payload: { targetUrl } }
  });
  return new Promise((resolve, reject) => {
    worker.once("message", (message) => {
      worker.terminate().catch(() => void 0);
      if (!message?.ok) {
        reject(new Error(message?.error || "Worker quick extract failed"));
        return;
      }
      resolve(message.result);
    });
    worker.once("error", (error) => {
      worker.terminate().catch(() => void 0);
      reject(error);
    });
    setTimeout(() => {
      worker.terminate().catch(() => void 0);
      reject(new Error("Worker quick extract timed out"));
    }, 15e3);
  });
};
var convertFontBufferOffThread = async (buffer, fromFormat, toFormat) => new Promise((resolve, reject) => {
  const worker = new Worker(fontConvertWorkerPath(), {
    workerData: {
      bufferBase64: buffer.toString("base64"),
      fromFormat,
      toFormat
    }
  });
  worker.once("message", (message) => {
    worker.terminate().catch(() => void 0);
    if (!message?.ok || !message.bufferBase64) {
      reject(new Error(message?.error || "Font conversion failed in worker thread."));
      return;
    }
    resolve(Buffer.from(message.bufferBase64, "base64"));
  });
  worker.once("error", (error) => {
    worker.terminate().catch(() => void 0);
    reject(error);
  });
});
var convertFontBuffer = async (url, buffer, fromFormat, toFormat, contentType = "", preferInlineConversion = false) => {
  const detected = detectFontFormatFromBuffer(buffer);
  let readFormat = detected || normalizeFontFormat(fromFormat, contentType);
  if (!["ttf", "woff", "woff2", "eot", "otf", "svg"].includes(readFormat)) {
    throw new Error(`Unsupported or undetectable original font format: ${readFormat || "unknown"}`);
  }
  if (readFormat === toFormat) {
    return buffer;
  }
  const convertInline = async () => {
    const { buffer: innerBuffer, format: innerFormat } = await getInnerFontBuffer(buffer, readFormat);
    if (toFormat === "ttf" && innerFormat === "otf") {
      throw new Error("CFF/OpenType outlines cannot be safely converted to an installable macOS TTF.");
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
  } catch (workerError) {
    return convertInline();
  }
};
var GOOGLE_INSTALLABLE_FONT_CACHE = /* @__PURE__ */ new Map();
var FONT_CSS_IDENTITY_CACHE = /* @__PURE__ */ new Map();
var resolveFontIdentityFromCssSource = async (cssSource, fontUrl) => {
  const cssUrl = String(cssSource || "").trim();
  const requestedUrl = normalizeAssetRequestUrl(String(fontUrl || "").trim());
  if (!cssUrl || !requestedUrl || !/^https?:\/\//i.test(cssUrl)) return null;
  let pending = FONT_CSS_IDENTITY_CACHE.get(cssUrl);
  if (!pending) {
    pending = (async () => {
      assertPublicAssetUrl(cssUrl);
      const response = await axios.get(cssUrl, {
        timeout: 1e4,
        responseType: "text",
        maxContentLength: 4 * 1024 * 1024,
        httpsAgent: relaxedHttpsAgent,
        ...axiosProxyOptions(),
        validateStatus: (status) => status === 200,
        headers: {
          "User-Agent": PAGE_FETCH_USER_AGENTS[0],
          Accept: "text/css,*/*;q=0.1"
        }
      });
      return extractFontsFromCss(String(response.data || ""), cssUrl);
    })();
    FONT_CSS_IDENTITY_CACHE.set(cssUrl, pending);
  }
  try {
    const fonts = await pending;
    return fonts.find((font) => normalizeAssetRequestUrl(String(font?.url || "")) === requestedUrl) || null;
  } catch {
    FONT_CSS_IDENTITY_CACHE.delete(cssUrl);
    return null;
  }
};
var normalizeFontFamilyCompare = (value) => String(value || "").replace(/^["']+|["']+$/g, "").replace(/\+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
var resolveGoogleInstallableFontSource = async (extras = {}) => {
  const cssSource = String(extras.cssSource || "").trim();
  if (!/fonts\.googleapis\.com/i.test(cssSource)) return null;
  const familyWanted = normalizeFontFamilyCompare(extras.fontFamily || extras.metadataFilename || "");
  const weightWanted = String(extras.fontWeight || "").trim() || "400";
  const styleWanted = String(extras.fontStyle || "").trim().toLowerCase() || "normal";
  const cacheKey = `${cssSource}|${familyWanted}|${weightWanted}|${styleWanted}`;
  if (GOOGLE_INSTALLABLE_FONT_CACHE.has(cacheKey)) return GOOGLE_INSTALLABLE_FONT_CACHE.get(cacheKey);
  try {
    assertPublicAssetUrl(cssSource);
    const response = await axios.get(cssSource, {
      timeout: 1e4,
      httpsAgent: relaxedHttpsAgent,
      ...axiosProxyOptions(),
      validateStatus: (status) => status === 200,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/css,*/*;q=0.1"
      }
    });
    const css = String(response.data || "");
    const directFonts = [];
    for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const block = match[1] || "";
      const family = normalizeFontFamilyCompare(block.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/i)?.[1] || "");
      const weight = String(block.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || "400").trim();
      const style = String(block.match(/font-style\s*:\s*([^;]+)/i)?.[1] || "normal").trim().toLowerCase();
      const unicodeRange = String(block.match(/unicode-range\s*:\s*([^;]+)/i)?.[1] || "").trim();
      const src = block.match(/url\(\s*['"]?([^'")]+?\.(?:ttf|woff2?|otf)(?:[?#][^'")]+)?)['"]?\s*\)/i)?.[1] || "";
      const format = getFontFormatFromUrlOrType(src, block);
      if (!src || !/^https?:\/\//i.test(src)) continue;
      directFonts.push({ family, weight, style, unicodeRange, url: src, format, cssSource });
    }
    const scored = directFonts.filter((font) => {
      if (familyWanted && font.family && font.family !== familyWanted) return false;
      if (weightWanted && font.weight && font.weight !== weightWanted) return false;
      if (styleWanted && font.style && font.style !== styleWanted) return false;
      return true;
    }).sort((a, b) => {
      const aUrl = String(a?.url || "");
      const bUrl = String(b?.url || "");
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
var convertFontAsset = async (url, toFormat, originalFormat = "unknown", preferredBase, extras = {}) => {
  const normalizedTarget = normalizeFontFormat(toFormat);
  const normalizedOriginal = normalizeFontFormat(originalFormat);
  const maxAttempts = normalizedTarget && normalizedTarget === normalizedOriginal ? 1 : 2;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTimeout(
        getCachedConvertedFont(url, toFormat, originalFormat, preferredBase, extras),
        extras.timeoutMs || 1e4 + attempt * 5e3,
        `Font conversion (${toFormat})`
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error?.message || error || "Font conversion failed"));
      const retryable = /timeout|fetch|network|econnreset|socket|temporarily/i.test(String(lastError.message));
      if (attempt < maxAttempts && retryable) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 350));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error("Font conversion failed.");
};
var fetchOriginalFontBufferForFallback = async (url, originalFormat, preferredBase, extras) => {
  const sourceFormat = normalizeFontFormat(originalFormat);
  return convertFontAsset(url, sourceFormat, originalFormat, preferredBase, { ...extras, cacheOnly: false });
};
var getCachedConvertedFont = async (url, toFormat = "ttf", originalFormat = "unknown", preferredBase, extras = {}) => {
  await fsp3.mkdir(cachedFontDir, { recursive: true });
  const normalizedTarget = ["ttf", "woff", "woff2", "eot", "otf", "svg"].includes(toFormat) ? toFormat : "ttf";
  const cacheSourceUrl = normalizeAssetRequestUrl(String(extras.originalUrl || "").trim()) || normalizeAssetRequestUrl(url) || url;
  if (normalizedTarget === "ttf" && String(extras.cssSource || "").trim()) {
    const cssIdentity = await resolveFontIdentityFromCssSource(String(extras.cssSource), cacheSourceUrl);
    if (cssIdentity?.family && !isGenericFontFamilyIdentity(cssIdentity.family)) {
      const extractedFamily = String(extras.fontFamily || "").trim();
      const cssFamily = String(cssIdentity.family).trim();
      const resolvedFamily = extractedFamily && !isGenericFontFamilyIdentity(extractedFamily) && normalizeFontIdentityCompare(extractedFamily) === normalizeFontIdentityCompare(cssFamily) ? extractedFamily : cssFamily;
      const requestedWeight = String(extras.fontWeight || "").trim();
      const cssWeight = String(cssIdentity.weight || "").trim();
      const keepRequestedVariableWeight = /^\d{2,3}$/.test(requestedWeight) && /^\d{2,3}\s+\d{2,3}$/.test(cssWeight);
      extras = {
        ...extras,
        fontFamily: resolvedFamily,
        fontWeight: keepRequestedVariableWeight ? requestedWeight : cssWeight || requestedWeight,
        fontStyle: String(cssIdentity.style || extras.fontStyle || "")
      };
    }
  }
  const ttfIdentity = buildTtfIdentityBase(preferredBase, extras);
  const cacheIdentity = normalizedTarget === "ttf" ? `${cacheSourceUrl}#installable-ttf-v17-unicode-subsets-${encodeURIComponent(ttfIdentity)}-metrics-${extras.fixVerticalMetrics === false ? "off" : "on"}` : cacheSourceUrl;
  const cachePath = path3.join(cachedFontDir, `${assetCacheKey(cacheIdentity, normalizedTarget)}.${normalizedTarget}`);
  const filenameSourceUrl = extras.originalUrl || url;
  const filenameExtras = {
    contentDisposition: extras.contentDisposition,
    metadataFilename: extras.metadataFilename
  };
  let cached = await readCachedFileIfExists(cachePath);
  if (cached && /fonts\.googleapis\.com/i.test(String(extras.cssSource || "")) && ["ttf", "woff"].includes(normalizedTarget)) {
    await fsp3.unlink(cachePath).catch(() => void 0);
    cached = null;
  }
  if (cached && !isValidFontBuffer(cached, normalizedTarget)) {
    await fsp3.unlink(cachePath).catch(() => void 0);
    cached = null;
  }
  if (cached) {
    return {
      buffer: cached,
      format: normalizedTarget,
      filename: buildDownloadFilename(filenameSourceUrl, normalizedTarget, preferredBase, filenameExtras)
    };
  }
  let fetched;
  const cacheOnly = Boolean(extras.cacheOnly);
  const remoteOriginal = String(extras.originalUrl || "").trim();
  const refererPage = String(extras.refererPageUrl || "").trim() || (remoteOriginal.startsWith("http") && !isLikelyFontAssetUrl(remoteOriginal) ? remoteOriginal : "");
  if (extras.prefetched?.buffer?.length) {
    fetched = extras.prefetched;
  } else {
    try {
      const googleInstallable = await resolveGoogleInstallableFontSource(extras);
      const effectiveUrl = googleInstallable?.url && ["ttf", "otf", "woff", "woff2"].includes(String(googleInstallable.format || "").toLowerCase()) ? String(googleInstallable.url) : url;
      const effectiveOriginal = googleInstallable?.url && googleInstallable.url !== url ? String(googleInstallable.url) : extras.originalUrl || "";
      const effectiveFormat = googleInstallable?.format ? String(googleInstallable.format) : originalFormat;
      fetched = await fetchAssetBuffer(url, extras.originalUrl || "", { cacheOnly, refererPageUrl: refererPage });
      if (effectiveUrl !== url && !cacheOnly) {
        fetched = await fetchAssetBuffer(effectiveUrl, effectiveOriginal, {
          cacheOnly: false,
          refererPageUrl: extras.cssSource || refererPage
        });
        originalFormat = effectiveFormat;
        url = effectiveUrl;
      }
    } catch (primaryFetchError) {
      const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
      if (siblingUrl !== url) {
        fetched = await fetchAssetBuffer(siblingUrl, extras.originalUrl || "", { cacheOnly, refererPageUrl: refererPage });
      } else {
        throw primaryFetchError;
      }
    }
  }
  const expectedSourceFormat = getFontFormatFromUrlOrType(url, fetched.contentType);
  const fetchedDetected = detectFontFormatFromBuffer(fetched.buffer);
  if (!isValidFontOriginalBuffer(fetched.buffer, fetched.contentType)) {
    if (remoteOriginal.startsWith("http") && remoteOriginal !== url && !cacheOnly) {
      try {
        fetched = await fetchRemoteFontBuffer(remoteOriginal, refererPage);
      } catch {
        throw new Error(`Downloaded asset is not a valid font: ${url}`);
      }
    } else {
      throw new Error(`Downloaded asset is not a valid font: ${url}`);
    }
  } else if (fetchedDetected && expectedSourceFormat !== "unknown" && fetchedDetected !== expectedSourceFormat && remoteOriginal.startsWith("http") && remoteOriginal !== url) {
    try {
      fetched = await fetchAssetBuffer(remoteOriginal, remoteOriginal, { cacheOnly: false, refererPageUrl: refererPage });
    } catch {
    }
  }
  let outputBuffer = fetched.buffer;
  let conversionProvider = "local";
  const detected = detectFontFormatFromBuffer(fetched.buffer);
  let fromFormat = detected || normalizeFontFormat(originalFormat || getFontFormatFromUrlOrType(url, fetched.contentType), fetched.contentType);
  if (normalizedTarget === "ttf" && fromFormat !== "ttf" && !cacheOnly) {
    if (extras.preferInlineConversion) {
      try {
        const inlineTtf = await convertFontBuffer(
          url,
          fetched.buffer,
          fromFormat,
          "ttf",
          fetched.contentType,
          true
        );
        if (!isInstallableTtfBuffer(inlineTtf)) {
          throw new Error("Local TTF output failed installability validation.");
        }
        outputBuffer = inlineTtf;
        conversionProvider = "local-inline";
      } catch {
        outputBuffer = await convertFontBufferToInstallableTtf(
          fetched.buffer,
          preferredBase || extras.fontFamily || "font",
          fromFormat,
          extras.fixVerticalMetrics !== false
        );
        conversionProvider = "transfonter";
      }
    } else {
      outputBuffer = await convertFontBufferToInstallableTtf(
        fetched.buffer,
        preferredBase || extras.fontFamily || "font",
        fromFormat,
        extras.fixVerticalMetrics !== false
      );
      conversionProvider = "transfonter";
    }
  } else if (normalizedTarget === "woff" && fromFormat !== "woff" && !cacheOnly) {
    try {
      outputBuffer = await convertFontBuffer(
        url,
        fetched.buffer,
        fromFormat,
        "woff",
        fetched.contentType,
        true
      );
      if (!isValidFontBuffer(outputBuffer, "woff")) {
        throw new Error("Local WOFF conversion returned an invalid WOFF binary.");
      }
      conversionProvider = "local";
    } catch (localWoffError) {
      if (cacheOnly) throw localWoffError;
      outputBuffer = await convertFontBufferWithTransfonter(
        fetched.buffer,
        preferredBase || extras.fontFamily || "font",
        fromFormat,
        extras.fixVerticalMetrics !== false,
        "woff"
      );
      if (!isValidFontBuffer(outputBuffer, "woff")) {
        throw new Error("Transfonter WOFF conversion returned an invalid WOFF binary.");
      }
      conversionProvider = "transfonter";
    }
  } else try {
    outputBuffer = await convertFontBuffer(
      url,
      fetched.buffer,
      fromFormat,
      normalizedTarget,
      fetched.contentType,
      Boolean(extras.preferInlineConversion)
    );
  } catch (convertError) {
    if (normalizedTarget === "ttf" && !cacheOnly) {
      outputBuffer = await convertFontBufferToInstallableTtf(
        fetched.buffer,
        preferredBase || extras.fontFamily || "font",
        fromFormat,
        extras.fixVerticalMetrics !== false
      );
      conversionProvider = "transfonter";
    } else if (normalizedTarget === "woff" && !cacheOnly) {
      outputBuffer = await convertFontBufferWithTransfonter(
        fetched.buffer,
        preferredBase || extras.fontFamily || "font",
        fromFormat,
        extras.fixVerticalMetrics !== false,
        "woff"
      );
      conversionProvider = "transfonter";
    } else {
      if (cacheOnly) throw convertError;
      const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
      if (siblingUrl !== url) {
        const sibling = await fetchAssetBuffer(siblingUrl, extras.originalUrl || "", { cacheOnly, refererPageUrl: refererPage });
        const siblingDetected = detectFontFormatFromBuffer(sibling.buffer);
        const siblingFrom = siblingDetected || normalizeFontFormat(getFontFormatFromUrlOrType(siblingUrl, sibling.contentType), sibling.contentType);
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
  if (normalizedTarget === "ttf" && !isInstallableTtfBuffer(outputBuffer) && !cacheOnly && fromFormat !== "ttf") {
    outputBuffer = await convertFontBufferToInstallableTtf(
      fetched.buffer,
      preferredBase || extras.fontFamily || "font",
      fromFormat,
      extras.fixVerticalMetrics !== false
    );
    conversionProvider = "transfonter";
  }
  if (normalizedTarget === "ttf") {
    outputBuffer = repairTtfNameTable(outputBuffer, ttfIdentity);
  }
  if (!isValidFontBuffer(outputBuffer, normalizedTarget)) {
    throw new Error(`Converted font is not valid ${normalizedTarget.toUpperCase()} binary`);
  }
  if (!cacheOnly) {
    await fsp3.writeFile(cachePath, outputBuffer);
  }
  return {
    buffer: outputBuffer,
    format: normalizedTarget,
    conversionProvider,
    filename: buildDownloadFilename(filenameSourceUrl, normalizedTarget, preferredBase, {
      ...filenameExtras,
      contentDisposition: fetched.contentDisposition || filenameExtras.contentDisposition
    })
  };
};
var cleanRawAssetUrl = (value) => decodeCssUrlValue(String(value || "")).replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/[)\]};,]+$/g, "").trim();
var readExistingOriginalAssetUrl = async (url, kind) => {
  const existing = await resolveOriginalCachedAsset(url, kind);
  return existing?.cachedUrl || "";
};
var warmCachedOriginalAssetForExtraction = async (url, kind, hintType = "bin", options = {}) => {
  const existing = await resolveOriginalCachedAsset(url, kind);
  if (existing) {
    try {
      const current = await fsp3.readFile(existing.filePath);
      const currentType = guessContentTypeFromPath(existing.filePath);
      const valid = kind === "image" ? isValidImageBuffer(current, currentType) : isValidFontOriginalBuffer(current, currentType);
      if (valid) {
        const meta2 = kind === "image" ? enrichImageAssetMeta({}, current, currentType) : {};
        return {
          ok: true,
          cachedUrl: existing.cachedUrl,
          bytes: meta2.bytes,
          width: meta2.width,
          height: meta2.height
        };
      }
      await fsp3.unlink(existing.filePath).catch(() => void 0);
    } catch {
    }
  }
  const refererPage = resolveFontRefererPage("", String(options.refererPageUrl || ""));
  let buffer;
  let contentType = "";
  let contentDisposition = "";
  if (kind === "font") {
    try {
      const fetched = await fetchRemoteFontBuffer(url, refererPage);
      buffer = fetched.buffer;
      contentType = fetched.contentType;
      contentDisposition = String(fetched.contentDisposition || "");
    } catch {
      return { ok: false, cachedUrl: "" };
    }
  } else {
    try {
      const fetched = await withTimeout(
        fetchRemoteImageBuffer(url, refererPage, { skipBrowser: options.skipBrowser }),
        2e4,
        `${kind} warm for ${url}`
      );
      if (!fetched) return { ok: false, cachedUrl: "" };
      buffer = fetched.buffer;
      contentType = fetched.contentType;
      contentDisposition = String(fetched.contentDisposition || "");
    } catch {
      return { ok: false, cachedUrl: "" };
    }
  }
  const maxBytes = kind === "image" ? 15 * 1024 * 1024 : 10 * 1024 * 1024;
  if (buffer.length <= 0 || buffer.length > maxBytes) return { ok: false, cachedUrl: "" };
  if (kind === "image" && !isValidImageBuffer(buffer, contentType)) return { ok: false, cachedUrl: "" };
  if (kind === "font" && !isValidFontOriginalBuffer(buffer, contentType)) return { ok: false, cachedUrl: "" };
  const cachedUrl = await writeOriginalCachedAsset(url, kind, buffer, {
    contentType,
    contentDisposition,
    hintType,
    preferredBase: options.preferredBase,
    metadataFilename: options.metadataFilename
  });
  if (kind === "image" && cachedUrl && /\.(?:webp|avif)(?:[?#]|$)/i.test(url)) {
    void warmRasterConversionVariants(url, cachedUrl).catch(() => void 0);
  }
  if (kind === "font" && cachedUrl) {
    void warmFontConversionVariants(url, cachedUrl, hintType, {
      refererPageUrl: String(options.refererPageUrl || "")
    }).catch(() => void 0);
  }
  const meta = kind === "image" ? enrichImageAssetMeta({}, buffer, contentType) : {};
  return {
    ok: Boolean(cachedUrl),
    cachedUrl,
    bytes: meta.bytes,
    width: meta.width,
    height: meta.height
  };
};
var extractAssetsFromRawText = (text, baseUrl) => {
  const images = [];
  const videos = [];
  const fonts = [];
  const raw = String(text || "").replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const assetRegex = /(?:https?:\/\/|\/\/|\/|\.{1,2}\/)[^"'`<>\s\\)]+?\.(?:jpe?g|png|webp|gif|avif|svg|mp4|webm|m3u8|mov|woff2?|ttf|otf|eot)(?=$|[?#"'`<>\s\\)])(?:[?#][^"'`<>\s\\)]*)?/gi;
  let match;
  while ((match = assetRegex.exec(raw)) !== null) {
    const cleaned = cleanRawAssetUrl(match[0]);
    const resolved = resolveUrl(baseUrl, cleaned);
    if (!resolved || resolved.startsWith("data:") || resolved.startsWith("blob:")) continue;
    if (isWistiaHelperResourceUrl(resolved)) {
      if (isWistiaSwatchUrl(resolved)) {
        addImageCandidate(images, resolved, baseUrl, { status: DEFAULT_ASSET_STATUS, type: "webp" }, { permissive: true });
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
        status: DEFAULT_ASSET_STATUS
      });
    } else if (/\.(?:woff2|ttf|otf)(?:[?#]|$)/i.test(resolved)) {
      const format = getFontFormatFromUrlOrType(resolved);
      if (!isSupportedFontFormat(format)) continue;
      const filenameBase = filenameFromUrlPath2(resolved).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
      const readableFilename = filenameBase && !/^[0-9a-f]{8,}(?: s p)?$/i.test(filenameBase) && !isJunkFontLabel(filenameBase);
      let hostLabel = "Website";
      try {
        const hostname = new URL2(resolved).hostname.replace(/^www\./i, "").split(".");
        hostLabel = hostname.length > 1 ? hostname[hostname.length - 2] : hostname[0] || hostLabel;
        hostLabel = hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1);
      } catch {
      }
      fonts.push({
        family: readableFilename ? filenameBase : `${hostLabel} Web Font ${fonts.length + 1}`,
        url: resolved,
        format,
        cssSource: baseUrl,
        status: DEFAULT_ASSET_STATUS
      });
    }
  }
  const wistiaSwatchRegex = /https?:\/\/fast\.wistia\.(?:com|net)\/embed\/medias\/[a-z0-9]{8,12}\/swatch(?:[?#][^"'`<>\s\\)]*)?/gi;
  while ((match = wistiaSwatchRegex.exec(raw)) !== null) {
    const resolved = resolveUrl(baseUrl, cleanRawAssetUrl(match[0]));
    if (resolved && isWistiaSwatchUrl(resolved)) {
      addImageCandidate(images, resolved, baseUrl, { status: DEFAULT_ASSET_STATUS, type: "webp" }, { permissive: true });
    }
  }
  return { images, videos, fonts };
};
var normalizeExactBlockText = (value) => String(value || "").replace(/\r/g, "").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
var extractPharmaBlocksFromText = (items) => {
  const indication = [];
  const isi = [];
  items.forEach((raw) => {
    const text = normalizeExactBlockText(raw);
    if (text.length < 40 || isBotWallText(text)) return;
    const lower = text.toLowerCase();
    const firstLine = (text.split("\n").find((line) => line.trim()) || "").toLowerCase();
    const looksIsi = lower.includes("important safety information") || /^important safety\b/i.test(firstLine) || /^warnings and precautions\b/i.test(firstLine) || lower.includes("see full prescribing information") || lower.includes("full prescribing information") || lower.includes("boxed warning") || /\bisi\b/i.test(firstLine) && /(warning|adverse|contraindic)/i.test(lower);
    const looksIndication = !looksIsi && (/^indication(s)?(\s+and\s+usage)?\b/i.test(firstLine) || /\bindicated for\b/i.test(lower) || /\bis indicated\b/i.test(lower) || /\bapproved for\b/i.test(lower) || /\bfor the treatment of\b/i.test(lower) || /\bindication\(s\)?\s*:/i.test(lower) || /\bindication(s)?\b/i.test(firstLine) && /\bindicated\b/i.test(lower));
    if (looksIndication) indication.push(text);
    if (looksIsi) isi.push(text);
  });
  return { indication, isi };
};
var extractIndicationBlocksFromHtml = (html) => {
  const blocks = [];
  const $ = cheerio.load(html || "");
  $('[id*="indication" i], [class*="indication" i], [data-module*="indication" i], [data-section*="indication" i]').each((_, el) => {
    const text = normalizeExactBlockText($(el).text());
    if (text.length > 40 && !isBotWallText(text)) blocks.push(text);
  });
  $("h1,h2,h3,h4,strong,b,span").each((_, el) => {
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (!/^indication(s)?(\s+and\s+usage)?$/i.test(title)) return;
    const parentText = normalizeExactBlockText($(el).parent().text());
    if (parentText.length > 40 && !isBotWallText(parentText)) blocks.push(parentText);
  });
  return blocks;
};
var extractIsiBlocksFromHtml = (html) => {
  const blocks = [];
  const $ = cheerio.load(html || "");
  $('[id*="isi" i], [class*="isi" i], [data-module*="isi" i], [data-section*="isi" i], [class*="important-information" i], [class*="safety-information" i]').each((_, el) => {
    const text = normalizeExactBlockText($(el).text());
    if (text.length > 40 && !isBotWallText(text)) blocks.push(text);
  });
  $("h1,h2,h3,h4,h5,h6,strong,b,span,button").each((_, el) => {
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (!/^important safety information$/i.test(title)) return;
    const sectionText = normalizeExactBlockText(
      $(el).closest("section, article, div, footer, main").text() || $(el).parent().text()
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
var deriveIndicationFromIsi = (isiText) => {
  const text = normalizeExactBlockText(isiText);
  if (text.length < 40) return "";
  const patterns = [
    /(?:INDICATIONS?\s+(?:AND\s+USAGE\s*)?[:\-]?\s*)([\s\S]{40,2500}?)(?=\n\s*(?:IMPORTANT SAFETY|WARNINGS|CONTRAINDICATIONS|DOSAGE|ADVERSE|BOXED WARNING))/i,
    /(?:What is [^\n?]+\?\s*)([\s\S]{40,1500}?)(?=\n\s*(?:IMPORTANT|WARNINGS|Who should not))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match[1].trim().length > 40) return match[1].trim();
  }
  return "";
};
var isBotWallImageUrl = (url) => /robot-suspicion|loader\.svg|captcha|cf-chl|challenge-platform|akamai.*\.svg|datadome|waf/i.test(String(url || ""));
var isTrackingPixelImageUrl = (url) => {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;
  return /(?:^|[./-])(?:pixel|beacon|tracker|tracking|analytics|collect|rum-collector|clarity)(?:[./?_-]|$)/i.test(lowered) || /\/(?:1p|px|pixel|beacon)\.(?:gif|png|jpe?g|webp)(?:$|[?#])/i.test(lowered) || /(?:pingdom\.net|clarity\.ms|doubleclick\.net|googletagmanager\.com|google-analytics\.com|facebook\.com\/tr|unbxdapi\.com\/v2\/1p\.jpg)/i.test(lowered);
};
var isJpeg2000ImageVariantUrl = (url) => {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return false;
  if (/\.(?:jp2|j2k|jpf|jpx)(?:$|[?#])/i.test(lowered)) return true;
  try {
    const parsed = new URL2(String(url || "").replace(/&amp;/g, "&"));
    const fmt = String(parsed.searchParams.get("fmt") || parsed.searchParams.get("format") || parsed.searchParams.get("fm") || "").toLowerCase();
    return /^(?:jp2|j2k|jpf|jpx|jpeg2000|jpeg2000-alpha)$/.test(fmt);
  } catch {
    return /[?&](?:fmt|format|fm)=(?:jp2|j2k|jpf|jpx|jpeg2000|jpeg2000-alpha)(?:&|$)/i.test(lowered);
  }
};
var isJunkImageUrl = (url) => {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return true;
  if (isJpeg2000ImageVariantUrl(url)) return true;
  if (/^https?:\/\/[^/]+\/jcr:content\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|[?#])/i.test(lowered)) return true;
  if (/^https?:\/\/[^/]+\/jcr:content(?:$|[?#])/i.test(lowered)) return true;
  if (isTrackingPixelImageUrl(url)) return true;
  return false;
};
var IMAGE_DEDUPE_STRIP_PARAMS = /* @__PURE__ */ new Set([
  "w",
  "h",
  "width",
  "height",
  "mw",
  "mh",
  "quality",
  "q",
  "format",
  "fm",
  "auto",
  "fit",
  "crop",
  "scale",
  "dpr",
  "rev",
  "mode",
  "output"
]);
var isOpaqueGeneratedImageLeaf = (leaf) => {
  const name = String(leaf || "").trim().toLowerCase();
  if (!name) return true;
  if (/^image-\d+\.[a-z0-9]+$/i.test(name)) return true;
  if (/^[a-f0-9]{16,}(\-\d+)?\.[a-z0-9]+$/i.test(name)) return true;
  return false;
};
var canonicalImageDedupKey = (url) => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) {
    if (raw.length <= 280) return raw;
    return crypto2.createHash("sha1").update(raw).digest("hex");
  }
  try {
    const parsed = new URL2(raw);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const leaf = filenameFromUrlPath2(raw).toLowerCase();
    if (/\.svg$/i.test(parsed.pathname) && parsed.hash) {
      return `${host}:${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
    }
    const contextParam = parsed.searchParams.get("context");
    if (contextParam) {
      return `${host}:${parsed.pathname}?context=${contextParam}`.toLowerCase();
    }
    if (isLikely360SequenceUrl(raw)) {
      const sequencePath = parsed.pathname.replace(/^\/content\/dam\/toyota\/(?=jellies\/)/i, "/").replace(/^\/is\/image\/toyota\/toyota\/(?=jellies\/)/i, "/").replace(/\/{2,}/g, "/");
      return `sequence:${sequencePath}`.toLowerCase();
    }
    const magnoliaImagingSource = parsed.pathname.match(/^(\/\.imaging\/.*?)\/jcr:content(?:\.[a-z0-9]+)?$/i)?.[1];
    if (magnoliaImagingSource) return `${host}:imaging-source:${magnoliaImagingSource}`.toLowerCase();
    if (leaf && !isOpaqueGeneratedImageLeaf(leaf)) {
      return `${host}:file:${leaf}`;
    }
    const ashId = parsed.searchParams.get("id") || parsed.searchParams.get("mediaid") || parsed.searchParams.get("mid") || parsed.searchParams.get("assetid");
    if (/\.ashx$/i.test(parsed.pathname) && ashId) {
      return `${host}:ashx:${String(ashId).toLowerCase()}`;
    }
    const imagingMatch = parsed.pathname.match(/\.imaging\/[^/]+\/[^/]+\/jcr:([^/]+)/i);
    if (imagingMatch?.[1]) return `${host}:imaging:${imagingMatch[1].toLowerCase()}`;
    const normalizedPath = parsed.pathname.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "");
    IMAGE_DEDUPE_STRIP_PARAMS.forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = "";
    const search = parsed.searchParams.toString();
    return `${host}:${normalizedPath}${search ? `?${search}` : ""}`.toLowerCase();
  } catch {
    return raw.split("#")[0].replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").toLowerCase();
  }
};
var scoreImageRecord = (img) => {
  let score = 0;
  const url = String(img?.url || "");
  if (img?.cachedUrl) score += 50;
  if (img?.status === "downloaded") score += 40;
  if (img?.filename || img?.alt || img?.name) score += 20;
  try {
    const parsed = new URL2(url);
    const width = Number(parsed.searchParams.get("wid") || parsed.searchParams.get("width") || parsed.searchParams.get("w") || 0);
    const height = Number(parsed.searchParams.get("hei") || parsed.searchParams.get("height") || parsed.searchParams.get("h") || 0);
    const quality = Number(parsed.searchParams.get("qlt") || parsed.searchParams.get("quality") || parsed.searchParams.get("q") || 0);
    if (width > 0) score += Math.min(30, Math.round(width / 80));
    if (height > 0) score += Math.min(12, Math.round(height / 80));
    if (quality > 0) score += Math.min(10, Math.round(quality / 10));
    const fmt = String(parsed.searchParams.get("fmt") || parsed.searchParams.get("format") || "").toLowerCase();
    if (/jp2|j2k|jpf|jpx|jpeg2000/.test(fmt)) score -= 1e4;
    if (/jpg|jpeg|png/.test(fmt)) score += 5;
    if (/webp|avif/.test(fmt)) score += 2;
  } catch {
  }
  if (!/-\d+x\d+\./i.test(url)) score += 12;
  if (/\.(?:png|jpe?g|webp|avif)(\?|$)/i.test(url)) score += 8;
  if (/\.(?:jp2|j2k|jpf|jpx)(?:$|[?#])/i.test(url)) score -= 1e4;
  if (/[?&]context=/i.test(url)) score += 30;
  if (!/\.ashx(\?|$)/i.test(url)) score += 4;
  return score;
};
var dedupeImagesByCanonicalKey = (images) => {
  const groups = /* @__PURE__ */ new Map();
  for (const img of images) {
    const url = String(img?.url || "");
    if (!url) continue;
    const key = canonicalImageDedupKey(url);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(img);
    groups.set(key, bucket);
  }
  return Array.from(groups.values()).map(
    (group) => [...group].sort((a, b) => scoreImageRecord(b) - scoreImageRecord(a))[0]
  );
};
var parseExpandableImageSequence = (rawUrl) => {
  const value = String(rawUrl || "").replace(/&amp;/g, "&").trim();
  if (!value || !isLikely360SequenceUrl(value)) return null;
  let parsed;
  try {
    parsed = new URL2(value);
  } catch {
    return null;
  }
  if (parsed.pathname.includes("//")) return null;
  const numericLeafMatch = parsed.pathname.match(/^(.*\/)(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const prefixedLeafMatch = parsed.pathname.match(/^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
  const match = numericLeafMatch || prefixedLeafMatch;
  if (!match) return null;
  const frame = Number(match[2]);
  if (!Number.isFinite(frame) || frame < 1 || frame > MAX_IMAGE_SEQUENCE_FRAMES) return null;
  const pathParts = match[1].split("/").filter(Boolean);
  const pathCount = Number(pathParts[pathParts.length - 1] || 0);
  const hasExplicitCountPath = Boolean(numericLeafMatch && pathCount >= 2 && pathCount <= MAX_IMAGE_SEQUENCE_FRAMES);
  return {
    href: parsed.href,
    prefix: match[1],
    suffix: match[3],
    frame,
    explicitCount: hasExplicitCountPath ? pathCount : 0,
    numericLeaf: Boolean(numericLeafMatch),
    key: `${parsed.origin}${match[1]}*${match[3]}?${parsed.searchParams.toString()}`.toLowerCase()
  };
};
var imageSequenceFrameUrl = (seedUrl, frame) => {
  const parsed = parseExpandableImageSequence(seedUrl);
  if (!parsed) return "";
  try {
    const clone = new URL2(parsed.href);
    clone.pathname = `${parsed.prefix}${frame}${parsed.suffix}`;
    return clone.href;
  } catch {
    return "";
  }
};
var toyotaCountedImageSequenceFrameUrl = (seedUrl, frame, count = 36) => {
  const parsed = parseExpandableImageSequence(seedUrl);
  if (!parsed || parsed.explicitCount > 0 || !parsed.numericLeaf) return "";
  if (!/\/jellies\/(?:max|relative)\//i.test(parsed.href)) return "";
  if (count < 2 || count > MAX_IMAGE_SEQUENCE_FRAMES) return "";
  try {
    const clone = new URL2(parsed.href);
    clone.pathname = `${parsed.prefix}${count}/${frame}${parsed.suffix}`;
    return clone.href;
  } catch {
    return "";
  }
};
var isRemoteImageUrlAvailable = async (url, refererPageUrl = "") => {
  const referer = resolveImageFetchReferer(url, refererPageUrl);
  const accept = imageAcceptHeaderForUrl(url);
  const headers = {
    "User-Agent": PAGE_FETCH_USER_AGENTS[0],
    Accept: accept,
    ...referer ? { Referer: referer } : {}
  };
  const check = async (method) => {
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...method === "GET" ? { Range: "bytes=0-511" } : {}
      },
      redirect: "follow",
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok && response.status !== 206) return false;
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type && !type.includes("image/")) return false;
    return true;
  };
  try {
    if (await check("HEAD")) return true;
  } catch {
  }
  try {
    return await check("GET");
  } catch {
    return false;
  }
};
var repairMalformedToyotaCountedSequences = async (items, targetUrl) => {
  if (!isToyotaVehicleExtractionTarget(targetUrl)) return items;
  const ordinarySeeds = items.map((item) => ({ item, parsed: String(item?.url || "").match(/\/jellies\/(?:max|relative)\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/1\.(png|jpe?g|webp|avif)(?:[?#]|$)/i) })).filter((entry) => entry.parsed);
  if (ordinarySeeds.length === 0) return items;
  let repairedGroup = null;
  for (const item of items) {
    const raw = String(item?.url || "").replace(/&amp;/g, "&").trim();
    if (!raw || !hasMalformedImageSequencePath(raw)) continue;
    let parsed;
    try {
      parsed = new URL2(raw);
    } catch {
      continue;
    }
    const malformed = parsed.pathname.match(/^(.*\/jellies\/(?:max|relative)\/(\d{4})\/([^/]+))\/{2,}([^/]+)\/([^/]+)\/(\d{1,3})\/(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
    if (!malformed) continue;
    const [, prefix, year, model, modelCode, colorCode, countRaw, , extension] = malformed;
    const count = Number(countRaw);
    if (count < 8 || count > MAX_IMAGE_SEQUENCE_FRAMES) continue;
    const matchingSeed = ordinarySeeds.find(
      ({ parsed: seedMatch }) => seedMatch?.[1] === year && seedMatch?.[2]?.toLowerCase() === model.toLowerCase() && seedMatch?.[4]?.toLowerCase() === modelCode.toLowerCase() && seedMatch?.[5]?.toLowerCase() === colorCode.toLowerCase()
    );
    const trim = matchingSeed?.parsed?.[3];
    if (!trim) continue;
    const urls = Array.from({ length: count }, (_unused, index) => {
      const clone = new URL2(parsed.href);
      clone.pathname = `${prefix}/${trim}/${modelCode}/${colorCode}/${count}/${index + 1}${extension}`;
      return { frame: index + 1, url: clone.href };
    });
    repairedGroup = { seed: item, urls };
    break;
  }
  if (!repairedGroup) return items;
  const existingUrls = new Set(items.map((item) => String(item?.url || "").trim()).filter(Boolean));
  const discovered = [];
  const sequenceCount = repairedGroup.urls.length;
  for (const candidate of repairedGroup.urls) {
    if (existingUrls.has(candidate.url)) continue;
    existingUrls.add(candidate.url);
    discovered.push({
      ...repairedGroup.seed,
      url: candidate.url,
      type: inferImageTypeFromUrl(candidate.url) || getAssetTypeFromUrl(candidate.url, "png"),
      filename: filenameFromUrlPath2(candidate.url),
      source: "360-sequence-probed",
      alt: `360 frame ${candidate.frame}`,
      sequenceFrame: candidate.frame,
      sequenceCount,
      status: DEFAULT_ASSET_STATUS
    });
  }
  return discovered.length ? [...items.filter((item) => !hasMalformedImageSequencePath(String(item?.url || ""))), ...discovered] : items;
};
var expandAvailableImageSequences = async (items, targetUrl) => {
  const byGroup = /* @__PURE__ */ new Map();
  for (const item of items) {
    const url = String(item?.url || "").trim();
    const parsed = parseExpandableImageSequence(url);
    if (!parsed) continue;
    if (parsed.explicitCount > 0) continue;
    if (!/(?:toyota|jellies|mazda|lexus|assetscs|visualizer|threesixty|360)/i.test(url)) continue;
    const isToyotaJellySequence = /\/jellies\/(?:max|relative)\//i.test(url);
    const isPrefixedVisualizerSequence = /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(url) && /[-_]\d{1,3}\.(?:png|jpe?g|webp|avif)(?:[?#]|$)/i.test(url);
    if (!isToyotaJellySequence && !isPrefixedVisualizerSequence) continue;
    const group = byGroup.get(parsed.key) || { seed: item, parsed, observedFrames: /* @__PURE__ */ new Set() };
    group.observedFrames.add(parsed.frame);
    byGroup.set(parsed.key, group);
  }
  const groups = [...byGroup.values()].slice(0, 48);
  if (groups.length === 0) return items;
  const existingUrls = new Set(items.map((item) => String(item?.url || "").trim()).filter(Boolean));
  const discovered = [];
  const replacedGroupKeys = /* @__PURE__ */ new Set();
  await mapWithConcurrency(groups, 4, async (group) => {
    const seedUrl = String(group.seed?.url || "");
    const isToyotaJellyGroup = /\/jellies\/(?:max|relative)\//i.test(seedUrl) && group.parsed.explicitCount === 0;
    const maxProbe = Math.min(MAX_IMAGE_SEQUENCE_FRAMES, Math.max(36, ...Array.from(group.observedFrames)));
    const toyotaCountedCandidates = isToyotaJellyGroup ? Array.from({ length: Math.min(36, MAX_IMAGE_SEQUENCE_FRAMES) }, (_unused, index) => index + 1).map((frame) => ({ frame, url: toyotaCountedImageSequenceFrameUrl(seedUrl, frame, 36), counted: true })).filter((candidate) => candidate.url && !existingUrls.has(candidate.url)) : [];
    const toyotaCountedChecks = toyotaCountedCandidates.length ? await mapWithConcurrency(toyotaCountedCandidates, 8, async (candidate) => ({
      ...candidate,
      ok: await isRemoteImageUrlAvailable(candidate.url, targetUrl)
    })) : [];
    const countedValidFrames = /* @__PURE__ */ new Set();
    toyotaCountedChecks.filter((check) => check.ok).forEach((check) => countedValidFrames.add(check.frame));
    const useToyotaCountedSequence = countedValidFrames.size >= Math.max(8, group.observedFrames.size + 1);
    const candidates = useToyotaCountedSequence ? [] : Array.from({ length: maxProbe }, (_unused, index) => index + 1).filter((frame) => !group.observedFrames.has(frame)).map((frame) => ({ frame, url: imageSequenceFrameUrl(seedUrl, frame) })).filter((candidate) => candidate.url && !existingUrls.has(candidate.url));
    const checks = await mapWithConcurrency(candidates, 8, async (candidate) => ({
      ...candidate,
      ok: await isRemoteImageUrlAvailable(candidate.url, targetUrl)
    }));
    const validFrames = useToyotaCountedSequence ? countedValidFrames : new Set(group.observedFrames);
    if (!useToyotaCountedSequence) checks.filter((check) => check.ok).forEach((check) => validFrames.add(check.frame));
    const sortedFrames = [...validFrames].filter((frame) => frame >= 1).sort((a, b) => a - b);
    const frameSet = sortedFrames;
    const count = Math.max(...frameSet);
    if (count < 2) return;
    if (isToyotaJellyGroup && !useToyotaCountedSequence && count < 8) return;
    if (useToyotaCountedSequence) replacedGroupKeys.add(group.parsed.key);
    for (const frame of frameSet) {
      const url = useToyotaCountedSequence ? toyotaCountedImageSequenceFrameUrl(seedUrl, frame, 36) : imageSequenceFrameUrl(seedUrl, frame);
      if (!url || existingUrls.has(url)) continue;
      existingUrls.add(url);
      discovered.push({
        ...group.seed,
        url,
        type: inferImageTypeFromUrl(url) || getAssetTypeFromUrl(url, String(group.seed?.type || "jpg")),
        filename: filenameFromUrlPath2(url),
        source: "360-sequence-probed",
        alt: `360 frame ${frame}`,
        sequenceFrame: frame,
        sequenceCount: count,
        status: DEFAULT_ASSET_STATUS
      });
    }
    for (const item of items) {
      const parsed = parseExpandableImageSequence(String(item?.url || ""));
      if (!parsed || parsed.key !== group.parsed.key || !frameSet.includes(parsed.frame)) continue;
      item.source = String(item.source || "").includes("360-sequence") ? item.source : "360-sequence-probed";
      item.sequenceFrame = parsed.frame;
      item.sequenceCount = count;
      item.alt = item.alt || `360 frame ${parsed.frame}`;
    }
  });
  const keptItems = replacedGroupKeys.size ? items.filter((item) => {
    const parsed = parseExpandableImageSequence(String(item?.url || ""));
    return !parsed || !replacedGroupKeys.has(parsed.key);
  }) : items;
  return discovered.length ? [...keptItems, ...discovered] : keptItems;
};
var filterUnavailableGeneratedImageSequences = async (items, targetUrl) => {
  if (shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) {
    return items;
  }
  const groups = /* @__PURE__ */ new Map();
  for (const item of items) {
    const url = String(item?.url || "").trim();
    const parsed = parseExpandableImageSequence(url);
    if (!parsed || parsed.explicitCount < 8 || !/^https?:\/\//i.test(url)) continue;
    const source = String(item?.source || "");
    const isGeneratedSequence = source.includes("360-sequence") || Number(item?.sequenceCount || 0) >= 8 || /\/jellies\/(?:max|relative)\//i.test(url);
    if (!isGeneratedSequence) continue;
    const group = groups.get(parsed.key) || {
      seed: item,
      parsed,
      items: [],
      sequenceCount: Number(item?.sequenceCount || parsed.explicitCount || 0)
    };
    group.items.push(item);
    group.sequenceCount = Math.max(group.sequenceCount, Number(item?.sequenceCount || parsed.explicitCount || 0));
    groups.set(parsed.key, group);
  }
  if (groups.size === 0) return items;
  const invalidKeys = /* @__PURE__ */ new Set();
  await mapWithConcurrency([...groups.values()], 4, async (group) => {
    const count = Math.min(MAX_IMAGE_SEQUENCE_FRAMES, Math.max(8, group.sequenceCount || group.parsed.explicitCount));
    const sampleFrames = Array.from(/* @__PURE__ */ new Set([1, Math.max(1, Math.ceil(count / 2)), count]));
    const checks = await mapWithConcurrency(sampleFrames, 3, async (frame) => {
      const sampleUrl = imageSequenceFrameUrl(String(group.seed?.url || ""), frame);
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
    const parsed = parseExpandableImageSequence(String(item?.url || ""));
    return !parsed || !invalidKeys.has(parsed.key);
  });
};
var keepBestToyotaSequenceGroup = (items, targetUrl) => {
  if (!shouldSuppressToyotaSequenceAutoExpansion(targetUrl)) return items;
  const groups = /* @__PURE__ */ new Map();
  for (const item of items) {
    const url = String(item?.url || "").trim();
    const parsed = parseExpandableImageSequence(url);
    const source = String(item?.source || "").trim();
    const count = Number(item?.sequenceCount || parsed?.explicitCount || 0);
    const trusted = source.includes("360-sequence") || source.includes("360-sequence-probed");
    if (!parsed && !trusted || count < 8) continue;
    const key = parsed?.key || `${source}:${url}`;
    const group = groups.get(key) || {
      key,
      items: [],
      count: 0,
      trusted: false,
      explicitCount: parsed?.explicitCount || 0
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
  const allowedKeys = /* @__PURE__ */ new Set([preferredGroup.key]);
  return items.filter((item) => {
    const url = String(item?.url || "").trim();
    const parsed = parseExpandableImageSequence(url);
    const source = String(item?.source || "").trim();
    const count = Number(item?.sequenceCount || parsed?.explicitCount || 0);
    const isSequenceCandidate = Boolean(parsed || source.includes("360-sequence") || source.includes("360-sequence-probed"));
    if (!isSequenceCandidate || count < 8) return true;
    const key = parsed?.key || `${source}:${url}`;
    return allowedKeys.has(key);
  });
};
var probeSvgDimensions = (buffer) => {
  try {
    const text = buffer.slice(0, 8192).toString("utf8");
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
  }
  return { width: 0, height: 0 };
};
var probeRasterDimensions = (buffer) => {
  if (!buffer || buffer.length < 24) return { width: 0, height: 0 };
  const head = buffer.slice(0, 256).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<") && head.includes("<svg")) {
    return probeSvgDimensions(buffer);
  }
  try {
    if (buffer[0] === 255 && buffer[1] === 216) {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 255) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 192 || marker === 194 || marker === 193) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7)
          };
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + Math.max(segmentLength, 2);
      }
    }
    if (buffer.slice(0, 8).toString("ascii") === "\x89PNG\r\n\n") {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20)
      };
    }
    if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
      if (buffer.slice(12, 16).toString("ascii") === "VP8X" && buffer.length >= 30) {
        return {
          width: 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16),
          height: 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16)
        };
      }
    }
  } catch {
  }
  return { width: 0, height: 0 };
};
var decodeDataImageBuffer = (dataUrl) => {
  const raw = String(dataUrl || "").trim();
  if (!raw.startsWith("data:image/")) return null;
  const comma = raw.indexOf(",");
  if (comma < 0) return null;
  const header = raw.slice(0, comma).toLowerCase();
  const payload = raw.slice(comma + 1);
  try {
    const buffer = header.includes(";base64") ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    if (!buffer.length) return null;
    return buffer;
  } catch {
    return null;
  }
};
var fontIconPathFontCache = /* @__PURE__ */ new Map();
var escapeSvgXml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var decodeFontIconSvgTextMeta = (dataUrl, fallback = {}) => {
  const buffer = decodeDataImageBuffer(dataUrl);
  if (!buffer?.length) return null;
  const svgText = buffer.toString("utf8");
  if (!/<text\b/i.test(svgText)) return null;
  const textMatch = svgText.match(/<text\b([^>]*)>([\s\S]*?)<\/text>/i);
  if (!textMatch) return null;
  const attrs = textMatch[1] || "";
  const readAttr = (name) => attrs.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1]?.trim() || "";
  const glyph = String(fallback.fontGlyph || textMatch[2] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const fontFamily = String(fallback.fontFamily || readAttr("font-family") || "").replace(/&quot;/g, '"').replace(/^["']|["']$/g, "");
  const fontSize = Number(fallback.fontSize || readAttr("font-size") || 0) || 48;
  const fill = String(fallback.fill || readAttr("fill") || "#000").replace(/&quot;/g, '"');
  const width = Number(fallback.width || svgText.match(/<svg\b[^>]*\bwidth=["']?(\d+)/i)?.[1] || 0) || 64;
  const height = Number(fallback.height || svgText.match(/<svg\b[^>]*\bheight=["']?(\d+)/i)?.[1] || 0) || width;
  if (!glyph || !/font awesome|fontawesome/i.test(fontFamily)) return null;
  return { glyph, fontFamily, fontSize, fill, width, height };
};
var buildFontIconTextSvgDataUrlFromMeta = (imageMeta = {}) => {
  const glyph = String(imageMeta.fontGlyph || "").trim();
  if (!glyph) return "";
  const width = Math.max(32, Number(imageMeta.width || 0) || 64);
  const height = Math.max(32, Number(imageMeta.height || 0) || width);
  const fontSize = Math.max(12, Number(imageMeta.fontSize || 0) || Math.round(Math.min(width, height) * 0.72));
  const fontFamily = String(imageMeta.fontFamily || "Font Awesome 6 Free, Font Awesome 5 Free, Font Awesome 6 Brands, Font Awesome 5 Brands, sans-serif");
  const fill = String(imageMeta.fill || "#000");
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}"><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="${escapeSvgXml(fontFamily)}" font-size="${Math.round(fontSize)}" fill="${escapeSvgXml(fill)}">${escapeSvgXml(glyph)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`;
};
var rasterizeSvgDataUrlToPngDataUrl = async (svgDataUrl) => {
  const buffer = decodeDataImageBuffer(svgDataUrl);
  if (!buffer?.length) return "";
  try {
    const sharp = await loadSharp();
    const png = await sharp(buffer, { density: 192, failOn: "none" }).png().toBuffer();
    return png?.length ? `data:image/png;base64,${png.toString("base64")}` : "";
  } catch {
    return "";
  }
};
var loadOpenTypeFontForIcon = async (fontUrl, refererPage = "") => {
  const key = `${fontUrl}::${refererPage}`;
  if (!fontIconPathFontCache.has(key)) {
    fontIconPathFontCache.set(key, (async () => {
      try {
        const fetched = await fetchRemoteFontBuffer(fontUrl, refererPage);
        const detected = detectFontFormatFromBuffer(fetched.buffer) || normalizeFontFormat(getAssetTypeFromUrl(fetched.sourceUrl || fontUrl, "font"));
        const inner = await getInnerFontBuffer(fetched.buffer, detected);
        return opentype.parse(bufferToExactArrayBuffer(inner.buffer));
      } catch {
        return null;
      }
    })());
  }
  return fontIconPathFontCache.get(key);
};
var fontMatchesIconFamily = (font, family) => {
  const haystack = [
    font?.family,
    font?.name,
    font?.title,
    font?.source,
    font?.url,
    font?.originalFilename
  ].map((item) => String(item || "").toLowerCase()).join(" ");
  const normalizedFamily = String(family || "").toLowerCase().replace(/["']/g, "");
  if (/font awesome|fontawesome/.test(normalizedFamily)) return /font[-\s]?awesome|\/fa-|fa-(?:solid|regular|brands)|fontawesome/i.test(haystack);
  return haystack.includes(normalizedFamily);
};
var convertFontIconTextSvgToPathSvg = async (dataUrl, imageMeta, fonts, refererPage = "") => {
  const meta = decodeFontIconSvgTextMeta(dataUrl, imageMeta);
  if (!meta) return "";
  const candidateFonts = fonts.filter((font) => String(font?.url || "").trim()).filter((font) => fontMatchesIconFamily(font, meta.fontFamily));
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
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><path fill="${escapeSvgXml(meta.fill)}" d="${escapeSvgXml(pathData)}"/></svg>`;
      return `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`;
    } catch {
    }
  }
  return "";
};
var enrichImageAssetMeta = (img, buffer, contentType = "") => {
  const next = { ...img };
  const resolvedBuffer = buffer && buffer.length > 0 ? buffer : decodeDataImageBuffer(String(next.url || ""));
  if (resolvedBuffer && resolvedBuffer.length > 0) {
    next.bytes = resolvedBuffer.length;
    const dims = probeRasterDimensions(resolvedBuffer);
    if (dims.width > 0 && dims.height > 0) {
      next.width = dims.width;
      next.height = dims.height;
    }
  }
  if (!next.filename) {
    const fromUrl = filenameFromUrlPath2(String(next.url || ""));
    if (fromUrl) next.filename = fromUrl;
  }
  if (!next.mimeType && contentType) next.mimeType = contentType;
  return next;
};
var isBotWallText = (text) => /checking (the )?site connection|connection security|robot-suspicion|captcha|verify you are human|access denied|just a moment|enable javascript|cloudflare|datadome|akamai|waf challenge|bot detection/i.test(
  String(text || "")
);
var isBotWallHtml = (html) => {
  return htmlLooksLikeBotWall(html);
};
var isLikelyBotWallExtract = (assets) => {
  const imgs = assets?.images || [];
  if (!imgs.length) return false;
  const botCount = imgs.filter((img) => isBotWallImageUrl(String(img?.url || ""))).length;
  return botCount > 0 && botCount >= imgs.length - 1;
};
var staticExtractNeedsBrowser = (html, assets, options = {}) => {
  const text = String(html || "");
  if (htmlNeedsRenderedExtraction(text)) return true;
  const fontHints = /fonts\.(?:googleapis|gstatic)|typekit|accelerator\.sanofi|use\.typekit|@font-face|rel=["']stylesheet["']/i.test(text);
  const videoHints = /youtube\.com|youtu\.be|vimeo\.com|wistia|brightcove|vidyard|\.(?:mp4|webm|m3u8)(?:[?#"'`<>\s\\)]|$)|<video\b|<iframe[^>]+src=/i.test(text);
  const lazyImageHints = /\bdata-(?:src|lazy-src|original|image)=/i.test(text) || /\bloading=["']lazy["']/i.test(text);
  const lowFonts = (assets?.fonts?.length || 0) < 2;
  const lowVideos = options.videosOnly && (assets?.videos?.length || 0) === 0 && videoHints;
  const lowImagesForLazySite = lazyImageHints && (assets?.images?.length || 0) < 40;
  return lowFonts && fontHints || lowVideos || lowImagesForLazySite || staticExtractHasUnresolvedEmbeds(text, assets, options);
};
var staticExtractHasUnresolvedEmbeds = (html, assets, options = {}) => {
  if (!options.videosOnly) return false;
  const text = String(html || "");
  const videos = assets?.videos || [];
  const vimeoHints = /vimeo\.com|data-vimeo-id/i.test(text);
  if (vimeoHints && !videos.some((video) => video?.isVimeoDirect)) return true;
  const wistiaHints = /wistia|<wistia-player\b|fast\.wistia\.(?:com|net)/i.test(text);
  if (wistiaHints && !videos.some((video) => video?.provider === "wistia" && (video?.isWistiaDirect || /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(String(video?.url || ""))))) {
    return true;
  }
  const brightcoveHints = /brightcove|gb-video-brightcove|data-account-id|players\.brightcove\.net/i.test(text);
  if (brightcoveHints && !videos.some((video) => video?.provider === "brightcove" && (video?.isDirect || video?.brightcoveManifestUrl || /\.mp4|m3u8/i.test(String(video?.url || ""))))) {
    return true;
  }
  const jwHints = /jwplayer|jw-player|kaltura|videoUrl["']\s*:/i.test(text);
  if (jwHints && videos.length === 0) return true;
  return false;
};
var collectBrightcovePlayerUrls = (videos) => Array.from(
  new Set(
    (videos || []).map((video) => String(video?.url || video?.sourceUrl || "").trim()).filter((url) => /players\.brightcove\.net/i.test(url) || parseBrightcovePlayerUrl(url))
  )
);
var resolveBrightcoveCandidateVideos = async (videos, label) => {
  const playerUrls = collectBrightcovePlayerUrls(videos);
  if (playerUrls.length === 0) return videos;
  const resolved = [];
  const unavailablePlayerUrls = /* @__PURE__ */ new Set();
  for (const playerUrl of playerUrls.slice(0, 8)) {
    try {
      const assets = await withTimeout(extractBrightcoveVideos(playerUrl), 2e4, `${label} for ${playerUrl}`);
      if (assets?.videos?.length) resolved.push(...assets.videos);
    } catch (error) {
      if (/\bVIDEO_NOT_FOUND\b/i.test(String(error?.message || error || ""))) {
        unavailablePlayerUrls.add(playerUrl);
      }
      console.warn(`${label} failed for ${playerUrl}:`, error?.message || error);
    }
  }
  if (!resolved.length) {
    return videos.filter((video) => {
      const url = String(video?.url || video?.embedUrl || "").trim();
      return !unavailablePlayerUrls.has(url) && !/players\.brightcove\.net/i.test(url);
    });
  }
  const withoutPlaceholders = videos.filter((video) => {
    const url = String(video?.url || "");
    return !/players\.brightcove\.net/i.test(url);
  });
  return [...withoutPlaceholders, ...resolved];
};
var shouldTryStaticBeforeBrowser = (html) => {
  const text = String(html || "");
  if (htmlLooksLikeBotWall(text)) return false;
  return text.length > 5e3 && !isSparseSiteHtml(text) && scoreSiteHtml(text, 200) >= 30;
};
var htmlNeedsRenderedExtraction = (html) => {
  const sample = String(html || "").slice(0, 5e5);
  const lazyAttrCount = (sample.match(/\bdata-(?:src|lazy-src|original|image|bg|background-image|lazyload|iesrc|lazy-image|flickity-lazyload|thumb|thumbnail|poster|hires|retina)=/gi)?.length || 0) + (sample.match(/\bloading=["']lazy["']/gi)?.length || 0);
  return lazyAttrCount >= 2 || /__NEXT_DATA__|__NUXT__|sap-commerce|hybris|next\/image|nuxt-img|swiper-lazy|lazyload|hydrateRoot|data-hydration|fabindia|\/medias\/|medias\/sys_master|commercecloud|IntersectionObserver|lazySizes|lozad|vanilla-lazyload/i.test(
    sample
  );
};
var isPlatformMarketingHomepage = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path4 = parsed.pathname.replace(/\/+$/, "") || "/";
    if (path4 !== "/" && path4 !== "/home") return false;
    return host === "vimeo.com" || host.endsWith(".vimeo.com");
  } catch {
    return false;
  }
};
var performLazyLoadScroll = async (page, options = {}) => {
  const stepDelayMs = options.stepDelayMs ?? 750;
  const maxStableRounds = options.maxStableRounds ?? 4;
  const maxDurationMs = options.maxDurationMs ?? 45e3;
  await page.evaluate(
    async ({ delayMs, stableLimit, maxMs }) => {
      const vp = window.innerHeight || document.documentElement.clientHeight || 800;
      const step = Math.max(Math.floor(vp * 0.9), 500);
      let stable = 0;
      let lastHeight = 0;
      const startedAt = Date.now();
      while (stable < stableLimit && Date.now() - startedAt < maxMs) {
        window.scrollBy(0, step);
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
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
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    },
    { delayMs: stepDelayMs, stableLimit: maxStableRounds, maxMs: maxDurationMs }
  );
};
var pageNeedsLazyLoadScroll = async (page, initialHtml) => {
  if (htmlNeedsRenderedExtraction(initialHtml)) return true;
  try {
    return await page.evaluate(() => {
      const lazyNodes = document.querySelectorAll(
        '[loading="lazy"], [data-src], [data-lazy-src], [data-original], [class*="lazy"], [class*="infinite"], [data-lazyload], [data-lazy-image], [data-iesrc], [data-flickity-lazyload], [data-lazy-srcset], [data-srcset], [data-thumb], [data-thumbnail], [data-poster], [class*="swiper-lazy"], [class*="lazyload"], [class*="lozad"]'
      ).length;
      const hasObserver = document.querySelectorAll("script").length > 0 && Array.from(document.querySelectorAll("script")).some(
        (s) => /IntersectionObserver|lazySizes|lozad|vanilla-lazyload/i.test(s.textContent || "")
      );
      const tallPage = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0) > Math.max(window.innerHeight || 800, 640) * 2.2;
      return lazyNodes >= 2 || hasObserver || tallPage;
    });
  } catch {
    return false;
  }
};
var extractRenderedDomAssetsFromPage = async (page) => page.evaluate(() => {
  const imageUrls = /* @__PURE__ */ new Set();
  const videoEntries = [];
  const fontFamilies = /* @__PURE__ */ new Set();
  const computedFonts = [];
  const computedFontKeys = /* @__PURE__ */ new Set();
  const stylesheetUrls = /* @__PURE__ */ new Set();
  const fontFaceCss = [];
  const fontResourceUrls = /* @__PURE__ */ new Set();
  var _ = {
    toAbsolute(raw) {
      const value = String(raw || "").trim();
      if (!value || value === "about:blank" || value.startsWith("blob:")) return "";
      if (value.startsWith("data:image/")) return value;
      if (value.startsWith("data:")) return "";
      try {
        return new URL2(value, window.location.href).href;
      } catch {
        return value.startsWith("http") ? value : "";
      }
    },
    isLikelyImageCandidate(raw) {
      const value = String(raw || "").replace(/&amp;/g, "&").trim();
      if (!value || /%7b|%7d|[{}]/i.test(value)) return false;
      if (/^data:image\//i.test(value)) return true;
      if (/\.(?:css|js|json|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|mkv|m3u8|mpd|html?)(?:[?#]|$)/i.test(value)) return false;
      try {
        const parsed = new URL2(value);
        const path4 = parsed.pathname.replace(/\/{2,}/g, "/");
        const hasImageExt = /\.(?:svg|png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(parsed.href);
        const hasImageFormat = /[?&](?:fmt|format|fm|output)=(?:svg|png|jpe?g|webp|gif|avif|png-alpha|webp-alpha)/i.test(parsed.search);
        const isImageService = /\/is\/image\/|\/image\/|\/images?\/|\/img\/|\/media\/|\/assets?\/|\/content\/dam\/|\/\.imaging\//i.test(path4);
        if (!hasImageExt && !hasImageFormat && !isImageService) return false;
        if (!hasImageExt && /\/\d{1,3}(?:&|$)/.test(path4)) return false;
        return true;
      } catch {
        return false;
      }
    },
    addImage(raw) {
      const abs = _.toAbsolute(String(raw || ""));
      if (abs && _.isLikelyImageCandidate(abs)) imageUrls.add(abs);
    },
    addInlineSvg(svg, index) {
      try {
        const externalUse = Array.from(svg.querySelectorAll("use")).some((use) => {
          const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
          return href && !href.startsWith("#");
        });
        if (externalUse) return;
        const clone = svg.cloneNode(true);
        if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const svgText = new XMLSerializer().serializeToString(clone);
        const bytes = new TextEncoder().encode(svgText);
        let binary = "";
        const chunkSize = 8192;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...Array.from(bytes.slice(offset, offset + chunkSize)));
        }
        imageUrls.add(`data:image/svg+xml;base64,${btoa(binary)}`);
      } catch {
      }
    },
    addSrcsetCandidates(raw) {
      if (!raw) return;
      raw.split(",").forEach((part) => _.addImage(part.trim().split(/\s+/)[0]));
    }
  };
  var fontAwesomeHelpers = {
    decodeCssContent(raw) {
      let text = String(raw || "").trim();
      if (!text || text === "none" || text === "normal") return "";
      if (text.startsWith('"') && text.endsWith('"') || text.startsWith("'") && text.endsWith("'")) {
        text = text.slice(1, -1);
      }
      text = text.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex) => {
        try {
          return String.fromCodePoint(parseInt(hex, 16));
        } catch {
          return "";
        }
      });
      return text.replace(/\\(["'\\])/g, "$1");
    },
    resolveGlyph(style, baseStyle, initialGlyph) {
      const candidates = [
        initialGlyph,
        style.getPropertyValue("--fa"),
        baseStyle.getPropertyValue("--fa"),
        style.getPropertyValue("--fa-primary"),
        baseStyle.getPropertyValue("--fa-primary"),
        style.content
      ];
      for (const candidate of candidates) {
        const glyph = fontAwesomeHelpers.decodeCssContent(candidate);
        if (glyph && !/^var\(/i.test(glyph) && glyph !== "none" && glyph !== "normal") return glyph;
      }
      return "";
    },
    svgDataUrl(glyph, family, fontPx, color, size) {
      try {
        const escapeXml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '"><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="' + escapeXml(family || "Font Awesome 6 Free, Font Awesome 5 Free, sans-serif") + '" font-size="' + Math.round(fontPx) + '" fill="' + escapeXml(color || "#000") + '">' + escapeXml(glyph) + "</text></svg>";
        const bytes = new TextEncoder().encode(svgText);
        let binary = "";
        const chunkSize = 8192;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...Array.from(bytes.slice(offset, offset + chunkSize)));
        }
        return `data:image/svg+xml;base64,${btoa(binary)}`;
      } catch {
        return "";
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
        '[class^="fa-"]'
      ].join(",");
      document.querySelectorAll(selector).forEach((el, index) => {
        const htmlEl = el;
        const classText = String(htmlEl.getAttribute("class") || "");
        const baseStyle = window.getComputedStyle(htmlEl);
        ["::before", "::after"].forEach((pseudo) => {
          try {
            const style = window.getComputedStyle(htmlEl, pseudo);
            const parentStyle = htmlEl.parentElement ? window.getComputedStyle(htmlEl.parentElement) : baseStyle;
            const family = String(style.fontFamily || baseStyle.fontFamily || parentStyle.fontFamily || "");
            if (!/font awesome|fontawesome/i.test(family) && !/(?:^|\s)(?:fa|fas|far|fab|fal|fad|fa-[a-z0-9-]+)/i.test(classText)) return;
            const glyph = fontAwesomeHelpers.resolveGlyph(style, baseStyle, fontAwesomeHelpers.decodeCssContent(style.content));
            const rect = htmlEl.getBoundingClientRect();
            const fontPx = Math.max(14, Number.parseFloat(style.fontSize || baseStyle.fontSize || parentStyle.fontSize || "") || rect.height || 24);
            const cssSize = Math.min(256, Math.max(64, Math.ceil(Math.max(rect.width || 0, rect.height || 0, fontPx) + 24)));
            if (!glyph || glyph.length > 4) return;
            const canvas = document.createElement("canvas");
            canvas.width = cssSize * 2;
            canvas.height = cssSize * 2;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.scale(2, 2);
            ctx.clearRect(0, 0, cssSize, cssSize);
            ctx.fillStyle = style.color || baseStyle.color || "#000";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `${style.fontStyle || baseStyle.fontStyle || "normal"} ${style.fontWeight || baseStyle.fontWeight || "400"} ${fontPx}px ${family || "Font Awesome 6 Free, Font Awesome 5 Free, sans-serif"}`;
            ctx.fillText(glyph, cssSize / 2, cssSize / 2);
            imageUrls.add(canvas.toDataURL("image/png"));
            const svgDataUrl = fontAwesomeHelpers.svgDataUrl(glyph, family, fontPx, style.color || baseStyle.color || "#000", cssSize);
            if (svgDataUrl) imageUrls.add(svgDataUrl);
          } catch {
          }
        });
      });
    }
  };
  const LAZY_ATTRS = [
    "data-src",
    "data-original",
    "data-lazy",
    "data-lazy-src",
    "data-image",
    "data-img",
    "data-bg",
    "data-background",
    "data-background-image",
    "data-thumb",
    "data-thumbnail",
    "data-poster",
    "data-hires",
    "data-retina",
    "data-full",
    "data-large",
    "data-medium",
    "data-small",
    "data-lazyload",
    "data-lazy-image",
    "data-iesrc",
    "data-src-small",
    "data-src-medium",
    "data-src-large",
    "data-src-retina",
    "data-flickity-lazyload",
    "data-url"
  ];
  const SRCSET_ATTRS2 = ["srcset", "data-srcset", "data-lazy-srcset"];
  const expand360Sequence = (raw, countHint = 0) => {
    const target = _.toAbsolute(String(raw || "").replace(/&amp;/g, "&"));
    if (!target || !/(?:threesixty|360|jellies|vehicle|toyota|lexus|aemassets|assetscs|visualizer)/i.test(target)) return [];
    let parsed;
    try {
      parsed = new URL2(target);
    } catch {
      return [];
    }
    if (parsed.pathname.includes("//")) return [];
    const match = parsed.pathname.match(/^(.*\/)(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i) || parsed.pathname.match(/^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i);
    if (!match) return [];
    const frame = Number(match[2]);
    const parts = match[1].split("/").filter(Boolean);
    const pathCount = Number(parts[parts.length - 1] || 0);
    const hinted = Number(countHint || 0);
    const commonSequenceCounts = /* @__PURE__ */ new Set([4, 18, 24, 36, 72, 120]);
    const hasExplicitFrameCountPath = Boolean(
      pathCount >= 2 && pathCount <= 120 && (hinted >= 2 && hinted <= 120 && pathCount === hinted || commonSequenceCounts.has(pathCount))
    );
    const hasPrefixedFrameName = Boolean(
      /^(.*[-_])(\d{1,3})(\.(?:png|jpe?g|webp|avif))$/i.test(parsed.pathname) && /(?:lexus|assetscs|visualizer|threesixty|360)/i.test(target)
    );
    if (!hasExplicitFrameCountPath && !hasPrefixedFrameName) return [];
    const count = hasExplicitFrameCountPath ? pathCount : Number(countHint || 0);
    if (!Number.isFinite(frame) || frame < 1 || !count || count > 120 || frame > count) return [];
    return Array.from({ length: count }, (_unused, index) => {
      const clone = new URL2(parsed.href);
      clone.pathname = `${match[1]}${index + 1}${match[3]}`;
      return clone.href;
    });
  };
  const collect360FromRoot = (root) => {
    const count = Number(
      root.getAttribute("data-image-count") || root.querySelector("[data-image-count]")?.getAttribute("data-image-count") || 0
    );
    const candidates = [];
    root.querySelectorAll("img, source, picture, [src], [srcset], [data-src], [data-srcset], [data-image], [data-lazy-src]").forEach((node) => {
      const anyNode = node;
      ["currentSrc", "src"].forEach((key) => {
        if (anyNode[key]) candidates.push(anyNode[key]);
      });
      ["src", "srcset", "data-src", "data-srcset", "data-lazy-src", "data-image", "data-url"].forEach((attr) => {
        const value = node.getAttribute(attr);
        if (!value) return;
        String(value).split(",").forEach((part) => candidates.push(part.trim().split(/\s+/)[0]));
      });
    });
    candidates.forEach((candidate) => {
      expand360Sequence(candidate, count).forEach((frameUrl) => _.addImage(frameUrl));
    });
  };
  const collectToyotaColorizerSwatchSequences = (root) => {
    const countHint = Number(
      root.getAttribute("data-image-count") || root.querySelector("[data-image-count]")?.getAttribute("data-image-count") || 0
    );
    if (!countHint || countHint > 120) return;
    const activeSwatch = root.querySelector('.color-selector__swatch[data-active="true"][data-model-grade]');
    const activeGrade = String(activeSwatch?.getAttribute("data-model-grade") || "").trim().toLowerCase();
    const activeModel = String(activeSwatch?.getAttribute("data-model-code") || "").trim().toLowerCase();
    const activeYear = String(activeSwatch?.getAttribute("data-model-year") || "").trim();
    const activeColor = String(activeSwatch?.getAttribute("data-color-code") || "").trim().toLowerCase();
    const activeColorName = String(
      activeSwatch?.getAttribute("data-color-name") || activeSwatch?.getAttribute("aria-label") || activeColor
    ).trim();
    if (!activeGrade || !activeColor) return;
    const mediaUrls = [];
    root.querySelectorAll(".threesixty-media img, .threesixty-media source, .threesixty-media [src], .threesixty-media [srcset]").forEach((node) => {
      const anyNode = node;
      ["currentSrc", "src"].forEach((key) => {
        if (anyNode[key]) mediaUrls.push(anyNode[key]);
      });
      ["src", "srcset", "data-src", "data-srcset"].forEach((attr) => {
        const value = node.getAttribute(attr);
        if (!value) return;
        String(value).split(",").forEach((part) => mediaUrls.push(part.trim().split(/\s+/)[0]));
      });
    });
    const template = mediaUrls.map((raw) => _.toAbsolute(raw)).filter(Boolean).map((raw) => {
      try {
        const parsed = new URL2(String(raw).replace(/&amp;/g, "&"));
        const match = parsed.pathname.replace(/\/{2,}/g, "/").match(/^(.*\/jellies\/max\/(\d{4})\/([^/]+)\/)(?:(?!\d+\/)[^/]+\/)?(\d+)\/([^/]+)\/(\d+)\/(\d+)(\.(?:png|jpe?g|webp|avif))$/i);
        if (!match) return null;
        return {
          href: parsed.href,
          prefix: match[1],
          year: match[2],
          model: match[3],
          style: match[4],
          count: Number(match[6]),
          suffix: match[8]
        };
      } catch {
        return null;
      }
    }).find((item) => item && item.count >= 2 && item.count <= 120 && (!activeYear || item.year === activeYear) && (!activeModel || item.model.toLowerCase() === activeModel));
    if (!template) return;
    for (let frame = 1; frame <= template.count; frame += 1) {
      try {
        const clone = new URL2(template.href);
        clone.pathname = `${template.prefix}${activeGrade}/${template.style}/${activeColor}/${template.count}/${frame}${template.suffix}`;
        _.addImage(clone.href);
      } catch {
      }
    }
  };
  document.querySelectorAll("img").forEach((img) => {
    const el = img;
    _.addImage(el.currentSrc);
    _.addImage(el.getAttribute("src"));
    LAZY_ATTRS.forEach((attr) => _.addImage(el.getAttribute(attr)));
    SRCSET_ATTRS2.forEach((attr) => _.addSrcsetCandidates(el.getAttribute(attr)));
  });
  document.querySelectorAll("picture source, source[srcset], source[src]").forEach((source) => {
    _.addImage(source.getAttribute("src"));
    SRCSET_ATTRS2.forEach((attr) => _.addSrcsetCandidates(source.getAttribute(attr)));
  });
  document.querySelectorAll('input[type="image"]').forEach((el) => {
    _.addImage(el.getAttribute("src"));
  });
  document.querySelectorAll("svg image").forEach((el) => {
    _.addImage(el.getAttribute("href"));
    _.addImage(el.getAttribute("xlink:href"));
  });
  document.querySelectorAll("svg use").forEach((el) => {
    const href = el.getAttribute("href") || el.getAttribute("xlink:href");
    if (href && !href.startsWith("#")) _.addImage(href);
  });
  document.querySelectorAll("svg").forEach((svg, index) => {
    _.addInlineSvg(svg, index);
  });
  fontAwesomeHelpers.addFontAwesomePngs();
  document.querySelectorAll('link[rel="preload"][as="image"]').forEach((el) => {
    _.addImage(el.getAttribute("href"));
  });
  document.querySelectorAll('meta[itemprop="image"]').forEach((el) => {
    _.addImage(el.getAttribute("content"));
  });
  document.querySelectorAll('object[type^="image/"], embed[type^="image/"]').forEach((el) => {
    _.addImage(el.getAttribute("data") || el.getAttribute("src"));
  });
  document.querySelectorAll("[data-src], [data-lazy-src], [data-original], [data-bg], [data-background-image], [data-image], [data-thumb]").forEach((el) => {
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      if (!attr.name.startsWith("data-") || !attr.value) continue;
      const lower = attr.name.toLowerCase();
      if (/image|img|photo|thumb|poster|bg|background|src|lazy|icon|avatar|banner|hero/i.test(lower)) {
        if (attr.value.includes(",") && /\d+w|\dx/.test(attr.value)) {
          _.addSrcsetCandidates(attr.value);
        } else {
          _.addImage(attr.value);
        }
      }
    }
  });
  document.querySelectorAll("video").forEach((video) => {
    const poster = _.toAbsolute(video.getAttribute("poster") || "");
    if (poster) _.addImage(poster);
    const src = _.toAbsolute(video.getAttribute("src") || "");
    if (src) {
      videoEntries.push({ url: src, poster, title: video.getAttribute("aria-label") || "" });
    }
    video.querySelectorAll("source").forEach((source) => {
      const sourceUrl = _.toAbsolute(source.getAttribute("src") || "");
      if (sourceUrl) videoEntries.push({ url: sourceUrl, poster, title: "" });
    });
  });
  document.querySelectorAll("iframe, embed").forEach((frame) => {
    const src = _.toAbsolute(frame.getAttribute("src") || frame.getAttribute("data-src") || "");
    if (!src) return;
    if (/vimeo\.com|youtube\.com|youtu\.be|player\.vimeo|brightcove|jwplayer/i.test(src)) {
      videoEntries.push({
        url: src,
        poster: "",
        title: frame.getAttribute("title") || frame.getAttribute("aria-label") || ""
      });
    }
  });
  document.querySelectorAll("a[href]").forEach((anchor) => {
    const href = _.toAbsolute(anchor.getAttribute("href") || "");
    if (!href) return;
    if (/vimeo\.com\/\d+/i.test(href) || /\/video\/\d+/i.test(href)) {
      const img = anchor.querySelector("img");
      videoEntries.push({
        url: href,
        poster: img ? _.toAbsolute(img.currentSrc || img.getAttribute("src") || "") : "",
        title: anchor.getAttribute("aria-label") || anchor.textContent?.trim().slice(0, 120) || ""
      });
    }
  });
  document.querySelectorAll("body *").forEach((el) => {
    const style = window.getComputedStyle(el);
    const bg = style.backgroundImage;
    if (!bg || bg === "none") return;
    const matches = bg.match(/url\(([^)]+)\)/g) || [];
    matches.forEach((match) => {
      const inner = /url\(["']?([^"')]+)["']?\)/.exec(match);
      if (inner?.[1]) _.addImage(inner[1]);
    });
  });
  document.querySelectorAll("style").forEach((styleEl) => {
    const cssText = styleEl.textContent || "";
    const bgRegex = /background-image\s*:\s*url\(([^)]+)\)/gi;
    let match;
    while ((match = bgRegex.exec(cssText)) !== null) {
      _.addImage(match[1].replace(/^["']|["']$/g, ""));
    }
  });
  document.querySelectorAll('[data-image-count], .threesixty, [class*="threesixty"], [class*="360"]').forEach((root) => {
    collect360FromRoot(root);
  });
  document.querySelectorAll('.colorizer, [class*="colorizer"]').forEach((root) => {
    collectToyotaColorizerSwatchSequences(root);
  });
  Array.from(performance.getEntriesByType("resource") || []).forEach((entry) => {
    expand360Sequence(entry.name, 0).forEach((frameUrl) => _.addImage(frameUrl));
  });
  Array.from(document.styleSheets).forEach((sheet) => {
    const href = _.toAbsolute(sheet.href || "");
    if (href) stylesheetUrls.add(href);
    try {
      Array.from(sheet.cssRules || []).forEach((rule) => {
        const cssText = String(rule.cssText || "");
        if (/^@font-face\b/i.test(cssText)) fontFaceCss.push(cssText);
      });
    } catch {
    }
  });
  Array.from(performance.getEntriesByType("resource") || []).forEach((entry) => {
    const resource = entry;
    const url = _.toAbsolute(resource.name || "");
    const initiator = String(resource.initiatorType || "").toLowerCase();
    if (!url) return;
    if (initiator === "font" || /fonts\.gstatic\.com/i.test(url) || /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url)) {
      fontResourceUrls.add(url);
    }
  });
  document.querySelectorAll("body *").forEach((el) => {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const style = window.getComputedStyle(el);
    const family = String(style.fontFamily || "").split(",")[0]?.replace(/^["']|["']$/g, "").trim();
    if (family && family !== "inherit") fontFamilies.add(family);
    if (family && family !== "inherit") {
      const payload = {
        family,
        weight: style.fontWeight || "400",
        style: style.fontStyle || "normal"
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
    fontResourceUrls: Array.from(fontResourceUrls).slice(0, 192)
  };
});
var isRichStaticExtract = (assets) => {
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const videoCount = assets?.videos?.length || 0;
  if (videoCount > 0) return true;
  if (imageCount >= 4 || fontCount >= 3) return true;
  if (imageCount + fontCount >= 6) return true;
  return false;
};
var isUsableStaticExtract = (assets) => {
  if (isRichStaticExtract(assets)) return true;
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const colorCount = assets?.colors?.length || 0;
  if (imageCount >= 1 && (fontCount >= 1 || colorCount >= 1)) return true;
  return imageCount >= 4;
};
var isStrongStaticExtractForImmediateReturn = (assets, options = {}) => {
  if (options.videosOnly) return false;
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const videoCount = assets?.videos?.length || 0;
  if (videoCount > 0) return true;
  if (imageCount >= 12) return true;
  return imageCount >= 8 && fontCount >= 2;
};
var warmExtractedAssetList = async (images, fonts, limits, pageUrl = "") => {
  const started = Date.now();
  const imageWarmPriority = (img) => {
    const url = String(img?.url || "");
    if (url.startsWith("data:")) return 0;
    if (String(img?.source || "").includes("360-sequence") || isLikely360SequenceUrl(url)) return 6;
    if (/\.(?:jpe?g|png|webp|gif|avif)(\?|$)/i.test(url)) return 3;
    if (/\/wp-content\/uploads\//i.test(url)) return 2;
    return 1;
  };
  const prioritizedImages = [...images].sort((a, b) => imageWarmPriority(b) - imageWarmPriority(a)).slice(0, limits.imageLimit);
  const fontsToWarm = fonts.slice(0, limits.fontLimit);
  await mapWithConcurrency(prioritizedImages, 12, async (img) => {
    if (Date.now() - started > limits.budgetMs) return;
    const url = String(img?.url || "");
    if (!url || url.startsWith("data:")) return;
    try {
      assertPublicAssetUrl(url);
      const warmed = await withTimeout(
        warmCachedOriginalAssetForExtraction(
          url,
          "image",
          inferImageTypeFromUrl(url, String(img?.type || "")) || getAssetTypeFromUrl(url, img?.type || "bin"),
          { refererPageUrl: pageUrl }
        ),
        12e3,
        `Extract image cache for ${url}`
      );
      if (warmed?.ok && warmed.cachedUrl) {
        img.cachedUrl = warmed.cachedUrl;
        img.status = "downloaded";
        if (warmed.bytes) img.bytes = warmed.bytes;
        if (warmed.width) img.width = warmed.width;
        if (warmed.height) img.height = warmed.height;
        if (/\.(?:webp|avif)(?:[?#]|$)/i.test(url)) {
          void warmRasterConversionVariants(url, warmed.cachedUrl).catch(() => void 0);
        }
      }
    } catch {
    }
  });
  await mapWithConcurrency(fontsToWarm, 10, async (font) => {
    if (Date.now() - started > limits.budgetMs) return;
    const url = String(font?.url || "");
    if (!url || url.startsWith("data:")) return;
    const existing = await readExistingOriginalAssetUrl(url, "font");
    if (existing) {
      await withTimeout(
        warmFontConversionVariants(url, existing, String(font?.format || "woff2"), {
          cssSource: String(font?.cssSource || ""),
          refererPageUrl: String(pageUrl || "")
        }),
        2e4,
        `Font warm for ${url}`
      ).catch(() => void 0);
      return;
    }
    try {
      assertPublicAssetUrl(url);
      await withTimeout(
        warmCachedOriginalAssetForExtraction(
          url,
          "font",
          getFontFormatFromUrlOrType(url, String(font?.format || "woff2")),
          {
            preferredBase: buildFontDisplayName(font) || void 0,
            metadataFilename: buildFontDisplayName(font) || void 0,
            refererPageUrl: resolveFontRefererPage(String(font?.cssSource || ""), String(pageUrl || "")) || void 0
          }
        ),
        25e3,
        `Extract font cache for ${url}`
      );
    } catch {
    }
  });
};
var warmExtractedAssetsInBackground = (images, fonts, pageUrl = "") => {
  setImmediate(() => {
    void (async () => {
      const imageWarmPriority = (img) => {
        const url = String(img?.url || "");
        if (url.startsWith("data:")) return 0;
        if (/\.(?:jpe?g|png|webp|gif|avif)(\?|$)/i.test(url)) return 3;
        if (/\/wp-content\/uploads\//i.test(url)) return 2;
        return 1;
      };
      const prioritizedImages = [...images].sort((a, b) => imageWarmPriority(b) - imageWarmPriority(a)).slice(0, 120);
      const fontsToWarm = fonts.slice(0, 80);
      await mapWithConcurrency(prioritizedImages, 8, async (img) => {
        const url = String(img?.url || "");
        if (!url || url.startsWith("data:")) return;
        const existing = await readExistingOriginalAssetUrl(url, "image");
        if (existing) {
          if (/\.(?:webp|avif)(?:[?#]|$)/i.test(url)) {
            void warmRasterConversionVariants(url, existing).catch(() => void 0);
          }
          return;
        }
        try {
          assertPublicAssetUrl(url);
          await withTimeout(
            warmCachedOriginalAssetForExtraction(
              url,
              "image",
              inferImageTypeFromUrl(url, String(img?.type || "")) || getAssetTypeFromUrl(url, img?.type || "bin"),
              { refererPageUrl: pageUrl }
            ),
            4500,
            `Background image warm for ${url}`
          );
        } catch {
        }
      });
      await mapWithConcurrency(fontsToWarm, 8, async (font) => {
        const url = String(font?.url || "");
        if (!url || url.startsWith("data:")) return;
        const existing = await readExistingOriginalAssetUrl(url, "font");
        if (existing) {
          void warmFontConversionVariants(url, existing, String(font?.format || "woff2"), {
            cssSource: String(font?.cssSource || ""),
            refererPageUrl: String(lastExtractedSourceUrl || "")
          }).catch(() => void 0);
          return;
        }
        try {
          assertPublicAssetUrl(url);
          await withTimeout(
            warmCachedOriginalAssetForExtraction(
              url,
              "font",
              getFontFormatFromUrlOrType(url, String(font?.format || "bin")),
              {
                preferredBase: buildFontDisplayName(font) || void 0,
                metadataFilename: buildFontDisplayName(font) || void 0,
                refererPageUrl: resolveFontRefererPage(String(font?.cssSource || ""), String(lastExtractedSourceUrl || "")) || void 0
              }
            ),
            2e4,
            `Background font warm for ${url}`
          );
        } catch {
        }
      });
    })().catch(() => void 0);
  });
};
var filterUnavailableSitecoreFonts = async (fonts, pageUrl = "") => {
  const referer = resolveFontRefererPage("", pageUrl);
  const results = await mapWithConcurrency(fonts, 10, async (font) => {
    const url = String(font?.url || "");
    if (!url || url.startsWith("data:") || /fonts\.gstatic\.com/i.test(url)) return font;
    if (!/\/-\/media\/.*\/fonts\//i.test(url)) return font;
    const probed = await fetchRemoteFontBufferViaCurl(url, referer);
    return probed ? font : null;
  });
  return results.filter(Boolean).sort((a, b) => {
    const familyA = buildFontDisplayName(a) || a.family || "";
    const familyB = buildFontDisplayName(b) || b.family || "";
    return familyA.localeCompare(familyB);
  });
};
var isLikelyEncodedVideoPlaceholderTitle = (value = "") => /^[A-Za-z0-9+/_=-]{24,}\.*$/.test(String(value || "").trim()) && !/\s/.test(String(value || "").trim());
var isDirectVideoCandidateUrl = (rawUrl = "") => /\.(?:mp4|webm|mov|mkv|m4v|m3u8|mpd)(?:[?#]|$)/i.test(String(rawUrl || "")) || /\/(?:videoplayback|progressive_redirect\/download)\b|vimeocdn\.com|vod-adaptive\.akamaized\.net|wistia\.com\/deliveries\//i.test(String(rawUrl || ""));
var isLikelyBlankEmbeddedVideoCard = (video, targetUrl = "") => {
  const candidates = [
    video?.url,
    video?.sourceStreamUrl,
    video?.downloadUrl,
    video?.originalUrl,
    video?.embedUrl,
    video?.sourceUrl,
    video?.pageUrl,
    targetUrl
  ].map((candidate) => String(candidate || "").trim()).filter(Boolean);
  if (candidates.some(isWistiaHelperResourceUrl)) return true;
  if (candidates.some((candidate) => /(?:wistia\.com|wistia\.net)\/deliveries\//i.test(candidate)) && !video?.isWistiaDirect && !video?.height && !video?.width && !/\b(?:mp4|m3u8|hls)\b/i.test(String(video?.type || video?.format || video?.resolution || ""))) {
    return true;
  }
  if (candidates.some(isDirectVideoCandidateUrl)) return false;
  const title = String(video?.title || video?.name || video?.label || "").trim();
  const hasPreview = /^https?:\/\//i.test(String(video?.thumbnail || video?.poster || "").trim());
  if (hasPreview) return false;
  const hasHttpCandidate = candidates.some((candidate) => /^https?:\/\//i.test(candidate));
  if (!hasHttpCandidate) return true;
  if (isLikelyEncodedVideoPlaceholderTitle(title)) return true;
  return /(?:embedded\s+player|video\s+player)/i.test(String(video?.type || video?.provider || video?.label || "")) && !candidates.some((candidate) => /youtube\.com|youtu\.be|vimeo\.com|wistia\.com|brightcove|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com/i.test(candidate));
};
var dedupeExtractedAssets = async (images, videos, fonts, colors, targetUrl, fallbackThumb = "", options = {}) => {
  const normalizedTargetImageUrl = (() => {
    try {
      const parsed = new URL2(targetUrl);
      parsed.hash = "";
      return parsed.href.replace(/\/+$/, "");
    } catch {
      return String(targetUrl || "").replace(/[#?].*$/, "").replace(/\/+$/, "");
    }
  })();
  const isUsableExtractedImage = (img) => {
    const url = String(img?.url || "").trim();
    if (!url || isBotWallImageUrl(url) || isJunkImageUrl(url)) return false;
    try {
      const parsed = new URL2(url);
      parsed.hash = "";
      if (parsed.href.replace(/\/+$/, "") === normalizedTargetImageUrl) return false;
    } catch {
    }
    return true;
  };
  const iconPool = [...options.extraIcons || [], ...images.filter((item) => classifyAssetIconCandidate(item))];
  const baseImages = await repairMalformedToyotaCountedSequences(
    images.filter((item) => !classifyAssetIconCandidate(item)),
    targetUrl
  );
  const hasTrustedToyotaSequence = shouldSuppressToyotaSequenceAutoExpansion(targetUrl) && baseImages.some((item) => {
    const source = String(item?.source || "").trim();
    const count = Number(item?.sequenceCount || 0);
    return source.includes("360-sequence") && count >= 8;
  });
  let imagePool = hasTrustedToyotaSequence ? baseImages : await expandAvailableImageSequences(baseImages, targetUrl);
  imagePool = await filterUnavailableGeneratedImageSequences(imagePool, targetUrl);
  imagePool = keepBestToyotaSequenceGroup(imagePool, targetUrl);
  const uniqueIcons = dedupeImagesByCanonicalKey(
    Array.from(new Set(iconPool.map((item) => item.url))).map((url) => iconPool.find((item) => item.url === url)).filter(Boolean).filter(isUsableExtractedImage)
  );
  const uniqueImages = dedupeImagesByCanonicalKey(
    Array.from(new Set(imagePool.map((item) => item.url))).map((url) => imagePool.find((item) => item.url === url)).filter(Boolean).filter(isUsableExtractedImage)
  );
  const videoKey = (video) => {
    const raw = String(video?.url || video?.sourceStreamUrl || video?.sourceUrl || "");
    try {
      const parsed = new URL2(raw);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host.includes("vimeo.com")) {
        const idMatch = parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/) || parsed.pathname.match(/\/video\/(\d+)/) || parsed.pathname.match(/\/videos\/(\d+)/) || parsed.pathname.match(/^\/(\d+)/);
        if (idMatch?.[1]) {
          return `vimeo:${idMatch[1]}`;
        }
      }
      if (host.includes("brightcove.net")) {
        const brightcove = parseBrightcovePlayerUrl(parsed.href);
        return `brightcove:${brightcove?.accountId || host}:${brightcove?.videoId || parsed.pathname}:${video?.height || video?.displayQualityKey || video?.qualityRequested || "stream"}`;
      }
      if (host.includes("wistia.com") || host.includes("wistia.net")) {
        const idMatch = parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
        const wistiaId = video?.wistiaHashedId || idMatch?.[1];
        if (wistiaId) {
          if (video?.isWistiaDirect || video?.height) {
            return `wistia:${wistiaId}:${video?.height || "h"}`;
          }
          return `wistia:${wistiaId}`;
        }
        if (parsed.pathname.includes("/deliveries/")) {
          const deliveryId = parsed.pathname.split("/deliveries/")[1]?.split(/[/?#]/)[0] || parsed.pathname;
          return `wistia-delivery:${deliveryId}:${video?.height || "stream"}`;
        }
      }
      parsed.hash = "";
      parsed.searchParams.sort();
      return parsed.toString();
    } catch {
      return raw;
    }
  };
  const videoRank = (video) => {
    const raw = String(video?.url || "");
    if (video?.isVimeoDirect || video?.isYouTubeDirect || video?.isWistiaDirect || video?.isDirect) return 4;
    if (isLikelyDirectVideoStreamUrl(raw)) return 3;
    if (isPlatformVideoUrl(raw)) return 2;
    return 1;
  };
  const videoByKey = /* @__PURE__ */ new Map();
  collapseVimeoVideosForClient(videos).forEach((video) => {
    if (!video?.url) return;
    if (isLikelyBlankEmbeddedVideoCard(video, targetUrl)) return;
    if (isUnsupportedVideoResourceUrl(String(video.url || video.sourceStreamUrl || video.sourceUrl || ""))) return;
    const sanitized = sanitizeVideoForClient(video, targetUrl);
    if (!sanitized?.url) return;
    if (isLikelyBlankEmbeddedVideoCard(sanitized, targetUrl)) return;
    if (isUnsupportedVideoResourceUrl(String(sanitized.url || sanitized.sourceStreamUrl || sanitized.sourceUrl || ""))) return;
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
  const videosWithThumbnailFallback = uniqueVideos.map((video) => {
    if (String(video?.thumbnail || video?.poster || "").trim()) return video;
    const streamUrl = String(
      video?.sourceStreamUrl || video?.brightcoveManifestUrl || video?.url || ""
    ).trim();
    if (!/^https?:\/\//i.test(streamUrl) || !isLikelyHttpMediaUrl(streamUrl)) return video;
    const thumbnail = `/api/video-frame-thumbnail?url=${encodeURIComponent(streamUrl)}&sourcePageUrl=${encodeURIComponent(targetUrl)}`;
    return { ...video, thumbnail, thumbnailGenerated: true };
  });
  const metadataFonts = expandVariableFontWeightFaces(
    await enrichFontsWithMetadata(fonts, targetUrl, { fast: options.fast })
  );
  let uniqueFonts = dedupeFontsByLogicalKey(
    Array.from(new Set(metadataFonts.map((font) => `${font.url}|${font.weight || ""}|${font.style || ""}`))).map((key) => {
      const [url, weight, style] = key.split("|");
      return pickBestFontForUrl(
        metadataFonts.filter((font) => String(font?.weight || "") === weight && String(font?.style || "") === style),
        url
      );
    }).filter(Boolean).filter(isSupportedFontAsset)
  );
  if (!options.fast && uniqueFonts.length > 0 && uniqueFonts.length <= 12) {
    uniqueFonts = await filterUnavailableSitecoreFonts(uniqueFonts, targetUrl);
  } else if (uniqueFonts.length > 0) {
    void filterUnavailableSitecoreFonts(uniqueFonts, targetUrl).catch(() => void 0);
  }
  const uniqueColors = getPrimaryExtractedColors(colors);
  if (options.videosOnly) {
    return {
      images: [],
      videos: videosWithThumbnailFallback,
      fonts: [],
      colors: [],
      ...options.sectionMode ? {
        sectionMode: true,
        sectionLabel: options.sectionLabel || "",
        sectionSelector: options.sectionSelector || ""
      } : {}
    };
  }
  if (options.fast) {
    if (uniqueImages.length > 0) {
      await Promise.race([
        Promise.all(
          uniqueImages.slice(0, 64).map(async (img) => {
            const assetUrl = String(img?.url || "");
            if (!assetUrl || assetUrl.startsWith("data:")) return;
            const existing = await readExistingOriginalAssetUrl(assetUrl, "image");
            if (existing) {
              img.cachedUrl = existing;
              img.status = "downloaded";
            }
          })
        ),
        new Promise((r) => setTimeout(r, 3e3))
        // Max 3 seconds for cache checks
      ]).catch(() => {
      });
    }
    warmExtractedAssetsInBackground(uniqueImages, uniqueFonts, targetUrl);
  } else {
    const fontLimit = Math.min(uniqueFonts.length, 80);
    await warmExtractedAssetList([], uniqueFonts, {
      imageLimit: 0,
      fontLimit,
      budgetMs: Math.min(3e4, 8e3 + fontLimit * 200)
    }, targetUrl);
    warmExtractedAssetsInBackground(
      uniqueImages,
      uniqueFonts.slice(fontLimit),
      targetUrl
    );
  }
  const attachCachedUrl = async (asset, kind) => {
    const url = String(asset?.url || "");
    if (!url || url.startsWith("data:")) return withAssetStatus(asset);
    let cachedUrl = await readExistingOriginalAssetUrl(url, kind);
    let enriched = asset;
    if (cachedUrl && kind === "image") {
      const cachedBuffer = await readAssetBufferFromCache(url, "image") || await readAssetBufferFromCache(cachedUrl, "image");
      if (cachedBuffer) {
        const detected = detectRasterFormatFromBuffer(cachedBuffer.buffer);
        enriched = enrichImageAssetMeta(
          detected === "webp" || detected === "avif" ? {
            ...enriched,
            type: detected,
            mimeType: cachedBuffer.contentType || (detected === "webp" ? "image/webp" : "image/avif")
          } : enriched,
          cachedBuffer.buffer,
          cachedBuffer.contentType
        );
      } else {
        enriched = enrichImageAssetMeta(enriched);
      }
      void warmRasterConversionVariants(url, cachedUrl).catch(() => void 0);
    }
    if (cachedUrl && kind === "font") {
      void warmFontConversionVariants(url, cachedUrl, String(asset?.format || "unknown"), {
        cssSource: String(asset?.cssSource || ""),
        refererPageUrl: String(targetUrl || "")
      }).catch(() => void 0);
    }
    return withAssetStatus(cachedUrl ? { ...enriched, cachedUrl } : enriched);
  };
  const fallbackImages = uniqueImages.map((img) => withAssetStatus(enrichImageAssetMeta(img)));
  const fallbackIcons = uniqueIcons.map((img) => withAssetStatus(enrichImageAssetMeta(img)));
  const fallbackFonts = uniqueFonts.map((font) => withAssetStatus(font));
  const resultImages = (await Promise.race([
    Promise.all(uniqueImages.map((img) => attachCachedUrl(enrichImageAssetMeta(img), "image"))),
    options.fast ? new Promise((resolve) => setTimeout(() => resolve(fallbackImages), 2e3)) : new Promise(() => {
    })
  ]).catch(() => fallbackImages)).sort((a, b) => {
    const rank = (item) => item?.cachedUrl || item?.status === "downloaded" ? 0 : item?.status === "path-only" ? 1 : 2;
    return rank(a) - rank(b);
  });
  const resultIcons = (await Promise.race([
    Promise.all(uniqueIcons.map((img) => attachCachedUrl(enrichImageAssetMeta(img), "image"))),
    options.fast ? new Promise((resolve) => setTimeout(() => resolve(fallbackIcons), 1e3)) : new Promise(() => {
    })
  ]).catch(() => fallbackIcons)).sort((a, b) => String(a?.url || "").localeCompare(String(b?.url || "")));
  const resultVideos = videosWithThumbnailFallback.map((video) => withAssetStatus(video));
  const resultFonts = await Promise.race([
    Promise.all(uniqueFonts.map((font) => attachCachedUrl(font, "font"))),
    options.fast ? new Promise((resolve) => setTimeout(() => resolve(fallbackFonts), 1e3)) : new Promise(() => {
    })
  ]).catch(() => fallbackFonts);
  return {
    // Keep icons in their dedicated collection for category-aware clients, but
    // also include them in the primary image list. Packaged/background extract
    // completion historically merged only `images`, which caused discovered SVG
    // sprite symbols to disappear even though extraction had found them.
    images: Array.from(
      new Map([...resultImages, ...resultIcons].map((item) => [String(item?.url || ""), item])).values()
    ).filter((item) => item?.url),
    icons: resultIcons,
    videos: resultVideos,
    fonts: resultFonts,
    colors: uniqueColors,
    ...options.sectionMode ? {
      extractionMeta: {
        mode: "section",
        sectionLabel: options.sectionLabel || "",
        sectionSelector: options.sectionSelector || ""
      }
    } : {}
  };
};
var enrichAssetsFromHtml = async (html, targetUrl, assets, options = {}) => {
  const $ = cheerio.load(html);
  const pagePrimaryThumb = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
  const resolvedPagePrimaryThumb = pagePrimaryThumb ? resolveUrl(targetUrl, pagePrimaryThumb) || pagePrimaryThumb : "";
  const pageTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").first().text().trim() || "Video link";
  extractVimeoUrlsFromText(html, targetUrl).forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
  extractWistiaIdsFromText(`${targetUrl}
${html}`, targetUrl).forEach((wistiaId) => assets.wistiaCandidateIds.add(wistiaId));
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
  const addVideoCandidate = (urlStr, poster, title) => {
    if (!urlStr) return;
    const normalizedRaw = String(urlStr).trim().replace(/ /g, "%20");
    const absoluteUrl = sanitizeStreamUrl(normalizedRaw, targetUrl);
    if (!absoluteUrl || absoluteUrl.startsWith("data:")) return;
    if (!isLikelyVideoAssetUrl(absoluteUrl) && !isPlatformVideoUrl(absoluteUrl)) return;
    assets.videos.push({
      url: absoluteUrl,
      sourceUrl: targetUrl,
      provider: platformProviderFromUrl(absoluteUrl),
      type: isPlatformVideoUrl(absoluteUrl) ? "video" : getAssetTypeFromUrl(absoluteUrl, "video"),
      title: title || pageTitle,
      thumbnail: poster ? resolveUrl(targetUrl, poster) || poster : resolvedPagePrimaryThumb,
      status: DEFAULT_ASSET_STATUS
    });
  };
  $("video source, video").each((_, el) => {
    const poster = $(el).attr("poster");
    addVideoCandidate($(el).attr("src"), poster);
    $(el).find("source").each((__, sourceEl) => addVideoCandidate($(sourceEl).attr("src"), poster));
  });
  const htmlVideoUrlRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#\s"'<>\\])(?:[?#][^\s"'<>\\]*)?/gi;
  const htmlVideoUrlRegexLoose = /https?:\/\/[^"'<>\\]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'<>\\])(?:[?#][^"'<>\\]*)?/gi;
  const videoSearchText = html.replace(/\\/g, "");
  (videoSearchText.match(htmlVideoUrlRegex) || []).forEach((match) => addVideoCandidate(match));
  (videoSearchText.match(htmlVideoUrlRegexLoose) || []).forEach((match) => addVideoCandidate(match));
  extractYouTubeUrlsFromText(html, targetUrl).forEach((youtubeUrl) => addVideoCandidate(youtubeUrl));
  $("iframe[src], iframe[data-src], embed[src]").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    if (!/youtube|youtu\.be|vimeo|wistia|brightcove|vidyard|loom|\.mp4|\.webm|\.m3u8/i.test(src)) return;
    const absolute = resolveUrl(targetUrl, src) || src;
    if (/vimeo\.com/i.test(absolute)) {
      extractVimeoUrlsFromText(absolute, targetUrl).forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
      return;
    }
    addVideoCandidate(absolute, "", pageTitle);
  });
  extractBrightcoveVideosFromHtml(html, targetUrl).forEach((brightcoveVideo) => {
    assets.videos.push({
      ...brightcoveVideo,
      thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb
    });
  });
  if (!options.fast) {
    try {
      const deepVideoCandidates = await withTimeout(
        discoverSiteVideoCandidates(targetUrl, html),
        1e4,
        `Deep video crawl for ${targetUrl}`
      );
      deepVideoCandidates.vimeoUrls.forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
      (deepVideoCandidates.wistiaIds || []).forEach((wistiaId) => assets.wistiaCandidateIds.add(wistiaId));
      deepVideoCandidates.videoUrls.forEach((videoUrl) => addVideoCandidate(videoUrl));
      (deepVideoCandidates.brightcoveVideos || []).forEach((brightcoveVideo) => {
        assets.videos.push({
          ...brightcoveVideo,
          thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb
        });
      });
    } catch (error) {
      console.warn("Deep video crawl failed:", error?.message || error);
    }
  }
  if (!options.videosOnly) {
    $("style").each((_, el) => {
      const cssText = $(el).html();
      if (!cssText) return;
      assets.fonts.push(...extractFontsFromCss(cssText, targetUrl));
      assets.colors.push(...extractColorsFromCss(cssText));
    });
    $("[fill], [stroke], [color], [bgcolor]").each((_, el) => {
      const addColor = (value) => {
        if (!value || value === "none" || value === "transparent" || value.startsWith("url(") || value.startsWith("var(")) return;
        if (value.startsWith("#") || value.startsWith("rgb") || value.startsWith("hsl") || /^[a-zA-Z]+$/.test(value)) {
          assets.colors.push(value.toLowerCase().replace(/\s+/g, ""));
        }
      };
      addColor($(el).attr("fill"));
      addColor($(el).attr("stroke"));
      addColor($(el).attr("color"));
      addColor($(el).attr("bgcolor"));
    });
    $('link[rel="preload"][as="font"], link[as="font"], link[href*=".woff"], link[href*=".woff2"], link[href*=".ttf"], link[href*=".otf"], link[href*=".eot"]').each((_, el) => {
      const href = $(el).attr("href");
      const abs = href ? resolveUrl(targetUrl, href) : null;
      if (abs && !abs.startsWith("data:") && isSupportedFontAsset({ url: abs, format: getAssetTypeFromUrl(abs, "unknown") })) {
        assets.fonts.push({
          family: "",
          url: abs,
          format: getAssetTypeFromUrl(abs, "unknown"),
          status: DEFAULT_ASSET_STATUS
        });
      }
    });
  }
  return { resolvedPagePrimaryThumb, pageTitle };
};
var extractStaticAssets = async (targetUrl, preloadedHtml = "", options = {}) => {
  const images = [];
  const videos = [];
  let fonts = [];
  let colors = [];
  const vimeoCandidateUrls = /* @__PURE__ */ new Set();
  const wistiaCandidateIds = /* @__PURE__ */ new Set();
  extractWistiaIdsFromText(targetUrl, targetUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));
  const html = preloadedHtml || await withTimeout(fetchSiteHtml(targetUrl), 28e3, `Static HTML fetch for ${targetUrl}`).catch(() => "");
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
    wistiaCandidateIds
  }, { fast: options.fast, videosOnly: options.videosOnly });
  const ustudioEmbedUrls = extractUstudioEmbedUrlsFromText(html, targetUrl);
  if (ustudioEmbedUrls.length > 0) {
    videos.push(...await withTimeout(
      extractUstudioVideos(ustudioEmbedUrls),
      options.fast ? 8e3 : 14e3,
      `Ustudio extraction for ${targetUrl}`
    ).catch((error) => {
      console.warn("Ustudio extraction failed:", error?.message || error);
      return [];
    }));
  }
  if (!options.videosOnly) {
    fonts.push(...recoverKnownThemeFontCandidates(html, targetUrl));
  }
  if (!options.videosOnly && html) {
    const providerFonts = await withTimeout(
      fetchImportedFontProviderFonts(targetUrl, html),
      options.fast ? 18e3 : 3e4,
      `Font provider scan for ${targetUrl}`
    ).catch(() => []);
    fonts.push(...providerFonts);
  }
  const htmlVideoPlayers = html ? buildWebsiteVideoPlayersFromHtml(html, targetUrl) : [];
  if (htmlVideoPlayers.length > 0) {
    htmlVideoPlayers.forEach((player) => {
      const normalized = normalizeVimeoUrl(String(player.url || ""));
      if (normalized) vimeoCandidateUrls.add(normalized);
    });
    videos.push(...htmlVideoPlayers);
  }
  if (videos.length === 0) {
    const addStaticVideoUrl = (rawUrl) => {
      const normalized = String(rawUrl || "").trim().replace(/\\/g, "").replace(/ /g, "%20");
      if (!normalized || normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
      const absoluteUrl = sanitizeStreamUrl(normalized, targetUrl) || encodeURI(normalized);
      if (!absoluteUrl || absoluteUrl.startsWith("data:") || absoluteUrl.startsWith("blob:")) return;
      videos.push({
        url: absoluteUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(absoluteUrl),
        type: isPlatformVideoUrl(absoluteUrl) ? "video" : getAssetTypeFromUrl(absoluteUrl, "video"),
        title: "Video",
        thumbnail: resolvedPagePrimaryThumb
      });
    };
    const escapedVideoUrlRegex = /\\"videoUrl\\":\\"([^"]+\.(?:m3u8|mpd|mp4)[^"]*)\\"/gi;
    let match;
    while ((match = escapedVideoUrlRegex.exec(html)) !== null) {
      addStaticVideoUrl(match[1]);
    }
    const plainVideoUrlRegex = /"videoUrl"\s*:\s*"([^"]+\.(?:m3u8|mpd|mp4)[^"]*)"/gi;
    while ((match = plainVideoUrlRegex.exec(html)) !== null) {
      addStaticVideoUrl(match[1]);
    }
    const simpleVideoUrlMatch = html.match(/videoUrl"\s*:\s*"(https?:\/\/[^"]+)"/i) || html.match(/videoUrl":"(https?:\/\/[^"]+)"/i);
    if (simpleVideoUrlMatch?.[1]) {
      addStaticVideoUrl(simpleVideoUrlMatch[1]);
    }
    const videoSearchText = html.replace(/\\/g, "");
    const candidateRegex = /https?:\/\/[^"'<>]+\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'<>])(?:[?#][^"'<>]*)?/gi;
    (videoSearchText.match(candidateRegex) || []).slice(0, 40).forEach((raw) => addStaticVideoUrl(raw));
  }
  const resolveVimeoCandidateVideos = async (timeoutMs, label) => {
    if (vimeoCandidateUrls.size === 0) return;
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(Array.from(vimeoCandidateUrls), "fhd", targetUrl),
        timeoutMs,
        label
      );
      videos.push(...vimeoAssets.videos || []);
      if (!options.videosOnly) images.push(...vimeoAssets.images || []);
    } catch (error) {
      console.warn(`${label} failed:`, error?.message || error);
      videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
    }
  };
  const resolveWistiaCandidateVideos = async (timeoutMs, label) => {
    if (wistiaCandidateIds.size === 0) return;
    try {
      const wistiaAssets = await withTimeout(
        extractWistiaVideos(Array.from(wistiaCandidateIds), "fhd"),
        timeoutMs,
        label
      );
      videos.push(...wistiaAssets.videos || []);
      if (!options.videosOnly) images.push(...wistiaAssets.images || []);
    } catch (error) {
      console.warn(`${label} failed, using placeholders:`, error?.message || error);
      videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
    }
  };
  const deferVimeoHomepageStreamUpgrade = !options.videosOnly && isPlatformMarketingHomepage(targetUrl);
  if (vimeoCandidateUrls.size > 0 && deferVimeoHomepageStreamUpgrade) {
    videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
  } else if (vimeoCandidateUrls.size > 0 && htmlVideoPlayers.length === 0) {
    await resolveVimeoCandidateVideos(
      options.fast ? 8e3 : VIMEO_EXTRACT_TIMEOUT_MS,
      options.fast ? `Fast static Vimeo extraction for ${targetUrl}` : `Static Vimeo extraction for ${targetUrl}`
    );
  } else if (vimeoCandidateUrls.size > 0 && htmlVideoPlayers.length > 0) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(Array.from(vimeoCandidateUrls), "fhd", targetUrl),
        options.fast ? 12e3 : 45e3,
        `Quick Vimeo upgrade for ${targetUrl}`
      );
      videos.push(...vimeoAssets.videos || []);
      if (!options.videosOnly) images.push(...vimeoAssets.images || []);
    } catch (error) {
      console.warn("Quick Vimeo upgrade skipped:", error?.message || error);
    }
  }
  await resolveWistiaCandidateVideos(
    options.fast ? 8e3 : 12e3,
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
    const embedsResolved = options.videosOnly ? !staticExtractHasUnresolvedEmbeds(html, { videos }, options) : true;
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
          videosOnly: options.videosOnly
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
    options.fast ? 2e4 : 3e4,
    `CSS asset scan for ${targetUrl}`
  ).catch(() => ({ inlineStyles: [], fetchedCss: [] }));
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
var extractQuickAssets = async (targetUrl, options = {}) => {
  const images = [];
  const videos = [];
  let fonts = [];
  let colors = [];
  const vimeoCandidateUrls = /* @__PURE__ */ new Set();
  const wistiaCandidateIds = /* @__PURE__ */ new Set();
  const html = await withTimeout(fetchQuickSiteHtml(targetUrl), 1e4, `Quick HTML fetch for ${targetUrl}`).catch(() => "");
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
    wistiaCandidateIds
  }, { fast: true, videosOnly: options.videosOnly });
  if (!options.videosOnly) {
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
var recoverKnownThemeFontCandidates = (html, targetUrl) => {
  const text = String(html || "");
  const fonts = [];
  const addFont = (rawUrl, family, format, cssSource = targetUrl) => {
    const url = resolveUrl(targetUrl, rawUrl);
    if (!url) return;
    fonts.push({
      family,
      url,
      format,
      cssSource,
      weight: "normal",
      style: "normal",
      source: "theme-font-recovery",
      status: DEFAULT_ASSET_STATUS
    });
  };
  if (/uncode-icons\.css|uncodeicon|uncode-icon|fa[bcirs]?\s+fa-|fa-(?:solid|regular|brands)/i.test(text)) {
    addFont("/fonts/uncode-icons.woff2", "uncodeicon", "woff2");
    addFont("/fonts/uncode-icons.woff", "uncodeicon", "woff");
    addFont("/fonts/uncode-icons.ttf", "uncodeicon", "ttf");
    addFont("/wp-content/themes/uncode/library/fonts/uncode-icons.woff2", "uncodeicon", "woff2");
  }
  return fonts;
};
var needsMp4Transcode = (rawUrl, contentType) => {
  const loweredUrl = String(rawUrl || "").toLowerCase();
  const loweredType = String(contentType || "").toLowerCase();
  if (/\.(webm|mov|m3u8|mpd|mkv)(\?|$)/i.test(loweredUrl)) return true;
  if (loweredType.includes("video/mp4")) return false;
  if (loweredType.includes("video/webm") || loweredType.includes("application/x-mpegurl") || loweredType.includes("application/vnd.apple.mpegurl") || loweredType.includes("application/dash+xml") || loweredType.includes("video/quicktime") || loweredType.includes("video/x-matroska")) {
    return true;
  }
  return false;
};
var validateOutputFile = async (outputPath, label) => {
  const stat = await fsp3.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 1024) {
    throw new Error(`${label} output was not created.`);
  }
  return stat;
};
var validateSavedAssetFile = async (outputPath, label) => {
  const stat = await fsp3.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new Error(`${label} output was not created.`);
  }
  return stat;
};
var MediaExtractionError = class extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
};
var probeMediaFile = (inputPath) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(inputPath, (error, metadata) => {
    if (error) reject(error);
    else resolve(metadata);
  });
});
var STRICT_YOUTUBE_AUDIO_VERIFY = process.env.VDX_STRICT_YOUTUBE_AUDIO_VERIFY === "1";
var assertLocalFileHasAudio = async (inputPath) => {
  const metadata = await probeMediaFile(inputPath);
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const audioStream = streams.find((stream) => stream?.codec_type === "audio" && stream?.codec_name && stream.codec_name !== "unknown");
  if (!audioStream) {
    throw new MediaExtractionError("Audio track unavailable for this video.", 422);
  }
  return audioStream;
};
var verifyMergedYouTubeFile = async (inputPath) => {
  const stat = await fsp3.stat(inputPath).catch(() => null);
  if (!stat || stat.size < 1024) {
    throw new MediaExtractionError("Merged YouTube file missing or too small.", 422);
  }
  logYouTubeMerge("verify-start", {
    mergedOutputPath: inputPath,
    fileSize: stat.size,
    tempFolder: path3.dirname(inputPath),
    strictAudioVerify: STRICT_YOUTUBE_AUDIO_VERIFY
  });
  try {
    const audioStream = await assertLocalFileHasAudio(inputPath);
    const metadata = await probeMediaFile(inputPath);
    const probe = describeMediaProbe(metadata);
    logYouTubeMerge("verify-ok", {
      mergedOutputPath: inputPath,
      hasAudio: true,
      audioCodec: probe.audioCodec,
      videoCodec: probe.videoCodec
    });
    return { ...probe, hasAudio: true, audioVerified: true, audioStream };
  } catch (probeError) {
    logYouTubeMerge("verify-audio-probe-failed", {
      mergedOutputPath: inputPath,
      fileSize: stat.size,
      error: probeError?.message || String(probeError)
    });
    if (STRICT_YOUTUBE_AUDIO_VERIFY) throw probeError;
    return {
      hasVideo: true,
      hasAudio: true,
      audioVerified: false,
      audioCodec: "",
      videoCodec: "",
      warning: probeError?.message || "Audio probe skipped; merged file exists."
    };
  }
};
var describeMediaProbe = (metadata) => {
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videoStream = streams.find((stream) => stream?.codec_type === "video");
  const audioStream = streams.find((stream) => stream?.codec_type === "audio" && stream?.codec_name && stream.codec_name !== "unknown");
  return {
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream?.codec_name || "",
    audioCodec: audioStream?.codec_name || "",
    pixFmt: String(videoStream?.pix_fmt || ""),
    width: Number(videoStream?.width || 0) || void 0,
    height: Number(videoStream?.height || 0) || void 0,
    duration: Number(metadata?.format?.duration || 0) || void 0,
    bitrate: Number(metadata?.format?.bit_rate || 0) || void 0
  };
};
var isQuickTimeCompatibleProbe = (probe) => {
  const videoCodec = String(probe.videoCodec || "").toLowerCase();
  const audioCodec = String(probe.audioCodec || "").toLowerCase();
  const pixFmt = String(probe.pixFmt || "").toLowerCase();
  if (/^(vp9|av01|av1|hevc|h265|theora|vorbis)$/i.test(videoCodec)) return false;
  const videoOk = probe.hasVideo && (videoCodec === "h264" || videoCodec.startsWith("avc1") || videoCodec.includes("h264"));
  const audioOk = !probe.hasAudio || audioCodec === "aac" || audioCodec.startsWith("mp4a") || audioCodec.includes("aac");
  const pixOk = !pixFmt || pixFmt === "yuv420p" || pixFmt === "yuvj420p";
  return videoOk && audioOk && pixOk;
};
var ensureQuickTimeCompatibleMp4 = async (inputPath, options = {}) => {
  const metadata = await probeMediaFile(inputPath);
  const probe = describeMediaProbe(metadata);
  const quality = options.quality || "fhd";
  const titleHint = options.titleHint || path3.basename(inputPath, path3.extname(inputPath));
  const desiredOutput = options.outputPath || path3.join(path3.dirname(inputPath), toQuickTimeVideoFilename(titleHint, quality));
  const tempOutput = `${desiredOutput}.part`;
  if (isQuickTimeCompatibleProbe(probe)) {
    const cmd = ffmpeg(inputPath).outputOptions(["-c copy", "-movflags +faststart", "-f mp4"]);
    await waitForFfmpegFile(cmd, tempOutput, "QuickTime faststart remux");
  } else {
    const cmd = ffmpeg(inputPath).outputOptions([
      "-c:v libx264",
      "-preset veryfast",
      "-crf 23",
      "-pix_fmt yuv420p",
      "-c:a aac",
      "-b:a 192k",
      "-movflags +faststart",
      "-f mp4"
    ]);
    await waitForFfmpegFile(cmd, tempOutput, "QuickTime transcode");
  }
  await fsp3.mkdir(path3.dirname(desiredOutput), { recursive: true }).catch(() => void 0);
  if (path3.resolve(desiredOutput) !== path3.resolve(inputPath)) {
    await fsp3.unlink(desiredOutput).catch(() => void 0);
  }
  await fsp3.rename(tempOutput, desiredOutput);
  if (path3.resolve(desiredOutput) !== path3.resolve(inputPath)) {
    await fsp3.unlink(inputPath).catch(() => void 0);
  }
  const finalProbe = describeMediaProbe(await probeMediaFile(desiredOutput));
  return {
    outputPath: desiredOutput,
    probe: finalProbe,
    quickTimeCompatible: isQuickTimeCompatibleProbe(finalProbe),
    remuxedOnly: isQuickTimeCompatibleProbe(probe)
  };
};
var waitForFfmpegFile = async (cmd, outputPath, label, { timeoutMs = 8 * 60 * 1e3, stallMs = 75 * 1e3 } = {}) => {
  await new Promise((resolve, reject) => {
    let settled = false;
    let lastActivity = Date.now();
    const markActivity = () => {
      lastActivity = Date.now();
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const kill = () => {
      try {
        cmd.kill("SIGKILL");
      } catch {
      }
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) {
        kill();
        finish(new Error(`${label} stalled while processing.`));
      }
    }, 5e3);
    const timeout = setTimeout(() => {
      kill();
      finish(new Error(`${label} timed out.`));
    }, timeoutMs);
    cmd.on("start", (commandLine) => {
      markActivity();
      logYouTubeMerge("ffmpeg-spawn", { label, commandLine: String(commandLine || "").slice(0, 500), outputPath });
    }).on("codecData", markActivity).on("progress", markActivity).on("stderr", (line) => {
      markActivity();
      if (/error|failed/i.test(String(line || ""))) {
        logYouTubeMerge("ffmpeg-stderr", { label, line: String(line || "").slice(0, 400) });
      }
    }).on("end", () => finish()).on("close", markActivity).on("exit", (code) => {
      markActivity();
      if (code && code !== 0) {
        logYouTubeMerge("ffmpeg-exit", { label, exitCode: code, outputPath });
      }
    }).on("error", (err) => {
      logYouTubeMerge("ffmpeg-error", { label, error: err?.message || String(err), exitCode: err?.exitCode ?? null, outputPath });
      finish(err);
    }).save(outputPath);
  });
  return validateOutputFile(outputPath, label);
};
var transcodeUrlToMp4File = async (inputUrl, outputPath, referer, origin) => {
  const headerLines = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join("\r\n")}\r
` : "";
  const cmd = ffmpeg(inputUrl);
  if (headersArg) {
    cmd.inputOptions(["-headers", headersArg]);
  }
  cmd.outputOptions([
    "-c:v libx264",
    "-preset veryfast",
    "-crf 23",
    "-c:a aac",
    "-movflags +faststart",
    "-f mp4"
  ]);
  await waitForFfmpegFile(cmd, outputPath, "MP4 conversion");
};
var audioDurationOptions = (durationSeconds) => durationSeconds && durationSeconds > 0 ? [`-t ${durationSeconds}`] : [];
var transcodeLocalFileToMp3File = async (inputPath, outputPath, bitrate = "192k", options = {}) => {
  const cmd = ffmpeg(inputPath).noVideo().audioCodec("libmp3lame").audioBitrate(bitrate).audioChannels(2).audioFrequency(44100).outputOptions([
    ...audioDurationOptions(options.durationSeconds),
    "-map 0:a:0?"
  ]).format("mp3");
  await waitForFfmpegFile(cmd, outputPath, "Local audio extraction", {
    timeoutMs: options.timeoutMs || 6 * 60 * 1e3,
    stallMs: options.stallMs || 55 * 1e3
  });
};
var downloadUrlToFile = async (sourceUrl, outputPath, sourcePageUrl) => {
  const headers = mediaRequestHeaders(sourceUrl, sourcePageUrl);
  const response = await axios({
    method: "GET",
    url: sourceUrl,
    responseType: "stream",
    timeout: 12e4,
    maxRedirects: 4,
    headers,
    httpsAgent: relaxedHttpsAgent
  });
  await new Promise((resolve, reject) => {
    const out = fs2.createWriteStream(outputPath);
    response.data.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    response.data.on("error", reject);
  });
  return validateOutputFile(outputPath, "Source download");
};
var transcodeUrlToMp3File = async (inputUrl, outputPath, referer, origin, bitrate = "192k", options = {}) => {
  const headerLines = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join("\r\n")}\r
` : "";
  const cmd = ffmpeg(inputUrl);
  if (headersArg) {
    cmd.inputOptions(["-headers", headersArg]);
  }
  cmd.noVideo().audioCodec("libmp3lame").audioBitrate(bitrate).audioChannels(2).audioFrequency(44100).outputOptions([
    ...audioDurationOptions(options.durationSeconds),
    "-map 0:a:0?"
  ]).format("mp3");
  await waitForFfmpegFile(cmd, outputPath, "Audio extraction", {
    timeoutMs: options.timeoutMs || 6 * 60 * 1e3,
    stallMs: options.stallMs || 55 * 1e3
  });
};
var copyUrlAudioSegmentToM4aFile = async (inputUrl, outputPath, referer, origin, durationSeconds = 60) => {
  const headerLines = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join("\r\n")}\r
` : "";
  const cmd = ffmpeg(inputUrl);
  if (headersArg) {
    cmd.inputOptions(["-headers", headersArg]);
  }
  cmd.noVideo().audioCodec("copy").outputOptions([
    "-map 0:a:0?",
    ...audioDurationOptions(durationSeconds),
    "-movflags +faststart",
    "-f mp4"
  ]);
  await waitForFfmpegFile(cmd, outputPath, "Audio copy", {
    timeoutMs: 90 * 1e3,
    stallMs: 25 * 1e3
  });
};
var copyUrlAudioToFile = async (inputUrl, outputPath, referer, origin, containerFormat) => {
  const headerLines = [];
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (origin) headerLines.push(`Origin: ${origin}`);
  const headersArg = headerLines.length > 0 ? `${headerLines.join("\r\n")}\r
` : "";
  const cmd = ffmpeg(inputUrl);
  if (headersArg) {
    cmd.inputOptions(["-headers", headersArg]);
  }
  cmd.noVideo().audioCodec("copy").outputOptions([
    "-map 0:a:0?",
    "-vn",
    ...containerFormat === "mp4" ? ["-movflags +faststart"] : [],
    ...containerFormat ? [`-f ${containerFormat}`] : []
  ]);
  await waitForFfmpegFile(cmd, outputPath, "Original audio extraction", {
    timeoutMs: 6 * 60 * 1e3,
    stallMs: 55 * 1e3
  });
};
var toSafeFileBase = (raw) => String(raw || "video").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "video";
var toQualityVideoFilename = (quality, titleHint) => {
  if (titleHint) return toQuickTimeVideoFilename(titleHint, quality);
  if (quality === "fhd") return "FHD_QuickTime.mp4";
  if (quality === "hd") return "HD_QuickTime.mp4";
  if (quality === "4k") return "4K_QuickTime.mp4";
  return `${String(quality || "video").toUpperCase()}_QuickTime.mp4`;
};
var toQuickTimeVideoFilename = (titleHint, quality) => {
  const base = toSafeFileBase(titleHint);
  if (quality === "hd") return `${base}_HD_QuickTime.mp4`;
  if (quality === "4k") return `${base}_4K_QuickTime.mp4`;
  return `${base}_FHD_QuickTime.mp4`;
};
var toQuickTimeAudioFilename = (titleHint) => `${toSafeFileBase(titleHint)}_Audio_128kbps.m4a`;
var toStandardAudioFilename = (mode, titleHint) => {
  if (titleHint && mode !== "hq" && mode !== "original") return toQuickTimeAudioFilename(titleHint);
  if (mode === "hq") return "Audio-HQ.mp3";
  if (mode === "original") return "Audio-Original.m4a";
  return "Audio_128kbps.m4a";
};
var pageTitleFromUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const file = parsed.pathname.split("/").filter(Boolean).pop() || "Video";
    return decodeURIComponent(file).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || "Video";
  } catch {
    return "Video";
  }
};
var toMp4ProxyUrl = (streamUrl, titleHint) => {
  const filename = `${toSafeFileBase(titleHint || "video")}.mp4`;
  const normalized = sanitizeStreamUrl(streamUrl) || streamUrl;
  return `/api/download?url=${encodeURIComponent(normalized)}&filename=${encodeURIComponent(filename)}`;
};
var isGoogleVideoPlaybackUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host.includes("googlevideo.com") || /\/videoplayback(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /googlevideo\.com|\/videoplayback(?:\?|\/|$)/i.test(String(rawUrl || ""));
  }
};
var toAbsoluteAppUrl = (req, relativePath) => {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = req.get("host") || `localhost:${activePort || DEFAULT_PORT}`;
  return `${proto}://${host}${relativePath}`;
};
var unwrapDownloadProxyUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl, `http://localhost:${activePort || DEFAULT_PORT}`);
    if (parsed.pathname === "/api/download" || parsed.pathname === "/api/youtube-merged-stream") {
      return parsed.searchParams.get("url") || rawUrl;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
};
var getStreamRequestContext = (parsedUrl, sourcePageUrl) => {
  const sourceOrigin = parsedUrl.origin;
  const host = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
  const isGoogleVideo = host.includes("googlevideo.com");
  const pageOrigin = (() => {
    try {
      return sourcePageUrl ? new URL2(sourcePageUrl).origin : "";
    } catch {
      return "";
    }
  })();
  const isVimeoCdn = host.includes("vimeocdn.com");
  const referer = isGoogleVideo ? "https://www.youtube.com/" : isVimeoCdn ? pageOrigin ? `${pageOrigin}/` : "https://player.vimeo.com/" : pageOrigin ? `${pageOrigin}/` : `${sourceOrigin}/`;
  const origin = isGoogleVideo ? "https://www.youtube.com" : isVimeoCdn ? "https://player.vimeo.com" : pageOrigin || sourceOrigin;
  return { referer, origin };
};
var openLocalFolder = async (folderPath) => {
  if (process.platform === "darwin") {
    await execFileAsync2("open", [folderPath]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync2("cmd", ["/c", "start", "", folderPath]);
    return;
  }
  await execFileAsync2("xdg-open", [folderPath]);
};
var isPortAvailable = (port) => new Promise((resolve) => {
  const tester = net.createServer().once("error", () => resolve(false)).once("listening", () => {
    tester.close(() => resolve(true));
  }).listen(port, "127.0.0.1");
});
var findAvailablePort = async (preferredPort, attempts = 50) => {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 3e3;
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) return candidate;
  }
  throw new Error("No available local port was found.");
};
var ensureRuntimeToolsReady = async () => {
  console.log("Preparing video engine...");
  try {
    await fsp3.mkdir(appDataDir, { recursive: true });
    await refreshResolvedMediaTools();
    const chromiumPath = findBundledChromiumExecutable();
    if (chromiumPath) await fsp3.chmod(chromiumPath, 493).catch(() => void 0);
    console.log("Optimizing extraction engine...");
    console.log("Setup complete.");
  } catch {
    console.log("Required video tools missing. Restart the app to retry bundled tool setup.");
  }
};
var mediaRequestHeaders = (streamUrl, sourcePageUrl) => {
  let referer;
  let origin;
  try {
    const parsed = new URL2(streamUrl);
    const context = getStreamRequestContext(parsed, sourcePageUrl);
    referer = context.referer;
    origin = context.origin;
  } catch {
  }
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    ...referer ? { "Referer": referer } : {},
    ...origin ? { "Origin": origin } : {}
  };
};
var generateVideoFrameThumbnail = async (streamUrl, sourcePageUrl, req) => {
  const normalized = sanitizeStreamUrl(streamUrl, sourcePageUrl);
  if (!normalized || !isLikelyHttpMediaUrl(normalized)) return "";
  await fsp3.mkdir(generatedThumbnailDir, { recursive: true });
  const hash = crypto2.createHash("sha1").update(normalized).digest("hex");
  const outputPath = path3.join(generatedThumbnailDir, `${hash}.jpg`);
  const existing = await fsp3.stat(outputPath).catch(() => null);
  if (existing && existing.size > 1024) {
    return toAbsoluteAppUrl(req, `/generated-thumbnails/${hash}.jpg`);
  }
  const headers = mediaRequestHeaders(normalized, sourcePageUrl);
  const headerLines = Object.entries(headers).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
  const headerArg = `${headerLines.join("\r\n")}\r
`;
  const renderFrame = async (input, useHeaders) => {
    const cmd = ffmpeg(input).outputOptions(["-frames:v 1", "-q:v 3", "-update 1"]).format("image2");
    if (useHeaders) cmd.inputOptions(["-headers", headerArg]);
    await waitForFfmpegFile(cmd, outputPath, "Thumbnail generation", {
      timeoutMs: 30 * 1e3,
      stallMs: 15 * 1e3
    });
  };
  try {
    await renderFrame(normalized, true);
  } catch (remoteError) {
    await fsp3.unlink(outputPath).catch(() => void 0);
    const validation = await validateStreamUrl(normalized, sourcePageUrl).catch(() => null);
    const isManifestSource = /\.m3u8|\.mpd/i.test(normalized) || /mpegurl|dash\+xml/i.test(String(validation?.contentType || ""));
    const isSmallEnoughForFallback = !validation?.contentLength || validation.contentLength <= 60 * 1024 * 1024;
    if (isManifestSource || !isSmallEnoughForFallback) throw remoteError;
    let tempInput = "";
    try {
      const parsed = new URL2(normalized);
      const ext = path3.extname(parsed.pathname) || ".bin";
      tempInput = path3.join(generatedThumbnailDir, `${hash}-source${ext}`);
      await downloadUrlToFile(normalized, tempInput, sourcePageUrl);
      await renderFrame(tempInput, false);
    } finally {
      if (tempInput) await fsp3.unlink(tempInput).catch(() => void 0);
    }
  }
  return toAbsoluteAppUrl(req, `/generated-thumbnails/${hash}.jpg`);
};
app.get("/api/video-frame-thumbnail", async (req, res) => {
  const streamUrl = String(req.query?.url || "").trim();
  const sourcePageUrl = String(req.query?.sourcePageUrl || "").trim();
  if (!streamUrl) return res.status(400).json({ error: "Video URL is required." });
  try {
    const thumbnailUrl = await generateVideoFrameThumbnail(streamUrl, sourcePageUrl || void 0, req);
    if (!thumbnailUrl) return res.status(404).json({ error: "Video thumbnail is unavailable." });
    return res.redirect(302, thumbnailUrl);
  } catch (error) {
    return res.status(404).json({ error: error?.message || "Video thumbnail generation failed." });
  }
});
var getVideoPreviewMetadata = async (targetUrl) => {
  if (isBrightcoveUrl(targetUrl)) {
    try {
      const info = await getBrightcoveMetadata(targetUrl);
      const thumbnail = sanitizeStreamUrl(
        info.poster || info.thumbnail || info.poster_sources?.[0]?.src || info.thumbnail_sources?.[0]?.src || "",
        targetUrl
      ) || "";
      return {
        sourceUrl: targetUrl,
        thumbnail,
        title: String(info.name || info.title || "Brightcove video"),
        provider: "brightcove"
      };
    } catch {
      return null;
    }
  }
  try {
    const info = await withTimeout(
      youtubedl(targetUrl, {
        dumpSingleJson: true,
        skipDownload: true,
        ...buildYtDlpQueryOptions(targetUrl)
      }),
      9e3,
      `Preview metadata for ${targetUrl}`
    );
    const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
    const bestThumb = thumbnails.filter((thumb) => thumb?.url).sort((a, b) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0))[0]?.url;
    const thumbnail = sanitizeStreamUrl(bestThumb || info.thumbnail || "", targetUrl) || "";
    return {
      sourceUrl: targetUrl,
      thumbnail,
      title: info.title || "Video link",
      provider: platformProviderFromUrl(targetUrl)
    };
  } catch {
    return null;
  }
};
var isAcceptableStreamMime = (contentType, streamUrl) => {
  const lowered = String(contentType || "").toLowerCase();
  if (/video\/|audio\/|mpegurl|dash\+xml|octet-stream|application\/x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(lowered)) return true;
  return isLikelyHttpMediaUrl(streamUrl) || isLikelyDirectVideoStreamUrl(streamUrl) || isLikelyVideoAssetUrl(streamUrl);
};
var validateStreamUrl = async (rawUrl, sourcePageUrl, baseUrl) => {
  const normalized = sanitizeStreamUrl(rawUrl, baseUrl || sourcePageUrl);
  if (!normalized) return { ok: false, reason: "Invalid stream URL." };
  if (isExpiredStreamUrl(normalized)) return { ok: false, url: normalized, reason: "Stream URL expired." };
  const headers = mediaRequestHeaders(normalized, sourcePageUrl);
  const validateHeaders = (status, responseHeaders) => {
    const contentType = String(responseHeaders?.["content-type"] || "");
    const contentLength = Number(responseHeaders?.["content-length"] || 0) || void 0;
    if (status < 200 || status >= 400) {
      return { ok: false, url: normalized, status, contentType, contentLength, reason: `Stream returned ${status}.` };
    }
    if (!isAcceptableStreamMime(contentType, normalized)) {
      return { ok: false, url: normalized, status, contentType, contentLength, reason: `Unexpected stream type ${contentType || "unknown"}.` };
    }
    return { ok: true, url: normalized, status, contentType, contentLength };
  };
  try {
    const head = await axios({
      method: "HEAD",
      url: normalized,
      timeout: 7e3,
      maxRedirects: 4,
      validateStatus: () => true,
      headers,
      httpsAgent: relaxedHttpsAgent
    });
    const checked = validateHeaders(head.status, head.headers);
    if (checked.ok || head.status !== 403 && head.status !== 405) return checked;
  } catch {
  }
  try {
    const ranged = await axios({
      method: "GET",
      url: normalized,
      responseType: "stream",
      timeout: 9e3,
      maxRedirects: 4,
      validateStatus: () => true,
      headers: {
        ...headers,
        Range: "bytes=0-1"
      },
      httpsAgent: relaxedHttpsAgent
    });
    const checked = validateHeaders(ranged.status, ranged.headers);
    ranged.data?.destroy?.();
    return checked;
  } catch (error) {
    return { ok: false, url: normalized, reason: error?.message || "Stream validation failed." };
  }
};
var cleanMediaUrlArtifacts = (rawUrl) => String(rawUrl || "").replace(/(\.mp4)(?:%20|\s)\([^?#]*?\)\.mp4(?=[?#]|$)/ig, "$1").replace(/(\.webm)(?:%20|\s)\([^?#]*?\)\.webm(?=[?#]|$)/ig, "$1").replace(/(\.mov)(?:%20|\s)\([^?#]*?\)\.mov(?=[?#]|$)/ig, "$1");
var sanitizeVideoForClient = (video, baseUrl) => {
  if (!video?.url) return null;
  const normalizedUrl = cleanMediaUrlArtifacts(sanitizeStreamUrl(String(video.url), baseUrl || video.sourceUrl || video.pageUrl) || "");
  if (!normalizedUrl) return null;
  const sourceStreamUrl = video.sourceStreamUrl ? cleanMediaUrlArtifacts(sanitizeStreamUrl(String(video.sourceStreamUrl), baseUrl || video.sourceUrl || video.pageUrl) || video.sourceStreamUrl) : void 0;
  const sourceUrl = video.sourceUrl ? sanitizeStreamUrl(String(video.sourceUrl), baseUrl) || video.sourceUrl : void 0;
  return {
    ...video,
    url: normalizedUrl,
    ...sourceStreamUrl ? { sourceStreamUrl } : {},
    ...sourceUrl ? { sourceUrl } : {}
  };
};
var validateAndNormalizeVideo = async (video, sourcePageUrl, baseUrl) => {
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
    verifiedPlayable: true
  };
};
var toVerifiedPlayableVideo = async (video, sourcePageUrl) => {
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
      verifiedPlayable: true
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
    verifiedPlayable: true
  };
  return enforceMp4VideoPayload(verified);
};
var firstValidStreamCandidate = async (candidates, sourcePageUrl, baseUrl) => {
  for (const candidate of candidates) {
    const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ""), baseUrl || sourcePageUrl);
    if (!normalizedUrl || isExpiredStreamUrl(normalizedUrl)) continue;
    const validation = await validateStreamUrl(normalizedUrl, sourcePageUrl, baseUrl);
    if (validation.ok && validation.url) {
      return {
        ...candidate,
        url: validation.url,
        contentType: validation.contentType,
        contentLength: validation.contentLength
      };
    }
  }
  return null;
};
var enforceMp4VideoPayload = (video) => {
  if (!video?.url) return video;
  const originalUrl = sanitizeStreamUrl(String(video.url), video.sourceUrl || video.pageUrl) || String(video.url);
  if (video?.isYouTubeMerged || String(video.url).includes("/api/youtube-merged-stream?")) {
    return {
      ...video,
      sourceStreamUrl: video.sourceStreamUrl || originalUrl,
      url: String(video.url),
      type: "mp4",
      isMp4Proxy: true,
      isDirect: true
    };
  }
  if (isGoogleVideoPlaybackUrl(originalUrl)) {
    return {
      ...video,
      sourceStreamUrl: originalUrl,
      url: originalUrl,
      type: "mp4",
      isMp4Proxy: false,
      isDirect: true
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
      isDirectAsset: true
    };
  }
  return {
    ...video,
    sourceStreamUrl: originalUrl,
    url: toMp4ProxyUrl(originalUrl, video?.title),
    type: "mp4",
    isMp4Proxy: true
  };
};
var getVimeoTargetHeight = (quality) => {
  if (quality === "4k") return 2160;
  if (quality === "fhd") return 1080;
  return 720;
};
var vimeoMetadataCache = /* @__PURE__ */ new Map();
var vimeoMetadataTtlMs = 3 * 60 * 1e3;
var VIMEO_YTDLP_TIMEOUT_MS = 12e4;
var VIMEO_EXTRACT_TIMEOUT_MS = 13e4;
var isVimeoProgressiveMp4Format = (format) => {
  const protocol = String(format?.protocol || "").toLowerCase();
  const ext = String(format?.ext || "").toLowerCase();
  const formatId = String(format?.format_id || format?.id || "").toLowerCase();
  const formatNote = String(format?.format_note || "").toLowerCase();
  const streamUrl = String(format?.url || "").toLowerCase();
  if (!format?.url || format?.vcodec === "none") return false;
  if (ext !== "mp4") return false;
  if (protocol.includes("m3u8") || protocol.includes("dash")) return false;
  if (formatNote.includes("dash") || formatId.startsWith("dash-") || formatId.startsWith("hls-")) return false;
  return protocol === "https" || protocol === "http" || formatId.startsWith("http-") || streamUrl.includes("progressive_redirect") || /\.mp4(?:\?|$)/i.test(streamUrl);
};
var parseVimeoIdFromUrl = (vimeoUrl) => {
  const value = String(vimeoUrl || "").trim();
  const directMatch = value.match(/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/|progressive_redirect\/(?:download|playback)\/)(\d+)/i);
  if (directMatch?.[1]) return directMatch[1];
  const normalized = normalizeVimeoUrl(vimeoUrl) || vimeoUrl;
  return String(normalized.match(/vimeo\.com\/(\d+)/)?.[1] || "");
};
var extractJsonObjectAfterMarker = (html, marker) => {
  const startIndex = html.indexOf(marker);
  if (startIndex < 0) return null;
  let index = startIndex + marker.length;
  while (index < html.length && /\s/.test(html[index])) index += 1;
  if (html[index] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
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
var parseVimeoPlayerConfigFromHtml = (html) => {
  const markers = ["window.playerConfig = ", "var playerConfig = ", "playerConfig = "];
  for (const marker of markers) {
    const config = extractJsonObjectAfterMarker(html, marker);
    if (config?.request || config?.video) return config;
  }
  return null;
};
var getVimeoManifestUrlFromConfig = (config, kind) => {
  const files = config?.request?.files?.[kind];
  if (!files?.cdns) return "";
  const cdnKey = files.default_cdn;
  const cdn = cdnKey && files.cdns[cdnKey] || Object.values(files.cdns)[0];
  const raw = String(cdn?.avc_url || cdn?.url || "");
  return raw ? decodeEscaped(raw) : "";
};
var getVimeoProgressiveFormatsFromConfig = (config) => {
  const progressive = config?.request?.files?.progressive;
  if (!Array.isArray(progressive)) return [];
  return progressive.filter((item) => item?.url && Number(item?.height || 0) > 0).map((item) => ({
    url: decodeEscaped(String(item.url)),
    height: Number(item.height || 0),
    width: Number(item.width || 0),
    fps: Number(item.fps || 0) || void 0,
    quality: String(item.quality || ""),
    ext: "mp4",
    protocol: "https",
    vcodec: "avc1",
    acodec: "mp4a",
    format_id: `http-${item.height}p`
  }));
};
var fetchVimeoConfigFromUrl = async (configUrl, sourcePageUrl = "") => {
  const response = await axios.get(configUrl, {
    timeout: 12e3,
    responseType: "json",
    httpsAgent: relaxedHttpsAgent,
    headers: mediaRequestHeaders(configUrl, sourcePageUrl || "https://vimeo.com/")
  });
  return response.data && typeof response.data === "object" ? response.data : null;
};
var parseVimeoQualityLabelHeight = (label) => {
  const match = String(label || "").match(/(\d{3,4})p/i);
  return match ? Number(match[1]) : 0;
};
var getVimeoDashQualityHeights = (config) => {
  const streams = config?.request?.files?.dash?.streams_avc || config?.request?.files?.dash?.streams || [];
  return Array.from(
    new Set(
      (Array.isArray(streams) ? streams : []).map((stream) => parseVimeoQualityLabelHeight(stream?.quality)).filter((height) => height > 0)
    )
  ).sort((a, b) => b - a);
};
var fetchVimeoPlayerHtml = async (vimeoId, sourcePageUrl = "") => {
  const playerUrl = `https://player.vimeo.com/video/${vimeoId}`;
  const response = await axios.get(playerUrl, {
    timeout: 15e3,
    responseType: "text",
    httpsAgent: relaxedHttpsAgent,
    headers: {
      ...mediaRequestHeaders(playerUrl, sourcePageUrl || "https://vimeo.com/"),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  return String(response.data || "");
};
var loadVimeoPlayerConfig = async (vimeoId, sourcePageUrl = "") => {
  let configUrl = "";
  try {
    const html = await fetchVimeoPlayerHtml(vimeoId, sourcePageUrl);
    const config = parseVimeoPlayerConfigFromHtml(html);
    if (config) {
      configUrl = String(config?.request?.config_url || config?.config_url || "").trim();
      return { config, configUrl, source: "player-page" };
    }
    const configUrlMatch = html.match(/config_url["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
    if (configUrlMatch?.[1]) {
      configUrl = decodeEscaped(configUrlMatch[1]);
      const remoteConfig = await fetchVimeoConfigFromUrl(configUrl, sourcePageUrl);
      if (remoteConfig?.request || remoteConfig?.video) {
        return { config: remoteConfig, configUrl, source: "config-url" };
      }
    }
  } catch (error) {
    console.warn(`[vimeo:${vimeoId}] Player page config fetch failed:`, error?.message || error);
  }
  return null;
};
var captureVimeoNetworkManifests = async (vimeoId, sourcePageUrl = "") => {
  const manifests = /* @__PURE__ */ new Set();
  let browser = null;
  try {
    browser = await acquireSharedPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    if (sourcePageUrl) {
      await page.setExtraHTTPHeaders({ Referer: `${sourcePageUrl.replace(/\/+$/, "")}/` });
    }
    page.on("response", (response) => {
      const url = response.url();
      if (/\.m3u8(?:\?|$)/i.test(url) && /vimeocdn\.com/i.test(url)) manifests.add(url);
    });
    await page.goto(`https://player.vimeo.com/video/${vimeoId}`, {
      waitUntil: "networkidle2",
      timeout: 3e4
    });
    await page.close().catch(() => void 0);
  } catch (error) {
    console.warn(`[vimeo:${vimeoId}] Puppeteer manifest capture failed:`, error?.message || error);
  } finally {
    await releaseSharedPuppeteerBrowser();
  }
  return Array.from(manifests);
};
var pickVimeoHlsVariant = (variants, targetHeight) => {
  const ranked = variants.filter((variant) => variant?.url).map((variant) => ({
    variant,
    height: Number(variant.height || 0),
    distance: variant.height ? Math.abs(variant.height - targetHeight) : 9999,
    abovePenalty: variant.height && variant.height > targetHeight ? 250 : 0,
    bandwidth: Number(variant.bandwidth || 0)
  })).sort(
    (a, b) => a.distance + a.abovePenalty - (b.distance + b.abovePenalty) || b.bandwidth - a.bandwidth || b.height - a.height
  );
  return ranked[0]?.variant || null;
};
var formatVimeoHeightList = (heights) => heights.length > 0 ? heights.map((height) => `${height}p`).join(", ") : "none";
var logVimeoQualityDiscovery = (vimeoId, debug) => {
  console.log(`[vimeo:${vimeoId}] Vimeo ID: ${vimeoId}`);
  if (debug.title) console.log(`[vimeo:${vimeoId}] Title: ${debug.title}`);
  if (debug.configUrl) console.log(`[vimeo:${vimeoId}] Config URL: ${debug.configUrl}`);
  console.log(`[vimeo:${vimeoId}] Progressive formats: ${formatVimeoHeightList(debug.progressiveHeights)}`);
  const hlsLines = debug.hlsHeights.length > 0 ? debug.hlsHeights.map((height) => `- ${height}p`).join("\n") : "- none";
  console.log(`[vimeo:${vimeoId}] HLS variants:
${hlsLines}`);
  if (debug.dashHeights.length > 0) {
    console.log(`[vimeo:${vimeoId}] DASH qualities: ${formatVimeoHeightList(debug.dashHeights)}`);
  }
  console.log(
    `[vimeo:${vimeoId}] Config source: ${debug.configSource || "none"} | FHD available: ${debug.fhdAvailable ? "yes" : "no"}`
  );
  if (debug.selectedFhdUrl) console.log(`[vimeo:${vimeoId}] Selected FHD URL: ${debug.selectedFhdUrl}`);
  if (debug.selectedHdUrl) console.log(`[vimeo:${vimeoId}] Selected HD URL: ${debug.selectedHdUrl}`);
};
var resolveVimeoQualityStreams = async (vimeoUrl, sourcePageUrl, ytDlpInfo = null) => {
  const vimeoId = parseVimeoIdFromUrl(vimeoUrl);
  let configSource = "";
  let configUrl = "";
  let playerConfig = null;
  let hlsMasterUrl = "";
  let hlsVariants = [];
  let dashHeights = [];
  const playerConfigResult = vimeoId ? await loadVimeoPlayerConfig(vimeoId, sourcePageUrl) : null;
  if (playerConfigResult?.config) {
    playerConfig = playerConfigResult.config;
    configSource = playerConfigResult.source;
    configUrl = String(playerConfigResult.configUrl || "").trim();
    hlsMasterUrl = getVimeoManifestUrlFromConfig(playerConfig, "hls");
    dashHeights = getVimeoDashQualityHeights(playerConfig);
    if (!hlsMasterUrl) {
      hlsMasterUrl = getVimeoManifestUrlFromConfig(playerConfig, "dash");
      if (hlsMasterUrl) configSource = `${configSource || "player-page"}+dash`;
    }
  }
  const resolvedTitle = String(playerConfig?.video?.title || ytDlpInfo?.title || "").trim();
  const title = resolvedTitle || "Vimeo video";
  const thumbnail = sanitizeStreamUrl(playerConfig?.video?.thumbnail_url || ytDlpInfo?.thumbnail || "", vimeoUrl) || ytDlpInfo?.thumbnail;
  const duration = Number(playerConfig?.video?.duration || ytDlpInfo?.duration || 0) || void 0;
  const formats = Array.isArray(ytDlpInfo?.formats) ? ytDlpInfo.formats : [];
  const progressiveFormats = [
    ...getVimeoProgressiveFormatsFromConfig(playerConfig),
    ...formats.filter(isVimeoProgressiveMp4Format)
  ].sort((a, b) => (b.height || 0) - (a.height || 0));
  const progressiveByHeight = /* @__PURE__ */ new Map();
  progressiveFormats.forEach((format) => {
    const height = parseCandidateHeight(format) || Number(format.height || 0);
    if (!height) return;
    const current = progressiveByHeight.get(height);
    if (!current || Number(format.tbr || 0) > Number(current.tbr || 0)) progressiveByHeight.set(height, format);
  });
  const progressiveHeights = Array.from(progressiveByHeight.keys()).sort((a, b) => b - a);
  if (!hlsMasterUrl && vimeoId) {
    const ytDlpHls = formats.filter((format) => {
      const protocol = String(format?.protocol || "").toLowerCase();
      const url = String(format?.url || "");
      return protocol.includes("m3u8") || /\.m3u8(?:\?|$)/i.test(url);
    }).sort((a, b) => (b.height || 0) - (a.height || 0));
    const masterCandidate = ytDlpHls.find((format) => /playlist\.m3u8|master\.m3u8/i.test(String(format?.url || "")));
    if (masterCandidate?.url) {
      hlsMasterUrl = sanitizeStreamUrl(masterCandidate.url, vimeoUrl) || masterCandidate.url;
      configSource = configSource || "ytdlp-hls";
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
      configSource = configSource || "puppeteer-network";
    }
  }
  const hlsHeights = Array.from(
    new Set(hlsVariants.map((variant) => Number(variant.height || 0)).filter((height) => height > 0))
  ).sort((a, b) => b - a);
  const allHeights = Array.from(/* @__PURE__ */ new Set([...progressiveHeights, ...hlsHeights, ...dashHeights])).sort((a, b) => b - a);
  const fhdAvailable = allHeights.some((height) => height >= 1e3);
  const debug = {
    progressiveHeights,
    hlsHeights,
    dashHeights,
    configSource,
    configUrl,
    fhdAvailable,
    title: resolvedTitle,
    selectedFhdUrl: "",
    selectedHdUrl: ""
  };
  const resolved = {};
  const buildProgressiveStream = (format, bucket) => {
    const height = parseCandidateHeight(format) || Number(format.height || 0);
    const normalizedUrl = sanitizeStreamUrl(format.url, vimeoUrl) || format.url;
    return {
      bucket,
      url: normalizedUrl,
      sourceStreamUrl: normalizedUrl,
      height,
      width: format.width,
      type: "mp4",
      streamSource: "progressive-mp4",
      format,
      acodec: format.acodec,
      vcodec: format.vcodec,
      fps: format.fps,
      filesize: format.filesize || format.filesize_approx
    };
  };
  const buildHlsStream = (variant, bucket) => {
    const normalizedUrl = sanitizeStreamUrl(variant.url, hlsMasterUrl || vimeoUrl) || variant.url;
    return {
      bucket,
      url: normalizedUrl,
      sourceStreamUrl: normalizedUrl,
      height: Number(variant.height || 0),
      width: variant.width,
      type: "m3u8",
      streamSource: hlsMasterUrl && configSource === "ytdlp-hls" ? "ytdlp-hls" : "hls"
    };
  };
  const progressiveFhd = progressiveHeights.filter((height) => height >= 1e3).sort((a, b) => b - a)[0];
  const progressiveHd = progressiveHeights.filter((height) => height >= 700 && height < 1e3).sort((a, b) => b - a)[0] || progressiveHeights.filter((height) => height >= 600).sort((a, b) => b - a)[0];
  if (progressiveFhd && progressiveByHeight.has(progressiveFhd)) {
    resolved.fhd = buildProgressiveStream(progressiveByHeight.get(progressiveFhd), "fhd");
  } else if (fhdAvailable) {
    const hlsFhd = pickVimeoHlsVariant(hlsVariants, 1080);
    if (hlsFhd?.height && hlsFhd.height >= 1e3) {
      resolved.fhd = buildHlsStream(hlsFhd, "fhd");
    }
  }
  if (progressiveHd && progressiveByHeight.has(progressiveHd)) {
    resolved.hd = buildProgressiveStream(progressiveByHeight.get(progressiveHd), "hd");
  } else {
    const hlsHd = pickVimeoHlsVariant(hlsVariants, 720);
    if (hlsHd?.height && hlsHd.height >= 600) {
      resolved.hd = buildHlsStream(hlsHd, "hd");
    }
  }
  if (resolved.fhd?.url) debug.selectedFhdUrl = resolved.fhd.url;
  if (resolved.hd?.url) debug.selectedHdUrl = resolved.hd.url;
  if (vimeoId) logVimeoQualityDiscovery(vimeoId, debug);
  return {
    vimeoId,
    title: resolvedTitle || title,
    thumbnail: sanitizeStreamUrl(playerConfig?.video?.thumbnail_url || thumbnail || "", vimeoUrl) || thumbnail,
    duration: Number(playerConfig?.video?.duration || duration || 0) || void 0,
    streams: resolved,
    debug
  };
};
var brightcovePolicyCache = /* @__PURE__ */ new Map();
var brightcoveMetadataCache = /* @__PURE__ */ new Map();
var brightcovePolicyInFlight = /* @__PURE__ */ new Map();
var brightcoveMetadataInFlight = /* @__PURE__ */ new Map();
var brightcoveMetadataTtlMs = 3 * 60 * 1e3;
var bundledBrightcovePolicyKeys = /* @__PURE__ */ new Map([
  [
    "6311996242001:default_default",
    "BCpkADawqM3eHsnivA0thG9l75psz8Bx4AyMKF8SdZSzD7GGt4gh7XK7yO6gQNN93TpRuY3okeOSZKG6Vq6iB4WB5vGwV-e5unw4zt3oF6_oQxOcXMc20I0iR2-xWpHF7eABbc6xkAB-7qDo"
  ]
]);
var getVimeoMetadata = async (vimeoUrl, sourcePageUrl = "") => {
  const cacheKey = `${vimeoUrl}|${String(sourcePageUrl || "")}`;
  const cached = vimeoMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const queryOptions = buildYtDlpQueryOptions(vimeoUrl, sourcePageUrl || void 0);
  const fetchMetadata = (options) => withTimeout(
    youtubedl(vimeoUrl, {
      dumpSingleJson: true,
      ...options
    }),
    VIMEO_YTDLP_TIMEOUT_MS,
    `Vimeo metadata for ${vimeoUrl}`
  );
  let info;
  try {
    info = await fetchMetadata(queryOptions);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (queryOptions.cookiesFromBrowser && /cookies|operation not permitted/i.test(message)) {
      const { cookiesFromBrowser: _cookiesFromBrowser, ...withoutCookies } = queryOptions;
      info = await fetchMetadata(withoutCookies);
    } else {
      throw error;
    }
  }
  vimeoMetadataCache.set(cacheKey, { expiresAt: Date.now() + vimeoMetadataTtlMs, info });
  return info;
};
var getBrightcovePolicyKey = async (accountId, playerId, forceRefresh = false) => {
  const normalizedPlayer = playerId.endsWith("_default") ? playerId : `${playerId}_default`;
  const cacheKey = `${accountId}:${normalizedPlayer}`;
  if (!forceRefresh) {
    const cached = brightcovePolicyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.policyKey;
    const bundledPolicyKey = bundledBrightcovePolicyKeys.get(cacheKey);
    if (bundledPolicyKey) {
      brightcovePolicyCache.set(cacheKey, {
        expiresAt: Date.now() + brightcoveMetadataTtlMs,
        policyKey: bundledPolicyKey
      });
      return bundledPolicyKey;
    }
    const existingRequest = brightcovePolicyInFlight.get(cacheKey);
    if (existingRequest) return existingRequest;
  }
  const request = (async () => {
    const playerBaseUrl = `https://players.brightcove.net/${accountId}/${normalizedPlayer}`;
    try {
      const configResponse = await axios.get(`${playerBaseUrl}/config.json`, {
        timeout: 3e4,
        httpsAgent: relaxedHttpsAgent,
        responseType: "json",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json,*/*"
        }
      });
      const configPolicyKey = String(
        configResponse.data?.video_cloud?.policy_key || configResponse.data?.videoCloud?.policyKey || configResponse.data?.policy_key || configResponse.data?.policyKey || ""
      ).trim();
      if (configPolicyKey) {
        brightcovePolicyCache.set(cacheKey, {
          expiresAt: Date.now() + brightcoveMetadataTtlMs,
          policyKey: configPolicyKey
        });
        return configPolicyKey;
      }
    } catch (error) {
      console.warn(`Brightcove player config fetch failed for ${cacheKey}:`, error?.message || error);
    }
    const playerJsUrl = `${playerBaseUrl}/index.min.js`;
    const response = await axios.get(playerJsUrl, {
      timeout: 3e4,
      httpsAgent: relaxedHttpsAgent,
      responseType: "text",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*"
      }
    });
    const js = String(response.data || "");
    const policyKey = js.match(/policyKey["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1] || js.match(/"policyKey"\s*:\s*"([^"]+)"/i)?.[1] || js.match(/BCpk[A-Za-z0-9._~-]+/)?.[0] || "";
    if (!policyKey) throw new Error("Brightcove policy key was not found for this player.");
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
var getBrightcoveMetadata = async (playerUrl) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) throw new Error("Invalid Brightcove player URL.");
  const normalizedPlayer = parsed.playerId.endsWith("_default") ? parsed.playerId : `${parsed.playerId}_default`;
  const cacheKey = `${parsed.accountId}:${normalizedPlayer}:${parsed.videoId}`;
  const cached = brightcoveMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const existingRequest = brightcoveMetadataInFlight.get(cacheKey);
  if (existingRequest) return existingRequest;
  const request = (async () => {
    let policyKey = await getBrightcovePolicyKey(parsed.accountId, parsed.playerId);
    const playbackUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${parsed.accountId}/videos/${parsed.videoId}`;
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await axios.get(playbackUrl, {
          timeout: 3e4,
          httpsAgent: relaxedHttpsAgent,
          validateStatus: (status) => status >= 200 && status < 500,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": `application/json;pk=${policyKey}`
          }
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
      const code = String(playbackError.error_code || "PLAYBACK_ERROR");
      const message = String(playbackError.message || "Brightcove could not load this video.");
      throw new Error(`Brightcove ${code}: ${message}`);
    }
    if (!response || response.status >= 400) {
      throw new Error(`Brightcove playback request failed with status ${response?.status || "unknown"}.`);
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
var getYouTubeVideoId = (rawUrl) => {
  try {
    const parsed = new URL2(normalizeYouTubeWatchUrl(rawUrl));
    return parsed.searchParams.get("v") || "";
  } catch {
    return "";
  }
};
var getYouTubeDirectFormatSelector = (quality, watchUrl = "") => {
  const targetHeight = getVimeoTargetHeight(quality);
  const shorts = isYouTubeShortsUrl(watchUrl);
  if (shorts) {
    return [
      `best[width<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
      `best[height<=${targetHeight * 2}][width<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
      `best[ext=mp4][acodec!=none][vcodec!=none]`,
      `bestvideo[width<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${targetHeight * 2}][width<=${targetHeight}][ext=mp4]+bestaudio`
    ].join("/");
  }
  return [
    `best[height=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[height<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[ext=mp4][acodec!=none][vcodec!=none]`,
    `bestvideo[height=${targetHeight}][ext=mp4]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]`
  ].join("/");
};
var getReferenceVideoFormatSelector = (quality) => {
  const height = quality === "hd" ? 720 : quality === "4k" ? 2160 : 1080;
  return [
    `bestvideo[height<=${height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio`,
    `best[height<=${height}][ext=mp4][vcodec!=none][acodec!=none]`,
    `best[height<=${height}][vcodec!=none][acodec!=none]`,
    "bestvideo+bestaudio",
    "best"
  ].join("/");
};
var getReferenceAudioFormatSelector = () => "bestaudio[abr<=128]/bestaudio/best";
var getYouTubeMergeFormatSelector = (quality, _watchUrl = "") => getReferenceVideoFormatSelector(quality);
var buildYouTubeFfmpegHeaders = (watchUrl) => {
  const headerLines = ["Referer: https://www.youtube.com/", "Origin: https://www.youtube.com"];
  try {
    const parsed = new URL2(normalizeYouTubeWatchUrl(watchUrl));
    headerLines[0] = `Referer: ${parsed.origin}/`;
  } catch {
  }
  return `${headerLines.join("\r\n")}\r
`;
};
var classifyYouTubeStreamUrl = (streamUrl) => {
  const lowered = String(streamUrl || "").toLowerCase();
  if (/mime=audio|%2faudio|acont=dash|itag=(139|140|141|171|249|250|251|599|600)/i.test(lowered)) return "audio";
  if (/mime=video|%2fvideo|vcodec=|itag=(133|134|135|136|137|160|242|243|244|247|248|271|272|298|299|302|303|308|313|315|399|401|402)/i.test(lowered)) {
    return "video";
  }
  return "unknown";
};
var getYouTubeStreamParts = async (watchUrl, quality = "fhd") => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const shorts = isYouTubeShortsUrl(watchUrl);
  const muxedFormat = shorts ? getYouTubeDirectFormatSelector(quality, watchUrl) : [
    `best[height=${targetHeight}][ext=mp4][vcodec^=avc1][acodec!=none]`,
    `best[height<=${targetHeight}][ext=mp4][vcodec^=avc1][acodec!=none]`,
    `best[height=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[height<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[ext=mp4][acodec!=none][vcodec!=none]`
  ].join("/");
  try {
    const muxedRaw = await withTimeout(
      youtubedl(normalizedWatchUrl, {
        getUrl: true,
        format: muxedFormat,
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true
      }),
      2e4,
      `YouTube muxed stream for ${normalizedWatchUrl}`
    );
    const muxedUrl = sanitizeStreamUrl(
      String(Array.isArray(muxedRaw) ? muxedRaw[0] : muxedRaw || "").split(/\r?\n/)[0]?.trim(),
      normalizedWatchUrl
    );
    if (muxedUrl && !isExpiredStreamUrl(muxedUrl) && classifyYouTubeStreamUrl(muxedUrl) !== "audio") {
      return { muxedUrl, videoUrl: muxedUrl, audioUrl: "" };
    }
  } catch {
  }
  const splitFormat = shorts ? getYouTubeMergeFormatSelector(quality, watchUrl) : [
    `bestvideo[height=${targetHeight}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio`
  ].join("/");
  const splitRaw = await withTimeout(
    youtubedl(normalizedWatchUrl, {
      getUrl: true,
      format: splitFormat,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true
    }),
    2e4,
    `YouTube split streams for ${normalizedWatchUrl}`
  );
  const lines = String(Array.isArray(splitRaw) ? splitRaw.join("\n") : splitRaw || "").split(/\r?\n/).map((line) => sanitizeStreamUrl(line.trim(), normalizedWatchUrl)).filter((line) => line && !isExpiredStreamUrl(line));
  let videoUrl = lines.find((line) => classifyYouTubeStreamUrl(line) === "video") || "";
  let audioUrl = lines.find((line) => classifyYouTubeStreamUrl(line) === "audio") || "";
  if (!videoUrl && lines.length === 1 && classifyYouTubeStreamUrl(lines[0]) !== "audio") {
    videoUrl = lines[0];
  }
  if (!audioUrl) {
    const audioRaw = await withTimeout(
      youtubedl(normalizedWatchUrl, {
        getUrl: true,
        format: "bestaudio[ext=m4a]/bestaudio",
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true
      }),
      15e3,
      `YouTube audio stream for ${normalizedWatchUrl}`
    );
    audioUrl = sanitizeStreamUrl(
      String(Array.isArray(audioRaw) ? audioRaw[0] : audioRaw || "").split(/\r?\n/)[0]?.trim(),
      normalizedWatchUrl
    );
  }
  if (!videoUrl) throw new Error("No YouTube video stream was found for this quality.");
  if (!audioUrl) throw new Error("No YouTube audio stream was found for this video.");
  return { videoUrl, audioUrl, muxedUrl: "" };
};
var mergeYouTubePartsToFile = async (videoUrl, audioUrl, outputPath, watchUrl) => {
  const headers = buildYouTubeFfmpegHeaders(watchUrl);
  logYouTubeMerge("ffmpeg-merge-start", {
    videoUrl: String(videoUrl || "").slice(0, 180),
    audioUrl: String(audioUrl || "").slice(0, 180),
    mergedOutputPath: outputPath
  });
  const cmd = ffmpeg().input(videoUrl).inputOptions(["-headers", headers]).input(audioUrl).inputOptions(["-headers", headers]).outputOptions(["-map 0:v:0", "-map 1:a:0", "-c copy", "-shortest", "-movflags +faststart", "-f mp4"]).format("mp4");
  await waitForFfmpegFile(cmd, outputPath, "YouTube stream-copy merge");
  logYouTubeMerge("ffmpeg-merge-complete", { mergedOutputPath: outputPath });
};
var youtubeMergeCacheDir = path3.join(convertedVideoDir, "youtube-merge-cache");
var getYouTubeMergeCachePath = (watchUrl, quality) => {
  const videoId = getYouTubeVideoId(watchUrl) || crypto2.createHash("sha1").update(normalizeYouTubeWatchUrl(watchUrl)).digest("hex").slice(0, 12);
  return path3.join(youtubeMergeCacheDir, `${videoId}-${quality}-h264.mp4`);
};
var mergeYouTubeWithYtDlp = async (watchUrl, quality, outputPath) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  await fsp3.mkdir(path3.dirname(outputPath), { recursive: true });
  const outputTemplate = outputPath.replace(/\.mp4$/i, ".%(ext)s");
  const options = {
    ...buildYtDlpDownloadOptions(normalizedWatchUrl, quality, void 0, outputTemplate)
  };
  logYouTubeMerge("ytdlp-download-start", {
    watchUrl: normalizedWatchUrl,
    quality,
    mergedOutputPath: outputPath,
    ytdlpOptions: {
      format: options.format,
      mergeOutputFormat: options.mergeOutputFormat,
      ffmpegLocation: options.ffmpegLocation,
      postprocessorArgs: options.postprocessorArgs
    }
  });
  try {
    const ytdlpOutput = await withTimeout(
      youtubedl(normalizedWatchUrl, options),
      10 * 60 * 1e3,
      `YouTube yt-dlp merge for ${normalizedWatchUrl}`
    );
    logYouTubeMerge("ytdlp-download-output", {
      watchUrl: normalizedWatchUrl,
      quality,
      outputPreview: String(ytdlpOutput || "").slice(0, 500),
      mergedOutputPath: outputPath
    });
  } catch (error) {
    logYouTubeMerge("ytdlp-download-failed", {
      watchUrl: normalizedWatchUrl,
      quality,
      error: error?.message || String(error),
      exitCode: error?.exitCode ?? error?.status ?? null,
      errno: error?.errno ?? null,
      code: error?.code ?? null,
      syscall: error?.syscall ?? null,
      path: error?.path ?? null,
      stderr: String(error?.stderr || error?.stdout || "").slice(0, 1200)
    });
    throw error;
  }
  return validateOutputFile(outputPath, "YouTube merged download");
};
var mergeYouTubeWatchUrlToFile = async (watchUrl, quality, outputPath, titleHint = "") => {
  logYouTubeMerge("merge-start", { watchUrl, quality, mergedOutputPath: outputPath });
  const applyQuickTimePass = async () => {
    try {
      await validateOutputFile(outputPath, "YouTube merged download");
      const probe = describeMediaProbe(await probeMediaFile(outputPath));
      if (isQuickTimeCompatibleProbe(probe)) {
        await ensureQuickTimeCompatibleMp4(outputPath, { titleHint, quality, outputPath });
        return;
      }
      await ensureQuickTimeCompatibleMp4(outputPath, { titleHint, quality, outputPath });
    } catch (error) {
      const msg = error?.message || String(error);
      console.warn(`[QuickTime pass] Failed for ${outputPath}: ${msg}`);
      logYouTubeMerge("quicktime-pass-skipped", { outputPath, error: msg });
      await validateOutputFile(outputPath, "YouTube merged download");
    }
  };
  try {
    const merged = await mergeYouTubeWithYtDlp(watchUrl, quality, outputPath);
    logYouTubeMerge("merge-ytdlp-success", { mergedOutputPath: outputPath });
    await applyQuickTimePass();
    return merged;
  } catch (ytdlpError) {
    logYouTubeMerge("merge-ytdlp-fallback", {
      watchUrl,
      quality,
      error: ytdlpError?.message || String(ytdlpError),
      exitCode: ytdlpError?.exitCode ?? ytdlpError?.status ?? null
    });
    const parts = await getYouTubeStreamParts(watchUrl, quality);
    logYouTubeMerge("stream-parts", {
      watchUrl,
      quality,
      hasVideoUrl: Boolean(parts.videoUrl),
      hasAudioUrl: Boolean(parts.audioUrl),
      hasMuxedUrl: Boolean(parts.muxedUrl),
      videoUrl: String(parts.videoUrl || "").slice(0, 180),
      audioUrl: String(parts.audioUrl || "").slice(0, 180)
    });
    if (parts.audioUrl) {
      await mergeYouTubePartsToFile(parts.videoUrl, parts.audioUrl, outputPath, watchUrl);
      await applyQuickTimePass();
      return validateOutputFile(outputPath, "YouTube merged download");
    }
    if (parts.muxedUrl) {
      const headers = buildYouTubeFfmpegHeaders(watchUrl);
      const cmd = ffmpeg(parts.muxedUrl).inputOptions(["-headers", headers]).outputOptions(["-c copy", "-movflags +faststart", "-f mp4"]).format("mp4");
      await waitForFfmpegFile(cmd, outputPath, "YouTube muxed copy");
      await applyQuickTimePass();
      return validateOutputFile(outputPath, "YouTube merged download");
    }
    throw ytdlpError;
  } finally {
    try {
      const stat = await fsp3.stat(outputPath);
      logYouTubeMerge("merge-complete", {
        watchUrl,
        quality,
        outputPath,
        size: stat.size
      });
    } catch {
    }
  }
};
var pipeLocalVideoFile = async (req, res, filePath, options = {}) => {
  const stat = await fsp3.stat(filePath);
  const fileSize = stat.size;
  const preferredName = (options.filename || path3.basename(filePath)).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
  const contentType = "video/mp4";
  const disposition = `${options.inline ? "inline" : "attachment"}; filename="${preferredName || "video.mp4"}"`;
  const setCommonHeaders = () => {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
  };
  if (req.method === "HEAD") {
    setCommonHeaders();
    res.setHeader("Content-Length", String(fileSize));
    return res.status(200).end();
  }
  setCommonHeaders();
  res.status(200);
  res.setHeader("Content-Length", String(fileSize));
  const stream = fs2.createReadStream(filePath);
  stream.on("error", (error) => {
    console.error("Local video stream read error:", error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: "Failed to stream local video file." });
    else res.end();
  });
  return stream.pipe(res);
};
var resolveYouTubeQuickTimeExportPath = async (watchUrl, quality, options = {}) => {
  const title = String(options.titleHint || pageTitleFromUrl(watchUrl) || "video").trim();
  const exportPath = path3.join(
    resolveDownloadsTargetDir(options.sourcePageUrl || watchUrl),
    toQuickTimeVideoFilename(title, quality)
  );
  try {
    await validateOutputFile(exportPath, "QuickTime export");
    return exportPath;
  } catch {
    return null;
  }
};
var pipeYouTubeMergedStream = async (req, res, watchUrl, quality, options = {}) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const titleHint = String(options.titleHint || pageTitleFromUrl(normalizedWatchUrl) || "video").trim();
  const existingExport = await resolveYouTubeQuickTimeExportPath(normalizedWatchUrl, quality, {
    titleHint,
    sourcePageUrl: options.sourcePageUrl || normalizedWatchUrl
  });
  if (existingExport) {
    logYouTubeMerge("serve-existing-export", { watchUrl: normalizedWatchUrl, quality, existingExport });
    return pipeLocalVideoFile(req, res, existingExport, options);
  }
  await fsp3.mkdir(youtubeMergeCacheDir, { recursive: true });
  const cachedPath = getYouTubeMergeCachePath(watchUrl, quality);
  try {
    await validateOutputFile(cachedPath, "YouTube merge cache");
  } catch {
    await mergeYouTubeWatchUrlToFile(watchUrl, quality, cachedPath, titleHint);
  }
  return pipeLocalVideoFile(req, res, cachedPath, options);
};
var toYouTubeMergedDownloadUrl = (watchUrl, quality, titleHint) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const filename = toQualityVideoFilename(quality, titleHint);
  return `/api/youtube-merged-stream?url=${encodeURIComponent(normalizedWatchUrl)}&quality=${quality}&inline=1&filename=${encodeURIComponent(filename)}`;
};
var toDisplayFilePath = (filePath) => {
  const resolved = path3.resolve(String(filePath || ""));
  const home = os3.homedir();
  if (resolved.startsWith(home + path3.sep)) return `~${resolved.slice(home.length)}`;
  return resolved;
};
var prepareYouTubeQualityOutput = async (watchUrl, quality, options = {}) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const title = String(options.titleHint || pageTitleFromUrl(normalizedWatchUrl) || "video").trim();
  const internalPreviewUrl = toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title);
  const targetHeight = getVimeoTargetHeight(quality);
  if (!options.forceLocalMerge) {
    let directStreamUrl = "";
    try {
      const parts = await getYouTubeStreamParts(normalizedWatchUrl, quality);
      if (parts.muxedUrl && !isExpiredStreamUrl(parts.muxedUrl)) {
        directStreamUrl = parts.muxedUrl;
      }
    } catch {
    }
    if (directStreamUrl) {
      return {
        ok: true,
        watchUrl: normalizedWatchUrl,
        quality,
        mergeMode: "direct",
        isDirectProgressive: true,
        directStreamUrl,
        copyUrl: directStreamUrl,
        mediaUrl: directStreamUrl,
        localPath: "",
        downloadPath: "",
        internalPreviewUrl,
        previewStreamPath: internalPreviewUrl,
        title,
        resolution: `${targetHeight}p`,
        height: targetHeight,
        audioAvailable: true,
        hasAudio: true,
        noAudio: false,
        verifiedPlayable: true
      };
    }
  }
  await fsp3.mkdir(youtubeMergeCacheDir, { recursive: true });
  const cachedPath = getYouTubeMergeCachePath(normalizedWatchUrl, quality);
  try {
    await validateOutputFile(cachedPath, "YouTube merge cache");
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
    await fsp3.mkdir(targetDir, { recursive: true });
    exportPath = path3.join(targetDir, toQualityVideoFilename(quality, title));
    try {
      await validateOutputFile(exportPath, "QuickTime export");
    } catch {
      await fsp3.copyFile(cachedPath, exportPath).catch(async () => {
        await fsp3.copyFile(cachedPath, exportPath);
      });
      await ensureQuickTimeCompatibleMp4(exportPath, { titleHint: title, quality, outputPath: exportPath });
    }
  } else {
    await ensureQuickTimeCompatibleMp4(cachedPath, { titleHint: title, quality, outputPath: cachedPath });
    exportPath = cachedPath;
  }
  const probe = await verifyMergedYouTubeFile(exportPath);
  const stat = await fsp3.stat(exportPath);
  const qtProbe = describeMediaProbe(await probeMediaFile(exportPath));
  return {
    ok: true,
    watchUrl: normalizedWatchUrl,
    quality,
    mergeMode: "merged",
    isDirectProgressive: false,
    directStreamUrl: "",
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
    ...probe
  };
};
var buildYouTubeMergedCard = (watchUrl, quality, titleHint, options = {}) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const isShorts = options.isShorts ?? isYouTubeShortsUrl(watchUrl);
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const title = titleHint || pageTitleFromUrl(normalizedWatchUrl);
  const portraitDims = isShorts ? { width: targetHeight, height: Math.round(targetHeight * 16 / 9) } : { width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : void 0, height: targetHeight };
  const internalPreviewUrl = toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title);
  return {
    url: normalizedWatchUrl,
    sourceStreamUrl: normalizedWatchUrl,
    sourceUrl: normalizedWatchUrl,
    pageUrl: normalizedWatchUrl,
    watchUrl: normalizedWatchUrl,
    internalPreviewUrl,
    previewStreamPath: internalPreviewUrl,
    provider: "youtube",
    type: "mp4",
    title,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
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
    streamsPrepared: true
  };
};
var youTubePreparedToVideoPayload = (prepared, quality, titleHint) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(String(prepared?.watchUrl || ""));
  const isShorts = isYouTubeShortsUrl(normalizedWatchUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const title = String(prepared?.title || titleHint || pageTitleFromUrl(normalizedWatchUrl) || "video");
  const portraitDims = isShorts ? { width: targetHeight, height: Math.round(targetHeight * 16 / 9) } : { width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : void 0, height: targetHeight };
  const directStreamUrl = String(prepared?.directStreamUrl || "").trim();
  const localPath = String(prepared?.localPath || prepared?.downloadPath || "").trim();
  const mediaUrl = pickVariantMediaUrl({
    mediaUrl: prepared?.mediaUrl,
    copyUrl: prepared?.copyUrl,
    directStreamUrl,
    localPath,
    downloadPath: localPath
  });
  const copyUrl = mediaUrl;
  const internalPreviewUrl = String(prepared?.internalPreviewUrl || prepared?.previewStreamPath || toYouTubeMergedDownloadUrl(normalizedWatchUrl, quality, title));
  const isDirectProgressive = Boolean(prepared?.isDirectProgressive || prepared?.mergeMode === "direct" || directStreamUrl);
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
    mergeMode: prepared?.mergeMode || (isDirectProgressive ? "direct" : "merged"),
    isDirectProgressive,
    provider: "youtube",
    type: "mp4",
    title,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
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
    streamsPrepared: true
  };
};
var scanYtDlpFormatAvailability = async (url, sourcePageUrl = "") => {
  const info = await withTimeout(
    youtubedl(url, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(url, sourcePageUrl),
      noPlaylist: true
    }),
    YOUTUBE_FORMATS_TIMEOUT_MS,
    `Quality scan for ${url}`
  );
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const videoFormats = formats.filter((format) => String(format?.vcodec || "") !== "none");
  const maxPixels = Math.max(
    0,
    ...videoFormats.map((format) => Math.max(Number(format?.height || 0), Number(format?.width || 0)))
  );
  const hasAudio = formats.some((format) => String(format?.acodec || "") !== "none") || videoFormats.some((format) => streamHasAudio(format));
  return {
    fhd: maxPixels >= 1080,
    hd: maxPixels >= 720,
    audio: hasAudio,
    title: String(info?.title || "").trim(),
    thumbnail: sanitizeStreamUrl(String(info?.thumbnail || ""), url) || "",
    duration: Number(info?.duration || 0) || void 0,
    info,
    formats
  };
};
var buildUnifiedStreamsPayload = (variants, options = {}) => {
  const fhdVariant = variants.fhd;
  const hdVariant = variants.hd;
  const fhdMediaUrl = pickVariantMediaUrl(fhdVariant);
  const hdMediaUrl = pickVariantMediaUrl(hdVariant);
  const fhdReady = Boolean(fhdMediaUrl) || options.fhdAvailable !== false && Boolean(fhdVariant?.formatAvailable ?? fhdVariant);
  const hdReady = Boolean(hdMediaUrl) || options.hdAvailable !== false && Boolean(hdVariant?.formatAvailable ?? hdVariant);
  return {
    FHD: {
      mediaUrl: fhdMediaUrl,
      url: fhdMediaUrl,
      ready: fhdReady,
      resolution: String(fhdVariant?.resolution || "1080p")
    },
    HD: {
      mediaUrl: hdMediaUrl,
      url: hdMediaUrl,
      ready: hdReady,
      resolution: String(hdVariant?.resolution || "720p")
    },
    AUDIO: {
      mediaUrl: "",
      url: "",
      ready: options.audioReady !== false
    }
  };
};
var buildYouTubeFormatVariant = (watchUrl, quality, titleHint, available, options = {}) => {
  return {
    ...buildYouTubeMergedCard(watchUrl, quality, titleHint, options),
    formatAvailable: available,
    copyUrl: "",
    mediaUrl: "",
    verifiedPlayable: false,
    needsYouTubeMerge: true
  };
};
var buildGenericPlatformFormatVariant = (targetUrl, quality, titleHint, available, provider) => ({
  url: targetUrl,
  sourceUrl: targetUrl,
  sourceStreamUrl: "",
  provider,
  platform: provider,
  type: "mp4",
  title: titleHint || pageTitleFromUrl(targetUrl),
  formatAvailable: available,
  copyUrl: "",
  mediaUrl: "",
  verifiedPlayable: false,
  qualityRequested: quality,
  displayQualityKey: quality,
  displayQualityLabel: getCleanQualityLabel(quality),
  resolution: quality === "fhd" ? "1080p" : "720p"
});
var buildVimeoUnifiedCard = async (targetUrl, sourcePageUrl = targetUrl) => {
  const vimeoAssets = await withTimeout(
    extractVimeoVideos([targetUrl], "fhd", sourcePageUrl),
    VIMEO_EXTRACT_TIMEOUT_MS,
    `Vimeo unified card for ${targetUrl}`
  ).catch(() => ({ videos: createVimeoSourceVideos([targetUrl]), images: [] }));
  const collapsed = collapseVimeoVideosForClient(vimeoAssets.videos || []);
  const card = collapsed[0];
  if (!card?.url) {
    return buildGenericPlatformUnifiedCard(targetUrl);
  }
  const variants = card.vimeoQualityVariants || card.qualityVariants || {};
  const enrichedVariants = Object.fromEntries(
    Object.entries(variants).map(([qualityKey, variant]) => {
      const mediaUrl = pickVariantMediaUrl(variant) || String(variant?.url || "").trim();
      return [
        qualityKey,
        mediaUrl ? { ...variant, mediaUrl, copyUrl: mediaUrl, sourceStreamUrl: variant?.sourceStreamUrl || mediaUrl, verifiedPlayable: true } : variant
      ];
    })
  );
  const defaultKey = String(card.defaultQualityKey || (enrichedVariants.fhd ? "fhd" : enrichedVariants.hd ? "hd" : "fhd"));
  const primary = enrichedVariants[defaultKey] || card;
  const streams = buildUnifiedStreamsPayload(enrichedVariants, {
    audioReady: card.audioAvailable !== false && card.noAudio !== true,
    fhdAvailable: Boolean(enrichedVariants.fhd),
    hdAvailable: Boolean(enrichedVariants.hd)
  });
  return {
    ...primary,
    ...card,
    title: String(card.title || primary?.title || "").trim() || "Vimeo video",
    thumbnail: String(card.thumbnail || vimeoAssets.images?.[0]?.url || "").trim(),
    duration: card.duration || primary?.duration,
    durationSeconds: card.durationSeconds || card.duration || primary?.duration,
    qualityVariants: enrichedVariants,
    vimeoQualityVariants: enrichedVariants,
    defaultQualityKey: defaultKey,
    displayQualityKey: defaultKey,
    displayQualityLabel: getCleanQualityLabel(defaultKey),
    streamsPrepared: true,
    streams,
    platform: "vimeo",
    provider: "vimeo",
    isVimeo: true,
    audioAvailable: card.audioAvailable !== false,
    hasAudio: card.hasAudio !== false,
    noAudio: card.noAudio === true
  };
};
var buildGenericPlatformUnifiedCard = async (targetUrl) => {
  const scan = await scanYtDlpFormatAvailability(targetUrl, targetUrl).catch(() => ({
    fhd: true,
    hd: true,
    audio: true,
    title: pageTitleFromUrl(targetUrl),
    thumbnail: "",
    duration: void 0
  }));
  const provider = platformProviderFromUrl(targetUrl);
  const variants = {};
  const fhdAvailable = scan.fhd !== false;
  const hdAvailable = scan.hd !== false;
  if (fhdAvailable) {
    variants.fhd = buildGenericPlatformFormatVariant(targetUrl, "fhd", scan.title, true, provider);
  }
  if (hdAvailable) {
    variants.hd = buildGenericPlatformFormatVariant(targetUrl, "hd", scan.title, true, provider);
  }
  if (!variants.fhd && !variants.hd) {
    variants.hd = buildGenericPlatformFormatVariant(targetUrl, "hd", scan.title, true, provider);
  }
  const defaultKey = variants.fhd ? "fhd" : "hd";
  const primary = variants[defaultKey];
  const streams = buildUnifiedStreamsPayload(variants, {
    audioReady: scan.audio !== false,
    fhdAvailable,
    hdAvailable
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
    noAudio: scan.audio === false
  };
};
var captureIspotNetworkManifest = async (targetUrl) => {
  const manifests = /* @__PURE__ */ new Set();
  let browser = null;
  try {
    browser = await acquireSharedPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    page.on("response", (response) => {
      const url = response.url();
      if (/videos-cdn\.ispot\.tv\/.*\.m3u8(?:\?|$)/i.test(url)) manifests.add(url);
    });
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 3e4 });
    await page.evaluate(() => {
      const candidate = Array.from(document.querySelectorAll(
        'video, button, [role="button"], [class*="play"], [aria-label*="play" i], [title*="play" i]'
      )).find((element) => {
        const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.className || ""}`;
        return element.tagName === "VIDEO" || /play|video|watch/i.test(label);
      });
      candidate?.click();
    }).catch(() => void 0);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await page.close().catch(() => void 0);
  } catch (error) {
    console.warn("iSpot network manifest capture failed:", error?.message || error);
  } finally {
    await releaseSharedPuppeteerBrowser();
  }
  return Array.from(manifests)[0] || "";
};
var buildIspotYtDlpUnifiedCard = async (targetUrl, fallback = {}) => {
  const info = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(targetUrl, targetUrl),
      noPlaylist: true
    }),
    45e3,
    `iSpot yt-dlp fallback for ${targetUrl}`
  );
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const requestedDownloads = Array.isArray(info?.requested_downloads) ? info.requested_downloads : [];
  const candidates = [
    ...formats,
    ...requestedDownloads,
    ...info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, width: info.width, tbr: info.tbr }] : []
  ].map((candidate) => {
    const url = sanitizeStreamUrl(String(candidate?.url || ""), targetUrl);
    return url ? { ...candidate, url } : null;
  }).filter(Boolean).filter((candidate) => !isExpiredStreamUrl(String(candidate.url))).filter((candidate) => streamHasVideo(candidate)).filter((candidate) => {
    const raw = String(candidate.url || "");
    const ext = String(candidate.ext || "").toLowerCase();
    return isLikelyDirectVideoStreamUrl(raw) || isLikelyVideoAssetUrl(raw) || ext === "mp4" || ext === "m3u8";
  });
  const selected = await firstValidStreamCandidate(sortCandidatesForQuality(candidates, "fhd"), targetUrl, targetUrl) || sortCandidatesForQuality(candidates, "fhd")[0];
  if (!selected?.url) return null;
  const selectedHeight = selected.height || parseCandidateHeight(selected);
  const selectedWidth = selected.width || parseCandidateWidth(selected);
  const title = String(info?.title || fallback.title || "").trim() || pageTitleFromUrl(targetUrl) || "iSpot.tv video";
  const thumbnail = sanitizeStreamUrl(String(info?.thumbnail || fallback.thumbnail || ""), targetUrl) || String(info?.thumbnail || fallback.thumbnail || "");
  const directUrl = String(selected.url);
  const type = getVideoFormatFromUrlOrType(directUrl, String(selected.contentType || selected.ext || ""));
  const qualityKey = selectedHeight && selectedHeight >= 1080 ? "fhd" : selectedHeight && selectedHeight >= 720 ? "hd" : "best";
  return enforceMp4VideoPayload({
    url: directUrl,
    sourceStreamUrl: directUrl,
    sourceUrl: targetUrl,
    pageUrl: targetUrl,
    provider: "ispot",
    platform: "ispot",
    type: type || selected.ext || "mp4",
    title,
    thumbnail,
    resolution: selectedHeight ? `${selectedHeight}p` : selected.format_note || "Best Quality",
    width: selectedWidth,
    height: selectedHeight,
    qualityRequested: qualityKey,
    displayQualityKey: qualityKey,
    displayQualityLabel: qualityKey === "fhd" ? "FHD" : qualityKey === "hd" ? "HD" : "Best Quality",
    hasAudio: streamHasAudio(selected),
    audioAvailable: streamHasAudio(selected),
    noAudio: !streamHasAudio(selected),
    isDirect: true,
    isDirectAsset: isDirectProgressiveVideoUrl(directUrl),
    verifiedPlayable: true,
    filesize: selected.filesize || selected.filesize_approx || selected.contentLength,
    formatId: selected.format_id || selected.id,
    fallbackSource: "yt-dlp"
  });
};
var buildIspotUnifiedCard = async (targetUrl) => {
  const html = await withTimeout(fetchSiteHtml(targetUrl), 3e4, `iSpot video discovery for ${targetUrl}`);
  const unescaped = String(html || "").replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const title = unescaped.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] || unescaped.match(/<title[^>]*>([^<]+)/i)?.[1] || pageTitleFromUrl(targetUrl);
  const thumbnail = unescaped.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1] || "";
  const manifestMatch = unescaped.match(/https?:\/\/videos-cdn\.ispot\.tv\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/i) || unescaped.match(/https?:\/\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/i);
  const manifestUrl = (manifestMatch?.[0] ? sanitizeStreamUrl(manifestMatch[0], targetUrl) : "") || await captureIspotNetworkManifest(targetUrl);
  if (!manifestUrl) {
    const ytDlpFallback = await buildIspotYtDlpUnifiedCard(targetUrl, { title, thumbnail }).catch((error) => {
      console.warn("iSpot yt-dlp fallback failed:", error?.message || error);
      return null;
    });
    if (ytDlpFallback?.url) return ytDlpFallback;
    throw new Error("No downloadable iSpot.tv video stream was found on this ad page.");
  }
  const variants = await extractHlsVariants(manifestUrl, targetUrl).catch(() => []);
  const best = [...variants].sort((a, b) => Number(b.height || 0) - Number(a.height || 0))[0];
  const height = Number(best?.height || 0) || void 0;
  const streamUrl = String(best?.url || manifestUrl);
  return {
    url: streamUrl,
    sourceStreamUrl: streamUrl,
    sourceUrl: targetUrl,
    pageUrl: targetUrl,
    provider: "ispot",
    platform: "ispot",
    type: "m3u8",
    title: String(title).replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, "&").trim(),
    thumbnail: sanitizeStreamUrl(thumbnail, targetUrl) || thumbnail,
    resolution: height ? `${height}p` : "Best Quality",
    height,
    qualityRequested: height && height >= 1080 ? "fhd" : height && height >= 720 ? "hd" : "best",
    displayQualityKey: height && height >= 1080 ? "fhd" : height && height >= 720 ? "hd" : "best",
    displayQualityLabel: height && height >= 1080 ? "FHD" : height && height >= 720 ? "HD" : "Best Quality",
    hasAudio: true,
    audioAvailable: true,
    isDirect: true,
    verifiedPlayable: true
  };
};
var buildBrightcoveDirectUnifiedCard = async (targetUrl) => {
  const brightcoveAssets = await extractBrightcoveVideos(targetUrl);
  const videoList = Array.isArray(brightcoveAssets.videos) ? brightcoveAssets.videos : [];
  const fhdVideo = videoList.find((video) => matchesStrictQuality(parseCandidateHeight(video), "fhd"));
  const hdVideo = videoList.find((video) => matchesStrictQuality(parseCandidateHeight(video), "hd"));
  const variants = {};
  if (fhdVideo?.url) {
    variants.fhd = {
      ...fhdVideo,
      formatAvailable: true,
      mediaUrl: fhdVideo.url,
      copyUrl: fhdVideo.url,
      verifiedPlayable: true
    };
  }
  if (hdVideo?.url) {
    variants.hd = {
      ...hdVideo,
      formatAvailable: true,
      mediaUrl: hdVideo.url,
      copyUrl: hdVideo.url,
      verifiedPlayable: true
    };
  }
  if (Object.keys(variants).length === 0) {
    return buildGenericPlatformUnifiedCard(targetUrl);
  }
  const defaultKey = variants.fhd ? "fhd" : "hd";
  const primary = variants[defaultKey];
  const thumbnail = primary.thumbnail || brightcoveAssets.images?.[0]?.url || "";
  const streams = buildUnifiedStreamsPayload(variants, {
    audioReady: true,
    fhdAvailable: Boolean(variants.fhd),
    hdAvailable: Boolean(variants.hd)
  });
  return {
    ...primary,
    thumbnail,
    qualityVariants: variants,
    defaultQualityKey: defaultKey,
    streamsPrepared: true,
    streams,
    platform: "brightcove",
    provider: "brightcove",
    sourceUrl: targetUrl
  };
};
var buildDirectProgressiveUnifiedCard = (targetUrl) => {
  const variants = {
    fhd: {
      url: targetUrl,
      sourceUrl: targetUrl,
      sourceStreamUrl: targetUrl,
      provider: "direct",
      platform: "direct",
      type: "mp4",
      isDirect: true,
      formatAvailable: true,
      mediaUrl: targetUrl,
      copyUrl: targetUrl,
      verifiedPlayable: true,
      qualityRequested: "fhd",
      displayQualityKey: "fhd",
      displayQualityLabel: "FHD",
      resolution: "1080p",
      title: filenameFromAssetUrl(targetUrl).replace(/\.mp4$/i, "")
    }
  };
  const streams = buildUnifiedStreamsPayload(variants, { audioReady: true, fhdAvailable: true, hdAvailable: false });
  return {
    ...variants.fhd,
    qualityVariants: variants,
    defaultQualityKey: "fhd",
    streamsPrepared: true,
    streams
  };
};
var buildDirectVideoExtractResponse = async (targetUrl) => {
  if (isDirectProgressiveVideoUrl(targetUrl)) {
    return {
      images: [],
      icons: [],
      videos: [buildDirectProgressiveUnifiedCard(targetUrl)],
      fonts: [],
      colors: [],
      extractionMeta: { route: "direct-video", mode: "direct", platform: "direct" }
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
      extractionMeta: { route: "direct-video", mode: "direct", platform: "youtube" }
    };
  }
  let videoCard;
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
      route: "direct-video",
      mode: "direct",
      platform: videoCard.platform || platformProviderFromUrl(targetUrl)
    }
  };
};
var runPlatformVideoExtractor = async (targetUrl, platform) => {
  const detected = platformProviderFromUrl(targetUrl);
  if (platform !== "universal") {
    if (detected !== platform) {
      throw new Error(`URL appears to be ${detected || "unsupported"}, not ${platform}.`);
    }
  }
  lastExtractedSourceUrl = targetUrl;
  lastExtractionSectionMode = false;
  if (platform === "universal" && !isPlatformVideoUrl(targetUrl)) {
    const videoCard = await buildGenericPlatformUnifiedCard(targetUrl);
    return {
      images: [],
      icons: [],
      videos: [videoCard],
      fonts: [],
      colors: [],
      extractionMeta: {
        route: "direct-video",
        mode: "universal",
        platform: videoCard.platform || detected
      }
    };
  }
  return buildDirectVideoExtractResponse(targetUrl);
};
var youtubeVideoExtractor = (url) => runPlatformVideoExtractor(url, "youtube");
var vimeoVideoExtractor = (url) => runPlatformVideoExtractor(url, "vimeo");
var instagramVideoExtractor = (url) => runPlatformVideoExtractor(url, "instagram");
var facebookVideoExtractor = (url) => runPlatformVideoExtractor(url, "facebook");
var xVideoExtractor = (url) => runPlatformVideoExtractor(url, "x");
var ispotVideoExtractor = (url) => runPlatformVideoExtractor(url, "ispot");
var universalVideoExtractor = (url) => runPlatformVideoExtractor(url, "universal");
var finalizePlatformDownloadOutput = async (downloadedPath, desiredPath, options = {}) => {
  await fsp3.mkdir(path3.dirname(desiredPath), { recursive: true });
  if (path3.resolve(downloadedPath) !== path3.resolve(desiredPath)) {
    await fsp3.copyFile(downloadedPath, desiredPath);
    await fsp3.unlink(downloadedPath).catch(() => void 0);
  }
  if (!options.skipQuickTime && /\.mp4$/i.test(desiredPath)) {
    try {
      await withTimeout(
        ensureQuickTimeCompatibleMp4(desiredPath, {
          titleHint: options.titleHint,
          quality: options.quality,
          outputPath: desiredPath
        }),
        9e4,
        "QuickTime compatibility pass"
      );
    } catch (qtError) {
      await validateOutputFile(desiredPath, "Downloaded video");
      logYouTubeMerge("quicktime-pass-accepted-existing", {
        desiredPath,
        error: qtError?.message || String(qtError)
      });
    }
  }
  const stat = await validateOutputFile(desiredPath, "Downloaded video");
  return {
    outputPath: desiredPath,
    displayPath: toDisplayFilePath(desiredPath),
    size: stat.size
  };
};
var findYtDlpOutputFile = async (tempDir, tempBase) => {
  const entries = await fsp3.readdir(tempDir);
  const matches = entries.filter((name) => name.startsWith(tempBase) && !name.endsWith(".part") && !name.endsWith(".ytdl")).map((name) => path3.join(tempDir, name));
  if (matches.length === 0) return "";
  const stats = await Promise.all(
    matches.map(async (filePath) => {
      try {
        const stat = await fsp3.stat(filePath);
        return stat.isFile() ? { filePath, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      } catch {
        return null;
      }
    })
  );
  const files = stats.filter(Boolean);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return files[0]?.filePath || "";
};
var downloadVimeoPlatformVideoToFile = async (targetUrl, quality, options = {}) => {
  const normalizedUrl = normalizeVimeoUrl(targetUrl) || String(targetUrl || "").trim();
  const vimeoId = parseVimeoIdFromUrl(normalizedUrl);
  if (!vimeoId) {
    throw new Error(describeUnsupportedPlatformVideoUrl(targetUrl));
  }
  assertPublicAssetUrl(normalizedUrl);
  const sourcePageUrl = String(options.sourcePageUrl || normalizedUrl).trim();
  const requestedQuality = ["hd", "fhd", "4k"].includes(String(quality || "").toLowerCase()) ? String(quality).toLowerCase() : "fhd";
  const platform = "vimeo";
  const targetDir = resolveVideoDownloadTargetDir(sourcePageUrl, options.saveToWebsiteAssets);
  await fsp3.mkdir(targetDir, { recursive: true });
  const vimeoAssets = await withTimeout(
    extractVimeoVideos([normalizedUrl], requestedQuality, sourcePageUrl),
    VIMEO_EXTRACT_TIMEOUT_MS,
    `Vimeo download resolve for ${normalizedUrl}`
  );
  let streamVideo = vimeoAssets.videos.find(
    (video) => video?.isVimeoDirect && (video.displayQualityKey === requestedQuality || video.qualityRequested === requestedQuality)
  );
  if (!streamVideo && requestedQuality === "fhd") {
    streamVideo = vimeoAssets.videos.find(
      (video) => video?.isVimeoDirect && (video.displayQualityKey === "hd" || video.qualityRequested === "hd")
    );
  }
  const title = String(
    options.titleHint || streamVideo?.title || vimeoAssets.videos.find((video) => video?.title)?.title || pageTitleFromUrl(normalizedUrl) || "video"
  ).trim();
  const desiredFilename = toQualityVideoFilename(requestedQuality, title);
  const desiredPath = path3.join(targetDir, desiredFilename);
  try {
    const stat = await validateOutputFile(desiredPath, "Existing download");
    return {
      ok: true,
      filePath: desiredPath,
      displayPath: toDisplayFilePath(desiredPath),
      size: stat.size,
      quality: requestedQuality,
      platform,
      reused: true
    };
  } catch {
  }
  if (!streamVideo?.url && isDirectProgressiveVideoUrl(targetUrl)) {
    streamVideo = {
      url: targetUrl,
      title,
      type: "mp4",
      isVimeoDirect: true,
      hasAudio: true,
      audioAvailable: true,
      qualityFallback: true
    };
  }
  if (!streamVideo?.url) {
    throw new Error("No downloadable Vimeo stream is available. The video may be private, embed-only, or region-locked.");
  }
  const streamUrl = sanitizeStreamUrl(String(streamVideo.url), sourcePageUrl) || String(streamVideo.url);
  const tempBase = `vimeo-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPath = path3.join(os3.tmpdir(), `${tempBase}.mp4`);
  if (streamVideo.isVimeoHls || /\.m3u8(?:\?|$)/i.test(streamUrl)) {
    const parsedStream = new URL2(streamUrl);
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
    skipQuickTime: false
  });
  return {
    ok: true,
    filePath: finalized.outputPath,
    displayPath: finalized.displayPath,
    size: finalized.size,
    quality: requestedQuality,
    platform,
    reused: false
  };
};
var downloadPlatformVideoToFile = async (targetUrl, quality, options = {}) => {
  const rawUrl = String(targetUrl || "").trim();
  if (isUnsupportedVideoResourceUrl(rawUrl)) {
    throw new Error("This URL is a player script/API resource, not a downloadable video.");
  }
  const normalizedUrl = isYouTubeUrl(rawUrl) ? normalizeYouTubeWatchUrl(rawUrl) : isVimeoUrl(rawUrl) ? isDirectProgressiveVideoUrl(rawUrl) ? rawUrl : normalizeVimeoUrl(rawUrl) || rawUrl : rawUrl;
  assertPublicAssetUrl(normalizedUrl);
  if (!isPlatformVideoUrl(normalizedUrl) && !isLikelyDirectVideoStreamUrl(normalizedUrl) && !isLikelyVideoAssetUrl(normalizedUrl)) {
    throw new Error("This URL is not a downloadable video.");
  }
  if (isVimeoUrl(normalizedUrl) && parseVimeoIdFromUrl(normalizedUrl) && options.mode !== "audio") {
    return downloadVimeoPlatformVideoToFile(normalizedUrl, quality, options);
  }
  const title = String(options.titleHint || pageTitleFromUrl(normalizedUrl) || "video").trim();
  const isAudio = options.mode === "audio";
  const maxAudioDurationSeconds = isAudio ? Math.min(120, Math.max(1, Number(options.maxDurationSeconds || 120))) : void 0;
  const requestedQuality = ["hd", "fhd", "4k"].includes(String(quality || "").toLowerCase()) ? String(quality).toLowerCase() : "fhd";
  const platform = platformProviderFromUrl(options.sourcePageUrl || normalizedUrl) || "video";
  const targetDir = isAudio ? resolveDownloadSaveDir("audio", options.sourcePageUrl || normalizedUrl) : resolveVideoDownloadTargetDir(options.sourcePageUrl || normalizedUrl, options.saveToWebsiteAssets);
  await fsp3.mkdir(targetDir, { recursive: true });
  const desiredFilename = isAudio ? `${toSafeFileBase(title)}_MP3_${maxAudioDurationSeconds}s.mp3` : toQualityVideoFilename(requestedQuality, title);
  const desiredPath = path3.join(targetDir, desiredFilename);
  try {
    const stat = await validateOutputFile(desiredPath, "Existing download");
    return {
      ok: true,
      filePath: desiredPath,
      displayPath: toDisplayFilePath(desiredPath),
      size: stat.size,
      quality: isAudio ? "audio" : requestedQuality,
      platform: platformProviderFromUrl(normalizedUrl),
      reused: true
    };
  } catch {
  }
  const isBitmovinManifest = /streams\.bitmovin\.com\/.*\.m3u8(?:[?#]|$)/i.test(normalizedUrl) || /\.m3u8(?:[?#]|$)/i.test(normalizedUrl) && /(?:^|\.)xtandi\.com$/i.test(new URL2(options.sourcePageUrl || normalizedUrl).hostname);
  const tempBase = `platform-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempTemplate = path3.join(os3.tmpdir(), `${tempBase}.%(ext)s`);
  const ydlOptions = {
    ...buildYtDlpQueryOptions(normalizedUrl, options.sourcePageUrl),
    ...buildYtDlpSpeedOptions(),
    output: tempTemplate,
    format: isAudio ? getReferenceAudioFormatSelector() : isBitmovinManifest ? "bestvideo+bestaudio/best" : getReferenceVideoFormatSelector(requestedQuality),
    mergeOutputFormat: "mp4",
    ...isYouTubeUrl(normalizedUrl) ? { noPart: true, noContinue: true } : {},
    ...isAudio ? {
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: "128K",
      postprocessorArgs: `ffmpeg:-t ${maxAudioDurationSeconds}`
    } : { postprocessorArgs: "ffmpeg:-c copy -movflags +faststart" }
  };
  await withTimeout(
    youtubedl(normalizedUrl, ydlOptions),
    YOUTUBE_MERGE_TIMEOUT_MS,
    `Platform download for ${normalizedUrl}`
  );
  let downloadedPath = await findYtDlpOutputFile(os3.tmpdir(), tempBase);
  if (!downloadedPath) {
    try {
      const stat = await validateOutputFile(desiredPath, "Downloaded video");
      return {
        ok: true,
        filePath: desiredPath,
        displayPath: toDisplayFilePath(desiredPath),
        size: stat.size,
        quality: isAudio ? "audio" : requestedQuality,
        platform: platformProviderFromUrl(normalizedUrl),
        reused: false
      };
    } catch {
      throw new Error("Download finished but output file was not found.");
    }
  }
  const finalized = await finalizePlatformDownloadOutput(downloadedPath, desiredPath, {
    titleHint: title,
    quality: requestedQuality,
    skipQuickTime: isAudio
  });
  return {
    ok: true,
    filePath: finalized.outputPath,
    displayPath: finalized.displayPath,
    size: finalized.size,
    quality: isAudio ? "audio" : requestedQuality,
    platform: platformProviderFromUrl(normalizedUrl),
    reused: false
  };
};
var downloadDirectStreamVideoToFile = async (targetUrl, options = {}) => {
  const normalizedUrl = sanitizeStreamUrl(String(targetUrl || "").trim(), options.sourcePageUrl) || String(targetUrl || "").trim();
  if (!normalizedUrl || !isDirectDownloadableVideoUrl(normalizedUrl)) {
    throw new Error("URL is not a direct downloadable video stream.");
  }
  assertPublicAssetUrl(normalizedUrl);
  const sourcePageUrl = String(options.sourcePageUrl || normalizedUrl).trim();
  lastExtractedSourceUrl = sourcePageUrl;
  lastExtractionSectionMode = false;
  const title = String(options.titleHint || pageTitleFromUrl(normalizedUrl) || "video").trim();
  const requestedQuality = ["hd", "fhd", "4k"].includes(String(options.quality || "").toLowerCase()) ? String(options.quality).toLowerCase() : "fhd";
  const targetDir = resolveVideoDownloadTargetDir(sourcePageUrl, options.saveToWebsiteAssets);
  await fsp3.mkdir(targetDir, { recursive: true });
  const desiredFilename = toQualityVideoFilename(requestedQuality, title);
  const desiredPath = path3.join(targetDir, desiredFilename);
  try {
    const stat = await validateOutputFile(desiredPath, "Existing download");
    return {
      ok: true,
      filePath: desiredPath,
      displayPath: toDisplayFilePath(desiredPath),
      size: stat.size,
      quality: requestedQuality,
      platform: platformProviderFromUrl(normalizedUrl),
      reused: true
    };
  } catch {
  }
  await downloadUrlToFile(normalizedUrl, desiredPath, sourcePageUrl);
  const finalized = await finalizePlatformDownloadOutput(desiredPath, desiredPath, {
    titleHint: title,
    quality: requestedQuality,
    skipQuickTime: true
  });
  return {
    ok: true,
    filePath: finalized.outputPath,
    displayPath: finalized.displayPath,
    size: finalized.size,
    quality: requestedQuality,
    platform: platformProviderFromUrl(normalizedUrl),
    reused: false
  };
};
var listVideoDownloadFiles = async () => {
  const entries = [];
  let dirNames = [];
  try {
    dirNames = await fsp3.readdir(downloadsDir);
  } catch {
    return entries;
  }
  for (const dirName of dirNames) {
    if (!/_CreativeAssets$/i.test(dirName)) continue;
    const platform = dirName.replace(/_CreativeAssets$/i, "");
    const videosDir = path3.join(downloadsDir, dirName, VIDEO_ASSET_SUBFOLDER);
    let files = [];
    try {
      files = await fsp3.readdir(videosDir);
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (fileName.startsWith(".")) continue;
      const filePath = path3.join(videosDir, fileName);
      try {
        const stat = await fsp3.stat(filePath);
        if (!stat.isFile()) continue;
        entries.push({
          name: fileName,
          platform,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          path: filePath,
          displayPath: toDisplayFilePath(filePath),
          quality: /_FHD_/i.test(fileName) ? "FHD" : /_HD_/i.test(fileName) ? "HD" : /128|audio|\.m4a|\.mp3/i.test(fileName) ? "Audio" : "Video"
        });
      } catch {
      }
    }
  }
  return entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
};
var buildYouTubeUnifiedCard = async (targetUrl, sourcePageUrl = "") => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(targetUrl);
  const isShorts = isYouTubeShortsUrl(targetUrl);
  const [titleHint, scan] = await Promise.all([
    withTimeout(
      fetchYouTubeOEmbedTitle(normalizedWatchUrl),
      YOUTUBE_METADATA_TIMEOUT_MS,
      `YouTube metadata for ${normalizedWatchUrl}`
    ).catch(() => ""),
    scanYtDlpFormatAvailability(normalizedWatchUrl, sourcePageUrl || targetUrl).catch(() => ({
      fhd: true,
      hd: true,
      audio: true,
      title: "",
      thumbnail: "",
      duration: void 0
    }))
  ]);
  const resolvedTitle = scan.title || titleHint;
  const variants = {};
  if (scan.fhd) {
    variants.fhd = buildYouTubeFormatVariant(normalizedWatchUrl, "fhd", resolvedTitle, true, { isShorts });
  }
  if (scan.hd) {
    variants.hd = buildYouTubeFormatVariant(normalizedWatchUrl, "hd", resolvedTitle, true, { isShorts });
  }
  const defaultKey = scan.fhd ? "fhd" : scan.hd ? "hd" : "fhd";
  const primary = variants[defaultKey] || buildYouTubeMergedCard(normalizedWatchUrl, defaultKey, resolvedTitle, { isShorts });
  const videoId = getYouTubeVideoId(normalizedWatchUrl);
  const streams = buildUnifiedStreamsPayload(variants, {
    audioReady: scan.audio !== false,
    watchUrl: normalizedWatchUrl,
    fhdAvailable: scan.fhd,
    hdAvailable: scan.hd
  });
  return {
    ...primary,
    title: resolvedTitle || primary.title,
    thumbnail: scan.thumbnail || primary.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : ""),
    duration: scan.duration,
    durationSeconds: scan.duration,
    qualityVariants: variants,
    vimeoQualityVariants: variants,
    defaultQualityKey: defaultKey,
    streamsPrepared: true,
    streams,
    platform: "youtube",
    audioAvailable: scan.audio !== false,
    hasAudio: scan.audio !== false,
    noAudio: scan.audio === false,
    provider: "youtube",
    isYouTube: true,
    isYouTubeMerged: true
  };
};
var probeVideoQualityManifest = async (url, sourcePageUrl = "") => {
  const manifest = {
    fhd: false,
    hd: false,
    audio: false,
    title: "",
    thumbnail: "",
    variants: {}
  };
  if (isYouTubeUrl(url)) {
    const normalizedWatchUrl = normalizeYouTubeWatchUrl(url);
    const scan = await scanYtDlpFormatAvailability(normalizedWatchUrl, sourcePageUrl || url).catch(() => ({
      fhd: true,
      hd: true,
      audio: true,
      title: "",
      thumbnail: "",
      duration: void 0
    }));
    manifest.fhd = scan.fhd;
    manifest.hd = scan.hd;
    manifest.audio = scan.audio !== false;
    manifest.title = scan.title;
    manifest.thumbnail = scan.thumbnail;
    manifest.duration = scan.duration;
    if (scan.fhd) {
      manifest.variants.fhd = buildYouTubeFormatVariant(normalizedWatchUrl, "fhd", scan.title, true);
    }
    if (scan.hd) {
      manifest.variants.hd = buildYouTubeFormatVariant(normalizedWatchUrl, "hd", scan.title, true);
    }
    return manifest;
  }
  const vimeoId = getVimeoIdFromVideoRecord({ url, sourceUrl: sourcePageUrl });
  if (vimeoId || isVimeoUrl(url)) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos([url], "fhd", sourcePageUrl || url),
        45e3,
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
        manifest.title = String(card.title || "");
        manifest.thumbnail = String(card.thumbnail || "");
        manifest.duration = Number(card.duration || card.durationSeconds || 0) || void 0;
      }
    } catch {
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
var videoQualityManifestCache = /* @__PURE__ */ new Map();
var videoQualityManifestInFlight = /* @__PURE__ */ new Map();
var getVideoQualityManifestFast = async (url, sourcePageUrl = "") => {
  const key = `${url}|${sourcePageUrl}`;
  const cached = videoQualityManifestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = videoQualityManifestInFlight.get(key);
  if (existing) return existing;
  const task = withTimeout(
    probeVideoQualityManifest(url, sourcePageUrl),
    1e4,
    `Video manifest probe for ${url}`
  ).then((value) => {
    videoQualityManifestCache.set(key, { expiresAt: Date.now() + 2 * 60 * 1e3, value });
    return value;
  }).finally(() => {
    videoQualityManifestInFlight.delete(key);
  });
  videoQualityManifestInFlight.set(key, task);
  return task;
};
var wrapYouTubePlaybackStream = (video, watchUrl, quality) => {
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
      hasAudio: true
    };
  }
  const mergedUrl = toYouTubeMergedDownloadUrl(watchUrl, quality, video?.title);
  return {
    ...video,
    sourceStreamUrl: streamUrl,
    url: mergedUrl,
    type: "mp4",
    isDirect: true,
    isMp4Proxy: true,
    isYouTubeMerged: true,
    audioAvailable: true,
    noAudio: false,
    hasAudio: true,
    verifiedPlayable: true,
    qualityRequested: quality
  };
};
var extractYouTubeVideoIdFromThumbnail = (thumbnail) => {
  const match = String(thumbnail || "").match(
    /(?:i\.ytimg\.com|yt3(?:\.ggpht)?(?:\.com)?(?:\/googleusercontent)?)\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})(?:\/|[?#]|$)/i
  );
  return match?.[1] || "";
};
var attachYouTubeWatchUrlToVideos = (videos) => {
  const watchUrlsByVideoId = /* @__PURE__ */ new Map();
  videos.forEach((video) => {
    [video?.watchUrl, video?.sourceUrl, video?.pageUrl, video?.url].filter(Boolean).forEach((candidate) => {
      const value = String(candidate);
      if (!isYouTubeUrl(value)) return;
      const id = getYouTubeVideoId(value);
      if (id) watchUrlsByVideoId.set(id, normalizeYouTubeWatchUrl(value));
    });
  });
  return videos.map((video) => {
    const rawUrl = String(video?.url || video?.sourceStreamUrl || "");
    let watchUrl = video?.watchUrl ? normalizeYouTubeWatchUrl(String(video.watchUrl)) : "";
    if (!watchUrl && isYouTubeUrl(String(video?.sourceUrl || ""))) {
      watchUrl = normalizeYouTubeWatchUrl(String(video.sourceUrl));
    }
    const thumbId = extractYouTubeVideoIdFromThumbnail(video?.thumbnail);
    if (!watchUrl && thumbId) {
      watchUrl = watchUrlsByVideoId.get(thumbId) || `https://www.youtube.com/watch?v=${thumbId}`;
    }
    const provider = isGoogleVideoPlaybackUrl(rawUrl) || watchUrl || String(video?.provider || "").toLowerCase().includes("youtube") ? "youtube" : video?.provider;
    const enriched = {
      ...video,
      ...watchUrl ? { watchUrl, pageUrl: video?.pageUrl || watchUrl } : {},
      ...provider ? { provider } : {}
    };
    if (isGoogleVideoPlaybackUrl(rawUrl) && watchUrl && !video?.isYouTubeMerged) {
      const payload = enforceMp4VideoPayload({
        ...enriched,
        sourceStreamUrl: rawUrl,
        url: rawUrl,
        acodec: enriched.acodec || "none",
        hasAudio: false,
        audioAvailable: false,
        noAudio: true
      });
      return wrapYouTubePlaybackStream(payload, watchUrl, String(video?.qualityRequested || "fhd"));
    }
    return enriched;
  });
};
var resolveYouTubeDirectStream = async (rawUrl, quality) => {
  const normalizedUrl = normalizeYouTubeWatchUrl(rawUrl);
  const targetHeight = getVimeoTargetHeight(quality);
  const directUrl = await withTimeout(
    youtubedl(normalizedUrl, {
      getUrl: true,
      format: getYouTubeDirectFormatSelector(quality, rawUrl),
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true
    }),
    2e4,
    `YouTube direct ${targetHeight}p stream for ${rawUrl}`
  );
  const selectedUrl = sanitizeStreamUrl(
    String(Array.isArray(directUrl) ? directUrl[0] : directUrl || "").split(/\r?\n/)[0]?.trim(),
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
    provider: "YouTube",
    type: "mp4",
    title: `YouTube ${targetHeight}p video`,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
    resolution: `${targetHeight}p`,
    height: targetHeight,
    width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : void 0,
    filesize: validation.contentLength,
    acodec: isVideoOnly ? "none" : void 0,
    hasAudio: !isVideoOnly,
    audioAvailable: !isVideoOnly,
    noAudio: isVideoOnly,
    isDirect: true,
    qualityRequested: quality
  });
  return isVideoOnly ? wrapYouTubePlaybackStream(payload, rawUrl, quality) : payload;
};
var resolveYouTubeBestAvailableStream = async (rawUrl) => {
  for (const quality of ["fhd", "hd"]) {
    try {
      const stream = await resolveYouTubeDirectStream(rawUrl, quality);
      if (stream?.url) return stream;
    } catch (error) {
      console.warn(`YouTube ${quality} stream resolve failed:`, error.message || error);
    }
  }
  return null;
};
var getOriginalAudioOutput = (format) => {
  const ext = String(format?.ext || "").toLowerCase();
  const acodec = String(format?.acodec || "").toLowerCase();
  if (ext === "webm" || acodec.includes("opus") || acodec.includes("vorbis")) {
    return { extension: "webm", container: "webm" };
  }
  if (ext === "m4a" || ext === "mp4" || /aac|mp4a|ac-?3|ec-?3|eac3|alac/.test(acodec)) {
    return { extension: "m4a", container: "mp4" };
  }
  return { extension: "mka", container: "matroska" };
};
var isDolbyLikeAudio = (format) => {
  const value = `${format?.acodec || ""} ${format?.format || ""} ${format?.format_note || ""}`.toLowerCase();
  return /dolby|e-?ac-?3|ec-?3|ac-?3|atmos/.test(value);
};
var resolveBestAudioStream = async (rawUrl, mode = "turbo") => {
  const info = await withTimeout(
    youtubedl(rawUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true
    }),
    3e4,
    `Audio metadata for ${rawUrl}`
  );
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const preferredBitrate = mode === "hq" ? 320 : 128;
  const selected = formats.filter((format) => {
    const url = String(format?.url || "");
    const acodec = String(format?.acodec || "");
    if (!url || acodec === "none") return false;
    if (/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(url)) return false;
    return true;
  }).map((format) => ({
    format,
    audioOnlyPenalty: String(format?.vcodec || "") === "none" ? 0 : 4e3,
    extPenalty: mode === "original" ? 0 : ["m4a", "mp4"].includes(String(format?.ext || "").toLowerCase()) ? 0 : String(format?.ext || "").toLowerCase() === "webm" ? 120 : 500,
    bitrate: Number(format?.abr || format?.tbr || format?.bitrate || 0),
    channels: Number(format?.audio_channels || format?.channels || 0),
    dolbyPenalty: isDolbyLikeAudio(format) ? -1e4 : 0
  })).sort((a, b) => {
    if (mode === "original") {
      return a.audioOnlyPenalty + a.dolbyPenalty - (b.audioOnlyPenalty + b.dolbyPenalty) || b.channels - a.channels || b.bitrate - a.bitrate;
    }
    const aBitrate = a.bitrate || preferredBitrate;
    const bBitrate = b.bitrate || preferredBitrate;
    const aSpeedScore = Math.abs(aBitrate - preferredBitrate) + (aBitrate > preferredBitrate + 96 ? 90 : 0);
    const bSpeedScore = Math.abs(bBitrate - preferredBitrate) + (bBitrate > preferredBitrate + 96 ? 90 : 0);
    return a.audioOnlyPenalty + a.extPenalty - (b.audioOnlyPenalty + b.extPenalty) || (mode === "hq" ? bBitrate - aBitrate : aSpeedScore - bSpeedScore);
  })[0]?.format;
  const selectedUrl = selected?.url ? sanitizeStreamUrl(selected.url, rawUrl) : null;
  if (!selectedUrl) return null;
  return {
    url: selectedUrl,
    title: info.title || "Audio",
    thumbnail: info.thumbnail || "",
    bitrate: selected.abr || selected.tbr || 192,
    acodec: selected.acodec,
    ext: selected.ext,
    formatId: selected.format_id || selected.itag || selected.id,
    audioChannels: Number(selected.audio_channels || selected.channels || 0) || void 0,
    isDolbyLike: isDolbyLikeAudio(selected),
    originalOutput: getOriginalAudioOutput(selected),
    isAudioOnly: String(selected.vcodec || "") === "none"
  };
};
var isFacebookUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch";
  } catch {
    return false;
  }
};
var isInstagramUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
};
var YTDLP_FHD_POSTPROCESSOR_ARGS = "ffmpeg:-c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 192k -pix_fmt yuv420p -movflags +faststart -threads 0";
var needsBrowserCookiesForUrl = (url) => isFacebookUrl(url) || isInstagramUrl(url);
var isPackagedDesktopApp = () => Boolean(String(process.env.VDX_RESOURCES_PATH || "").trim());
var buildYtDlpBaseOptions = () => ({
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  forceIpv4: true,
  ...resolvedFfmpegPath ? { ffmpegLocation: path3.dirname(String(resolvedFfmpegPath)) } : {}
});
var buildYtDlpAuthOptions = (targetUrl) => {
  if (isPackagedDesktopApp()) return {};
  if (process.platform === "darwin" && needsBrowserCookiesForUrl(targetUrl)) {
    return { cookiesFromBrowser: "safari" };
  }
  return {};
};
var buildYtDlpRefererOptions = (targetUrl, sourcePageUrl) => {
  if (isVimeoUrl(targetUrl)) {
    const refererPage2 = String(sourcePageUrl || targetUrl || "").trim();
    return { referer: refererPage2 || "https://vimeo.com/" };
  }
  const refererPage = String(sourcePageUrl || "").trim();
  if (!refererPage) return {};
  try {
    const targetHost = new URL2(targetUrl).hostname.replace(/^www\./, "").toLowerCase();
    const refererHost = new URL2(refererPage).hostname.replace(/^www\./, "").toLowerCase();
    if (refererHost !== targetHost) {
      return { referer: refererPage };
    }
  } catch {
  }
  return {};
};
var buildYtDlpSpeedOptions = () => {
  if (!aria2Path || !fs2.existsSync(aria2Path)) return {};
  return {
    externalDownloader: "aria2c",
    externalDownloaderArgs: "aria2c:-x 16 -s 16 -k 1M",
    concurrentFragments: 16
  };
};
var buildYtDlpQueryOptions = (targetUrl, sourcePageUrl) => ({
  ...buildYtDlpBaseOptions(),
  ...buildYtDlpAuthOptions(targetUrl),
  ...buildYtDlpRefererOptions(targetUrl, sourcePageUrl)
});
var buildYtDlpDownloadOptions = (targetUrl, quality, sourcePageUrl, output) => {
  const isYouTube = isYouTubeUrl(targetUrl);
  return {
    ...buildYtDlpQueryOptions(targetUrl, sourcePageUrl),
    ...buildYtDlpSpeedOptions(),
    ...output ? { output } : {},
    format: getReferenceVideoFormatSelector(quality),
    mergeOutputFormat: "mp4",
    // Prevent flaky resume/partial-file state in tmp cache (seen as missing *.part errors).
    ...isYouTube ? { noPart: true, noContinue: true } : {},
    ...isYouTube ? { postprocessorArgs: "ffmpeg:-c copy -movflags +faststart" } : { postprocessorArgs: YTDLP_FHD_POSTPROCESSOR_ARGS }
  };
};
var isXUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
};
var platformProviderFromUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("facebook.com") || host === "fb.watch") return "facebook";
    if (host === "x.com" || host.includes("twitter.com")) return "x";
    if (host.includes("youtube.com") || host === "youtu.be") return "youtube";
    if (host.includes("googlevideo.com")) return "youtube";
    if (host.includes("vimeo.com")) return "vimeo";
    if (host.includes("wistia.com") || host.includes("wistia.net")) return "wistia";
    if (host === "embed.ustudio.com" || host.endsWith(".ustudio.com")) return "ustudio";
    if (host.includes("brightcove.net")) return "brightcove";
    if (host === "ispot.tv" || host.endsWith(".ispot.tv")) return "ispot";
    if (host.includes("tiktok.com")) return "tiktok";
    return "platform";
  } catch {
    return "platform";
  }
};
var describeUnsupportedPlatformVideoUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path4 = parsed.pathname.toLowerCase();
    if (host.includes("vimeo.com")) {
      if (!path4 || path4 === "/") {
        return "That link is the Vimeo homepage. Paste a direct video URL like https://vimeo.com/123456789.";
      }
      if (path4.startsWith("/ondemand/")) {
        return "That is a Vimeo On Demand catalog page, not a single video. Open a video and copy its direct link.";
      }
      if (path4.startsWith("/channels/") || path4.startsWith("/groups/") || path4.startsWith("/categories/")) {
        return "That is a Vimeo browse page. Paste the URL of a specific video instead.";
      }
      if (!parseVimeoIdFromUrl(rawUrl) && path4.split("/").filter(Boolean).length < 2) {
        return "Paste a direct Vimeo video link (e.g. https://vimeo.com/123456789).";
      }
    }
    if (host.includes("youtube.com") && !parsed.searchParams.get("v") && !/\/(?:shorts|live|embed)\//.test(path4)) {
      return "Paste a direct YouTube watch link (e.g. https://www.youtube.com/watch?v=...).";
    }
  } catch {
  }
  return "Paste a direct video link for this platform \u2014 not a homepage, channel, or catalog page.";
};
var isPlatformVideoUrl = (rawUrl) => {
  try {
    if (isUnsupportedVideoResourceUrl(rawUrl)) return false;
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path4 = parsed.pathname.toLowerCase();
    if (/(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl)) return true;
    if (host === "youtu.be") return path4.replace(/^\/+/, "").length > 0;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      return Boolean(parsed.searchParams.get("v")) || /\/(?:embed|shorts|live)\//.test(path4);
    }
    if (host === "player.vimeo.com") return /\/video\/\d+/.test(path4) || /\/progressive_redirect\/download\/\d+/.test(path4);
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      if (/\/progressive_redirect\/download\/\d+/.test(path4)) return true;
      if (/^\/\d+(?:\/|$)/.test(path4)) return true;
      if (/\.(ico|js|css|json)(\?|$)/i.test(path4)) return false;
      if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/.test(path4)) return false;
      const segments = path4.split("/").filter(Boolean);
      return segments.length >= 2;
    }
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") {
      return host === "fb.watch" || /\/(?:watch|reel|videos?)\b|\/videos\//.test(path4);
    }
    if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) return /\/status(?:es)?\//.test(path4);
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return /\/(?:reel|reels|p|tv)\//.test(path4);
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return /\/video\//.test(path4);
    if (host === "players.brightcove.net" || host.endsWith(".players.brightcove.net")) {
      return /\/index\.html$/i.test(path4) && Boolean(parsed.searchParams.get("videoId"));
    }
    if (host.includes("wistia.com") || host.includes("wistia.net")) {
      return /\/(?:embed\/(?:medias|iframe)|medias)\/[a-z0-9]{8,12}/i.test(path4);
    }
    if (host === "embed.ustudio.com" || host.endsWith(".ustudio.com")) {
      return /^\/embed\/[^/]+\/[^/]+/i.test(path4);
    }
    if (host === "ispot.tv" || host.endsWith(".ispot.tv")) return /^\/ad\/[^/]+\/[^/]+/.test(path4);
    return false;
  } catch {
    return /(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl);
  }
};
var isVideoPlatformHostUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host === "vimeo.com" || host.endsWith(".vimeo.com") || host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com") || host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch" || host === "instagram.com" || host.endsWith(".instagram.com") || host === "tiktok.com" || host.endsWith(".tiktok.com") || host === "players.brightcove.net" || host.endsWith(".players.brightcove.net") || host === "ispot.tv" || host.endsWith(".ispot.tv");
  } catch {
    return false;
  }
};
var isLikelyVideoAssetUrl = (rawUrl) => {
  const value = String(rawUrl || "").toLowerCase();
  if (!value) return false;
  if (isUnsupportedVideoResourceUrl(rawUrl)) return false;
  if (value.startsWith("data:")) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v|\.m3u8|\.mpd)(\?|$)/i.test(value)) return true;
  if (value.includes("wistia.com/deliveries/") || value.includes("wistia.net/deliveries/")) return true;
  if (value.includes("/videoplayback?") || value.includes("manifest") || value.includes("/video/")) return true;
  return false;
};
var isDirectProgressiveVideoUrl = (rawUrl) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(rawUrl || ""));
var isDirectDownloadableVideoUrl = (rawUrl) => {
  if (!rawUrl) return false;
  if (isDirectProgressiveVideoUrl(rawUrl)) return true;
  return isLikelyDirectVideoStreamUrl(rawUrl);
};
var filenameFromAssetUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "video.mp4");
    return name.replace(/[\\/:*?"<>|]/g, "_") || "video.mp4";
  } catch {
    return "video.mp4";
  }
};
var heightToQualityKey = (height) => {
  if (!height || height <= 0) return "best";
  if (height >= 2160) return "4k";
  if (height >= 1440) return "2k";
  if (height >= 1080) return "fhd";
  if (height >= 720) return "hd";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  return "best";
};
var heightToQualityLabel = (height) => {
  if (!height || height <= 0) return "Best Quality";
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height >= 1080) return "FHD";
  if (height >= 720) return "HD";
  if (height >= 480) return "SD";
  if (height >= 360) return "360p";
  return `${height}p`;
};
var probeRemoteVideoMetadata = async (sourceUrl, sourcePageUrl) => {
  const headers = mediaRequestHeaders(sourceUrl, sourcePageUrl);
  const headerArg = `${Object.entries(headers).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r
`;
  return new Promise((resolve, reject) => {
    ffmpeg(sourceUrl).inputOptions(["-headers", headerArg]).ffprobe((error, metadata) => {
      if (error) reject(error);
      else resolve(metadata);
    });
  });
};
var buildDirectProgressiveVideoPayload = async (sourceUrl, req, sourcePageUrl, options = {}) => {
  const normalizedUrl = sanitizeStreamUrl(sourceUrl, sourcePageUrl);
  if (!normalizedUrl || !isDirectProgressiveVideoUrl(normalizedUrl)) {
    throw new Error("URL is not a direct progressive video asset.");
  }
  assertPublicAssetUrl(normalizedUrl);
  const localFilename = filenameFromAssetUrl(normalizedUrl);
  const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
  const localPath = path3.join(targetDir, localFilename);
  let stat = null;
  let metadata = null;
  if (options.cache) {
    await fsp3.mkdir(targetDir, { recursive: true });
    const existing = await fsp3.stat(localPath).catch(() => null);
    if (!existing || existing.size <= 1024) {
      await downloadUrlToFile(normalizedUrl, localPath, sourcePageUrl);
    }
    stat = await validateOutputFile(localPath, "Direct video cache");
    metadata = await probeMediaFile(localPath).catch(() => null);
  } else {
    try {
      metadata = await probeRemoteVideoMetadata(normalizedUrl, sourcePageUrl);
    } catch {
      await fsp3.mkdir(targetDir, { recursive: true });
      const tempPath = path3.join(targetDir, `.probe-${Date.now()}-${localFilename}`);
      try {
        await downloadUrlToFile(normalizedUrl, tempPath, sourcePageUrl);
        stat = await validateOutputFile(tempPath, "Direct video probe");
        metadata = await probeMediaFile(tempPath);
        await fsp3.rename(tempPath, localPath).catch(async () => {
          await fsp3.copyFile(tempPath, localPath);
          await fsp3.unlink(tempPath).catch(() => void 0);
        });
        stat = await fsp3.stat(localPath);
      } finally {
        await fsp3.unlink(tempPath).catch(() => void 0);
      }
    }
    if (!stat) {
      const validation = await validateStreamUrl(normalizedUrl, sourcePageUrl);
      stat = validation.contentLength ? { size: validation.contentLength } : null;
    }
  }
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videoStream = streams.find((stream) => stream?.codec_type === "video");
  const audioStream = streams.find((stream) => stream?.codec_type === "audio");
  const height = Number(videoStream?.height || 0) || void 0;
  const width = Number(videoStream?.width || 0) || void 0;
  const duration = Number(metadata?.format?.duration || 0) || void 0;
  const bitrate = Number(metadata?.format?.bit_rate || videoStream?.bit_rate || 0) || void 0;
  const qualityKey = heightToQualityKey(height);
  const fileStat = stat || await fsp3.stat(localPath).catch(() => null);
  return {
    url: normalizedUrl,
    sourceStreamUrl: normalizedUrl,
    sourceUrl: sourcePageUrl || normalizedUrl,
    provider: platformProviderFromUrl(normalizedUrl),
    type: getVideoFormatFromUrlOrType(normalizedUrl),
    title: pageTitleFromUrl(normalizedUrl),
    localPath: fileStat ? localPath : void 0,
    downloadPath: fileStat ? localPath : void 0,
    localFilename,
    width,
    height,
    resolution: height ? `${height}p` : void 0,
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
    isMp4Proxy: false
  };
};
var isLikelyDirectVideoStreamUrl = (rawUrl) => {
  if (!rawUrl) return false;
  const lowered = String(rawUrl).toLowerCase();
  if (isUnsupportedVideoResourceUrl(rawUrl)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(lowered)) return false;
  if (/i\.ytimg\.com|yt3\.ggpht\.com|twimg\.com\/media|fbcdn\.net\/.*\.(jpg|jpeg|png|webp)/i.test(lowered)) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv)(\?|$)/i.test(lowered)) return true;
  if (lowered.includes("googlevideo.com/videoplayback")) return true;
  if (lowered.includes("video.xx.fbcdn.net")) return true;
  if (lowered.includes("vimeo.com/progressive_redirect")) return true;
  if (/vimeocdn\.com|vod-adaptive\.akamaized\.net|cloudfront\.net.*\/packages\//i.test(lowered)) return true;
  if (lowered.includes("wistia.com/deliveries/") || lowered.includes("wistia.net/deliveries/")) return true;
  return false;
};
var matchesStrictQuality = (heightOrCandidate, quality, width) => {
  const effective = getEffectiveVideoPixels(heightOrCandidate, width);
  if (!effective) return false;
  if (quality === "hd") return effective >= 720;
  if (quality === "fhd") return effective >= 1080;
  if (quality === "4k") return effective >= 2160;
  return true;
};
var parseCandidateHeight = (candidate) => {
  const directHeight = Number(candidate?.height);
  if (Number.isFinite(directHeight) && directHeight > 0) return directHeight;
  const qualityLabel = String(
    candidate?.qualityLabel || candidate?.format_note || candidate?.format || candidate?.resolution || ""
  ).toLowerCase();
  const match = qualityLabel.match(/(\d{3,4})p/);
  if (match?.[1]) return Number(match[1]);
  return void 0;
};
var parseCandidateWidth = (candidate) => {
  const directWidth = Number(candidate?.width);
  if (Number.isFinite(directWidth) && directWidth > 0) return directWidth;
  const resolution = String(candidate?.resolution || candidate?.format || "").toLowerCase();
  const match = resolution.match(/(\d{3,4})x(\d{3,4})/);
  if (match?.[1]) return Number(match[1]);
  return void 0;
};
var getQualityTarget = (quality) => {
  if (quality === "fhd") return { width: 1920, height: 1080, label: "FHD" };
  if (quality === "4k") return { width: 3840, height: 2160, label: "4K" };
  return { width: 1280, height: 720, label: "HD" };
};
var qualityCandidateScore = (candidate, quality) => {
  const target = getQualityTarget(quality);
  const height = parseCandidateHeight(candidate);
  const width = parseCandidateWidth(candidate);
  const heightDistance = height ? Math.abs(height - target.height) : 5e3;
  const widthDistance = width ? Math.abs(width - target.width) / 2 : 0;
  const belowPenalty = height && height < target.height ? 250 : 0;
  const videoOnlyPenalty = String(candidate?.acodec || candidate?.audioCodec || "") === "none" ? 35 : 0;
  const container = String(candidate?.ext || candidate?.container || "").toLowerCase();
  const containerPenalty = container === "mp4" ? 0 : container === "webm" ? 120 : 300;
  const protocol = String(candidate?.protocol || "").toLowerCase();
  const protocolPenalty = protocol.includes("m3u8") || String(candidate?.url || "").includes(".m3u8") ? 500 : 0;
  const exactBonus = matchesStrictQuality(height, quality) ? -1e3 : 0;
  return heightDistance * 12 + widthDistance + belowPenalty + videoOnlyPenalty + containerPenalty + protocolPenalty + exactBonus;
};
var sortCandidatesForQuality = (candidates, quality) => [...candidates].sort(
  (a, b) => qualityCandidateScore(a, quality) - qualityCandidateScore(b, quality) || Number(b?.tbr || b?.bitrate || b?.abr || 0) - Number(a?.tbr || a?.bitrate || a?.abr || 0)
);
var cleanQualityOrder = {
  best: 0,
  fhd: 1,
  hd: 2,
  "480p": 3,
  "360p": 4,
  audio: 5
};
var streamHasAudio = (candidate) => {
  const acodec = String(candidate?.acodec || candidate?.audioCodec || "").toLowerCase();
  const streamUrl = String(candidate?.sourceStreamUrl || candidate?.url || "");
  if (candidate?.audioAvailable === false || candidate?.noAudio) return false;
  if (candidate?.audioAvailable === true) return true;
  if (candidate?.hasAudio === true) return true;
  if (acodec === "none") return false;
  if (acodec && acodec !== "unknown") return true;
  if (isGoogleVideoPlaybackUrl(streamUrl)) return false;
  return candidate?.isYouTubeDirect ? false : true;
};
var streamHasVideo = (candidate) => {
  const vcodec = String(candidate?.vcodec || candidate?.videoCodec || "").toLowerCase();
  if (vcodec === "none") return false;
  return true;
};
var getCleanQualityKey = (candidate) => {
  if (!streamHasVideo(candidate)) return "audio";
  const height = parseCandidateHeight(candidate);
  if (!height || height > 1080) return "best";
  if (height >= 900) return "fhd";
  if (height >= 600) return "hd";
  if (height >= 400) return "480p";
  if (height >= 300) return "360p";
  return "best";
};
var getCleanQualityLabel = (qualityKey) => {
  if (qualityKey === "fhd") return "FHD";
  if (qualityKey === "hd") return "HD";
  if (qualityKey === "480p") return "480p";
  if (qualityKey === "360p") return "360p";
  if (qualityKey === "audio") return "Audio Only";
  return "Best Quality";
};
var isTechnicalOrUnsupportedStream = (candidate) => {
  const raw = String(candidate?.url || "").toLowerCase();
  const type = String(candidate?.type || candidate?.ext || "").toLowerCase();
  const note = String(candidate?.formatNote || candidate?.format_note || candidate?.format || candidate?.resolution || "").toLowerCase();
  if (!raw) return true;
  if (isUnsupportedVideoResourceUrl(raw)) return true;
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif|js|css|json)(\?|$)/i.test(raw)) return true;
  if (/storyboard|thumbnail|sprite|dash fragment|fragmented|metadata|manifest|m3u8|mpd/i.test(note)) return true;
  if (type === "m3u8" || type === "mpd") return true;
  if (/\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\/manifest|dash\+xml/i.test(raw)) return true;
  return false;
};
var displayStreamRank = (candidate) => {
  const raw = String(candidate?.url || "");
  const type = String(candidate?.type || candidate?.ext || "").toLowerCase();
  const isMp4 = type === "mp4" || /\.mp4(\?|$)/i.test(raw) || raw.includes("googlevideo.com/videoplayback") || raw.includes("vimeo.com/progressive_redirect");
  const hasAudio = streamHasAudio(candidate);
  const direct = candidate?.isDirect || candidate?.isVimeoDirect || candidate?.isWistiaDirect || candidate?.isYouTubeDirect || isLikelyDirectVideoStreamUrl(raw);
  const bitrate = Number(candidate?.tbr || candidate?.bitrate || candidate?.filesize || candidate?.filesize_approx || 0);
  return (isMp4 ? 1e4 : 0) + (hasAudio ? 4e3 : 0) + (direct ? 1e3 : 0) + Math.min(900, bitrate / 1e4);
};
var getStreamSourceIdentity = (candidate, fallbackUrl) => {
  const sourceRaw = String(candidate?.sourceUrl || candidate?.pageUrl || candidate?.originalUrl || fallbackUrl || "");
  const candidateRaw = String(candidate?.url || "");
  const useSourceIdentity = sourceRaw && isPlatformVideoUrl(sourceRaw);
  const raw = useSourceIdentity ? sourceRaw : candidateRaw || sourceRaw;
  try {
    const parsed = new URL2(raw);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube.com") || host === "youtu.be") return `youtube:${getYouTubeVideoId(raw) || parsed.pathname}`;
    if (host.includes("vimeo.com")) {
      const match = parsed.pathname.match(/\/(?:video\/)?(\d+)/) || parsed.pathname.match(/\/progressive_redirect\/download\/(\d+)/);
      return `vimeo:${match?.[1] || parsed.pathname.replace(/\/+$/, "")}`;
    }
    if (host === "x.com" || host.includes("twitter.com")) {
      const match = parsed.pathname.match(/\/status(?:es)?\/(\d+)/);
      return `x:${match?.[1] || parsed.pathname}`;
    }
    if (host.includes("facebook.com") || host === "fb.watch") return `facebook:${parsed.pathname.replace(/\/+$/, "")}`;
    if (host.includes("instagram.com")) return `instagram:${parsed.pathname.replace(/\/+$/, "")}`;
    if (host.includes("brightcove.net")) {
      const parsedBrightcove = parseBrightcovePlayerUrl(parsed.href);
      return parsedBrightcove ? `brightcove:${parsedBrightcove.accountId}:${parsedBrightcove.videoId}` : `brightcove:${parsed.pathname.replace(/\/+$/, "")}`;
    }
    if (host.includes("wistia.com") || host.includes("wistia.net")) {
      const match = parsed.pathname.match(/\/(?:embed\/medias|medias|embed\/iframe)\/([a-z0-9]{8,12})/i);
      if (match?.[1]) return `wistia:${match[1]}`;
      if (candidate?.wistiaHashedId) return `wistia:${candidate.wistiaHashedId}`;
    }
    parsed.search = "";
    parsed.hash = "";
    return `${host}${parsed.pathname}`;
  } catch {
    return raw;
  }
};
var normalizeVisibleVideoStreams = (videos, sourcePageUrl = "") => {
  const candidates = (Array.isArray(videos) ? videos : []).map((video) => sanitizeVideoForClient(video, sourcePageUrl)).filter(Boolean).filter((video) => {
    const url = String(video?.url || "");
    const isPagePlaceholder = isPlatformVideoUrl(url) && !isLikelyVideoAssetUrl(url) && !isLikelyDirectVideoStreamUrl(url);
    const sourceUrl = String(video?.sourceUrl || video?.pageUrl || sourcePageUrl || "");
    const isSilentDirectPlatformVideo = streamHasVideo(video) && !streamHasAudio(video) && (isYouTubeUrl(sourceUrl) || isXUrl(sourceUrl) || isFacebookUrl(sourceUrl) || isInstagramUrl(sourceUrl)) && (isLikelyDirectVideoStreamUrl(url) || isLikelyVideoAssetUrl(url));
    if (video?.isVimeo && !video?.isVimeoDirect) {
      const vimeoUrl = String(video?.url || video?.sourceUrl || "");
      return isPlatformVideoUrl(vimeoUrl);
    }
    if (video?.isWistia && !video?.isWistiaDirect) return true;
    if (isTechnicalOrUnsupportedStream(video) && !isPagePlaceholder) return false;
    if (!streamHasVideo(video) && getCleanQualityKey(video) !== "audio") return false;
    if (!streamHasAudio(video) && streamHasVideo(video)) {
      return isPagePlaceholder || isSilentDirectPlatformVideo;
    }
    return true;
  });
  const hasResolvedPlayableVideo = candidates.some((video) => {
    const url = String(video?.sourceStreamUrl || video?.url || "");
    return !video?.unresolvable && (video?.isDirect || video?.isVimeoDirect || video?.isWistiaDirect || video?.isYouTubeDirect || isLikelyDirectVideoStreamUrl(url) || isLikelyVideoAssetUrl(url));
  });
  const visibleCandidates = hasResolvedPlayableVideo ? candidates.filter((video) => !video?.unresolvable) : candidates;
  const totalAvailable = visibleCandidates.length;
  const grouped = /* @__PURE__ */ new Map();
  visibleCandidates.forEach((video) => {
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
      availableFormats: totalAvailable
    };
    const current = grouped.get(groupKey);
    if (!current || displayStreamRank(normalized) > displayStreamRank(current)) {
      grouped.set(groupKey, normalized);
    }
  });
  const sorted = Array.from(grouped.values()).sort((a, b) => {
    const aHeight = parseCandidateHeight(a);
    const bHeight = parseCandidateHeight(b);
    if (aHeight && bHeight && aHeight !== bHeight) return bHeight - aHeight;
    return (cleanQualityOrder[a.displayQualityKey] ?? 99) - (cleanQualityOrder[b.displayQualityKey] ?? 99) || displayStreamRank(b) - displayStreamRank(a);
  });
  const isPlatformStreamSet = isPlatformVideoUrl(sourcePageUrl) || sorted.some((video) => {
    const source = String(video?.sourceUrl || video?.pageUrl || "").toLowerCase();
    if (source.includes("wistia.com") || source.includes("wistia.net")) return false;
    return isPlatformVideoUrl(source);
  });
  const isVimeoStreamSet = isVimeoUrl(sourcePageUrl) || sorted.some((video) => {
    const provider = String(video?.provider || "").toLowerCase();
    const source = String(video?.sourceUrl || video?.url || "").toLowerCase();
    return provider.includes("vimeo") || source.includes("vimeo.com");
  });
  const visibleSorted = isPlatformStreamSet ? sorted.filter((video) => ["best", "fhd", "hd", "audio"].includes(video.displayQualityKey)) : sorted;
  const finalSorted = visibleSorted.length > 0 ? visibleSorted : sorted.slice(0, 2);
  const playlistLike = finalSorted.length > 6 && finalSorted.some((video) => video?.playlistIndex || video?.playlistTitle);
  const limit = playlistLike ? 48 : isPlatformStreamSet || isVimeoStreamSet ? 8 : 12;
  return finalSorted.slice(0, limit).map((video) => ({
    ...video,
    availableFormats: totalAvailable,
    hiddenFormats: Math.max(0, totalAvailable - finalSorted.length)
  }));
};
var prepareVisibleVideoStreams = async (videos, sourcePageUrl = "") => {
  const visible = normalizeVisibleVideoStreams(videos, sourcePageUrl);
  const prepared = await mapWithConcurrency(visible, 2, async (video) => {
    const watchUrl = String(video?.watchUrl || "").trim() || (isYouTubeUrl(String(video?.sourceUrl || video?.url || "")) ? normalizeYouTubeWatchUrl(String(video?.sourceUrl || video?.url || "")) : "");
    if (watchUrl && getYouTubeVideoId(watchUrl)) {
      if (video?.streamsPrepared) {
        return video;
      }
      try {
        return await buildYouTubeUnifiedCard(watchUrl, sourcePageUrl);
      } catch (error) {
        console.warn("YouTube unified card prepare failed:", error?.message || error);
        return video;
      }
    }
    if (video?.isYouTubeMerged || String(video?.url || "").includes("/api/youtube-merged-stream")) {
      return video;
    }
    const raw = String(video?.sourceStreamUrl || video?.url || "");
    if (!raw) return null;
    if (!isLikelyDirectVideoStreamUrl(raw) && !isLikelyVideoAssetUrl(raw)) return video;
    return toVerifiedPlayableVideo(video, sourcePageUrl);
  });
  return prepared.filter(Boolean);
};
var extractDirectPlatformVideoStreams = async (targetUrl, quality = "fhd") => {
  const info = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(targetUrl)
    }),
    isXUrl(targetUrl) || isFacebookUrl(targetUrl) || isInstagramUrl(targetUrl) ? 18e3 : 14e3,
    `Direct platform video metadata for ${targetUrl}`
  );
  const thumbnail = sanitizeStreamUrl(info.thumbnail || "", targetUrl) || info.thumbnail || "";
  const images = thumbnail ? [{ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, "jpg") }] : [];
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const requestedDownloads = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
  const mergedCandidates = [
    ...formats,
    ...requestedDownloads,
    ...info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, width: info.width, tbr: info.tbr }] : []
  ];
  const hasAnyAudioCandidate = mergedCandidates.some((candidate) => streamHasAudio(candidate));
  const videos = mergedCandidates.map((candidate) => {
    const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ""), targetUrl);
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
      type: candidate.ext || getVideoFormatFromUrlOrType(normalizedUrl, ""),
      title: info.title || pageTitleFromUrl(targetUrl),
      thumbnail,
      resolution: candidate.format_note || candidate.resolution || (candidate.height ? `${candidate.height}p` : "Best Quality"),
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
      duration: Number(candidate.duration || info.duration || 0) || void 0,
      isDirect: true
    };
  }).filter(Boolean);
  return { videos, images };
};
var extractHlsVariants = async (manifestUrl, sourcePageUrl) => {
  const response = await axios.get(manifestUrl, {
    timeout: 8e3,
    responseType: "text",
    httpsAgent: relaxedHttpsAgent,
    headers: mediaRequestHeaders(manifestUrl, sourcePageUrl)
  });
  const text = String(response.data || "");
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const bandwidth = line.match(/BANDWIDTH=(\d+)/i);
    const nextLine = lines.slice(index + 1).find((candidate) => {
      const value = candidate.trim();
      return value && !value.startsWith("#");
    })?.trim();
    const url = nextLine ? resolveUrl(manifestUrl, nextLine) || nextLine : "";
    if (!url) continue;
    variants.push({
      url,
      width: resolution?.[1] ? Number(resolution[1]) : void 0,
      height: resolution?.[2] ? Number(resolution[2]) : void 0,
      bandwidth: bandwidth?.[1] ? Number(bandwidth[1]) : void 0
    });
  }
  if (variants.length === 0 && manifestUrl) {
    variants.push({ url: manifestUrl });
  }
  return variants;
};
var extractBrightcoveVideos = async (playerUrl) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) return { videos: [], images: [] };
  const info = await getBrightcoveMetadata(playerUrl);
  const durationRaw = Number(info.duration || 0);
  const duration = durationRaw > 1e4 ? Math.round(durationRaw / 1e3) : durationRaw || void 0;
  const thumbnail = sanitizeStreamUrl(
    info.poster || info.thumbnail || info.poster_sources?.[0]?.src || info.thumbnail_sources?.[0]?.src || "",
    playerUrl
  ) || info.poster || info.thumbnail || "";
  const sources = Array.isArray(info.sources) ? info.sources : [];
  const hlsSource = sources.find((source) => {
    const src = String(source?.src || "");
    const type = String(source?.type || "").toLowerCase();
    return src && (src.includes(".m3u8") || type.includes("mpegurl"));
  });
  const hlsUrl = sanitizeStreamUrl(String(hlsSource?.src || ""), playerUrl) || "";
  const hlsVariants = hlsUrl ? await extractHlsVariants(hlsUrl, playerUrl).catch(() => []) : [];
  const directMp4Sources = sources.map((source) => {
    const src = sanitizeStreamUrl(String(source?.src || ""), playerUrl);
    return src ? { ...source, src } : null;
  }).filter(Boolean).filter((source) => {
    const src = String(source.src || "");
    const container = String(source.container || source.type || "").toLowerCase();
    return src && (container.includes("mp4") || /\.mp4(?:\?|$)/i.test(src));
  });
  const bestByHeight = /* @__PURE__ */ new Map();
  directMp4Sources.forEach((source) => {
    const height = Number(source.height || source.size || parseCandidateHeight(source) || 0);
    const key = String(height || "best");
    const current = bestByHeight.get(key);
    if (!current || Number(source.avg_bitrate || source.encoding_rate || source.filesize || 0) > Number(current.avg_bitrate || current.encoding_rate || current.filesize || 0)) {
      bestByHeight.set(key, source);
    }
  });
  const videos = Array.from(bestByHeight.values()).map((source) => {
    const height = Number(source.height || source.size || parseCandidateHeight(source) || 0) || void 0;
    return {
      url: source.src,
      sourceUrl: playerUrl,
      provider: "brightcove",
      type: "mp4",
      title: info.name || info.title || "Brightcove video",
      thumbnail,
      resolution: height ? `${height}p` : "Best Quality",
      formatId: source.asset_id || source.id || `${parsed.videoId}-${height || "best"}`,
      width: source.width,
      height,
      filesize: source.filesize || source.size,
      duration,
      vcodec: source.codec || source.video_codec,
      acodec: source.audio_codec || "aac",
      hasAudio: true,
      audioAvailable: true,
      isDirect: true,
      qualityExact: Boolean(height && (height === 720 || height === 1080)),
      brightcoveManifestUrl: hlsUrl,
      brightcoveAccountId: parsed.accountId,
      brightcovePlayerId: parsed.playerId,
      brightcoveVideoId: parsed.videoId
    };
  });
  const images = thumbnail ? [{ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, "jpg") }] : [];
  if (videos.length > 0) return { videos, images };
  const mergeHeights = Array.from(new Set(
    (hlsVariants.length > 0 ? hlsVariants.map((variant) => variant.height || 0) : [1080, 720]).filter((height) => height === 1080 || height === 720).sort((a, b) => b - a)
  ));
  return {
    images,
    videos: (mergeHeights.length > 0 ? mergeHeights : [0]).map((height) => ({
      url: playerUrl,
      sourceUrl: playerUrl,
      provider: "brightcove",
      type: "video",
      title: info.name || info.title || "Brightcove video",
      thumbnail,
      duration,
      resolution: height ? `${height}p` : "Best Quality",
      height: height || void 0,
      isDirect: false,
      needsMp4Merge: Boolean(hlsUrl),
      brightcoveManifestUrl: hlsUrl,
      qualityRequested: height === 1080 ? "fhd" : height === 720 ? "hd" : "best",
      qualityExact: Boolean(height === 1080 || height === 720),
      displayQualityKey: height === 1080 ? "fhd" : height === 720 ? "hd" : "best",
      displayQualityLabel: height === 1080 ? "FHD" : height === 720 ? "HD" : "Best Quality",
      streamLabel: height === 1080 ? "FHD" : height === 720 ? "HD" : "Best Quality",
      brightcoveAccountId: parsed.accountId,
      brightcovePlayerId: parsed.playerId,
      brightcoveVideoId: parsed.videoId
    }))
  };
};
var downloadBrightcoveVideoToFile = async (url, quality, options = {}) => {
  const assets = await extractBrightcoveVideos(url);
  const videos = Array.isArray(assets.videos) ? assets.videos : [];
  const requestedHeight = getVimeoTargetHeight(quality === "audio" ? "fhd" : quality);
  const directCandidates = videos.filter((video) => video?.isDirect && isLikelyDirectVideoStreamUrl(String(video?.url || ""))).sort((a, b) => {
    const aHeight = parseCandidateHeight(a) || 0;
    const bHeight = parseCandidateHeight(b) || 0;
    const aPenalty = aHeight > requestedHeight ? 1e4 + aHeight - requestedHeight : requestedHeight - aHeight;
    const bPenalty = bHeight > requestedHeight ? 1e4 + bHeight - requestedHeight : requestedHeight - bHeight;
    return aPenalty - bPenalty;
  });
  const selected = directCandidates[0];
  const fallback = videos.find((video) => video?.brightcoveManifestUrl);
  const manifestUrl = String(fallback?.brightcoveManifestUrl || selected?.brightcoveManifestUrl || "").trim();
  const selectedHlsUrl = manifestUrl;
  const streamUrl = String(selectedHlsUrl || selected?.url || "").trim();
  if (!streamUrl) throw new Error("Brightcove did not provide a downloadable video stream.");
  const resolvedTitle = String(options.title || selected?.title || fallback?.title || "Brightcove video");
  const thumbnail = String(selected?.thumbnail || fallback?.thumbnail || assets.images?.[0]?.url || "");
  const result = options.mode !== "audio" && !selectedHlsUrl && selected?.url ? await downloadDirectStreamVideoToFile(streamUrl, {
    titleHint: resolvedTitle,
    sourcePageUrl: options.sourcePageUrl || url,
    quality,
    saveToWebsiteAssets: options.saveToWebsiteAssets
  }) : await downloadPlatformVideoToFile(streamUrl, quality === "audio" ? "fhd" : quality, {
    titleHint: resolvedTitle,
    sourcePageUrl: options.sourcePageUrl || url,
    saveToWebsiteAssets: options.saveToWebsiteAssets,
    mode: options.mode === "audio" ? "audio" : "video",
    maxDurationSeconds: options.mode === "audio" ? 120 : void 0
  });
  return { ...result, title: resolvedTitle, thumbnail, platform: "brightcove" };
};
var normalizePlaylistEntryUrl = (entry, sourceUrl) => {
  const raw = String(entry?.webpage_url || entry?.webpage_url_basename || entry?.original_url || entry?.url || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_-]{6,}$/.test(raw) && isYouTubeUrl(sourceUrl)) {
    return `https://www.youtube.com/watch?v=${raw}`;
  }
  const resolved = sanitizeStreamUrl(raw, sourceUrl);
  if (!resolved) return "";
  return isYouTubeUrl(resolved) ? normalizeYouTubeWatchUrl(resolved) : resolved;
};
var extractPlaylistVideos = async (targetUrl) => {
  const info = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
      playlistEnd: 48
    }),
    isYouTubeUrl(targetUrl) ? 35e3 : 24e3,
    `Playlist metadata for ${targetUrl}`
  );
  const entries = Array.isArray(info?.entries) ? info.entries.filter(Boolean) : [];
  if (entries.length <= 1) return null;
  const playlistTitle = info.title || info.playlist_title || "Playlist";
  const videos = entries.map((entry, index) => {
    const entryUrl = normalizePlaylistEntryUrl(entry, targetUrl);
    if (!entryUrl || !isPlatformVideoUrl(entryUrl)) return null;
    const duration = Number(entry.duration || entry.duration_string || 0) || void 0;
    return {
      url: entryUrl,
      sourceUrl: entryUrl,
      pageUrl: entryUrl,
      provider: entry.extractor_key || info.extractor_key || platformProviderFromUrl(entryUrl),
      type: "video",
      title: entry.title || `${playlistTitle} ${index + 1}`,
      thumbnail: sanitizeStreamUrl(entry.thumbnail || entry.thumbnails?.[entry.thumbnails.length - 1]?.url || "", entryUrl) || "",
      duration,
      playlistTitle,
      playlistIndex: index + 1,
      playlistCount: entries.length,
      availableFormats: entries.length
    };
  }).filter(Boolean);
  if (videos.length <= 1) return null;
  return {
    playlist: {
      title: playlistTitle,
      count: videos.length,
      totalDuration: videos.reduce((sum, video) => sum + (Number(video.duration || 0) || 0), 0)
    },
    videos,
    images: []
  };
};
var extractDirectYtDlpVideoStreams = async (targetUrl, qualities = ["fhd", "hd"], exactOnly = true) => {
  const info = await withTimeout(
    youtubedl(targetUrl, {
      dumpSingleJson: true,
      ...buildYtDlpQueryOptions(targetUrl)
    }),
    isYouTubeUrl(targetUrl) ? 45e3 : 18e3,
    `Direct video metadata for ${targetUrl}`
  );
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const requestedDownloads = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
  const mergedCandidates = [
    ...formats,
    ...requestedDownloads,
    ...info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, width: info.width, tbr: info.tbr }] : []
  ];
  const normalizedCandidates = mergedCandidates.map((candidate) => {
    const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ""), targetUrl);
    return normalizedUrl ? { ...candidate, url: normalizedUrl } : null;
  }).filter(Boolean).filter((candidate) => !isExpiredStreamUrl(String(candidate.url)));
  const hasAudioCandidate = normalizedCandidates.some((candidate) => streamHasAudio(candidate));
  const playableCandidates = normalizedCandidates.filter((candidate) => {
    const raw = String(candidate.url || "");
    if (isTechnicalOrUnsupportedStream(candidate)) return false;
    if (isYouTubeUrl(targetUrl) && raw.includes(".m3u8")) return false;
    if (!streamHasVideo(candidate)) return false;
    return isLikelyDirectVideoStreamUrl(raw) || !isYouTubeUrl(targetUrl) && isLikelyVideoAssetUrl(raw);
  });
  const selectedByQuality = /* @__PURE__ */ new Map();
  for (const quality of qualities) {
    const qualityCandidates = sortCandidatesForQuality(
      exactOnly ? playableCandidates.filter((candidate) => matchesStrictQuality(parseCandidateHeight(candidate), quality)) : playableCandidates,
      quality
    );
    const selected = await firstValidStreamCandidate(qualityCandidates, targetUrl, targetUrl);
    if (!selected?.url) continue;
    const selectedHeight = selected.height || parseCandidateHeight(selected);
    const selectedHasAudio = streamHasAudio(selected);
    const payload = enforceMp4VideoPayload({
      url: selected.url,
      sourceUrl: targetUrl,
      watchUrl: isYouTubeUrl(targetUrl) ? normalizeYouTubeWatchUrl(targetUrl) : void 0,
      provider: info.extractor_key || info.extractor || platformProviderFromUrl(targetUrl),
      type: selected.ext || "mp4",
      title: info.title || pageTitleFromUrl(targetUrl),
      thumbnail: sanitizeStreamUrl(info.thumbnail || "", targetUrl) || info.thumbnail || "",
      resolution: selected.format_note || (selectedHeight ? `${selectedHeight}p` : "Best Quality"),
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
      duration: Number(selected.duration || info.duration || 0) || void 0,
      isDirect: true,
      verifiedPlayable: true
    });
    const video = isYouTubeUrl(targetUrl) ? wrapYouTubePlaybackStream(payload, normalizeYouTubeWatchUrl(targetUrl), quality) : payload;
    selectedByQuality.set(quality, video);
  }
  if (selectedByQuality.size === 0 && !exactOnly) {
    const selected = await firstValidStreamCandidate(sortCandidatesForQuality(playableCandidates, qualities[0] || "fhd"), targetUrl, targetUrl);
    if (selected?.url) {
      const selectedHeight = selected.height || parseCandidateHeight(selected);
      const selectedHasAudio = streamHasAudio(selected);
      const payload = enforceMp4VideoPayload({
        url: selected.url,
        sourceUrl: targetUrl,
        watchUrl: isYouTubeUrl(targetUrl) ? normalizeYouTubeWatchUrl(targetUrl) : void 0,
        provider: info.extractor_key || info.extractor || platformProviderFromUrl(targetUrl),
        type: selected.ext || "mp4",
        title: info.title || pageTitleFromUrl(targetUrl),
        thumbnail: sanitizeStreamUrl(info.thumbnail || "", targetUrl) || info.thumbnail || "",
        resolution: selected.format_note || (selectedHeight ? `${selectedHeight}p` : "Best Quality"),
        formatId: selected.format_id || selected.itag || selected.id,
        width: selected.width,
        height: selectedHeight,
        qualityRequested: "best",
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
        duration: Number(selected.duration || info.duration || 0) || void 0,
        isDirect: true,
        verifiedPlayable: true
      });
      selectedByQuality.set(
        "best",
        isYouTubeUrl(targetUrl) ? wrapYouTubePlaybackStream(payload, normalizeYouTubeWatchUrl(targetUrl), "fhd") : payload
      );
    }
  }
  return Array.from(selectedByQuality.values());
};
var extractDirectYtDlpVideoStream = async (targetUrl, quality = "fhd") => {
  const exact = await extractDirectYtDlpVideoStreams(targetUrl, [quality], true);
  if (exact[0]?.url) return exact[0];
  const fallback = await extractDirectYtDlpVideoStreams(targetUrl, [quality], false);
  return fallback[0] || null;
};
var materializeMergedMp4FromPlatform = async (targetUrl, quality, req, titleHint = "video", options = {}) => {
  await fsp3.mkdir(convertedVideoDir, { recursive: true });
  const targetHeight = getVimeoTargetHeight(quality);
  const tempBase = `merged-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempOutput = path3.join(convertedVideoDir, `${tempBase}.mp4`);
  const resolvedTitle = String(titleHint || "video").trim();
  const safeFilename = toQualityVideoFilename(quality, resolvedTitle);
  const targetDir = resolveDownloadsTargetDir(options.sourcePageUrl);
  await fsp3.mkdir(targetDir, { recursive: true });
  const finalPath = path3.join(targetDir, safeFilename);
  try {
    const directInputUrl = options.directInputUrl ? sanitizeStreamUrl(options.directInputUrl, options.sourcePageUrl || targetUrl) : "";
    if (directInputUrl) {
      const parsedInput = new URL2(directInputUrl);
      const { referer, origin } = getStreamRequestContext(parsedInput, options.sourcePageUrl || targetUrl);
      await transcodeUrlToMp4File(directInputUrl, tempOutput, referer, origin);
    } else {
      await withTimeout(
        youtubedl(targetUrl, {
          ...buildYtDlpDownloadOptions(targetUrl, quality, options.sourcePageUrl, tempOutput)
        }),
        4 * 60 * 1e3,
        `Merged MP4 fallback for ${targetUrl}`
      );
    }
    await validateOutputFile(tempOutput, "Merged MP4 fallback");
    const qt = await ensureQuickTimeCompatibleMp4(tempOutput, {
      titleHint: resolvedTitle,
      quality,
      outputPath: finalPath
    });
    await fsp3.unlink(tempOutput).catch(() => void 0);
    const stat = await validateOutputFile(qt.outputPath, "Merged MP4 fallback");
    return {
      url: toLocalVideoDownloadUrl(req, safeFilename, options.sourcePageUrl),
      localPath: qt.outputPath,
      downloadPath: qt.outputPath,
      copyUrl: toDisplayFilePath(qt.outputPath),
      sourceUrl: targetUrl,
      provider: platformProviderFromUrl(targetUrl),
      type: "mp4",
      title: resolvedTitle || "Video",
      resolution: `${targetHeight}p`,
      height: targetHeight,
      isDirect: true,
      isLocalMerged: true,
      verifiedPlayable: true,
      quickTimeCompatible: qt.quickTimeCompatible,
      qualityRequested: quality,
      filesize: stat.size
    };
  } catch (error) {
    await fsp3.unlink(tempOutput).catch(() => void 0);
    throw error;
  }
};
var decodeEscaped = (value) => value.replace(/\\u0025/g, "%").replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
var extractFacebookVideoFallback = async (targetUrl, quality = "fhd") => {
  const response = await axios.get(targetUrl, {
    timeout: 12e3,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  const html = String(response.data || "");
  const pick = (patterns) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeEscaped(match[1]);
    }
    return "";
  };
  const hd = pick([
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
    /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/i,
    /"hd_src"\s*:\s*"([^"]+)"/i
  ]);
  const sd = pick([
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/i,
    /"playable_url"\s*:\s*"([^"]+)"/i,
    /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/i,
    /"sd_src"\s*:\s*"([^"]+)"/i
  ]);
  const thumbnail = pick([
    /<meta property="og:image" content="([^"]+)"/i,
    /"preferred_thumbnail"\s*:\s*\{"image"\s*:\s*\{"uri"\s*:\s*"([^"]+)"/i
  ]);
  const title = pick([
    /<meta property="og:title" content="([^"]+)"/i,
    /<title[^>]*>([^<]+)<\/title>/i
  ]) || "Facebook video";
  const selected = sanitizeStreamUrl(quality === "fhd" ? hd || sd : sd || hd, targetUrl);
  if (!selected) return null;
  return {
    url: selected,
    sourceUrl: targetUrl,
    provider: "facebook",
    type: "mp4",
    title,
    thumbnail: sanitizeStreamUrl(thumbnail, targetUrl) || thumbnail,
    resolution: hd && sanitizeStreamUrl(hd, targetUrl) === selected ? "1080p" : "720p",
    isDirect: true
  };
};
var extractXVideoFallback = async (targetUrl, quality = "fhd") => {
  const parsed = new URL2(targetUrl);
  const altUrl = `https://vxtwitter.com${parsed.pathname}${parsed.search || ""}`;
  const response = await axios.get(altUrl, {
    timeout: 12e3,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  const html = String(response.data || "");
  const pick = (patterns) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeEscaped(match[1]);
    }
    return "";
  };
  const ogVideo = pick([
    /<meta\s+property="og:video"\s+content="([^"]+)"/i,
    /<meta\s+property="og:video:url"\s+content="([^"]+)"/i
  ]);
  const thumbnail = pick([
    /<meta\s+property="og:image"\s+content="([^"]+)"/i,
    /<meta\s+name="twitter:image"\s+content="([^"]+)"/i
  ]);
  const title = pick([
    /<meta\s+property="og:title"\s+content="([^"]+)"/i,
    /<title[^>]*>([^<]+)<\/title>/i
  ]) || "X video";
  const selected = sanitizeStreamUrl(ogVideo, targetUrl);
  if (!selected) return null;
  return {
    url: selected,
    sourceUrl: targetUrl,
    provider: "x",
    type: "mp4",
    title,
    thumbnail: sanitizeStreamUrl(thumbnail, targetUrl) || thumbnail,
    resolution: quality === "fhd" ? "1080p" : "720p",
    isDirect: true
  };
};
var buildVimeoStreamVideos = (vimeoUrl, resolved) => {
  const videos = [];
  const images = [];
  const thumbnail = resolved.thumbnail;
  const title = String(resolved.title || "").trim();
  const streamBuckets = Object.entries(resolved.streams);
  if (!title || title === "Vimeo video" || !thumbnail || streamBuckets.length === 0) {
    return { videos, images };
  }
  images.push({ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, "jpg") });
  streamBuckets.forEach(([bucket, stream]) => {
    const acodec = String(stream.acodec || "");
    const hasAudio = stream.type === "m3u8" ? true : acodec !== "none";
    videos.push({
      url: stream.url,
      sourceStreamUrl: stream.sourceStreamUrl,
      sourceUrl: vimeoUrl,
      vimeoId: resolved.vimeoId || void 0,
      provider: "vimeo",
      isVimeoDirect: true,
      isVimeoHls: stream.type === "m3u8",
      type: stream.type,
      title,
      thumbnail,
      resolution: stream.height ? `${stream.height}p` : "Unknown",
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
      vimeoQualityDebug: resolved.debug
    });
  });
  return { videos, images };
};
var extractVimeoVideos = async (vimeoUrls, quality = "fhd", sourcePageUrl = "") => {
  const uniqueUrls = dedupeVimeoUrlsById(
    vimeoUrls.map((value) => normalizeVimeoUrl(value) || value).filter(Boolean)
  );
  const results = await mapWithConcurrency(uniqueUrls.slice(0, 12), 4, async (vimeoUrl) => {
    const vimeoId = parseVimeoIdFromUrl(vimeoUrl);
    try {
      let ytDlpInfo = null;
      try {
        ytDlpInfo = await withTimeout(
          getVimeoMetadata(vimeoUrl, sourcePageUrl),
          25e3,
          `Vimeo yt-dlp metadata for ${vimeoUrl}`
        );
      } catch (error) {
        console.warn(`[vimeo:${vimeoId}] yt-dlp metadata skipped:`, error?.message || error);
      }
      const resolved = await resolveVimeoQualityStreams(vimeoUrl, sourcePageUrl, ytDlpInfo);
      const built = buildVimeoStreamVideos(vimeoUrl, resolved);
      if (built.videos.length === 0) {
        console.warn(`[vimeo:${vimeoId}] Skipping card \u2014 title, thumbnail, or streams were not fully resolved.`);
        return { images: [], videos: createVimeoSourceVideos([vimeoUrl]) };
      }
      return built;
    } catch (error) {
      console.warn(`[vimeo:${vimeoId}] Vimeo extraction failed:`, error?.message || error);
      return { images: [], videos: createVimeoSourceVideos([vimeoUrl]) };
    }
  });
  return {
    videos: results.flatMap((result) => result.videos),
    images: results.flatMap((result) => result.images)
  };
};
var createVimeoSourceVideos = (vimeoUrls) => {
  const uniqueUrls = Array.from(new Set(vimeoUrls.map(normalizeVimeoUrl).filter(Boolean)));
  return uniqueUrls.slice(0, 24).map((vimeoUrl) => ({
    url: vimeoUrl,
    provider: "vimeo",
    isVimeo: true,
    type: "vimeo",
    title: "Vimeo video"
  }));
};
var wistiaMetadataCache = /* @__PURE__ */ new Map();
var wistiaMetadataTtlMs = 3 * 60 * 1e3;
var getWistiaMetadata = async (hashedId) => {
  const cached = wistiaMetadataCache.get(hashedId);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const embedUrl = buildWistiaEmbedUrl(hashedId);
  const response = await withTimeout(
    axios.get(`${embedUrl}.json`, {
      timeout: 12e3,
      httpsAgent: relaxedHttpsAgent,
      headers: browserLikeHeaders(embedUrl)
    }),
    12e3,
    `Wistia metadata for ${hashedId}`
  );
  const media = response.data?.media;
  if (!media) throw new Error(`Wistia media not found for ${hashedId}`);
  wistiaMetadataCache.set(hashedId, { expiresAt: Date.now() + wistiaMetadataTtlMs, info: media });
  return media;
};
var extractWistiaVideos = async (wistiaIds, quality = "fhd") => {
  const uniqueIds = Array.from(new Set(wistiaIds.filter(Boolean)));
  const results = await mapWithConcurrency(uniqueIds.slice(0, 12), 4, async (hashedId) => {
    try {
      const media = await getWistiaMetadata(hashedId);
      const wistiaUrl = buildWistiaEmbedUrl(hashedId);
      const title = String(media.name || "Wistia video").trim() || "Wistia video";
      const videos = [];
      const images = [];
      const stillAsset = (Array.isArray(media.assets) ? media.assets : []).find((asset) => asset?.type === "still_image" && asset?.url);
      const thumbnail = stillAsset?.url ? sanitizeStreamUrl(stillAsset.url, wistiaUrl) || stillAsset.url : "";
      if (thumbnail) {
        images.push({ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, "jpg") });
      }
      const mp4Assets = (Array.isArray(media.assets) ? media.assets : []).filter((asset) => {
        const ext = String(asset?.ext || asset?.container || "").toLowerCase();
        const type = String(asset?.type || "").toLowerCase();
        if (!asset?.url || asset?.status !== 2) return false;
        if (type === "still_image" || type === "storyboard") return false;
        return ext === "mp4" || type.includes("mp4") || type === "iphone_video";
      }).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
      if (mp4Assets.length > 0) {
        const bestAsset = mp4Assets[0];
        const fhdAsset = mp4Assets.find((asset) => Number(asset.height || 0) >= 900);
        const hdAsset = mp4Assets.find((asset) => {
          const height = Number(asset.height || 0);
          return height >= 600 && height < 900;
        });
        const publishAssets = Array.from(new Map(
          [bestAsset, fhdAsset, hdAsset].filter(Boolean).map((asset) => [Number(asset.height || 0), asset])
        ).values());
        publishAssets.forEach((asset) => {
          const normalizedUrl = asset?.url ? sanitizeStreamUrl(asset.url, wistiaUrl) : null;
          if (!normalizedUrl) return;
          videos.push({
            url: normalizedUrl,
            sourceUrl: wistiaUrl,
            provider: "wistia",
            isWistiaDirect: true,
            type: "mp4",
            title,
            thumbnail,
            resolution: asset.display_name || (asset.height ? `${asset.height}p` : "Unknown"),
            width: asset.width,
            height: asset.height,
            bitrate: asset.bitrate,
            filesize: asset.size,
            duration: Number(media.duration || 0) || void 0,
            wistiaHashedId: hashedId,
            availableFormats: publishAssets.length,
            qualityRequested: quality,
            qualityExact: matchesStrictQuality(Number(asset.height || 0), quality),
            hasAudio: true,
            audioAvailable: true,
            acodec: "aac",
            vcodec: asset.codec || "h264"
          });
        });
      } else {
        videos.push({
          url: wistiaUrl,
          sourceUrl: wistiaUrl,
          provider: "wistia",
          isWistia: true,
          type: "wistia",
          title,
          thumbnail,
          wistiaHashedId: hashedId
        });
      }
      return { videos, images };
    } catch (error) {
      console.warn(`Wistia extraction failed for ${hashedId}:`, error?.message || error);
      const wistiaUrl = buildWistiaEmbedUrl(hashedId);
      return {
        images: [],
        videos: [{
          url: wistiaUrl,
          sourceUrl: wistiaUrl,
          provider: "wistia",
          isWistia: true,
          type: "wistia",
          title: "Wistia video",
          wistiaHashedId: hashedId
        }]
      };
    }
  });
  return {
    videos: results.flatMap((result) => result.videos),
    images: results.flatMap((result) => result.images)
  };
};
var createWistiaSourceVideos = (wistiaIds) => {
  const uniqueIds = Array.from(new Set(wistiaIds.filter(Boolean)));
  return uniqueIds.slice(0, 24).map((hashedId) => {
    const wistiaUrl = buildWistiaEmbedUrl(hashedId);
    return {
      url: wistiaUrl,
      sourceUrl: wistiaUrl,
      provider: "wistia",
      isWistia: true,
      type: "wistia",
      title: "Wistia video",
      wistiaHashedId: hashedId
    };
  });
};
var SECTION_PICKER_SCRIPT = `
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
var injectSectionPickerIntoHtml = (html, targetUrl, enablePicker = true) => {
  const baseTag = `<base href="${targetUrl.replace(/"/g, "&quot;")}">`;
  const scriptTag = enablePicker ? `<script>${SECTION_PICKER_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>` : "";
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`).replace(/<\/body>/i, `${scriptTag}</body>`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}${scriptTag}</body></html>`;
};
var extractSectionAssetsFromHtml = async (targetUrl, sectionHtml, sectionSelector, sectionLabel = "", computedFonts = []) => {
  const $section = cheerio.load(sectionHtml);
  const images = [];
  const icons = [];
  let fonts = [];
  const colors = [];
  images.push(...extractImagesFromDom($section, targetUrl, { scoped: true }));
  icons.push(...extractIconsFromDom($section, targetUrl));
  $section("video[poster]").each((_, el) => {
    addImageCandidate(images, $section(el).attr("poster"), targetUrl, void 0, { permissive: true });
  });
  $section("style").each((_, el) => {
    const cssText = $section(el).html();
    if (!cssText) return;
    fonts = fonts.concat(extractFontsFromCss(cssText, targetUrl));
    images.push(...extractImagesFromCss(cssText, targetUrl));
    colors.push(...extractColorsFromCss(cssText));
  });
  $section("[style]").each((_, el) => {
    const style = $section(el).attr("style");
    if (!style) return;
    images.push(...extractImagesFromCss(style, targetUrl));
    colors.push(...extractColorsFromCss(style));
  });
  const pageHtml = await withTimeout(fetchSiteHtml(targetUrl), 28e3, `Section CSS fetch for ${targetUrl}`).catch(() => "");
  if (pageHtml) {
    const cssBundle = await withTimeout(
      fetchCssSourceCandidates(targetUrl, pageHtml, { fast: true }),
      8e3,
      `Section stylesheet scan for ${targetUrl}`
    ).catch(() => ({ inlineStyles: [], fetchedCss: [] }));
    [...cssBundle.inlineStyles, ...cssBundle.fetchedCss].forEach(({ css, source }) => {
      fonts = fonts.concat(extractFontsFromCss(css, source));
    });
  }
  if (computedFonts.length > 0) {
    fonts = filterFontsByComputedUsage(fonts, computedFonts);
  }
  return dedupeExtractedAssets(images, [], fonts, colors, targetUrl, "", {
    fast: true,
    extraIcons: icons,
    sectionMode: true,
    sectionLabel,
    sectionSelector
  });
};
var extractSectionAssets = async (targetUrl, sectionSelector, sectionLabel = "") => {
  let browser = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await acquireSingleWebsitePage(browser);
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 45e3 }).catch(() => void 0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const sectionData = await page.evaluate((selector) => {
      const root = document.querySelector(selector);
      if (!root) return null;
      const computedFonts = [];
      const seen = /* @__PURE__ */ new Set();
      root.querySelectorAll("*").forEach((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return;
        const style = window.getComputedStyle(el);
        const payload = JSON.stringify({
          family: style.fontFamily,
          weight: style.fontWeight,
          style: style.fontStyle
        });
        if (seen.has(payload)) return;
        seen.add(payload);
        computedFonts.push(JSON.parse(payload));
      });
      return {
        html: root.outerHTML,
        label: root.getAttribute("data-section-label") || root.getAttribute("aria-label") || root.getAttribute("id") || root.tagName.toLowerCase(),
        computedFonts
      };
    }, sectionSelector);
    await page.close().catch(() => void 0);
    await closePuppeteerBrowser(browser);
    browser = null;
    if (!sectionData?.html) {
      throw new Error("Selected section was not found on the page. Pick the section again.");
    }
    return extractSectionAssetsFromHtml(
      targetUrl,
      sectionData.html,
      sectionSelector,
      sectionLabel || sectionData.label || "",
      sectionData.computedFonts || []
    );
  } finally {
    if (browser) await closePuppeteerBrowser(browser).catch(() => void 0);
  }
};
app.get("/api/section-frame", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!rawUrl) return res.status(400).send("URL is required");
  try {
    const targetUrl = new URL2(rawUrl).href;
    assertPublicAssetUrl(targetUrl);
    if (isVideoPlatformHostUrl(targetUrl) && isPlatformVideoUrl(targetUrl)) {
      return res.status(400).send("Video platform URLs cannot be previewed here. Use Video Downloader instead.");
    }
    let html = await withTimeout(fetchSiteHtml(targetUrl), 2e4, `Section frame for ${targetUrl}`).catch(() => "");
    if (!html || htmlLooksLikeBotWall(html)) {
      const readerText = await fetchReaderFallbackText(targetUrl).catch(() => "");
      html = buildKnownBlockedSiteFallbackHtml(targetUrl, readerText);
      if (!html && readerText) {
        const escaped = readerText.replace(/[<&>]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] || char);
        html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;line-height:1.55;color:#18181b}pre{white-space:pre-wrap}</style></head><body><pre>${escaped}</pre></body></html>`;
      }
    }
    if (!html) return res.status(502).send("Could not load page HTML.");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;");
    const enablePicker = req.query.picker !== "0";
    return res.send(injectSectionPickerIntoHtml(html, targetUrl, enablePicker));
  } catch (error) {
    return res.status(500).send(error?.message || "Failed to load section preview.");
  }
});
app.post("/api/extract", async (req, res) => {
  const { url, mode, extractionMode, sectionSelector, sectionLabel, scope, videosOnly: videosOnlyBody, crawlMode: crawlModeBody, siteProfile: siteProfileBody, proxyUrl } = req.body;
  const needsDeepCrawl = /fabindia\.com|warehousestationery\.co\.nz|\.imaging\/|\/dam\/jcr:/i.test(url);
  const crawlMode = crawlModeBody === "deep" || needsDeepCrawl ? "deep" : "fast";
  const isFastCrawl = crawlMode !== "deep";
  let browser = null;
  let extractKey = "";
  let progressMgr = null;
  let quickExtractPromise = null;
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const targetUrl = new URL2(url).href;
    assertPublicAssetUrl(targetUrl);
    const extractionProxyUrl = normalizeExtractionProxyUrl(proxyUrl);
    activeExtractionProxyUrl = extractionProxyUrl;
    lastExtractedSourceUrl = targetUrl;
    extractKey = `${crypto2.createHash("sha256").update(targetUrl).digest("hex").slice(0, 12)}-${Date.now().toString(36)}-${crypto2.randomBytes(3).toString("hex")}`;
    progressMgr = ExtractionProgressManager.create(extractKey);
    activeExtractProgress = progressMgr;
    setGlobalProgressManager(progressMgr);
    res.setHeader("X-Extract-Id", extractKey);
    const videosOnly = scope === "videos" || videosOnlyBody === true;
    const useStaticExtract = mode === "static";
    const sectionExtract = extractionMode === "section" && typeof sectionSelector === "string" && sectionSelector.trim().length > 0;
    lastExtractionSectionMode = sectionExtract;
    if (sectionExtract && isVideoPlatformHostUrl(targetUrl)) {
      return res.status(400).json({ error: "Section extraction is for website assets only. Use Extract for video URLs." });
    }
    if (sectionExtract) {
      const sectionAssets = await extractSectionAssets(targetUrl, sectionSelector.trim(), String(sectionLabel || "").trim());
      return res.json(sectionAssets);
    }
    lastExtractionSectionMode = false;
    if (extractionMode === "direct") {
      try {
        const directAssets = await buildDirectVideoExtractResponse(targetUrl);
        return res.json(directAssets);
      } catch (directError) {
        return res.status(400).json({ error: directError?.message || "Direct video extraction failed." });
      }
    }
    if (isVideoPlatformHostUrl(targetUrl) && !isPlaylistUrl(targetUrl) && !isPlatformVideoUrl(targetUrl) && !isPlatformMarketingHomepage(targetUrl)) {
      return res.json({
        images: [],
        videos: [],
        fonts: [],
        colors: []
      });
    }
    const isWarehouseStationeryRequest = /warehousestationery\.co\.nz/i.test(targetUrl);
    if (mode === "quick" && !isWarehouseStationeryRequest) {
      const quickAssets = await withTimeout(
        extractQuickAssets(targetUrl, { videosOnly }),
        // Leave enough room for the reader fallback used by challenge pages.
        3e4,
        `Quick extract for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      return res.json(quickAssets);
    }
    if (useStaticExtract && !isWarehouseStationeryRequest) {
      const staticAssets = await withTimeout(
        extractStaticAssets(targetUrl, "", { fast: true, videosOnly }),
        isFastCrawl ? 35e3 : 45e3,
        `Static extract for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      return res.json(staticAssets);
    }
    const isWarehouseStationeryTarget = isWarehouseStationeryRequest;
    if (isWarehouseStationeryTarget) {
      const warehouseAssetsPromise = videosOnly ? Promise.resolve({ fonts: [], colors: [] }) : withTimeout(
        extractProtectedPageAssetsFast(targetUrl),
        24e3,
        `Warehouse Stationery font and color scan for ${targetUrl}`
      ).catch(() => ({ fonts: [], colors: [] }));
      const readerText = await withTimeout(
        fetchReaderFallbackText(targetUrl),
        55e3,
        `Warehouse Stationery reader fetch for ${targetUrl}`
      ).catch(() => "");
      if (readerText) {
        const discovered = extractAssetsFromRawText(readerText, targetUrl);
        const directAssetUrls = Array.from(
          readerText.matchAll(/https?:\/\/[^\s)"'<>]+\.(?:svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf)(?:\?[^\s)"'<>]*)?/gi),
          (match) => match[0]
        );
        for (const assetUrl of directAssetUrls) {
          if (/\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(assetUrl)) {
            discovered.fonts.push({
              family: "",
              url: assetUrl,
              format: getFontFormatFromUrlOrType(assetUrl, ""),
              status: DEFAULT_ASSET_STATUS
            });
          } else {
            discovered.images.push({
              url: assetUrl,
              type: getAssetTypeFromUrl(assetUrl, "img"),
              status: DEFAULT_ASSET_STATUS
            });
          }
        }
        const uniqueByUrl = (items) => Array.from(
          new Map(
            items.filter((item) => /^https?:\/\//i.test(String(item?.url || ""))).map((item) => [String(item.url), { ...item, status: item.status || DEFAULT_ASSET_STATUS }])
          ).values()
        );
        const readerImages = uniqueByUrl(discovered.images || []);
        if (readerImages.length >= 20) {
          const protectedAssets = await warehouseAssetsPromise;
          return res.json({
            images: videosOnly ? [] : readerImages,
            videos: uniqueByUrl(discovered.videos || []),
            fonts: uniqueByUrl([...discovered.fonts || [], ...protectedAssets.fonts]),
            colors: protectedAssets.colors
          });
        }
      }
      const readerAssets = await withTimeout(
        extractReaderFallbackAssets(targetUrl, { videosOnly }),
        105e3,
        `Warehouse Stationery reader extraction for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      if (isUsableStaticExtract(readerAssets)) {
        return res.json(readerAssets);
      }
    }
    const prefetchedSiteHtml = await withTimeout(
      fetchSiteHtml(targetUrl),
      12e3,
      `Prefetch HTML for ${targetUrl}`
    ).catch(() => "");
    let extractionProfile = classifyWebsiteExtraction({
      url: targetUrl,
      html: prefetchedSiteHtml,
      crawlMode,
      captchaDetected: Boolean(prefetchedSiteHtml && htmlLooksLikeBotWall(prefetchedSiteHtml)),
      profileHint: ["normal", "heavy", "captcha"].includes(siteProfileBody) ? siteProfileBody : "auto"
    });
    progressMgr?.setProfile(extractionProfile);
    progressMgr?.setTask(extractionProfile.detail);
    const staticFallbackAssets = async () => extractStaticAssets(targetUrl, prefetchedSiteHtml);
    if (!prefetchedSiteHtml || !htmlLooksLikeBotWall(prefetchedSiteHtml)) {
      const blockedFallbackAssets = await withTimeout(
        extractReaderFallbackAssets(targetUrl, { videosOnly }),
        35e3,
        `Blocked site fallback for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      if (isStrongStaticExtractForImmediateReturn(blockedFallbackAssets, { videosOnly })) {
        return res.json(blockedFallbackAssets);
      }
      const staticRecoveryAssets = await withTimeout(
        extractStaticAssets(targetUrl, "", { fast: true, videosOnly }),
        35e3,
        `Static recovery before browser for ${targetUrl}`
      ).catch(() => ({ images: [], videos: [], fonts: [], colors: [] }));
      if (isStrongStaticExtractForImmediateReturn(staticRecoveryAssets, { videosOnly }) || videosOnly && Array.isArray(staticRecoveryAssets.videos) && staticRecoveryAssets.videos.length > 0) {
        return res.json(staticRecoveryAssets);
      }
      if (isUsableStaticExtract(blockedFallbackAssets)) {
        return res.json(blockedFallbackAssets);
      }
    }
    if (prefetchedSiteHtml && !htmlLooksLikeBotWall(prefetchedSiteHtml)) {
      try {
        const hasVimeoHints = /vimeo\.com|data-vimeo-id/i.test(prefetchedSiteHtml);
        const staticQuickTimeoutMs = isToyotaVehicleExtractionTarget(targetUrl) ? 6e3 : hasVimeoHints ? 75e3 : shouldTryStaticBeforeBrowser(prefetchedSiteHtml) ? 45e3 : 18e3;
        const staticQuick = await withTimeout(
          extractStaticAssets(targetUrl, prefetchedSiteHtml, { fast: true, videosOnly }),
          staticQuickTimeoutMs,
          `Static fast path for ${targetUrl}`
        );
        if (isUsableStaticExtract(staticQuick) && (videosOnly && Array.isArray(staticQuick.videos) && staticQuick.videos.length > 0 || isStrongStaticExtractForImmediateReturn(staticQuick, { videosOnly }) || !htmlNeedsRenderedExtraction(prefetchedSiteHtml) && !staticExtractNeedsBrowser(prefetchedSiteHtml, staticQuick, { videosOnly }) && !staticExtractHasUnresolvedEmbeds(prefetchedSiteHtml, staticQuick, { videosOnly }))) {
          return res.json(staticQuick);
        }
      } catch (error) {
        console.warn("Static fast path skipped, continuing with browser route:", error?.message || error);
      }
    }
    const images = [];
    const videos = [];
    let fonts = [];
    let renderedComputedFonts = [];
    let colors = [];
    const vimeoCandidateUrls = /* @__PURE__ */ new Set();
    const wistiaCandidateIds = /* @__PURE__ */ new Set();
    const embeddedPageUrls = /* @__PURE__ */ new Set();
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
            playlist: playlistAssets.playlist
          });
        }
      } catch (error) {
        console.warn("Playlist metadata extraction failed, continuing with single-video route:", error?.message || error);
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
            colors: []
          });
        }
      } catch (error) {
        console.warn("Brightcove direct extraction failed, continuing with browser route:", error?.message || error);
      }
    }
    if (isYouTube) {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(targetUrl) || targetUrl;
      const fallbackVideo = {
        url: toYouTubeMergedDownloadUrl(normalizedWatchUrl, "fhd", pageTitleFromUrl(normalizedWatchUrl)),
        sourceStreamUrl: normalizedWatchUrl,
        sourceUrl: normalizedWatchUrl,
        pageUrl: normalizedWatchUrl,
        watchUrl: normalizedWatchUrl,
        provider: "youtube",
        type: "mp4",
        isYouTube: true,
        isYouTubeMerged: true,
        isDirect: true,
        isMp4Proxy: true,
        qualityRequested: "fhd",
        displayQualityKey: "fhd",
        displayQualityLabel: getCleanQualityLabel("fhd"),
        streamLabel: getCleanQualityLabel("fhd"),
        audioAvailable: true,
        hasAudio: true,
        noAudio: false,
        verifiedPlayable: true
      };
      try {
        const ytDlpDirectVideos = await extractDirectYtDlpVideoStreams(targetUrl, ["fhd", "hd"], true).catch((error) => {
          console.warn("YouTube yt-dlp direct extraction failed, trying ytdl-core:", error?.message || error);
          return [];
        });
        if (ytDlpDirectVideos.length > 0) {
          const cleanVideos2 = await prepareVisibleVideoStreams(ytDlpDirectVideos, targetUrl);
          if (cleanVideos2.length > 0) {
            return res.json({
              images: [],
              videos: cleanVideos2,
              fonts: [],
              colors: []
            });
          }
        }
        let bestDirectVideo = null;
        const directVideo = await resolveYouTubeBestAvailableStream(targetUrl);
        if (directVideo?.url) {
          bestDirectVideo = directVideo;
        }
        const info = await ytdl.getInfo(targetUrl);
        const youtubeId = getYouTubeVideoId(targetUrl);
        const thumbnails = Array.isArray(info?.videoDetails?.thumbnails) ? info.videoDetails.thumbnails : [];
        const pickedThumb = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1]?.url : youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : "";
        const thumbnail = sanitizeStreamUrl(String(pickedThumb || ""), targetUrl) || String(pickedThumb || "");
        if (info.formats) {
          info.formats.forEach((format) => {
            const formatUrl = sanitizeStreamUrl(format.url, targetUrl);
            if (formatUrl && format.hasVideo && !isExpiredStreamUrl(formatUrl)) {
              const acodec = String(format.audioCodec || format.acodec || "");
              const hasAudio = Boolean(format.hasAudio) || acodec && acodec.toLowerCase() !== "none" && acodec.toLowerCase() !== "unknown";
              videos.push({
                url: formatUrl,
                sourceUrl: targetUrl,
                provider: "youtube",
                type: "mp4",
                resolution: format.qualityLabel || "Unknown",
                formatId: format.itag || format.format_id,
                width: format.width,
                height: format.height,
                formatNote: format.quality,
                fps: format.fps,
                vcodec: format.videoCodec,
                acodec: format.audioCodec || format.acodec,
                hasAudio,
                filesize: format.contentLength,
                title: info.videoDetails?.title || "YouTube video",
                thumbnail,
                duration: Number(info.videoDetails?.lengthSeconds || 0) || void 0,
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
        const uniqueImages = Array.from(new Set(images.map((i) => i.url))).map((url2) => images.find((i) => i.url === url2));
        const uniqueVideos = Array.from(new Set(videos.map((v) => v.url))).map((url2) => videos.find((v) => v.url === url2));
        const cleanVideos = await prepareVisibleVideoStreams(
          uniqueVideos.map((video) => wrapYouTubePlaybackStream(
            video,
            normalizeYouTubeWatchUrl(targetUrl),
            String(video?.qualityRequested || getCleanQualityKey(video) || "fhd")
          )),
          targetUrl
        );
        return res.json({
          images: [],
          videos: cleanVideos.length > 0 ? cleanVideos : [fallbackVideo],
          fonts: [],
          colors: []
        });
      } catch (err) {
        console.error("ytdl-core error:", err.message);
        const directVideo = await extractDirectYtDlpVideoStream(targetUrl, "fhd").catch(() => null) || await resolveYouTubeBestAvailableStream(targetUrl);
        const cleanVideos = await prepareVisibleVideoStreams(directVideo?.url ? [directVideo] : [], targetUrl);
        return res.json({
          images: [],
          videos: cleanVideos.length > 0 ? cleanVideos : [fallbackVideo],
          fonts: [],
          colors: []
        });
      }
    }
    if (isVimeoUrl(targetUrl)) {
      const vimeoUrl = normalizeVimeoUrl(targetUrl);
      if (vimeoUrl) {
        try {
          const vimeoAssets = await withTimeout(
            extractVimeoVideos([vimeoUrl], "fhd", targetUrl),
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
            colors: []
          });
        } catch (error) {
          console.warn("Vimeo extraction failed:", error?.message || error);
          return res.json({
            images: [],
            videos: [],
            fonts: [],
            colors: []
          });
        }
      }
    }
    if (isXUrl(targetUrl) || isFacebookUrl(targetUrl) || isInstagramUrl(targetUrl)) {
      const fallbackVideo = isPlatformVideoUrl(targetUrl) ? {
        url: targetUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(targetUrl),
        type: "video",
        title: platformProviderFromUrl(targetUrl) === "x" ? "X video" : `${platformProviderFromUrl(targetUrl)} video`
      } : null;
      try {
        const platformAssets = await extractDirectPlatformVideoStreams(targetUrl, "fhd");
        const cleanPlatformVideos = await prepareVisibleVideoStreams(platformAssets.videos || [], targetUrl);
        return res.json({
          images: [],
          videos: cleanPlatformVideos.length > 0 ? cleanPlatformVideos : fallbackVideo ? [fallbackVideo] : [],
          fonts: [],
          colors: []
        });
      } catch (error) {
        console.warn("Fast platform video extraction failed:", error?.message || error);
        return res.json({
          images: [],
          videos: fallbackVideo ? [fallbackVideo] : [],
          fonts: [],
          colors: []
        });
      }
    }
    const browserBudgetMs = extractionProfile.browserBudgetMs;
    activeExtractProgress?.setPhase("loading");
    quickExtractPromise = extractionProxyUrl ? Promise.resolve(null) : quickExtractInWorker(targetUrl).catch(() => null);
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
        await page.setRequestInterception(true);
        page.on("request", async (request) => {
          if (request.isInterceptResolutionHandled()) return;
          const requestUrl = request.url();
          const resourceType = request.resourceType();
          if (!videosOnly && (resourceType === "image" || /\/medias\/[^?#]+\.(?:svg|png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(requestUrl))) {
            const asset = createImageAsset(requestUrl, targetUrl, {}, { permissive: true });
            pushImageAsset(images, asset);
            touchAssetActivity();
          }
          if (videosOnly && ["image", "font", "stylesheet"].includes(resourceType)) {
            await request.abort().catch(() => void 0);
            return;
          }
          if (["websocket", "eventsource"].includes(resourceType)) {
            await request.abort().catch(() => void 0);
            return;
          }
          if (/google-analytics|googletagmanager|doubleclick|facebook\.net\/tr|hotjar|clarity\.ms|segment\.io/i.test(requestUrl)) {
            await request.abort().catch(() => void 0);
            return;
          }
          await request.continue().catch(() => void 0);
        });
        const handlePageResponse = async (response) => {
          const url2 = sanitizeStreamUrl(response.url(), targetUrl) || response.url();
          const resourceType = response.request().resourceType();
          const status = response.status();
          const headers = response.headers ? response.headers() : {};
          const contentType = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
          if (isVimeoUrl(url2)) {
            const vimeoUrl = normalizeVimeoUrl(url2);
            if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
          }
          if (status >= 200 && status < 300) {
            const looksLikeImageResponse = !videosOnly && (resourceType === "image" || /^image\//i.test(contentType));
            if (looksLikeImageResponse && (isLikelyImageAssetUrl(url2, contentType) || resourceType === "image")) {
              images.push({
                url: url2,
                type: inferImageTypeFromUrl(url2, contentType) || getAssetTypeFromUrl(url2, "img"),
                status: DEFAULT_ASSET_STATUS
              });
              touchAssetActivity();
              if (!isFastCrawl) {
                void (async () => {
                  try {
                    const buffer = Buffer.from(await withTimeout(Promise.resolve(response.buffer()), 4e3, "Image buffer read"));
                    const cachedUrl = await writeCachedOriginalImageFromBuffer(
                      url2,
                      buffer,
                      contentType,
                      inferImageTypeFromUrl(url2, contentType) || "bin"
                    );
                    if (cachedUrl) {
                      const existing = images.find((item) => item.url === url2);
                      if (existing) {
                        existing.cachedUrl = cachedUrl;
                        existing.status = "downloaded";
                      }
                    }
                  } catch {
                    const existing = images.find((item) => item.url === url2);
                    if (existing && !existing.cachedUrl) existing.status = "failed-download";
                  }
                })();
              }
            }
            const looksLikeVideoResponse = resourceType === "media" || /video\/|mpegurl|dash\+xml/i.test(contentType) || isLikelyVideoAssetUrl(url2);
            if (looksLikeVideoResponse) {
              videos.push({
                url: url2,
                sourceUrl: targetUrl,
                provider: platformProviderFromUrl(url2),
                type: getVideoFormatFromUrlOrType(url2, contentType),
                title: pageTitleFromUrl(url2),
                isDirect: isLikelyDirectVideoStreamUrl(url2) || isLikelyVideoAssetUrl(url2),
                status: DEFAULT_ASSET_STATUS
              });
            }
            const looksLikeFontResponse = resourceType === "font" || /font\/|application\/font|vnd\.ms-fontobject/i.test(contentType) || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url2);
            if (looksLikeFontResponse) {
              const format = getFontFormatFromUrlOrType(url2, contentType);
              if (isSupportedFontFormat(format)) {
                fonts.push({
                  family: "",
                  url: url2,
                  format,
                  status: DEFAULT_ASSET_STATUS
                });
              }
            }
            if (resourceType === "stylesheet" || /text\/css/i.test(contentType) || /\.css(\?|$)/i.test(url2)) {
              try {
                const cssReadMs = isFastCrawl ? 1e3 : 1500;
                const cssText = String(await withTimeout(Promise.resolve(response.text()), cssReadMs, "Stylesheet read"));
                if (isFastCrawl && cssText.length > 4e5) return;
                fonts.push(...extractFontsFromCss(cssText, String(url2)));
                images.push(...extractImagesFromCss(cssText, String(url2)));
                const rawAssets = extractAssetsFromRawText(cssText, String(url2));
                images.push(...rawAssets.images);
                videos.push(...rawAssets.videos);
                fonts.push(...rawAssets.fonts);
              } catch {
              }
            }
            if (resourceType === "script" || /(?:javascript|json|text\/plain)/i.test(contentType) || /\.(?:js|json)(\?|$)/i.test(url2)) {
              try {
                const sourceText = String(await withTimeout(Promise.resolve(response.text()), 1500, "Script/config read"));
                const rawAssets = extractAssetsFromRawText(sourceText, String(url2));
                images.push(...rawAssets.images);
                videos.push(...rawAssets.videos);
                fonts.push(...rawAssets.fonts);
              } catch {
              }
            }
            if ((resourceType === "xhr" || resourceType === "fetch") && /(?:application\/json|text\/json|\+json)/i.test(contentType)) {
              try {
                const jsonText = String(await withTimeout(Promise.resolve(response.text()), 2500, "XHR JSON read"));
                const rawAssets = extractAssetsFromRawText(jsonText, targetUrl);
                if (!videosOnly) {
                  images.push(...rawAssets.images);
                  fonts.push(...rawAssets.fonts);
                }
                videos.push(...rawAssets.videos);
              } catch {
              }
            }
          }
        };
        page.on("response", handlePageResponse);
        page.on("pageerror", (pageErr) => {
          console.warn("Page JS error during extraction:", pageErr?.message || pageErr || "unknown");
        });
        const pageLoadTimeout = extractionProfile.pageLoadTimeoutMs;
        const pageWaitUntil = "domcontentloaded";
        const navigated = await page.goto(targetUrl, { waitUntil: pageWaitUntil, timeout: pageLoadTimeout }).catch((e) => {
          console.log("Goto timeout, continuing...", e?.message || e);
          return null;
        });
        if (!navigated) {
          const currentPageUrl = String(page.url?.() || "");
          if (!currentPageUrl || currentPageUrl === "about:blank") {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: Math.min(pageLoadTimeout, 12e3) }).catch(() => void 0);
          }
          await waitForPageContentSettle(page, {
            minWaitMs: isFastCrawl ? 6e3 : 9e3,
            readinessTimeoutMs: isFastCrawl ? 3500 : 6e3
          });
        } else if (isFastCrawl) {
          await waitForPageContentSettle(page, { minWaitMs: 6e3, readinessTimeoutMs: 3500 });
        } else {
          await waitForPageContentSettle(page, { minWaitMs: 9e3, readinessTimeoutMs: 6e3 });
        }
        let initialHtml = await page.content().catch(() => "");
        const shouldWaitForChallengeOrLoader = pageHtmlLooksBlocked(initialHtml);
        if (shouldWaitForChallengeOrLoader) {
          extractionProfile = classifyWebsiteExtraction({
            url: targetUrl,
            html: initialHtml,
            crawlMode,
            captchaDetected: true,
            profileHint: ["normal", "heavy", "captcha"].includes(siteProfileBody) ? siteProfileBody : "auto"
          });
          activeExtractProgress?.setProfile(extractionProfile);
          activeExtractProgress?.setTask(extractionProfile.detail);
          await waitForChallengeOrLoaderSettle(page, {
            timeoutMs: extractionProfile.challengeWaitMs,
            minAssetWaitMs: Math.min(extractionProfile.challengeWaitMs, 9e3)
          });
          await waitForPageContentSettle(page, {
            minWaitMs: isFastCrawl ? 6e3 : 9e3,
            readinessTimeoutMs: isFastCrawl ? 3500 : 6e3
          });
          initialHtml = await page.content().catch(() => initialHtml);
        }
        if (pageHtmlLooksBlocked(initialHtml)) {
          throw new Error(
            "This website is protected by a captcha or browser verification gate. Please open the page in Chrome, complete the captcha, then run extraction again."
          );
        }
        activeExtractProgress?.setPhase("dom");
        activeExtractProgress?.setTask("Scanning page DOM and network assets");
        const scrollBudgetMs = isFastCrawl ? 12e3 : 45e3;
        const needsScroll = await pageNeedsLazyLoadScroll(page, initialHtml);
        if (needsScroll) {
          activeExtractProgress?.setPhase("scroll");
          activeExtractProgress?.setTask("Scrolling for lazy-loaded assets");
          await performLazyLoadScroll(page, {
            stepDelayMs: isFastCrawl ? 450 : 800,
            maxStableRounds: isFastCrawl ? 2 : 4,
            maxDurationMs: scrollBudgetMs
          });
          await page.evaluate(() => {
            const clickables = Array.from(
              document.querySelectorAll(
                '[class*="swiper-button-next"], [class*="carousel"] button, [aria-label*="next" i], [data-testid*="next" i], button.slick-next'
              )
            );
            clickables.slice(0, 12).forEach((el) => {
              try {
                el.click();
              } catch {
              }
            });
          }).catch(() => void 0);
          if (!isFastCrawl) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            await performLazyLoadScroll(page, { stepDelayMs: 700, maxStableRounds: 3, maxDurationMs: 3e4 });
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
                type: isPlatformVideoUrl(absoluteUrl) ? "video" : getAssetTypeFromUrl(absoluteUrl, "video"),
                title: entry.title || pageTitleFromUrl(absoluteUrl),
                thumbnail: entry.poster ? resolveUrl(targetUrl, entry.poster) || entry.poster : "",
                status: DEFAULT_ASSET_STATUS
              });
            });
          }
          if (Array.isArray(renderedDom?.fontFamilies)) {
            renderedDom.fontFamilies.forEach((family) => {
              if (!family) return;
              fonts.push({ family, url: "", format: "computed", status: DEFAULT_ASSET_STATUS });
            });
          }
          if (Array.isArray(renderedDom?.computedFonts)) {
            renderedComputedFonts = renderedDom.computedFonts.map((entry) => ({
              family: String(entry?.family || "").trim(),
              weight: String(entry?.weight || "").trim() || void 0,
              style: String(entry?.style || "").trim() || void 0
            })).filter((entry) => entry.family);
          }
          if (Array.isArray(renderedDom?.fontFaceCss)) {
            renderedDom.fontFaceCss.forEach((cssText) => {
              fonts.push(...extractFontsFromCss(String(cssText || ""), targetUrl));
            });
          }
          if (Array.isArray(renderedDom?.fontResourceUrls)) {
            renderedDom.fontResourceUrls.forEach((fontUrl) => {
              const url2 = String(fontUrl || "").trim();
              if (!url2) return;
              const format = getFontFormatFromUrlOrType(url2, "");
              if (!isSupportedFontFormat(format)) return;
              fonts.push({
                family: "",
                url: url2,
                format,
                source: /fonts\.gstatic\.com/i.test(url2) ? "Google Fonts network" : "Rendered font resource",
                status: DEFAULT_ASSET_STATUS
              });
            });
          }
          if (Array.isArray(renderedDom?.stylesheetUrls) && renderedDom.stylesheetUrls.length > 0) {
            const renderedStylesheetUrls = prioritizeFontCssCandidates(
              renderedDom.stylesheetUrls.filter((url2) => typeof url2 === "string" && /^https?:\/\//i.test(url2))
            ).slice(0, isFastCrawl ? 24 : 72);
            const renderedStylesheetResults = await mapWithConcurrency(renderedStylesheetUrls, 8, async (cssUrl) => {
              try {
                assertPublicAssetUrl(cssUrl);
                const response = await axios.get(cssUrl, {
                  timeout: isFastCrawl ? 3500 : 6e3,
                  httpsAgent: relaxedHttpsAgent,
                  validateStatus: (status) => status === 200,
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    Referer: targetUrl
                  }
                });
                return extractFontsFromCss(String(response.data || ""), cssUrl);
              } catch {
                return [];
              }
            });
            renderedStylesheetResults.forEach((stylesheetFonts) => fonts.push(...stylesheetFonts));
          }
        } catch {
        }
        {
          let prevCount = images.length;
          const shouldRunExtraPasses = !isFastCrawl || images.length < 12 || Date.now() - lastNewAssetAt < 2500 && images.length < 40;
          const maxPasses = isFastCrawl ? 1 : 3;
          for (let pass = 0; shouldRunExtraPasses && pass < maxPasses; pass++) {
            try {
              await performLazyLoadScroll(page, {
                stepDelayMs: isFastCrawl ? 350 : 500,
                maxStableRounds: 2,
                maxDurationMs: isFastCrawl ? 7e3 : 15e3
              });
            } catch (scrollErr) {
              console.warn(`Multi-pass scroll round ${pass + 1} failed:`, scrollErr?.message || scrollErr);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 800));
            const moreDom = await extractRenderedDomAssetsFromPage(page).catch(() => null);
            if (Array.isArray(moreDom?.images)) {
              moreDom.images.forEach((imageUrl) => {
                const asset = createImageAsset(imageUrl, targetUrl, {}, { permissive: true });
                pushImageAsset(images, asset);
              });
            }
            const newCount = images.length;
            if (newCount === prevCount) break;
            prevCount = newCount;
          }
        }
        if (!videosOnly) {
          try {
            await page.evaluate(async () => {
              const ready = document.fonts?.ready;
              if (!ready) return;
              await Promise.race([
                ready,
                new Promise((resolve) => window.setTimeout(resolve, 3e3))
              ]);
            }).catch(() => void 0);
            await new Promise((resolve) => setTimeout(resolve, isFastCrawl ? 900 : 1500));
            const finalFontDom = await extractRenderedDomAssetsFromPage(page).catch(() => null);
            if (finalFontDom) {
              if (Array.isArray(finalFontDom.fontFamilies)) {
                finalFontDom.fontFamilies.forEach((family) => {
                  const cleanFamily = String(family || "").trim();
                  if (!cleanFamily) return;
                  fonts.push({
                    family: cleanFamily,
                    url: "",
                    format: "computed",
                    source: "Final FontFaceSet scan",
                    status: DEFAULT_ASSET_STATUS
                  });
                });
              }
              if (Array.isArray(finalFontDom.computedFonts)) {
                const mergedComputedFonts = /* @__PURE__ */ new Map();
                [...renderedComputedFonts, ...finalFontDom.computedFonts].forEach((entry) => {
                  const family = String(entry?.family || "").trim();
                  if (!family) return;
                  const weight = String(entry?.weight || "").trim() || void 0;
                  const style = String(entry?.style || "").trim() || void 0;
                  const key = `${normalizeFontFamilyToken(family)}|${weight || ""}|${style || ""}`;
                  if (!mergedComputedFonts.has(key)) mergedComputedFonts.set(key, { family, weight, style });
                });
                renderedComputedFonts = Array.from(mergedComputedFonts.values()).slice(0, 192);
              }
              if (Array.isArray(finalFontDom.fontFaceCss)) {
                finalFontDom.fontFaceCss.forEach((cssText) => {
                  fonts.push(...extractFontsFromCss(String(cssText || ""), targetUrl));
                });
              }
              if (Array.isArray(finalFontDom.fontResourceUrls)) {
                finalFontDom.fontResourceUrls.forEach((fontUrl) => {
                  const url2 = String(fontUrl || "").trim();
                  if (!url2) return;
                  const format = getFontFormatFromUrlOrType(url2, "");
                  if (!isSupportedFontFormat(format)) return;
                  fonts.push({
                    family: "",
                    url: url2,
                    format,
                    source: /fonts\.gstatic\.com/i.test(url2) ? "Google Fonts final resource scan" : "Final rendered font resource",
                    status: DEFAULT_ASSET_STATUS
                  });
                });
              }
              if (Array.isArray(finalFontDom.stylesheetUrls) && finalFontDom.stylesheetUrls.length > 0) {
                const finalStylesheetUrls = prioritizeFontCssCandidates(
                  finalFontDom.stylesheetUrls.map((url2) => String(url2 || "").trim()).filter((url2) => /^https?:\/\//i.test(url2))
                ).slice(0, isFastCrawl ? 18 : 48);
                const finalStylesheetFonts = await mapWithConcurrency(finalStylesheetUrls, 6, async (cssUrl) => {
                  try {
                    assertPublicAssetUrl(cssUrl);
                    const response = await axios.get(cssUrl, {
                      timeout: isFastCrawl ? 3e3 : 5e3,
                      httpsAgent: relaxedHttpsAgent,
                      validateStatus: (status) => status === 200,
                      headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        Referer: targetUrl
                      }
                    });
                    return extractFontsFromCss(String(response.data || ""), cssUrl);
                  } catch {
                    return [];
                  }
                });
                finalStylesheetFonts.forEach((stylesheetFonts) => fonts.push(...stylesheetFonts));
              }
            }
          } catch (fontSettleError) {
            console.warn("Final rendered font scan failed:", fontSettleError?.message || fontSettleError);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], a, .play, .play-button, [class*="play"], [aria-label*="play" i], [title*="play" i]'
          ));
          candidates.slice(0, 12).forEach((el) => {
            const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.className || ""} ${el.textContent || ""}`;
            const rect = el.getBoundingClientRect();
            if (/play|watch|video/i.test(label) && rect.width > 10 && rect.height > 10) {
              try {
                el.click();
              } catch {
              }
            }
          });
        }).catch(() => void 0);
        await new Promise((resolve) => setTimeout(resolve, 700));
        try {
          const domVimeoUrls = await page.evaluate(() => {
            const urls = /* @__PURE__ */ new Set();
            var _ = {
              addId(id) {
                const clean = String(id || "").trim();
                if (/^\d{6,}$/.test(clean)) urls.add(`https://vimeo.com/${clean}`);
              },
              scanText(value) {
                const text = String(value || "").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
                const re = /(?:https?:)?\/\/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/)?(\d+)/gi;
                let match;
                while ((match = re.exec(text)) !== null) _.addId(match[1]);
                const idRegex = /(?:vimeo(?:Video)?Id|vimeo_id|vimeoId|clip_id|clipId)["']?\s*[:=]\s*["']?(\d{6,})/gi;
                while ((match = idRegex.exec(text)) !== null) _.addId(match[1]);
              }
            };
            Array.from(document.querySelectorAll("script")).map((script) => script.textContent || "").filter(Boolean).slice(0, 120).forEach((s) => _.scanText(s));
            const attrNames = ["data-vimeo-id", "data-vimeoid", "data-video-id", "data-clip-id", "data-vimeo-video-id"];
            Array.from(document.querySelectorAll("[data-vimeo-id],[data-vimeoid],[data-video-id],[data-clip-id],[data-vimeo-video-id]")).slice(0, 120).forEach((node) => {
              for (const attr of attrNames) {
                const val = node.getAttribute(attr);
                if (val) _.addId(val);
              }
            });
            Array.from(document.querySelectorAll('video[src^="blob:"]')).slice(0, 40).forEach((video) => {
              const src = String(video.getAttribute("src") || "");
              if (!/blob:https?:\/\/player\.vimeo\.com/i.test(src)) return;
              const wrapper = video.closest("div, section, article");
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
        }
        try {
          const domPlayerCandidates = await page.evaluate(() => {
            const players = [];
            const seen = /* @__PURE__ */ new Set();
            var _ = {
              addBrightcove(accountId, playerId, videoId, title = "", poster = "") {
                const account = String(accountId || "").trim();
                const video = String(videoId || "").trim();
                if (!account || !video) return;
                const player = String(playerId || "default").trim() || "default";
                const normalizedPlayer = player.endsWith("_default") ? player : `${player}_default`;
                const url2 = `https://players.brightcove.net/${account}/${normalizedPlayer}/index.html?videoId=${video}`;
                if (seen.has(url2)) return;
                seen.add(url2);
                players.push({ url: url2, title: title || "Brightcove video", poster, provider: "brightcove" });
              }
            };
            document.querySelectorAll("gb-video-brightcove, [data-account-id][data-video-id], [data-bc-video-id]").forEach((el) => {
              const node = el;
              _.addBrightcove(
                node.getAttribute("data-account-id") || node.getAttribute("account-id") || "",
                node.getAttribute("data-player-id") || node.getAttribute("player-id") || "default",
                node.getAttribute("data-video-id") || node.getAttribute("data-bc-video-id") || node.getAttribute("video-id") || "",
                node.getAttribute("aria-label") || node.getAttribute("title") || "",
                node.querySelector("img")?.getAttribute("src") || node.getAttribute("poster") || ""
              );
            });
            const scriptText = Array.from(document.querySelectorAll("script")).map((s) => s.textContent || "").join("\n");
            const normalizedScript = scriptText.replace(/\\\//g, "/").replace(/\\"/g, '"');
            const bcRegex = /data-account-id=["'](\d+)["'][\s\S]{0,400}?data-video-id=["'](\d+)["']/gi;
            let bcMatch;
            while ((bcMatch = bcRegex.exec(normalizedScript)) !== null) {
              _.addBrightcove(bcMatch[1], "default", bcMatch[2]);
            }
            const bcJsonRegex = /"accountId"\s*:\s*"(\d+)"[\s\S]{0,300}?"(?:videoId|id)"\s*:\s*"(\d+)"/gi;
            while ((bcMatch = bcJsonRegex.exec(normalizedScript)) !== null) {
              _.addBrightcove(bcMatch[1], "default", bcMatch[2]);
            }
            const jwRegex = /(?:jwplayer|playlist)\s*\([\s\S]{0,800}?(https?:\/\/[^"'\\]+\.(?:mp4|m3u8)[^"'\\]*)/gi;
            let jwMatch;
            while ((jwMatch = jwRegex.exec(normalizedScript)) !== null) {
              const url2 = jwMatch[1];
              if (!url2 || seen.has(url2)) continue;
              seen.add(url2);
              players.push({ url: url2, title: "JW Player video", poster: "", provider: "jwplayer" });
            }
            const kalturaRegex = /"entryId"\s*:\s*"([^"]+)"/gi;
            let kMatch;
            while ((kMatch = kalturaRegex.exec(normalizedScript)) !== null) {
              const entryId = String(kMatch[1] || "").trim();
              if (!entryId) continue;
              const url2 = `https://cdnapi.kaltura.com/p/0/sp/0/playManifest/entryId/${entryId}/format/applehttp/protocol/https/a.m3u8`;
              if (seen.has(url2)) continue;
              seen.add(url2);
              players.push({ url: url2, title: "Kaltura video", poster: "", provider: "kaltura" });
            }
            document.querySelectorAll("video[src], video source[src]").forEach((el) => {
              const src = el.getAttribute("src") || "";
              if (!src || src.startsWith("blob:") || seen.has(src)) return;
              if (!/\.(mp4|webm|m3u8|mpd)(\?|$)/i.test(src)) return;
              seen.add(src);
              players.push({ url: src, title: "Embedded video", poster: "", provider: "direct" });
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
                type: "video",
                title: candidate.title || "Video",
                thumbnail: candidate.poster || resolvedPagePrimaryThumb
              });
            });
          }
        } catch {
        }
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
    `);
        colors = domColors;
        const html = await waitForRenderedSiteHtml(page);
        const $ = cheerio.load(html);
        const pagePrimaryThumb = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
        const resolvedPagePrimaryThumb = pagePrimaryThumb ? resolveUrl(targetUrl, pagePrimaryThumb) || pagePrimaryThumb : "";
        const pageTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").first().text().trim() || "Video link";
        extractVimeoUrlsFromText(html, targetUrl).forEach((vimeoUrl) => vimeoCandidateUrls.add(vimeoUrl));
        extractWistiaIdsFromText(`${targetUrl}
${html}`, targetUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));
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
        const ustudioVideos = await withTimeout(
          extractUstudioVideos(extractUstudioEmbedUrlsFromText(html, targetUrl)),
          12e3,
          `Browser Ustudio extraction for ${targetUrl}`
        ).catch((error) => {
          console.warn("Browser Ustudio extraction failed:", error?.message || error);
          return [];
        });
        videos.push(...ustudioVideos);
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
        const addVideoCandidate = (urlStr, poster, title) => {
          if (!urlStr) return;
          const absoluteUrl = sanitizeStreamUrl(urlStr, targetUrl);
          if (!absoluteUrl || absoluteUrl.startsWith("data:")) return;
          if (!isLikelyVideoAssetUrl(absoluteUrl) && !isPlatformVideoUrl(absoluteUrl)) return;
          videos.push({
            url: absoluteUrl,
            sourceUrl: targetUrl,
            provider: platformProviderFromUrl(absoluteUrl),
            type: isPlatformVideoUrl(absoluteUrl) ? "video" : getAssetTypeFromUrl(absoluteUrl, "video"),
            title: title || pageTitle,
            thumbnail: poster ? resolveUrl(targetUrl, poster) || poster : resolvedPagePrimaryThumb,
            status: DEFAULT_ASSET_STATUS
          });
        };
        $("video source").each((_, el) => {
          const src = $(el).attr("src");
          addVideoCandidate(src);
        });
        $("video").each((_, el) => {
          const src = $(el).attr("src");
          const poster = $(el).attr("poster");
          addVideoCandidate(src, poster);
          $(el).find("source").each((__, sourceEl) => {
            addVideoCandidate($(sourceEl).attr("src"), poster);
          });
        });
        $("[data-src], [data-video], [data-video-src], [data-video-url], [data-mp4], [data-hls], [data-stream], [data-url]").each((_, el) => {
          const poster = $(el).attr("data-poster") || $(el).attr("poster");
          const title = $(el).attr("aria-label") || $(el).attr("title") || void 0;
          const candidates = [
            $(el).attr("data-src"),
            $(el).attr("data-video"),
            $(el).attr("data-video-src"),
            $(el).attr("data-video-url"),
            $(el).attr("data-mp4"),
            $(el).attr("data-hls"),
            $(el).attr("data-stream"),
            $(el).attr("data-url")
          ];
          candidates.forEach((candidate) => addVideoCandidate(candidate, poster, title));
        });
        const htmlVideoUrlRegex = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#\s"'<>\\])(?:[?#][^\s"'<>\\]*)?/gi;
        const relativeVideoUrlRegex = /(?:["'`])(\/[^"'`<>\\]+?\.(?:mp4|webm|mov|mkv|m3u8|mpd)(?=$|[?#"'`<>\\])(?:[?#][^"'`<>\\]*)?)(?:["'`])/gi;
        const rawMatches = html.match(htmlVideoUrlRegex) || [];
        rawMatches.forEach((match) => addVideoCandidate(match));
        extractYouTubeUrlsFromText(html, targetUrl).forEach((youtubeUrl) => addVideoCandidate(youtubeUrl));
        extractBrightcoveVideosFromHtml(html, targetUrl).forEach((brightcoveVideo) => {
          videos.push({
            ...brightcoveVideo,
            thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb
          });
        });
        let relMatch;
        while ((relMatch = relativeVideoUrlRegex.exec(html)) !== null) {
          addVideoCandidate(relMatch[1]);
        }
        try {
          const deepVideoCandidates = await withTimeout(
            discoverSiteVideoCandidates(targetUrl, html),
            6e3,
            `Deep video crawl for ${targetUrl}`
          );
          deepVideoCandidates.vimeoUrls.forEach((vimeoUrl) => vimeoCandidateUrls.add(vimeoUrl));
          (deepVideoCandidates.wistiaIds || []).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));
          deepVideoCandidates.videoUrls.forEach((videoUrl) => addVideoCandidate(videoUrl));
          (deepVideoCandidates.brightcoveVideos || []).forEach((brightcoveVideo) => {
            videos.push({
              ...brightcoveVideo,
              thumbnail: brightcoveVideo.thumbnail || resolvedPagePrimaryThumb
            });
          });
        } catch (error) {
          console.warn("Deep video crawl failed:", error?.message || error);
        }
        $("iframe, embed, object").each((_, el) => {
          const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data") || "";
          const absoluteUrl = resolveUrl(targetUrl, src);
          if (absoluteUrl && !absoluteUrl.startsWith("data:")) {
            embeddedPageUrls.add(absoluteUrl);
          }
          if (absoluteUrl && isVimeoUrl(absoluteUrl)) {
            const vimeoUrl = normalizeVimeoUrl(absoluteUrl);
            if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
          }
          if (absoluteUrl && isYouTubeUrl(absoluteUrl) && isPlatformVideoUrl(absoluteUrl)) {
            addVideoCandidate(normalizeYouTubeWatchUrl(absoluteUrl), void 0, $(el).attr("title") || $(el).attr("aria-label") || void 0);
          } else if (absoluteUrl && isPlatformVideoUrl(absoluteUrl)) {
            addVideoCandidate(absoluteUrl, void 0, $(el).attr("title") || $(el).attr("aria-label") || void 0);
          }
        });
        $("a[href], [data-href], [data-url], [data-video-url]").each((_, el) => {
          const possibleUrls = [
            $(el).attr("href"),
            $(el).attr("data-href"),
            $(el).attr("data-url"),
            $(el).attr("data-video-url")
          ];
          possibleUrls.forEach((possibleUrl) => {
            if (!possibleUrl) return;
            const absoluteUrl = resolveUrl(targetUrl, possibleUrl);
            if (absoluteUrl && isVimeoUrl(absoluteUrl)) {
              const vimeoUrl = normalizeVimeoUrl(absoluteUrl);
              if (vimeoUrl) vimeoCandidateUrls.add(vimeoUrl);
            }
            if (absoluteUrl && isYouTubeUrl(absoluteUrl) && isPlatformVideoUrl(absoluteUrl)) {
              addVideoCandidate(normalizeYouTubeWatchUrl(absoluteUrl), $(el).find("img").attr("src"), $(el).attr("title") || $(el).text().trim());
            } else if (absoluteUrl && isPlatformVideoUrl(absoluteUrl)) {
              addVideoCandidate(absoluteUrl, $(el).find("img").attr("src"), $(el).attr("title") || $(el).text().trim());
            }
          });
        });
        await mapWithConcurrency(Array.from(embeddedPageUrls).slice(0, 2), 2, async (embeddedUrl) => {
          let embeddedPage;
          try {
            embeddedPage = await acquireSingleWebsitePage(browser);
            await applyProxyAuthToPage(embeddedPage);
            embeddedPage.on("response", handlePageResponse);
            await embeddedPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            await embeddedPage.setRequestInterception(true);
            embeddedPage.on("request", async (request) => {
              if (request.isInterceptResolutionHandled()) return;
              const resourceType = request.resourceType();
              if (["image", "font", "stylesheet"].includes(resourceType)) {
                await request.abort().catch(() => void 0);
              } else {
                await request.continue().catch(() => void 0);
              }
            });
            await embeddedPage.goto(embeddedUrl, { waitUntil: "domcontentloaded", timeout: 3500 }).catch(() => void 0);
            await new Promise((resolve) => setTimeout(resolve, 500));
            const embeddedHtml = await embeddedPage.content();
            extractVimeoUrlsFromText(embeddedHtml, embeddedUrl).forEach((vimeoUrl) => vimeoCandidateUrls.add(vimeoUrl));
            extractWistiaIdsFromText(embeddedHtml, embeddedUrl).forEach((wistiaId) => wistiaCandidateIds.add(wistiaId));
          } catch (error) {
            console.warn(`Embedded page could not be crawled: ${embeddedUrl}`, error.message || error);
          } finally {
            await embeddedPage?.close().catch(() => void 0);
          }
        });
        if (!videosOnly) {
          $("style").each((_, el) => {
            const cssText = $(el).html();
            if (cssText) {
              fonts = fonts.concat(extractFontsFromCss(cssText, targetUrl));
            }
          });
          const cssLinks = [];
          $('link[rel="stylesheet"]').each((_, el) => {
            const href = $(el).attr("href");
            if (href) {
              const absoluteUrl = resolveUrl(targetUrl, href);
              if (absoluteUrl) {
                try {
                  assertPublicAssetUrl(absoluteUrl);
                  cssLinks.push(absoluteUrl);
                } catch {
                }
              }
            }
          });
          $('link[rel="preload"][as="font"], link[as="font"], link[href*=".woff"], link[href*=".woff2"], link[href*=".ttf"], link[href*=".otf"], link[href*=".eot"]').each((_, el) => {
            const href = $(el).attr("href");
            const abs = href ? resolveUrl(targetUrl, href) : null;
            if (abs && !abs.startsWith("data:") && isSupportedFontAsset({ url: abs, format: getAssetTypeFromUrl(abs, "unknown") })) {
              fonts.push({
                family: "",
                url: abs,
                format: getAssetTypeFromUrl(abs, "unknown"),
                status: DEFAULT_ASSET_STATUS
              });
            }
          });
          $('script[src*="typekit.net"], script[src*="fonts.googleapis.com"], script[src*="fonts.gstatic.com"]').each((_, el) => {
            const src = $(el).attr("src");
            const abs = src ? resolveUrl(targetUrl, src) : null;
            if (abs) {
              try {
                assertPublicAssetUrl(abs);
                cssLinks.push(abs);
              } catch {
              }
            }
          });
          extractExternalFontCssUrls(html, targetUrl).forEach((fontCssUrl) => {
            try {
              assertPublicAssetUrl(fontCssUrl);
              cssLinks.push(fontCssUrl);
            } catch {
            }
          });
          activeExtractProgress?.setPhase("fonts-colors");
          activeExtractProgress?.setTask("Extracting fonts and colors from stylesheets");
          const cssQueue = prioritizeFontCssCandidates(Array.from(new Set(cssLinks))).slice(0, isFastCrawl ? 12 : 48);
          const visitedCss = /* @__PURE__ */ new Set();
          const discoveredFonts = [];
          const discoveredImages = [];
          let hops = 0;
          const cssMaxHops = isFastCrawl ? 32 : 72;
          const cssMaxMs = isFastCrawl ? 12e3 : 24e3;
          const cssStartedAt = Date.now();
          while (cssQueue.length > 0 && hops < cssMaxHops && Date.now() - cssStartedAt < cssMaxMs) {
            const batch = cssQueue.splice(0, 6).filter((url2) => !visitedCss.has(url2));
            if (batch.length === 0) break;
            hops += batch.length;
            batch.forEach((url2) => visitedCss.add(url2));
            const cssResults = await Promise.allSettled(batch.map(async (cssUrl) => {
              try {
                assertPublicAssetUrl(cssUrl);
                const cssTimeout = isFastCrawl ? 2500 : 3500;
                const cssResponse = await axios.get(cssUrl, {
                  timeout: cssTimeout,
                  httpsAgent: relaxedHttpsAgent,
                  validateStatus: (status) => status === 200,
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
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
                    }
                  });
                  return {
                    fonts: extractFontsFromCss(cssResponse.data, cssUrl),
                    images: extractImagesFromCss(cssResponse.data, cssUrl),
                    rawAssets: extractAssetsFromRawText(String(cssResponse.data || ""), cssUrl)
                  };
                }
              } catch (e) {
                if (e.response && e.response.status >= 400 && e.response.status < 500) {
                  console.warn(`CSS file could not be fetched (${e.response.status}): ${cssUrl}`);
                } else {
                  console.error(`Failed to fetch CSS: ${cssUrl}`, e.message || e);
                }
              }
              return { fonts: [], images: [], rawAssets: { images: [], videos: [], fonts: [] } };
            }));
            cssResults.forEach((result) => {
              if (result.status === "fulfilled") {
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
        const realImageCount = images.filter((img) => !isBotWallImageUrl(String(img?.url || ""))).length;
        if (!videosOnly && realImageCount < 5 && images.some((img) => isBotWallImageUrl(String(img?.url || "")))) {
          console.warn("Bot-wall detected during extract, reloading page:", targetUrl);
          await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 4e4 }).catch(() => void 0);
          await new Promise((resolve) => setTimeout(resolve, 5e3));
          const reloadHtml = await page.content().catch(() => "");
          if (reloadHtml && !pageHtmlLooksBlocked(reloadHtml)) {
            await enrichAssetsFromHtml(reloadHtml, targetUrl, {
              images,
              videos,
              fonts,
              colors,
              vimeoCandidateUrls,
              wistiaCandidateIds
            }, { videosOnly });
          }
        }
        await page.close().catch(() => void 0);
        await closePuppeteerBrowser(browser);
        browser = null;
        if (vimeoCandidateUrls.size > 0) {
          try {
            const vimeoAssets = await withTimeout(
              extractVimeoVideos(Array.from(vimeoCandidateUrls), "fhd", targetUrl),
              isFastCrawl ? 8e3 : VIMEO_EXTRACT_TIMEOUT_MS,
              `Browser Vimeo extraction for ${targetUrl}`
            );
            videos.push(...vimeoAssets.videos || []);
            images.push(...vimeoAssets.images || []);
          } catch (error) {
            console.warn("Vimeo direct extraction failed:", error?.message || error);
          }
        }
        if (wistiaCandidateIds.size > 0) {
          try {
            const wistiaAssets = await withTimeout(
              extractWistiaVideos(Array.from(wistiaCandidateIds), "fhd"),
              8e3,
              `Browser Wistia extraction for ${targetUrl}`
            );
            videos.push(...wistiaAssets.videos || []);
            images.push(...wistiaAssets.images || []);
          } catch (error) {
            console.warn("Wistia direct extraction failed, using source placeholders only:", error?.message || error);
            videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
          }
        }
        const resolvedVideos = await resolveBrightcoveCandidateVideos(videos, `Browser Brightcove extraction for ${targetUrl}`);
        if ((isInstagramUrl(targetUrl) || isFacebookUrl(targetUrl) || isXUrl(targetUrl)) && resolvedVideos.length === 0) {
          videos.push({
            url: targetUrl,
            sourceUrl: targetUrl,
            provider: platformProviderFromUrl(targetUrl),
            type: "video",
            title: pageTitle,
            thumbnail: resolvedPagePrimaryThumb
          });
        }
        let mergedVideos = resolvedVideos;
        if (mergedVideos.length === 0 && html) {
          mergedVideos = buildWebsiteVideoPlayersFromHtml(html, targetUrl);
        }
        activeExtractProgress?.setPhase("finalizing");
        activeExtractProgress?.setTask("Deduplicating and finalizing extracted assets");
        activeExtractProgress?.updateCounters({
          images: images.length,
          videos: videos.length,
          fonts: fonts.length,
          colors: colors.length
        });
        fonts = applyBrowserFontFamilyEvidence(fonts, renderedComputedFonts);
        let extractedAssets = await dedupeExtractedAssets(images, mergedVideos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, {
          // Deep scans must resolve variable font metadata before deduplication;
          // otherwise every weight/style instance sharing a WOFF2 URL is reduced
          // to a single card.
          fast: isFastCrawl,
          videosOnly
        });
        extractedAssets = await recoverExtractWhenEmpty(targetUrl, extractedAssets);
        return extractedAssets;
      })(),
      browserBudgetMs,
      `Browser extract for ${targetUrl}`
    );
    browserExtractPromise.then(async (bx) => {
      try {
        const quickExtracted = await quickExtractPromise;
        if (quickExtracted) {
          const seenUrls = new Set((bx?.images || []).map((i) => i.url).filter(Boolean));
          for (const img of quickExtracted.images || []) {
            if (img.url && !seenUrls.has(img.url)) {
              bx.images.push(img);
              seenUrls.add(img.url);
            }
          }
          const seenVideoUrls = new Set((bx?.videos || []).map((v) => v.url).filter(Boolean));
          for (const vid of quickExtracted.videos || []) {
            if (vid.url && !seenVideoUrls.has(vid.url)) {
              bx.videos.push(vid);
              seenVideoUrls.add(vid.url);
            }
          }
          const seenFontUrls = new Set((bx?.fonts || []).map((f) => f.url).filter(Boolean));
          for (const fnt of quickExtracted.fonts || []) {
            if (fnt.url && !seenFontUrls.has(fnt.url)) {
              bx.fonts.push(fnt);
              seenFontUrls.add(fnt.url);
            }
          }
          const existingColors = new Set(bx?.colors || []);
          for (const col of quickExtracted.colors || []) {
            if (!existingColors.has(col)) {
              bx.colors.push(col);
              existingColors.add(col);
            }
          }
        }
        progressMgr?.complete(bx);
      } catch (mergeError) {
        console.error("Browser extraction merge/broadcast error:", mergeError?.message || mergeError);
        progressMgr?.fail(mergeError?.message || "Merge failed");
      }
    }).catch(async (error) => {
      console.error("Background browser extraction error:", error?.message || error);
      let quickExtracted = await quickExtractPromise.catch(() => null);
      if (videosOnly && !(quickExtracted?.videos?.length > 0)) {
        quickExtracted = await withTimeout(
          extractQuickAssets(targetUrl, { videosOnly: true }),
          3e4,
          `Video fallback extraction for ${targetUrl}`
        ).catch(() => quickExtracted);
      }
      if (images.length || videos.length || fonts.length || colors.length) {
        try {
          const partialAssets = await dedupeExtractedAssets(
            [...images, ...quickExtracted?.images || []],
            [...videos, ...quickExtracted?.videos || []],
            [...fonts, ...quickExtracted?.fonts || []],
            [...colors, ...quickExtracted?.colors || []],
            targetUrl,
            "",
            {
              fast: true,
              videosOnly
            }
          );
          progressMgr?.complete(partialAssets);
          return;
        } catch (partialError) {
          console.error("Partial browser extraction finalization failed:", partialError?.message || partialError);
        }
      }
      if (quickExtracted?.images?.length || 0 || (quickExtracted?.videos?.length || 0) || (quickExtracted?.fonts?.length || 0)) {
        progressMgr?.complete(quickExtracted);
        return;
      }
      progressMgr?.fail(error?.message || "Browser extraction failed");
    }).finally(async () => {
      await closePuppeteerBrowser(browser).catch(() => void 0);
      if (activeExtractProgress === progressMgr) {
        activeExtractProgress = null;
        setGlobalProgressManager(null);
      }
      if (extractKey) {
        setTimeout(() => ExtractionProgressManager.remove(extractKey), 6e4).unref?.();
      }
    });
    return res.json({ async: true, extractId: extractKey, extractionProfile });
  } catch (error) {
    progressMgr?.fail(String(error?.message || "Extraction failed"));
    console.error("Extraction error:", error.message);
    if (/proxy url|proxy protocol/i.test(String(error?.message || ""))) {
      return res.status(400).json({ error: error.message });
    }
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ""))) {
      return res.status(403).json({ error: error.message });
    }
    try {
      const targetUrl = new URL2(String(req.body?.url || "")).href;
      assertPublicAssetUrl(targetUrl);
      const quickAssets = await (quickExtractPromise || extractQuickAssets(targetUrl)).catch(() => ({
        images: [],
        videos: [],
        fonts: [],
        colors: []
      }));
      if (quickAssets.images.length || quickAssets.videos.length || quickAssets.fonts.length) {
        return res.json(quickAssets);
      }
      const prefetchedHtml = await fetchSiteHtml(targetUrl).catch(() => "");
      const staticAssets = await extractStaticAssets(targetUrl, prefetchedHtml, { fast: true });
      return res.json(staticAssets);
    } catch (fallbackError) {
      console.warn("Static extraction fallback failed:", fallbackError?.message || fallbackError);
      try {
        const targetUrl = new URL2(String(req.body?.url || "")).href;
        assertPublicAssetUrl(targetUrl);
        const sourceOnlyAssets = extractAssetsFromRawText(targetUrl, targetUrl);
        const extracted = await dedupeExtractedAssets(
          sourceOnlyAssets.images,
          sourceOnlyAssets.videos,
          sourceOnlyAssets.fonts,
          [],
          targetUrl,
          "",
          { fast: true }
        );
        if (extracted.images.length || extracted.videos.length || extracted.fonts.length) {
          return res.json(extracted);
        }
      } catch (sourceFallbackError) {
        console.warn("Source-only extraction fallback failed:", sourceFallbackError?.message || sourceFallbackError);
      }
    }
    return res.json({
      images: [],
      videos: [],
      fonts: [],
      colors: []
    });
  } finally {
    await closePuppeteerBrowser(browser).catch(() => void 0);
  }
});
var registerVideoExtractorRoute = (route, handler) => {
  app.post(route, async (req, res) => {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "URL is required" });
    try {
      const targetUrl = new URL2(url).href;
      assertPublicAssetUrl(targetUrl);
      const result = await handler(targetUrl);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error?.message || "Video extraction failed." });
    }
  });
};
registerVideoExtractorRoute("/api/video-extract/universal", universalVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/youtube", youtubeVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/vimeo", vimeoVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/instagram", instagramVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/facebook", facebookVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/x", xVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/ispot", ispotVideoExtractor);
registerVideoExtractorRoute("/api/video-extract/brightcove", buildDirectVideoExtractResponse);
app.post("/api/video-extract/bulk", async (req, res) => {
  const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls = rawUrls.map((value) => String(value || "").trim()).filter(Boolean);
  if (urls.length === 0) return res.status(400).json({ error: "At least one URL is required" });
  const results = await Promise.all(
    urls.map(async (entryUrl) => {
      try {
        const targetUrl = new URL2(entryUrl).href;
        assertPublicAssetUrl(targetUrl);
        const payload = await universalVideoExtractor(targetUrl);
        const videos2 = Array.isArray(payload?.videos) ? payload.videos : [];
        return { url: entryUrl, ok: true, videos: videos2, platform: payload?.extractionMeta?.platform || platformProviderFromUrl(entryUrl) };
      } catch (error) {
        return { url: entryUrl, ok: false, error: error?.message || "Extraction failed", videos: [] };
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
        mode: quality === "audio" ? "audio" : "video"
      });
    }
    const payload = await ispotVideoExtractor(url);
    const card = Array.isArray(payload?.videos) ? payload.videos[0] : null;
    const refreshedUrl = String(card?.sourceStreamUrl || card?.url || url);
    return downloadPlatformVideoToFile(refreshedUrl, quality === "audio" ? "fhd" : quality, {
      titleHint: title,
      sourcePageUrl: sourcePageUrl || url,
      saveToWebsiteAssets,
      mode: quality === "audio" ? "audio" : "video",
      maxDurationSeconds: quality === "audio" ? 120 : void 0
    });
  }
});
app.get("/api/video-downloads", async (_req, res) => {
  try {
    const items = await listVideoDownloadFiles();
    return res.json({ items, count: items.length });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to list video downloads." });
  }
});
app.post("/api/platform-video-download", async (req, res) => {
  const rawUrl = String(req.body?.url || "").trim();
  const quality = String(req.body?.quality || "fhd").toLowerCase();
  const titleHint = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const sourcePageUrl = typeof req.body?.sourcePageUrl === "string" ? req.body.sourcePageUrl.trim() : rawUrl;
  const mode = req.body?.mode === "audio" ? "audio" : "video";
  const saveToWebsiteAssets = req.body?.saveToWebsiteAssets === true;
  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: "URL is required" });
  }
  try {
    if (isUnsupportedVideoResourceUrl(rawUrl) || !isPlatformVideoUrl(rawUrl) && !isLikelyDirectVideoStreamUrl(rawUrl) && !isLikelyVideoAssetUrl(rawUrl)) {
      return res.status(400).json({ ok: false, error: "This URL is a player script/API resource, not a downloadable video." });
    }
    assertPublicAssetUrl(rawUrl);
    lastExtractedSourceUrl = sourcePageUrl || rawUrl;
    lastExtractionSectionMode = false;
    const result = isBrightcoveUrl(rawUrl) ? await downloadBrightcoveVideoToFile(rawUrl, quality, {
      title: titleHint,
      sourcePageUrl,
      mode,
      saveToWebsiteAssets
    }) : await downloadPlatformVideoToFile(rawUrl, quality, {
      titleHint,
      sourcePageUrl,
      mode,
      maxDurationSeconds: mode === "audio" ? 120 : void 0,
      saveToWebsiteAssets
    });
    return res.json(result);
  } catch (error) {
    console.error("Platform video download error:", error?.message || error);
    const message = String(error?.message || "Video download failed.");
    if (/\bVIDEO_NOT_FOUND\b/i.test(message)) {
      return res.status(404).json({
        ok: false,
        error: "Brightcove reports that this video does not exist or is no longer available."
      });
    }
    return res.status(500).json({ ok: false, error: message });
  }
});
app.post("/api/direct-video-download", async (req, res) => {
  const rawUrl = String(req.body?.url || "").trim();
  const quality = String(req.body?.quality || "fhd").toLowerCase();
  const titleHint = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const sourcePageUrl = typeof req.body?.sourcePageUrl === "string" ? req.body.sourcePageUrl.trim() : rawUrl;
  const saveToWebsiteAssets = req.body?.saveToWebsiteAssets === true;
  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: "URL is required" });
  }
  try {
    const result = await downloadDirectStreamVideoToFile(rawUrl, {
      titleHint,
      sourcePageUrl,
      quality,
      saveToWebsiteAssets
    });
    return res.json(result);
  } catch (error) {
    console.error("Direct video download error:", error?.message || error);
    return res.status(500).json({ ok: false, error: error?.message || "Direct video download failed." });
  }
});
app.get("/api/image-meta", async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const inlineBuffer = decodeDataImageBuffer(url);
    if (inlineBuffer) {
      const dims = probeRasterDimensions(inlineBuffer);
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: inlineBuffer.length
      });
    }
    const normalized = assertAssetUrlAllowed(url);
    const cached = await readAssetBufferFromCache(normalized, "image") || await readAssetBufferFromCache(String(req.query.originalUrl || ""), "image");
    if (cached?.buffer) {
      const dims = probeRasterDimensions(cached.buffer);
      const format = detectRasterFormatFromBuffer(cached.buffer) || detectImageFormatFromBuffer(cached.buffer) || inferImageTypeFromContentType(cached.contentType) || getAssetTypeFromUrl(normalized, "jpg");
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: cached.buffer.length,
        format
      });
    }
    const thumbMeta = await readImageThumbMeta(String(req.query.originalUrl || normalized));
    if (thumbMeta && (thumbMeta.width || thumbMeta.height)) {
      const remoteMeta = await withTimeout(
        fetch(normalized, {
          method: "HEAD",
          redirect: "follow",
          headers: browserLikeHeaders(normalized, readSourcePageUrl(req)),
          signal: AbortSignal.timeout(2200)
        }),
        2500,
        `image-meta head for ${normalized}`
      ).catch(() => null);
      const contentType = String(remoteMeta?.headers.get("content-type") || "");
      const bytes = Number(remoteMeta?.headers.get("content-length") || 0) || 0;
      const format = inferImageTypeFromContentType(contentType) || inferImageTypeFromUrl(normalized, contentType) || getAssetTypeFromUrl(normalized, "jpg");
      return res.json({
        width: thumbMeta.width || 0,
        height: thumbMeta.height || 0,
        bytes,
        format
      });
    }
    const originalUrl = String(req.query.originalUrl || normalized);
    const sourcePageUrl = readSourcePageUrl(req);
    await withTimeout(ensureImageThumbnail(originalUrl, sourcePageUrl), 3500, `image-meta warm for ${normalized}`).catch(
      () => null
    );
    const warmed = await readAssetBufferFromCache(normalized, "image") || (originalUrl !== normalized ? await readAssetBufferFromCache(originalUrl, "image") : null);
    if (warmed?.buffer) {
      const dims = probeRasterDimensions(warmed.buffer);
      const format = detectRasterFormatFromBuffer(warmed.buffer) || detectImageFormatFromBuffer(warmed.buffer) || inferImageTypeFromContentType(warmed.contentType) || getAssetTypeFromUrl(originalUrl, "jpg");
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: warmed.buffer.length,
        format
      });
    }
    return res.status(202).json({ width: 0, height: 0, bytes: 0, pending: true });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to read image metadata" });
  }
});
app.post("/api/image-meta-batch", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
  const sourcePageUrl = String(req.body?.sourcePageUrl || "").trim();
  const results = {};
  await mapWithConcurrency(items, 48, async (item) => {
    const originalUrl = String(item?.originalUrl || item?.url || "").trim();
    if (!originalUrl || originalUrl.startsWith("data:")) return;
    try {
      const normalized = assertAssetUrlAllowed(originalUrl);
      const cached = await readAssetBufferFromCache(normalized, "image");
      if (cached?.buffer) {
        const dims = probeRasterDimensions(cached.buffer);
        results[originalUrl] = {
          width: dims.width || 0,
          height: dims.height || 0,
          bytes: cached.buffer.length,
          format: detectRasterFormatFromBuffer(cached.buffer) || detectImageFormatFromBuffer(cached.buffer) || inferImageTypeFromContentType(cached.contentType) || getAssetTypeFromUrl(normalized, "jpg")
        };
        return;
      }
      const thumbMeta = await readImageThumbMeta(originalUrl);
      const head = thumbMeta ? await withTimeout(
        fetch(normalized, {
          method: "HEAD",
          redirect: "follow",
          headers: browserLikeHeaders(normalized, sourcePageUrl),
          signal: AbortSignal.timeout(800)
        }),
        1e3,
        `image-meta batch head for ${normalized}`
      ).catch(() => null) : null;
      const contentType = String(head?.headers.get("content-type") || "");
      results[originalUrl] = {
        width: thumbMeta?.width || 0,
        height: thumbMeta?.height || 0,
        bytes: Number(head?.headers.get("content-length") || 0) || 0,
        format: inferImageTypeFromContentType(contentType) || inferImageTypeFromUrl(normalized, contentType) || getAssetTypeFromUrl(normalized, "jpg")
      };
    } catch {
    }
  });
  return res.json({ ok: true, results });
});
var imageThumbHashFor = (originalUrl) => crypto2.createHash("sha1").update(String(originalUrl || "").trim()).digest("hex");
var imageThumbPathsFor = (originalUrl) => {
  const hash = imageThumbHashFor(originalUrl);
  return {
    hash,
    thumbPath: path3.join(generatedImageThumbDir, `${hash}.webp`),
    metaPath: path3.join(generatedImageThumbDir, `${hash}.meta.json`),
    publicThumbUrl: `/generated-image-thumbs/${hash}.webp`
  };
};
var readImageThumbMeta = async (originalUrl) => {
  const { thumbPath, metaPath, publicThumbUrl } = imageThumbPathsFor(originalUrl);
  const thumbStat = await fsp3.stat(thumbPath).catch(() => null);
  if (!thumbStat || thumbStat.size < 64) return null;
  let lqip = "";
  let width = 0;
  let height = 0;
  let bytes = 0;
  try {
    const raw = await fsp3.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    lqip = String(parsed?.lqip || "");
    width = Number(parsed?.width || 0);
    height = Number(parsed?.height || 0);
    bytes = Number(parsed?.bytes || 0);
  } catch {
  }
  return {
    thumbUrl: publicThumbUrl,
    lqip,
    width,
    height,
    bytes
  };
};
var buildImageThumbnail = async (originalUrl, sourcePageUrl = "") => {
  const normalized = String(originalUrl || "").trim();
  if (!normalized) throw new Error("Missing image URL");
  if (normalized.startsWith("data:")) {
    throw new Error("Data URLs use client-side preview");
  }
  const existing = await readImageThumbMeta(normalized);
  if (existing) return existing;
  await fsp3.mkdir(generatedImageThumbDir, { recursive: true });
  const { thumbPath, metaPath, publicThumbUrl } = imageThumbPathsFor(normalized);
  const cached = await readCachedImageBuffer(normalized) || null;
  let sourceBuffer = cached?.buffer || null;
  let contentType = cached?.contentType || "";
  if (!sourceBuffer) {
    const fetched = await withTimeout(
      fetchAssetBuffer(normalized, normalized, { refererPageUrl: sourcePageUrl, skipBrowser: true }),
      25e3,
      `Thumbnail source fetch for ${normalized}`
    ).catch(() => null);
    if (fetched && isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      sourceBuffer = fetched.buffer;
      contentType = fetched.contentType || "";
      void writeCachedOriginalImageFromBuffer(
        normalized,
        fetched.buffer,
        contentType,
        inferImageTypeFromUrl(normalized, "") || getAssetTypeFromUrl(normalized, "bin"),
        String(fetched.contentDisposition || "")
      ).catch(() => void 0);
    }
  }
  if (!sourceBuffer || !isValidImageBuffer(sourceBuffer, contentType)) {
    return { thumbUrl: "", lqip: "", width: 0, height: 0, bytes: 0 };
  }
  const thumbnailSource = detectImageFormatFromBuffer(sourceBuffer) === "svg" ? materializeSvgFragmentForIllustrator(sourceBuffer, normalized) : sourceBuffer;
  const artifacts = await generateImageThumbArtifacts(thumbnailSource);
  await fsp3.writeFile(thumbPath, artifacts.thumbBuffer);
  await fsp3.writeFile(
    metaPath,
    JSON.stringify({
      lqip: artifacts.lqip,
      width: artifacts.width,
      height: artifacts.height,
      bytes: sourceBuffer.length,
      originalUrl: normalized,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    })
  );
  return {
    thumbUrl: publicThumbUrl,
    lqip: artifacts.lqip,
    width: artifacts.width,
    height: artifacts.height,
    bytes: sourceBuffer.length
  };
};
var imageThumbnailInFlight = /* @__PURE__ */ new Map();
var ensureImageThumbnail = async (originalUrl, sourcePageUrl = "") => {
  const key = String(originalUrl || "").trim();
  const existing = imageThumbnailInFlight.get(key);
  if (existing) return existing;
  const task = buildImageThumbnail(key, sourcePageUrl).finally(() => {
    imageThumbnailInFlight.delete(key);
  });
  imageThumbnailInFlight.set(key, task);
  return task;
};
app.get("/api/image-thumb", async (req, res) => {
  const originalUrl = String(req.query?.originalUrl || req.query?.url || "").trim();
  const sourcePageUrl = readSourcePageUrl(req);
  const wantsMeta = String(req.query?.meta || "").trim() === "1";
  if (!originalUrl) {
    return res.status(400).json({ error: "originalUrl is required" });
  }
  if (originalUrl.startsWith("data:")) {
    return res.status(400).json({ error: "Data URLs are not supported for server thumbnails" });
  }
  try {
    assertAssetUrlAllowed(originalUrl);
    const meta = await ensureImageThumbnail(originalUrl, sourcePageUrl);
    if (!meta.thumbUrl) {
      if (wantsMeta) return res.json({ ok: false, error: "Thumbnail unavailable" });
      return res.status(204).end();
    }
    if (wantsMeta) {
      return res.json({
        ok: true,
        ...meta,
        thumbUrl: toAbsoluteAppUrl(req, meta.thumbUrl)
      });
    }
    const { thumbPath } = imageThumbPathsFor(originalUrl);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    return res.sendFile(thumbPath);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Thumbnail generation failed" });
  }
});
app.post("/api/warm-image-thumbs-batch", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const sourcePageUrl = String(req.body?.sourcePageUrl || "").trim();
  if (!items.length) {
    return res.json({ ok: true, results: {}, warmed: 0, total: 0 });
  }
  const results = {};
  await mapWithConcurrency(items.slice(0, 500), 6, async (item) => {
    const originalUrl = String(item?.originalUrl || item?.url || "").trim();
    if (!originalUrl || originalUrl.startsWith("data:")) return;
    try {
      assertAssetUrlAllowed(originalUrl);
      const meta = await ensureImageThumbnail(originalUrl, sourcePageUrl);
      const cached = await readAssetBufferFromCache(originalUrl, "image");
      const contentType = cached?.contentType || "";
      const bytes = cached?.buffer?.length || meta.bytes || 0;
      const format = (cached?.buffer ? detectRasterFormatFromBuffer(cached.buffer) || detectImageFormatFromBuffer(cached.buffer) : "") || inferImageTypeFromContentType(contentType) || inferImageTypeFromUrl(originalUrl, contentType) || getAssetTypeFromUrl(originalUrl, "jpg");
      results[originalUrl] = {
        ok: true,
        thumbUrl: meta.thumbUrl,
        lqip: meta.lqip,
        width: meta.width,
        height: meta.height,
        bytes,
        format
      };
    } catch (error) {
      results[originalUrl] = { ok: false, error: error?.message || "Thumbnail warm failed" };
    }
  });
  const warmed = Object.values(results).filter((entry) => entry.ok).length;
  return res.json({ ok: true, results, warmed, total: items.length });
});
app.get("/api/image-preview", async (req, res) => {
  const { url, originalUrl } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const sourcePageUrl = readSourcePageUrl(req);
    const normalized = assertAssetUrlAllowed(url);
    const origin = typeof originalUrl === "string" ? originalUrl.trim() : "";
    const ensured = await ensureImageCachedForDownload(normalized, origin || normalized, sourcePageUrl);
    const fetched = ensured.cached || await withTimeout(
      fetchAssetBuffer(ensured.requestUrl || normalized, origin || normalized, { refererPageUrl: sourcePageUrl }),
      12e3,
      `Preview fetch for ${normalized}`
    );
    if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      return res.status(502).json({ error: "Preview image could not be loaded" });
    }
    const format = detectRasterFormatFromBuffer(fetched.buffer) || detectImageFormatFromBuffer(fetched.buffer) || inferImageTypeFromContentType(fetched.contentType) || getAssetTypeFromUrl(normalized, "bin");
    const contentType = format === "jpg" || format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : format === "svg" ? "image/svg+xml" : format === "webp" ? "image/webp" : format === "avif" ? "image/avif" : format === "gif" ? "image/gif" : fetched.contentType || "application/octet-stream";
    const previewBuffer = format === "svg" ? materializeSvgFragmentForIllustrator(fetched.buffer, origin || normalized) : fetched.buffer;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    if (ensured.requestUrl?.startsWith("/cached-")) {
      res.setHeader("X-Cached-Image-Path", ensured.requestUrl);
    }
    return res.send(previewBuffer);
  } catch (error) {
    console.error("Image preview error:", error?.message || error);
    return res.status(500).json({ error: "Failed to load image preview" });
  }
});
app.get("/api/download-image", async (req, res) => {
  const { url, originalUrl, filenameBase, metadataFilename, save } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const sourcePageUrl = readSourcePageUrl(req);
    const normalized = assertAssetUrlAllowed(url);
    const origin = typeof originalUrl === "string" ? originalUrl.trim() : "";
    const convertOptions = {
      filenameBase: typeof filenameBase === "string" ? filenameBase : void 0,
      originalUrl: origin || void 0,
      metadataFilename: typeof metadataFilename === "string" ? metadataFilename : void 0
    };
    const ensured = await ensureImageCachedForDownload(normalized, origin || normalized, sourcePageUrl);
    let cached = ensured.cached;
    const resolvedRequestUrl = ensured.requestUrl || normalized;
    const cachePath = cached ? await getAssetCacheDebugPath(resolvedRequestUrl, "image") || await getAssetCacheDebugPath(normalized, "image") || (origin ? await getAssetCacheDebugPath(origin, "image") : "") : "";
    console.debug("[image-download:cache]", {
      url: origin || normalized,
      requestUrl: resolvedRequestUrl,
      mimeType: cached?.contentType || "",
      cachePath,
      cache: cached ? "hit" : "miss"
    });
    if (cached && cachePath && (String(save || "").toLowerCase() === "1" || String(save || "").toLowerCase() === "true")) {
      const sourceFormat2 = normalizeRasterFormat(
        detectImageFormatFromBuffer(cached.buffer) || inferImageTypeFromContentType(cached.contentType) || inferImageTypeFromUrl(origin || normalized, cached.contentType) || getAssetTypeFromUrl(origin || normalized, "bin")
      );
      const filename2 = buildDownloadFilename(origin || normalized, sourceFormat2, convertOptions.filenameBase, {
        metadataFilename: convertOptions.metadataFilename,
        contentDisposition: cached.contentDisposition
      });
      if (sourceFormat2 === "svg" && new URL2(origin || normalized).hash) {
        const standalone = materializeSvgFragmentForIllustrator(cached.buffer, origin || normalized);
        const saved2 = await saveBufferToDownloads(standalone, filename2, "Image download", sourcePageUrl, "image");
        return res.json(saved2);
      }
      const saved = await saveCachedFileToDownloads(cachePath, filename2, "Image download", sourcePageUrl, "image");
      return res.json(saved);
    }
    const fetched = cached || await fetchAssetBuffer(resolvedRequestUrl, origin || normalized, { refererPageUrl: sourcePageUrl });
    if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      throw new Error(`Downloaded asset is not a valid image: ${normalized}`);
    }
    const sourceFormat = normalizeRasterFormat(
      detectImageFormatFromBuffer(fetched.buffer) || inferImageTypeFromContentType(fetched.contentType) || inferImageTypeFromUrl(origin || normalized, fetched.contentType) || getAssetTypeFromUrl(origin || normalized, "bin")
    );
    const filename = buildDownloadFilename(origin || normalized, sourceFormat, convertOptions.filenameBase, {
      metadataFilename: convertOptions.metadataFilename,
      contentDisposition: fetched.contentDisposition
    });
    const contentType = imageContentTypeForFormat(sourceFormat, fetched.contentType || "application/octet-stream");
    const downloadBuffer = sourceFormat === "svg" ? materializeSvgFragmentForIllustrator(fetched.buffer, origin || normalized) : fetched.buffer;
    if (String(save || "").toLowerCase() === "1" || String(save || "").toLowerCase() === "true") {
      const saved = await saveBufferToDownloads(downloadBuffer, filename, "Image download", sourcePageUrl, "image");
      return res.json(saved);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);
    return res.send(downloadBuffer);
  } catch (error) {
    console.error("Image download error:", error.message || error);
    const message = String(error?.message || "Unknown error");
    if (/failed to fetch a valid image|downloaded asset is not a valid image|403|forbidden|cloudflare|blocked/i.test(message)) {
      return res.status(409).json({
        error: "This image could not be downloaded directly because the source site blocked the fetch.",
        sourceUrl: typeof originalUrl === "string" ? originalUrl : url,
        blocked: true
      });
    }
    return res.status(500).json({ error: `Failed to download image: ${message}` });
  }
});
app.post("/api/warm-image-cache", async (req, res) => {
  const originalUrl = String(req.body?.originalUrl || req.body?.url || "").trim();
  const requestUrl = String(req.body?.url || originalUrl).trim();
  const sourcePageUrl = String(req.body?.sourcePageUrl || "").trim();
  if (!requestUrl) {
    return res.status(400).json({ ok: false, error: "URL is required" });
  }
  try {
    const normalized = assertAssetUrlAllowed(requestUrl);
    const ensured = await ensureImageCachedForDownload(normalized, originalUrl || normalized, sourcePageUrl);
    if (!ensured.cached) {
      return res.status(502).json({ ok: false, error: "Image could not be cached" });
    }
    const publicPath = String(ensured.requestUrl || "").trim();
    const cachePath = await getAssetCacheDebugPath(publicPath, "image") || await getAssetCacheDebugPath(normalized, "image") || (originalUrl ? await getAssetCacheDebugPath(originalUrl, "image") : "") || "";
    const cachedUrl = await resolveCachedPublicUrl(publicPath, normalized, originalUrl) || (publicPath.startsWith("/cached-") ? publicPath : "");
    return res.json({
      ok: true,
      cachedUrl,
      cachePath,
      bytes: ensured.cached.buffer.length
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Image cache warm failed" });
  }
});
app.post("/api/warm-image-cache-batch", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const sourcePageUrl = String(req.body?.sourcePageUrl || "").trim();
  if (!items.length) {
    return res.json({ ok: true, results: {}, warmed: 0, total: 0 });
  }
  const results = {};
  const pending = [];
  await mapWithConcurrency(items.slice(0, 500), 24, async (item) => {
    const originalUrl = String(item?.originalUrl || item?.url || "").trim();
    const requestUrl = String(item?.url || originalUrl).trim();
    if (!requestUrl) return;
    if (originalUrl.startsWith("data:")) {
      results[originalUrl] = { ok: true, cachedUrl: originalUrl };
      return;
    }
    try {
      const normalized = assertAssetUrlAllowed(requestUrl);
      const cached = await readAssetBufferFromCache(normalized, "image") || (originalUrl && originalUrl !== normalized ? await readAssetBufferFromCache(originalUrl, "image") : null);
      if (!cached) {
        pending.push({ originalUrl, requestUrl: normalized });
        results[originalUrl] = { ok: false, error: "warming" };
        return;
      }
      const cachedUrl = await resolveCachedPublicUrl(normalized, normalized, originalUrl);
      results[originalUrl] = { ok: true, cachedUrl };
    } catch (error) {
      results[originalUrl] = { ok: false, error: error?.message || "Image cache warm failed" };
    }
  });
  if (pending.length > 0) {
    setImmediate(() => {
      void mapWithConcurrency(pending, 8, async (item) => {
        await ensureImageCachedForDownload(item.requestUrl, item.originalUrl || item.requestUrl, sourcePageUrl).catch(
          () => void 0
        );
      }).catch(() => void 0);
    });
  }
  const warmed = Object.values(results).filter((entry) => entry.ok).length;
  return res.json({ ok: true, results, warmed, pending: pending.length, total: items.length });
});
app.post("/api/warm-image-conversions", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const warmed = [];
  await mapWithConcurrency(items.slice(0, 200), 12, async (item) => {
    const originalUrl = String(item?.originalUrl || item?.url || "").trim();
    const convertUrl = String(item?.url || item?.cachedUrl || originalUrl).trim();
    if (!originalUrl || !/\.(?:webp|avif)(?:[?#]|$)/i.test(originalUrl)) return;
    try {
      await warmRasterConversionVariants(originalUrl, convertUrl);
      warmed.push(originalUrl);
    } catch {
    }
  });
  return res.json({ ok: true, warmed: warmed.length });
});
app.get("/api/convert-image", async (req, res) => {
  const { url, toFormat, filenameBase, originalUrl, metadataFilename, cacheOnly, save } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const sourcePageUrl = readSourcePageUrl(req);
    const normalized = assertAssetUrlAllowed(url);
    const cacheOnlyFlag = String(cacheOnly || "").toLowerCase();
    const convertOptions = {
      filenameBase: typeof filenameBase === "string" ? filenameBase : void 0,
      originalUrl: typeof originalUrl === "string" ? originalUrl : void 0,
      metadataFilename: typeof metadataFilename === "string" ? metadataFilename : void 0,
      cacheOnly: cacheOnlyFlag === "1" || cacheOnlyFlag === "true" ? true : void 0,
      refererPageUrl: sourcePageUrl || void 0
    };
    let converted;
    try {
      converted = await withTimeout(
        getCachedConvertedImage(normalized, typeof toFormat === "string" ? toFormat : void 0, convertOptions),
        6e4,
        `Image conversion for ${normalized}`
      );
    } catch (primaryError) {
      if (convertOptions.cacheOnly) {
        try {
          converted = await withTimeout(
            getCachedConvertedImage(normalized, typeof toFormat === "string" ? toFormat : void 0, {
              ...convertOptions,
              cacheOnly: void 0
            }),
            6e4,
            `Image conversion fetch for ${normalized}`
          );
        } catch {
        }
      }
      if (!converted) {
        converted = await getCurlFetchedConvertedImage(
          normalized,
          typeof toFormat === "string" ? toFormat : void 0,
          convertOptions
        );
        if (!converted) {
          const origin = typeof originalUrl === "string" ? originalUrl.trim() : "";
          if (origin && origin !== normalized) {
            converted = await withTimeout(
              getCachedConvertedImage(origin, typeof toFormat === "string" ? toFormat : void 0, convertOptions),
              6e4,
              `Image conversion fallback for ${origin}`
            );
          } else {
            throw primaryError;
          }
        }
      }
    }
    const responseFormat = normalizeRasterFormat(
      detectRasterFormatFromBuffer(converted.buffer) || detectImageFormatFromBuffer(converted.buffer) || converted.format || "bin"
    );
    const responseFilename = reconcileImageFilenameWithBuffer(converted.filename, converted.buffer);
    const contentType = imageContentTypeForFormat(responseFormat, "application/octet-stream");
    if (typeof toFormat === "string" && ["png", "jpg"].includes(normalizeRasterFormat(toFormat))) {
      const expected = normalizeRasterFormat(toFormat);
      if (!isValidRasterOutputBuffer(converted.buffer, expected)) {
        throw new Error(`Response is not valid ${expected.toUpperCase()} binary`);
      }
      if (detectRasterFormatFromBuffer(converted.buffer) === "webp" || detectRasterFormatFromBuffer(converted.buffer) === "avif") {
        throw new Error("Refusing to stream WEBP/AVIF when PNG/JPG was requested");
      }
    }
    if (String(save || "").toLowerCase() === "1" || String(save || "").toLowerCase() === "true") {
      if (converted.cachedPath) {
        try {
          await fsp3.access(converted.cachedPath);
          const saved2 = await saveCachedFileToDownloads(converted.cachedPath, responseFilename, "Image conversion", sourcePageUrl, "image");
          return res.json(saved2);
        } catch {
        }
      }
      const saved = await saveBufferToDownloads(converted.buffer, responseFilename, "Image conversion", sourcePageUrl, "image");
      return res.json(saved);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${responseFilename}"`);
    res.setHeader("Content-Type", contentType);
    return res.send(converted.buffer);
  } catch (error) {
    console.error("Image conversion error:", error.message || error);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ""))) {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: `Failed to convert image: ${error?.message || "Unknown error"}` });
  }
});
var parseDownloadSaveKind = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "font" || raw === "image" || raw === "icon" || raw === "color" || raw === "video" || raw === "audio" || raw === "brief" || raw === "isi" || raw === "zip") {
    return raw;
  }
  return "default";
};
var inferDownloadSaveKindFromFilename = (filename) => {
  const ext = path3.extname(String(filename || "")).toLowerCase();
  if (/^\.(?:woff2?|ttf|otf|eot|svg)$/.test(ext)) return "font";
  if (/^\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|heif)$/.test(ext)) return "image";
  return "default";
};
app.post("/api/save-asset-buffer", async (req, res) => {
  const { base64, filename, sourcePageUrl: bodySourcePageUrl, kind: bodyKind } = req.body || {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ error: "base64 is required" });
  }
  if (!filename || typeof filename !== "string") {
    return res.status(400).json({ error: "filename is required" });
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > 50 * 1024 * 1024) {
      return res.status(413).json({ error: "File is too large to save through this path." });
    }
    const explicitKind = parseDownloadSaveKind(bodyKind);
    const saveKind = explicitKind !== "default" ? explicitKind : inferDownloadSaveKindFromFilename(filename);
    const saved = await saveBufferToDownloads(buffer, filename, "Asset buffer save", readSourcePageUrl(req, bodySourcePageUrl), saveKind);
    return res.json(saved);
  } catch (error) {
    console.error("Save asset buffer error:", error?.message || error);
    return res.status(500).json({ error: `Failed to save file: ${error?.message || "Unknown error"}` });
  }
});
app.get("/api/convert-font", async (req, res) => {
  const { url, toFormat, originalFormat, filenameBase, familyFolder, originalUrl, metadataFilename, save, cssSource, fontFamily, fontWeight, fontStyle, fixVerticalMetrics } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const targetFormat = typeof toFormat === "string" && toFormat.trim() ? toFormat.trim().toLowerCase() : "ttf";
  const sourceFormat = typeof originalFormat === "string" ? originalFormat : "unknown";
  const preferredBase = typeof filenameBase === "string" ? filenameBase : void 0;
  const fontFamilyFolder = typeof familyFolder === "string" ? familyFolder : "";
  const extras = {
    originalUrl: typeof originalUrl === "string" ? originalUrl : void 0,
    metadataFilename: typeof metadataFilename === "string" ? metadataFilename : void 0,
    refererPageUrl: readSourcePageUrl(req) || void 0,
    cssSource: typeof cssSource === "string" ? cssSource : void 0,
    fontFamily: typeof fontFamily === "string" ? fontFamily : fontFamilyFolder || void 0,
    fontWeight: typeof fontWeight === "string" ? fontWeight : void 0,
    fontStyle: typeof fontStyle === "string" ? fontStyle : void 0,
    preferInlineConversion: true,
    timeoutMs: 65e3,
    fixVerticalMetrics: !["0", "false", "off"].includes(String(fixVerticalMetrics || "").toLowerCase())
  };
  const wantsSave = String(save || "").toLowerCase() === "1" || String(save || "").toLowerCase() === "true";
  try {
    const normalized = assertAssetUrlAllowed(url);
    const converted = await convertFontAsset(normalized, targetFormat, sourceFormat, preferredBase, extras);
    if (wantsSave) {
      const saved = await saveBufferToDownloads(
        converted.buffer,
        converted.filename,
        "Font conversion",
        readSourcePageUrl(req),
        "font",
        fontFamilyFolder
      );
      return res.json({ ...saved, format: converted.format, conversionProvider: converted.conversionProvider || "local" });
    }
    let contentType = "application/octet-stream";
    if (converted.format === "woff2") contentType = "font/woff2";
    else if (converted.format === "woff") contentType = "font/woff";
    else if (converted.format === "ttf") contentType = "font/ttf";
    else if (converted.format === "otf") contentType = "font/otf";
    else if (converted.format === "eot") contentType = "application/vnd.ms-fontobject";
    else if (converted.format === "svg") contentType = "image/svg+xml";
    res.setHeader("Content-Disposition", `attachment; filename="${converted.filename}"`);
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Font-Conversion-Provider", converted.conversionProvider || "local");
    return res.send(converted.buffer);
  } catch (error) {
    console.error("Font conversion error:", error.message || error);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ""))) {
      return res.status(403).json({ error: error.message });
    }
    if (/woff2|decode/i.test(String(error?.message || "")) && wantsSave) {
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
          "Font original fallback",
          readSourcePageUrl(req),
          "font",
          fontFamilyFolder
        );
        return res.json({
          ...saved,
          format: original.format,
          warning: "WOFF2 converter unavailable. Downloading original font only."
        });
      } catch {
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
          "Font original fallback",
          readSourcePageUrl(req),
          "font",
          fontFamilyFolder
        );
        return res.json({
          ...saved,
          format: original.format,
          warning: "Font conversion failed. Original file saved."
        });
      } catch {
      }
    }
    return res.status(500).json({
      error: wantsSave ? "Font conversion failed. Try downloading the original format or use ZIP download." : `Font conversion failed: ${error?.message || "Unknown error"}`
    });
  }
});
app.post("/api/convert-font-buffer", async (req, res) => {
  const { base64, toFormat, originalFormat, filenameBase, familyFolder, save, sourcePageUrl: bodySourcePageUrl, fixVerticalMetrics } = req.body || {};
  if (!base64 || typeof base64 !== "string") {
    return res.status(400).json({ error: "base64 is required" });
  }
  const targetFormat = typeof toFormat === "string" && toFormat.trim() ? toFormat.trim().toLowerCase() : "ttf";
  try {
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) {
      return res.status(400).json({ error: "Font buffer was empty" });
    }
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(413).json({ error: "Font buffer too large" });
    }
    const normalizedTarget = ["ttf", "woff", "woff2", "eot", "otf", "svg"].includes(targetFormat) ? targetFormat : "ttf";
    let output;
    let conversionProvider = "local";
    try {
      const normalizedOriginal = normalizeFontFormat(typeof originalFormat === "string" ? originalFormat : "unknown");
      if (normalizedTarget === "ttf" && normalizedOriginal !== "ttf") {
        output = await convertFontBufferToInstallableTtf(
          buffer,
          typeof filenameBase === "string" ? filenameBase : "font",
          normalizedOriginal,
          fixVerticalMetrics !== false
        );
        conversionProvider = "transfonter";
      } else if (normalizedTarget === "woff" && normalizedOriginal !== "woff") {
        try {
          output = await convertFontBuffer(
            typeof filenameBase === "string" ? filenameBase : "font",
            buffer,
            normalizedOriginal,
            "woff",
            "",
            true
          );
          if (!isValidFontBuffer(output, "woff")) {
            throw new Error("Local WOFF conversion returned an invalid WOFF binary.");
          }
          conversionProvider = "local";
        } catch {
          output = await convertFontBufferWithTransfonter(
            buffer,
            typeof filenameBase === "string" ? filenameBase : "font",
            normalizedOriginal,
            fixVerticalMetrics !== false,
            "woff"
          );
          if (!isValidFontBuffer(output, "woff")) {
            throw new Error("Transfonter WOFF conversion returned an invalid WOFF binary.");
          }
          conversionProvider = "transfonter";
        }
      } else {
        output = await convertFontBuffer(
          typeof filenameBase === "string" ? filenameBase : "font",
          buffer,
          typeof originalFormat === "string" ? originalFormat : "unknown",
          normalizedTarget,
          ""
        );
      }
      if (normalizedTarget === "ttf" && !isInstallableTtfBuffer(output) && normalizeFontFormat(typeof originalFormat === "string" ? originalFormat : "unknown") !== "ttf") {
        output = await convertFontBufferToInstallableTtf(
          buffer,
          typeof filenameBase === "string" ? filenameBase : "font",
          normalizeFontFormat(typeof originalFormat === "string" ? originalFormat : "unknown"),
          fixVerticalMetrics !== false
        );
        conversionProvider = "transfonter";
      }
    } catch (localError) {
      if (!["ttf", "woff"].includes(normalizedTarget)) throw localError;
      const normalizedOriginal = normalizeFontFormat(typeof originalFormat === "string" ? originalFormat : "unknown");
      output = normalizedTarget === "ttf" ? await convertFontBufferToInstallableTtf(
        buffer,
        typeof filenameBase === "string" ? filenameBase : "font",
        normalizedOriginal,
        fixVerticalMetrics !== false
      ) : await convertFontBufferWithTransfonter(
        buffer,
        typeof filenameBase === "string" ? filenameBase : "font",
        normalizedOriginal,
        fixVerticalMetrics !== false,
        "woff"
      );
      conversionProvider = "transfonter";
    }
    if (!isValidFontBuffer(output, normalizedTarget)) {
      throw new Error(`Converted font is not a valid installable ${normalizedTarget.toUpperCase()} file`);
    }
    const preferredBase = typeof filenameBase === "string" ? filenameBase : void 0;
    const filename = deriveAssetFilename({
      metadataFilename: typeof req.body?.metadataFilename === "string" ? req.body.metadataFilename : void 0,
      preferredBase,
      format: normalizedTarget,
      fallbackBase: "font"
    });
    let contentType = "application/octet-stream";
    if (normalizedTarget === "woff2") contentType = "font/woff2";
    else if (normalizedTarget === "woff") contentType = "font/woff";
    else if (normalizedTarget === "ttf") contentType = "font/ttf";
    else if (normalizedTarget === "otf") contentType = "font/otf";
    else if (normalizedTarget === "eot") contentType = "application/vnd.ms-fontobject";
    else if (normalizedTarget === "svg") contentType = "image/svg+xml";
    if (save === true || String(save || "").toLowerCase() === "true") {
      const saved = await saveBufferToDownloads(
        output,
        filename,
        "Font buffer conversion",
        readSourcePageUrl(req, bodySourcePageUrl),
        "font",
        typeof familyFolder === "string" ? familyFolder : ""
      );
      return res.json({ ...saved, format: normalizedTarget, conversionProvider });
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Font-Conversion-Provider", conversionProvider);
    return res.send(output);
  } catch (error) {
    console.error("Font buffer conversion error:", error.message || error);
    return res.status(500).json({ error: `Failed to convert font: ${error?.message || "Unknown error"}` });
  }
});
app.get("/api/probe-stream-audio", async (req, res) => {
  const { url, sourcePageUrl } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const normalizedUrl = sanitizeStreamUrl(url, typeof sourcePageUrl === "string" ? sourcePageUrl : void 0);
    if (!normalizedUrl) return res.status(400).json({ error: "Invalid media URL" });
    assertPublicAssetUrl(normalizedUrl);
    const metadata = await probeRemoteVideoMetadata(
      normalizedUrl,
      typeof sourcePageUrl === "string" ? sourcePageUrl : void 0
    );
    return res.json({
      url: normalizedUrl,
      ...describeMediaProbe(metadata)
    });
  } catch (error) {
    console.error("Stream audio probe error:", error?.message || error);
    return res.status(500).json({ error: error?.message || "Failed to probe stream audio." });
  }
});
app.get("/api/verify-youtube-merge", async (req, res) => {
  const { url, quality } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "YouTube watch URL is required" });
  }
  const watchUrl = recoverYouTubeWatchFromMergeQuery(url, typeof req.query.v === "string" ? req.query.v : "");
  if (!isYouTubeUrl(watchUrl) || !getYouTubeVideoId(watchUrl)) {
    return res.status(400).json({ error: "Only YouTube watch URLs are supported." });
  }
  const requestedQuality = typeof quality === "string" && ["hd", "fhd", "4k"].includes(quality) ? quality : "fhd";
  try {
    assertPublicAssetUrl(watchUrl);
    const sourcePageUrl = typeof req.query.sourcePageUrl === "string" ? req.query.sourcePageUrl : watchUrl;
    const titleHint = typeof req.query.title === "string" && req.query.title.trim() ? req.query.title.trim() : pageTitleFromUrl(watchUrl);
    const exportToDownloads = req.query.export === "1" || req.query.direct === "1";
    const forceLocalMerge = req.query.direct === "1";
    const prepared = await prepareYouTubeQualityOutput(watchUrl, requestedQuality, {
      titleHint,
      sourcePageUrl,
      exportToDownloads,
      forceLocalMerge
    });
    return res.json(prepared);
  } catch (error) {
    console.error("YouTube merge verify error:", error?.message || error);
    try {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
      const cachedPath = getYouTubeMergeCachePath(normalizedWatchUrl, requestedQuality);
      await validateOutputFile(cachedPath, "YouTube merge cache");
      const probe = await verifyMergedYouTubeFile(cachedPath);
      const stat = await fsp3.stat(cachedPath);
      const title = pageTitleFromUrl(normalizedWatchUrl);
      const internalPreviewUrl = toYouTubeMergedDownloadUrl(normalizedWatchUrl, requestedQuality, title);
      const targetHeight = getVimeoTargetHeight(requestedQuality);
      logYouTubeMerge("verify-salvage", { cachedPath, originalError: error?.message || String(error) });
      return res.json({
        ok: true,
        watchUrl: normalizedWatchUrl,
        quality: requestedQuality,
        mergeMode: "merged",
        isDirectProgressive: false,
        directStreamUrl: "",
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
        warning: probe.warning || error?.message || "",
        ...probe
      });
    } catch {
      return res.status(500).json({ error: error?.message || "Merged YouTube file failed audio verification." });
    }
  }
});
app.get("/api/youtube-merged-stream", async (req, res) => {
  const { url, quality, filename } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const watchUrl = recoverYouTubeWatchFromMergeQuery(url, typeof req.query.v === "string" ? req.query.v : "");
  if (!isYouTubeUrl(watchUrl) || !getYouTubeVideoId(watchUrl)) {
    return res.status(400).json({ error: "Only YouTube watch URLs are supported for merged streaming." });
  }
  const requestedQuality = typeof quality === "string" && ["hd", "fhd", "4k"].includes(quality) ? quality : "fhd";
  const inlinePlayback = req.query.inline !== "0" && (req.query.inline === "1" || req.query.inline === "true" || req.query.inline === void 0);
  const preferredFilename = typeof filename === "string" ? filename : toQualityVideoFilename(requestedQuality);
  try {
    assertPublicAssetUrl(watchUrl);
    await pipeYouTubeMergedStream(req, res, watchUrl, requestedQuality, {
      inline: inlinePlayback,
      filename: preferredFilename
    });
  } catch (error) {
    console.error("YouTube merged stream error:", error?.message || error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error?.message || "Failed to merge YouTube audio into stream." });
    }
  }
});
app.head("/api/youtube-merged-stream", async (req, res) => {
  const { url, quality, filename } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).end();
  }
  const watchUrl = recoverYouTubeWatchFromMergeQuery(url, typeof req.query.v === "string" ? req.query.v : "");
  if (!isYouTubeUrl(watchUrl) || !getYouTubeVideoId(watchUrl)) {
    return res.status(400).end();
  }
  const requestedQuality = typeof quality === "string" && ["hd", "fhd", "4k"].includes(quality) ? quality : "fhd";
  const inlinePlayback = req.query.inline !== "0" && (req.query.inline === "1" || req.query.inline === "true" || req.query.inline === void 0);
  const preferredFilename = typeof filename === "string" ? filename : toQualityVideoFilename(requestedQuality);
  try {
    assertPublicAssetUrl(watchUrl);
    await pipeYouTubeMergedStream(req, res, watchUrl, requestedQuality, {
      inline: inlinePlayback,
      filename: preferredFilename
    });
  } catch (error) {
    console.error("YouTube merged stream HEAD error:", error?.message || error);
    if (!res.headersSent) res.status(500).end();
  }
});
app.get("/api/download", async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    let normalizedSourceUrl = sanitizeStreamUrl(url);
    if (!normalizedSourceUrl) {
      return res.status(400).json({ error: "Invalid download URL" });
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
    if (isYouTubeUrl(normalizedSourceUrl) && !isLikelyDirectVideoStreamUrl(normalizedSourceUrl) && !isLikelyVideoAssetUrl(normalizedSourceUrl)) {
      const tempBase2 = `creative-ytdlp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const outputPath = path3.join(os3.tmpdir(), `${tempBase2}.mp4`);
      const requestedQuality = typeof req.query.quality === "string" && ["hd", "fhd", "4k"].includes(req.query.quality) ? req.query.quality : "fhd";
      const inlinePlayback = req.query.inline === "1" || req.query.inline === "true";
      try {
        await withTimeout(
          mergeYouTubeWatchUrlToFile(normalizedSourceUrl, requestedQuality, outputPath),
          4 * 60 * 1e3,
          `YouTube merged download for ${normalizedSourceUrl}`
        );
        const stat = await fsp3.stat(outputPath);
        const requestedName2 = typeof filename === "string" ? filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") : "";
        const preferredName2 = requestedName2 || `${pageTitleFromUrl(normalizedSourceUrl)}.mp4`.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
        res.setHeader("Content-Disposition", `${inlinePlayback ? "inline" : "attachment"}; filename="${preferredName2 || "youtube-video.mp4"}"`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", String(stat.size));
        const stream = fs2.createReadStream(outputPath);
        stream.on("close", async () => {
          await fsp3.unlink(outputPath).catch(() => void 0);
        });
        stream.pipe(res);
        return;
      } catch (ytdlpError) {
        await fsp3.unlink(outputPath).catch(() => void 0);
        console.warn("YouTube merged download failed:", ytdlpError?.message || ytdlpError);
        return res.status(500).json({ error: "Could not merge YouTube video and audio. Please retry with the YouTube watch URL." });
      }
    }
    const mediaValidation = isLikelyHttpMediaUrl(normalizedSourceUrl) || isLikelyDirectVideoStreamUrl(normalizedSourceUrl) || isLikelyVideoAssetUrl(normalizedSourceUrl) ? await validateStreamUrl(normalizedSourceUrl) : null;
    if (mediaValidation && (!mediaValidation.ok || !mediaValidation.url)) {
      return res.status(410).json({ error: mediaValidation.reason || "Stream URL is no longer valid." });
    }
    const downloadUrl = mediaValidation?.url || normalizedSourceUrl;
    if (isGoogleVideoPlaybackUrl(downloadUrl)) {
      return res.status(400).json({ error: "This YouTube link is video-only. Paste the YouTube watch URL to download with audio merged." });
    }
    const sourceOrigin = (() => {
      try {
        return new URL2(downloadUrl).origin;
      } catch {
        return "";
      }
    })();
    const parsedDownloadUrl = (() => {
      try {
        return new URL2(downloadUrl);
      } catch {
        return null;
      }
    })();
    const host = parsedDownloadUrl?.hostname.replace(/^www\./, "").toLowerCase() || "";
    const isGoogleVideo = host.includes("googlevideo.com");
    const referer = isGoogleVideo ? "https://www.youtube.com/" : sourceOrigin ? `${sourceOrigin}/` : void 0;
    const origin = isGoogleVideo ? "https://www.youtube.com" : sourceOrigin || void 0;
    const response = await axios({
      method: "GET",
      url: downloadUrl,
      responseType: "stream",
      timeout: 6e4,
      httpsAgent: relaxedHttpsAgent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        ...referer ? { "Referer": referer } : {},
        ...origin ? { "Origin": origin } : {}
      }
    });
    const sourceName = downloadUrl.split("/").pop()?.split("?")[0] || "download";
    const base = sourceName.replace(/\.[a-z0-9]+$/i, "") || "download";
    const requestedName = typeof filename === "string" ? filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") : "";
    const preferredName = requestedName || `${base}.mp4`;
    const contentType = String(response.headers["content-type"] || "video/mp4");
    const forceTranscode = needsMp4Transcode(downloadUrl, contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${preferredName}"`);
    res.setHeader("Content-Type", "video/mp4");
    if (!forceTranscode) {
      response.data.pipe(res);
      return;
    }
    response.data.destroy();
    const tempBase = `creative-extractor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempOutput = path3.join(os3.tmpdir(), `${tempBase}.mp4`);
    try {
      await transcodeUrlToMp4File(downloadUrl, tempOutput, referer, origin);
      const stat = await fsp3.stat(tempOutput);
      res.setHeader("Content-Length", String(stat.size));
      const stream = fs2.createReadStream(tempOutput);
      stream.on("close", async () => {
        await fsp3.unlink(tempOutput).catch(() => void 0);
      });
      stream.pipe(res);
    } catch (transcodeError) {
      await fsp3.unlink(tempOutput).catch(() => void 0);
      throw new Error(`Failed to convert source to mp4: ${transcodeError?.message || transcodeError}`);
    }
  } catch (error) {
    console.error("Download error:", error.message || error);
    const blockedPrivateUrl = /private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ""));
    res.status(blockedPrivateUrl ? 403 : error.response?.status || 500).json({ error: blockedPrivateUrl ? error.message : "Failed to download file" });
  }
});
app.get("/api/convert-mp4", async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const sourceUrl = sanitizeStreamUrl(unwrapDownloadProxyUrl(url));
  if (!sourceUrl) {
    return res.status(400).json({ error: "Invalid video URL" });
  }
  try {
    assertPublicAssetUrl(sourceUrl);
  } catch (securityError) {
    return res.status(403).json({ error: securityError?.message || "Private or local video URLs are blocked." });
  }
  let parsedSource;
  try {
    parsedSource = new URL2(sourceUrl);
  } catch {
    return res.status(400).json({ error: "Invalid video URL" });
  }
  const safeFilename = (typeof filename === "string" && filename.trim() ? filename : `${toSafeFileBase(parsedSource.pathname.split("/").pop() || "video")}.mp4`).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").replace(/\.[a-z0-9]+$/i, ".mp4");
  try {
    const validation = await validateStreamUrl(sourceUrl);
    if (!validation.ok || !validation.url) {
      return res.status(410).json({ error: validation.reason || "Stream URL is no longer valid." });
    }
    const validatedSourceUrl = validation.url;
    parsedSource = new URL2(validatedSourceUrl);
    const { referer, origin } = getStreamRequestContext(parsedSource);
    await fsp3.mkdir(convertedVideoDir, { recursive: true });
    const sourcePageUrl = readSourcePageUrl(req);
    const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
    await fsp3.mkdir(targetDir, { recursive: true });
    const tempBase = `converted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempOutput = path3.join(convertedVideoDir, `${tempBase}.mp4`);
    const isAlreadyMp4 = /\.mp4(\?|$)/i.test(validatedSourceUrl);
    if (isAlreadyMp4) {
      const downloadResponse = await axios({
        method: "GET",
        url: validatedSourceUrl,
        responseType: "stream",
        timeout: 6e4,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Referer": referer,
          "Origin": origin
        }
      });
      await new Promise((resolve, reject) => {
        const out = fs2.createWriteStream(tempOutput);
        downloadResponse.data.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
        downloadResponse.data.on("error", reject);
      });
    } else {
      await transcodeUrlToMp4File(validatedSourceUrl, tempOutput, referer, origin);
    }
    const finalPath = path3.join(targetDir, safeFilename);
    await fsp3.rename(tempOutput, finalPath).catch(async () => {
      await fsp3.copyFile(tempOutput, finalPath);
      await fsp3.unlink(tempOutput).catch(() => void 0);
    });
    const stat = await validateOutputFile(finalPath, "MP4 conversion");
    return res.json({
      ok: true,
      url: toLocalVideoDownloadUrl(req, safeFilename, sourcePageUrl),
      localPath: finalPath,
      downloadPath: finalPath,
      folderPath: targetDir,
      filename: safeFilename,
      size: stat.size
    });
  } catch (error) {
    console.error("Convert MP4 error:", error.message || error);
    return res.status(500).json({ error: `Failed to convert to MP4: ${error?.message || "Unknown error"}` });
  }
});
app.get("/api/convert-audio", async (req, res) => {
  const { url, filename, bitrate, mode } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const sourceUrl = sanitizeStreamUrl(unwrapDownloadProxyUrl(url));
  if (!sourceUrl) {
    return res.status(400).json({ error: "Invalid media URL" });
  }
  try {
    assertPublicAssetUrl(sourceUrl);
  } catch (securityError) {
    return res.status(403).json({ error: securityError?.message || "Private or local media URLs are blocked." });
  }
  let parsedSource;
  try {
    parsedSource = new URL2(sourceUrl);
  } catch {
    return res.status(400).json({ error: "Invalid media URL" });
  }
  const audioMode = mode === "original" ? "original" : mode === "hq" || bitrate === "320k" ? "hq" : "turbo";
  const requestedBitrate = typeof bitrate === "string" && /^\d{2,3}k$/.test(bitrate) ? bitrate : audioMode === "hq" ? "320k" : "128k";
  const requestedBase = (typeof filename === "string" && filename.trim() ? filename : toStandardAudioFilename(String(mode || ""))).replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "Audio";
  const turboDurationSeconds = audioMode === "turbo" ? 30 : void 0;
  try {
    await fsp3.mkdir(convertedAudioDir, { recursive: true });
    let audioSourceUrl = sourceUrl;
    let sourcePageUrl = sourceUrl;
    let resolvedAudioStream = null;
    if (isPlatformVideoUrl(sourceUrl) && !isLikelyDirectVideoStreamUrl(sourceUrl)) {
      try {
        const audioStream = await resolveBestAudioStream(sourceUrl, audioMode);
        if (audioStream?.url) {
          resolvedAudioStream = audioStream;
          audioSourceUrl = sanitizeStreamUrl(audioStream.url, sourceUrl) || audioStream.url;
          sourcePageUrl = sourceUrl;
        } else {
          return res.status(422).json({ error: "Audio track unavailable for this video." });
        }
      } catch (resolveError) {
        if (isXUrl(sourceUrl)) {
          return res.status(422).json({ error: "This X.com video does not contain a separate audio stream." });
        }
        console.warn("Audio stream resolver failed, falling back to direct FFmpeg input:", resolveError.message || resolveError);
      }
    }
    const validation = await validateStreamUrl(audioSourceUrl, sourcePageUrl);
    if (!validation.ok || !validation.url) {
      return res.status(410).json({ error: validation.reason || "Audio stream URL is no longer valid." });
    }
    audioSourceUrl = validation.url;
    const parsedAudioSource = new URL2(audioSourceUrl);
    const { referer, origin } = getStreamRequestContext(parsedAudioSource, sourcePageUrl);
    const tempBase = `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let outputFormat = audioMode === "original" ? resolvedAudioStream?.originalOutput?.extension || getOriginalAudioOutput(resolvedAudioStream || { ext: path3.extname(parsedAudioSource.pathname).replace(/^\./, "") }).extension : audioMode === "turbo" ? "m4a" : "mp3";
    const originalContainer = audioMode === "original" ? resolvedAudioStream?.originalOutput?.container || getOriginalAudioOutput(resolvedAudioStream || { ext: outputFormat }).container : void 0;
    let tempOutput = path3.join(convertedAudioDir, `${tempBase}.${outputFormat}`);
    const tempInput = path3.join(convertedAudioDir, `${tempBase}-source${path3.extname(parsedAudioSource.pathname) || ".bin"}`);
    const isManifestSource = /\.m3u8|\.mpd/i.test(parsedAudioSource.pathname) || /mpegurl|dash\+xml/i.test(String(validation.contentType || ""));
    try {
      if (audioMode === "original") {
        if (resolvedAudioStream?.isAudioOnly) {
          await downloadUrlToFile(audioSourceUrl, tempOutput, sourcePageUrl);
          await assertLocalFileHasAudio(tempOutput);
        } else {
          await copyUrlAudioToFile(audioSourceUrl, tempOutput, referer, origin, originalContainer);
        }
      } else if (audioMode === "turbo") {
        try {
          await copyUrlAudioSegmentToM4aFile(audioSourceUrl, tempOutput, referer, origin, turboDurationSeconds || 30);
        } catch (copyError) {
          console.warn("Quick audio copy failed, falling back to 128kbps MP3:", copyError?.message || copyError);
          await fsp3.unlink(tempOutput).catch(() => void 0);
          outputFormat = "mp3";
          tempOutput = path3.join(convertedAudioDir, `${tempBase}.mp3`);
          try {
            await transcodeUrlToMp3File(audioSourceUrl, tempOutput, referer, origin, requestedBitrate, {
              durationSeconds: turboDurationSeconds,
              timeoutMs: 90 * 1e3,
              stallMs: 25 * 1e3
            });
          } catch (urlTranscodeError) {
            console.warn("Quick URL audio transcode failed, using chunked local fallback:", urlTranscodeError?.message || urlTranscodeError);
            await fsp3.unlink(tempOutput).catch(() => void 0);
            await downloadUrlToFile(audioSourceUrl, tempInput, sourcePageUrl);
            await assertLocalFileHasAudio(tempInput);
            await transcodeLocalFileToMp3File(tempInput, tempOutput, requestedBitrate, {
              durationSeconds: turboDurationSeconds,
              timeoutMs: 90 * 1e3,
              stallMs: 25 * 1e3
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
      await fsp3.unlink(tempInput).catch(() => void 0);
    }
    const safeFilename = `${requestedBase}.${outputFormat}`;
    const finalPath = path3.join(convertedAudioDir, safeFilename);
    await fsp3.rename(tempOutput, finalPath).catch(async () => {
      await fsp3.copyFile(tempOutput, finalPath);
      await fsp3.unlink(tempOutput).catch(() => void 0);
    });
    const stat = await validateOutputFile(finalPath, "Audio extraction");
    return res.json({
      ok: true,
      url: toAbsoluteAppUrl(req, `/converted-audio/${encodeURIComponent(safeFilename)}`),
      filename: safeFilename,
      format: outputFormat,
      bitrate: audioMode === "original" || outputFormat === "m4a" ? "source copy" : requestedBitrate.replace("k", " kbps"),
      mode: audioMode,
      durationSeconds: turboDurationSeconds,
      codec: resolvedAudioStream?.acodec,
      channels: resolvedAudioStream?.audioChannels,
      formatId: resolvedAudioStream?.formatId,
      originalAudio: audioMode === "original",
      dolbyLike: Boolean(resolvedAudioStream?.isDolbyLike),
      estimatedSeconds: audioMode === "turbo" ? 30 : audioMode === "original" ? 20 : 45,
      size: stat.size
    });
  } catch (error) {
    console.error("Convert audio error:", error.message || error);
    const looksLikeMissingAudio = /audio track unavailable|stream map|matches no streams|does not contain any stream|output was not created/i.test(String(error?.message || ""));
    const status = error?.status || (looksLikeMissingAudio ? 422 : 500);
    const message = status === 422 ? error?.message || "Audio track unavailable for this video." : `Failed to extract audio: ${error?.message || "Unknown error"}`;
    return res.status(status).json({ error: message });
  }
});
app.post("/api/open-folder", async (req, res) => {
  const target = String(req.body?.target || "downloads");
  const sourcePageUrl = readSourcePageUrl(req, String(req.body?.sourcePageUrl || ""));
  const requestedFolderPath = String(req.body?.folderPath || "").trim();
  const exactFolderPath = requestedFolderPath ? assertPathInsideDownloads(requestedFolderPath) : "";
  const folderPath = exactFolderPath || (target === "converted-audio" ? convertedAudioDir : target === "converted-video" ? convertedVideoDir : target === "video-downloads" ? resolveDownloadSaveDir("video", sourcePageUrl) : target === "fonts" ? resolveCreativeAssetsDir(sourcePageUrl, "Fonts", { sectionMode: lastExtractionSectionMode }) : target === "colors" ? resolveCreativeAssetsDir(sourcePageUrl, "Colors", { sectionMode: lastExtractionSectionMode }) : target === "icons" ? resolveCreativeAssetsDir(sourcePageUrl, "Images", { sectionMode: lastExtractionSectionMode }) : target === "images" ? resolveCreativeAssetsDir(sourcePageUrl, "Images", { sectionMode: lastExtractionSectionMode }) : resolveCreativeAssetsRoot(sourcePageUrl, { sectionMode: lastExtractionSectionMode }));
  try {
    const stat = await fsp3.stat(folderPath);
    if (!stat.isDirectory()) throw new Error("Requested Downloads path is not a folder.");
    await openLocalFolder(folderPath);
    return res.json({ ok: true, path: folderPath });
  } catch (error) {
    console.error("Open folder error:", error.message || error);
    return res.status(500).json({ error: "Could not open the folder on this machine." });
  }
});
var isInsidePath = (candidate, parent) => {
  const relative = path3.relative(path3.resolve(parent), path3.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path3.isAbsolute(relative);
};
app.delete("/api/website-downloads", async (req, res) => {
  const sourcePageUrl = readSourcePageUrl(req, String(req.body?.sourcePageUrl || ""));
  const deleteFiles = Boolean(req.body?.deleteFiles);
  if (!sourcePageUrl) return res.status(400).json({ error: "Source URL is required." });
  try {
    const root = resolveCreativeAssetsRoot(sourcePageUrl, { sectionMode: lastExtractionSectionMode });
    if (!deleteFiles) return res.json({ ok: true, mode: "history", removed: 0, path: root });
    const downloadsRoot = path3.join(os3.homedir(), "Downloads");
    if (!isInsidePath(root, downloadsRoot)) {
      return res.status(400).json({ error: "Refusing to clear files outside Downloads." });
    }
    const entries = await fsp3.readdir(root).catch(() => []);
    await fsp3.rm(root, { recursive: true, force: true });
    return res.json({ ok: true, mode: "files", removed: entries.length, path: root });
  } catch (error) {
    console.error("Clear website downloads error:", error.message || error);
    return res.status(500).json({ error: error?.message || "Failed to clear website downloads." });
  }
});
app.get("/api/fetch-direct-video", async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  if (!isDirectProgressiveVideoUrl(url)) {
    return res.status(400).json({ error: "Only direct progressive video URLs are supported." });
  }
  try {
    assertPublicAssetUrl(url);
    const sourcePageUrl = typeof req.query.sourcePageUrl === "string" ? req.query.sourcePageUrl : void 0;
    const payload = await buildDirectProgressiveVideoPayload(url, req, sourcePageUrl, { cache: true });
    const preferredName = typeof filename === "string" && filename.trim() ? filename.trim().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120) : payload.localFilename;
    const filePath = payload.localPath || path3.join(downloadsDir, payload.localFilename);
    const stat = await validateOutputFile(filePath, "Direct video download");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${preferredName || payload.localFilename}"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    return fs2.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error("Direct video fetch error:", error?.message || error);
    return res.status(500).json({ error: error?.message || "Failed to fetch direct video." });
  }
});
app.get("/api/download-local-video", async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  const safeFilename = filename.split("/").map((segment) => segment.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "")).filter(Boolean).join("/");
  if (!safeFilename || safeFilename !== filename || !safeFilename.toLowerCase().endsWith(".mp4")) {
    return res.status(400).json({ error: "A valid local MP4 filename is required." });
  }
  const filePath = path3.join(downloadsDir, safeFilename);
  const resolved = assertPathInsideDownloads(filePath);
  try {
    await validateOutputFile(resolved, "Local video download");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store, private");
    return fs2.createReadStream(resolved).pipe(res);
  } catch {
    return res.status(404).json({ error: "Local video file was not found in Downloads." });
  }
});
app.head("/api/download-local-video", async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  const safeFilename = filename.split("/").map((segment) => segment.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "")).filter(Boolean).join("/");
  if (!safeFilename || safeFilename !== filename || !safeFilename.toLowerCase().endsWith(".mp4")) {
    return res.status(400).end();
  }
  const filePath = path3.join(downloadsDir, safeFilename);
  try {
    const stat = await validateOutputFile(assertPathInsideDownloads(filePath), "Local video download");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    return res.status(200).end();
  } catch {
    return res.status(404).end();
  }
});
app.post("/api/ftp/upload-url", async (req, res) => {
  const {
    ftpHost,
    ftpPort,
    ftpUser,
    ftpPassword,
    ftpSecure,
    remoteDir,
    fileUrl,
    filename
  } = req.body || {};
  if (!ftpHost || !ftpUser || !ftpPassword || !fileUrl) {
    return res.status(400).json({
      error: "ftpHost, ftpUser, ftpPassword, and fileUrl are required"
    });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL2(fileUrl);
  } catch {
    return res.status(400).json({ error: "Invalid fileUrl" });
  }
  const downloadResponse = await axios({
    method: "GET",
    url: parsedUrl.href,
    responseType: "arraybuffer",
    timeout: 3e4,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "*/*"
    },
    validateStatus: (status) => status >= 200 && status < 300
  }).catch((error) => {
    const status = error?.response?.status;
    throw new Error(status ? `Source download failed (${status})` : "Source download failed");
  });
  const fileBuffer = Buffer.from(downloadResponse.data);
  const inferredName = parsedUrl.pathname.split("/").pop() || "asset.bin";
  const safeFilename = String(filename || inferredName).replace(/[\\/:*?"<>|]/g, "_");
  const port = Number(ftpPort) > 0 ? Number(ftpPort) : 21;
  const secure = Boolean(ftpSecure);
  const ftp = new FtpClient(3e4);
  ftp.ftp.verbose = false;
  try {
    await ftp.access({
      host: String(ftpHost),
      port,
      user: String(ftpUser),
      password: String(ftpPassword),
      secure
    });
    const normalizedRemoteDir = String(remoteDir || "").trim();
    if (normalizedRemoteDir) {
      await ftp.ensureDir(normalizedRemoteDir);
    }
    await ftp.uploadFrom(Readable.from(fileBuffer), safeFilename);
    const uploadedPath = normalizedRemoteDir ? `${normalizedRemoteDir}/${safeFilename}` : safeFilename;
    return res.json({
      ok: true,
      uploadedPath,
      bytes: fileBuffer.length
    });
  } catch (error) {
    return res.status(500).json({
      error: `FTP upload failed: ${error?.message || "Unknown error"}`
    });
  } finally {
    ftp.close();
  }
});
app.get("/api/resolve-vimeo", async (req, res) => {
  const { url, quality, sourcePageUrl } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const requestedQuality = typeof quality === "string" && ["hd", "fhd", "4k"].includes(quality) ? quality : "fhd";
  const vimeoUrl = normalizeVimeoUrl(url);
  if (!vimeoUrl) {
    return res.status(400).json({ error: "A valid Vimeo URL is required" });
  }
  try {
    assertPublicAssetUrl(vimeoUrl);
  } catch (securityError) {
    return res.status(403).json({ error: securityError?.message || "Private or local video URLs are blocked." });
  }
  try {
    const source = typeof sourcePageUrl === "string" ? sourcePageUrl : "";
    const vimeoAssets = await withTimeout(
      extractVimeoVideos([vimeoUrl], requestedQuality, source),
      VIMEO_EXTRACT_TIMEOUT_MS,
      `Vimeo progressive resolve for ${vimeoUrl}`
    );
    const directVideo = vimeoAssets.videos.find(
      (video) => video.isVimeoDirect && streamHasAudio(video) && (video.displayQualityKey === requestedQuality || video.qualityRequested === requestedQuality)
    ) || (requestedQuality === "fhd" ? vimeoAssets.videos.find(
      (video) => video.isVimeoDirect && streamHasAudio(video) && (video.displayQualityKey === "hd" || video.qualityRequested === "hd")
    ) : void 0) || vimeoAssets.videos.find((video) => video.isVimeoDirect && streamHasAudio(video));
    if (!directVideo && isDirectProgressiveVideoUrl(url)) {
      try {
        const source2 = typeof sourcePageUrl === "string" ? sourcePageUrl : void 0;
        const directFallback = await buildDirectProgressiveVideoPayload(url, req, source2, { cache: false });
        if (directFallback?.url && streamHasAudio(directFallback)) {
          const selectedHeight = parseCandidateHeight(directFallback);
          return res.json({
            video: enforceMp4VideoPayload({
              ...directFallback,
              qualityRequested: requestedQuality,
              qualityExact: matchesStrictQuality(selectedHeight, requestedQuality),
              qualityFallback: !matchesStrictQuality(selectedHeight, requestedQuality),
              fallbackMessage: requestedQuality === "fhd" ? "1080p was unavailable, so the best fetched MP4 with audio was selected instead." : void 0,
              hasAudio: true,
              audioAvailable: true,
              noAudio: false
            }),
            images: vimeoAssets.images
          });
        }
      } catch (directFallbackError) {
        console.warn("Vimeo direct MP4 fallback failed:", directFallbackError?.message || directFallbackError);
      }
    }
    if (!directVideo) {
      const debug = vimeoAssets.videos.find((video) => video?.vimeoQualityDebug)?.vimeoQualityDebug;
      const qualityLabel = requestedQuality === "fhd" ? "1080p FHD" : requestedQuality === "hd" ? "720p HD" : requestedQuality.toUpperCase();
      return res.status(404).json({
        error: `No ${qualityLabel} Vimeo stream is available for this video.`,
        vimeoQualityDebug: debug
      });
    }
    const validVideo = directVideo ? directVideo.isVimeoDirect ? enforceMp4VideoPayload(directVideo) : await validateAndNormalizeVideo(directVideo, vimeoUrl) : null;
    if (validVideo) {
      const selectedHeight = parseCandidateHeight(validVideo);
      const qualityExact = matchesStrictQuality(selectedHeight, requestedQuality);
      return res.json({
        video: enforceMp4VideoPayload({
          ...validVideo,
          qualityRequested: requestedQuality,
          qualityExact,
          qualityFallback: !qualityExact,
          fallbackMessage: !qualityExact && requestedQuality === "fhd" ? `1080p was unavailable, so the best MP4 with audio was selected instead.` : validVideo?.fallbackMessage,
          hasAudio: true,
          audioAvailable: true,
          noAudio: false
        }),
        images: vimeoAssets.images
      });
    }
    return res.status(404).json({
      error: "No downloadable Vimeo progressive MP4 stream was available for this link."
    });
  } catch (error) {
    console.error("Vimeo resolve error:", error.message || error);
    const msg = String(error?.message || error || "");
    if (/HTTP Error 404|not found/i.test(msg)) {
      return res.status(404).json({ error: "This Vimeo video is unavailable (404)." });
    }
    res.status(500).json({ error: `Failed to resolve Vimeo download link: ${msg || "Unknown error"}` });
  }
});
app.get("/api/video-quality-manifest", async (req, res) => {
  const { url, sourcePageUrl } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    assertPublicAssetUrl(url);
    const manifest = await getVideoQualityManifestFast(
      url,
      typeof sourcePageUrl === "string" ? sourcePageUrl : void 0
    );
    return res.json(manifest);
  } catch (error) {
    console.warn("Video quality manifest probe skipped:", error?.message || error);
    return res.json({
      fhd: false,
      hd: false,
      audio: true,
      title: "",
      thumbnail: "",
      variants: {},
      pending: true
    });
  }
});
app.get("/api/resolve-video", async (req, res) => {
  const { url, quality } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const requestedQuality = typeof quality === "string" && ["hd", "fhd", "4k"].includes(quality) ? quality : "fhd";
  const resolverTargetUrl = isYouTubeUrl(url) ? normalizeYouTubeWatchUrl(url) : url;
  try {
    assertPublicAssetUrl(resolverTargetUrl);
  } catch (securityError) {
    return res.status(403).json({ error: securityError?.message || "Private or local video URLs are blocked." });
  }
  if (isDirectProgressiveVideoUrl(resolverTargetUrl)) {
    try {
      const sourcePageUrl = typeof req.query.sourcePageUrl === "string" ? req.query.sourcePageUrl : void 0;
      const video = await buildDirectProgressiveVideoPayload(resolverTargetUrl, req, sourcePageUrl, { cache: false });
      return res.json({ video });
    } catch (directError) {
      console.error("Direct progressive video resolve error:", directError?.message || directError);
      return res.status(500).json({ error: directError?.message || "Failed to resolve direct video metadata." });
    }
  }
  const qualityUnavailableMessage = requestedQuality === "fhd" ? "1080p stream is not available for this YouTube video." : requestedQuality === "hd" ? "720p stream is not available for this YouTube video." : "Requested quality stream is not available for this YouTube video.";
  try {
    if (isBrightcoveUrl(url)) {
      try {
        const brightcoveAssets = await extractBrightcoveVideos(url);
        const mergeCandidate = (brightcoveAssets.videos || []).find((video2) => video2?.brightcoveManifestUrl);
        const directCandidates = (mergeCandidate ? [] : brightcoveAssets.videos || []).filter((video2) => video2?.isDirect && isLikelyDirectVideoStreamUrl(String(video2.sourceStreamUrl || video2.url || "")));
        const exactCandidates = directCandidates.filter((video2) => matchesStrictQuality(parseCandidateHeight(video2), requestedQuality));
        const selected2 = await firstValidStreamCandidate(
          sortCandidatesForQuality(exactCandidates.length > 0 ? exactCandidates : directCandidates, requestedQuality),
          url,
          url
        );
        if (selected2?.url) {
          const selectedHeight2 = selected2.height || parseCandidateHeight(selected2);
          return res.json({
            video: enforceMp4VideoPayload({
              ...selected2,
              url: selected2.url,
              sourceUrl: url,
              provider: "brightcove",
              type: "mp4",
              height: selectedHeight2,
              resolution: selected2.resolution || (selectedHeight2 ? `${selectedHeight2}p` : "Best Quality"),
              qualityRequested: requestedQuality,
              qualityExact: matchesStrictQuality(selectedHeight2, requestedQuality),
              qualityFallback: !matchesStrictQuality(selectedHeight2, requestedQuality),
              displayQualityKey: matchesStrictQuality(selectedHeight2, requestedQuality) ? requestedQuality : getCleanQualityKey(selected2),
              verifiedPlayable: true,
              isDirect: true
            })
          });
        }
        const hlsInputUrl = String(mergeCandidate?.brightcoveManifestUrl || "");
        const mergedVideo = await materializeMergedMp4FromPlatform(
          url,
          requestedQuality,
          req,
          mergeCandidate?.title || directCandidates[0]?.title || "Brightcove video",
          hlsInputUrl ? { directInputUrl: hlsInputUrl, sourcePageUrl: url } : {}
        );
        return res.json({ video: mergedVideo });
      } catch (brightcoveError) {
        const brightcoveMessage = String(brightcoveError?.message || brightcoveError || "");
        if (/\bVIDEO_NOT_FOUND\b/i.test(brightcoveMessage)) {
          return res.status(404).json({
            error: "Brightcove reports that this video does not exist or is no longer available. Check the videoId with the publisher."
          });
        }
        console.warn("Brightcove resolve failed, trying universal yt-dlp route:", brightcoveError?.message || brightcoveError);
      }
    }
    if (isYouTubeUrl(url)) {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(resolverTargetUrl);
      const titleHint = await fetchYouTubeOEmbedTitle(normalizedWatchUrl);
      const sourcePageUrl2 = typeof req.query.sourcePageUrl === "string" ? req.query.sourcePageUrl : normalizedWatchUrl;
      const prepared = await prepareYouTubeQualityOutput(normalizedWatchUrl, requestedQuality, {
        titleHint,
        sourcePageUrl: sourcePageUrl2,
        exportToDownloads: false
      });
      return res.json({
        video: youTubePreparedToVideoPayload(prepared, requestedQuality, titleHint)
      });
    }
    const metadataTimeoutMs = isYouTubeUrl(url) ? 45e3 : 15e3;
    const sourcePageUrl = typeof req.query.sourcePageUrl === "string" ? req.query.sourcePageUrl : url;
    const info = await withTimeout(
      youtubedl(resolverTargetUrl, {
        dumpSingleJson: true,
        ...buildYtDlpQueryOptions(resolverTargetUrl, sourcePageUrl)
      }),
      metadataTimeoutMs,
      `Video metadata for ${url}`
    );
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const requestedDownloads = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
    const mergedCandidates = [
      ...formats,
      ...requestedDownloads,
      ...info?.url ? [{ url: info.url, ext: info.ext, vcodec: info.vcodec, acodec: info.acodec, height: info.height, tbr: info.tbr }] : []
    ];
    const normalizedCandidates = mergedCandidates.map((candidate) => {
      const normalizedUrl = sanitizeStreamUrl(String(candidate?.url || ""), resolverTargetUrl);
      return normalizedUrl ? { ...candidate, url: normalizedUrl } : null;
    }).filter(Boolean).filter((candidate) => !isExpiredStreamUrl(String(candidate.url)));
    const platformNeedsProgressiveMp4 = isXUrl(url) || isFacebookUrl(url) || isInstagramUrl(url) || isBrightcoveUrl(url);
    const platformHasAudioCandidate = normalizedCandidates.some((candidate) => streamHasAudio(candidate));
    const playableCandidates = normalizedCandidates.filter((candidate) => {
      const raw = String(candidate.url || "");
      const ext = String(candidate.ext || "").toLowerCase();
      if (isTechnicalOrUnsupportedStream(candidate)) return false;
      if (isYouTubeUrl(url) && raw.includes(".m3u8")) return false;
      if (platformNeedsProgressiveMp4) {
        if (!streamHasVideo(candidate)) return false;
        if (!streamHasAudio(candidate) && platformHasAudioCandidate) return false;
        if (ext && ext !== "mp4" && ext !== "m4v") return false;
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
        } catch (mergeError) {
          console.warn("Merged MP4 fallback failed:", mergeError?.message || mergeError);
        }
      }
      return res.status(404).json({ error: "No direct downloadable stream found for this link." });
    }
    if (!isLikelyDirectVideoStreamUrl(String(selected.url)) && !(isLikelyVideoAssetUrl(String(selected.url)) && !isYouTubeUrl(url))) {
      return res.status(404).json({ error: "No direct MP4/video stream found for this link." });
    }
    const selectedHeight = selected.height || parseCandidateHeight(selected);
    const exactQuality = matchesStrictQuality(selectedHeight, requestedQuality);
    const fallbackLabel = getCleanQualityLabel(getCleanQualityKey(selected));
    const selectedHasAudio = streamHasAudio(selected);
    const video = {
      url: selected.url,
      sourceUrl: url,
      watchUrl: isYouTubeUrl(url) ? normalizeYouTubeWatchUrl(url) : void 0,
      provider: info.extractor_key || info.extractor || "video",
      type: selected.ext || "mp4",
      title: info.title || "Video",
      thumbnail: sanitizeStreamUrl(info.thumbnail || "", resolverTargetUrl) || info.thumbnail || "",
      resolution: selected.format_note || (selected.height ? `${selected.height}p` : "Unknown"),
      formatId: selected.format_id || selected.itag || selected.id,
      width: selected.width,
      height: selectedHeight,
      qualityRequested: requestedQuality,
      qualityExact: exactQuality,
      qualityFallback: !exactQuality,
      fallbackMessage: !exactQuality && requestedQuality === "fhd" ? `1080p was unavailable, so ${fallbackLabel} was selected instead.` : void 0,
      fps: selected.fps,
      vcodec: selected.vcodec,
      acodec: selected.acodec,
      hasAudio: selectedHasAudio,
      audioAvailable: selectedHasAudio,
      noAudio: !selectedHasAudio,
      filesize: selected.filesize || selected.filesize_approx || selected.contentLength,
      duration: Number(selected.duration || info.duration || 0) || void 0,
      isDirect: true,
      verifiedPlayable: true
    };
    const payload = enforceMp4VideoPayload(video);
    if (isYouTubeUrl(url) && !selectedHasAudio) {
      return res.json({ video: wrapYouTubePlaybackStream(payload, url, requestedQuality) });
    }
    return res.json({ video: payload });
  } catch (error) {
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
    } catch (fallbackError) {
      console.error("Fallback resolve error:", fallbackError.message || fallbackError);
    }
    console.error("Universal resolve error:", error.message || error);
    if (isYouTubeUrl(url)) {
      return res.status(404).json({ error: qualityUnavailableMessage });
    }
    return res.status(500).json({ error: "Failed to resolve downloadable stream for this link." });
  }
});
app.get("/api/video-preview", async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const targetUrl = new URL2(url).href;
    assertPublicAssetUrl(targetUrl);
    const response = await axios.get(targetUrl, {
      timeout: 8e3,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const html = String(response.data || "");
    const $ = cheerio.load(html);
    const rawThumb = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || $('meta[property="og:image:url"]').attr("content") || "";
    const thumb = rawThumb ? resolveUrl(targetUrl, rawThumb) || rawThumb : "";
    const title = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").first().text().trim() || "Video link";
    const preview = {
      sourceUrl: targetUrl,
      thumbnail: thumb,
      title,
      provider: platformProviderFromUrl(targetUrl)
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
      preview.thumbnail = await generateVideoFrameThumbnail(targetUrl, targetUrl, req).catch(() => "");
    }
    return res.json({
      preview
    });
  } catch (error) {
    const targetUrl = sanitizeStreamUrl(String(url)) || String(url);
    const richPreview = isPlatformVideoUrl(targetUrl) || isLikelyHttpMediaUrl(targetUrl) ? await getVideoPreviewMetadata(targetUrl) : null;
    const frameThumbnail = !richPreview?.thumbnail && isLikelyHttpMediaUrl(targetUrl) ? await generateVideoFrameThumbnail(targetUrl, targetUrl, req).catch(() => "") : "";
    return res.status(200).json({
      preview: {
        sourceUrl: targetUrl,
        thumbnail: richPreview?.thumbnail || frameThumbnail || "",
        title: richPreview?.title || "Video link",
        provider: richPreview?.provider || platformProviderFromUrl(targetUrl)
      }
    });
  }
});
app.get("/api/font-source", async (req, res) => {
  const { url, fontUrl, fontFamily } = req.query;
  if (!url || typeof url !== "string" || !fontUrl || typeof fontUrl !== "string") {
    return res.status(400).json({ error: "url and fontUrl are required" });
  }
  try {
    const normalizedSiteUrl = new URL2(url).href;
    const { inlineStyles, fetchedCss } = await fetchCssSourceCandidates(normalizedSiteUrl);
    const fullFontUrl = fontUrl;
    const strippedFontUrl = fullFontUrl.split("?")[0];
    const basename = strippedFontUrl.split("/").pop() || "";
    const family = String(fontFamily || "").trim().toLowerCase();
    const familyNeedle = family ? family.replace(/['"]/g, "") : "";
    const allSources = [...inlineStyles, ...fetchedCss];
    const matchingSources = allSources.filter(({ css }) => {
      const text = css.toLowerCase();
      return text.includes(fullFontUrl.toLowerCase()) || text.includes(strippedFontUrl.toLowerCase()) || (basename ? text.includes(basename.toLowerCase()) : false) || (familyNeedle ? text.includes(familyNeedle) : false);
    }).map((entry) => entry.source);
    const uniqueSources = Array.from(new Set(matchingSources));
    return res.json({
      source: uniqueSources[0] || null,
      sources: uniqueSources
    });
  } catch (error) {
    console.error("Font source resolve error:", error.message || error);
    return res.status(500).json({ error: "Failed to resolve font CSS source." });
  }
});
app.post("/api/insights", async (req, res) => {
  const { url, assets: clientAssets } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const imageCacheMap = /* @__PURE__ */ new Map();
  for (const img of clientAssets?.images || []) {
    const remote = String(img?.url || "").trim();
    const cached = String(img?.cachedUrl || "").trim();
    if (remote && cached) imageCacheMap.set(remote, cached);
  }
  const applyBriefAssetPreview = (asset) => {
    if (!asset?.url) return asset;
    const cachedUrl = imageCacheMap.get(asset.url);
    return {
      ...asset,
      remote_url: asset.url,
      preview_url: cachedUrl || void 0
    };
  };
  const scoreHeroImage = (asset) => {
    let score = Number(asset?.priority || 0);
    const label = `${asset?.url || ""} ${asset?.alt || ""} ${asset?.title || ""}`.toLowerCase();
    if (/hero|banner|masthead|key-visual|keyvisual|about-/.test(label)) score += 2500;
    if (/\/wp-content\/uploads\//i.test(asset?.url || "")) score += 600;
    if (/\.jpe?g(\?|$)/i.test(asset?.url || "")) score += 120;
    return score;
  };
  const isBotWallAsset = (asset) => {
    const label = `${asset?.url || ""} ${asset?.alt || ""}`.toLowerCase();
    return /robot-suspicion|captcha|challenge|akamai|datadome|cf-chl|waf|blocked/.test(label);
  };
  const clientImageAssets = () => (clientAssets?.images || []).filter((img) => img?.url && !String(img.url).startsWith("data:")).map((img) => ({
    url: String(img.url),
    alt: "",
    source: "extracted-asset",
    priority: scoreHeroImage({ url: img.url, alt: img.url }),
    preview_url: String(img.cachedUrl || "").trim() || void 0,
    pageUrl: "",
    stage: "Awareness"
  }));
  const normalizeExactBlock = (value) => normalizeExactBlockText(value);
  const safetyKeywords = [
    "important safety information",
    "safety",
    "warnings",
    "disclaimer",
    "side effects",
    "risk information"
  ];
  const normalizeUrl = (raw) => {
    try {
      const parsed = new URL2(raw);
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"].forEach((key) => parsed.searchParams.delete(key));
      parsed.hash = "";
      return parsed.href;
    } catch {
      return "";
    }
  };
  const sameDomain = (candidate, originHost) => {
    try {
      const host = new URL2(candidate).hostname.replace(/^www\./, "").toLowerCase();
      return host === originHost || host.endsWith(`.${originHost}`);
    } catch {
      return false;
    }
  };
  const textHash = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const uniqueByText = (items) => {
    const seen = /* @__PURE__ */ new Set();
    const unique = [];
    items.forEach((item) => {
      const normalized = textHash(item);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      unique.push(item);
    });
    return unique;
  };
  const uniqueExactBlocks = (items) => {
    const seen = /* @__PURE__ */ new Set();
    const unique = [];
    items.forEach((item) => {
      const normalized = normalizeExactBlock(item);
      if (!normalized) return;
      const key = normalized.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(normalized);
    });
    return unique;
  };
  const stageFor = (text) => {
    const lower = text.toLowerCase();
    if (/(buy|get started|pricing|trial|book|contact|download|learn more|request demo)/.test(lower)) return "Conversion";
    if (/(feature|benefit|compare|study|results|proof|review|trusted|demo|efficacy|safety)/.test(lower)) return "Consideration";
    return "Awareness";
  };
  const splitSnippets = (text, min = 28, max = 280, limit = 6) => {
    return uniqueByText(
      text.split(/(?<=[.!?])\s+|[\n•]+/).map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item.length >= min && item.length <= max)
    ).slice(0, limit);
  };
  let browser;
  try {
    const seedUrl = normalizeUrl(new URL2(url).href);
    assertPublicAssetUrl(seedUrl);
    const originHost = new URL2(seedUrl).hostname.replace(/^www\./, "").toLowerCase();
    const maxDepth = 1;
    const maxPages = 5;
    const crawlBudgetMs = 16e3;
    const pageBudgetMs = 9e3;
    const crawlStart = Date.now();
    browser = await launchPuppeteerBrowser();
    const queue = [{ url: seedUrl, depth: 0 }];
    const visited = /* @__PURE__ */ new Set();
    const headingCandidates = [];
    const heroImages = [];
    const heroVideos = [];
    const valueCards = [];
    const featureCards = [];
    const testimonialCards = [];
    const visualAssets = [];
    const videos = [];
    const importantInfo = [];
    const disclaimerInfo = [];
    const legalInfo = [];
    const referenceInfo = [];
    const indicationCandidates = [];
    const isiCandidates = [];
    const keywordsRaw = [];
    const prefetchedHtml = await withTimeout(fetchSiteHtml(seedUrl), 28e3, `Insights prefetch HTML for ${seedUrl}`).catch(() => "");
    if (prefetchedHtml && !isBotWallHtml(prefetchedHtml)) {
      const $prefetch = cheerio.load(prefetchedHtml);
      const prefetchHeading = $prefetch("h1").first().text().replace(/\s+/g, " ").trim();
      if (prefetchHeading.length > 4 && !/^phyrago\.com$/i.test(prefetchHeading) && !isBotWallText(prefetchHeading)) {
        headingCandidates.push({ text: prefetchHeading, score: 1200 });
      }
      const prefetchTextBlocks = $prefetch("section, article, div, aside, footer, main, p, li").map((_, el) => $prefetch(el).text()).get();
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
    const scoreLink = (candidate) => {
      const lower = candidate.toLowerCase();
      if (/(important|safety|warning|disclaimer|risk|isi|pi|prescribing|side-effects)/.test(lower)) return 120;
      if (/(feature|benefit|about|product|learn|results|video|gallery|testimonial|review)/.test(lower)) return 70;
      return 10;
    };
    while (queue.length > 0 && visited.size < maxPages) {
      if (Date.now() - crawlStart > crawlBudgetMs) break;
      const current = queue.shift();
      if (visited.has(current.url) || current.depth > maxDepth) continue;
      visited.add(current.url);
      const page = await acquireSingleWebsitePage(browser);
      try {
        await withTimeout(
          (async () => {
            await applyPuppeteerStealth(page);
            await page.setViewport({ width: 1440, height: 1100 });
            await page.goto(current.url, { waitUntil: "domcontentloaded", timeout: 1e4 }).catch(() => void 0);
            await new Promise((resolve) => setTimeout(resolve, 600));
            let html = await page.content().catch(() => "");
            if (current.depth === 0 && (isBotWallHtml(html) || isLikelyBotWallExtract(clientAssets || {}))) {
              await page.goto(current.url, { waitUntil: "networkidle2", timeout: 4e4 }).catch(() => void 0);
              await new Promise((resolve) => setTimeout(resolve, 5e3));
              html = await page.content().catch(() => html);
            }
            const tabHandles = await page.$$('[role="tab"], button[aria-controls], button[data-tab], button[data-target], .tab, .tabs button').catch(() => []);
            for (const handle of tabHandles.slice(0, 8)) {
              try {
                await handle.click({ delay: 10 });
                await new Promise((resolve) => setTimeout(resolve, 80));
              } catch {
              }
            }
            const extracted = await page.evaluate(insightsPageEvaluate, current.url, safetyKeywords).catch(() => ({}));
            const htmlFromPage = html || await page.content().catch(() => "");
            const $ = cheerio.load(htmlFromPage || "<html></html>");
            const htmlSafety = uniqueExactBlocks(
              $('section, article, div, p, li, footer, [class*="isi" i]').map((_, el) => $(el).text()).get().map((item) => normalizeExactBlock(item)).filter((item) => item.length > 20 && !isBotWallText(item) && safetyKeywords.some((keyword) => item.toLowerCase().includes(keyword)))
            );
            const htmlDisclaimers = uniqueExactBlocks(
              $("section, article, div, p, li").map((_, el) => $(el).text()).get().map((item) => normalizeExactBlock(item)).filter((item) => item.length > 20 && /(disclaimer|not imply|terms apply|limitations|see full prescribing information|full pi|reference)/i.test(item))
            );
            const htmlLegal = uniqueExactBlocks(
              $("section, article, div, p, li").map((_, el) => $(el).text()).get().map((item) => normalizeExactBlock(item)).filter((item) => item.length > 20 && /(legal|terms of use|terms and conditions|privacy policy|copyright|all rights reserved|fair balance)/i.test(item))
            );
            const htmlReferences = uniqueExactBlocks(
              $("section, article, div, p, li").map((_, el) => $(el).text()).get().map((item) => normalizeExactBlock(item)).filter((item) => item.length > 20 && /(reference|references|bibliography|clinical trial|nct0|nct-)/i.test(item))
            );
            const extractPharmaBlocks = (items) => extractPharmaBlocksFromText(items);
            const pageTextBlocks = $("section, article, div, aside, footer, main, p, li").map((_, el) => $(el).text()).get();
            const pharmaBlocks = extractPharmaBlocks(pageTextBlocks);
            extractIndicationBlocksFromHtml(htmlFromPage).forEach((text) => {
              indicationCandidates.push({ text, source_url: current.url });
            });
            extractIsiBlocksFromHtml(htmlFromPage).forEach((text) => {
              isiCandidates.push({ text, source_url: current.url });
            });
            headingCandidates.push(...extracted.headingCandidates || []);
            heroImages.push(...(extracted.heroImages || []).map((asset) => ({ ...asset, pageUrl: current.url, stage: "Awareness" })));
            visualAssets.push(...(extracted.galleryImages || []).map((asset) => ({ ...asset, pageUrl: current.url, stage: "Awareness" })));
            const videoAssets = (extracted.videos || []).map((asset) => ({ ...asset, pageUrl: current.url, stage: "Consideration" }));
            videos.push(...videoAssets);
            heroVideos.push(...videoAssets.filter((asset) => /hero|intro|overview|video|demo|youtube|vimeo/i.test(`${asset.url} ${asset.title}`)));
            const focusSnippets = splitSnippets(
              (extracted.focusSections || []).map((section) => section.text).join(". "),
              28,
              280,
              8
            );
            valueCards.push(...focusSnippets.map((text) => ({
              title: text.split(/[:.!?]/)[0].slice(0, 90),
              text,
              stage: stageFor(text),
              source_url: current.url
            })));
            const featureSnippets = uniqueByText(
              (extracted.featureSections || []).flatMap((section) => splitSnippets(section.text, 24, 320, 4))
            ).slice(0, 18);
            featureCards.push(
              ...featureSnippets.map((text, idx) => ({
                title: text.split(/[:.!?]/)[0].slice(0, 90),
                text,
                image: extracted.featureSections?.[idx]?.image || "",
                stage: stageFor(text),
                source_url: current.url
              }))
            );
            testimonialCards.push(
              ...(extracted.testimonialSections || []).slice(0, 10).map((section) => {
                const quoteMatch = section.text.match(/[“"]([^”"]{20,360})[”"]/);
                const quote = (quoteMatch?.[1] || section.text).replace(/\s+/g, " ").trim();
                const nameMatch = section.text.match(/\b(?:by|from|—|-)\s+([A-Z][A-Za-z .'-]{2,70})/);
                return {
                  quote,
                  name: (nameMatch?.[1] || section.title || "").trim(),
                  stage: "Consideration",
                  source_url: current.url
                };
              })
            );
            importantInfo.push(
              ...(extracted.safetyBlocks || []).map((text) => ({ text, source_url: current.url })),
              ...htmlSafety.map((text) => ({ text, source_url: current.url }))
            );
            disclaimerInfo.push(
              ...(extracted.disclaimerBlocks || []).map((text) => ({ text, source_url: current.url })),
              ...htmlDisclaimers.map((text) => ({ text, source_url: current.url }))
            );
            legalInfo.push(
              ...(extracted.legalBlocks || []).map((text) => ({ text, source_url: current.url })),
              ...htmlLegal.map((text) => ({ text, source_url: current.url }))
            );
            referenceInfo.push(
              ...(extracted.referenceBlocks || []).map((text) => ({ text, source_url: current.url })),
              ...htmlReferences.map((text) => ({ text, source_url: current.url }))
            );
            indicationCandidates.push(
              ...pharmaBlocks.indication.map((text) => ({ text, source_url: current.url }))
            );
            isiCandidates.push(
              ...pharmaBlocks.isi.map((text) => ({ text, source_url: current.url })),
              ...(extracted.safetyBlocks || []).filter((text) => /important safety information/i.test(text)).map((text) => ({ text, source_url: current.url }))
            );
            keywordsRaw.push(...extracted.rawKeywords || []);
            if (current.depth < maxDepth && Date.now() - crawlStart <= crawlBudgetMs) {
              const candidates = uniqueByText(extracted.internalLinks || []).filter((candidate) => !/^(javascript:|mailto:|tel:)/i.test(candidate)).filter((candidate) => !/\.(pdf|zip|docx?|xlsx?|pptx?)($|\?)/i.test(candidate)).sort((a, b) => scoreLink(b) - scoreLink(a));
              candidates.forEach((candidate) => {
                const normalized = normalizeUrl(candidate);
                if (!normalized) return;
                if (!sameDomain(normalized, originHost)) return;
                if (visited.has(normalized) || queue.some((item) => item.url === normalized)) return;
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
      } catch (pageError) {
        console.warn(`Insights page crawl skipped for ${current.url}:`, pageError?.message || pageError);
      } finally {
        await page.close().catch(() => void 0);
      }
    }
    const uniqueAssetMap = (assets) => Array.from(new Map(assets.filter((asset) => asset?.url).map((asset) => [asset.url, asset])).values());
    let dedupedHeroImages = uniqueAssetMap([
      ...clientImageAssets(),
      ...heroImages.filter((asset) => !isBotWallAsset(asset))
    ]).sort((a, b) => scoreHeroImage(b) - scoreHeroImage(a)).slice(0, 16);
    const dedupedHeroVideos = uniqueAssetMap(heroVideos.filter((asset) => !isBotWallAsset(asset))).slice(0, 8);
    const dedupedVideos = uniqueAssetMap(videos.filter((asset) => !isBotWallAsset(asset))).slice(0, 20);
    let dedupedGalleryAssets = uniqueAssetMap([
      ...clientImageAssets(),
      ...visualAssets.filter((asset) => !isBotWallAsset(asset))
    ]).filter((asset) => !dedupedHeroImages.some((hero) => hero.url === asset.url)).slice(0, 30);
    const dedupedValueCards = uniqueByText(valueCards.map((card) => card.text)).slice(0, 12).map((text) => {
      const card = valueCards.find((item) => textHash(item.text) === textHash(text));
      return card || { title: text.slice(0, 90), text, stage: stageFor(text), source_url: seedUrl };
    });
    const dedupedFeatureCards = uniqueByText(featureCards.map((card) => card.text)).slice(0, 18).map((text) => {
      const card = featureCards.find((item) => textHash(item.text) === textHash(text));
      return card || { title: text.slice(0, 90), text, stage: stageFor(text), source_url: seedUrl };
    });
    const dedupedTestimonialCards = uniqueByText(testimonialCards.map((card) => card.quote)).slice(0, 10).map((quote) => {
      const card = testimonialCards.find((item) => textHash(item.quote) === textHash(quote));
      return card || { quote, name: "", stage: "Consideration", source_url: seedUrl };
    });
    const heading = headingCandidates.filter((item) => !isBotWallText(item.text)).sort((a, b) => b.score - a.score)[0]?.text || "";
    const resolvedHeading = heading && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(heading.trim()) ? heading : dedupedValueCards[0]?.title || dedupedValueCards[0]?.text?.slice(0, 120) || heading;
    const keywordFrequency = keywordsRaw.reduce((acc, keyword) => {
      const normalized = keyword.toLowerCase();
      acc[normalized] = (acc[normalized] || 0) + 1;
      return acc;
    }, {});
    const keywords = Object.entries(keywordFrequency).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([keyword]) => keyword);
    const mainFocus = dedupedValueCards[0]?.text || "";
    const adHeadlines = uniqueByText([
      heading,
      mainFocus ? mainFocus.split(/[.!?]/)[0] : "",
      keywords.length >= 2 ? `${keywords[0][0].toUpperCase() + keywords[0].slice(1)} for ${keywords[1]}` : ""
    ]).filter(Boolean).slice(0, 6);
    const uniqueTextBlocksWithSource = (items) => {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      items.forEach((item) => {
        if (isBotWallText(item.text)) return;
        const normalized = normalizeExactBlock(item.text);
        if (!normalized || isBotWallText(normalized)) return;
        const key = normalized.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ text: normalized, source_url: item.source_url || seedUrl });
      });
      return out;
    };
    const importantInformationBlocks = uniqueTextBlocksWithSource(importantInfo).slice(0, 24);
    const importantKeySet = new Set(importantInformationBlocks.map((item) => item.text.toLowerCase().replace(/\s+/g, " ")));
    const disclaimersBlocks = uniqueTextBlocksWithSource(disclaimerInfo).filter((item) => !importantKeySet.has(item.text.toLowerCase().replace(/\s+/g, " "))).slice(0, 24);
    const disclaimerKeySet = new Set(disclaimersBlocks.map((item) => item.text.toLowerCase().replace(/\s+/g, " ")));
    const legalBlocks = uniqueTextBlocksWithSource(legalInfo).filter((item) => !importantKeySet.has(item.text.toLowerCase().replace(/\s+/g, " "))).filter((item) => !disclaimerKeySet.has(item.text.toLowerCase().replace(/\s+/g, " "))).slice(0, 24);
    const legalKeySet = new Set(legalBlocks.map((item) => item.text.toLowerCase().replace(/\s+/g, " ")));
    const referencesBlocks = uniqueTextBlocksWithSource(referenceInfo).filter((item) => !importantKeySet.has(item.text.toLowerCase().replace(/\s+/g, " "))).filter((item) => !disclaimerKeySet.has(item.text.toLowerCase().replace(/\s+/g, " "))).filter((item) => !legalKeySet.has(item.text.toLowerCase().replace(/\s+/g, " "))).slice(0, 30);
    const pickLongestExactBlock = (items) => {
      const blocks = uniqueTextBlocksWithSource(items);
      if (!blocks.length) return { text: "", source_url: seedUrl };
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
      const focusCandidate = mainFocus.length > 40 ? mainFocus : "";
      const headingCandidate = resolvedHeading.length > 30 && /\b(for|treatment|approved|indicated)\b/i.test(resolvedHeading) ? resolvedHeading : "";
      const fallbackText = focusCandidate || headingCandidate;
      if (fallbackText.length > 40) {
        indicationBlock = { text: fallbackText, source_url: seedUrl };
      }
    }
    const pickCta = (text) => {
      const match = text.match(/\b(get started|learn more|contact us|book now|request demo|download|buy now|sign up|try free)\b/i);
      return match?.[0] || adHeadlines[0] || "Learn more";
    };
    const subheadingCandidate = dedupedValueCards[1]?.text || dedupedFeatureCards[0]?.text || mainFocus || "";
    const buildBriefTabSlides = (cards, images, videos2, preferVideoGallery) => {
      const slides = [];
      for (let i = 0; i < 3; i += 1) {
        const card = cards[i];
        const slideImage = images[i] || images[0] || null;
        if (!card && !slideImage) continue;
        const slideHeading = card?.title || (card?.text ? card.text.slice(0, 90) : card?.quote ? card.quote.slice(0, 90) : "");
        const slideBody = card?.text || card?.quote || "";
        if (!slideHeading && !slideBody && !slideImage) continue;
        const slideVideos = videos2.slice(i * 2, i * 2 + 3);
        const useGallery = preferVideoGallery && slideVideos.length > 0;
        slides.push({
          layout: useGallery ? "video-gallery" : "image-text",
          heading: slideHeading || (slideImage?.alt || slideImage?.title || "Supporting visual"),
          body: slideBody,
          cta: pickCta(slideBody || slideHeading || "Learn more"),
          image: useGallery ? null : slideImage,
          media_assets: useGallery ? slideVideos : []
        });
      }
      return slides;
    };
    const tabTwoCards = [
      ...dedupedFeatureCards.slice(0, 2),
      ...dedupedValueCards.slice(1, 2)
    ].slice(0, 3);
    const tabThreeCards = [
      ...dedupedFeatureCards.slice(2, 5),
      ...dedupedTestimonialCards.slice(0, 2),
      ...dedupedValueCards.slice(2, 4)
    ].slice(0, 3);
    const briefTabs = [
      {
        id: 1,
        label: "Tab 1",
        layout: "hero-video",
        heading: resolvedHeading || "Campaign heading",
        subheading: subheadingCandidate ? subheadingCandidate.slice(0, 220) : void 0,
        cta: pickCta(`${resolvedHeading} ${mainFocus}`),
        hero_video: applyBriefAssetPreview(dedupedHeroVideos[0] || dedupedVideos[0] || null),
        hero_image: applyBriefAssetPreview(dedupedHeroImages[0] || null),
        slides: []
      },
      {
        id: 2,
        label: "Tab 2",
        layout: "slides",
        slides: buildBriefTabSlides(
          tabTwoCards.length > 0 ? tabTwoCards : dedupedValueCards,
          dedupedGalleryAssets,
          dedupedVideos,
          dedupedVideos.length > 0
        ).map((slide) => ({
          ...slide,
          image: slide.image ? applyBriefAssetPreview(slide.image) : null,
          media_assets: (slide.media_assets || []).map((asset) => applyBriefAssetPreview(asset))
        }))
      },
      {
        id: 3,
        label: "Tab 3",
        layout: "slides",
        slides: buildBriefTabSlides(
          tabThreeCards.length > 0 ? tabThreeCards : dedupedTestimonialCards,
          dedupedGalleryAssets.slice(3),
          dedupedVideos.slice(3),
          dedupedVideos.length > 2
        ).map((slide) => ({
          ...slide,
          image: slide.image ? applyBriefAssetPreview(slide.image) : null,
          media_assets: (slide.media_assets || []).map((asset) => applyBriefAssetPreview(asset))
        }))
      }
    ];
    const responsePayload = {
      heading: resolvedHeading,
      hero_images: dedupedHeroImages,
      hero_videos: dedupedHeroVideos,
      main_focus: mainFocus,
      main_focus_cards: dedupedValueCards,
      features: dedupedFeatureCards.map((card) => card.text).slice(0, 12),
      feature_cards: dedupedFeatureCards,
      testimonials: dedupedTestimonialCards.map((card) => card.quote).slice(0, 10),
      testimonial_cards: dedupedTestimonialCards,
      gallery: dedupedGalleryAssets.map((asset) => asset.url),
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
      crawled_pages: Array.from(visited)
    };
    res.json(responsePayload);
  } catch (error) {
    console.error("Insights extraction error:", error.message || error);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ""))) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: "Failed to extract insights from this site." });
  } finally {
    await closePuppeteerBrowser(browser);
  }
});
app.post("/api/download-zip", async (req, res) => {
  const { urls, items } = req.body;
  const requestedList = items || urls;
  if (!requestedList || !Array.isArray(requestedList)) {
    return res.status(400).json({ error: "Array of items or urls is required" });
  }
  const seenFontOutputs = /* @__PURE__ */ new Set();
  const list = requestedList.filter((item) => {
    if (!item || typeof item !== "object" || item.assetType !== "font") return true;
    const family = normalizeFontFamilyToken(String(item.fontFamily || item.familyFolder || item.filenameBase || "font"));
    const weight = String(item.fontWeight || "400").trim().toLowerCase();
    const style = String(item.fontStyle || "normal").trim().toLowerCase();
    const format = String(item.toFormat || item.originalFormat || "ttf").trim().toLowerCase();
    const key = `${family}|${weight}|${style}|${format}`;
    if (seenFontOutputs.has(key)) return false;
    seenFontOutputs.add(key);
    return true;
  });
  try {
    const zipFailures = [];
    const usedZipNames = /* @__PURE__ */ new Set();
    const uniqueZipFilename = (filename) => uniqueFilenameInSet(filename, usedZipNames);
    const zipImageStats = {
      selected: list.filter((item) => typeof item === "object" && item?.assetType === "image").length,
      cached: 0,
      skipped: 0
    };
    console.debug("[image-zip:start]", {
      selectedCount: list.length,
      imageSelectedCount: zipImageStats.selected
    });
    const zipCacheOnly = { cacheOnly: true };
    const zipPageUrl = readSourcePageUrl(req);
    const zipFontConvertTimeoutMs = 12e4;
    const zipConvertTimeoutMs = 15e3;
    const zipImageConvertTimeoutMs = 45e3;
    const zipSkipBrowser = true;
    const buildZipEntry = async (item, index) => {
      const rawUrl = typeof item === "string" ? item : item.url;
      if (!rawUrl || typeof rawUrl !== "string") {
        return { ok: false, failure: { url: String(rawUrl || ""), assetType: "asset", status: "failed-download", reason: "missing url" } };
      }
      const manifestUrl = typeof item === "object" && typeof item.originalUrl === "string" && item.originalUrl ? item.originalUrl : rawUrl;
      const manifestType = typeof item === "object" && typeof item.assetType === "string" ? item.assetType : "asset";
      const manifestStatus = typeof item === "object" && typeof item.status === "string" && item.status ? item.status : "failed-download";
      const isFontConversion = typeof item === "object" && item.assetType === "font" && item.toFormat && ["woff", "woff2", "ttf", "otf", "eot", "svg"].includes(String(item.toFormat).toLowerCase());
      const isImageConversion = typeof item === "object" && item.assetType === "image";
      const isVideoAsset = typeof item === "object" && item.assetType === "video";
      try {
        if (rawUrl.startsWith("data:") && !isFontConversion) {
          const matches = rawUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            let buffer = Buffer.from(matches[2], "base64");
            let ext = matches[1].split("/")[1]?.split("+")[0] || "bin";
            if (ext === "jpeg") ext = "jpg";
            if (ext === "svg" || ext === "svg+xml") {
              ext = "svg";
              buffer = normalizeSvgBufferForIllustrator(buffer);
            }
            const filename = typeof item === "object" ? deriveAssetFilename({
              metadataFilename: typeof item.filename === "string" ? item.filename : item.metadataFilename,
              preferredBase: typeof item.filenameBase === "string" ? item.filenameBase : void 0,
              format: ext,
              fallbackBase: `inline-image-${index + 1}`
            }) : `inline-image-${index + 1}.${ext}`;
            return { ok: true, entry: { name: filename, buffer } };
          }
          throw new Error("Invalid data URL");
        }
        if (isFontConversion) {
          const requestedCachePath = typeof item.cachedPath === "string" ? item.cachedPath.trim() : "";
          const requestUrl = requestedCachePath || rawUrl;
          const url2 = requestUrl.startsWith("data:") ? requestUrl : assertAssetUrlAllowed(requestUrl);
          const cacheProbe = (!url2.startsWith("data:") ? await readAssetBufferFromCache(url2, "font") : null) || (manifestUrl && manifestUrl !== requestUrl ? await readAssetBufferFromCache(manifestUrl, "font") : null);
          const fontExtras = {
            originalUrl: manifestUrl,
            metadataFilename: typeof item.metadataFilename === "string" ? item.metadataFilename : void 0,
            refererPageUrl: resolveFontRefererPage(
              typeof item.cssSource === "string" ? item.cssSource : "",
              zipPageUrl || ""
            ) || void 0,
            cssSource: typeof item.cssSource === "string" ? item.cssSource : void 0,
            fontFamily: typeof item.fontFamily === "string" ? item.fontFamily : typeof item.familyFolder === "string" ? item.familyFolder : void 0,
            fontWeight: typeof item.fontWeight === "string" ? item.fontWeight : void 0,
            fontStyle: typeof item.fontStyle === "string" ? item.fontStyle : void 0,
            preferInlineConversion: true,
            timeoutMs: 65e3,
            fixVerticalMetrics: item.fixVerticalMetrics !== false
          };
          const toFormat = normalizeFontFormat(String(item.toFormat || "ttf"));
          const originalFormat = normalizeFontFormat(String(item.originalFormat || "unknown"));
          const filenameBase = typeof item.filenameBase === "string" ? item.filenameBase : "font";
          const familyFolder = typeof item.familyFolder === "string" ? item.familyFolder : filenameBase;
          const detectedCachedFormat = cacheProbe ? detectFontFormatFromBuffer(cacheProbe.buffer) : "";
          const zipName = typeof item.zipEntryName === "string" && item.zipEntryName.trim() ? item.zipEntryName.trim() : buildFontZipEntryName(filenameBase, toFormat, familyFolder);
          if (cacheProbe?.buffer?.length && (detectedCachedFormat === toFormat || !detectedCachedFormat && originalFormat === toFormat)) {
            return { ok: true, entry: { name: zipName, buffer: cacheProbe.buffer } };
          }
          const runFontZipConvert = (cacheOnly) => convertFontAsset(
            url2,
            toFormat,
            originalFormat,
            filenameBase,
            {
              ...fontExtras,
              ...cacheProbe ? { prefetched: cacheProbe } : cacheOnly ? zipCacheOnly : {}
            }
          );
          let converted2;
          try {
            converted2 = await runFontZipConvert(!cacheProbe);
          } catch (cacheError) {
            const reason = String(cacheError?.message || cacheError || "");
            if (!cacheProbe && /not cached|valid font|decode|conversion|timeout|fetch/i.test(reason)) {
              converted2 = await runFontZipConvert(false);
            } else {
              throw cacheError;
            }
          }
          if (!converted2.buffer?.length) {
            throw new Error(`Font file is empty (${converted2?.format || toFormat})`);
          }
          const actualFormat = detectFontFormatFromBuffer(converted2.buffer) || normalizeFontFormat(String(converted2?.format || ""));
          if (actualFormat !== toFormat) {
            throw new Error(
              `Requested ${toFormat.toUpperCase()} but conversion produced ${(actualFormat || "unknown").toUpperCase()}.`
            );
          }
          if (!isValidFontBuffer(converted2.buffer, toFormat)) {
            throw new Error(`Converted font failed exact ${toFormat.toUpperCase()} binary validation.`);
          }
          if (toFormat === "ttf" && !isInstallableTtfBuffer(converted2.buffer)) {
            throw new Error("TTF conversion produced a non-installable TTF font file.");
          }
          return { ok: true, entry: { name: zipName, buffer: converted2.buffer } };
        }
        if (isImageConversion) {
          const requestedCachePath = typeof item.cachedPath === "string" ? item.cachedPath.trim() : "";
          const requestUrl = requestedCachePath || rawUrl;
          const url2 = assertAssetUrlAllowed(requestUrl);
          let cacheProbe = await readAssetBufferFromCache(url2, "image") || (manifestUrl && manifestUrl !== requestUrl ? await readAssetBufferFromCache(manifestUrl, "image") : null);
          if (!cacheProbe && !String(url2 || "").startsWith("data:")) {
            const ensured = await withTimeout(
              ensureImageCachedForDownload(url2, manifestUrl || url2, zipPageUrl),
              45e3,
              `ZIP image cache fetch for ${manifestUrl || url2}`
            ).catch(() => null);
            cacheProbe = ensured?.cached || null;
          }
          if (cacheProbe) zipImageStats.cached += 1;
          console.debug("[image-zip:item]", {
            id: typeof item.id === "string" ? item.id : void 0,
            url: manifestUrl,
            mimeType: typeof item.mimeType === "string" ? item.mimeType : cacheProbe?.contentType || "",
            cachePath: requestedCachePath || await getAssetCacheDebugPath(url2, "image"),
            cache: cacheProbe ? "hit" : "miss"
          });
          if (item?.preserveOriginal === true || String(item?.preserveOriginal || "").toLowerCase() === "true") {
            if (!cacheProbe || !isValidImageBuffer(cacheProbe.buffer, cacheProbe.contentType)) {
              throw new Error(`Downloaded asset is not a valid image: ${manifestUrl || url2}`);
            }
            let sourceFormat = normalizeRasterFormat(
              detectImageFormatFromBuffer(cacheProbe.buffer) || inferImageTypeFromContentType(cacheProbe.contentType) || inferImageTypeFromUrl(manifestUrl || url2, cacheProbe.contentType) || getAssetTypeFromUrl(manifestUrl || url2, "bin")
            );
            const preferredZipName3 = typeof item.zipEntryName === "string" ? item.zipEntryName.trim() : "";
            const requestedZipFormat = normalizeRasterFormat(
              preferredZipName3.match(/\.([a-z0-9]+)$/i)?.[1] || String(item.filename || item.metadataFilename || "").match(/\.([a-z0-9]+)$/i)?.[1] || ""
            );
            let entryBuffer3 = sourceFormat === "svg" ? normalizeSvgBufferForIllustrator(cacheProbe.buffer) : cacheProbe.buffer;
            if (["png", "jpg"].includes(requestedZipFormat) && sourceFormat !== requestedZipFormat) {
              const converted3 = await withTimeout(
                getCachedConvertedImage(url2, requestedZipFormat, {
                  prefetched: {
                    buffer: cacheProbe.buffer,
                    contentType: cacheProbe.contentType || guessContentTypeFromPath(String(item.cachedPath || url2)) || "application/octet-stream"
                  },
                  filenameBase: typeof item.filenameBase === "string" ? item.filenameBase : void 0,
                  originalUrl: manifestUrl,
                  metadataFilename: typeof item.metadataFilename === "string" ? item.metadataFilename : void 0,
                  refererPageUrl: zipPageUrl || void 0,
                  skipBrowser: zipSkipBrowser
                }),
                zipImageConvertTimeoutMs,
                `ZIP image preserve conversion for ${manifestUrl || url2}`
              );
              entryBuffer3 = converted3.buffer;
              sourceFormat = normalizeRasterFormat(converted3.format || requestedZipFormat);
            }
            const fallbackName = buildDownloadFilename(
              manifestUrl || url2,
              sourceFormat,
              typeof item.filenameBase === "string" ? item.filenameBase : void 0,
              {
                metadataFilename: typeof item.metadataFilename === "string" ? item.metadataFilename : void 0,
                contentDisposition: cacheProbe.contentDisposition
              }
            );
            const entryName3 = preferredZipName3 ? reconcileZipEntryNameWithBuffer(preferredZipName3, entryBuffer3) : reconcileImageFilenameWithBuffer(fallbackName, entryBuffer3, cacheProbe.contentType);
            return { ok: true, entry: { name: entryName3, buffer: entryBuffer3 } };
          }
          const zipTargetFormat = normalizeRasterFormat(
            typeof item.selectedFormat === "string" ? item.selectedFormat : typeof item.toFormat === "string" ? item.toFormat : ""
          );
          const needsRasterConvert = ["png", "jpg"].includes(zipTargetFormat);
          const imageZipExtras = {
            filenameBase: typeof item.filenameBase === "string" ? item.filenameBase : void 0,
            originalUrl: manifestUrl,
            metadataFilename: typeof item.metadataFilename === "string" ? item.metadataFilename : void 0,
            refererPageUrl: zipPageUrl || void 0,
            skipBrowser: zipSkipBrowser
          };
          const runImageZipConvert = (cacheOnly) => withTimeout(
            getCachedConvertedImage(url2, needsRasterConvert ? zipTargetFormat : void 0, {
              ...imageZipExtras,
              ...cacheProbe ? {
                prefetched: {
                  buffer: cacheProbe.buffer,
                  contentType: cacheProbe.contentType || guessContentTypeFromPath(String(item.cachedPath || url2)) || "application/octet-stream"
                }
              } : cacheOnly ? zipCacheOnly : {}
            }),
            needsRasterConvert ? zipImageConvertTimeoutMs : zipConvertTimeoutMs,
            `ZIP image conversion for ${url2}`
          );
          let converted2;
          try {
            converted2 = await runImageZipConvert(false);
          } catch (cacheError) {
            const reason = String(cacheError?.message || cacheError || "");
            if (!cacheProbe && /not cached|valid image|conversion|timeout|fetch/i.test(reason)) {
              converted2 = await runImageZipConvert(true);
            } else {
              throw cacheError;
            }
          }
          if (needsRasterConvert) {
            const expected = zipTargetFormat;
            if (!isValidRasterOutputBuffer(converted2.buffer, expected)) {
              throw new Error(`ZIP entry is not valid ${expected.toUpperCase()} binary`);
            }
            if (converted2.filename.toLowerCase().endsWith(".webp") || converted2.filename.toLowerCase().endsWith(".avif")) {
              throw new Error("ZIP entry must not use WEBP/AVIF extension when PNG/JPG conversion was requested");
            }
          }
          const entryBuffer2 = detectImageFormatFromBuffer(converted2.buffer) === "svg" ? normalizeSvgBufferForIllustrator(converted2.buffer) : converted2.buffer;
          const preferredZipName2 = typeof item.zipEntryName === "string" ? item.zipEntryName.trim() : "";
          const entryName2 = preferredZipName2 ? reconcileZipEntryNameWithBuffer(preferredZipName2, entryBuffer2) : reconcileImageFilenameWithBuffer(converted2.filename, entryBuffer2);
          return { ok: true, entry: { name: entryName2, buffer: entryBuffer2 } };
        }
        if (isVideoAsset) {
          return {
            ok: false,
            failure: {
              url: manifestUrl,
              assetType: manifestType,
              status: manifestStatus,
              reason: "Video files must be downloaded directly (FHD.mp4 / HD.mp4), not as ZIP."
            }
          };
        }
        const url = assertAssetUrlAllowed(rawUrl);
        const looksLikeVideo = isLikelyDirectVideoStreamUrl(url) || isLikelyVideoAssetUrl(url) || /\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|$)/i.test(url);
        const looksLikeFont = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url);
        if (looksLikeVideo) {
          return {
            ok: false,
            failure: {
              url: manifestUrl,
              assetType: "video",
              status: "failed-download",
              reason: "Video streams must be downloaded directly (FHD.mp4 / HD.mp4), not as ZIP."
            }
          };
        }
        if (looksLikeFont) {
          const sourceFormat = getFontFormatFromUrlOrType(url);
          const filenameBase = typeof item?.filenameBase === "string" ? item.filenameBase : "font";
          const familyFolder = typeof item?.familyFolder === "string" ? item.familyFolder : filenameBase;
          if (item?.preserveOriginal === true || String(item?.preserveOriginal || "").toLowerCase() === "true") {
            const fetched = await fetchRemoteFontBuffer(url, zipPageUrl || "");
            const detectedFormat = detectFontFormatFromBuffer(fetched.buffer) || sourceFormat || "font";
            const metadataFilename = typeof item?.metadataFilename === "string" ? item.metadataFilename : void 0;
            const preferredZipName2 = typeof item?.zipEntryName === "string" ? item.zipEntryName.trim() : "";
            const fallbackName = buildDownloadFilename(manifestUrl || url, detectedFormat, filenameBase, {
              metadataFilename,
              contentDisposition: fetched.contentDisposition
            });
            return {
              ok: true,
              entry: {
                name: preferredZipName2 || fallbackName,
                buffer: fetched.buffer
              }
            };
          }
          const runFontZipFetch = (cacheOnly) => convertFontAsset(url, "ttf", sourceFormat, filenameBase, {
            originalUrl: manifestUrl,
            preferInlineConversion: true,
            timeoutMs: 65e3,
            ...cacheOnly ? zipCacheOnly : {}
          });
          let converted2;
          try {
            converted2 = await runFontZipFetch(true);
          } catch (cacheError) {
            const reason = String(cacheError?.message || cacheError || "");
            if (/not cached|valid font|conversion|timeout|fetch/i.test(reason)) {
              converted2 = await runFontZipFetch(false);
            } else {
              throw cacheError;
            }
          }
          if (!converted2.buffer?.length) {
            throw new Error("Converted font is empty (ttf)");
          }
          return {
            ok: true,
            entry: {
              name: buildFontZipEntryName(filenameBase, converted2.format || "ttf", familyFolder),
              buffer: converted2.buffer
            }
          };
        }
        const runGenericImageZipFetch = (cacheOnly) => withTimeout(
          getCachedConvertedImage(url, void 0, {
            originalUrl: manifestUrl,
            refererPageUrl: zipPageUrl || void 0,
            skipBrowser: zipSkipBrowser,
            ...cacheOnly ? zipCacheOnly : {}
          }),
          zipConvertTimeoutMs,
          `ZIP image conversion for ${url}`
        );
        let converted;
        try {
          converted = await runGenericImageZipFetch(true);
        } catch (cacheError) {
          const reason = String(cacheError?.message || cacheError || "");
          if (/not cached|valid image|conversion|timeout|fetch/i.test(reason)) {
            converted = await runGenericImageZipFetch(false);
          } else {
            throw cacheError;
          }
        }
        const entryBuffer = detectImageFormatFromBuffer(converted.buffer) === "svg" ? normalizeSvgBufferForIllustrator(converted.buffer) : converted.buffer;
        const preferredZipName = typeof item?.zipEntryName === "string" ? item.zipEntryName.trim() : "";
        const entryName = preferredZipName ? reconcileZipEntryNameWithBuffer(preferredZipName, entryBuffer) : reconcileImageFilenameWithBuffer(converted.filename, entryBuffer);
        return { ok: true, entry: { name: entryName, buffer: entryBuffer } };
      } catch (e) {
        console.error(`Failed to add ${rawUrl} to zip:`, e.message || e);
        if (isImageConversion) zipImageStats.skipped += 1;
        const failure = {
          url: manifestUrl,
          assetType: manifestType,
          status: manifestStatus,
          reason: String(e?.message || e || "download failed")
        };
        if (typeof item === "object") {
          if (typeof item.toFormat === "string") failure.toFormat = item.toFormat;
          if (typeof item.filenameBase === "string") failure.filenameBase = item.filenameBase;
        }
        return { ok: false, failure };
      }
    };
    const zipConcurrency = list.length > 24 ? 6 : list.length > 12 ? 8 : Math.min(12, Math.max(4, list.length));
    const zipBudgetMs = Math.min(3e5, 3e4 + list.length * 8e3);
    const buildResults = await withTimeout(
      mapWithConcurrency(list, zipConcurrency, (item, index) => buildZipEntry(item, index)),
      zipBudgetMs,
      "ZIP asset build"
    );
    const zipEntries = [];
    for (const result of buildResults) {
      if (!result) continue;
      if (result.ok) {
        const entryName = result.entry.name.includes("/") ? uniqueZipPathInSet(result.entry.name, usedZipNames) : uniqueZipFilename(result.entry.name);
        if (!result.entry.buffer?.length) continue;
        zipEntries.push({ name: entryName, buffer: result.entry.buffer });
      } else {
        const failure = result.failure;
        zipFailures.push(failure);
        if (failure.assetType === "font" && failure.toFormat) {
          const base = (failure.filenameBase || "font").replace(/\.[^/.]+$/, "");
          const note = [
            `Font conversion to ${String(failure.toFormat).toUpperCase()} failed.`,
            `Font: ${base}`,
            `URL: ${failure.url}`,
            `Reason: ${failure.reason}`,
            "The original font file may still be present in this ZIP under its source extension (WOFF2/TTF/WOFF).",
            ""
          ].join("\n");
          zipEntries.push({
            name: uniqueZipFilename(`${base}.${failure.toFormat}.conversion-failed.txt`),
            buffer: Buffer.from(note, "utf8")
          });
        }
      }
    }
    console.debug("[image-zip:summary]", {
      selectedCount: zipImageStats.selected,
      cachedCount: zipImageStats.cached,
      skippedCount: zipImageStats.skipped
    });
    if (zipFailures.length > 0) {
      const manifest = [
        "Some assets were not in the extraction cache.",
        "Re-extract the page to fetch them once, then download the ZIP again.",
        "",
        ...zipFailures.map((failure, index) => [
          `${index + 1}. ${failure.url}`,
          `   type: ${failure.assetType}`,
          failure.toFormat ? `   requested format: ${failure.toFormat}` : "",
          failure.filenameBase ? `   filename base: ${failure.filenameBase}` : "",
          `   status: ${failure.status}`,
          `   reason: ${failure.reason}`
        ].filter(Boolean).join("\n")),
        ""
      ].join("\n");
      zipEntries.push({
        name: uniqueZipFilename("asset-paths.txt"),
        buffer: Buffer.from(manifest, "utf8")
      });
      const fontFailures = zipFailures.filter((failure) => failure.assetType === "font");
      if (fontFailures.length > 0) {
        const fontReport = [
          "Font conversion failures",
          "Each failed target format has a matching *.conversion-failed.txt note in this ZIP.",
          "",
          ...fontFailures.map((failure, index) => [
            `${index + 1}. ${failure.filenameBase || failure.url}`,
            `   target: ${failure.toFormat || "unknown"}`,
            `   url: ${failure.url}`,
            `   reason: ${failure.reason}`
          ].join("\n")),
          ""
        ].join("\n");
        zipEntries.push({
          name: uniqueZipFilename("font-conversion-report.txt"),
          buffer: Buffer.from(fontReport, "utf8")
        });
      }
    }
    if (zipEntries.length === 0) {
      return res.status(400).json({
        error: "No cached assets available for ZIP. Extract the page first so assets are saved locally, then download again."
      });
    }
    const fontOnlyBatch = list.length > 0 && list.every(
      (item) => item && typeof item === "object" && item.assetType === "font"
    );
    if (req.body?.save === true && fontOnlyBatch) {
      const fontEntries = zipEntries.filter((entry) => /\.(?:woff2?|ttf|otf|eot)$/i.test(entry.name));
      if (fontEntries.length === 0) {
        return res.status(400).json({ error: "No converted font files were available to save." });
      }
      const savedFonts = await Promise.all(
        fontEntries.map(
          (entry) => saveBufferToDownloads(
            entry.buffer,
            path3.basename(entry.name),
            "Font download",
            zipPageUrl,
            "font"
          )
        )
      );
      const folderPath = savedFonts[0]?.folderPath || resolveCreativeAssetsDir(zipPageUrl, "Fonts", {
        sectionMode: lastExtractionSectionMode
      });
      res.setHeader("X-Zip-Added-Count", String(savedFonts.length));
      res.setHeader("X-Zip-Failed-Count", String(zipFailures.length));
      return res.json({
        ok: true,
        filename: "Fonts",
        downloadPath: folderPath,
        localPath: folderPath,
        folderPath,
        addedCount: savedFonts.length,
        failedCount: zipFailures.length
      });
    }
    const archive = archiver2("zip", { zlib: { level: 0 } });
    const addedCount = zipEntries.filter((entry) => entry.name !== "asset-paths.txt").length;
    for (const entry of zipEntries) {
      archive.append(entry.buffer, { name: entry.name });
    }
    if (req.body?.save === true || String(req.body?.save || "").toLowerCase() === "true") {
      const requestedFilename = typeof req.body?.filename === "string" && req.body.filename.trim() ? req.body.filename.trim() : "assets.zip";
      const requestedRootFolderName = typeof req.body?.rootFolderName === "string" ? req.body.rootFolderName.trim() : "";
      const rootFolderName = /^(?:asset|assets|image|images|font|fonts|video|videos)$/i.test(
        sanitizeFilenameBase(requestedRootFolderName)
      ) ? "" : requestedRootFolderName;
      archive.on("error", (err) => {
        console.error("ZIP stream error:", err.message || err);
      });
      const target = await uniqueDownloadFilePath(requestedFilename, {
        sourcePageUrl: rootFolderName ? "" : readSourcePageUrl(req),
        kind: "zip",
        rootFolderName
      });
      const writeStream = fs2.createWriteStream(target.filePath);
      const streamDone = new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      archive.pipe(writeStream);
      await archive.finalize();
      await streamDone;
      const stat = await validateSavedAssetFile(target.filePath, "Assets ZIP");
      res.setHeader("X-Zip-Added-Count", String(addedCount));
      res.setHeader("X-Zip-Failed-Count", String(zipFailures.length));
      return res.json({
        ok: true,
        filename: target.filename,
        downloadPath: target.filePath,
        localPath: target.filePath,
        folderPath: target.folderPath,
        size: stat.size,
        addedCount,
        failedCount: zipFailures.length
      });
    }
    archive.on("error", (err) => {
      console.error("ZIP stream error:", err.message || err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create ZIP file" });
      } else {
        res.destroy();
      }
    });
    res.setHeader("Content-Disposition", 'attachment; filename="assets.zip"');
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Zip-Cache-Only", "1");
    res.setHeader("X-Zip-Added-Count", String(addedCount));
    res.setHeader("X-Zip-Failed-Count", String(zipFailures.length));
    archive.pipe(res);
    await archive.finalize();
  } catch (error) {
    console.error("ZIP error:", error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create ZIP file" });
    }
  }
});
async function startServer() {
  await ensureRuntimeToolsReady();
  activePort = await findAvailablePort(DEFAULT_PORT);
  if (activePort !== DEFAULT_PORT) {
    console.log(`Using another available local port: ${activePort}`);
  }
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const hmrDisabled = process.env.VITE_HMR_DISABLED === "1" || process.env.DISABLE_HMR === "true";
    const hmrPort = hmrDisabled ? -1 : await findAvailablePort(Number(process.env.VITE_HMR_PORT || 24678), 60).catch(() => {
      console.warn("Could not find free HMR port \u2014 hot reload will be unavailable");
      return -1;
    });
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrPort > 0 ? { port: hmrPort } : false
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path3.join(getAppRoot(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path3.join(distPath, "index.html"));
    });
  }
  const server = app.listen(activePort, "127.0.0.1", () => {
    console.log(`Server running on http://localhost:${activePort}`);
  });
  setupExtractProgressWS(server);
  return { server, port: activePort, url: `http://localhost:${activePort}`, cleanup: cleanupDisposableStorage };
}
if (process.env.VDX_SKIP_AUTOSTART !== "1") {
  startServer().catch((error) => {
    const message = /EADDRINUSE|address already in use/i.test(String(error?.message || "")) ? "Using another available local port..." : "Startup repair did not finish. Please run npm install once, then try again.";
    console.error(message);
    console.error(error?.message || error);
    process.exit(1);
  });
}
export {
  startServer
};
