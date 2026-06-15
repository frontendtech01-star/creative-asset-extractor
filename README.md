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

See [INSTALLATION.md](./INSTALLATION.md) for the complete dependency list,
platform-specific setup, environment variables, build commands, verification,
and troubleshooting.

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
| `npm run dmg` | Build and verify a macOS DMG |
| `npm run dist:win` | Build a Windows NSIS installer |
| `npm run dist:linux` | Build a Linux AppImage |

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
