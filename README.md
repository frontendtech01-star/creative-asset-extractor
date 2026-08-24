# Creative Asset Extractor

Creative Asset Extractor is a local React, Express, and Electron application for
extracting, previewing, converting, and downloading creative assets from web
pages and supported video platforms.

## Requirements

- Node.js `20.19+` or `22.12+` (`22.x LTS` recommended)
- npm, included with Node.js
- Internet access during installation
- About 1.5 GB of free disk space for dependencies and runtime tools

Python and a separate FFmpeg installation are not required. The project setup
prepares its required media tools automatically.

## Quick Start

Open a terminal in this project folder and run:

```bash
npm install
npm run dev
```

Open the URL printed by the server, normally:

```text
http://localhost:3000
```

If port `3000` is already occupied, the app automatically selects another
available port such as `3001` or `3003`.

To launch the Electron desktop app instead:

```bash
npm start
```

## Installed Dependencies

Running `npm install` installs the packages in `package-lock.json` and prepares:

- React, Vite, Tailwind CSS, and TypeScript
- Express and WebSocket server support
- Electron and electron-builder
- Puppeteer browser automation
- Sharp image processing and font conversion tools
- FFmpeg and FFprobe for media processing
- Standalone `yt-dlp` for supported platform metadata and downloads
- aria2 download acceleration when available

Install from the Mac DMG linked in [RELEASE_NOTES.md](./RELEASE_NOTES.md).

## macOS Gatekeeper

If macOS says that `yt-dlp`, `ffmpeg`, `ffprobe`, or `aria2c` cannot be checked
for malicious software, and you trust the source of this project, clear the
download quarantine flag:

```bash
xattr -dr com.apple.quarantine vendor/bin-pack
```

Then restart the app:

```bash
npm run dev
```

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install all dependencies and prepare media tools |
| `npm run dev` | Start the local web app and API server |
| `npm start` | Start the Electron desktop app |
| `npm run typecheck` | Check TypeScript |
| `npm run build` | Build the frontend |
| `npm run build:all` | Build the frontend and type-check the server |
| `npm run smoke` | Run the consolidated fast static smoke check |
| `npm run dmg` | Build and verify a macOS DMG |
| `npm run dist:win` | Build a Windows NSIS installer |
| `npm run dist:linux` | Build a Linux AppImage |

## Project Map

This is the working application folder. Keep the source, runtime tools, and
configuration folders below. Build products and test outputs can be recreated.

```text
creative extracter/
├── src/                 React application and browser-side logic
├── server.ts            Express API, extraction pipeline, downloads and feedback endpoint
├── server/              Server helpers (workers, progress WebSocket, video routes)
├── electron/            Electron main process and preload bridge
├── scripts/             Development, build, setup and smoke-test commands
├── vendor/              Bundled Chromium and command-line runtime tools
├── bin/                 macOS copies of the runtime media tools
├── desktop/             Generated bundled server used by packaged Electron builds
├── dist/                Generated Vite frontend build
├── release/             Generated installers and packaging metadata
├── reports/             Saved extraction/QC reports
├── package.json         Commands and application dependencies
├── vite.config.ts       Frontend build configuration
└── electron/main.cjs    Desktop application entry point
```

### Application source

| Folder/file | What it does | Keep? |
| --- | --- | --- |
| `src/App.tsx` | Main application screen, extraction UI, bookmarks, progress, and navigation. | Yes |
| `src/components/` | Reusable UI: image, font, video, color, bookmark, feedback, and progress panels. | Yes |
| `src/lib/` | Shared browser-side utilities: API calls, downloads, font/color handling, sessions, bookmarks, feedback, and WebSocket progress. | Yes |
| `src/config/` | Frontend configuration such as the feedback form defaults. | Yes |
| `server.ts` | Main local API server. Runs website extraction with Chromium, asset collection, conversion, downloads, and feedback delivery. | Yes |
| `server/` | Focused server helpers: extraction workers, font conversion worker, live WebSocket progress, and video downloader routes. | Yes |
| `electron/` | Starts the packaged desktop application and exposes safe desktop APIs to the UI. | Yes |

### Runtime tools and packaging

