import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const toolConfigPath = path.join(projectRoot, '.local-tools.json');
const vendorDir = path.join(projectRoot, 'vendor');

const log = (message) => console.log(message);

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: options.stdio || 'pipe',
      shell: process.platform === 'win32',
      env: { ...process.env, ...(options.env || {}) },
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `${command} exited with code ${code}`));
    });
  });

const npmCommand = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

const ensureExecutable = async (filePath) => {
  if (!filePath || !existsSync(filePath) || process.platform === 'win32') return;
  await fs.chmod(filePath, 0o755).catch(() => undefined);
};

const findOnPath = async (binaryName) => {
  const command = process.platform === 'win32' ? 'where' : 'which';
  return run(command, [binaryName])
    .then((result) => result.split(/\r?\n/)[0]?.trim() || '')
    .catch(() => '');
};

const resolveFfmpeg = async (repair) => {
  try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath && existsSync(ffmpegPath)) {
      await ensureExecutable(ffmpegPath);
      return ffmpegPath;
    }
  } catch {
    // Try repair below.
  }

  if (repair) {
    log('Required video tools missing. Repairing automatically...');
    await run(npmCommand(), ['rebuild', 'ffmpeg-static'], { stdio: 'inherit' }).catch(() => undefined);
  }

  try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath && existsSync(ffmpegPath)) {
      await ensureExecutable(ffmpegPath);
      return ffmpegPath;
    }
  } catch {
    // Friendly fallback below.
  }
  return '';
};

const isPythonScriptBinary = async (filePath) => {
  try {
    const head = (await fs.readFile(filePath, 'utf8')).slice(0, 128);
    return /^#!.*python/i.test(head);
  } catch {
    return false;
  }
};

const resolveYtDlp = async (repair) => {
  const standalonePath = path.join(
    projectRoot,
    'vendor',
    'bin-pack',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  );

  if (existsSync(standalonePath) && !(await isPythonScriptBinary(standalonePath))) {
    await ensureExecutable(standalonePath);
    return standalonePath;
  }

  if (repair) {
    log('Downloading standalone yt-dlp binary...');
    await import('../stage-desktop-bin.mjs');
  }

  if (existsSync(standalonePath) && !(await isPythonScriptBinary(standalonePath))) {
    await ensureExecutable(standalonePath);
    return standalonePath;
  }
  return '';
};

const downloadFile = (url, destination) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });

const findFileRecursive = async (dir, predicate) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(fullPath, predicate);
      if (found) return found;
    } else if (predicate(fullPath)) {
      return fullPath;
    }
  }
  return '';
};

const tryInstallWindowsAria2 = async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return '';
  const targetDir = path.join(vendorDir, 'aria2');
  const target = path.join(targetDir, 'aria2c.exe');
  if (existsSync(target)) return target;

  const tempDir = path.join(os.tmpdir(), `vdx-aria2-${Date.now()}`);
  const zipPath = path.join(tempDir, 'aria2.zip');
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });

  try {
    log('Installing media tools...');
    await downloadFile('https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip', zipPath);
    const extractZip = (await import('extract-zip')).default;
    await extractZip(zipPath, { dir: tempDir });
    const found = await findFileRecursive(tempDir, (filePath) => path.basename(filePath).toLowerCase() === 'aria2c.exe');
    if (found) {
      await fs.copyFile(found, target);
      return target;
    }
  } catch {
    // aria2 is an accelerator; the app still works with the built-in stream downloader.
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return '';
};

const resolveAria2 = async () => {
  const local = path.join(vendorDir, 'aria2', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
  if (existsSync(local)) {
    await ensureExecutable(local);
    return local;
  }

  const system = await findOnPath(process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
  if (system) return system;

  const installed = await tryInstallWindowsAria2();
  if (installed) return installed;
  return '';
};

export async function ensureSetup({ repair = true } = {}) {
  log('Preparing video engine...');
  await fs.mkdir(vendorDir, { recursive: true });

  const [ffmpegPath, ytdlpPath, aria2Path] = await Promise.all([
    resolveFfmpeg(repair),
    resolveYtDlp(repair),
    resolveAria2(),
  ]);

  const config = {
    platform: process.platform,
    arch: process.arch,
    ffmpegPath,
    ytdlpPath,
    aria2Path,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(toolConfigPath, `${JSON.stringify(config, null, 2)}\n`);

  if (!ffmpegPath || !ytdlpPath) {
    log('Required video tools missing. Repairing automatically...');
    log('If this is the first install, run npm install once more after your internet connection is available.');
  } else {
    log('Optimizing extraction engine...');
    if (!aria2Path) log('Download accelerator unavailable; using the built-in stream engine.');
    log('Setup complete.');
  }

  return config;
}

export { run, npmCommand, projectRoot };
