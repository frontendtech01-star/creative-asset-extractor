import React, { useState } from 'react';
import { Copy, Check, Palette } from 'lucide-react';

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

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {colors.map((color, idx) => {
          const hex = normalizeHexColor(color);
          const hexKey = `${idx}:hex`;
          const darkText = shouldUseDarkText(hex);
          const foreground = darkText ? '#18181B' : '#FFFFFF';
          const overlay = darkText ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.28)';
          return (
            <button
              key={`${color}-${idx}`}
              type="button"
              onClick={() => void handleCopy(hex, hexKey)}
              className="group relative flex h-36 overflow-hidden rounded-2xl border border-zinc-200 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              style={{ backgroundColor: hex, color: foreground }}
              title={`Copy HEX ${hex}`}
            >
              <div className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100" style={{ backgroundColor: overlay }} />
              <div className="relative flex h-full w-full flex-col justify-between p-4">
                <div className="flex justify-end">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-sm"
                    style={{ backgroundColor: overlay, color: foreground }}
                    aria-hidden
                  >
                    {copied === hexKey ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </span>
                </div>
                <p className="truncate font-mono text-sm font-bold tracking-wide drop-shadow-sm" title={`Copy ${hex}`}>
                  {hex}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