| Folder | What it does | Keep? |
| --- | --- | --- |
| `vendor/chromium/` and `vendor/chromium-pack/` | Local Chromium used to render modern websites and collect lazy-loaded assets. | Yes |
| `vendor/bin-pack/` | Bundled `ffmpeg`, `ffprobe`, `yt-dlp`, `aria2c`, and `deno` used for media downloads/conversion. | Yes |
| `bin/mac/` | macOS runtime-tool copies used by desktop packaging. | Yes |
| `desktop/server.mjs` | Bundled version of `server.ts` used by Electron release builds. Rebuilt with `npm run build:desktop:server`. | Yes; generated |
| `dist/` | Compiled frontend served by production/desktop builds. Rebuilt with `npm run build`. | Safe to regenerate |
| `release/` | DMGs, ZIPs, and electron-builder metadata. This can be large; keep it if you need existing installers. | Optional generated output |

### Scripts and verification

| Folder/file | What it does |
| --- | --- |
| `scripts/dev.mjs` | Repairs required local tools if necessary and starts `server.ts` for development. |
| `scripts/start.mjs` / `scripts/start-localhost.mjs` | Starts the desktop/local-host variants. |
| `scripts/build-*.mjs` | Creates the server bundle and platform installer builds. |
| `scripts/smoke-*.mjs` | Retained targeted regression tests for extraction, fonts, images, videos, packaging, and feedback. Use `npm run smoke` for the normal fast check. |
| `scripts/qc-dmg.mjs` | Packaged macOS installer verification, run as part of the DMG build. |
| `scripts/lib/` | Shared helpers used by setup/build/smoke scripts. |

### Feedback: one canonical location

Feedback is intentionally kept as one feature, with one canonical deployment
script:

| Location | Responsibility |
| --- | --- |
| `src/components/FeedbackModal.tsx` | Feedback form shown to the user. |
| `src/lib/feedbackContext.ts`, `feedbackProfile.ts`, `feedbackSubmit.ts` | Feedback state, form data, and API submission. |
| `server.ts` | Receives feedback, stores a local fallback inbox, and forwards it to Google Sheets or a Google Form. |
| `scripts/apps-script/Code.gs` | **Canonical Google Apps Script webhook** for the feedback spreadsheet. Deploy/redeploy this file when changing the sheet integration. |
| `scripts/setup-google-feedback.mjs` | Optional helper for configuring or deploying the feedback webhook. |

The old duplicate feedback webhook file has been removed. Do not add another
copy; use `scripts/apps-script/Code.gs` as the only Apps Script source.

### Saved data and outputs

| Location | What it contains |
| --- | --- |
| `reports/` | Saved JSON reports from extraction/QC work. Keep reports that are useful as regression references. |
| App data folder (outside this repository) | Local feedback fallback inbox, bookmark history, settings, screenshots, and downloaded assets. The app reports its exact local paths in its relevant UI/status screens. |

### Safe cleanup guide

The following are generated and can be removed when you do not need their
contents. They will be recreated by the relevant command.

| Target | Recreate with |
| --- | --- |
| `dist/` | `npm run build` |
| `desktop/server.mjs` | `npm run build:desktop:server` |
| `release/` | `npm run dmg`, `npm run dist:win`, or `npm run dist:linux` |
| `.smoke-*` and `.qc-*` folders | The smoke/QC command that created them |

Do **not** delete `src/`, `server/`, `vendor/`, `electron/`, `scripts/`,
`package.json`, or `package-lock.json` unless you are intentionally changing
the application. Avoid deleting `node_modules/` unless you are prepared to run
`npm install` again.

`npm run smoke` is the standard fast check for normal development. The named
scripts in `scripts/smoke-*.mjs` are retained only for focused regressions or
release checks; they do not create files unless the individual test requires
an output folder.

## How the App Works

1. The user enters a page URL, a video URL, or opens a saved bookmark.
2. `server.ts` first tries fast HTML/static extraction.
3. If a rendered page is needed, bundled Chromium loads it, collects DOM and
   network assets, scrolls for lazy assets, and streams live progress over a
   WebSocket.
4. The UI groups results into Images, Fonts, Videos, Colors, and Insights.
5. Fonts can be converted; assets can be previewed, downloaded individually,
   or packed into ZIP files.
6. Bookmarks and recent searches are stored locally. Recent searches are in
   **Menu → My Bookmarks** so they do not push asset results below the fold.
7. Feedback is submitted to the configured Google Sheets webhook when
   available, with a local inbox fallback if it is not.

## Responsible Use

This application is intended for personal and lawful use only. Users are
responsible for complying with copyright laws, platform terms of service, and
local regulations.

Do not use this application to download, reproduce, or distribute copyrighted
or protected content without proper permission. The app does not bypass DRM;
DRM-protected services such as Netflix, Prime Video, Disney+, and Hotstar are
unsupported.

User media is not uploaded to external servers by this app. Extraction and
conversion happen locally when possible.
