# Creative Asset Extractor defaults

These are product-wide requirements for every supported website extraction:

- Return every discoverable image and icon without collapsing different source paths that share a filename.
- Return every downloadable font file and font variant. Font conversion controls are enabled by default.
- Return every discoverable video. Video preview and downloading must be available through Image/Video Downloader.
- Rank extracted colors and display the 10 primary colors by default.
- Website assets must come from the app's automated Chromium crawler only. Reader, static-HTML, and active-user-Chrome results must not be merged into the default extraction.
- Protected pages must return assets already captured by automated Chromium and must not reuse assets from a previous extraction.
- Smoke tests must validate the final user-visible asset set, not only an intermediate backend payload.
