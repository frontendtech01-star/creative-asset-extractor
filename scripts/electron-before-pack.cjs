const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['en.lproj', 'en_GB.lproj']);
const CHROMIUM_LIBRARY_STRIP = new Set([
  'WidevineCdm',
  'PrivacySandboxAttestationsPreloaded',
  'IwaKeyDistribution',
]);

const pruneBundledChromiumTree = (rootDir) => {
  if (!fs.existsSync(rootDir)) return;

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.lproj') && !KEEP_LOCALES.has(entry.name)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        continue;
      }
      if (entry.name === 'Libraries') {
        for (const libEntry of fs.readdirSync(fullPath, { withFileTypes: true })) {
          if (!libEntry.isDirectory()) continue;
          if (CHROMIUM_LIBRARY_STRIP.has(libEntry.name)) {
            fs.rmSync(path.join(fullPath, libEntry.name), { recursive: true, force: true });
          }
        }
      }
      walk(fullPath);
    }
  };

  walk(rootDir);
  const frameworkResources = path.join(
    rootDir,
    'Contents',
    'Frameworks',
    'Google Chrome for Testing Framework.framework',
    'Versions'
  );
  if (fs.existsSync(frameworkResources)) {
    for (const versionDir of fs.readdirSync(frameworkResources)) {
      const resourcesDir = path.join(frameworkResources, versionDir, 'Resources');
      const shaderCache = path.join(resourcesDir, 'gpu_shader_cache.bin');
      if (fs.existsSync(shaderCache)) fs.rmSync(shaderCache, { force: true });
    }
  }
};

const resolvePackArch = (context) => {
  const raw = String(process.env.DESKTOP_PACK_ARCH || process.env.DMG_PACK_ARCH || '').trim().toLowerCase();
  if (raw === 'universal' || raw === 'arm64' || raw === 'x64') return raw;
  if (context?.arch === 1 || context?.arch === 'x64') return 'x64';
  if (context?.arch === 3 || context?.arch === 'arm64') return 'arm64';
  return process.arch === 'arm64' ? 'arm64' : 'x64';
};

const chromiumPrefixForPack = (platformName, packArch) => {
  if (platformName === 'darwin' || platformName === 'mac') {
    if (packArch === 'universal') return ['mac_arm-', 'mac-'];
    return packArch === 'arm64' ? ['mac_arm-'] : ['mac-'];
  }
  if (platformName === 'win32' || platformName === 'windows' || platformName === 'win') {
    return ['win64-'];
  }
  if (platformName === 'linux') {
    return ['linux-'];
  }
  return [];
};

const shouldIncludeChromiumVersionDir = (versionDir, prefixes) => (
  prefixes.some((prefix) => {
    if (prefix === 'mac-') return versionDir.startsWith('mac-') && !versionDir.startsWith('mac_arm-');
    return versionDir.startsWith(prefix);
  })
);

module.exports = async function beforePack(context = {}) {
  const projectRoot = path.join(__dirname, '..');
  const sourceRoot = path.join(projectRoot, 'vendor', 'chromium', 'chrome');
  const packRoot = path.join(projectRoot, 'vendor', 'chromium-pack');
  const packChromeDir = path.join(packRoot, 'chrome');
  const packArch = resolvePackArch(context);
  const packPlatform = String(context.electronPlatformName || process.platform || '').toLowerCase();
  const chromiumPrefixes = chromiumPrefixForPack(packPlatform, packArch);

  fs.rmSync(packRoot, { recursive: true, force: true });
  fs.mkdirSync(packChromeDir, { recursive: true });

  if (!fs.existsSync(sourceRoot)) return;

  const entries = fs.readdirSync(sourceRoot);
  const versionDirs = entries.filter((name) => shouldIncludeChromiumVersionDir(name, chromiumPrefixes));

  for (const versionDir of versionDirs) {
    const src = path.join(sourceRoot, versionDir);
    const dest = path.join(packChromeDir, versionDir);
    // Preserve Chromium's framework symlinks. Dereferencing them turns the
    // framework root into a second physical bundle and makes codesign report
    // "bundle format is ambiguous" on another Mac.
    fs.cpSync(src, dest, { recursive: true, dereference: false, verbatimSymlinks: true });
    if (packPlatform === 'darwin' || packPlatform === 'mac') {
      const bundleFolder = versionDir.startsWith('mac_arm-') ? 'chrome-mac-arm64' : 'chrome-mac-x64';
      const chromeApp = path.join(dest, bundleFolder, 'Google Chrome for Testing.app');
      pruneBundledChromiumTree(chromeApp);
    }
  }
};
