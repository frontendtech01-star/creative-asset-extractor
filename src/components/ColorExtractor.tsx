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

const hexToRgb = (value: string) => {
  const hex = normalizeHexColor(value).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return String(value || '').trim();
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
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
          const rgb = hexToRgb(hex);
          const hexKey = `${idx}:hex`;
          const rgbKey = `${idx}:rgb`;
          return (
            <div key={`${color}-${idx}`} className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all group">
              <div
                className="h-24 w-full relative"
                style={{ backgroundColor: hex }}
              >
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                  <div className="rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-zinc-900 backdrop-blur-sm">
                    {hex}
                  </div>
                </div>
              </div>
              <div className="space-y-2 border-t border-zinc-100 p-3">
                <p className="truncate text-xs font-mono font-medium text-zinc-900" title={hex}>
                  {hex}
                </p>
                <p className="truncate text-xs font-mono text-zinc-500" title={rgb}>
                  {rgb}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopy(hex, hexKey)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100"
                    title={`Copy HEX ${hex}`}
                  >
                    {copied === hexKey ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    HEX
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopy(rgb, rgbKey)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100"
                    title={`Copy RGB ${rgb}`}
                  >
                    {copied === rgbKey ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    RGB
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
