#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

cd "$ROOT_DIR"

npm run build:all

echo "FTP sync complete."
echo "Hybrid deployment package is ready from this one canonical folder:"
echo "$ROOT_DIR"
echo ""
echo "1) Static FTP frontend:"
echo "$DIST_DIR"
echo "   Upload the contents of dist/ to FTP/shared hosting."
echo ""
echo "2) Backend API entry:"
echo "$ROOT_DIR/server.ts"
echo ""
echo "3) Runtime-only backend package template:"
echo "$ROOT_DIR/package.light.json"
echo ""
echo "If frontend and API are on different domains, set VITE_API_BASE_URL before building"
echo "or edit window.__CREATIVE_EXTRACTOR_CONFIG__.apiBaseUrl in dist/index.html."
