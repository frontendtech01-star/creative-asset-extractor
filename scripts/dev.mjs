import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSetup, projectRoot } from './lib/setup.mjs';

await ensureSetup({ repair: true });

console.log('Starting local app...');

const tsxBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const child = spawn(tsxBin, ['server.ts'], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    NODE_ENV: process.env.VITE_HMR_DISABLED === '1'
      ? 'production'
      : process.env.NODE_ENV || 'development',
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', () => {
  console.error('Startup repair did not finish. Please run npm install once, then try again.');
  process.exit(1);
});
