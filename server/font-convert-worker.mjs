import { parentPort, workerData } from 'node:worker_threads';
import { Font, woff2 } from 'fonteditor-core';
import opentype from 'opentype.js';

const bufferToExactArrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const fontOutputToBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value || ''), 'utf8');
};

const detectFontFormatFromBuffer = (buffer) => {
  if (!buffer || buffer.length < 4) return '';
  const sig = buffer.slice(0, 4).toString('latin1');
  if (sig === 'wOF2') return 'woff2';
  if (sig === 'wOFF') return 'woff';
  if (sig === 'OTTO') return 'otf';
  if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0) return 'ttf';
  return '';
};

let woff2Ready = false;
const ensureWoff2Ready = async () => {
  if (woff2Ready) return;
  await woff2.init();
  woff2Ready = true;
};

const getInnerFontBuffer = async (buffer, readFormat) => {
  if (readFormat === 'woff2') {
    await ensureWoff2Ready();
    const inner = fontOutputToBuffer(woff2.decode(bufferToExactArrayBuffer(buffer)));
    const innerFormat = inner.slice(0, 4).toString('latin1') === 'OTTO' ? 'otf' : 'ttf';
    return { buffer: inner, format: innerFormat };
  }
  if (readFormat === 'woff') {
    try {
      const font = Font.create(buffer, { type: 'woff' });
      const inner = fontOutputToBuffer(font.write({ type: 'ttf' }));
      const innerFormat = inner.slice(0, 4).toString('latin1') === 'OTTO' ? 'otf' : 'ttf';
      return { buffer: inner, format: innerFormat };
    } catch {
      const parsed = opentype.parse(bufferToExactArrayBuffer(buffer));
      const out = Buffer.from(parsed.toArrayBuffer());
      const outFormat = out.slice(0, 4).toString('latin1') === 'OTTO' ? 'otf' : 'ttf';
      return { buffer: out, format: outFormat };
    }
  }
  if (readFormat === 'ttf' || readFormat === 'otf') {
    return { buffer, format: readFormat };
  }
  return { buffer, format: readFormat };
};

const writeFontBuffer = async (innerBuffer, innerFormat, toFormat) => {
  if (toFormat === innerFormat) return innerBuffer;
  if (toFormat === 'woff2' && (innerFormat === 'ttf' || innerFormat === 'otf')) {
    await ensureWoff2Ready();
    return fontOutputToBuffer(woff2.encode(bufferToExactArrayBuffer(innerBuffer)));
  }
  if (toFormat === 'woff' && (innerFormat === 'ttf' || innerFormat === 'otf')) {
    const font = Font.create(innerBuffer, { type: innerFormat });
    return fontOutputToBuffer(font.write({ type: 'woff' }));
  }
  const font = Font.create(innerBuffer, { type: innerFormat });
  return fontOutputToBuffer(font.write({ type: toFormat }));
};

const convertFontBuffer = async (buffer, fromFormat, toFormat) => {
  const detected = detectFontFormatFromBuffer(buffer);
  const readFormat = detected || String(fromFormat || '').toLowerCase();
  if (readFormat === toFormat) return buffer;
  const { buffer: innerBuffer, format: innerFormat } = await getInnerFontBuffer(buffer, readFormat);
  return writeFontBuffer(innerBuffer, innerFormat, toFormat);
};

const run = async () => {
  const input = workerData || {};
  const buffer = Buffer.from(String(input.bufferBase64 || ''), 'base64');
  const fromFormat = String(input.fromFormat || 'unknown');
  const toFormat = String(input.toFormat || 'ttf');
  if (!buffer.length) throw new Error('Font buffer was empty');
  const output = await convertFontBuffer(buffer, fromFormat, toFormat);
  parentPort?.postMessage({ ok: true, bufferBase64: output.toString('base64') });
};

run().catch((error) => {
  parentPort?.postMessage({ ok: false, error: String(error?.message || error || 'Font conversion failed') });
});
