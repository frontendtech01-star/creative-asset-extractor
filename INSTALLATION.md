# Complete Installation Guide

This guide covers a fresh development installation, all direct dependencies,
optional configuration, platform-specific fixes, verification, and desktop
packaging for Creative Asset Extractor.

## System Requirements

| Requirement | Supported or recommended value |
| --- | --- |
| Node.js | `20.19+` or `22.12+`; Node `22.x LTS` recommended |
| npm | Included with Node.js; npm `10+` recommended |
| Operating system | macOS, Windows, or Linux |
| Internet | Required during installation and for online extraction |
| Disk space | At least 1.5 GB for development; allow more for desktop builds |
| Memory | 4 GB minimum; 8 GB or more recommended |

Node `21.x` is not supported by the current Vite dependency. Avoid old Node
versions and prefer Node 22 LTS.

The normal installation does **not** require Python or a separately installed
FFmpeg.

## What `npm install` Installs

The exact dependency versions are locked in `package-lock.json`. Always run the
install command from the project root.

### Application and Runtime Packages

- UI: `react`, `react-dom`, `@tanstack/react-virtual`, `lucide-react`,
  `clsx`, and `tailwind-merge`
- Server: `express`, `cors`, `express-rate-limit`, and `ws`
- HTTP and extraction: `axios`, `cheerio`, `srcset`, `puppeteer`,
  `@distube/ytdl-core`, and `youtube-dl-exec`
- Media: `ffmpeg-static`, `@ffprobe-installer/ffprobe`, and `fluent-ffmpeg`
- Image and font processing: `sharp`, `fonteditor-core`, and `opentype.js`
- Archives and transfer: `archiver`, `archiver-utils`, and `basic-ftp`
- Runtime tooling: `tsx`

### Development and Build Packages

- Frontend: `vite`, `@vitejs/plugin-react`, `tailwindcss`,
  `@tailwindcss/vite`, and `autoprefixer`
- Language and types: `typescript`, `@types/node`, `@types/react`,
  `@types/react-dom`, `@types/express`, `@types/cors`,
  `@types/fluent-ffmpeg`, `@types/archiver`, and `@types/ws`
- Desktop packaging: `electron`, `electron-builder`, and `extract-zip`
- Bundling: `esbuild`

### Native Runtime Tools

The post-install script runs `node scripts/setup.mjs` and prepares these tools:

| Tool | Required | Purpose |
| --- | --- | --- |
| FFmpeg | Yes | Video/audio conversion, processing, and merging |
| FFprobe | Recommended and bundled | Media stream inspection |
| standalone `yt-dlp` | Yes | Supported platform metadata and downloads |
| aria2c | Optional | Faster downloads; built-in downloading is the fallback |
| Chrome/Chromium | Required for browser-based extraction | Puppeteer normally installs or locates a compatible browser |

Runtime tool locations are recorded in `.local-tools.json`. Bundled desktop
tools are stored under `vendor/bin-pack/`.

## Fresh Installation

### 1. Install Node.js

