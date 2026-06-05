import { createRequire } from 'node:module';

export type RasterOutputFormat = 'png' | 'jpg';
export type RasterSourceFormat = 'webp' | 'avif' | 'svg';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any = null;

/** Match VDX-main: dynamic sharp load for Node/Electron. */
export const loadSharp = async () => {
  if (sharpModule) return sharpModule;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default || mod;
    return sharpModule;
  } catch {
    try {
      sharpModule = require('sharp');
      return sharpModule.default || sharpModule;
    } catch {
      throw new Error('Image conversion backend is unavailable. Install sharp to enable WEBP/AVIF conversion.');
    }
  }
};

export const isValidRasterOutputBuffer = (buffer: Buffer, format: RasterOutputFormat) => {
  if (!buffer || buffer.length < 12) return false;
  if (format === 'png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  return buffer[0] === 0xff && buffer[1] === 0xd8;
};

export const detectRasterFormatFromBuffer = (buffer: Buffer) => {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer.slice(0, 8).toString('ascii') === '\x89PNG\r\n\x1a\n') return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
  }
  return '';
};

export const supportedRasterConversionTargets = (sourceFormat: string): RasterOutputFormat[] => {
  const normalized = String(sourceFormat || '').toLowerCase().replace('jpeg', 'jpg');
  if (normalized === 'webp' || normalized === 'avif' || normalized === 'svg') return ['png', 'jpg'];
  return [];
};

const looksLikeSvg = (buffer: Buffer) => {
  const head = buffer.slice(0, 512).toString('utf8').trimStart();
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg');
};

const numericSvgLength = (value: string) => {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const prepareSvgForSharp = (buffer: Buffer) => {
  if (!looksLikeSvg(buffer)) return buffer;

  let svg = buffer.toString('utf8').trim();
  if (/<font\b/i.test(svg) && !/(<path\b|<rect\b|<circle\b|<ellipse\b|<line\b|<polyline\b|<polygon\b|<image\b|<text\b)/i.test(svg)) {
    throw new Error('SVG font files cannot be rasterized as images. Download the original SVG instead.');
  }

  const tagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!tagMatch) return buffer;

  let tag = tagMatch[0];
  if (!/\sxmlns=/.test(tag)) {
    tag = tag.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const width = numericSvgLength(tag.match(/\swidth=["']([^"']+)["']/i)?.[1] || '');
  const height = numericSvgLength(tag.match(/\sheight=["']([^"']+)["']/i)?.[1] || '');
  const viewBoxMatch = tag.match(/\sviewBox=["']([^"']+)["']/i);
  const viewBoxParts = (viewBoxMatch?.[1] || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((part) => Number.isFinite(part));
  const viewBoxWidth = viewBoxParts.length === 4 && viewBoxParts[2] > 0 ? viewBoxParts[2] : 0;
  const viewBoxHeight = viewBoxParts.length === 4 && viewBoxParts[3] > 0 ? viewBoxParts[3] : 0;
  const finalWidth = Math.ceil(width || viewBoxWidth || 1024);
  const finalHeight = Math.ceil(height || viewBoxHeight || 1024);

  if (!width) tag = tag.replace(/<svg\b/i, `<svg width="${finalWidth}"`);
  if (!height) tag = tag.replace(/<svg\b/i, `<svg height="${finalHeight}"`);
  if (!viewBoxMatch) tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${finalWidth} ${finalHeight}"`);

  svg = svg.replace(tagMatch[0], tag);
  return Buffer.from(svg, 'utf8');
};

/** Decode WEBP/AVIF and re-encode — same approach as VDX-main convertImageBuffer. */
export const convertRasterImageBuffer = async (
  input: Buffer,
  targetFormat: RasterOutputFormat
) => {
  if (!input?.length) throw new Error('Empty image buffer');

  const sharp = await loadSharp();
  const preparedInput = prepareSvgForSharp(input);
  const image = sharp(preparedInput, { failOn: 'error', unlimited: true, density: 144 }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image buffer for conversion');
  }

  const output =
    targetFormat === 'jpg'
      ? await image.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : await image.png({ compressionLevel: 9 }).toBuffer();

  if (!isValidRasterOutputBuffer(output, targetFormat)) {
    throw new Error(`${targetFormat.toUpperCase()} conversion produced invalid output`);
  }

  const detected = detectRasterFormatFromBuffer(output);
  if (detected === 'webp' || detected === 'avif') {
    throw new Error(`Conversion returned ${detected} bytes instead of ${targetFormat}`);
  }

  return output;
};
