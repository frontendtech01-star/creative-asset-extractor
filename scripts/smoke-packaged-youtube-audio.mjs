import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = process.cwd();
const appPath = path.resolve(process.env.QC_APP_PATH || path.join(root, 'release/mac-arm64/Creative Asset Extractor.app'));
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-audio-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-audio-data-'));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cae-packaged-audio-downloads-'));
let serverProcess;

const waitForServer = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Packaged audio server startup timed out')), 30000);
  const onData = (buffer) => {
    const text = String(buffer);
    process.stdout.write(text);
    const match = text.match(/Server running on (http:\/\/localhost:\d+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  };
  serverProcess.stdout.on('data', onData);
  serverProcess.stderr.on('data', (buffer) => process.stderr.write(String(buffer)));
  serverProcess.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`Packaged audio server exited during startup (${code})`));
  });
});

try {
  execFileSync(path.join(root, 'node_modules/.bin/asar'), ['extract', path.join(resourcesPath, 'app.asar'), extractDir]);
  serverProcess = spawn(path.join(appPath, 'Contents/MacOS/Creative Asset Extractor'), [path.join(extractDir, 'desktop/server.mjs')], {
    cwd: extractDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      VDX_APP_ROOT: extractDir,
      VDX_RESOURCES_PATH: resourcesPath,
      VDX_USER_DATA: userDataDir,
      CAE_DOWNLOADS_DIR: downloadsDir,
      // Reproduce the mounted-DMG failure. The server must redirect this to
      // VDX_USER_DATA/tmp before yt-dlp creates any transient MP3 files.
      TMPDIR: resourcesPath,
      TMP: resourcesPath,
      TEMP: resourcesPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverUrl = await waitForServer();
  const result = await new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/smoke-video-downloader.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        SMOKE_BASE_URL: serverUrl,
        SMOKE_ONLY: 'youtube',
        SMOKE_DOWNLOAD: '1',
        SMOKE_AUDIO: '1',
        SMOKE_YOUTUBE_URL: 'https://www.youtube.com/watch?v=N14a0vnfxCc',
        SMOKE_FFPROBE_PATH: path.join(resourcesPath, 'bin', 'ffprobe'),
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(undefined) : reject(new Error(`Packaged YouTube audio smoke exited with ${code}`)));
  });
  void result;
  const tempDir = path.join(userDataDir, 'tmp');
  if (!fs.existsSync(tempDir)) throw new Error('Packaged audio smoke did not create the writable application temp directory.');
  console.log(`PASS packaged YouTube MP3: temporary files used ${tempDir}`);
} finally {
  serverProcess?.kill('SIGTERM');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(downloadsDir, { recursive: true, force: true });
}
