# Repository Guidelines

## Project Structure & Module Organization

The React/Vite interface lives in `src/`. Put reusable UI in `src/components/`, helpers in `src/lib/`, and artwork in `src/assets/`. `src/App.tsx` coordinates the main views. The extraction API is implemented in `server.ts`, with focused modules under `server/`. Electron entry points are in `electron/`; regenerate packaged `desktop/server.mjs` after backend changes.

Build and smoke-test utilities live in `scripts/`. Packaged binaries and offline runtime resources live in `vendor/` and `bin/`. Treat `dist/` and most of `release/` as generated output.

## Build, Test, and Development Commands

- `npm install` installs dependencies and prepares bundled tooling.
- `npm run dev` starts the Vite frontend and development server.
- `npm run localhost` runs the production-style local application.
- `npm run build` creates the frontend bundle in `dist/`.
- `npm run typecheck` runs TypeScript validation without emitting files.
- `npm run build:desktop:server` regenerates `desktop/server.mjs`.
- `npm run smoke` runs the lightweight regression suite.
- `npm run smoke:all:source` runs every source/local smoke area sequentially with one shared server.
- `npm run smoke:all:packaged` runs every packaged-app smoke area against the current macOS bundle.
- `npm run smoke:all` runs both full suites in order; it requires an existing packaged app.
- `npm run dmg` builds the macOS installer and runs packaged-app QC.

## Coding Style & Naming Conventions

Use TypeScript/TSX with two-space indentation, semicolons, single quotes, and trailing commas where surrounding code does. React components use `PascalCase`; hooks and functions use `camelCase`; configuration constants use `UPPER_SNAKE_CASE`. Keep components focused and shared logic in `src/lib/`. Follow existing Tailwind utility ordering and avoid unrelated formatting changes. TypeScript (`tsc --noEmit`) is the linting gate.

## Testing Guidelines

Tests are scenario-based scripts named `scripts/smoke-*.mjs`; there is no formal coverage threshold. Add a regression assertion for each reported extraction, download, packaging, or UI bug. Available commands are grouped below.

- Baseline and feedback: `npm run smoke`, `npm run smoke:feedback`.
- Images and UI: `smoke:webp`, `smoke:teneo-svg`, `smoke:hello-banner`, `smoke:alprolix-icons`.
- Fonts: `smoke:teneo-fonts`, `smoke:rxsight-typekit`, `smoke:typekit-identities`, `smoke:fordham-fonts`, `smoke:packaged-tandem-fonts`.
- Website extraction: `smoke:bissell`, `smoke:warehouse-stationery`, `smoke:warehouse-stationery-ui`, `smoke:tandem-images-ui`, `smoke:kroger`, `smoke:kroger-chromium`, `smoke:reported-sites`.
- Video: `smoke:video-downloader`, `smoke:video-failure-layers`, `smoke:video-reported-sites`, `smoke:video-ui`, `smoke:xtandi-videos`, `smoke:xtandi-video-ui`.
- Packaged flows: `smoke:packaged-video-ui`, `smoke:packaged-xtandi-video`, `smoke:packaged-tandem-fonts`, `smoke:packaged-warehouse-images`, `smoke:packaged-tandem-images`.

Prefix npm aliases with `npm run`, for example `npm run smoke:kroger`. All browser-based tests run sequentially; do not launch smoke scripts in parallel because competing Chromium sessions can create false timeouts and incorrect asset counts. Run the narrowest relevant test first, followed by `npm run typecheck` and `npm run smoke`.

For a release or DMG change, use this mandatory order:

1. Run `npm run smoke:all:source` and fix every failure.
2. Run `npm run dmg`; this rebuilds the desktop server and performs DMG QC.
3. Run `npm run smoke:all:packaged` against the exact generated app bundle.
4. Upload or publish artifacts only when all three commands pass.

For Xtandi/Bitmovin changes specifically, `smoke:xtandi-videos` must return the route-specific master manifest, `smoke:xtandi-video-ui` must show one direct video card with its thumbnail and `Download MP4` handoff, and `smoke:packaged-xtandi-video` must repeat those UI assertions from the packaged bundle. Also verify one real Image/Video Downloader job completes as a playable MP4 with video and audio; do not accept manifest extraction alone as sufficient.

Network-dependent and GUI tests require a reachable live site. Source tests use the one local server managed by `smoke-all.mjs`; packaged tests start their own bundled server and use their documented `QC_*` variables. The aggregate runner continues after individual failures, prints a complete failure summary, and exits nonzero if anything failed. It deliberately covers each behavior once instead of rerunning the duplicate `smoke:reported-sites` wrapper. A live-site outage or bot challenge must be reported separately from a product regression and must not be silently treated as a pass.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects such as `Fix broken image previews`. Keep each commit scoped and describe the user-visible outcome. Pull requests should include a concise problem/solution summary, commands executed, linked issues, and screenshots for UI changes. Note platform-specific testing and any regenerated or bundled artifacts.

## Security & Configuration

Copy `.env.example` for local configuration and never commit credentials, cookies, user profiles, or downloaded private media. Preserve responsible-use and DRM restrictions. Avoid editing large binaries unless the runtime or release process explicitly requires it.
