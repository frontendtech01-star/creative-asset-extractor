/** Stable folder per sequence keeps identical frame numbers from colliding. */
export function imageSequenceFolder(groupKey: string, label: string) {
  let hash = 2166136261;
  for (const char of groupKey) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const name = label.replace(/[^a-z0-9 -]/gi, '').trim().replace(/\s+/g, '-').slice(0, 90) || 'sequence';
  return `${name}-${(hash >>> 0).toString(16)}`;
}
