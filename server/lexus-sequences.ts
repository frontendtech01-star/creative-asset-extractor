import { load } from 'cheerio';

/** Discover variants only from the exterior viewer's own swatches and frames. */
export function discoverLexusSequences(html: string, pageUrl: string) {
  try {
    if (!/(^|\.)lexus\.com$/i.test(new URL(pageUrl).hostname)) return [];
  } catch { return []; }
  const $ = load(html);
  const result = new Map<string, any>();
  const visited = new Set<unknown>();
  $('img[src]').each((_index, image) => {
    const src = $(image).attr('src') || '';
    let seed: URL;
    try { seed = new URL(src, pageUrl); } catch { return; }
    if (seed.protocol !== 'https:' || seed.hostname !== 'tmna.assetscs.toyota.com') return;
    const match = seed.pathname.match(/^(.*\/visualizer[^/]*\/[^/]+\/exterior\/[^/]+\/)([^/]+)\/(large-)(\d+)\.(jpg|png|webp)$/i);
    if (!match) return;
    // The nearest common wrapper prevents mixing other models or interior swatches.
    const wrapper = $(image).parents().toArray().find((node) =>
      $(node).find('[role="radio"], input[type="radio"]').length > 0);
    if (!wrapper || visited.has(wrapper)) return;
    visited.add(wrapper);
    const root = $(wrapper);
    const colors = new Map<string, string>();
    root.find('[role="radio"], input[type="radio"]').each((_i, radio) => {
      const label = ($(radio).attr('aria-label') || $(radio).attr('data-color-name') || '').trim();
      if (!label || label.length > 60) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-');
      if (/^[a-z]+(?:-[a-z]+)*$/.test(slug)) colors.set(slug, label);
    });
    // Require the current color to be represented: no unrelated radio groups.
    if (!colors.has(match[2]) || colors.size > 24) return;
    const frames = new Map<number, URL>();
    root.find('img[src]').each((_i, img) => {
      try {
        const url = new URL($(img).attr('src')!, pageUrl);
        const frame = url.pathname.match(/\/large-(\d+)\.(?:jpg|png|webp)$/i);
        if (url.origin !== seed.origin || !url.pathname.startsWith(match[1] + match[2] + '/') || !frame) return;
        const n = Number(frame[1]);
        if (n >= 1 && n <= 120) frames.set(n, url);
      } catch { /* Ignore malformed image attributes. */ }
    });
    if (frames.size < 2) return;
    for (const [slug, color] of colors) {
      for (const [frame, observedUrl] of frames) {
        const url = new URL(observedUrl.href);
        url.pathname = url.pathname.replace(match[1] + match[2] + '/', match[1] + slug + '/');
        result.set(url.href, {
          url: url.href,
          filename: `${slug}-frame-${String(frame).padStart(3, '0')}.${match[5]}`,
          type: match[5],
          alt: `${color} 360 frame ${frame}`,
          source: '360-sequence-color-candidate',
          sequenceColor: color,
          sequenceFrame: frame,
          sequenceCount: Math.max(...frames.keys()),
        });
      }
    }
  });
  return [...result.values()].slice(0, 2880);
}

/** No guessed variant reaches the gallery until its individual URL is checked. */
export async function verifyLexusSequences(
  items: any[],
  available: (url: string) => Promise<boolean>,
) {
  const candidates = [...new Map(items.filter((item) => item.source === '360-sequence-color-candidate')
    .map((item) => [item.url, item])).values()];
  if (!candidates.length) return items;
  const verified = new Map<string, any>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      if (await available(item.url).catch(() => false)) {
        verified.set(item.url, { ...item, source: '360-sequence-verified', sequenceVerified: true });
      }
    }
  }));
  const output = new Map<string, any>();
  for (const item of items) {
    if (item.source === '360-sequence-color-candidate') continue;
    output.set(item.url, verified.get(item.url) || item);
  }
  for (const [url, item] of verified) output.set(url, item);
  return [...output.values()];
}
