# Release Notes

## Latest Release

**Latest git package:** [creative-asset-extractor v2.0 zip](https://codeload.github.com/frontendtech01-star/creative-asset-extractor/zip/refs/heads/v2.0)

### Package Installation

1. Download the v2.0 package from the link above.
2. Unzip the package.
3. Open Terminal and go to the extracted package folder.
4. Run `npm install`.
5. Run `xattr -dr com.apple.quarantine vendor/bin-pack` and `chmod +x vendor/bin-pack/*`.
6. Run `npm run dev` and open `http://localhost:3000/`.

For the package install guide and first-launch help → [INSTALLATION.md](INSTALLATION.md)

### What's new

- Improved website asset extraction for CSS backgrounds, Next.js fonts, and browser-session fallbacks.
- Filtered YouTube player API scripts from extracted video cards and bulk MP4 downloads.
- Updated release links to point directly to the latest v2.0 git package.

---

## v1.0

**macOS download (Apple Silicon):** [Creative-Asset-Extractor-1.0.0-arm64.dmg](https://github.com/frontendtech01-star/creative-asset-extractor/releases/download/v1.0.0/Creative-Asset-Extractor-1.0.0-arm64.dmg)

- Rebuilt Video Downloader with reference-style yt-dlp downloads for YouTube, Vimeo, Instagram, Facebook, and X.com.
- FHD and HD download buttons stay enabled after metadata lookup; merge runs only when you click download.
- Downloaded videos save to `~/Downloads/{platform}_CreativeAssets/Videos/`.
- Copy FHD/HD File Path is available after a download completes.
- Fixed website preview loading the app inside itself for video platform URLs.
- Added responsible-use notice, Installation Guide, and About access from the main screen.

**Full Changelog:** https://github.com/frontendtech01-star/creative-asset-extractor/compare/v1.0.0...v1.0

## Responsible Use

This application is intended for personal and lawful use only.

Users are responsible for complying with:

- copyright laws
- platform terms of service
- local regulations

Do not use this application to download, reproduce, or distribute copyrighted or protected content without proper permission.

This software does not bypass DRM or protected streaming technologies. DRM-protected platforms such as Netflix, Prime Video, Disney+, and Hotstar are unsupported.

User media is not uploaded to external servers by this app. Extraction and conversion happen locally on your machine when possible.
