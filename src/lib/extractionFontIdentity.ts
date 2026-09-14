import { buildFontDisplayName, getFontFilenameBase, getFontLogicalKey, getFontSelectionKey, resolveFontIdentityFields, scoreFontRecord } from './fontAsset';

/** Resolve identity before merging formats, retaining weight/style instances. */
export function mergeExtractionFonts(fonts: any[]) {
  const byFace = new Map<string, any>();
  for (const original of fonts) {
    if (!original?.url) continue;
    const { assetName: _assetName, ...record } = original;
    const font = { ...record, ...resolveFontIdentityFields(record) };
    const key = getFontLogicalKey(font) || getFontSelectionKey(font);
    const previous = byFace.get(key);
    if (!previous || scoreFontRecord(font) > scoreFontRecord(previous)) {
      byFace.set(key, { ...font, alternativeSources: [...(previous?.alternativeSources || []), ...(previous ? [previous.url] : [])] });
    } else {
      previous.alternativeSources = [...new Set([...(previous.alternativeSources || []), font.url])].filter(url => url !== previous.url);
    }
  }
  const results = [...byFace.values()];
  const groups = new Map<string, any[]>();
  for (const font of results) {
    const label = buildFontDisplayName(font) || getFontFilenameBase(font);
    groups.set(label.toLowerCase(), [...(groups.get(label.toLowerCase()) || []), font]);
  }
  const used = new Set(groups.keys());
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let number = 1;
    for (const font of group.sort((a,b) => String(a.url).localeCompare(String(b.url)))) {
      const label = buildFontDisplayName(font) || getFontFilenameBase(font);
      let name: string;
      do { name = `${label} ${String(number++).padStart(3, '0')}`; } while (used.has(name.toLowerCase()));
      used.add(name.toLowerCase());
      font.assetName = name;
    }
  }
  return results;
}
