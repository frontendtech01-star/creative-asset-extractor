import { spawnSync } from 'node:child_process';

for (const script of ['scripts/smoke-warehouse-stationery.mjs', 'scripts/smoke-alprolix-icons.mjs', 'scripts/smoke-kroger.mjs']) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('PASS: all reported-site regressions passed');
