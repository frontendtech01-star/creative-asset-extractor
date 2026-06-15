import React from 'react';
import { X } from 'lucide-react';
import { apiUrl } from '../lib/api';

type SectionPick = {
  selector: string;
  label: string;
};

export default function SectionPickerModal({
  open,
  pageUrl,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pageUrl: string;
  onClose: () => void;
  onConfirm: (pick: SectionPick) => void;
}) {
  const [selection, setSelection] = React.useState<SectionPick | null>(null);

  React.useEffect(() => {
    if (!open) {
      setSelection(null);
      return undefined;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'vdx-section-picked') return;
      const selector = String(event.data.selector || '').trim();
      const label = String(event.data.label || '').trim();
      if (!selector) return;
      setSelection({ selector, label: label || selector });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open]);

  if (!open || !pageUrl) return null;

  const frameSrc = apiUrl(`/api/section-frame?url=${encodeURIComponent(pageUrl)}`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[min(90vh,820px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Pick Section</h2>
            <p className="text-sm text-zinc-500">Click a visible block on the page preview to scope extraction.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-zinc-100 bg-zinc-50 px-5 py-3 text-sm text-zinc-700">
          {selection ? (
            <span>
              Selected: <span className="font-medium text-zinc-900">{selection.label}</span>
            </span>
          ) : (
            <span>Hover to highlight, click to select a section.</span>
          )}
        </div>

        <div className="min-h-0 flex-1 bg-zinc-100">
          <iframe
            title="Section picker preview"
            src={frameSrc}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selection}
            onClick={() => selection && onConfirm(selection)}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Use Selected Section
          </button>
        </div>
      </div>
    </div>
  );
}
