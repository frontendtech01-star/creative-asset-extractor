import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const siteFolderName = (pageUrl = '') => {
  const raw = String(pageUrl || '').trim();
  if (!raw) return 'CreativeAssets';
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') return 'youtube_CreativeAssets';
    const site = (host.split('.').filter(Boolean)[0] || 'website')
      .replace(/[^a-z0-9]+/gi, '')
      .slice(0, 48) || 'website';
    return `${site}_CreativeAssets`;
  } catch {
    return 'CreativeAssets';
  }
};

/** QC/smoke artifacts live under the site project folder, never Downloads root. */
export const resolveSmokeOutDir = (label = 'smoke', sourcePageUrl = '') => {
  const safe = String(label || 'smoke')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'smoke';
  const dir = path.join(
    os.homedir(),
    'Downloads',
    siteFolderName(sourcePageUrl),
    'SmokeTest',
    safe
  );
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    } catch {
      // Best-effort cleanup of prior smoke run.
    }
  }
  return dir;
};
