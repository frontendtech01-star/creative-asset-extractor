import React, { useState } from 'react';
import { Copy, Check, Palette } from 'lucide-react';

type ColorFormat = 'hex' | 'rgb' | 'hsl';

const hslToRgb = (h: number, s: number, l: number) => {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  return [r, g, b].map((value) => Math.round((value + m) * 255)) as [number, number, number];
};

const rgbToHsl = (r: number, g: number, b: number) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return [Math.round((h + 360) % 360), Math.round(s * 100), Math.round(l * 100)] as [number, number, number];
};

const colorToRgb = (value: string): [number, number, number] | null => {
  const color = String(value || '').trim();
  const hex = color.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? hex.split('').map((char) => `${char}${char}`).join('') : hex;
    return [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number];
  }
  const rgb = color.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) return rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part)))) as [number, number, number];
  const hsl = color.match(/hsla?\(\s*([\d.]+)(?:deg)?\s*[ ,]+\s*([\d.]+)%\s*[ ,]+\s*([\d.]+)%/i);
  if (hsl) return hslToRgb(Number(hsl[1]) % 360, Number(hsl[2]), Number(hsl[3]));
  return null;
};

const normalizeHexColor = (value: string) => {
  const color = String(value || '').trim();
  const hex = color.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3
      ? hex.split('').map((char) => `${char}${char}`).join('')
      : hex;
    return `#${expanded.toUpperCase()}`;
  }

  const rgb = color.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const parts = rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
    return `#${parts.map((part) => part.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  return color;
};

const shouldUseDarkText = (hexValue: string) => {
  const hex = normalizeHexColor(hexValue).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62;
};

export default function ColorExtractor({ colors }: { colors: string[]; sourcePageUrl?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [format, setFormat] = useState<ColorFormat>('hex');

  const handleCopy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  if (colors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-zinc-500">
        <Palette className="w-12 h-12 mb-4 text-zinc-300" />
        <p className="text-lg font-medium text-zinc-900">No colors found</p>
        <p className="text-sm">We couldn't detect any colors on this page.</p>
      </div>
    );
  }

  const formatColor = (color: string, selectedFormat: ColorFormat) => {
    const rgb = colorToRgb(color);
    if (!rgb) return color;
    if (selectedFormat === 'rgb') return `rgb(${rgb.join(', ')})`;
    if (selectedFormat === 'hsl') {
      const [h, s, l] = rgbToHsl(...rgb);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    return `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  };

  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1 shadow-sm" aria-label="Color value format">
        {(['hex', 'rgb', 'hsl'] as ColorFormat[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFormat(option)}
            aria-pressed={format === option}
            className={`min-h-10 rounded-lg px-4 font-mono text-sm font-semibold uppercase transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${format === option ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600 hover:bg-white hover:text-zinc-950'}`}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {colors.map((color, idx) => {
          const hex = normalizeHexColor(color);
          const displayValue = formatColor(color, format);
          const colorKey = `${idx}:${format}`;
          const darkText = shouldUseDarkText(hex);
          const foreground = darkText ? '#18181B' : '#FFFFFF';
          const overlay = darkText ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.28)';
          return (
            <button
              key={`${color}-${idx}`}
              type="button"
              onClick={() => void handleCopy(displayValue, colorKey)}
              className="group relative flex h-36 overflow-hidden rounded-2xl border border-zinc-200 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              style={{ backgroundColor: hex, color: foreground }}
              title={`Copy ${format.toUpperCase()} ${displayValue}`}
            >
              <div className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100" style={{ backgroundColor: overlay }} />
              <div className="relative flex h-full w-full flex-col justify-between p-4">
                <div className="flex justify-end">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-sm"
                    style={{ backgroundColor: overlay, color: foreground }}
                    aria-hidden
                  >
                    {copied === colorKey ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </span>
                </div>
                <p className="truncate font-mono text-sm font-bold tracking-wide drop-shadow-sm" title={`Copy ${displayValue}`}>
                  {displayValue}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
