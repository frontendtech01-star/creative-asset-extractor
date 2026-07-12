import React from 'react';
import { Download, Sparkles, X } from 'lucide-react';
import type { GithubReleaseInfo } from '../lib/githubRelease';
import { releaseDownloadLabel, resolveReleaseDownloadUrl } from '../lib/githubRelease';
import { openExternalUrl } from '../lib/openExternal';

const BETA_DMG_URL =
  'https://github.com/frontendtech01-star/creative-asset-extractor/releases/latest/download/Creative.Asset.Extractor-2.0.0-arm64.dmg';
const REMOVE_QUARANTINE_COMMAND = 'xattr -dr com.apple.quarantine "/Applications/Creative Asset Extractor.app"';
const OPEN_APP_COMMAND = 'open "/Applications/Creative Asset Extractor.app"';

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
  const notesDownloadUrl = release?.dmgDownloadUrl || BETA_DMG_URL;
  const updateDownloadLabel = releaseDownloadLabel(release, viewMode);
  const sameVersionRefresh = releaseTag === versionLabel;

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
                  : sameVersionRefresh
                    ? 'A newer Mac DMG has been published with the latest fixes.'
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
                    <li>Website Extractor pulls images, SVG icons, fonts, videos and primary colors from the opened Chrome page.</li>
                    <li>Image/Video Downloader keeps video downloads and bulk image/font ZIP downloads separate.</li>
                    <li>Download social videos from YouTube, Vimeo, Instagram, Facebook, X.com, Brightcove, Wistia and iSpot.tv.</li>
                    <li>Saves fast, Mac-compatible 1080p H.264 video files by default.</li>
                    <li>Bulk asset downloader accepts image links, font links and Google/Typekit/Client Fonts CSS links.</li>
                    <li>Font downloads support WOFF and TTF output, with vertical metrics fixing enabled during conversion.</li>
                    <li>Preserves SVG downloads as Illustrator-friendly editable SVG files, including inline SVG captures where available.</li>
                    <li>Filters blank, tracker, segment and encoded website player cards.</li>
                    <li>Bookmarks, recent searches and pinned quick access are stored locally and survive app restarts.</li>
                    <li>Keyboard shortcuts are available for extraction, reset, bookmarking, navigation and output-folder access.</li>
                  </ul>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => void openExternalUrl(notesDownloadUrl)}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700"
                    >
                      <Download className="h-4 w-4" />
                      Download Mac DMG
                    </button>
                  </div>
                </div>
              ) : null}

              {isNotesView ? (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-950">
                  <p className="font-semibold">Open the installed app from Terminal</p>
                  <code className="mt-3 block whitespace-pre-wrap break-all rounded-lg bg-blue-950 px-3 py-3 font-mono text-xs text-white">
                    {REMOVE_QUARANTINE_COMMAND}{'\n'}{OPEN_APP_COMMAND}
                  </code>
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
