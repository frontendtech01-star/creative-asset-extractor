const { execFileSync } = require('node:child_process');

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;
  const appPath = context?.appOutDir && context?.packager?.appInfo?.productFilename
    ? `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
    : '';
  if (!appPath) return;

  try {
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