Install Node.js 22 LTS from [nodejs.org](https://nodejs.org/) or through a Node
version manager.

Verify the installation:

```bash
node --version
npm --version
```

The Node version must satisfy `20.19+` or `22.12+`.

### 2. Open the Project Folder

macOS or Linux:

```bash
cd /path/to/creative-asset-extractor-1.0
```

Windows PowerShell:

```powershell
Set-Location C:\path\to\creative-asset-extractor-1.0
```

### 3. Install Every Dependency

```bash
npm install
```

Keep the internet connection available. Installation may download packages,
Electron, Puppeteer browser files, FFmpeg, and the standalone `yt-dlp` binary
from npm registries or GitHub.

The successful setup output ends with:

```text
Preparing video engine...
Optimizing extraction engine...
Setup complete.
```

If setup says required video tools are missing, restore internet access and run
`npm install` one more time.

For automated or clean reproducible installs, use:

```bash
npm ci
```

`npm ci` removes the existing `node_modules` directory before reinstalling it.

### 4. Optional Environment Configuration

The app works without a `.env` file. To configure feedback integrations,
release checks, ports, or a custom browser, copy the example:

macOS or Linux:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit only the values you need. Never commit secrets or private credentials in
`.env`.

### 5. Start the Web App

```bash
npm run dev
```

The command starts the Express API and Vite frontend together. Open the URL
printed in the terminal, normally:

```text
http://localhost:3000
```

The server automatically uses another local port when `3000` is occupied.
Press `Ctrl+C` in the terminal to stop it.

### 6. Start the Desktop App

```bash
npm start
```

This starts the local server, waits for its URL, and opens the Electron desktop
window.

## Verify the Installation

Run the project checks:

```bash
npm run typecheck
npm run build
```

Verify the bundled media tools on macOS or Linux:

```bash
vendor/bin-pack/yt-dlp --version
vendor/bin-pack/ffmpeg -version
vendor/bin-pack/ffprobe -version
vendor/bin-pack/aria2c --version
```

On Windows, use:

```powershell
vendor\bin-pack\yt-dlp.exe --version
vendor\bin-pack\ffmpeg.exe -version
vendor\bin-pack\ffprobe.exe -version
vendor\bin-pack\aria2c.exe --version
```

aria2c is optional, so its verification command may be unavailable on some
installations.

## Environment Variables

All variables are optional unless a related integration requires them.

| Variable | Purpose |
| --- | --- |
| `PORT` | Preferred API and app port; defaults to `3000` |
| `VITE_HMR_PORT` | Preferred Vite hot-reload port; defaults to `24678` |
| `DISABLE_HMR=true` | Disable Vite hot reload |
| `CHROME_PATH` | Path to a Chrome or Chromium executable |
| `PUPPETEER_EXECUTABLE_PATH` | Alternate browser path for Puppeteer |
| `GOOGLE_SHEET_ID` | Feedback Google Sheet ID |
| `GOOGLE_SHEET_FEEDBACK_WEBHOOK_URL` | Feedback Apps Script web-app URL |
| `GOOGLE_FORM_ACTION_URL` | Optional Google Form fallback endpoint |
| `GOOGLE_FORM_NAME_ENTRY` | Google Form name field ID |
| `GOOGLE_FORM_SUGGESTIONS_ENTRY` | Google Form suggestions field ID |
| `GOOGLE_FORM_APP_VERSION_ENTRY` | Google Form app-version field ID |
| `GOOGLE_FORM_PLATFORM_ENTRY` | Google Form platform field ID |
| `VITE_GOOGLE_FORM_*` | Frontend versions of the Google Form settings |
| `GITHUB_OWNER` / `VITE_GITHUB_OWNER` | GitHub release-check owner |
| `GITHUB_REPO` / `VITE_GITHUB_REPO` | GitHub release-check repository |
| `VDX_STRICT_YOUTUBE_AUDIO_VERIFY=1` | Enable strict YouTube audio verification |

The `VDX_APP_ROOT`, `VDX_RESOURCES_PATH`, `VDX_SERVER_URL`,
`VDX_SKIP_AUTOSTART`, and `VDX_USER_DATA` variables are managed internally by
the desktop runtime and normally should not be set manually.

To configure Google Sheet feedback interactively:

```bash
npm run setup:feedback
```

## Platform Notes

### macOS Gatekeeper Warning

Files extracted from a browser-downloaded archive may inherit a macOS
quarantine attribute. If macOS says `yt-dlp`, `ffmpeg`, `ffprobe`, or `aria2c`
cannot be checked for malicious software, confirm that you trust the project
source and run:

```bash
xattr -dr com.apple.quarantine vendor/bin-pack
```

Verify the fix:

```bash
xattr -lr vendor/bin-pack
vendor/bin-pack/yt-dlp --version
```

The first command should print no quarantine attributes.

### Linux

Ensure the bundled tools are executable if the archive format removed their
permissions:

```bash
chmod +x vendor/bin-pack/yt-dlp vendor/bin-pack/ffmpeg vendor/bin-pack/ffprobe
```

If Puppeteer cannot launch a browser, install Chrome or Chromium using your
distribution package manager and set `CHROME_PATH` in `.env`.

### Windows

Use PowerShell or Command Prompt with Node.js and npm available on `PATH`. The
setup script uses `.exe` media tools and can automatically download an optional
Windows aria2 binary when needed.

## Build and Packaging Commands

| Command | Result |
| --- | --- |
| `npm run build` | Production frontend in `dist/` |
| `npm run build:server` | Server TypeScript check |
| `npm run build:desktop:server` | Bundled desktop server |
| `npm run build:all` | Frontend build plus server TypeScript check |
| `npm run preview` | Preview the built frontend |
| `npm run dmg` or `npm run dist:mac` | macOS DMG in `release/` |
| `npm run dist:win` | Windows NSIS installer in `release/` |
| `npm run dist:linux` | Linux AppImage in `release/` |

Build installers on their target operating system. Desktop packaging downloads
additional Chromium runtime files and needs more disk space.

On macOS, choose a DMG architecture with:

```bash
DMG_PACK_ARCH=arm64 npm run dmg
DMG_PACK_ARCH=x64 npm run dmg
DMG_PACK_ARCH=universal npm run dmg
```

## Troubleshooting

### Required Video Tools Missing

Make sure npm and GitHub are reachable, then run:

```bash
npm install
node scripts/setup.mjs
```

Corporate firewalls, proxies, DNS failures, and disconnected networks can block
the FFmpeg or `yt-dlp` downloads.

### `yt-dlp` Cannot Be Opened on macOS

Clear the quarantine flag from the trusted project binaries:

```bash
xattr -dr com.apple.quarantine vendor/bin-pack
```

Then restart `npm run dev`.

### Port Already in Use

This is normally harmless because the app automatically selects another port.
To prefer a specific port:

macOS or Linux:

```bash
PORT=3010 npm run dev
```

Windows PowerShell:

```powershell
$env:PORT=3010
npm run dev
```

### Puppeteer Cannot Find or Launch Chrome

Install Google Chrome or Chromium, then set its executable path in `.env`:

```text
CHROME_PATH=/absolute/path/to/chrome
```

You can also reinstall Puppeteer's managed browser files with:

```bash
npx puppeteer browsers install chrome
```

### Clean Reinstall

Use this only when normal `npm install` repair does not work.

macOS or Linux:

```bash
rm -rf node_modules
npm install
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

### npm Reports Vulnerabilities

Review them with:

```bash
npm audit
```

Do not run `npm audit fix --force` without reviewing the proposed breaking
dependency upgrades.

## Local Data and Downloads

- Extracted media is saved under the current user's `Downloads` directory.
- App cache, logs, and local feedback data use
  `~/.creative-asset-extractor/` outside packaged desktop mode.
- Temporary converted media uses the operating system temporary directory.
- `.env`, `.local-tools.json`, `node_modules/`, `dist/`, and most generated
  release output are intentionally excluded from source control.

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
