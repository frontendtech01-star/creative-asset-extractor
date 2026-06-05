import React from 'react';
import { Download, Sparkles, X } from 'lucide-react';
import type { GithubReleaseInfo } from '../lib/githubRelease';
import { releaseDownloadLabel, resolveReleaseDownloadUrl } from '../lib/githubRelease';

const formatReleaseNotes = (body: string) => {
  const text = String(body || '').trim();
  if (!text) return 'No release notes provided.';
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
};

export function LatestReleaseModal({
  open,
  viewMode = 'update',
  productName,
  currentVersion,
  release,
  onDownload,
  onLater,
}: {
  open: boolean;
  viewMode?: 'update' | 'notes';
  productName: string;
  currentVersion: string;
  release: GithubReleaseInfo | null;
  onDownload: () => void;
  onLater: () => void;
}) {
  if (!open) return null;

  const versionLabel = currentVersion.replace(/^v/i, '');
  const isNotesView = viewMode === 'notes';
  const downloadUrl = resolveReleaseDownloadUrl(release);
  const downloadLabel = releaseDownloadLabel(release, viewMode);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="latest-release-title"
    >
      <div className="fade-in max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-violet-50 p-3 text-violet-700">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h2 id="latest-release-title" className="text-xl font-semibold text-zinc-950">
                {isNotesView ? 'Release note' : 'Latest release available'}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {isNotesView
                  ? `${productName} v${versionLabel}${release?.tagName ? ` · ${release.tagName}` : ''}`
                  : `${productName} ${release?.tagName || ''} is available (you have v${versionLabel}).`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLater}
            className="rounded-full p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close latest release popup"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
          {release ? (
            <>
              <p className="text-sm font-semibold text-zinc-900">{release.name || release.tagName}</p>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-6 text-zinc-700">
                {formatReleaseNotes(release.body)}
              </pre>
              {isNotesView && (release.dmgDownloadUrl || release.releasesUrl || release.repoUrl) ? (
                <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm">
                  <p className="font-medium text-zinc-900">Download source</p>
                  {release.dmgDownloadUrl ? (
                    <p className="text-zinc-700">
                      macOS DMG:{' '}
                      <a
                        href={release.dmgDownloadUrl}
                        onClick={(event) => {
                          event.preventDefault();
                          onDownload();
                        }}
                        className="break-all font-medium text-blue-600 hover:text-blue-700"
                      >
                        {release.dmgAssetName || 'Creative Asset Extractor.dmg'}
                      </a>
                    </p>
                  ) : null}
                  {release.releasesUrl ? (
                    <p className="text-zinc-700">
                      GitHub releases:{' '}
                      <a
                        href={release.releasesUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all font-medium text-blue-600 hover:text-blue-700"
                      >
                        {release.releasesUrl}
                      </a>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-zinc-600">Release notes are not available right now.</p>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onLater}
            className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            {isNotesView ? 'Close' : 'Remind Me Later'}
          </button>
          {downloadUrl ? (
            <button
              type="button"
              onClick={onDownload}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              <Download className="h-4 w-4" />
              {downloadLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
