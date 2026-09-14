import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSharp } from '../src/lib/convertRasterImage';

export const PANORAMA_FACES = ['right', 'left', 'top', 'bottom', 'front', 'back'] as const;
const MEDIA = 'https://tmna.assetscs.toyota.com/is/image/lexusaemcs';

export function discoverInteriorPanoramas(model: any, pageUrl: string) {
  const page = new URL(pageUrl);
  if (!/(^|\.)lexus\.com$/i.test(page.hostname)) return [];
  const trim = page.searchParams.get('trim') || '';
  const wanted = /^nxh|^hybrid/.test(trim) ? 'nxh' : /^nxp/.test(trim) ? 'nxphev' : /^nxf|^fsport/.test(trim) ? 'fsport' : trim ? 'nx' : '';
  const output: { label: string; urls: string[] }[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.id === 'model_visualizer_interior' && Array.isArray(value.visualizerTabs)) {
      const tab = value.visualizerTabs.find((t: any) => t.id === (wanted || (value.selectedTabId === 'hybrid' ? 'nxh' : value.selectedTabId)));
      if (!tab) return;
      for (const category of tab.visualizerInnerTabs || []) {
        if (category.type !== 'interior' || !category.panoAssetPathStructure) continue;
        for (const swatch of category.swatches || []) {
          for (const view of category.panoViews || []) {
            const template = String(category.panoAssetPathStructure)
              .replace('{{dynamicMediaURL}}', MEDIA).replace('{{activeInteriorSwatch}}', swatch.id).replace('{{pano}}', view.id);
            const urls = PANORAMA_FACES.map((face) => template.replace('{position}', face) + '?' + (category.panoDesktopImageProfile || 'wid=2000'));
            if (!urls.every((url) => { const p = new URL(url); return p.origin === new URL(MEDIA).origin && p.pathname.includes('/interior/') && !/[{}]/.test(url); })) continue;
            output.push({ label: `Interior ${swatch.label}${category.panoViews.length > 1 ? ` ${view.labelTitle}` : ''}`, urls });
          }
        }
      }
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(model);
  return output.slice(0, 16);
}

/** Standard cubemap direction -> face and normalized pixel coordinates. */
export function cubeSample(x: number, y: number, z: number) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face: number, u: number, v: number;
  if (ax >= ay && ax >= az) { face = x > 0 ? 0 : 1; u = (x > 0 ? -z : z) / ax; v = -y / ax; }
  else if (ay >= az) { face = y > 0 ? 2 : 3; u = x / ay; v = (y > 0 ? z : -z) / ay; }
  else { face = z > 0 ? 4 : 5; u = (z > 0 ? x : -x) / az; v = -y / az; }
  return { face, u: (u + 1) / 2, v: (v + 1) / 2 };
}

export async function renderInteriorPanorama(buffers: Buffer[], write: (frame: number, jpeg: Buffer) => Promise<void>, width = 960, height = 420) {
  if (buffers.length !== 6) throw new Error('Interior panorama requires all six faces');
  const sharp = await loadSharp();
  const faces = await Promise.all(buffers.map(async (buffer) => {
    const result = await sharp(buffer).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    if (result.info.width !== result.info.height || result.info.channels !== 3) throw new Error('Invalid panorama face');
    return result;
  }));
  const tangent = Math.tan(80 * Math.PI / 360);
  for (let frame = 1; frame <= 36; frame++) {
    const yaw = (frame - 1) * Math.PI / 18, sin = Math.sin(yaw), cos = Math.cos(yaw);
    const output = Buffer.alloc(width * height * 3);
    for (let row = 0; row < height; row++) {
      const y = (1 - 2 * (row + .5) / height) * tangent * height / width;
      for (let col = 0; col < width; col++) {
        const x = (2 * (col + .5) / width - 1) * tangent;
        const sample = cubeSample(x * cos + sin, y, cos - x * sin);
        const { data, info } = faces[sample.face];
        const px = Math.max(0, Math.min(info.width - 1, sample.u * info.width - .5));
        const py = Math.max(0, Math.min(info.height - 1, sample.v * info.height - .5));
        const left = Math.floor(px), top = Math.floor(py), right = Math.min(left + 1, info.width - 1), bottom = Math.min(top + 1, info.height - 1);
        const dx = px - left, dy = py - top, dest = (row * width + col) * 3;
        for (let c = 0; c < 3; c++) output[dest + c] = Math.round(
          (data[(top * info.width + left) * 3 + c] * (1 - dx) + data[(top * info.width + right) * 3 + c] * dx) * (1 - dy) +
          (data[(bottom * info.width + left) * 3 + c] * (1 - dx) + data[(bottom * info.width + right) * 3 + c] * dx) * dy);
      }
    }
    await write(frame, await sharp(output, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer());
  }
}

const pending = new Map<string, Promise<any[]>>();
export async function extractLexusInterior(pageUrl: string, cacheDir: string, appOrigin: string) {
  const page = new URL(pageUrl);
  if (!/(^|\.)lexus\.com$/i.test(page.hostname) || !/^\/models\//.test(page.pathname)) return [];
  const key = page.href;
  if (pending.has(key)) return pending.get(key)!;
  const task = (async () => {
    const modelUrl = new URL(page.pathname.replace(/\/$/, '') + '.model.json', page.origin);
    const response = await fetch(modelUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Interior model HTTP ${response.status}`);
    const panoramas = discoverInteriorPanoramas(await response.json(), page.href);
    const images: any[] = [];
    for (const panorama of panoramas) {
      const id = createHash('sha256').update('cubemap-v1:' + panorama.urls.join('|')).digest('hex').slice(0, 24);
      const folder = `interior-360/${id}`;
      const directory = path.join(cacheDir, folder);
      const ready = await fs.access(path.join(directory, 'complete')).then(() => true, () => false);
      if (!ready) {
        const buffers = await Promise.all(panorama.urls.map(async (url) => {
          const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!r.ok || !r.headers.get('content-type')?.startsWith('image/')) throw new Error(`Interior face HTTP ${r.status}`);
          return Buffer.from(await r.arrayBuffer());
        }));
        await fs.mkdir(directory, { recursive: true });
        await renderInteriorPanorama(buffers, async (frame, jpeg) => { await fs.writeFile(path.join(directory, `frame-${String(frame).padStart(3, '0')}.jpg`), jpeg); });
        await fs.writeFile(path.join(directory, 'complete'), '36');
      }
      for (let frame = 1; frame <= 36; frame++) {
        const filename = `frame-${String(frame).padStart(3, '0')}.jpg`;
        const cachedUrl = `/cached-images-original/${folder}/${filename}`;
        images.push({ url: new URL(cachedUrl, appOrigin).href, cachedUrl, filename, type: 'jpg', mimeType: 'image/jpeg', width: 960, height: 420,
          source: '360-sequence-interior-rendered', sequenceVerified: true, sequenceColor: panorama.label, sequenceFrame: frame, sequenceCount: 36,
          alt: `${panorama.label}, viewing angle ${(frame - 1) * 10} degrees`, panoramaSourceUrls: panorama.urls });
      }
    }
    return images;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
