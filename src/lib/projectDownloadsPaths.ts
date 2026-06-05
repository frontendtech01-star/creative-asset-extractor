import path from 'path';
import os from 'os';
import fsp from 'fs/promises';
import { buildCreativeAssetsFolderName } from './creativeAssetsFolder';

export const CREATIVE_ASSET_SUBFOLDERS = [
  'Videos',
  'Audio',
  'Images',
  'Fonts',
  'ISI',
  'Brief',
  'SmokeTest',
  'Logs',
] as const;

export type CreativeAssetSubfolder = (typeof CREATIVE_ASSET_SUBFOLDERS)[number];

export const resolveCreativeAssetsRoot = (sourcePageUrl?: string) => {
  const folderName = buildCreativeAssetsFolderName(String(sourcePageUrl || '').trim());
  return path.join(os.homedir(), 'Downloads', folderName);
};

export const resolveCreativeAssetsDir = (
  sourcePageUrl?: string,
  subfolder?: CreativeAssetSubfolder
) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl);
  return subfolder ? path.join(root, subfolder) : root;
};

export const ensureCreativeAssetsFolders = async (sourcePageUrl?: string) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl);
  await fsp.mkdir(root, { recursive: true });
  await Promise.all(
    CREATIVE_ASSET_SUBFOLDERS.map((sub) =>
      fsp.mkdir(resolveCreativeAssetsDir(sourcePageUrl, sub), { recursive: true })
    )
  );
};
