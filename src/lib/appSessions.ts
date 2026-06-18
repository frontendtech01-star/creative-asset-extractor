export type VideoDownloaderSession = {
  url: string;
  video: any | null;
  savedAt: number;
  /** @deprecated legacy fields */
  singleUrl?: string;
  bulkUrls?: string;
  activeTab?: string;
  videos?: any[];
  seedUrl?: string;
};

export type WebsiteExtractionSession = {
  url: string;
  extractedUrl: string;
  assets: {
    fonts: any[];
    images: any[];
    icons?: any[];
    videos: any[];
    colors: string[];
    extractionMeta?: { mode?: string; sectionLabel?: string; sectionSelector?: string };
  } | null;
  activeTab: 'fonts' | 'images' | 'colors';
  completion?: { title: string; detail?: string; size?: number; folderTarget?: string } | null;
  savedAt: number;
};

export type MainSection = 'video-downloader' | 'website-extraction';

const VIDEO_SESSION_KEY = 'vdx.videoDownloaderSession.v1';
const WEBSITE_SESSION_KEY = 'vdx.websiteExtractionSession.v1';
const MAIN_SECTION_KEY = 'vdx.mainSection.v1';

const readJson = <T>(key: string): T | null => {
  if (typeof window === 'undefined') return null;
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      return JSON.parse(raw) as T;
    } catch {
      // try next store
    }
  }
  return null;
};

const writeJson = (key: string, value: unknown) => {
  const payload = JSON.stringify(value);
  try {
    window.localStorage.setItem(key, payload);
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.setItem(key, payload);
  } catch {
    // ignore
  }
};

const removeJson = (key: string) => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
};

export const readVideoDownloaderSession = () => readJson<VideoDownloaderSession>(VIDEO_SESSION_KEY);
export const writeVideoDownloaderSession = (session: VideoDownloaderSession) => writeJson(VIDEO_SESSION_KEY, session);
export const clearVideoDownloaderSession = () => removeJson(VIDEO_SESSION_KEY);

export const readWebsiteExtractionSession = () => readJson<WebsiteExtractionSession>(WEBSITE_SESSION_KEY);
export const writeWebsiteExtractionSession = (session: WebsiteExtractionSession) => writeJson(WEBSITE_SESSION_KEY, session);
export const clearWebsiteExtractionSession = () => removeJson(WEBSITE_SESSION_KEY);

export const readMainSection = (): MainSection => {
  return 'website-extraction';
};

export const writeMainSection = (section: MainSection) => writeJson(MAIN_SECTION_KEY, { section });
