type JobRecord = {
  state: 'running' | 'completed';
  result?: unknown;
  startedAt: number;
};

const jobs = new Map<string, JobRecord>();

const normalizeJobUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    parsed.hash = '';
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, '').toLowerCase()}${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return String(rawUrl || '').trim().toLowerCase();
  }
};

export const buildMediaJobKey = (
  platform: string,
  url: string,
  action: string,
  quality = ''
) => `${String(platform || 'unknown').toLowerCase()}|${normalizeJobUrl(url)}|${action}|${String(quality || '').toLowerCase()}`;

export const beginMediaJob = (key: string) => {
  const existing = jobs.get(key);
  if (existing?.state === 'running') {
    return { duplicate: true as const, running: true as const, existing };
  }
  if (existing?.state === 'completed') {
    return { duplicate: true as const, running: false as const, cached: true as const, existing };
  }
  jobs.set(key, { state: 'running', startedAt: Date.now() });
  return { duplicate: false as const };
};

export const completeMediaJob = (key: string, result?: unknown) => {
  jobs.set(key, {
    state: 'completed',
    result,
    startedAt: jobs.get(key)?.startedAt || Date.now(),
  });
};

export const failMediaJob = (key: string) => {
  jobs.delete(key);
};

export const clearMediaJobRegistry = () => {
  jobs.clear();
};
