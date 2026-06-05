const CLIPBOARD_URL_STORAGE_KEY = 'vdx.clipboardUrl.v1';

export const parseClipboardUrl = (raw: string): string | null => {
  const text = String(raw || '').trim();
  if (!text) return null;

  const tryParse = (candidate: string) => {
    const value = candidate.trim();
    if (!/^https?:\/\//i.test(value)) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname || parsed.hostname === 'localhost') return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) return direct;

  for (const line of text.split(/\r?\n/)) {
    const parsed = tryParse(line);
    if (parsed) return parsed;
  }

  return null;
};

export const readPersistedClipboardUrl = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return parseClipboardUrl(window.localStorage.getItem(CLIPBOARD_URL_STORAGE_KEY) || '') || '';
  } catch {
    return '';
  }
};

export const writePersistedClipboardUrl = (url: string) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CLIPBOARD_URL_STORAGE_KEY, url);
  } catch {
    // best-effort
  }
  try {
    window.sessionStorage.setItem(CLIPBOARD_URL_STORAGE_KEY, url);
  } catch {
    // best-effort mirror
  }
};

export const clearPersistedClipboardUrl = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CLIPBOARD_URL_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(CLIPBOARD_URL_STORAGE_KEY);
  } catch {
    // ignore
  }
};
