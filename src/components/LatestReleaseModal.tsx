import React, { useState } from 'react';
import { Check, Copy, Download, PackageOpen, Sparkles, X } from 'lucide-react';
import type { GithubReleaseInfo } from '../lib/githubRelease';
import { releaseDownloadLabel, resolveReleaseDownloadUrl } from '../lib/githubRelease';
import { openExternalUrl } from '../lib/openExternal';

const LATEST_BETA_PACKAGE_URL =
  'https://codeload.github.com/frontendtech01-star/creative-asset-extractor/zip/refs/heads/v2.0';
const ZIP_DOWNLOAD_PATH = 'https://github.com/frontendtech01-star/creative-asset-extractor/releases/latest/download/Creative-Asset-Extractor-Localhost.zip';
const MAC_LAUNCH_COMMAND = 'xattr -dr com.apple.quarantine . && chmod +x "Run Localhost.command" && ./"Run Localhost.command"';

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
  const [copiedZipPath, setCopiedZipPath] = useState(false);
  if (!open) return null;

  const versionLabel = currentVersion.replace(/^v/i, '');
  const isNotesView = viewMode === 'notes';
  const downloadUrl = resolveReleaseDownloadUrl(release);
  const releaseTag = release?.tagName?.replace(/^v/i, '') || versionLabel;
  const notesDownloadUrl = LATEST_BETA_PACKAGE_URL;
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
                {isNotesView ? 'Beta Release' : 'Latest release available'}
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
                {isNotesView ? 'Beta Release' : `v${releaseTag}`}
              </span>

              {isNotesView ? (
                <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm">
                  <p className="font-medium text-zinc-900">Beta Release</p>
                  <ul className="list-disc space-y-1 pl-5 text-zinc-700">
                    <li>Uses fast Mac-compatible 1080p H.264 downloads by default.</li>
                    <li>Prevents YouTube downloads from stalling at 35% before fallback.</li>
                    <li>Filters blank and tracking-only Vimeo player cards.</li>
                    <li>Keeps cancel controls for active video downloads.</li>
                    <li>Removes MP3 download options.</li>
                    <li>Includes a lightweight localhost ZIP for macOS and Windows.</li>
                    <li>Downloads a private Node.js runtime on macOS without an administrator password.</li>
                  </ul>
                  <p className="text-zinc-700">
                    <button
                      type="button"
                      onClick={() => notesDownloadUrl ? openExternalUrl(notesDownloadUrl) : undefined}
                      disabled={!notesDownloadUrl}
                      className="font-medium text-blue-600 hover:text-blue-700"
                    >
                      Download Beta Release package
                    </button>
                  </p>
                  <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">ZIP download path</p>
                    <code className="mt-2 block break-all rounded bg-zinc-900 px-3 py-2 font-mono text-xs text-white">
                      {ZIP_DOWNLOAD_PATH}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(ZIP_DOWNLOAD_PATH).then(() => {
                          setCopiedZipPath(true);
                          window.setTimeout(() => setCopiedZipPath(false), 1600);
                        });
                      }}
                      className="mt-2 inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-100"
                    >
                      {copiedZipPath ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                      {copiedZipPath ? 'ZIP path copied' : 'Copy ZIP path'}
                    </button>
                  </div>
                </div>
              ) : null}

              {isNotesView ? (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-950">
                  <div className="flex items-center gap-2 font-semibold">
                    <PackageOpen className="h-4 w-4" />
                    Installation guide.md
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-blue-900">
                    <li>Right-click the downloaded and extracted folder.</li>
                    <li>Select <strong>Open Folder in Terminal</strong>.</li>
                    <li>Paste the command below and press Return.</li>
                  </ol>
                  <code className="mt-3 block break-all rounded-lg bg-blue-950 px-3 py-3 font-mono text-xs text-white">
                    {MAC_LAUNCH_COMMAND}
                  </code>
                  <p className="mt-2 text-xs text-blue-800">The launcher installs required packages, starts localhost, and opens the browser.</p>
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
