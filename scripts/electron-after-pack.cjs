const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sign = (target) => execFileSync('codesign', [
  '--force',
  '--sign',
  '-',
  target,
], { stdio: 'inherit' });

const signBundledChromium = (appPath) => {
  const chromeRoot = path.join(appPath, 'Contents', 'Resources', 'chromium', 'chrome');
  if (!fs.existsSync(chromeRoot)) return;

  for (const versionName of fs.readdirSync(chromeRoot)) {
    const versionRoot = path.join(chromeRoot, versionName);
    for (const bundleName of fs.readdirSync(versionRoot)) {
      const chromeApp = path.join(versionRoot, bundleName, 'Google Chrome for Testing.app');
      if (!fs.existsSync(chromeApp)) continue;

      const versionsRoot = path.join(
        chromeApp,
        'Contents',
        'Frameworks',
        'Google Chrome for Testing Framework.framework',
        'Versions'
      );
      const concreteVersions = fs.readdirSync(versionsRoot).filter((name) => name !== 'Current');
      for (const frameworkVersion of concreteVersions) {
        const frameworkRoot = path.join(versionsRoot, frameworkVersion);
        const helpersRoot = path.join(frameworkRoot, 'Helpers');
        if (fs.existsSync(helpersRoot)) {
          for (const helperName of fs.readdirSync(helpersRoot)) {
            if (helperName.endsWith('.app')) sign(path.join(helpersRoot, helperName));
          }
        }
        // Sign the concrete framework version, not the symlinked framework
        // root. This is the layout codesign expects for Chromium.
        sign(frameworkRoot);
      }
      sign(chromeApp);
      execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', chromeApp], {
        stdio: 'inherit',
      });
    }
  }
};

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;
  const appPath = context?.appOutDir && context?.packager?.appInfo?.productFilename
    ? `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
    : '';
  if (!appPath) return;

  try {
    signBundledChromium(appPath);
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      appPath,
    ], { stdio: 'inherit' });
  } catch (error) {
    throw new Error(`Ad-hoc codesign failed for ${appPath}: ${error.message || error}`);
  }
};
