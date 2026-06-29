import { apiFetch } from './api';
import { isNewerVersion } from './semver';

export type GithubReleaseInfo = {
  tagName: string;
  name: string;
  body: string;
  publishedAt?: string;
  htmlUrl: string;
  repoUrl?: string;
  releasesUrl?: string;
  packageDownloadUrl?: string;
  packageAssetName?: string;
  dmgDownloadUrl?: string;
  dmgAssetName?: string;
  source?: 'local' | 'github';
};

export const resolveReleaseDownloadUrl = (release: GithubReleaseInfo | null | undefined) => {
  if (!release) return '';
  if (release.dmgDownloadUrl) return release.dmgDownloadUrl;
  return release.htmlUrl;
};

export const releaseDownloadLabel = (release: GithubReleaseInfo | null | undefined, viewMode: 'update' | 'notes' = 'update') => {
  if (release?.dmgDownloadUrl) return viewMode === 'notes' ? 'Beta Release' : 'Download Update';
  return viewMode === 'notes' ? 'Beta Release' : 'Download Update';
};

const RELEASE_DISMISS_SESSION_KEY = 'vdx.release.dismissedVersion';

export const getSessionDismissedRelease = () => {
  try {
    return window.sessionStorage.getItem(RELEASE_DISMISS_SESSION_KEY) || '';
  } catch {
    return '';
  }
};

export const setSessionDismissedRelease = (tagName: string) => {
  try {
    window.sessionStorage.setItem(RELEASE_DISMISS_SESSION_KEY, tagName);
  } catch {
    // best-effort
  }
};

export const fetchLatestGithubRelease = async (): Promise<GithubReleaseInfo | null> => {
  const response = await apiFetch('/api/github-latest-release');
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.release?.tagName) return null;
  return data.release as GithubReleaseInfo;
};

export const fetchReleaseNotes = async (): Promise<GithubReleaseInfo | null> => {
  const response = await apiFetch('/api/release-notes');
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.release?.tagName) return null;
  return data.release as GithubReleaseInfo;
};

export const shouldPromptForRelease = (latestTag: string, currentVersion: string, dismissedTag = '') => {
  if (!latestTag || !currentVersion) return false;
  if (dismissedTag && dismissedTag === latestTag) return false;
  return isNewerVersion(latestTag, currentVersion);
};
