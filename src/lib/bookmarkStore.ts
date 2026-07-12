import { apiFetch } from './api';

export type BookmarkCategory = 'website' | 'video';

export type BookmarkFolder = {
  id: string;
  title: string;
  parentId?: string | null;
  createdAt: string;
  sortIndex: number;
};

export type BookmarkItem = {
  id: string;
  title: string;
  url: string;
  normalizedUrl: string;
  category: BookmarkCategory;
  folderId?: string | null;
  createdAt: string;
  lastUsed?: string | null;
  notes?: string;
  tags: string[];
  favorite: boolean;
  faviconUrl?: string;
  extraction?: {
    imageCount?: number;
    videoCount?: number;
    fontCount?: number;
    colorCount?: number;
    extractionDate?: string;
    outputFolder?: string;
  };
  sortIndex: number;
};

export type RecentItem = {
  id: string;
  title: string;
  url: string;
  normalizedUrl: string;
  category: BookmarkCategory;
  lastUsed: string;
  faviconUrl?: string;
};

export type BookmarkStore = {
  version: number;
  bookmarks: BookmarkItem[];
  folders: BookmarkFolder[];
  history: RecentItem[];
  updatedAt: string;
};

export const emptyBookmarkStore = (): BookmarkStore => ({
  version: 1,
  bookmarks: [],
  folders: [],
  history: [],
  updatedAt: new Date().toISOString(),
});

export const normalizeBookmarkUrl = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    parsed.hash = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString().replace(/\/$/g, '');
  } catch {
    return raw.replace(/\/+$/g, '');
  }
};

export const titleFromUrl = (value: string) => {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return String(value || '').trim() || 'Untitled';
  }
};

export async function fetchBookmarkStore(): Promise<BookmarkStore> {
  const response = await apiFetch('/api/bookmarks');
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not load bookmarks.');
  return data.store || emptyBookmarkStore();
}

export async function saveBookmark(payload: Partial<BookmarkItem> & { url: string; category: BookmarkCategory }) {
  const response = await apiFetch('/api/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not save bookmark.');
  return data.bookmark as BookmarkItem;
}

export async function updateBookmark(id: string, patch: Partial<BookmarkItem>) {
  const response = await apiFetch(`/api/bookmarks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not update bookmark.');
  return data.bookmark as BookmarkItem;
}

export async function deleteBookmark(id: string) {
  const response = await apiFetch(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not delete bookmark.');
}

export async function duplicateBookmark(id: string) {
  const response = await apiFetch(`/api/bookmarks/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not duplicate bookmark.');
  return data.bookmark as BookmarkItem;
}

export async function recordBookmarkHistory(url: string, category: BookmarkCategory, title?: string) {
  const response = await apiFetch('/api/bookmarks/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, category, title }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not save recent history.');
  return data.store as BookmarkStore;
}

export async function deleteRecentHistory(url: string, category: BookmarkCategory) {
  const response = await apiFetch('/api/bookmarks/history/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, category }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not delete recent history.');
  return data.store as BookmarkStore;
}

export async function clearRecentHistory(category: BookmarkCategory) {
  const response = await apiFetch('/api/bookmarks/history/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not clear recent history.');
  return data.store as BookmarkStore;
}

export async function markBookmarkUsed(id: string) {
  const response = await apiFetch(`/api/bookmarks/${encodeURIComponent(id)}/use`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not update bookmark history.');
  return data.store as BookmarkStore;
}

export async function importBookmarks(text: string, format: 'json' | 'html' = 'json') {
  const response = await apiFetch('/api/bookmarks/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, format }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not import bookmarks.');
  return data.store as BookmarkStore;
}
