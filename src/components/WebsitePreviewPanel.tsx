import React from 'react';
import { ExternalLink, Loader2, Trash2 } from 'lucide-react';

export function WebsiteExtracterToolbar({
  url,
  onUrlChange,
  onClearDownloads,
  onExtractFromOpenWebsite,
  loading,
  extractFromOpenWebsiteLoading = false,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  onClearDownloads?: () => void;
  onExtractFromOpenWebsite?: () => void;
  loading: boolean;
  extractFromOpenWebsiteLoading?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <p className="font-medium">Full Website Extracter</p>
        <p className="mt-1 text-blue-800/90">
          Extract from the entire page: images (including icons), videos, fonts, and colors.
        </p>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <input
          type="text"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="https://example.com"
          className="min-w-0 flex-1 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
        <div className="flex flex-wrap gap-2">
          {onExtractFromOpenWebsite ? (
            <button
              type="button"
              disabled={loading || extractFromOpenWebsiteLoading || !url.trim()}
              onClick={onExtractFromOpenWebsite}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {extractFromOpenWebsiteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
              {extractFromOpenWebsiteLoading || loading ? 'Extracting…' : 'Extract From Open Website'}
            </button>
          ) : null}
          {onClearDownloads ? (
            <button
              type="button"
              onClick={onClearDownloads}
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              <Trash2 className="h-4 w-4" />
              Clear Downloads
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
