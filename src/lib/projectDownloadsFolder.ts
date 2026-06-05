export {
  buildCreativeAssetsFolderName,
  creativeAssetsFolderLabel,
  extractSiteKeyFromUrl,
} from './creativeAssetsFolder';

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
