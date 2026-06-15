import { loadSharp } from './convertRasterImage';
import { MAX_SHEET_SCREENSHOT_BYTES, MAX_SHEET_SCREENSHOT_PIXELS } from './feedbackScreenshotLimits';

export type SheetScreenshotAttachment = {
  screenshotBase64: string;
  screenshotMimeType: string;
  screenshotFilename: string;
};

export const compressScreenshotBufferForSheet = async (
  buffer: Buffer
): Promise<SheetScreenshotAttachment> => {
  const sharp = await loadSharp();
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  let width = meta.width || 0;
  let height = meta.height || 0;

  let pipeline = sharp(buffer, { failOn: 'none' });
  if (width > 0 && height > 0 && width * height > MAX_SHEET_SCREENSHOT_PIXELS) {
    const scale = Math.sqrt(MAX_SHEET_SCREENSHOT_PIXELS / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    pipeline = sharp(buffer, { failOn: 'none' }).resize(width, height, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  let quality = 82;
  let output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();

  while (output.length > MAX_SHEET_SCREENSHOT_BYTES && quality > 44) {
    quality -= 8;
    output = await sharp(output).jpeg({ quality, mozjpeg: true }).toBuffer();
  }

  if (output.length > MAX_SHEET_SCREENSHOT_BYTES) {
    output = await sharp(buffer, { failOn: 'none' })
      .resize(960, 960, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 68, mozjpeg: true })
      .toBuffer();
  }

  return {
    screenshotBase64: output.toString('base64'),
    screenshotMimeType: 'image/jpeg',
    screenshotFilename: 'feedback-screenshot.jpg',
  };
};

export const compressScreenshotDataUrlForSheet = async (
  dataUrl: string
): Promise<SheetScreenshotAttachment | null> => {
  const match = String(dataUrl || '').trim().match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match?.[2]) return null;
  return compressScreenshotBufferForSheet(Buffer.from(match[2], 'base64'));
};
