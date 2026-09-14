import { createHash } from 'node:crypto';
import { getImageDisplayName } from '../src/lib/imageAsset';

/** Compare cached originals, never thumbnails or filenames, for content equality. */
export async function resolveDuplicateImageContent(images: any[], read: (image: any) => Promise<Buffer | null>) {
  const counts = new Map<string, number>();
  for (const image of images) {
    const name = getImageDisplayName({ ...image, assetName: undefined }).toLowerCase();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let cursor = 0;
  const output = [...images];
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, async () => {
    while (cursor < images.length) {
      const index = cursor++, image = images[index];
      if (image.sequenceFrame || counts.get(getImageDisplayName({ ...image, assetName: undefined }).toLowerCase()) < 2) continue;
      const buffer = await read(image).catch(() => null);
      if (buffer?.length) output[index] = { ...image, contentHash: createHash('sha256').update(buffer).digest('hex') };
    }
  }));
  return output;
}
