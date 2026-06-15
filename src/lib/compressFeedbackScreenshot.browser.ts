import { MAX_SHEET_SCREENSHOT_PIXELS } from './feedbackScreenshotLimits';

const MAX_DATA_URL_CHARS = 2_100_000;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load screenshot.'));
    img.src = src;
  });

export const compressScreenshotDataUrlForSheet = async (dataUrl: string): Promise<string> => {
  const source = String(dataUrl || '').trim();
  if (!source.startsWith('data:image/')) return source;

  const img = await loadImage(source);
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;
  if (!width || !height) return source;

  const pixels = width * height;
  if (pixels > MAX_SHEET_SCREENSHOT_PIXELS) {
    const scale = Math.sqrt(MAX_SHEET_SCREENSHOT_PIXELS / pixels);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(img, 0, 0, width, height);

  let quality = 0.84;
  let compressed = canvas.toDataURL('image/jpeg', quality);
  while (compressed.length > MAX_DATA_URL_CHARS && quality > 0.46) {
    quality -= 0.08;
    compressed = canvas.toDataURL('image/jpeg', quality);
  }

  if (compressed.length > MAX_DATA_URL_CHARS) {
    canvas.width = Math.max(1, Math.floor(width * 0.72));
    canvas.height = Math.max(1, Math.floor(height * 0.72));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    compressed = canvas.toDataURL('image/jpeg', 0.68);
  }

  return compressed;
};
