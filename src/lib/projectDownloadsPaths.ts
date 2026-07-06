import path from 'path';
import os from 'os';
import fsp from 'fs/promises';
import { buildCreativeAssetsFolderName, buildPlatformCreativeAssetsFolderName } from './creativeAssetsFolder';

export const CREATIVE_ASSET_SUBFOLDERS = [
  'Images',
  'Fonts',
  'Colors',
  'Videos',
] as const;

export const VIDEO_ASSET_SUBFOLDER = 'Videos';
const LEGACY_CREATIVE_ASSET_SUBFOLDERS = [
  'Icons',
  'Screenshots',
  'SelectedAreas',
  'SmokeTest',
] as const;
const LEGACY_IMAGE_SUBFOLDERS = ['Originals', 'Thumbnails'] as const;
const DISPOSABLE_FOLDER_ENTRIES = new Set(['.DS_Store']);

export type CreativeAssetSubfolder = (typeof CREATIVE_ASSET_SUBFOLDERS)[number];

export type CreativeAssetsPathOptions = {
  sectionMode?: boolean;
};

export const resolveDownloadsRoot = () =>
  String(process.env.CAE_DOWNLOADS_DIR || '').trim() ||
  path.join(os.homedir(), 'Downloads');

export const resolveCreativeAssetsRoot = (sourcePageUrl?: string, options: CreativeAssetsPathOptions = {}) => {
  const folderName = buildCreativeAssetsFolderName(String(sourcePageUrl || '').trim());
  return path.join(resolveDownloadsRoot(), folderName);
};

export const resolveCreativeAssetsDir = (
  sourcePageUrl?: string,
  subfolder?: CreativeAssetSubfolder,
  options: CreativeAssetsPathOptions = {}
) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl, options);
  return subfolder ? path.join(root, subfolder) : root;
};

export const resolvePlatformVideoAssetsDir = (platform: string) => {
  const root = path.join(resolveDownloadsRoot(), buildPlatformCreativeAssetsFolderName(platform));
  return path.join(root, VIDEO_ASSET_SUBFOLDER);
};

export const ensurePlatformVideoFolderOnly = async (platform: string) => {
  await fsp.mkdir(resolvePlatformVideoAssetsDir(platform), { recursive: true });
};

const removeDirectoryWhenEmpty = async (directory: string) => {
  const entries = await fsp.readdir(directory).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (DISPOSABLE_FOLDER_ENTRIES.has(entry)) {
      await fsp.unlink(path.join(directory, entry)).catch(() => undefined);
    }
  }
  await fsp.rmdir(directory).catch(() => undefined);
};

export const removeEmptyCreativeAssetFolders = async (sourcePageUrl?: string) => {
  const root = resolveCreativeAssetsRoot(sourcePageUrl);
  const imagesDir = path.join(root, 'Images');
  for (const subfolder of LEGACY_IMAGE_SUBFOLDERS) {
    await removeDirectoryWhenEmpty(path.join(imagesDir, subfolder));
  }
  for (const subfolder of LEGACY_CREATIVE_ASSET_SUBFOLDERS) {
    await removeDirectoryWhenEmpty(path.join(root, subfolder));
  }
  for (const subfolder of CREATIVE_ASSET_SUBFOLDERS) {
    await removeDirectoryWhenEmpty(path.join(root, subfolder));
  }
  await removeDirectoryWhenEmpty(root);
};
