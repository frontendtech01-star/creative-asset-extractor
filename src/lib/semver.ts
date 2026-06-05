export const normalizeVersionTag = (tag: string) => String(tag || '').trim().replace(/^v/i, '');

export const parseVersionParts = (tag: string) =>
  normalizeVersionTag(tag)
    .split('.')
    .map((part) => {
      const match = part.match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });

export const isNewerVersion = (latestTag: string, currentTag: string) => {
  const latest = parseVersionParts(latestTag);
  const current = parseVersionParts(currentTag);
  const length = Math.max(latest.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (latest[index] || 0) - (current[index] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};
