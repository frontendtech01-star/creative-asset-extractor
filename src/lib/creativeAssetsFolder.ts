/** Folder under ~/Downloads for assets from a given site, e.g. `posluma_CreativeAssets`. */
export const extractSiteKeyFromUrl = (pageUrl: string) => {
  const raw = String(pageUrl || '').trim();
  if (!raw) return 'CreativeAssets';
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') return 'youtube';
    const parts = host.split('.').filter(Boolean);
    const site = (parts[0] || 'website')
      .replace(/[^a-z0-9]+/gi, '')
      .replace(/-+/g, '')
      .slice(0, 48);
    return site || 'website';
  } catch {
    return 'CreativeAssets';
  }
};

export const buildCreativeAssetsFolderName = (pageUrl: string) => {
  const site = extractSiteKeyFromUrl(pageUrl);
  return `${site}_CreativeAssets`;
};

export const creativeAssetsFolderLabel = (pageUrl?: string, subfolder?: string) => {
  const root = `~/Downloads/${buildCreativeAssetsFolderName(pageUrl || '')}`;
  return subfolder ? `${root}/${subfolder}` : root;
};

export const appendSourcePageUrl = (params: URLSearchParams, sourcePageUrl?: string) => {
  const value = String(sourcePageUrl || '').trim();
  if (value) params.set('sourcePageUrl', value);
};
