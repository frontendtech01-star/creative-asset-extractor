import React from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

export function WebsiteExtracterToolbar({
  url,
  onUrlChange,
  onExtractFromOpenWebsite,
  loading,
  extractFromOpenWebsiteLoading = false,
  inputRef,
  onSubmit,
  rightSlot,
  belowSlot,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  onExtractFromOpenWebsite?: () => void;
  loading: boolean;
  extractFromOpenWebsiteLoading?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onSubmit?: () => void;
  rightSlot?: React.ReactNode;
  belowSlot?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmit?.();
              }
            }}
            placeholder="https://example.com"
            className="w-full min-w-0 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            title="Extract (Enter)"
          />
          {belowSlot}
        </div>
        {rightSlot}
        <div className="flex flex-wrap gap-2">
          {onExtractFromOpenWebsite ? (
            <button
              type="button"
              disabled={loading || extractFromOpenWebsiteLoading || !url.trim()}
              onClick={onExtractFromOpenWebsite}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {extractFromOpenWebsiteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
              {extractFromOpenWebsiteLoading || loading ? 'Extracting…' : 'Extract from Chrome'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** @deprecated Use WebsiteExtracterToolbar */
export const WebsiteExtractionToolbar = WebsiteExtracterToolbar;
export const WebsiteCrawlerToolbar = WebsiteExtracterToolbar;
