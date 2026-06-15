import { apiFetch } from './api';
import { getDesktopBridge } from './desktopBridge';

export type AppMeta = {
  version: string;
  productName: string;
  githubOwner: string;
  githubRepo: string;
};

export const fetchAppMeta = async (): Promise<AppMeta> => {
  const bridge = getDesktopBridge();
  const response = await apiFetch('/api/app-meta');
  const data = await response.json().catch(() => ({}));
  let version = String(data?.version || '1.0.0');
  if (bridge?.getAppVersion) {
    try {
      const desktopVersion = await bridge.getAppVersion();
      if (desktopVersion) version = desktopVersion;
    } catch {
      // Fall back to server-reported version.
    }
  }
  return {
    version,
    productName: String(data?.productName || 'Creative Asset Extractor'),
    githubOwner: String(data?.githubOwner || ''),
    githubRepo: String(data?.githubRepo || ''),
  };
};
