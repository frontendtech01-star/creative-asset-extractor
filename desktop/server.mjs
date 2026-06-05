// server.ts
import express from "express";
import path2 from "path";
import rateLimit from "express-rate-limit";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
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
import fs from "fs";
import fsp2 from "fs/promises";
import os2 from "os";
import https from "https";
import net from "net";
import crypto from "crypto";
import { execFile } from "child_process";
import { Worker } from "worker_threads";
import { promisify } from "util";
import { createRequire as createRequire2 } from "module";

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
    const path3 = `/api/youtube-merged-stream?${params.toString()}`;
    if (isLocalHost(parsed.hostname) || rawUrl.startsWith("/api/")) return path3;
    return `${parsed.protocol}//${parsed.host}${path3}`;
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
var isExpiredStreamUrl = (rawUrl, graceSeconds = 90) => {
  try {
    const parsed = new URL(rawUrl);
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
  } catch {
    return true;
  }
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
  return ["ttf", "woff"];
};
var buildFontZipEntryName = (filenameBase, format) => {
  const safe = sanitizeFontFilenameBase(filenameBase).replace(/\s+/g, "-").replace(/-+/g, "-") || "font";
  const ext = String(format || "ttf").toLowerCase();
  return `fonts/${safe}/${safe}.${ext}`;
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
    /^(.+?)[-](Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Bold|ExtraBold|Black|CondBold)(Italic)?$/i
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
  const format = resolveFontSourceFormat(font);
  if (format === "woff2") score += 30;
  else if (format === "woff") score += 20;
  else if (format === "ttf" || format === "otf") score += 10;
  const assetUrl = String(font?.url || font?.cachedUrl || "");
  score += scoreFontSubsetUrl(assetUrl);
  if (/-ttf\.ttf(\?|$)/i.test(assetUrl)) score += 18;
  else if (/-woff\.woff(\?|$)/i.test(assetUrl)) score += 12;
  if (/\/fonts\//i.test(assetUrl) && (format === "ttf" || format === "woff")) score += 10;
  if (font?.cachedUrl) score += 50;
  if (String(font?.status || "").toLowerCase() === "downloaded") score += 40;
  return score;
};
var dedupeFontsByLogicalKey = (fonts) => {
  const groups = /* @__PURE__ */ new Map();
  for (const font of fonts) {
    if (!font?.url || String(font.url).startsWith("data:")) continue;
    const key = getFontLogicalKey(font);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(font);
    groups.set(key, bucket);
  }
  const deduped = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => scoreFontRecord(b) - scoreFontRecord(a));
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
  const base = String(value || "").trim().toLowerCase();
  if (!base) return true;
  if (base === "unknown" || base === "font") return true;
  if (base.length <= 2) return true;
  if (/^font-\d+$/i.test(base)) return true;
  if (/^[lda](?:-\d+)?$/i.test(base)) return true;
  if (/^[0-9a-f]{8,}$/i.test(base)) return true;
  return false;
};
var scoreFontFamilyLabel = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return 0;
  if (isJunkFontLabel(trimmed)) return 1;
  if (/^https?:\/\//i.test(trimmed)) return 1;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return 10 + Math.min(words, 4) + Math.min(trimmed.length, 48);
};
var sanitizeFontFilenameBase = (value) => String(value || "").trim().replace(/^["']+|["']+$/g, "").replace(/[/\\]+/g, "-").replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
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
  if (!raw || raw === "normal" || raw === "regular" || raw === "400") return "";
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return FONT_WEIGHT_LABELS[num] || "";
  }
  if (raw === "bold" || raw === "bolder") return "Bold";
  if (raw === "lighter") return "Light";
  return sanitizeFontFilenameBase(raw);
};
var buildFontDisplayName = (font) => {
  const familyCandidates = [
    String(font?.family || "").trim(),
    String(font?.title || "").trim(),
    String(font?.name || "").trim(),
    String(font?.filename || "").trim()
  ].map((value) => sanitizeFontFilenameBase(value.replace(/^["']+|["']+$/g, ""))).filter((value) => value && !isJunkFontLabel(value));
  const family = familyCandidates.sort((a, b) => scoreFontFamilyLabel(b) - scoreFontFamilyLabel(a))[0] || "";
  if (!family) return "";
  const weight = normalizeFontWeightLabel(font?.weight);
  const style = String(font?.style || "").trim().toLowerCase();
  const italic = style === "italic" || style === "oblique";
  const suffixes = [weight, italic ? "Italic" : ""].filter(Boolean);
  return suffixes.length ? `${family} ${suffixes.join(" ")}`.trim() : family;
};
var mergeFontRecords = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  const familyCandidates = [left.family, right.family, left.title, right.title, left.name, right.name, left.filename, right.filename];
  const family = familyCandidates.map((value) => sanitizeFontFilenameBase(String(value || "").replace(/^["']+|["']+$/g, ""))).filter((value) => value && !isJunkFontLabel(value)).sort((a, b) => scoreFontFamilyLabel(b) - scoreFontFamilyLabel(a))[0] || left.family || right.family || "Font";
  return {
    ...left,
    ...right,
    family,
    format: right.format || left.format,
    cssSource: right.cssSource || left.cssSource,
    url: left.url || right.url,
    weight: right.weight || left.weight,
    style: right.style || left.style,
    filename: right.filename || left.filename,
    name: right.name || left.name
  };
};
var pickBestFontForUrl = (fonts, url) => fonts.filter((font) => String(font?.url || "") === url).reduce((best, current) => mergeFontRecords(best, current), null);

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
  return `${site}_CreativeAssets`;
};

// src/lib/projectDownloadsPaths.ts
var CREATIVE_ASSET_SUBFOLDERS = [
  "Videos",
  "Audio",
  "Images",
  "Fonts",
  "ISI",
  "Brief",
  "SmokeTest",
  "Logs"
];
var resolveCreativeAssetsRoot = (sourcePageUrl) => {
  const folderName = buildCreativeAssetsFolderName(String(sourcePageUrl || "").trim());
  return path.join(os.homedir(), "Downloads", folderName);
};
var resolveCreativeAssetsDir = (sourcePageUrl, subfolder) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl);
  return subfolder ? path.join(root, subfolder) : root;
};
var ensureCreativeAssetsFolders = async (sourcePageUrl) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl);
  await fsp.mkdir(root, { recursive: true });
  await Promise.all(
    CREATIVE_ASSET_SUBFOLDERS.map(
      (sub) => fsp.mkdir(resolveCreativeAssetsDir(sourcePageUrl, sub), { recursive: true })
    )
  );
};

// server.ts
var require3 = createRequire2(import.meta.url);
var getAppRoot = () => process.env.VDX_APP_ROOT || process.cwd();
var insightsPageEvaluate = require3(path2.join(getAppRoot(), "scripts", "insights-page-evaluate.cjs"));
var youtubedl = youtubedlModule;
var execFileAsync = promisify(execFile);
var getResourcesPath = () => process.env.VDX_RESOURCES_PATH || getAppRoot();
var getUnpackedModulePath = (...segments) => {
  const resources = process.env.VDX_RESOURCES_PATH;
  if (resources) {
    const unpacked = path2.join(resources, "app.asar.unpacked", ...segments);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path2.join(getAppRoot(), ...segments);
};
var resolveYtDlpPath = () => {
  const constantPath = youtubedlModule?.constants?.YOUTUBE_DL_PATH;
  if (constantPath && fs.existsSync(String(constantPath))) return String(constantPath);
  const candidates = [
    getUnpackedModulePath("node_modules", "youtube-dl-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
    path2.join(getAppRoot(), "node_modules", "youtube-dl-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1];
};
var findBundledChromiumExecutable = () => {
  const chromeCacheRoot = path2.join(getResourcesPath(), "chromium", "chrome");
  if (!fs.existsSync(chromeCacheRoot)) return "";
  const platformPrefix = process.arch === "arm64" ? "mac_arm-" : "mac-";
  const bundleDir = process.arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
  try {
    const versionDir = fs.readdirSync(chromeCacheRoot).find((name) => name.startsWith(platformPrefix));
    if (!versionDir) return "";
    const executable = path2.join(
      chromeCacheRoot,
      versionDir,
      bundleDir,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );
    return fs.existsSync(executable) ? executable : "";
  } catch {
    return "";
  }
};
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(String(ffmpegPath));
}
var aria2Path = "";
try {
  const localToolsPath = path2.join(getAppRoot(), ".local-tools.json");
  const localTools = JSON.parse(fs.readFileSync(localToolsPath, "utf8"));
  aria2Path = String(localTools?.aria2Path || "");
} catch {
  const bundledAria2 = path2.join(getResourcesPath(), "vendor", "aria2", "aria2c");
  if (fs.existsSync(bundledAria2)) aria2Path = bundledAria2;
}
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
var app = express();
var DEFAULT_PORT = Number(process.env.PORT || 3e3);
var activePort = DEFAULT_PORT;
var convertedVideoDir = path2.join(os2.tmpdir(), "creative-asset-extractor-mp4");
var convertedAudioDir = path2.join(os2.tmpdir(), "creative-asset-extractor-audio");
var generatedThumbnailDir = path2.join(os2.tmpdir(), "creative-asset-extractor-thumbnails");
var cachedImageDir = path2.join(os2.tmpdir(), "creative-asset-extractor-images");
var cachedFontDir = path2.join(os2.tmpdir(), "creative-asset-extractor-fonts");
var cachedImageOriginalDir = path2.join(os2.tmpdir(), "creative-asset-extractor-images-original");
var cachedFontOriginalDir = path2.join(os2.tmpdir(), "creative-asset-extractor-fonts-original");
var downloadsDir = path2.join(os2.homedir(), "Downloads");
var lastExtractedSourceUrl = "";
var readSourcePageUrl = (req, explicit) => {
  const direct = String(explicit || "").trim();
  if (direct) return direct;
  if (!req) return lastExtractedSourceUrl;
  const fromQuery = typeof req.query?.sourcePageUrl === "string" ? req.query.sourcePageUrl.trim() : "";
  const fromBody = typeof req.body?.sourcePageUrl === "string" ? req.body.sourcePageUrl.trim() : "";
  return fromQuery || fromBody || lastExtractedSourceUrl;
};
var resolveDownloadSaveDir = (kind = "default", sourcePageUrl) => {
  const pageUrl = String(sourcePageUrl || lastExtractedSourceUrl || "").trim();
  if (kind === "font") return resolveCreativeAssetsDir(pageUrl, "Fonts");
  if (kind === "image") return resolveCreativeAssetsDir(pageUrl, "Images");
  if (kind === "video") return resolveCreativeAssetsDir(pageUrl, "Videos");
  if (kind === "audio") return resolveCreativeAssetsDir(pageUrl, "Audio");
  if (kind === "brief") return resolveCreativeAssetsDir(pageUrl, "Brief");
  if (kind === "isi") return resolveCreativeAssetsDir(pageUrl, "ISI");
  if (kind === "zip") return resolveCreativeAssetsDir(pageUrl, "Images");
  return resolveCreativeAssetsRoot(pageUrl);
};
var resolveDownloadsTargetDir = (sourcePageUrl) => resolveCreativeAssetsRoot(String(sourcePageUrl || lastExtractedSourceUrl || "").trim());
var assertPathInsideDownloads = (filePath) => {
  const resolved = path2.resolve(filePath);
  const root = path2.resolve(downloadsDir);
  if (resolved === root || resolved.startsWith(root + path2.sep)) return resolved;
  throw new Error("Download path resolved outside Downloads.");
};
var appDataDir = path2.join(os2.homedir(), ".creative-asset-extractor");
var feedbackInboxPath = path2.join(appDataDir, "feedback", "inbox.jsonl");
var feedbackConfigPath = path2.join(appDataDir, "feedback-config.json");
var relaxedHttpsAgent = new https.Agent({ rejectUnauthorized: false });
var loadProjectEnvFile = () => {
  const candidates = [
    path2.join(process.cwd(), ".env"),
    ...process.env.VDX_APP_ROOT ? [path2.join(String(process.env.VDX_APP_ROOT), ".env")] : []
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const text = fs.readFileSync(envPath, "utf8");
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
var cachedFeedbackTarget;
var readFeedbackConfigJson = async () => {
  try {
    const raw = await fsp2.readFile(feedbackConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};
var resolveFeedbackSheetConfig = async () => {
  const fromFile = await readFeedbackConfigJson();
  const webhookUrl = String(
    fromFile?.sheetWebhookUrl || process.env.GOOGLE_SHEET_FEEDBACK_WEBHOOK_URL || ""
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
  if (!actionUrl || !nameEntryId || !suggestionsEntryId) return null;
  return { actionUrl, nameEntryId, suggestionsEntryId };
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
var appendLocalFeedbackInbox = async (name, suggestions) => {
  await fsp2.mkdir(path2.dirname(feedbackInboxPath), { recursive: true });
  const entry = {
    name,
    suggestions,
    submittedAt: (/* @__PURE__ */ new Date()).toISOString(),
    destination: "frontendtech01@gmail.com"
  };
  await fsp2.appendFile(feedbackInboxPath, `${JSON.stringify(entry)}
`, "utf8");
};
var submitFeedbackToGoogleForm = async (config, name, suggestions) => {
  const body = new URLSearchParams();
  body.set(config.nameEntryId, name);
  body.set(config.suggestionsEntryId, suggestions);
  await axios.post(config.actionUrl, body.toString(), {
    timeout: 12e3,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });
};
var submitFeedbackToGoogleSheet = async (config, payload) => {
  const response = await axios.post(config.webhookUrl, payload, {
    timeout: 15e3,
    headers: { "Content-Type": "application/json" },
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300
  });
  const data = response.data;
  if (data && typeof data === "object" && data.ok === false) {
    throw new Error(String(data.error || "Google Sheet feedback webhook rejected the submission."));
  }
};
var submitFeedbackRemote = async (target, payload) => {
  if (target.mode === "sheet") {
    await submitFeedbackToGoogleSheet(target.config, payload);
    return "sheet";
  }
  await submitFeedbackToGoogleForm(target.config, payload.name, payload.suggestions);
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
var getCurrentUserName = () => {
  try {
    return os2.userInfo().username || "user";
  } catch {
    return "user";
  }
};
var toSafeUserFilePart = (value) => String(value || "user").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "user";
var toLocalVideoDownloadUrl = (req, filename, sourcePageUrl) => {
  const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
  const relative = path2.relative(downloadsDir, path2.join(targetDir, filename));
  return toAbsoluteAppUrl(req, `/api/download-local-video?filename=${encodeURIComponent(relative)}`);
};
var fileExists = async (filePath) => {
  if (!filePath) return false;
  try {
    await fsp2.access(filePath, fs.constants.F_OK);
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
app.use(express.json({ limit: "1mb" }));
app.use("/converted-videos", localOnlyGuard, express.static(convertedVideoDir, privateStaticOptions));
app.use("/converted-audio", localOnlyGuard, express.static(convertedAudioDir, privateStaticOptions));
app.use("/generated-thumbnails", localOnlyGuard, express.static(generatedThumbnailDir, privateStaticOptions));
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
app.get("/api/feedback/status", async (_req, res) => {
  const target = await resolveFeedbackTarget();
  const sheet = await resolveFeedbackSheetConfig();
  const googleForm = await resolveFeedbackFormConfig();
  res.json({
    ready: true,
    mode: target?.mode || "local",
    contactEmail: "frontendtech01@gmail.com",
    googleSheetConfigured: Boolean(sheet),
    googleFormConfigured: Boolean(googleForm),
    sheetId: sheet?.sheetId || DEFAULT_FEEDBACK_SHEET_ID,
    localInboxPath: feedbackInboxPath
  });
});
app.post("/api/feedback", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const suggestions = String(req.body?.suggestions || "").trim();
  if (!name || !suggestions) {
    return res.status(400).json({ error: "Name and suggestions are required." });
  }
  let appVersion = "1.0.0";
  try {
    const pkg = JSON.parse(await fsp2.readFile(path2.join(getAppRoot(), "package.json"), "utf8"));
    appVersion = String(pkg?.version || appVersion);
  } catch {
  }
  const payload = {
    name,
    suggestions,
    submittedAt: (/* @__PURE__ */ new Date()).toISOString(),
    appVersion
  };
  try {
    const target = await resolveFeedbackTarget();
    if (target) {
      const mode = await submitFeedbackRemote(target, payload);
      return res.json({
        ok: true,
        mode,
        message: "Thanks! Your feedback has been submitted."
      });
    }
    await appendLocalFeedbackInbox(name, suggestions);
    return res.json({
      ok: true,
      mode: "local",
      message: "Thanks! Your feedback has been submitted.",
      inboxPath: feedbackInboxPath
    });
  } catch (error) {
    console.error("Feedback submit failed:", error?.message || error);
    try {
      await appendLocalFeedbackInbox(name, suggestions);
      return res.json({
        ok: true,
        mode: "local",
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
    const filePath = path2.join(appDataDir, `${safeUserName}-responsible-use.json`);
    const payload = {
      userName,
      acknowledged: true,
      acknowledgedAt,
      app: "Creative Asset Extractor",
      version: "1",
      context: typeof req.body?.context === "string" ? req.body.context : "firstLaunch"
    };
    await fsp2.mkdir(appDataDir, { recursive: true });
    await fsp2.writeFile(filePath, `${JSON.stringify(payload, null, 2)}
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
var resolvePackageMeta = async () => {
  const candidates = [
    path2.join(process.cwd(), "package.json"),
    ...process.env.VDX_APP_ROOT ? [path2.join(String(process.env.VDX_APP_ROOT), "package.json")] : []
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fsp2.readFile(candidate, "utf8");
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
var resolveGithubRepoConfig = () => {
  const repository = String(process.env.GITHUB_REPOSITORY || "").trim();
  if (repository.includes("/")) {
    const [owner, repo] = repository.split("/");
    return { githubOwner: owner, githubRepo: repo };
  }
  return {
    githubOwner: String(process.env.GITHUB_OWNER || process.env.VITE_GITHUB_OWNER || "").trim(),
    githubRepo: String(process.env.GITHUB_REPO || process.env.VITE_GITHUB_REPO || "").trim()
  };
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
    const data = response.data || {};
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const dmgAsset = assets.find((asset) => /\.dmg$/i.test(String(asset?.name || "")));
    const exeAsset = assets.find((asset) => /\.exe$/i.test(String(asset?.name || "")));
    return res.json({
      available: true,
      release: {
        tagName: String(data.tag_name || ""),
        name: String(data.name || data.tag_name || "Latest release"),
        body: String(data.body || ""),
        htmlUrl: String(data.html_url || ""),
        dmgDownloadUrl: String(dmgAsset?.browser_download_url || ""),
        exeDownloadUrl: String(exeAsset?.browser_download_url || "")
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
app.get("/api/system-check", async (_req, res) => {
  const ytdlpPath = resolveYtDlpPath();
  const ffmpegReady = Boolean(ffmpegPath && await fileExists(String(ffmpegPath)));
  const ytdlpReady = await fileExists(String(ytdlpPath));
  const downloadsReady = await fsp2.mkdir(downloadsDir, { recursive: true }).then(() => true).catch(() => false);
  const appDataReady = await fsp2.mkdir(appDataDir, { recursive: true }).then(() => true).catch(() => false);
  res.json({
    ok: ffmpegReady && ytdlpReady && downloadsReady && appDataReady,
    platform: process.platform,
    arch: process.arch,
    userName: getCurrentUserName(),
    downloadsDir,
    appDataDir,
    tools: {
      ffmpeg: { ready: ffmpegReady, path: ffmpegPath ? String(ffmpegPath) : "" },
      ytdlp: { ready: ytdlpReady, path: String(ytdlpPath || "") },
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
    url.hash = "";
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
var scoreSiteHtml = (html, status) => {
  const text = String(html || "");
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
  if (text.length < 2048) return true;
  if (/\/wp-content\/uploads/i.test(text) && text.length > 8e3) return false;
  if (text.length < 9e4 && !/\/wp-content\/uploads|<img\b|background-image\s*:\s*url/i.test(text)) return true;
  const rasterHints = (text.match(/\.(?:png|jpe?g|webp|gif|avif)(?:[^\w]|$)/gi) || []).length;
  const svgCount = (text.match(/<svg\b/gi) || []).length;
  return rasterHints < 2 && svgCount > 0 && text.length < 12e4;
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
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return "";
};
var applyPuppeteerStealth = async (page) => {
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
var pageHtmlLooksBlocked = (html) => /robot-suspicion|challenge-platform|captcha-delivery|cf-challenge|access denied|just a moment|checking your browser/i.test(
  String(html || "")
);
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
var launchFreshPuppeteerBrowser = async () => {
  const executablePath = resolvePuppeteerExecutablePath();
  const launchOptions = {
    headless: true,
    args: PUPPETEER_BROWSER_ARGS,
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
var launchPuppeteerBrowser = async () => acquireSharedPuppeteerBrowser();
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
  if (!recoveryHtml || scoreSiteHtml(recoveryHtml, 200) < 20) return assets;
  return extractStaticAssets(targetUrl, recoveryHtml, { fast: false });
};
var fetchSiteHtmlViaCurl = async (siteUrl) => {
  let best = { html: "", score: -1 };
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        ["-sL", "--max-time", "8", "-A", userAgent, "-H", "Accept: text/html,application/xhtml+xml", siteUrl],
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
var fetchSiteHtmlViaBrowser = async (siteUrl) => {
  let browser = null;
  let page = null;
  try {
    browser = await launchPuppeteerBrowser();
    page = await browser.newPage();
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
var extractFontsFromCss = (cssText, baseUrl) => {
  const fonts = [];
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
      const candidates = [];
      const srcPartRegex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)\s*(?:format\(\s*['"]?([^'")]+?)['"]?\s*\))?/gi;
      let srcPart;
      while ((srcPart = srcPartRegex.exec(srcMatch[1])) !== null) {
        const urlStr = srcPart[1];
        const formatHint = srcPart[2] || "";
        const absoluteUrl = resolveUrl(baseUrl, urlStr);
        if (!absoluteUrl || absoluteUrl.startsWith("data:")) continue;
        const format = inferFontFormatFromCssSrc(absoluteUrl, formatHint);
        if (!isSupportedFontFormat(format)) continue;
        candidates.push({
          family: fontFamily,
          url: absoluteUrl,
          format,
          cssSource: baseUrl,
          weight: fontWeightMatch?.[1]?.trim() || void 0,
          style: fontStyleMatch?.[1]?.trim() || void 0,
          status: DEFAULT_ASSET_STATUS
        });
      }
      if (candidates.length > 0) {
        const gstatic = candidates.find((candidate) => /fonts\.gstatic\.com/i.test(String(candidate?.url || "")));
        const best = gstatic || candidates.sort((a, b) => scoreFontCssCandidate(b) - scoreFontCssCandidate(a))[0];
        const familyLabel = String(best?.family || "");
        const bestUrl = String(best?.url || "");
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
var FONT_FORMAT_PRIORITY = {
  woff2: 3,
  woff: 2,
  otf: 2,
  ttf: 1
};
var scoreFontCssCandidate = (candidate) => {
  let score = FONT_FORMAT_PRIORITY[String(candidate?.format || "").toLowerCase()] || 0;
  const url = String(candidate?.url || "").toLowerCase();
  const family = String(candidate?.family || "").trim().replace(/^['"]+|['"]+$/g, "");
  const familySlug = family.replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const urlBase = (url.split("/").pop() || "").replace(/\.[^.]+$/, "").toLowerCase();
  const urlSlug = urlBase.replace(/[^a-z0-9]+/g, "");
  if (familySlug && (urlSlug.includes(familySlug) || familySlug.includes(urlSlug))) score += 24;
  else {
    const familyTokens = family.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
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
var isSupportedFontFormat = (format) => SUPPORTED_FONT_FORMATS.has(String(format || "").toLowerCase());
var isSupportedFontAsset = (font) => {
  if (!font?.url || String(font.url).startsWith("data:")) return false;
  const format = getFontFormatFromUrlOrType(String(font.url), String(font.format || ""));
  return isSupportedFontFormat(format);
};
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
    if (/en-main|main\.css|typography|\/font/.test(lowered)) return 60;
    if (/\/themes\//.test(lowered)) return 40;
    return 0;
  };
  return Array.from(new Set(cssUrls)).sort((a, b) => score(b) - score(a));
};
var extractExternalFontCssUrls = (text, baseUrl) => {
  const urls = /* @__PURE__ */ new Set();
  const patterns = [
    /https?:\/\/use\.typekit\.net\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/p\.typekit\.net\/[^"'()\s<>]+/gi,
    /https?:\/\/fonts\.googleapis\.com\/[^"'()\s<>]+/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/[^"'()\s<>]+\.css/gi,
    /https?:\/\/cdn\.prod\.accelerator\.sanofi\/fonts\/[^"'()\s<>]+/gi
  ];
  patterns.forEach((pattern) => {
    (String(text || "").match(pattern) || []).forEach((raw) => {
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
        timeout: options.fast ? 2e3 : 3e3,
        httpsAgent: relaxedHttpsAgent,
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
        imports: options.fast ? [] : extractCssImports(cssText, current)
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
var extractColorsFromCss = (cssText) => {
  const colors = [];
  const hexRegex = /#(?:[0-9a-fA-F]{3}){1,2}\b|#(?:[0-9a-fA-F]{4}){1,2}\b/g;
  const rgbRegex = /(?:rgb|rgba)\([^)]+\)/gi;
  const hslRegex = /(?:hsl|hsla)\([^)]+\)/gi;
  let match;
  while ((match = hexRegex.exec(cssText)) !== null) {
    colors.push(match[0].toLowerCase());
  }
  while ((match = rgbRegex.exec(cssText)) !== null) {
    colors.push(match[0].toLowerCase().replace(/\s+/g, ""));
  }
  while ((match = hslRegex.exec(cssText)) !== null) {
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
var pickPrimaryUiColors = (colors, limit = 6) => {
  const scored = /* @__PURE__ */ new Map();
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
  return Array.from(scored.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([hex]) => hex);
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
var sanitizeExtractedImageUrl = (value) => {
  const cleaned = decodeCssUrlValue(value).trim();
  const extMatch = cleaned.match(/^(.*?\.(?:svg|png|jpe?g|webp|gif|avif))(?:\?[^"'()\s;>]*)?/i);
  if (extMatch?.[1]) return extMatch[1];
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
  if (isJunkImageUrl(absoluteUrl)) return null;
  if (!options.permissive && !isLikelyImageAssetUrl(absoluteUrl)) return null;
  const type = inferImageTypeFromUrl(absoluteUrl) || getAssetTypeFromUrl(absoluteUrl, "img");
  const filename = filenameFromUrlPath2(absoluteUrl);
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
var extractInlineSvgsFromDom = ($, images) => {
  $("svg").each((_, el) => {
    if (!$(el).attr("xmlns")) {
      $(el).attr("xmlns", "http://www.w3.org/2000/svg");
    }
    const svgString = $.html(el);
    const svgBuffer = Buffer.from(svgString, "utf8");
    const dims = probeRasterDimensions(svgBuffer);
    images.push({
      url: `data:image/svg+xml;base64,${svgBuffer.toString("base64")}`,
      type: "svg",
      isInlineSvg: true,
      bytes: svgBuffer.length,
      width: dims.width || void 0,
      height: dims.height || void 0,
      mimeType: "image/svg+xml"
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
var extractImagesFromDom = ($, targetUrl) => {
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
  $('link[rel="preload"][as="image"], link[rel="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"], link[rel="mask-icon"]').each((_, el) => {
    addImageCandidate(images, $(el).attr("href"), targetUrl);
  });
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
  extractInlineSvgsFromDom($, images);
  return images;
};
var extractImagesFromHtmlString = (html, targetUrl) => {
  const images = [];
  const searchText = html.replace(/\\/g, "").replace(/&amp;/g, "&");
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
var isPlaylistUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path3 = parsed.pathname.toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      return Boolean(parsed.searchParams.get("list")) || path3.includes("/playlist");
    }
    if (host.includes("vimeo.com")) return /\/(?:showcase|album|channels|groups)\//.test(path3);
    if (host.includes("facebook.com")) return /\/(?:watch|playlist|videos)\//.test(path3) && Boolean(parsed.searchParams.get("vlist") || parsed.searchParams.get("playlist_id"));
    if (host === "x.com" || host.includes("twitter.com")) return /\/status(?:es)?\//.test(path3) && /\/\d+(?:\/(?:photo|video)\/\d+)?$/i.test(path3);
    if (isBrightcoveUrl(rawUrl)) return Boolean(parsed.searchParams.get("playlistId") || parsed.searchParams.get("playlist_id"));
    return false;
  } catch {
    return false;
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
    const match = parsed.pathname.match(/\/video\/(\d+)/) || parsed.pathname.match(/\/videos\/(\d+)/) || parsed.pathname.match(/^\/(\d+)/);
    if (match) return `https://vimeo.com/${match[1]}`;
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
  const normalizedText = text.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
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
  return Array.from(urls);
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
var vimeoQualityBucketFromHeight = (height) => {
  if (!Number.isFinite(height) || height <= 0) return null;
  if (height >= 900) return "fhd";
  if (height >= 600) return "hd";
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
      const placeholder = group.find((video) => video?.sourceUrl || video?.url) || group[0];
      collapsed.push({
        ...placeholder,
        vimeoId,
        sourceUrl: placeholder?.sourceUrl || `https://vimeo.com/${vimeoId}`,
        url: placeholder?.sourceUrl || placeholder?.url || `https://vimeo.com/${vimeoId}`,
        provider: "vimeo",
        isVimeo: true
      });
      continue;
    }
    const variants = {};
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
var buildWistiaEmbedUrl = (hashedId) => `https://fast.wistia.com/embed/medias/${hashedId}`;
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
var assetCacheKey = (url, suffix = "") => crypto.createHash("sha1").update(`${url}::${suffix}`).digest("hex");
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
      const { stdout } = await execFileAsync("curl", args, { maxBuffer: 10 * 1024 * 1024 });
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
    browser = await launchPuppeteerBrowser();
    const page = await browser.newPage();
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
      return path2.join(cachedImageOriginalDir, relative.replace(/^cached-images-original\//, ""));
    }
    if (pathname.startsWith("/cached-fonts-original/")) {
      return path2.join(cachedFontOriginalDir, relative.replace(/^cached-fonts-original\//, ""));
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
  const ext = path2.extname(filePath).slice(1).toLowerCase();
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
      const buffer = await fsp2.readFile(localPath);
      const contentType = guessContentTypeFromPath(localPath);
      const isImagePath = localPath.includes(`${path2.sep}cached-images-original${path2.sep}`) || isRemoteImageRequestUrl(normalized);
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
        const buffer = await fsp2.readFile(cachedPath);
        const contentType = guessContentTypeFromPath(cachedPath);
        if (kind !== "image" || isValidImageBuffer(buffer, contentType)) {
          if (kind === "font" && !isValidFontOriginalBuffer(buffer, contentType)) {
            await fsp2.unlink(cachedPath).catch(() => void 0);
          } else {
            return { buffer, contentType };
          }
        }
      }
      const resolved = await resolveOriginalCachedAsset(normalized, kind);
      if (resolved?.filePath) {
        const buffer = await fsp2.readFile(resolved.filePath);
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
    const stat = await fsp2.stat(filePath);
    if (stat.size > 0) return await fsp2.readFile(filePath);
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
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
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
  for (const userAgent of PAGE_FETCH_USER_AGENTS) {
    try {
      const args = [
        "-sL",
        "--max-time",
        "25",
        "-A",
        userAgent,
        "-H",
        "Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ...referer ? ["-H", `Referer: ${referer}`] : [],
        url
      ];
      const { stdout } = await execFileAsync("curl", args, {
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
var fetchRemoteImageBufferViaBrowser = async (url, refererPageUrl = "") => {
  let browser = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await browser.newPage();
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
    await new Promise((resolve) => setTimeout(resolve, 1800));
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
  const isProtectedCdnImage = /\.imaging\/|\/dam\/jcr:|dam\/jcr:/i.test(url);
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
var ensureImageCachedForDownload = async (requestUrl, originalUrl, refererPageUrl = "") => {
  let cached = await readAssetBufferFromCache(requestUrl, "image") || (originalUrl && originalUrl !== requestUrl ? await readAssetBufferFromCache(originalUrl, "image") : null);
  if (cached) {
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
var fetchRemoteImageBuffersViaBrowserBatch = async (urls, refererPageUrl = "") => {
  const results = /* @__PURE__ */ new Map();
  const uniqueUrls = Array.from(new Set(urls.filter(Boolean)));
  if (uniqueUrls.length === 0) return results;
  let landing = String(refererPageUrl || "").trim();
  if (!landing.startsWith("http")) {
    try {
      landing = `${new URL2(uniqueUrls[0]).origin}/`;
    } catch {
      return results;
    }
  }
  let browser = null;
  try {
    browser = await launchPuppeteerBrowser();
    const page = await browser.newPage();
    await applyPuppeteerStealth(page);
    await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 3e4 }).catch(() => void 0);
    await new Promise((resolve) => setTimeout(resolve, 2e3));
    const batchSize = 8;
    for (let offset = 0; offset < uniqueUrls.length; offset += batchSize) {
      const chunk = uniqueUrls.slice(offset, offset + batchSize);
      const fetched = await page.evaluate(async (imageUrls) => {
        const out = [];
        await Promise.all(
          imageUrls.map(async (imageUrl) => {
            try {
              const response = await fetch(imageUrl, { credentials: "include", cache: "no-store" });
              if (!response.ok) return;
              const contentType = response.headers.get("content-type") || "";
              const buffer = await response.arrayBuffer();
              out.push({ url: imageUrl, bytes: Array.from(new Uint8Array(buffer)), contentType });
            } catch {
            }
          })
        );
        return out;
      }, chunk).catch(() => []);
      for (const item of fetched) {
        const buffer = Buffer.from(item.bytes);
        const contentType = String(item.contentType || "");
        if (!isValidImageBuffer(buffer, contentType)) continue;
        results.set(item.url, { buffer, contentType });
        await writeCachedOriginalImageFromBuffer(item.url, buffer, contentType);
      }
      for (const imageUrl of chunk) {
        if (results.has(imageUrl)) continue;
        try {
          const response = await page.goto(imageUrl, { waitUntil: "networkidle2", timeout: 25e3 }).catch(() => null);
          if (!response || response.status() < 200 || response.status() >= 400) continue;
          const buffer = Buffer.from(await response.buffer());
          const contentType = String(response.headers()["content-type"] || response.headers()["Content-Type"] || "");
          if (!isValidImageBuffer(buffer, contentType)) continue;
          results.set(imageUrl, { buffer, contentType });
          await writeCachedOriginalImageFromBuffer(imageUrl, buffer, contentType);
        } catch {
        }
      }
    }
  } finally {
    await closePuppeteerBrowser(browser);
  }
  return results;
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
  if (fromBuffer && RASTER_CONVERTIBLE_FORMATS.has(fromBuffer)) return fromBuffer;
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
  let baseName = path2.basename(decoded.split("?")[0].split("#")[0]).replace(/[\\/:*?"<>|]/g, "-");
  if (!baseName) baseName = `asset${fallbackExt ? `.${normalizeAssetExtension(fallbackExt)}` : ""}`;
  const ext = path2.extname(baseName);
  const nameBase = ext ? path2.basename(baseName, ext) : baseName;
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
  if (formatExt && !path2.extname(candidate)) candidate = `${candidate}.${formatExt}`;
  return sanitizeFullFilename(candidate, formatExt);
};
var uniqueFilenameInSet = (filename, used) => {
  let candidate = sanitizeFullFilename(filename);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const ext = path2.extname(candidate);
  const base = path2.basename(candidate, ext) || "asset";
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
  const ext = path2.extname(safeFile);
  const base = path2.basename(safeFile, ext) || "asset";
  let index = 1;
  while (used.has(safeDir ? `${safeDir}/${base}-${index}${ext}` : `${base}-${index}${ext}`)) index += 1;
  candidate = safeDir ? `${safeDir}/${base}-${index}${ext}` : `${base}-${index}${ext}`;
  used.add(candidate);
  return candidate;
};
var uniqueDownloadFilePath = async (filename, options = {}) => {
  const pageUrl = String(options.sourcePageUrl || lastExtractedSourceUrl || "").trim();
  await ensureCreativeAssetsFolders(pageUrl);
  const targetDir = resolveDownloadSaveDir(options.kind || "default", pageUrl);
  const safeFilename = sanitizeFullFilename(filename);
  const ext = path2.extname(safeFilename);
  const base = path2.basename(safeFilename, ext) || "asset";
  let candidate = safeFilename;
  let index = 1;
  while (true) {
    const filePath = path2.join(targetDir, candidate);
    const resolved = assertPathInsideDownloads(filePath);
    try {
      await fsp2.access(resolved);
      candidate = `${base}-${index}${ext}`;
      index += 1;
    } catch {
      return { filePath: resolved, filename: candidate, folderPath: targetDir };
    }
  }
};
var saveBufferToDownloads = async (buffer, filename, label = "Download", sourcePageUrl, kind = "default") => {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error(`${label} produced an empty file.`);
  }
  const target = await uniqueDownloadFilePath(filename, { sourcePageUrl, kind });
  await fsp2.writeFile(target.filePath, buffer);
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
  const target = await uniqueDownloadFilePath(filename, { sourcePageUrl, kind });
  await fsp2.copyFile(sourcePath, target.filePath);
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
var convertedImageCachePath = (lookupUrl, targetFormat) => path2.join(cachedImageDir, `${assetCacheKey(lookupUrl, targetFormat)}.${targetFormat}`);
var readValidatedConvertedImageCache = async (lookupUrl, targetFormat) => {
  const cachePath = convertedImageCachePath(lookupUrl, targetFormat);
  const cached = await readCachedFileIfExists(cachePath);
  if (!cached) return null;
  if (!isValidRasterOutputBuffer(cached, targetFormat)) {
    await fsp2.unlink(cachePath).catch(() => void 0);
    return null;
  }
  return { buffer: cached, cachePath };
};
var originalCacheKindDir = (kind) => kind === "image" ? cachedImageOriginalDir : cachedFontOriginalDir;
var originalCachePublicDir = (kind) => kind === "image" ? "/cached-images-original" : "/cached-fonts-original";
var originalCacheIndexPath = (kind) => path2.join(originalCacheKindDir(kind), ".url-index.json");
var loadOriginalCacheIndex = async (kind) => {
  try {
    const raw = await fsp2.readFile(originalCacheIndexPath(kind), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};
var saveOriginalCacheIndex = async (kind, index) => {
  await fsp2.mkdir(originalCacheKindDir(kind), { recursive: true });
  await fsp2.writeFile(originalCacheIndexPath(kind), JSON.stringify(index));
};
var originalCacheLookupKey = (url) => assetCacheKey(normalizeAssetRequestUrl(url) || url, "original-lookup");
var findLegacyHashOriginalCachePath = async (url, kind) => {
  const cacheDir = originalCacheKindDir(kind);
  const key = assetCacheKey(url, `original-${kind}`);
  const candidates = kind === "image" ? ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bin"] : ["woff2", "woff", "ttf", "otf", "eot", "svg", "bin"];
  for (const ext of candidates) {
    const filePath = path2.join(cacheDir, `${key}.${ext}`);
    try {
      const stat = await fsp2.stat(filePath);
      if (stat.size <= 0) continue;
      if (kind === "image") {
        const buffer = await fsp2.readFile(filePath);
        if (!isValidImageBuffer(buffer, guessContentTypeFromPath(filePath))) {
          await fsp2.unlink(filePath).catch(() => void 0);
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
    const filePath = path2.join(originalCacheKindDir(kind), indexedName);
    try {
      const stat = await fsp2.stat(filePath);
      if (stat.size > 0) {
        const buffer = await fsp2.readFile(filePath);
        const contentType = guessContentTypeFromPath(filePath);
        const valid = kind === "image" ? isValidImageBuffer(buffer, contentType) : isValidFontOriginalBuffer(buffer, contentType);
        if (!valid) {
          await fsp2.unlink(filePath).catch(() => void 0);
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
  const filename = path2.basename(legacyPath);
  return {
    filePath: legacyPath,
    filename,
    cachedUrl: `${originalCachePublicDir(kind)}/${filename}`
  };
};
var writeOriginalCachedAsset = async (url, kind, buffer, options = {}) => {
  const normalized = normalizeAssetRequestUrl(url) || url;
  const cacheDir = originalCacheKindDir(kind);
  await fsp2.mkdir(cacheDir, { recursive: true });
  const existing = await resolveOriginalCachedAsset(url, kind);
  if (existing) {
    try {
      const current = await fsp2.readFile(existing.filePath);
      const currentType = guessContentTypeFromPath(existing.filePath);
      const validOriginal = current.length > 0 && (kind === "image" ? isValidImageBuffer(current, currentType) : isValidFontOriginalBuffer(current, currentType));
      if (validOriginal) {
        return existing.cachedUrl;
      }
      await fsp2.unlink(existing.filePath).catch(() => void 0);
    } catch {
    }
  }
  if (kind === "font" && !isValidFontOriginalBuffer(buffer, options.contentType || "")) {
    return "";
  }
  const ext = kind === "image" ? safeExtFromAssetType(
    detectImageFormatFromBuffer(buffer) || inferImageTypeFromUrl(normalized, options.contentType || "") || options.hintType || "bin"
  ) : safeExtFromAssetType(getFontFormatFromUrlOrType(normalized, options.contentType || "") || options.hintType || "bin");
  const desired = deriveAssetFilename({
    url: normalized.startsWith("http") ? normalized : url,
    contentDisposition: options.contentDisposition,
    metadataFilename: options.metadataFilename,
    preferredBase: options.preferredBase,
    format: ext,
    fallbackBase: kind === "image" ? "image" : "font"
  });
  const existingFiles = await fsp2.readdir(cacheDir).catch(() => []);
  const used = new Set(existingFiles.filter((name) => !name.startsWith(".")));
  const filename = uniqueFilenameInSet(desired, used);
  await fsp2.writeFile(path2.join(cacheDir, filename), buffer);
  const index = await loadOriginalCacheIndex(kind);
  index[originalCacheLookupKey(normalized)] = filename;
  await saveOriginalCacheIndex(kind, index);
  const legacyPath = await findLegacyHashOriginalCachePath(normalized, kind);
  if (legacyPath && path2.basename(legacyPath) !== filename) {
    await fsp2.unlink(legacyPath).catch(() => void 0);
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
  await fsp2.mkdir(cachedImageDir, { recursive: true });
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
  const defaultTarget = normalizedSource === "webp" ? "jpg" : normalizedSource === "avif" ? "png" : normalizedSource;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  filenameExtras.contentDisposition = fetched.contentDisposition || options?.prefetched?.contentDisposition;
  const wantsRasterConversion = ["png", "jpg"].includes(normalizedTarget) && RASTER_CONVERTIBLE_FORMATS.has(normalizedSource) && supportedRasterConversionTargets(normalizedSource).includes(normalizedTarget);
  if (!wantsRasterConversion) {
    const cachePath2 = path2.join(cachedImageDir, `${assetCacheKey(normalizedUrl, "original")}.${sourceFormat || "bin"}`);
    let cached2 = await readCachedFileIfExists(cachePath2);
    if (cached2 && !isValidImageBuffer(cached2, guessContentTypeFromPath(cachePath2))) {
      await fsp2.unlink(cachePath2).catch(() => void 0);
      cached2 = null;
    }
    if (!cached2) {
      await fsp2.writeFile(cachePath2, fetched.buffer);
      cached2 = fetched.buffer;
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
    cached = await convertRasterImageBuffer(fetched.buffer, targetFormat);
    await fsp2.writeFile(cachePath, cached);
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
  const defaultTarget = sourceFormat === "webp" ? "jpg" : sourceFormat === "avif" ? "png" : sourceFormat;
  const normalizedTarget = normalizeRasterFormat(requestedFormat || defaultTarget);
  const wantsRasterConversion = ["png", "jpg"].includes(normalizedTarget) && RASTER_CONVERTIBLE_FORMATS.has(sourceFormat) && supportedRasterConversionTargets(sourceFormat).includes(normalizedTarget);
  if (wantsRasterConversion) {
    const targetFormat = normalizedTarget;
    const converted = await convertRasterImageBuffer(fetched.buffer, targetFormat);
    if (!isValidRasterOutputBuffer(converted, targetFormat)) return null;
    const cacheKeyUrl = lookupUrl || normalizedUrl;
    const cachePath = convertedImageCachePath(cacheKeyUrl, targetFormat);
    await fsp2.writeFile(cachePath, converted).catch(() => void 0);
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
    buffer: fetched.buffer,
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
  if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0) return "ttf";
  return "";
};
var isValidFontBuffer = (buffer, expectedFormat) => {
  if (!buffer || buffer.length < 128) return false;
  const detected = detectFontFormatFromBuffer(buffer);
  const target = String(expectedFormat || "").toLowerCase();
  if (!detected) return false;
  if (target === "svg" || target === "eot") return false;
  return detected === target;
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
var fontConvertWorkerPath = () => path2.join(getAppRoot(), "server", "font-convert-worker.mjs");
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
var convertFontBuffer = async (url, buffer, fromFormat, toFormat, contentType = "") => {
  const detected = detectFontFormatFromBuffer(buffer);
  let readFormat = detected || normalizeFontFormat(fromFormat, contentType);
  if (!["ttf", "woff", "woff2", "eot", "otf", "svg"].includes(readFormat)) {
    throw new Error(`Unsupported or undetectable original font format: ${readFormat || "unknown"}`);
  }
  if (readFormat === toFormat) {
    return buffer;
  }
  try {
    return await convertFontBufferOffThread(buffer, readFormat, toFormat);
  } catch (workerError) {
    const { buffer: innerBuffer, format: innerFormat } = await getInnerFontBuffer(buffer, readFormat);
    return writeFontBuffer(innerBuffer, innerFormat, toFormat);
  }
};
var convertFontAsset = async (url, toFormat, originalFormat = "unknown", preferredBase, extras = {}) => {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTimeout(
        getCachedConvertedFont(url, toFormat, originalFormat, preferredBase, extras),
        2e4 + attempt * 8e3,
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
  await fsp2.mkdir(cachedFontDir, { recursive: true });
  const normalizedTarget = ["ttf", "woff", "woff2", "eot", "otf", "svg"].includes(toFormat) ? toFormat : "ttf";
  const cacheSourceUrl = normalizeAssetRequestUrl(String(extras.originalUrl || "").trim()) || normalizeAssetRequestUrl(url) || url;
  const cachePath = path2.join(cachedFontDir, `${assetCacheKey(cacheSourceUrl, normalizedTarget)}.${normalizedTarget}`);
  const filenameSourceUrl = extras.originalUrl || url;
  const filenameExtras = {
    contentDisposition: extras.contentDisposition,
    metadataFilename: extras.metadataFilename
  };
  let cached = await readCachedFileIfExists(cachePath);
  if (cached && !isValidFontBuffer(cached, normalizedTarget)) {
    await fsp2.unlink(cachePath).catch(() => void 0);
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
  try {
    fetched = await fetchAssetBuffer(url, extras.originalUrl || "", { cacheOnly, refererPageUrl: refererPage });
  } catch (primaryFetchError) {
    const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
    if (siblingUrl !== url) {
      fetched = await fetchAssetBuffer(siblingUrl, extras.originalUrl || "", { cacheOnly, refererPageUrl: refererPage });
    } else {
      throw primaryFetchError;
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
  const detected = detectFontFormatFromBuffer(fetched.buffer);
  let fromFormat = detected || normalizeFontFormat(originalFormat || getFontFormatFromUrlOrType(url, fetched.contentType), fetched.contentType);
  try {
    outputBuffer = await convertFontBuffer(url, fetched.buffer, fromFormat, normalizedTarget, fetched.contentType);
  } catch (convertError) {
    if (cacheOnly) throw convertError;
    const siblingUrl = url.replace(/\.(ttf|woff2?|eot|otf|svg)(\?|$)/i, `.${normalizedTarget}$2`);
    if (siblingUrl !== url) {
      const sibling = await fetchAssetBuffer(siblingUrl, extras.originalUrl || "", { cacheOnly, refererPageUrl: refererPage });
      const siblingDetected = detectFontFormatFromBuffer(sibling.buffer);
      const siblingFrom = siblingDetected || normalizeFontFormat(getFontFormatFromUrlOrType(siblingUrl, sibling.contentType), sibling.contentType);
      outputBuffer = await convertFontBuffer(siblingUrl, sibling.buffer, siblingFrom, normalizedTarget, sibling.contentType);
    } else {
      throw convertError;
    }
  }
  if (!isValidFontBuffer(outputBuffer, normalizedTarget)) {
    throw new Error(`Converted font is not valid ${normalizedTarget.toUpperCase()} binary`);
  }
  if (!cacheOnly) {
    await fsp2.writeFile(cachePath, outputBuffer);
  }
  return {
    buffer: outputBuffer,
    format: normalizedTarget,
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
      const current = await fsp2.readFile(existing.filePath);
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
      await fsp2.unlink(existing.filePath).catch(() => void 0);
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
        fetchRemoteImageBuffer(url, refererPage),
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
      fonts.push({
        family: "",
        url: resolved,
        format,
        cssSource: baseUrl,
        status: DEFAULT_ASSET_STATUS
      });
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
var isJunkImageUrl = (url) => {
  const lowered = String(url || "").toLowerCase();
  if (!lowered) return true;
  if (/^https?:\/\/[^/]+\/jcr:content\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|[?#])/i.test(lowered)) return true;
  if (/^https?:\/\/[^/]+\/jcr:content(?:$|[?#])/i.test(lowered)) return true;
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
    return crypto.createHash("sha1").update(raw).digest("hex");
  }
  try {
    const parsed = new URL2(raw);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const leaf = filenameFromUrlPath2(raw).toLowerCase();
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
  if (!/-\d+x\d+\./i.test(url)) score += 12;
  if (/\.(?:png|jpe?g|webp|avif)(\?|$)/i.test(url)) score += 8;
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
  const sample = String(html || "").slice(0, 12e4).toLowerCase();
  if (/important safety information|full prescribing information|indicated for|wp-content\/uploads|\/\.imaging\//i.test(String(html || ""))) {
    return false;
  }
  return /robot-suspicion|checking the site connection security|cf-challenge|challenge-platform|datadome|verify you are human|access denied/i.test(sample);
};
var isLikelyBotWallExtract = (assets) => {
  const imgs = assets?.images || [];
  if (!imgs.length) return false;
  const botCount = imgs.filter((img) => isBotWallImageUrl(String(img?.url || ""))).length;
  return botCount > 0 && botCount >= imgs.length - 1;
};
var staticExtractNeedsBrowser = (html, assets) => {
  const text = String(html || "");
  const fontHints = /fonts\.(?:googleapis|gstatic)|typekit|accelerator\.sanofi|use\.typekit|@font-face|rel=["']stylesheet["']/i.test(text);
  const videoHints = /youtube\.com|youtu\.be|vimeo\.com|wistia|brightcove|vidyard|\.(?:mp4|webm|m3u8)(?:[?#"'`<>\s\\)]|$)|<video\b|<iframe[^>]+src=/i.test(text);
  const lowFonts = (assets?.fonts?.length || 0) < 2;
  const lowVideos = (assets?.videos?.length || 0) === 0 && videoHints;
  return lowFonts && fontHints || lowVideos;
};
var shouldTryStaticBeforeBrowser = (html) => {
  const text = String(html || "");
  return text.length > 5e3 && !isSparseSiteHtml(text) && scoreSiteHtml(text, 200) >= 30;
};
var isRichStaticExtract = (assets) => {
  const imageCount = assets?.images?.length || 0;
  const fontCount = assets?.fonts?.length || 0;
  const videoCount = assets?.videos?.length || 0;
  if (videoCount > 0) return true;
  if (imageCount >= 4 || fontCount >= 3) return true;
  if (imageCount + fontCount >= 6) return true;
  return false;
};
var warmExtractedAssetList = async (images, fonts, limits, pageUrl = "") => {
  const started = Date.now();
  const imageWarmPriority = (img) => {
    const url = String(img?.url || "");
    if (url.startsWith("data:")) return 0;
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
var dedupeExtractedAssets = async (images, videos, fonts, colors, targetUrl, fallbackThumb = "", options = {}) => {
  const uniqueImages = dedupeImagesByCanonicalKey(
    Array.from(new Set(images.map((item) => item.url))).map((url) => images.find((item) => item.url === url)).filter(Boolean).filter((img) => !isBotWallImageUrl(String(img?.url || ""))).filter((img) => !isJunkImageUrl(String(img?.url || "")))
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
    const sanitized = sanitizeVideoForClient(video, targetUrl);
    if (!sanitized?.url) return;
    const key = videoKey(sanitized);
    const normalizedVideo = !sanitized.thumbnail && fallbackThumb ? { ...sanitized, thumbnail: fallbackThumb } : sanitized;
    const current = videoByKey.get(key);
    if (!current || videoRank(normalizedVideo) > videoRank(current)) {
      videoByKey.set(key, normalizedVideo);
    }
  });
  const uniqueVideos = options.fast ? normalizeVisibleVideoStreams(attachYouTubeWatchUrlToVideos(Array.from(videoByKey.values())), targetUrl) : await prepareVisibleVideoStreams(attachYouTubeWatchUrlToVideos(Array.from(videoByKey.values())), targetUrl);
  let uniqueFonts = dedupeFontsByLogicalKey(
    Array.from(new Set(fonts.map((font) => font.url))).map((url) => pickBestFontForUrl(fonts, url)).filter(Boolean).filter(isSupportedFontAsset)
  );
  if (!options.fast && uniqueFonts.length > 0 && uniqueFonts.length <= 12) {
    uniqueFonts = await filterUnavailableSitecoreFonts(uniqueFonts, targetUrl);
  } else if (uniqueFonts.length > 0) {
    void filterUnavailableSitecoreFonts(uniqueFonts, targetUrl).catch(() => void 0);
  }
  const uniqueColors = pickPrimaryUiColors(Array.from(new Set(colors)).filter((color) => color.length > 0), 6);
  if (options.fast) {
    const imageLimit = Math.min(uniqueImages.length, 48);
    await warmExtractedAssetList(uniqueImages, [], {
      imageLimit,
      fontLimit: 0,
      budgetMs: Math.min(45e3, 12e3 + imageLimit * 500)
    }, targetUrl);
    const stillUncached = uniqueImages.filter((img) => !img?.cachedUrl && String(img?.url || "").startsWith("http")).slice(0, 24).map((img) => String(img.url));
    if (stillUncached.length) {
      try {
        await withTimeout(
          fetchRemoteImageBuffersViaBrowserBatch(stillUncached, targetUrl),
          75e3,
          `Browser batch warm for ${targetUrl}`
        );
        for (const img of uniqueImages) {
          if (img?.cachedUrl) continue;
          const url = String(img?.url || "");
          if (!url) continue;
          const existing = await readExistingOriginalAssetUrl(url, "image");
          if (existing) {
            img.cachedUrl = existing;
            img.status = "downloaded";
          }
        }
      } catch {
      }
    }
    warmExtractedAssetsInBackground(
      uniqueImages.slice(imageLimit),
      uniqueFonts,
      targetUrl
    );
  } else {
    const imageLimit = Math.min(uniqueImages.length, 200);
    const fontLimit = Math.min(uniqueFonts.length, 80);
    await warmExtractedAssetList(uniqueImages, uniqueFonts, {
      imageLimit,
      fontLimit,
      budgetMs: Math.min(18e4, 2e4 + imageLimit * 240 + fontLimit * 200)
    }, targetUrl);
    warmExtractedAssetsInBackground(
      uniqueImages.slice(imageLimit),
      uniqueFonts.slice(fontLimit),
      targetUrl
    );
  }
  const attachCachedUrl = async (asset, kind) => {
    const url = String(asset?.url || "");
    if (!url || url.startsWith("data:")) return withAssetStatus(asset);
    let cachedUrl = await readExistingOriginalAssetUrl(url, kind);
    let enriched = asset;
    if (!cachedUrl && kind === "image" && !options.fast) {
      try {
        const warmed = await withTimeout(
          warmCachedOriginalAssetForExtraction(
            url,
            "image",
            inferImageTypeFromUrl(url, String(asset?.type || "")) || getAssetTypeFromUrl(url, asset?.type || "bin"),
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
            status: "downloaded",
            ...warmed.bytes ? { bytes: warmed.bytes } : {},
            ...warmed.width ? { width: warmed.width } : {},
            ...warmed.height ? { height: warmed.height } : {}
          };
        }
      } catch {
      }
    }
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
  const resultImages = (await Promise.all(uniqueImages.map((img) => attachCachedUrl(enrichImageAssetMeta(img), "image")))).sort((a, b) => {
    const rank = (item) => item?.cachedUrl || item?.status === "downloaded" ? 0 : item?.status === "path-only" ? 1 : 2;
    return rank(a) - rank(b);
  });
  const resultVideos = uniqueVideos.map((video) => withAssetStatus(video));
  const resultFonts = await Promise.all(uniqueFonts.map((font) => attachCachedUrl(font, "font")));
  return {
    images: resultImages,
    videos: resultVideos,
    fonts: resultFonts,
    colors: uniqueColors
  };
};
var enrichAssetsFromHtml = async (html, targetUrl, assets, options = {}) => {
  const $ = cheerio.load(html);
  const pagePrimaryThumb = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
  const resolvedPagePrimaryThumb = pagePrimaryThumb ? resolveUrl(targetUrl, pagePrimaryThumb) || pagePrimaryThumb : "";
  const pageTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").first().text().trim() || "Video link";
  extractVimeoUrlsFromText(html, targetUrl).forEach((vimeoUrl) => assets.vimeoCandidateUrls.add(vimeoUrl));
  extractWistiaIdsFromText(html, targetUrl).forEach((wistiaId) => assets.wistiaCandidateIds.add(wistiaId));
  assets.images.push(...extractImagesFromDom($, targetUrl));
  assets.images.push(...extractImagesFromHtmlString(html, targetUrl));
  const rawAssets = extractAssetsFromRawText(html, targetUrl);
  assets.images.push(...rawAssets.images);
  assets.videos.push(...rawAssets.videos);
  assets.fonts.push(...rawAssets.fonts);
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
  return { resolvedPagePrimaryThumb, pageTitle };
};
var extractStaticAssets = async (targetUrl, preloadedHtml = "", options = {}) => {
  const images = [];
  const videos = [];
  let fonts = [];
  let colors = [];
  const vimeoCandidateUrls = /* @__PURE__ */ new Set();
  const wistiaCandidateIds = /* @__PURE__ */ new Set();
  const html = preloadedHtml || await withTimeout(fetchSiteHtml(targetUrl), 28e3, `Static HTML fetch for ${targetUrl}`).catch(() => "");
  const { resolvedPagePrimaryThumb } = await enrichAssetsFromHtml(html, targetUrl, {
    images,
    videos,
    fonts,
    colors,
    vimeoCandidateUrls,
    wistiaCandidateIds
  }, { fast: options.fast });
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
  if (options.fast && isRichStaticExtract({ images, fonts, videos })) {
    const stylesheetLinks = (html.match(/<link[^>]+rel=["']stylesheet["']/gi) || []).length;
    const fontCssHints = (html.match(/fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|accelerator\.sanofi|@font-face|\.woff2/gi) || []).length;
    const canSkipCssFetch = stylesheetLinks === 0 || fonts.length >= 3 || fonts.length >= 1 && fontCssHints === 0;
    if (canSkipCssFetch) {
      return dedupeExtractedAssets(images, videos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: true });
    }
  }
  const cssBundle = await withTimeout(
    fetchCssSourceCandidates(targetUrl, html, { fast: options.fast }),
    options.fast ? 4e3 : 1e4,
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
  if (!options.fast && vimeoCandidateUrls.size > 0) {
    try {
      const vimeoAssets = await withTimeout(
        extractVimeoVideos(Array.from(vimeoCandidateUrls), "fhd", targetUrl),
        VIMEO_EXTRACT_TIMEOUT_MS,
        `Static Vimeo extraction for ${targetUrl}`
      );
      videos.push(...vimeoAssets.videos || []);
      images.push(...vimeoAssets.images || []);
    } catch (error) {
      console.warn("Static Vimeo extraction failed, using placeholders:", error?.message || error);
      videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
    }
  } else if (options.fast && vimeoCandidateUrls.size > 0) {
    videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
  }
  if (!options.fast && wistiaCandidateIds.size > 0) {
    try {
      const wistiaAssets = await withTimeout(
        extractWistiaVideos(Array.from(wistiaCandidateIds), "fhd"),
        8e3,
        `Static Wistia extraction for ${targetUrl}`
      );
      videos.push(...wistiaAssets.videos || []);
      images.push(...wistiaAssets.images || []);
    } catch (error) {
      console.warn("Static Wistia extraction failed, using placeholders:", error?.message || error);
      videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
    }
  } else if (options.fast && wistiaCandidateIds.size > 0) {
    videos.push(...createWistiaSourceVideos(Array.from(wistiaCandidateIds)));
  }
  return dedupeExtractedAssets(images, videos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: options.fast });
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
  const stat = await fsp2.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 1024) {
    throw new Error(`${label} output was not created.`);
  }
  return stat;
};
var validateSavedAssetFile = async (outputPath, label) => {
  const stat = await fsp2.stat(outputPath).catch(() => null);
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
var assertLocalFileHasAudio = async (inputPath) => {
  const metadata = await probeMediaFile(inputPath);
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const audioStream = streams.find((stream) => stream?.codec_type === "audio" && stream?.codec_name && stream.codec_name !== "unknown");
  if (!audioStream) {
    throw new MediaExtractionError("Audio track unavailable for this video.", 422);
  }
  return audioStream;
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
    width: Number(videoStream?.width || 0) || void 0,
    height: Number(videoStream?.height || 0) || void 0,
    duration: Number(metadata?.format?.duration || 0) || void 0,
    bitrate: Number(metadata?.format?.bit_rate || 0) || void 0
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
    cmd.on("start", markActivity).on("codecData", markActivity).on("progress", markActivity).on("stderr", markActivity).on("end", () => finish()).on("close", markActivity).on("exit", markActivity).on("error", (err) => finish(err)).save(outputPath);
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
    const out = fs.createWriteStream(outputPath);
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
    await execFileAsync("open", [folderPath]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", folderPath]);
    return;
  }
  await execFileAsync("xdg-open", [folderPath]);
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
    if (ffmpegPath) await fsp2.chmod(String(ffmpegPath), 493).catch(() => void 0);
    const ytdlpPath = resolveYtDlpPath();
    await fsp2.chmod(String(ytdlpPath), 493).catch(() => void 0);
    const chromiumPath = findBundledChromiumExecutable();
    if (chromiumPath) await fsp2.chmod(chromiumPath, 493).catch(() => void 0);
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
  await fsp2.mkdir(generatedThumbnailDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(normalized).digest("hex");
  const outputPath = path2.join(generatedThumbnailDir, `${hash}.jpg`);
  const existing = await fsp2.stat(outputPath).catch(() => null);
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
    await fsp2.unlink(outputPath).catch(() => void 0);
    const validation = await validateStreamUrl(normalized, sourcePageUrl).catch(() => null);
    const isManifestSource = /\.m3u8|\.mpd/i.test(normalized) || /mpegurl|dash\+xml/i.test(String(validation?.contentType || ""));
    const isSmallEnoughForFallback = !validation?.contentLength || validation.contentLength <= 60 * 1024 * 1024;
    if (isManifestSource || !isSmallEnoughForFallback) throw remoteError;
    let tempInput = "";
    try {
      const parsed = new URL2(normalized);
      const ext = path2.extname(parsed.pathname) || ".bin";
      tempInput = path2.join(generatedThumbnailDir, `${hash}-source${ext}`);
      await downloadUrlToFile(normalized, tempInput, sourcePageUrl);
      await renderFrame(tempInput, false);
    } finally {
      if (tempInput) await fsp2.unlink(tempInput).catch(() => void 0);
    }
  }
  return toAbsoluteAppUrl(req, `/generated-thumbnails/${hash}.jpg`);
};
var getVideoPreviewMetadata = async (targetUrl) => {
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
var getFhdMp4FormatSelector = (quality) => {
  const targetHeight = getVimeoTargetHeight(quality);
  return [
    `bv*[height<=${targetHeight}][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best[height<=${targetHeight}][ext=mp4]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio`,
    `best[height<=${targetHeight}][ext=mp4]`,
    `best[height<=${targetHeight}]`,
    "best[ext=mp4]/best"
  ].join("/");
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
  try {
    const html = await fetchVimeoPlayerHtml(vimeoId, sourcePageUrl);
    const config = parseVimeoPlayerConfigFromHtml(html);
    if (config) return { config, source: "player-page" };
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
    const page = await browser.newPage();
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
  console.log(`[vimeo:${vimeoId}] Progressive MP4 found: ${formatVimeoHeightList(debug.progressiveHeights)}`);
  const hlsLines = debug.hlsHeights.length > 0 ? debug.hlsHeights.map((height) => `- ${height}p`).join("\n") : "- none";
  console.log(`[vimeo:${vimeoId}] HLS variants found:
${hlsLines}`);
  if (debug.dashHeights.length > 0) {
    console.log(`[vimeo:${vimeoId}] DASH qualities: ${formatVimeoHeightList(debug.dashHeights)}`);
  }
  console.log(
    `[vimeo:${vimeoId}] Config source: ${debug.configSource || "none"} | FHD available: ${debug.fhdAvailable ? "yes" : "no"}`
  );
};
var resolveVimeoQualityStreams = async (vimeoUrl, sourcePageUrl, ytDlpInfo) => {
  const vimeoId = parseVimeoIdFromUrl(vimeoUrl);
  const title = ytDlpInfo?.title || "Vimeo video";
  const thumbnail = sanitizeStreamUrl(ytDlpInfo?.thumbnail || "", vimeoUrl) || ytDlpInfo?.thumbnail;
  const duration = Number(ytDlpInfo?.duration || 0) || void 0;
  const formats = Array.isArray(ytDlpInfo?.formats) ? ytDlpInfo.formats : [];
  const progressiveFormats = formats.filter(isVimeoProgressiveMp4Format).sort((a, b) => (b.height || 0) - (a.height || 0));
  const progressiveByHeight = /* @__PURE__ */ new Map();
  progressiveFormats.forEach((format) => {
    const height = parseCandidateHeight(format) || Number(format.height || 0);
    if (!height) return;
    const current = progressiveByHeight.get(height);
    if (!current || Number(format.tbr || 0) > Number(current.tbr || 0)) progressiveByHeight.set(height, format);
  });
  const progressiveHeights = Array.from(progressiveByHeight.keys()).sort((a, b) => b - a);
  let configSource = "";
  let playerConfig = null;
  let hlsMasterUrl = "";
  let hlsVariants = [];
  let dashHeights = [];
  const playerConfigResult = vimeoId ? await loadVimeoPlayerConfig(vimeoId, sourcePageUrl) : null;
  if (playerConfigResult?.config) {
    playerConfig = playerConfigResult.config;
    configSource = playerConfigResult.source;
    hlsMasterUrl = getVimeoManifestUrlFromConfig(playerConfig, "hls");
    dashHeights = getVimeoDashQualityHeights(playerConfig);
    if (!title && playerConfig?.video?.title) {
    }
  }
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
    fhdAvailable
  };
  if (vimeoId) logVimeoQualityDiscovery(vimeoId, debug);
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
  return {
    vimeoId,
    title: playerConfig?.video?.title || title,
    thumbnail: sanitizeStreamUrl(playerConfig?.video?.thumbnail_url || thumbnail || "", vimeoUrl) || thumbnail,
    duration: Number(playerConfig?.video?.duration || duration || 0) || void 0,
    streams: resolved,
    debug
  };
};
var brightcovePolicyCache = /* @__PURE__ */ new Map();
var brightcoveMetadataCache = /* @__PURE__ */ new Map();
var brightcoveMetadataTtlMs = 3 * 60 * 1e3;
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
var getBrightcovePolicyKey = async (accountId, playerId) => {
  const normalizedPlayer = playerId.endsWith("_default") ? playerId : `${playerId}_default`;
  const cacheKey = `${accountId}:${normalizedPlayer}`;
  const cached = brightcovePolicyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.policyKey;
  const playerJsUrl = `https://players.brightcove.net/${accountId}/${normalizedPlayer}/index.min.js`;
  const response = await axios.get(playerJsUrl, {
    timeout: 1e4,
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
};
var getBrightcoveMetadata = async (playerUrl) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) throw new Error("Invalid Brightcove player URL.");
  const normalizedPlayer = parsed.playerId.endsWith("_default") ? parsed.playerId : `${parsed.playerId}_default`;
  const cacheKey = `${parsed.accountId}:${normalizedPlayer}:${parsed.videoId}`;
  const cached = brightcoveMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const policyKey = await getBrightcovePolicyKey(parsed.accountId, parsed.playerId);
  const playbackUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${parsed.accountId}/videos/${parsed.videoId}`;
  const response = await axios.get(playbackUrl, {
    timeout: 12e3,
    httpsAgent: relaxedHttpsAgent,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": `application/json;pk=${policyKey}`
    }
  });
  const info = response.data || {};
  brightcoveMetadataCache.set(cacheKey, { expiresAt: Date.now() + brightcoveMetadataTtlMs, info });
  return info;
};
var getYouTubeVideoId = (rawUrl) => {
  try {
    const parsed = new URL2(normalizeYouTubeWatchUrl(rawUrl));
    return parsed.searchParams.get("v") || "";
  } catch {
    return "";
  }
};
var getYouTubeDirectFormatSelector = (quality) => {
  const targetHeight = getVimeoTargetHeight(quality);
  return [
    `best[height=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[height<=${targetHeight}][ext=mp4][acodec!=none][vcodec!=none]`,
    `best[ext=mp4][acodec!=none][vcodec!=none]`,
    `bestvideo[height=${targetHeight}][ext=mp4]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]`
  ].join("/");
};
var getYouTubeMergeFormatSelector = (quality) => {
  const targetHeight = getVimeoTargetHeight(quality);
  return [
    `bestvideo[height<=${targetHeight}][vcodec^=avc1][ext=mp4]+bestaudio[acodec!=none][ext=m4a]/bestaudio[acodec!=none][ext=m4a]`,
    `bestvideo[height<=${targetHeight}][vcodec^=avc1]+bestaudio[acodec!=none]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]/bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio/best`
  ].join("/");
};
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
  const muxedFormat = [
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
  const splitFormat = [
    `bestvideo[height=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${targetHeight}]+bestaudio`,
    `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio`
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
  const cmd = ffmpeg().input(videoUrl).inputOptions(["-headers", headers]).input(audioUrl).inputOptions(["-headers", headers]).outputOptions([
    "-map 0:v:0",
    "-map 1:a:0",
    "-c:v copy",
    "-c:a aac",
    "-b:a 192k",
    "-shortest",
    "-movflags +faststart",
    "-f mp4"
  ]).format("mp4");
  await waitForFfmpegFile(cmd, outputPath, "YouTube audio merge");
};
var youtubeMergeCacheDir = path2.join(convertedVideoDir, "youtube-merge-cache");
var getYouTubeMergeCachePath = (watchUrl, quality) => {
  const videoId = getYouTubeVideoId(watchUrl) || crypto.createHash("sha1").update(normalizeYouTubeWatchUrl(watchUrl)).digest("hex").slice(0, 12);
  return path2.join(youtubeMergeCacheDir, `${videoId}-${quality}-h264.mp4`);
};
var mergeYouTubeWithYtDlp = async (watchUrl, quality, outputPath) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  await fsp2.mkdir(path2.dirname(outputPath), { recursive: true });
  const outputTemplate = outputPath.replace(/\.mp4$/i, ".%(ext)s");
  await withTimeout(
    youtubedl(normalizedWatchUrl, {
      ...buildYtDlpDownloadOptions(normalizedWatchUrl, quality, void 0, outputTemplate)
    }),
    10 * 60 * 1e3,
    `YouTube yt-dlp merge for ${normalizedWatchUrl}`
  );
  return validateOutputFile(outputPath, "YouTube merged download");
};
var mergeYouTubeWatchUrlToFile = async (watchUrl, quality, outputPath) => {
  try {
    return await mergeYouTubeWithYtDlp(watchUrl, quality, outputPath);
  } catch (ytdlpError) {
    console.warn("YouTube yt-dlp merge failed, trying ffmpeg split merge:", ytdlpError?.message || ytdlpError);
    const parts = await getYouTubeStreamParts(watchUrl, quality);
    if (parts.audioUrl) {
      await mergeYouTubePartsToFile(parts.videoUrl, parts.audioUrl, outputPath, watchUrl);
      return validateOutputFile(outputPath, "YouTube merged download");
    }
    if (parts.muxedUrl) {
      const headers = buildYouTubeFfmpegHeaders(watchUrl);
      const cmd = ffmpeg(parts.muxedUrl).inputOptions(["-headers", headers]).outputOptions(["-c copy", "-movflags +faststart", "-f mp4"]).format("mp4");
      await waitForFfmpegFile(cmd, outputPath, "YouTube muxed copy");
      return validateOutputFile(outputPath, "YouTube merged download");
    }
    throw ytdlpError;
  }
};
var pipeYouTubeMergedStream = async (req, res, watchUrl, quality, options = {}) => {
  await fsp2.mkdir(youtubeMergeCacheDir, { recursive: true });
  const cachedPath = getYouTubeMergeCachePath(watchUrl, quality);
  try {
    await validateOutputFile(cachedPath, "YouTube merge cache");
  } catch {
    await mergeYouTubeWatchUrlToFile(watchUrl, quality, cachedPath);
  }
  const stat = await fsp2.stat(cachedPath);
  const fileSize = stat.size;
  const preferredName = (options.filename || `${toSafeFileBase(pageTitleFromUrl(watchUrl))}.mp4`).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
  const contentType = "video/mp4";
  const disposition = `${options.inline ? "inline" : "attachment"}; filename="${preferredName || "youtube-video.mp4"}"`;
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
  const rangeHeader = String(req.headers.range || "");
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (rangeMatch) {
    const start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
    const end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= fileSize || start > end) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).end();
    }
    const chunkSize = end - start + 1;
    setCommonHeaders();
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", String(chunkSize));
    const stream2 = fs.createReadStream(cachedPath, { start, end });
    stream2.on("error", (error) => {
      console.error("YouTube merged range stream read error:", error?.message || error);
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream merged YouTube video." });
      else res.end();
    });
    return stream2.pipe(res);
  }
  setCommonHeaders();
  res.status(200);
  res.setHeader("Content-Length", String(fileSize));
  const stream = fs.createReadStream(cachedPath);
  stream.on("error", (error) => {
    console.error("YouTube merged stream read error:", error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: "Failed to stream merged YouTube video." });
    else res.end();
  });
  stream.pipe(res);
};
var toYouTubeMergedDownloadUrl = (watchUrl, quality, titleHint) => {
  const normalizedWatchUrl = normalizeYouTubeWatchUrl(watchUrl);
  const filename = `${toSafeFileBase(titleHint || "video")}.mp4`;
  return `/api/youtube-merged-stream?url=${encodeURIComponent(normalizedWatchUrl)}&quality=${quality}&inline=1&filename=${encodeURIComponent(filename)}`;
};
var buildYouTubeMergedCard = (watchUrl, quality, titleHint) => {
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
    provider: "youtube",
    type: "mp4",
    title,
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
    resolution: `${targetHeight}p`,
    height: targetHeight,
    width: targetHeight === 1080 ? 1920 : targetHeight === 720 ? 1280 : void 0,
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
    verifiedPlayable: true
  };
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
  const targetHeight = getVimeoTargetHeight(quality);
  const directUrl = await withTimeout(
    youtubedl(rawUrl, {
      getUrl: true,
      format: getYouTubeDirectFormatSelector(quality),
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
var buildYtDlpBaseOptions = () => ({
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  ...ffmpegPath ? { ffmpegLocation: path2.dirname(String(ffmpegPath)) } : {}
});
var buildYtDlpAuthOptions = (targetUrl) => {
  if (process.platform === "darwin" && needsBrowserCookiesForUrl(targetUrl)) {
    return { cookiesFromBrowser: "safari" };
  }
  return {};
};
var buildYtDlpRefererOptions = (targetUrl, sourcePageUrl) => {
  const refererPage = String(sourcePageUrl || "").trim();
  if (!refererPage) return {};
  try {
    const targetHost = new URL2(targetUrl).hostname.replace(/^www\./, "").toLowerCase();
    const refererHost = new URL2(refererPage).hostname.replace(/^www\./, "").toLowerCase();
    if (isVimeoUrl(targetUrl) && refererHost !== targetHost) {
      return { referer: refererPage };
    }
  } catch {
  }
  return {};
};
var buildYtDlpSpeedOptions = () => {
  if (!aria2Path || !fs.existsSync(aria2Path)) return {};
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
    format: isYouTube ? getYouTubeMergeFormatSelector(quality) : getFhdMp4FormatSelector(quality),
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
    if (host.includes("brightcove.net")) return "brightcove";
    if (host.includes("tiktok.com")) return "tiktok";
    return "platform";
  } catch {
    return "platform";
  }
};
var isPlatformVideoUrl = (rawUrl) => {
  try {
    const parsed = new URL2(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path3 = parsed.pathname.toLowerCase();
    if (/(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl)) return true;
    if (host === "youtu.be") return path3.replace(/^\/+/, "").length > 0;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      return Boolean(parsed.searchParams.get("v")) || /\/(?:embed|shorts|live)\//.test(path3);
    }
    if (host === "player.vimeo.com") return /\/video\/\d+/.test(path3) || /\/progressive_redirect\/download\/\d+/.test(path3);
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      if (/\/progressive_redirect\/download\/\d+/.test(path3)) return true;
      if (/^\/\d+(?:\/|$)/.test(path3)) return true;
      if (/\.(ico|js|css|json)(\?|$)/i.test(path3)) return false;
      if (/^\/(?:api|add|ablincoln|favicon|channels|groups|ondemand|categories)\b/.test(path3)) return false;
      const segments = path3.split("/").filter(Boolean);
      return segments.length >= 2;
    }
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") {
      return host === "fb.watch" || /\/(?:watch|reel|videos?)\b|\/videos\//.test(path3);
    }
    if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) return /\/status(?:es)?\//.test(path3);
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return /\/(?:reel|reels|p|tv)\//.test(path3);
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return /\/video\//.test(path3);
    if (host === "players.brightcove.net" || host.endsWith(".players.brightcove.net")) {
      return /\/index\.html$/i.test(path3) && Boolean(parsed.searchParams.get("videoId"));
    }
    if (host.includes("wistia.com") || host.includes("wistia.net")) {
      return /\/(?:embed\/(?:medias|iframe)|medias)\/[a-z0-9]{8,12}/i.test(path3);
    }
    return false;
  } catch {
    return /(\.mp4|\.webm|\.mov|\.mkv|\.m3u8|\.mpd)(\?|$)/i.test(rawUrl);
  }
};
var isVideoPlatformHostUrl = (rawUrl) => {
  try {
    const host = new URL2(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host === "vimeo.com" || host.endsWith(".vimeo.com") || host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com") || host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch" || host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
};
var isLikelyVideoAssetUrl = (rawUrl) => {
  const value = String(rawUrl || "").toLowerCase();
  if (!value) return false;
  if (value.startsWith("data:")) return false;
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v|\.m3u8|\.mpd)(\?|$)/i.test(value)) return true;
  if (value.includes("wistia.com/deliveries/") || value.includes("wistia.net/deliveries/")) return true;
  if (value.includes("/videoplayback?") || value.includes("manifest") || value.includes("/video/")) return true;
  return false;
};
var isDirectProgressiveVideoUrl = (rawUrl) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(String(rawUrl || ""));
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
  const localPath = path2.join(targetDir, localFilename);
  let stat = null;
  let metadata = null;
  if (options.cache) {
    await fsp2.mkdir(targetDir, { recursive: true });
    const existing = await fsp2.stat(localPath).catch(() => null);
    if (!existing || existing.size <= 1024) {
      await downloadUrlToFile(normalizedUrl, localPath, sourcePageUrl);
    }
    stat = await validateOutputFile(localPath, "Direct video cache");
    metadata = await probeMediaFile(localPath).catch(() => null);
  } else {
    try {
      metadata = await probeRemoteVideoMetadata(normalizedUrl, sourcePageUrl);
    } catch {
      await fsp2.mkdir(targetDir, { recursive: true });
      const tempPath = path2.join(targetDir, `.probe-${Date.now()}-${localFilename}`);
      try {
        await downloadUrlToFile(normalizedUrl, tempPath, sourcePageUrl);
        stat = await validateOutputFile(tempPath, "Direct video probe");
        metadata = await probeMediaFile(tempPath);
        await fsp2.rename(tempPath, localPath).catch(async () => {
          await fsp2.copyFile(tempPath, localPath);
          await fsp2.unlink(tempPath).catch(() => void 0);
        });
        stat = await fsp2.stat(localPath);
      } finally {
        await fsp2.unlink(tempPath).catch(() => void 0);
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
  const fileStat = stat || await fsp2.stat(localPath).catch(() => null);
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
var matchesStrictQuality = (height, quality) => {
  if (!height) return false;
  if (quality === "hd") return height === 720;
  if (quality === "fhd") return height === 1080;
  if (quality === "4k") return height >= 2160;
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
    if (video?.isVimeo && !video?.isVimeoDirect) return true;
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
  const prepared = await mapWithConcurrency(visible, 3, async (video) => {
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
var selectHlsVariantUrl = async (manifestUrl, targetHeight, sourcePageUrl) => {
  const variants = await extractHlsVariants(manifestUrl, sourcePageUrl);
  const selected = variants.map((variant) => ({
    variant,
    distance: variant.height ? Math.abs(variant.height - targetHeight) : 9999,
    abovePenalty: variant.height && variant.height > targetHeight ? 500 : 0,
    bitrate: Number(variant.bandwidth || 0)
  })).sort((a, b) => a.distance + a.abovePenalty - (b.distance + b.abovePenalty) || b.bitrate - a.bitrate)[0]?.variant;
  return selected?.url || manifestUrl;
};
var extractBrightcoveVideos = async (playerUrl) => {
  const parsed = parseBrightcovePlayerUrl(playerUrl);
  if (!parsed) return { videos: [], images: [] };
  const info = await getBrightcoveMetadata(playerUrl);
  const durationRaw = Number(info.duration || 0);
  const duration = durationRaw > 1e4 ? Math.round(durationRaw / 1e3) : durationRaw || void 0;
  const thumbnail = sanitizeStreamUrl(info.poster || info.thumbnail || info.thumbnail_sources?.[0]?.src || "", playerUrl) || info.poster || info.thumbnail || "";
  const sources = Array.isArray(info.sources) ? info.sources : [];
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
      brightcoveAccountId: parsed.accountId,
      brightcovePlayerId: parsed.playerId,
      brightcoveVideoId: parsed.videoId
    };
  });
  const images = thumbnail ? [{ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, "jpg") }] : [];
  if (videos.length > 0) return { videos, images };
  const hlsSource = sources.find((source) => {
    const src = String(source?.src || "");
    const type = String(source?.type || "").toLowerCase();
    return src && (src.includes(".m3u8") || type.includes("mpegurl"));
  });
  const hlsUrl = sanitizeStreamUrl(String(hlsSource?.src || ""), playerUrl) || "";
  const hlsVariants = hlsUrl ? await extractHlsVariants(hlsUrl, playerUrl).catch(() => []) : [];
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
  await fsp2.mkdir(convertedVideoDir, { recursive: true });
  const targetHeight = getVimeoTargetHeight(quality);
  const tempBase = `merged-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempOutput = path2.join(convertedVideoDir, `${tempBase}.mp4`);
  const safeFilename = `${toSafeFileBase(titleHint || "video")}-${quality}.mp4`;
  const targetDir = resolveDownloadsTargetDir(options.sourcePageUrl);
  await fsp2.mkdir(targetDir, { recursive: true });
  const finalPath = path2.join(targetDir, safeFilename);
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
    await fsp2.rename(tempOutput, finalPath).catch(async () => {
      await fsp2.copyFile(tempOutput, finalPath);
      await fsp2.unlink(tempOutput).catch(() => void 0);
    });
    const stat = await validateOutputFile(finalPath, "Merged MP4 fallback");
    return {
      url: toLocalVideoDownloadUrl(req, safeFilename, options.sourcePageUrl),
      localPath: finalPath,
      downloadPath: finalPath,
      sourceUrl: targetUrl,
      provider: platformProviderFromUrl(targetUrl),
      type: "mp4",
      title: titleHint || "Video",
      resolution: `${targetHeight}p`,
      height: targetHeight,
      isDirect: true,
      isLocalMerged: true,
      verifiedPlayable: true,
      qualityRequested: quality,
      filesize: stat.size
    };
  } catch (error) {
    await fsp2.unlink(tempOutput).catch(() => void 0);
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
var extractVimeoVideos = async (vimeoUrls, quality = "fhd", sourcePageUrl = "") => {
  const uniqueUrls = Array.from(new Set(vimeoUrls.map(normalizeVimeoUrl).filter(Boolean)));
  const results = await mapWithConcurrency(uniqueUrls.slice(0, 12), 4, async (vimeoUrl) => {
    try {
      const info = await getVimeoMetadata(vimeoUrl, sourcePageUrl);
      const resolved = await resolveVimeoQualityStreams(vimeoUrl, sourcePageUrl, info);
      const videos = [];
      const images = [];
      const thumbnail = resolved.thumbnail;
      if (thumbnail) {
        images.push({ url: thumbnail, type: getAssetTypeFromUrl(thumbnail, "jpg") });
      }
      const streamBuckets = Object.entries(resolved.streams);
      if (streamBuckets.length > 0) {
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
            title: resolved.title || "Vimeo video",
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
      } else {
        videos.push({
          url: vimeoUrl,
          provider: "vimeo",
          isVimeo: true,
          type: "vimeo",
          title: resolved.title || info.title || "Vimeo video",
          thumbnail,
          vimeoQualityDebug: resolved.debug
        });
      }
      return { videos, images };
    } catch (error) {
      console.warn(`Vimeo extraction failed for ${vimeoUrl}:`, error.message || error);
      const cleanError = String(error?.message || error || "").slice(0, 260);
      return {
        images: [],
        videos: [{
          url: vimeoUrl,
          provider: "vimeo",
          isVimeo: true,
          type: "vimeo",
          title: "Vimeo video",
          unresolvable: true,
          resolveError: cleanError,
          qualityFallbackMessage: "This Vimeo link could not be resolved (unavailable or restricted)."
        }]
      };
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
app.post("/api/extract", async (req, res) => {
  const { url, mode } = req.body;
  let browser = null;
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    const targetUrl = new URL2(url).href;
    assertPublicAssetUrl(targetUrl);
    lastExtractedSourceUrl = targetUrl;
    const useStaticExtract = mode === "static";
    if (isVideoPlatformHostUrl(targetUrl) && !isPlaylistUrl(targetUrl) && !isPlatformVideoUrl(targetUrl)) {
      return res.json({
        images: [],
        videos: [],
        fonts: [],
        colors: []
      });
    }
    if (useStaticExtract) {
      const staticAssets = await extractStaticAssets(targetUrl);
      return res.json(staticAssets);
    }
    const prefetchedSiteHtml = await withTimeout(
      fetchSiteHtml(targetUrl),
      12e3,
      `Prefetch HTML for ${targetUrl}`
    ).catch(() => "");
    const staticFallbackAssets = async () => extractStaticAssets(targetUrl, prefetchedSiteHtml);
    if (prefetchedSiteHtml && shouldTryStaticBeforeBrowser(prefetchedSiteHtml)) {
      try {
        const staticQuick = await withTimeout(
          extractStaticAssets(targetUrl, prefetchedSiteHtml, { fast: true }),
          12e3,
          `Static fast path for ${targetUrl}`
        );
        if (isRichStaticExtract(staticQuick) && !staticExtractNeedsBrowser(prefetchedSiteHtml, staticQuick)) {
          return res.json(staticQuick);
        }
      } catch (error) {
        console.warn("Static fast path skipped, continuing with browser route:", error?.message || error);
      }
    }
    const images = [];
    const videos = [];
    let fonts = [];
    let colors = [];
    const vimeoCandidateUrls = /* @__PURE__ */ new Set();
    const wistiaCandidateIds = /* @__PURE__ */ new Set();
    const embeddedPageUrls = /* @__PURE__ */ new Set();
    const isYouTube = targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be");
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
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(targetUrl);
      const immediateVideos = ["fhd", "hd"].map((quality) => buildYouTubeMergedCard(normalizedWatchUrl, quality));
      return res.json({
        images: [],
        videos: immediateVideos,
        fonts: [],
        colors: []
      });
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
            cleanVideos = createVimeoSourceVideos([vimeoUrl]).map((video) => ({
              ...video,
              unresolvable: true,
              resolveError: "Vimeo progressive streams were not available for this link.",
              qualityFallbackMessage: "Try HD/FHD download or check that the video is public."
            }));
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
            videos: createVimeoSourceVideos([vimeoUrl]).map((video) => ({
              ...video,
              unresolvable: true,
              resolveError: String(error?.message || error || "Vimeo extraction failed").slice(0, 260),
              qualityFallbackMessage: "This Vimeo link could not be resolved (timeout, private, or restricted)."
            })),
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
    browser = await launchPuppeteerBrowser();
    const page = await browser.newPage();
    await applyPuppeteerStealth(page);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      if (["websocket", "eventsource", "manifest", "other"].includes(resourceType)) {
        request.abort();
        return;
      }
      if (/google-analytics|googletagmanager|doubleclick|facebook\.net\/tr|hotjar|clarity\.ms|segment\.io/i.test(requestUrl)) {
        request.abort();
        return;
      }
      request.continue();
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
        const looksLikeImageResponse = resourceType === "image" || /^image\//i.test(contentType);
        if (looksLikeImageResponse && (isLikelyImageAssetUrl(url2, contentType) || resourceType === "image")) {
          images.push({
            url: url2,
            type: inferImageTypeFromUrl(url2, contentType) || getAssetTypeFromUrl(url2, "img"),
            status: DEFAULT_ASSET_STATUS
          });
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
            const cssText = String(await withTimeout(Promise.resolve(response.text()), 1500, "Stylesheet read"));
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
      }
    };
    page.on("response", handlePageResponse);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 28e3 }).catch((e) => console.log("Goto timeout, continuing...", e?.message || e));
    const initialHtml = await page.content().catch(() => "");
    if (/robot-suspicion|challenge-platform|captcha-delivery|cf-challenge/i.test(initialHtml)) {
      await new Promise((resolve) => setTimeout(resolve, 4500));
      await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 35e3 }).catch(() => void 0);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
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
        const addId = (id) => {
          const clean = String(id || "").trim();
          if (/^\d{6,}$/.test(clean)) urls.add(`https://vimeo.com/${clean}`);
        };
        const scanText = (value) => {
          const text = String(value || "").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
          const re = /(?:https?:)?\/\/(?:player\.|api\.)?vimeo\.com\/(?:video\/|videos\/)?(\d+)/gi;
          let match;
          while ((match = re.exec(text)) !== null) addId(match[1]);
          const idRegex = /(?:vimeo(?:Video)?Id|vimeo_id|vimeoId|clip_id|clipId)["']?\s*[:=]\s*["']?(\d{6,})/gi;
          while ((match = idRegex.exec(text)) !== null) addId(match[1]);
        };
        Array.from(document.querySelectorAll("script")).map((script) => script.textContent || "").filter(Boolean).slice(0, 120).forEach(scanText);
        const attrNames = ["data-vimeo-id", "data-vimeoid", "data-video-id", "data-clip-id", "data-vimeo-video-id"];
        Array.from(document.querySelectorAll("[data-vimeo-id],[data-vimeoid],[data-video-id],[data-clip-id],[data-vimeo-video-id]")).slice(0, 120).forEach((node) => {
          for (const attr of attrNames) {
            const val = node.getAttribute(attr);
            if (val) addId(val);
          }
        });
        Array.from(document.querySelectorAll('video[src^="blob:"]')).slice(0, 40).forEach((video) => {
          const src = String(video.getAttribute("src") || "");
          if (!/blob:https?:\/\/player\.vimeo\.com/i.test(src)) return;
          const wrapper = video.closest("div, section, article");
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
    }
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
    `);
    colors = domColors;
    const html = await waitForRenderedSiteHtml(page);
    const $ = cheerio.load(html);
    const pagePrimaryThumb = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
    const resolvedPagePrimaryThumb = pagePrimaryThumb ? resolveUrl(targetUrl, pagePrimaryThumb) || pagePrimaryThumb : "";
    const pageTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").first().text().trim() || "Video link";
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
        embeddedPage = await browser.newPage();
        embeddedPage.on("response", handlePageResponse);
        await embeddedPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await embeddedPage.setRequestInterception(true);
        embeddedPage.on("request", (request) => {
          const resourceType = request.resourceType();
          if (["image", "font", "stylesheet"].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
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
    const cssQueue = prioritizeFontCssCandidates(Array.from(new Set(cssLinks))).slice(0, 48);
    const visitedCss = /* @__PURE__ */ new Set();
    const discoveredFonts = [];
    const discoveredImages = [];
    let hops = 0;
    while (cssQueue.length > 0 && hops < 24) {
      const batch = cssQueue.splice(0, 6).filter((url2) => !visitedCss.has(url2));
      if (batch.length === 0) break;
      hops += batch.length;
      batch.forEach((url2) => visitedCss.add(url2));
      const cssResults = await Promise.allSettled(batch.map(async (cssUrl) => {
        try {
          assertPublicAssetUrl(cssUrl);
          const cssResponse = await axios.get(cssUrl, {
            timeout: 3500,
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
                  cssQueue.push(importUrl);
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
    const realImageCount = images.filter((img) => !isBotWallImageUrl(String(img?.url || ""))).length;
    if (realImageCount < 5 && images.some((img) => isBotWallImageUrl(String(img?.url || "")))) {
      console.warn("Bot-wall detected during extract, reloading page:", targetUrl);
      await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 4e4 }).catch(() => void 0);
      await new Promise((resolve) => setTimeout(resolve, 5e3));
      const reloadHtml = await page.content().catch(() => "");
      if (reloadHtml && !/robot-suspicion/i.test(reloadHtml)) {
        await enrichAssetsFromHtml(reloadHtml, targetUrl, {
          images,
          videos,
          fonts,
          colors,
          vimeoCandidateUrls,
          wistiaCandidateIds
        });
      }
    }
    await page.close().catch(() => void 0);
    await closePuppeteerBrowser(browser);
    browser = null;
    if (vimeoCandidateUrls.size > 0) {
      try {
        const vimeoAssets = await withTimeout(
          extractVimeoVideos(Array.from(vimeoCandidateUrls), "fhd", targetUrl),
          VIMEO_EXTRACT_TIMEOUT_MS,
          `Browser Vimeo extraction for ${targetUrl}`
        );
        videos.push(...vimeoAssets.videos || []);
        images.push(...vimeoAssets.images || []);
      } catch (error) {
        console.warn("Vimeo direct extraction failed, using source placeholders only:", error?.message || error);
        videos.push(...createVimeoSourceVideos(Array.from(vimeoCandidateUrls)));
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
    if ((isInstagramUrl(targetUrl) || isFacebookUrl(targetUrl) || isXUrl(targetUrl)) && videos.length === 0) {
      videos.push({
        url: targetUrl,
        sourceUrl: targetUrl,
        provider: platformProviderFromUrl(targetUrl),
        type: "video",
        title: pageTitle,
        thumbnail: resolvedPagePrimaryThumb
      });
    }
    let extractedAssets = await dedupeExtractedAssets(images, videos, fonts, colors, targetUrl, resolvedPagePrimaryThumb, { fast: true });
    extractedAssets = await recoverExtractWhenEmpty(targetUrl, extractedAssets);
    res.json(extractedAssets);
  } catch (error) {
    console.error("Extraction error:", error.message);
    if (/private or local asset urls are blocked|only http\(s\) asset urls are allowed/i.test(String(error?.message || ""))) {
      return res.status(403).json({ error: error.message });
    }
    try {
      const targetUrl = new URL2(String(req.body?.url || "")).href;
      assertPublicAssetUrl(targetUrl);
      const prefetchedHtml = await fetchSiteHtml(targetUrl).catch(() => "");
      const staticAssets = await extractStaticAssets(targetUrl, prefetchedHtml);
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
    await closePuppeteerBrowser(browser);
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
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: cached.buffer.length
      });
    }
    try {
      const sourcePageUrl = readSourcePageUrl(req);
      const fetched = await withTimeout(
        fetchRemoteImageBuffer(normalized, sourcePageUrl),
        12e3,
        `image-meta for ${normalized}`
      );
      const dims = probeRasterDimensions(fetched.buffer);
      return res.json({
        width: dims.width || 0,
        height: dims.height || 0,
        bytes: fetched.buffer.length
      });
    } catch {
      return res.json({ width: 0, height: 0, bytes: 0 });
    }
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to read image metadata" });
  }
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
      45e3,
      `Preview fetch for ${normalized}`
    );
    if (!isValidImageBuffer(fetched.buffer, fetched.contentType)) {
      return res.status(502).json({ error: "Preview image could not be loaded" });
    }
    const format = getAssetTypeFromUrl(normalized, inferImageTypeFromContentType(fetched.contentType) || "bin");
    const contentType = format === "jpg" || format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : format === "svg" ? "image/svg+xml" : format === "webp" ? "image/webp" : format === "avif" ? "image/avif" : format === "gif" ? "image/gif" : fetched.contentType || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.send(fetched.buffer);
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
      const saved = await saveCachedFileToDownloads(cachePath, filename2, "Image download", sourcePageUrl);
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
    if (String(save || "").toLowerCase() === "1" || String(save || "").toLowerCase() === "true") {
      const saved = await saveBufferToDownloads(fetched.buffer, filename, "Image download", sourcePageUrl, "image");
      return res.json(saved);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);
    return res.send(fetched.buffer);
  } catch (error) {
    console.error("Image download error:", error.message || error);
    return res.status(500).json({ error: `Failed to download image: ${error?.message || "Unknown error"}` });
  }
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
    const contentType = imageContentTypeForFormat(converted.format, "application/octet-stream");
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
          await fsp2.access(converted.cachedPath);
          const saved2 = await saveCachedFileToDownloads(converted.cachedPath, converted.filename, "Image conversion", sourcePageUrl);
          return res.json(saved2);
        } catch {
        }
      }
      const saved = await saveBufferToDownloads(converted.buffer, converted.filename, "Image conversion", sourcePageUrl, "image");
      return res.json(saved);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${converted.filename}"`);
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
app.post("/api/save-asset-buffer", async (req, res) => {
  const { base64, filename, sourcePageUrl: bodySourcePageUrl } = req.body || {};
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
    const saved = await saveBufferToDownloads(buffer, filename, "Asset buffer save", readSourcePageUrl(req, bodySourcePageUrl));
    return res.json(saved);
  } catch (error) {
    console.error("Save asset buffer error:", error?.message || error);
    return res.status(500).json({ error: `Failed to save file: ${error?.message || "Unknown error"}` });
  }
});
app.get("/api/convert-font", async (req, res) => {
  const { url, toFormat, originalFormat, filenameBase, originalUrl, metadataFilename, save } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }
  const targetFormat = typeof toFormat === "string" && toFormat.trim() ? toFormat.trim().toLowerCase() : "ttf";
  const sourceFormat = typeof originalFormat === "string" ? originalFormat : "unknown";
  const preferredBase = typeof filenameBase === "string" ? filenameBase : void 0;
  const extras = {
    originalUrl: typeof originalUrl === "string" ? originalUrl : void 0,
    metadataFilename: typeof metadataFilename === "string" ? metadataFilename : void 0,
    refererPageUrl: readSourcePageUrl(req) || void 0
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
        "font"
      );
      return res.json(saved);
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
          "font"
        );
        return res.json({
          ...saved,
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
          "font"
        );
        return res.json({
          ...saved,
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
  const { base64, toFormat, originalFormat, filenameBase, save, sourcePageUrl: bodySourcePageUrl } = req.body || {};
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
    const output = await convertFontBuffer(
      typeof filenameBase === "string" ? filenameBase : "font",
      buffer,
      typeof originalFormat === "string" ? originalFormat : "unknown",
      normalizedTarget,
      ""
    );
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
        "font"
      );
      return res.json(saved);
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);
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
    await fsp2.mkdir(youtubeMergeCacheDir, { recursive: true });
    const cachedPath = getYouTubeMergeCachePath(watchUrl, requestedQuality);
    try {
      await validateOutputFile(cachedPath, "YouTube merge cache");
    } catch {
      await withTimeout(
        mergeYouTubeWatchUrlToFile(watchUrl, requestedQuality, cachedPath),
        9e4,
        `YouTube merge for ${watchUrl}`
      );
    }
    await assertLocalFileHasAudio(cachedPath);
    const metadata = await probeMediaFile(cachedPath);
    const stat = await fsp2.stat(cachedPath);
    const probe = describeMediaProbe(metadata);
    return res.json({
      ok: true,
      watchUrl,
      quality: requestedQuality,
      mergedUrl: toYouTubeMergedDownloadUrl(watchUrl, requestedQuality, pageTitleFromUrl(watchUrl)),
      localPath: cachedPath,
      size: stat.size,
      ...probe
    });
  } catch (error) {
    console.error("YouTube merge verify error:", error?.message || error);
    return res.status(500).json({ error: error?.message || "Merged YouTube file failed audio verification." });
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
  const preferredFilename = typeof filename === "string" ? filename : `${toSafeFileBase(pageTitleFromUrl(watchUrl))}.mp4`;
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
  const preferredFilename = typeof filename === "string" ? filename : `${toSafeFileBase(pageTitleFromUrl(watchUrl))}.mp4`;
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
      const outputPath = path2.join(os2.tmpdir(), `${tempBase2}.mp4`);
      const requestedQuality = typeof req.query.quality === "string" && ["hd", "fhd", "4k"].includes(req.query.quality) ? req.query.quality : "fhd";
      const inlinePlayback = req.query.inline === "1" || req.query.inline === "true";
      try {
        await withTimeout(
          mergeYouTubeWatchUrlToFile(normalizedSourceUrl, requestedQuality, outputPath),
          4 * 60 * 1e3,
          `YouTube merged download for ${normalizedSourceUrl}`
        );
        const stat = await fsp2.stat(outputPath);
        const requestedName2 = typeof filename === "string" ? filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") : "";
        const preferredName2 = requestedName2 || `${pageTitleFromUrl(normalizedSourceUrl)}.mp4`.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120);
        res.setHeader("Content-Disposition", `${inlinePlayback ? "inline" : "attachment"}; filename="${preferredName2 || "youtube-video.mp4"}"`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", String(stat.size));
        const stream = fs.createReadStream(outputPath);
        stream.on("close", async () => {
          await fsp2.unlink(outputPath).catch(() => void 0);
        });
        stream.pipe(res);
        return;
      } catch (ytdlpError) {
        await fsp2.unlink(outputPath).catch(() => void 0);
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
    const contentType = response.headers["content-type"] || "video/mp4";
    const forceTranscode = needsMp4Transcode(downloadUrl, contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${preferredName}"`);
    res.setHeader("Content-Type", "video/mp4");
    if (!forceTranscode) {
      response.data.pipe(res);
      return;
    }
    response.data.destroy();
    const tempBase = `creative-extractor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempOutput = path2.join(os2.tmpdir(), `${tempBase}.mp4`);
    try {
      await transcodeUrlToMp4File(downloadUrl, tempOutput, referer, origin);
      const stat = await fsp2.stat(tempOutput);
      res.setHeader("Content-Length", String(stat.size));
      const stream = fs.createReadStream(tempOutput);
      stream.on("close", async () => {
        await fsp2.unlink(tempOutput).catch(() => void 0);
      });
      stream.pipe(res);
    } catch (transcodeError) {
      await fsp2.unlink(tempOutput).catch(() => void 0);
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
    await fsp2.mkdir(convertedVideoDir, { recursive: true });
    const sourcePageUrl = readSourcePageUrl(req);
    const targetDir = resolveDownloadsTargetDir(sourcePageUrl);
    await fsp2.mkdir(targetDir, { recursive: true });
    const tempBase = `converted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempOutput = path2.join(convertedVideoDir, `${tempBase}.mp4`);
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
        const out = fs.createWriteStream(tempOutput);
        downloadResponse.data.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
        downloadResponse.data.on("error", reject);
      });
    } else {
      await transcodeUrlToMp4File(validatedSourceUrl, tempOutput, referer, origin);
    }
    const finalPath = path2.join(targetDir, safeFilename);
    await fsp2.rename(tempOutput, finalPath).catch(async () => {
      await fsp2.copyFile(tempOutput, finalPath);
      await fsp2.unlink(tempOutput).catch(() => void 0);
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
  const requestedBase = (typeof filename === "string" && filename.trim() ? filename : parsedSource.pathname.split("/").pop() || "audio").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "audio";
  const turboDurationSeconds = audioMode === "turbo" ? 30 : void 0;
  try {
    await fsp2.mkdir(convertedAudioDir, { recursive: true });
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
    let outputFormat = audioMode === "original" ? resolvedAudioStream?.originalOutput?.extension || getOriginalAudioOutput(resolvedAudioStream || { ext: path2.extname(parsedAudioSource.pathname).replace(/^\./, "") }).extension : audioMode === "turbo" ? "m4a" : "mp3";
    const originalContainer = audioMode === "original" ? resolvedAudioStream?.originalOutput?.container || getOriginalAudioOutput(resolvedAudioStream || { ext: outputFormat }).container : void 0;
    let tempOutput = path2.join(convertedAudioDir, `${tempBase}.${outputFormat}`);
    const tempInput = path2.join(convertedAudioDir, `${tempBase}-source${path2.extname(parsedAudioSource.pathname) || ".bin"}`);
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
          await fsp2.unlink(tempOutput).catch(() => void 0);
          outputFormat = "mp3";
          tempOutput = path2.join(convertedAudioDir, `${tempBase}.mp3`);
          try {
            await transcodeUrlToMp3File(audioSourceUrl, tempOutput, referer, origin, requestedBitrate, {
              durationSeconds: turboDurationSeconds,
              timeoutMs: 90 * 1e3,
              stallMs: 25 * 1e3
            });
          } catch (urlTranscodeError) {
            console.warn("Quick URL audio transcode failed, using chunked local fallback:", urlTranscodeError?.message || urlTranscodeError);
            await fsp2.unlink(tempOutput).catch(() => void 0);
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
      await fsp2.unlink(tempInput).catch(() => void 0);
    }
    const safeFilename = `${requestedBase}.${outputFormat}`;
    const finalPath = path2.join(convertedAudioDir, safeFilename);
    await fsp2.rename(tempOutput, finalPath).catch(async () => {
      await fsp2.copyFile(tempOutput, finalPath);
      await fsp2.unlink(tempOutput).catch(() => void 0);
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
  const folderPath = target === "converted-audio" ? convertedAudioDir : target === "converted-video" ? convertedVideoDir : target === "fonts" ? resolveCreativeAssetsDir(sourcePageUrl, "Fonts") : target === "images" ? resolveCreativeAssetsDir(sourcePageUrl, "Images") : target === "videos" ? resolveCreativeAssetsDir(sourcePageUrl, "Videos") : target === "audio" ? resolveCreativeAssetsDir(sourcePageUrl, "Audio") : target === "smoketest" ? resolveCreativeAssetsDir(sourcePageUrl, "SmokeTest") : target === "brief" ? resolveCreativeAssetsDir(sourcePageUrl, "Brief") : target === "isi" ? resolveCreativeAssetsDir(sourcePageUrl, "ISI") : resolveCreativeAssetsRoot(sourcePageUrl);
  try {
    await ensureCreativeAssetsFolders(sourcePageUrl);
    await fsp2.mkdir(folderPath, { recursive: true });
    await openLocalFolder(folderPath);
    return res.json({ ok: true, path: folderPath });
  } catch (error) {
    console.error("Open folder error:", error.message || error);
    return res.status(500).json({ error: "Could not open the folder on this machine." });
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
    const filePath = payload.localPath || path2.join(downloadsDir, payload.localFilename);
    const stat = await validateOutputFile(filePath, "Direct video download");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${preferredName || payload.localFilename}"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    return fs.createReadStream(filePath).pipe(res);
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
  const filePath = path2.join(downloadsDir, safeFilename);
  const resolved = assertPathInsideDownloads(filePath);
  try {
    await validateOutputFile(resolved, "Local video download");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store, private");
    return fs.createReadStream(resolved).pipe(res);
  } catch {
    return res.status(404).json({ error: "Local video file was not found in Downloads." });
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
      (video) => video.isVimeoDirect && (video.displayQualityKey === requestedQuality || video.qualityRequested === requestedQuality)
    );
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
      return res.json({ video: enforceMp4VideoPayload(validVideo), images: vimeoAssets.images });
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
        const directCandidates = (brightcoveAssets.videos || []).filter((video2) => video2?.isDirect && isLikelyDirectVideoStreamUrl(String(video2.sourceStreamUrl || video2.url || "")));
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
        const mergeCandidate = (brightcoveAssets.videos || []).find((video2) => video2?.brightcoveManifestUrl);
        const hlsInputUrl = mergeCandidate?.brightcoveManifestUrl ? await selectHlsVariantUrl(mergeCandidate.brightcoveManifestUrl, getVimeoTargetHeight(requestedQuality), url).catch(() => mergeCandidate.brightcoveManifestUrl) : "";
        const mergedVideo = await materializeMergedMp4FromPlatform(
          url,
          requestedQuality,
          req,
          mergeCandidate?.title || directCandidates[0]?.title || "Brightcove video",
          hlsInputUrl ? { directInputUrl: hlsInputUrl, sourcePageUrl: url } : {}
        );
        return res.json({ video: mergedVideo });
      } catch (brightcoveError) {
        console.warn("Brightcove resolve failed, trying universal yt-dlp route:", brightcoveError?.message || brightcoveError);
      }
    }
    if (isYouTubeUrl(url)) {
      const normalizedWatchUrl = normalizeYouTubeWatchUrl(resolverTargetUrl);
      return res.json({
        video: buildYouTubeMergedCard(normalizedWatchUrl, requestedQuality)
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
      const page = await browser.newPage();
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
  const list = items || urls;
  if (!list || !Array.isArray(list)) {
    return res.status(400).json({ error: "Array of items or urls is required" });
  }
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
    const zipFontConvertTimeoutMs = 3e4;
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
        if (rawUrl.startsWith("data:")) {
          const matches = rawUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const buffer = Buffer.from(matches[2], "base64");
            let ext = matches[1].split("/")[1]?.split("+")[0] || "bin";
            if (ext === "jpeg") ext = "jpg";
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
          const url2 = assertAssetUrlAllowed(rawUrl);
          const fontExtras = {
            originalUrl: manifestUrl,
            metadataFilename: typeof item.metadataFilename === "string" ? item.metadataFilename : void 0,
            refererPageUrl: resolveFontRefererPage(
              typeof item.cssSource === "string" ? item.cssSource : "",
              zipPageUrl || ""
            ) || void 0
          };
          const toFormat = String(item.toFormat || "ttf");
          const filenameBase = typeof item.filenameBase === "string" ? item.filenameBase : "font";
          const runFontZipConvert = (cacheOnly) => convertFontAsset(
            url2,
            toFormat,
            String(item.originalFormat || "unknown"),
            filenameBase,
            {
              ...fontExtras,
              ...cacheOnly ? zipCacheOnly : {}
            }
          );
          let converted2;
          try {
            converted2 = await runFontZipConvert(true);
          } catch (cacheError) {
            const reason = String(cacheError?.message || cacheError || "");
            if (/not cached|valid font|decode|conversion|timeout|fetch/i.test(reason)) {
              converted2 = await runFontZipConvert(false);
            } else {
              throw cacheError;
            }
          }
          if (!converted2.buffer?.length) {
            throw new Error(`Converted font is empty (${toFormat})`);
          }
          const zipName = typeof item.zipEntryName === "string" && item.zipEntryName.trim() ? item.zipEntryName.trim() : buildFontZipEntryName(filenameBase, converted2.format || toFormat);
          return { ok: true, entry: { name: zipName, buffer: converted2.buffer } };
        }
        if (isImageConversion) {
          const requestedCachePath = typeof item.cachedPath === "string" ? item.cachedPath.trim() : "";
          const requestUrl = requestedCachePath || rawUrl;
          const url2 = assertAssetUrlAllowed(requestUrl);
          const cacheProbe = await readAssetBufferFromCache(url2, "image") || (manifestUrl && manifestUrl !== requestUrl ? await readAssetBufferFromCache(manifestUrl, "image") : null);
          if (cacheProbe) zipImageStats.cached += 1;
          console.debug("[image-zip:item]", {
            id: typeof item.id === "string" ? item.id : void 0,
            url: manifestUrl,
            mimeType: typeof item.mimeType === "string" ? item.mimeType : cacheProbe?.contentType || "",
            cachePath: requestedCachePath || await getAssetCacheDebugPath(url2, "image"),
            cache: cacheProbe ? "hit" : "miss"
          });
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
          return { ok: true, entry: { name: converted2.filename, buffer: converted2.buffer } };
        }
        if (isVideoAsset) {
          const url2 = assertAssetUrlAllowed(rawUrl);
          const cached = await readAssetBufferFromCache(url2, "image");
          if (!cached) {
            throw new Error("Video is not cached. Re-extract the page, then download the ZIP.");
          }
          const filename = url2.split("/").pop()?.split("?")[0] || `file-${index + 1}`;
          return { ok: true, entry: { name: filename, buffer: cached.buffer } };
        }
        const url = assertAssetUrlAllowed(rawUrl);
        const looksLikeVideo = isLikelyDirectVideoStreamUrl(url) || isLikelyVideoAssetUrl(url) || /\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|$)/i.test(url);
        const looksLikeFont = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url);
        if (looksLikeVideo) {
          const cached = await readAssetBufferFromCache(url, "image");
          if (!cached) {
            throw new Error("Video is not cached. Re-extract the page, then download the ZIP.");
          }
          const filename = url.split("/").pop()?.split("?")[0] || `file-${index + 1}`;
          return { ok: true, entry: { name: filename, buffer: cached.buffer } };
        }
        if (looksLikeFont) {
          const sourceFormat = getFontFormatFromUrlOrType(url);
          const filenameBase = typeof item?.filenameBase === "string" ? item.filenameBase : "font";
          const runFontZipFetch = (cacheOnly) => convertFontAsset(url, "ttf", sourceFormat, filenameBase, {
            originalUrl: manifestUrl,
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
              name: buildFontZipEntryName(filenameBase, converted2.format || "ttf"),
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
        return { ok: true, entry: { name: converted.filename, buffer: converted.buffer } };
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
    const archive = archiver("zip", { zlib: { level: 0 } });
    const zipChunks = [];
    const zipDone = new Promise((resolve, reject) => {
      archive.on("data", (chunk) => zipChunks.push(chunk));
      archive.on("end", () => resolve());
      archive.on("error", reject);
    });
    for (const entry of zipEntries) {
      archive.append(entry.buffer, { name: entry.name });
    }
    await archive.finalize();
    await zipDone;
    const zipBuffer = Buffer.concat(zipChunks);
    const addedCount = zipEntries.filter((entry) => entry.name !== "asset-paths.txt").length;
    if (req.body?.save === true || String(req.body?.save || "").toLowerCase() === "true") {
      const requestedFilename = typeof req.body?.filename === "string" && req.body.filename.trim() ? req.body.filename.trim() : "assets.zip";
      const zipSaveKind = /font/i.test(requestedFilename) || list.some((item) => typeof item === "object" && item?.assetType === "font") ? "font" : "image";
      const saved = await saveBufferToDownloads(
        zipBuffer,
        requestedFilename,
        "Assets ZIP",
        readSourcePageUrl(req),
        zipSaveKind
      );
      res.setHeader("X-Zip-Added-Count", String(addedCount));
      res.setHeader("X-Zip-Failed-Count", String(zipFailures.length));
      return res.json({ ...saved, addedCount, failedCount: zipFailures.length });
    }
    res.setHeader("Content-Disposition", 'attachment; filename="assets.zip"');
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Zip-Cache-Only", "1");
    res.setHeader("X-Zip-Added-Count", String(addedCount));
    res.setHeader("X-Zip-Failed-Count", String(zipFailures.length));
    res.setHeader("Content-Length", String(zipBuffer.length));
    return res.send(zipBuffer);
  } catch (error) {
    console.error("ZIP error:", error.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create ZIP file" });
    }
  }
});
async function startServer() {
  await ensureCreativeAssetsFolders(lastExtractedSourceUrl);
  await ensureRuntimeToolsReady();
  activePort = await findAvailablePort(DEFAULT_PORT);
  if (activePort !== DEFAULT_PORT) {
    console.log(`Using another available local port: ${activePort}`);
  }
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const hmrPort = await findAvailablePort(Number(process.env.VITE_HMR_PORT || 24678), 40).catch(() => void 0);
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...hmrPort ? { hmr: { port: hmrPort } } : {}
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path2.join(getAppRoot(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path2.join(distPath, "index.html"));
    });
  }
  const server = app.listen(activePort, "127.0.0.1", () => {
    console.log(`Server running on http://localhost:${activePort}`);
  });
  return { server, port: activePort, url: `http://localhost:${activePort}` };
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
