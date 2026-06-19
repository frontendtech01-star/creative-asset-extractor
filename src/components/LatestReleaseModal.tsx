import React from 'react';
import { Download, PackageOpen, Sparkles, X } from 'lucide-react';
import type { GithubReleaseInfo } from '../lib/githubRelease';
import { releaseDownloadLabel, resolveReleaseDownloadUrl } from '../lib/githubRelease';
import { openExternalUrl } from '../lib/openExternal';

const LATEST_PACKAGE_V2_URL =
  'https://codeload.github.com/frontendtech01-star/creative-asset-extractor/zip/refs/heads/v2.0';

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
  const releaseTag = release?.tagName?.replace(/^v/i, '') || versionLabel;
  const notesDownloadUrl = LATEST_PACKAGE_V2_URL;
  const updateDownloadLabel = releaseDownloadLabel(release, viewMode);

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
                {isNotesView ? 'Latest Release' : 'Latest release available'}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {isNotesView
                  ? productName
                  : `${productName} v${releaseTag} is available (you have v${versionLabel}).`}
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
              <span className="inline-flex rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                v{releaseTag}
              </span>

              {isNotesView ? (
                <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm">
                  <p className="font-medium text-zinc-900">Latest Release</p>
                  <p className="text-zinc-700">
                    <button
                      type="button"
                      onClick={() => notesDownloadUrl ? openExternalUrl(notesDownloadUrl) : undefined}
                      disabled={!notesDownloadUrl}
                      className="font-medium text-blue-600 hover:text-blue-700"
                    >
                      Download latest package v2.0
                    </button>
                  </p>
                </div>
              ) : null}

              {isNotesView ? (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-950">
                  <div className="flex items-center gap-2 font-semibold">
                    <PackageOpen className="h-4 w-4" />
                    Installation guide (package v2.0)
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-blue-900">
                    <li>
                      Download Node.js package from{' '}
                      <a
                        href="https://nodejs.org/dist/v24.17.0/node-v24.17.0.pkg"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium underline hover:text-blue-950"
                      >
                        node-v24.17.0.pkg
                      </a>
                      .
                    </li>
                    <li>Open Terminal using search bar (Cmd+Spacebar).</li>
                    <li>
                      Locate package folder by typing{' '}
                      <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">cd /Users/rohitashkumar/Downloads/creative-asset-extractor-2.0</code>
                    </li>
                    <li>
                      Type <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">npm install</code>.
                    </li>
                    <li>
                      Copy paste{' '}
                      <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">xattr -dr com.apple.quarantine vendor/bin-pack</code>,{' '}
                      <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">chmod +x vendor/bin-pack/*</code>,{' '}
                      <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">vendor/bin-pack/ffprobe -version</code>,{' '}
                      <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">vendor/bin-pack/ffmpeg -version</code>, and{' '}
                      <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">vendor/bin-pack/yt-dlp --version</code>.
                    </li>
                    <li>
                      Type <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">npm run dev</code> to start local server to run the app in the browser.
                    </li>
                    <li>
                      Example: <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-xs">http://localhost:3000/</code>
                    </li>
                  </ol>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-zinc-600">Release notes are not available right now.</p>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          {!isNotesView ? (
            <button
              type="button"
              onClick={onLater}
              className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
            >
              Remind Me Later
            </button>
          ) : null}
          {!isNotesView && downloadUrl ? (
            <button
              type="button"
              onClick={onDownload}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              <Download className="h-4 w-4" />
              {updateDownloadLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
