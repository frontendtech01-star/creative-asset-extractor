#!/bin/zsh
set -e
cd "${0:A:h}"

LOCAL_NODE_DIR="$PWD/.runtime/node"
if [[ -x "$LOCAL_NODE_DIR/bin/node" ]]; then
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Installing a private runtime in this folder (no password required)..."
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.tab | awk -F '\t' 'NR > 1 && $10 != "-" { print $1; exit }')"
  case "$(uname -m)" in
    arm64) NODE_ARCH="arm64" ;;
    x86_64) NODE_ARCH="x64" ;;
    *) NODE_ARCH="" ;;
  esac
  NODE_ARCHIVE="${TMPDIR:-/tmp}/node-lts-${NODE_ARCH}.tar.gz"
  NODE_EXTRACT_DIR="$PWD/.runtime/node-${NODE_VERSION}-darwin-${NODE_ARCH}"
  if [[ -z "$NODE_VERSION" || -z "$NODE_ARCH" ]] || ! curl -fL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz" -o "$NODE_ARCHIVE"; then
    open "https://nodejs.org/en/download"
    echo "Automatic Node.js download failed. Check the internet connection, then run this launcher again."
    read "?Press Return to close..."
    exit 1
  fi
  rm -rf "$LOCAL_NODE_DIR" "$NODE_EXTRACT_DIR"
  mkdir -p "$PWD/.runtime"
  if ! tar -xzf "$NODE_ARCHIVE" -C "$PWD/.runtime"; then
    echo "Could not unpack the private Node.js runtime. Run this launcher again."
    read "?Press Return to close..."
    exit 1
  fi
  mv "$NODE_EXTRACT_DIR" "$LOCAL_NODE_DIR"
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  rm -f "$NODE_ARCHIVE"
fi

echo "Closing older Creative Asset Extractor server sessions..."
pkill -f 'node .*scripts/dev\.mjs' 2>/dev/null || true
pkill -f 'tsx.*server\.ts' 2>/dev/null || true
pkill -f 'node .*scripts/start-localhost\.mjs' 2>/dev/null || true

echo "Cleaning old caches and temporary files..."
rm -rf node_modules package-lock.json .vite .cache
rm -rf "$HOME/.cache/puppeteer"
rm -rf "$HOME/Library/Caches/puppeteer"
rm -rf "$HOME/Library/Caches/Creative Asset Extractor"
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'creative-asset-extractor-*' -exec rm -rf {} + 2>/dev/null || true
npm cache clean --force >/dev/null 2>&1 || true

echo "Installing a clean runtime without bundled Chromium..."
PUPPETEER_SKIP_DOWNLOAD=true npm install

echo "Starting Creative Asset Extractor on localhost..."
PUPPETEER_SKIP_DOWNLOAD=true npm run localhost
