import { copyFile, chmod, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import { projectRoot } from './lib/setup.mjs';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const binPackDir = path.join(projectRoot, 'vendor', 'bin-pack');

const clearMacQuarantine = async (filePath) => {
  if (process.platform !== 'darwin' || !filePath) return;
  await execFileAsync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', filePath]).catch(() => undefined);
};

const YTDLP_RELEASE_URLS = {
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
};

const downloadFile = (url, destination) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });

const isPythonScript = async (filePath) => {
  try {
    const head = (await readFile(filePath, { encoding: 'utf8' })).slice(0, 128);
    return /^#!.*python/i.test(head);
  } catch {
    return false;
  }
};

const assertStandaloneBinary = async (filePath, label) => {
  if (await isPythonScript(filePath)) {
    throw new Error(`${label} at ${filePath} is a Python script, not a standalone binary.`);
  }
  try {
    const { stdout } = await execFileAsync('file', [filePath]);
    if (/python script/i.test(String(stdout || ''))) {
      throw new Error(`${label} file probe reported Python script: ${stdout.trim()}`);
    }
  } catch (error) {
    if (error?.message?.includes('Python script')) throw error;
    // `file` may be unavailable on Windows; Python shebang check is enough.
  }
};

const copyExecutable = async (source, destination) => {
  if (!source || !existsSync(source)) return false;
  await copyFile(source, destination);
  await chmod(destination, 0o755).catch(() => undefined);
  await clearMacQuarantine(destination);
  return true;
};

const downloadStandaloneYtDlp = async (destination) => {
  const url = YTDLP_RELEASE_URLS[process.platform] || YTDLP_RELEASE_URLS.linux;
  console.log(`Downloading standalone yt-dlp from ${url}`);
  await downloadFile(url, destination);
  await chmod(destination, 0o755);
  await clearMacQuarantine(destination);
  await assertStandaloneBinary(destination, 'yt-dlp');
  return true;
};

const stageAria2 = async (destination) => {
  const localCandidates = [
    path.join(projectRoot, 'vendor', 'aria2', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'),
    path.join(projectRoot, 'vendor', 'aria2', 'aria2c'),
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      await copyExecutable(candidate, destination);
      return true;
    }
  }

  if (process.platform === 'win32') {
    return false;
  }

  try {
    const { stdout } = await execFileAsync('which', ['aria2c']);
    const systemPath = String(stdout || '').trim().split('\n')[0];
    if (systemPath && existsSync(systemPath)) {
      await copyExecutable(systemPath, destination);
      return true;
    }
  } catch {
    // Optional accelerator.
  }
  return false;
};

await rm(binPackDir, { recursive: true, force: true });
await mkdir(binPackDir, { recursive: true });

let ffmpegSource = '';
let ffprobeSource = '';

try {
  ffmpegSource = String(require('ffmpeg-static') || '');
} catch {
  ffmpegSource = '';
}

try {
  ffprobeSource = String(require('@ffprobe-installer/ffprobe').path || '');
} catch {
  ffprobeSource = '';
}

const ffmpegDest = path.join(binPackDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobeDest = path.join(binPackDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ytdlpDest = path.join(binPackDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const aria2Dest = path.join(binPackDir, process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');

const copied = {
  ffmpeg: await copyExecutable(ffmpegSource, ffmpegDest),
  ffprobe: await copyExecutable(ffprobeSource, ffprobeDest),
  ytdlp: await downloadStandaloneYtDlp(ytdlpDest),
  aria2: await stageAria2(aria2Dest),
};

if (!copied.ffmpeg || !copied.ytdlp) {
  throw new Error(`Failed to stage desktop binaries: ${JSON.stringify(copied)}`);
}

const manifest = {
  platform: process.platform,
  arch: process.arch,
  updatedAt: new Date().toISOString(),
  binaries: {
    ffmpeg: ffmpegDest,
    ffprobe: ffprobeDest,
    ytdlp: ytdlpDest,
    aria2: copied.aria2 ? aria2Dest : '',
  },
  standaloneYtDlp: true,
};
await writeFile(path.join(binPackDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log('Desktop binaries staged:', copied, '->', binPackDir);
