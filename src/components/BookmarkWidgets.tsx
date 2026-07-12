import React from 'react';
import {
  Bookmark,
  Copy,
  Download,
  Edit3,
  FileDown,
  FileText,
  Folder,
  History,
  Keyboard,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  BookmarkItem,
  BookmarkStore,
  BookmarkCategory,
  deleteBookmark,
  duplicateBookmark,
  emptyBookmarkStore,
  importBookmarks,
  normalizeBookmarkUrl,
  saveBookmark,
  titleFromUrl,
  updateBookmark,
} from '../lib/bookmarkStore';

const isEditableTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
};

export { isEditableTarget };

const displayDate = (value?: string | null) => {
  if (!value) return 'Never';
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch {
    return value;
  }
};

export function AppMenu({
  open,
  onToggle,
  onClose,
  releaseUpdateAvailable = false,
  onFeedback,
  onBookmarks,
  onKeyboardShortcuts,
  onReleaseNotesAndUpdates,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  releaseUpdateAvailable?: boolean;
  onFeedback: () => void;
  onBookmarks: () => void;
  onKeyboardShortcuts: () => void;
  onReleaseNotesAndUpdates: () => void;
}) {
  const items = [
    { label: 'Latest Release Notes', handler: onReleaseNotesAndUpdates, icon: FileText, highlight: releaseUpdateAvailable },
    { label: 'Feedback', handler: onFeedback, icon: MessageSquare },
    { label: 'My Bookmarks', handler: onBookmarks, icon: Star },
    { label: 'Keyboard Shortcuts', handler: onKeyboardShortcuts, icon: Keyboard },
  ];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        title={releaseUpdateAvailable ? 'Menu · New release available' : 'Menu'}
        className={[
          'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition',
          releaseUpdateAvailable
            ? 'release-blink-once border border-red-600 bg-red-600 text-white shadow-sm hover:border-red-700 hover:bg-red-700'
            : 'border border-zinc-200 bg-white text-zinc-700 hover:border-blue-600 hover:bg-blue-600 hover:text-white',
        ].join(' ')}
      >
        <Menu className="h-4 w-4" />
        Menu
      </button>
      {open ? (
        <>
          <button type="button" aria-label="Close menu" className="fixed inset-0 z-20 cursor-default" onClick={onClose} />
          <div className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white py-2 text-sm shadow-2xl">
            {items.map(({ label, handler, icon: Icon, highlight }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  onClose();
                  handler();
                }}
                className={[
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left font-medium transition',
                  highlight
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'text-zinc-700 hover:bg-blue-50 hover:text-blue-700',
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function KeyboardShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  const sections = [
    {
      title: 'Navigation',
      rows: [
        ['W', 'Website Extractor'],
        ['V', 'Image/Video Downloader'],
      ],
    },
    {
      title: 'Workflow',
      rows: [
        ['Enter / Return', 'Start Extract or Download'],
        ['⌘/Ctrl + R', 'Reset Current Tool'],
        ['⌘/Ctrl + L', 'Focus URL Input'],
        ['⌘/Ctrl + D', 'Bookmark Current URL'],
        ['Esc', 'Cancel Current Process'],
        ['⌘/Ctrl + Shift + O', 'Open Output Folder'],
        ['?', 'Open Keyboard Shortcuts'],
      ],
    },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-zinc-900">Keyboard Shortcuts</h2>
            <p className="text-xs text-zinc-500">Shortcuts pause while you are typing in inputs, textareas, editors, or forms.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-5 p-5">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">{section.title}</h3>
              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
                {section.rows.map(([keys, description]) => (
                  <div key={keys} className="flex items-center justify-between gap-4 px-4 py-3">
                    <span className="text-sm font-medium text-zinc-700">{description}</span>
                    <kbd className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-bold text-zinc-700 shadow-sm">{keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BookmarkStarButton({
  url,
  category,
  store,
  onChanged,
}: {
  url: string;
  category: BookmarkCategory;
  store: BookmarkStore | null;
  onChanged: () => void;
}) {
  const normalized = normalizeBookmarkUrl(url);
  const existing = store?.bookmarks.find((bookmark) => bookmark.normalizedUrl === normalized && bookmark.category === category);
  const [saving, setSaving] = React.useState(false);
  const disabled = !normalized || saving;
  return (
    <button
      type="button"
      disabled={disabled}
      title={existing ? 'Bookmarked (⌘D)' : 'Bookmark this URL (⌘D)'}
      onClick={async () => {
        if (!normalized) return;
        setSaving(true);
        try {
          if (existing) {
            await updateBookmark(existing.id, { favorite: !existing.favorite });
          } else {
            await saveBookmark({ url, category, title: titleFromUrl(url), favorite: true, tags: [] });
          }
          onChanged();
        } finally {
          setSaving(false);
        }
      }}
      className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border text-lg transition ${
        existing
          ? 'border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100'
          : 'border-zinc-200 bg-white text-zinc-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {existing ? <Star className="h-5 w-5 fill-current" /> : <Star className="h-5 w-5" />}
    </button>
  );
}

export function RecentRows({
  store,
  category,
  title,
  onOpen,
  onBookmark,
  onDelete,
  onClear,
}: {
  store: BookmarkStore | null;
  category: BookmarkCategory;
  title: string;
  onOpen: (url: string) => void;
  onBookmark: (url: string) => void;
  onDelete: (url: string) => void;
  onClear?: () => void;
}) {
  const rows = (store?.history || []).filter((item) => item.category === category).slice(0, 15);
  if (!rows.length) return null;
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          <History className="h-3.5 w-3.5" />
          {title}
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {category === 'website' ? 'Clear Searches' : 'Clear Recent Downloads'}
          </button>
        ) : null}
      </div>
      <div className="divide-y divide-zinc-100">
        {rows.map((item) => (
          <div key={item.id} className="group flex items-center gap-3 py-2">
            {item.faviconUrl ? <img src={item.faviconUrl} className="h-5 w-5 rounded" alt="" /> : <span className="h-5 w-5 rounded bg-zinc-100" />}
            <button type="button" onClick={() => onOpen(item.url)} className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-semibold text-zinc-900">{item.title || titleFromUrl(item.url)}</p>
              <p className="truncate text-xs text-zinc-500">{item.url}</p>
            </button>
            <span className="hidden text-xs text-zinc-400 sm:block">{displayDate(item.lastUsed)}</span>
            <button type="button" onClick={() => onBookmark(item.url)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-amber-50 hover:text-amber-600" title="Bookmark">
              <Star className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => onDelete(item.url)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" title="Delete from history">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PinnedBookmarks({
  store,
  category,
  onOpen,
}: {
  store: BookmarkStore | null;
  category?: BookmarkCategory;
  onOpen: (bookmark: BookmarkItem) => void;
}) {
  const pins = (store?.bookmarks || [])
    .filter((bookmark) => bookmark.favorite && (!category || bookmark.category === category))
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .slice(0, 12);
  if (!pins.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {pins.map((bookmark) => (
        <button
          key={bookmark.id}
          type="button"
          onClick={() => onOpen(bookmark)}
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 shadow-sm transition hover:bg-amber-100"
          title={bookmark.url}
        >
          <Star className="h-3.5 w-3.5 fill-current" />
          {bookmark.title || titleFromUrl(bookmark.url)}
        </button>
      ))}
    </div>
  );
}

export function AutocompletePanel({
  query,
  store,
  category,
  onPick,
}: {
  query: string;
  store: BookmarkStore | null;
  category: BookmarkCategory;
  onPick: (url: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return null;
  const suggestions = [
    ...(store?.bookmarks || []).filter((item) => item.category === category),
    ...(store?.history || []).filter((item) => item.category === category) as any[],
  ]
    .filter((item) => `${item.title || ''} ${item.url || ''} ${(item.tags || []).join(' ')}`.toLowerCase().includes(needle))
    .slice(0, 8);
  if (!suggestions.length) return null;
  return (
    <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
      {suggestions.map((item) => (
        <button
          key={`${item.id}-${item.url}`}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item.url)}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-blue-50"
        >
          {item.faviconUrl ? <img src={item.faviconUrl} className="h-5 w-5 rounded" alt="" /> : <Search className="h-5 w-5 text-zinc-400" />}
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-zinc-900">{item.title || titleFromUrl(item.url)}</span>
            <span className="block truncate text-xs text-zinc-500">{item.url}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function BookmarkManagerModal({
  open,
  store,
  onClose,
  onReload,
  onOpenBookmark,
}: {
  open: boolean;
  store: BookmarkStore | null;
  onClose: () => void;
  onReload: () => void;
  onOpenBookmark: (bookmark: BookmarkItem) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<'used' | 'added' | 'name' | 'url' | 'favorites'>('used');
  const [editing, setEditing] = React.useState<BookmarkItem | null>(null);
  const [contextId, setContextId] = React.useState<string | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  if (!open) return null;
  const data = store || emptyBookmarkStore();
  const needle = query.toLowerCase();
  const filtered = data.bookmarks
    .filter((item) => `${item.title} ${item.url} ${item.notes || ''} ${(item.tags || []).join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (sort === 'favorites') return Number(b.favorite) - Number(a.favorite) || a.sortIndex - b.sortIndex;
      if (sort === 'added') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (sort === 'name') return (a.title || '').localeCompare(b.title || '');
      if (sort === 'url') return a.url.localeCompare(b.url);
      return Date.parse(b.lastUsed || '') - Date.parse(a.lastUsed || '') || a.sortIndex - b.sortIndex;
    });

  const exportUrl = (format: 'json' | 'html') => `/api/bookmarks/export.${format}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-zinc-900">Bookmark Manager</h2>
            <p className="text-xs text-zinc-500">Local bookmarks, folders, recents, and Chrome-compatible import/export.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid max-h-[calc(90vh-4rem)] grid-cols-1 overflow-hidden md:grid-cols-[220px,1fr]">
          <aside className="border-r border-zinc-200 bg-zinc-50 p-4">
            <button
              type="button"
              onClick={async () => {
                await saveBookmark({ title: 'New Bookmark', url: 'https://example.com', category: 'website', tags: [] });
                onReload();
              }}
              className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              Add Bookmark
            </button>
            <div className="space-y-1 text-sm">
              <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Folders</p>
              <p className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-zinc-700"><Folder className="h-4 w-4" /> All Bookmarks</p>
              {data.folders.map((folder) => (
                <p key={folder.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-zinc-700"><Folder className="h-4 w-4" /> {folder.title}</p>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              <a href={exportUrl('json')} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:border-blue-300 hover:text-blue-700"><FileDown className="h-4 w-4" /> Export JSON</a>
              <a href={exportUrl('html')} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:border-blue-300 hover:text-blue-700"><FileDown className="h-4 w-4" /> Export HTML</a>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:border-blue-300 hover:text-blue-700">
                <Download className="h-4 w-4" />
                Import
                <input
                  type="file"
                  accept=".json,.html,.htm,text/html,application/json"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const text = await file.text();
                    await importBookmarks(text, /\.html?$/i.test(file.name) ? 'html' : 'json');
                    onReload();
                    event.currentTarget.value = '';
                  }}
                />
              </label>
            </div>
          </aside>
          <section className="overflow-y-auto p-4">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search title, URL, notes, tags..."
                className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <select value={sort} onChange={(event) => setSort(event.target.value as any)} className="rounded-xl border border-zinc-200 px-3 py-2 text-sm">
                <option value="used">Recently Used</option>
                <option value="added">Recently Added</option>
                <option value="name">Name</option>
                <option value="url">URL</option>
                <option value="favorites">Favorites</option>
              </select>
            </div>
            <div className="space-y-2">
              {filtered.map((bookmark) => (
                <div
                  key={bookmark.id}
                  draggable
                  onDragStart={() => setDragId(bookmark.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={async () => {
                    if (!dragId || dragId === bookmark.id) return;
                    const dragged = data.bookmarks.find((item) => item.id === dragId);
                    if (!dragged) return;
                    await updateBookmark(dragged.id, { sortIndex: bookmark.sortIndex - 0.5 });
                    setDragId(null);
                    onReload();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextId(contextId === bookmark.id ? null : bookmark.id);
                  }}
                  className="relative rounded-xl border border-zinc-200 bg-white p-3 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    {bookmark.faviconUrl ? <img src={bookmark.faviconUrl} className="mt-1 h-5 w-5 rounded" alt="" /> : <Bookmark className="mt-1 h-5 w-5 text-zinc-400" />}
                    <button type="button" onClick={() => onOpenBookmark(bookmark)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm font-bold text-zinc-900">{bookmark.favorite ? '★ ' : ''}{bookmark.title}</p>
                      <p className="truncate text-xs text-zinc-500">{bookmark.url}</p>
                      <p className="mt-1 text-xs text-zinc-400">Added {displayDate(bookmark.createdAt)} · Last used {displayDate(bookmark.lastUsed)}</p>
                    </button>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => setEditing(bookmark)} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"><Edit3 className="h-4 w-4" /></button>
                      <button type="button" onClick={() => void duplicateBookmark(bookmark.id).then(onReload)} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"><Copy className="h-4 w-4" /></button>
                      <button type="button" onClick={() => void deleteBookmark(bookmark.id).then(onReload)} className="rounded-lg p-2 text-red-500 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {contextId === bookmark.id ? (
                    <div className="absolute right-3 top-12 z-10 w-48 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 text-sm shadow-xl">
                      <button className="block w-full px-3 py-2 text-left hover:bg-blue-50" onClick={() => onOpenBookmark(bookmark)}>Open / Extract</button>
                      <button className="block w-full px-3 py-2 text-left hover:bg-blue-50" onClick={() => window.open(bookmark.url, '_blank')}>Open in Browser</button>
                      <button className="block w-full px-3 py-2 text-left hover:bg-blue-50" onClick={() => navigator.clipboard?.writeText(bookmark.url)}>Copy URL</button>
                      <button className="block w-full px-3 py-2 text-left hover:bg-blue-50" onClick={() => setEditing(bookmark)}>Rename</button>
                      <button className="block w-full px-3 py-2 text-left hover:bg-blue-50" onClick={() => void duplicateBookmark(bookmark.id).then(onReload)}>Duplicate</button>
                      <button className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50" onClick={() => void deleteBookmark(bookmark.id).then(onReload)}>Delete</button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      {editing ? <BookmarkEditModal bookmark={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onReload(); }} /> : null}
    </div>
  );
}

function BookmarkEditModal({ bookmark, onClose, onSaved }: { bookmark: BookmarkItem; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = React.useState(bookmark);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
        <h3 className="mb-4 text-lg font-bold">Edit Bookmark</h3>
        <div className="space-y-3">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="w-full rounded-xl border border-zinc-200 px-3 py-2" placeholder="Title" />
          <input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} className="w-full rounded-xl border border-zinc-200 px-3 py-2" placeholder="URL" />
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as BookmarkCategory })} className="w-full rounded-xl border border-zinc-200 px-3 py-2">
            <option value="website">Website</option>
            <option value="video">Video</option>
          </select>
          <textarea value={draft.notes || ''} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} className="w-full rounded-xl border border-zinc-200 px-3 py-2" placeholder="Notes" />
          <input value={(draft.tags || []).join(', ')} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} className="w-full rounded-xl border border-zinc-200 px-3 py-2" placeholder="Tags, comma separated" />
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={draft.favorite} onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })} /> Favorite Pin</label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-zinc-200 px-4 py-2 font-semibold text-zinc-700">Cancel</button>
          <button type="button" onClick={() => void updateBookmark(bookmark.id, draft).then(onSaved)} className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white">Save</button>
        </div>
      </div>
    </div>
  );
}

export function BookmarkSearchModal({
  open,
  store,
  onClose,
  onOpenBookmark,
}: {
  open: boolean;
  store: BookmarkStore | null;
  onClose: () => void;
  onOpenBookmark: (bookmark: BookmarkItem) => void;
}) {
  const [query, setQuery] = React.useState('');
  const ref = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (open) window.setTimeout(() => ref.current?.focus(), 30);
  }, [open]);
  if (!open) return null;
  const needle = query.toLowerCase();
  const matches = (store?.bookmarks || [])
    .filter((item) => `${item.title} ${item.url} ${item.notes || ''} ${(item.tags || []).join(' ')}`.toLowerCase().includes(needle))
    .slice(0, 20);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[10vh]">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3">
          <Search className="h-5 w-5 text-zinc-400" />
          <input ref={ref} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bookmarks..." className="min-w-0 flex-1 border-none text-base outline-none" />
          <button type="button" onClick={onClose}><X className="h-5 w-5 text-zinc-500" /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {matches.map((bookmark) => (
            <button
              key={bookmark.id}
              type="button"
              onClick={() => {
                onOpenBookmark(bookmark);
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-blue-50"
            >
              {bookmark.faviconUrl ? <img src={bookmark.faviconUrl} className="h-5 w-5 rounded" alt="" /> : <Bookmark className="h-5 w-5 text-zinc-400" />}
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{bookmark.title}</span>
                <span className="block truncate text-xs text-zinc-500">{bookmark.url}</span>
              </span>
              {bookmark.favorite ? <Star className="ml-auto h-4 w-4 fill-amber-500 text-amber-500" /> : null}
            </button>
          ))}
          {!matches.length ? <p className="p-6 text-center text-sm text-zinc-500">No bookmarks found.</p> : null}
        </div>
      </div>
    </div>
  );
}
