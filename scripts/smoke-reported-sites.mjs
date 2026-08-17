import { spawnSync } from 'node:child_process';

for (const script of ['scripts/smoke-warehouse-stationery.mjs', 'scripts/smoke-alprolix-icons.mjs']) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('PASS: both reported-site regressions passed');
