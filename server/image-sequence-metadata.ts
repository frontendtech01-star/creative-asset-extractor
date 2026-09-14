/** A new frame must fetch its own bytes, never reuse the seed's preview. */
export function imageSequenceSeedMetadata(seed: any) {
  const { cachedUrl, dataUrl, thumbnailUrl, previewUrl, lqip, width, height, size, ...metadata } = seed;
  return metadata;
}
