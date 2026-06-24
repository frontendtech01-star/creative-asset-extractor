import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSetup, projectRoot } from './lib/setup.mjs';

await ensureSetup({ repair: true });

const tsxBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const server = spawn(tsxBin, ['server.ts'], {
  cwd: projectRoot,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, NODE_ENV: 'production' },
});

let browserOpened = false;

const openBrowser = (url) => {
  if (browserOpened) return;
  browserOpened = true;
  if (process.env.VDX_NO_OPEN_BROWSER === '1') {
    console.log(`Open ${url} in Chrome.`);
    return;
  }
  console.log(`Opening ${url}`);
  if (process.platform === 'darwin') {
    const chrome = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    chrome.on('error', () => spawn('open', [url], { stdio: 'ignore' }));
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
};

const handleOutput = (chunk, error = false) => {
  const text = chunk.toString();
  process[error ? 'stderr' : 'stdout'].write(text);
  const match = text.match(/Server running on (http:\/\/localhost:\d+)/i);
  if (match?.[1]) openBrowser(match[1]);
};

server.stdout.on('data', (chunk) => handleOutput(chunk));
server.stderr.on('data', (chunk) => handleOutput(chunk, true));
server.on('error', (error) => {
  console.error(error?.message || 'Could not start the localhost server.');
  process.exit(1);
});
server.on('exit', (code) => process.exit(code ?? 0));

process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});
