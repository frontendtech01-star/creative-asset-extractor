import { getImageDedupeKey, getImageDisplayName } from './imageAsset';

export const imageResolution = (image: any) => {
  let width = Number(image.width) || 0, height = Number(image.height) || 0;
  try {
    const url = new URL(image.url || image.src);
    width = Math.max(width, ...['width', 'w', 'wid'].map(key => Number(url.searchParams.get(key)) || 0));
    height = Math.max(height, ...['height', 'h', 'hei'].map(key => Number(url.searchParams.get(key)) || 0));
    const size = url.pathname.match(/[_-](\d+)x(\d+)(?=\.[^.]+$)/i);
    if (size) { width = Math.max(width, Number(size[1])); height = Math.max(height, Number(size[2])); }
  } catch { /* Dimensions remain authoritative for embedded images. */ }
  return width && height ? width * height : Math.max(width, height) ** 2;
};

export const compareImageQuality = (a: any, b: any) =>
  imageResolution(b) - imageResolution(a) ||
  Number(b.bytes || b.size || 0) - Number(a.bytes || a.size || 0) ||
  Number(Boolean(b.cachedUrl)) - Number(Boolean(a.cachedUrl));

/** Keep real asset identities separate; filenames alone never prove equality. */
export function mergeExtractionImages(images: any[]) {
  const byIdentity = new Map<string, any>();
  for (const item of images) {
    if (!(item?.url || item?.src)) continue;
    const key = getImageDedupeKey(item);
    const previous = byIdentity.get(key);
    if (!previous || compareImageQuality(item, previous) < 0) byIdentity.set(key, item);
  }
  const byContent = new Map<string, any>();
  for (const item of byIdentity.values()) {
    // Rotation frames retain their place even when two endpoint views match.
    const frame = Number(item.sequenceFrame || 0);
    const key = item.contentHash && !frame ? `content:${item.contentHash}` : getImageDedupeKey(item);
    const previous = byContent.get(key);
    if (!previous || compareImageQuality(item, previous) < 0) byContent.set(key, item);
  }
  const groups = new Map<string, any[]>();
  const result = [...byContent.values()].map(({ assetName: _assetName, ...item }) => item);
  for (const item of result) {
    const name = getImageDisplayName(item).trim();
    const key = name.toLowerCase();
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const used = new Set(groups.keys());
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.url).localeCompare(String(b.url)));
    let number = 1;
    for (const item of group) {
      const name = getImageDisplayName(item);
      const extension = name.match(/\.[a-z0-9]+$/i)?.[0] || '';
      const stem = extension ? name.slice(0, -extension.length) : name;
      let candidate: string;
      do { candidate = `${stem}-${String(number++).padStart(3, '0')}${extension}`; } while (used.has(candidate.toLowerCase()));
      used.add(candidate.toLowerCase());
      item.assetName = candidate;
    }
  }
  return result;
}
