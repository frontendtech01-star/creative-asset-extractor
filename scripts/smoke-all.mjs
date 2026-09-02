import fs from 'node:fs';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url);
const mode = String(process.argv[2] || 'source').toLowerCase();
const packagedApp = new URL('../release/mac-arm64/Creative Asset Extractor.app', import.meta.url);

const sourceTests = [
  'smoke:webp',
  'smoke:teneo-svg',
  'smoke:teneo-fonts',
  'smoke:rxsight-typekit',
  'smoke:typekit-identities',
  'smoke:fordham-fonts',
  'smoke:bissell',
  'smoke:warehouse-stationery',
  'smoke:warehouse-stationery-ui',
  'smoke:tandem-images-ui',
  'smoke:alprolix-icons',
  'smoke:kroger',
  'smoke:kroger-chromium',
  'smoke:hello-banner',
  'smoke:video-downloader',
  'smoke:video-failure-layers',
  'smoke:video-reported-sites',
  'smoke:video-ui',
  'smoke:xtandi-videos',
  'smoke:xtandi-video-ui',
  'smoke:feedback',
];

const packagedTests = [
  'smoke:packaged-video-ui',
  'smoke:packaged-xtandi-video',
  'smoke:packaged-tandem-fonts',
  'smoke:packaged-warehouse-images',
  'smoke:packaged-tandem-images',
];
const failures = [];
let sharedBaseUrl = '';

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  let output = '';
  if (options.capture) {
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
      process.stderr.write(chunk);
    });
  }
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (code === 0) resolve({ child, output });
    else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`));
  });
});

const runNpm = async (script) => {
  console.log(`\n=== ${script} ===`);
  try {
    await run('npm', ['run', script], {
      env: sharedBaseUrl ? { SMOKE_BASE_URL: sharedBaseUrl } : {},
    });
  } catch (error) {
    failures.push({ script, error: error?.message || String(error) });
    console.error(`\nFAIL ${script}: ${error?.message || error}`);
  }
};

let server;
const stopServer = () => {
  if (!server || server.killed) return;
  if (process.platform !== 'win32' && server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  server.kill('SIGTERM');
};
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});
process.on('SIGTERM', stopServer);

try {
  if (mode === 'source' || mode === 'all') {
    await runNpm('typecheck');
    await runNpm('smoke');

    console.log('\n=== starting one shared localhost server ===');
    server = spawn(process.execPath, ['scripts/dev.mjs'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local smoke server startup timed out')), 60000);
      const onData = (chunk) => {
        const text = String(chunk);
        process.stdout.write(text);
        const match = text.match(/Server running on (http:\/\/(?:127\.0\.0\.1|localhost):(\d+))/);
        if (match?.[1]) {
          sharedBaseUrl = match[1].replace('localhost', '127.0.0.1');
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on('data', onData);
      server.stderr.on('data', (chunk) => process.stderr.write(chunk));
      server.on('exit', (code) => reject(new Error(`Local smoke server exited (${code})`)));
    });

    for (const test of sourceTests) await runNpm(test);
    stopServer();
    server = undefined;
    sharedBaseUrl = '';
  }

  if (mode === 'packaged' || mode === 'all') {
    if (!fs.existsSync(packagedApp)) {
      throw new Error('Packaged app is missing. Run `npm run dmg` before packaged smoke tests.');
    }
    for (const test of packagedTests) await runNpm(test);
  }

  if (!['source', 'packaged', 'all'].includes(mode)) {
    throw new Error('Usage: node scripts/smoke-all.mjs [source|packaged|all]');
  }
  if (failures.length) {
    console.error('\n=== smoke failures ===');
    failures.forEach(({ script, error }) => console.error(`- ${script}: ${error}`));
    throw new Error(`${failures.length} smoke test(s) failed`);
  }
  console.log(`\nPASS: ${mode} smoke suite completed sequentially`);
} finally {
  stopServer();
}
