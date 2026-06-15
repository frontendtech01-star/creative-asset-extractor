import { loadSharp } from './convertRasterImage';

const THUMB_MAX_EDGE = 320;
const THUMB_TARGET_BYTES = 50 * 1024;
const LQIP_MAX_EDGE = 24;

export type ImageThumbArtifacts = {
  thumbBuffer: Buffer;
  lqip: string;
  width: number;
  height: number;
};

export const generateImageThumbArtifacts = async (input: Buffer): Promise<ImageThumbArtifacts> => {
  if (!input?.length) throw new Error('Empty image buffer');

  const sharp = await loadSharp();
  const base = sharp(input, { failOn: 'none', unlimited: true, density: 144 }).rotate();
  const metadata = await base.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image dimensions');
  }

  const lqipBuffer = await base
    .clone()
    .resize(LQIP_MAX_EDGE, LQIP_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 35, effort: 2 })
    .toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuffer.toString('base64')}`;

  let quality = 74;
  let thumbBuffer = await base
    .clone()
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

  while (thumbBuffer.length > THUMB_TARGET_BYTES && quality > 36) {
    quality -= 6;
    thumbBuffer = await base
      .clone()
      .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer();
  }

  const thumbMeta = await sharp(thumbBuffer).metadata();
  return {
    thumbBuffer,
    lqip,
    width: thumbMeta.width || metadata.width,
    height: thumbMeta.height || metadata.height,
  };
};
