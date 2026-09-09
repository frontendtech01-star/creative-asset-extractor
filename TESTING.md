# Testing

For individual bug fixes, run only the relevant targeted regression. Browser tests must run sequentially.

- Kesimpta dosing images and video: `npm run smoke:kesimpta` (requires the local server).
- Fast static suite, when requested: `npm run smoke`.
- Full source suite: `npm run smoke:all:source`.
- Full packaged suite: `npm run smoke:all:packaged`.

For releases, run the full source suite, then `npm run dmg`, then the full packaged suite against the generated app before publishing.
