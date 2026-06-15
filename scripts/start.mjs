import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureSetup, npmCommand, projectRoot, run } from './lib/setup.mjs';

await ensureSetup({ repair: true });

const electronBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
if (!fs.existsSync(electronBin)) {
  console.log('Installing desktop app support...');
  await run(npmCommand(), ['install'], { stdio: 'inherit' });
}

console.log('Starting local video engine...');

const tsxBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const server = spawn(tsxBin, ['server.ts'], {
  cwd: projectRoot,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, NODE_ENV: 'development' },
});

let electronStarted = false;
let electronProcess = null;

const launchElectron = (url) => {
  if (electronStarted) return;
  electronStarted = true;
  console.log('Launching desktop app...');
  electronProcess = spawn(electronBin, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VDX_SERVER_URL: url },
  });
  electronProcess.on('exit', (code) => {
    server.kill();
    process.exit(code ?? 0);
  });
};

const handleServerText = (chunk, isError = false) => {
  const text = chunk.toString();
  if (isError && /EADDRINUSE|address already in use/i.test(text)) {
    process.stdout.write('Using another available local port...\n');
  } else {
    process[isError ? 'stderr' : 'stdout'].write(text);
  }
  const match = text.match(/Server running on (http:\/\/localhost:\d+)/i);
  if (match?.[1]) launchElectron(match[1]);
};

server.stdout.on('data', (chunk) => handleServerText(chunk, false));
server.stderr.on('data', (chunk) => handleServerText(chunk, true));
server.on('error', () => {
  console.error('Startup repair did not finish. Please run npm install once, then try again.');
  process.exit(1);
});
server.on('exit', (code) => {
  if (!electronStarted) process.exit(code ?? 1);
});

process.on('SIGINT', () => {
  electronProcess?.kill();
  server.kill();
  process.exit(0);
});
