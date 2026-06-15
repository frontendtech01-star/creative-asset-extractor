import React, { useState } from 'react';
import { Copy, Check, Palette } from 'lucide-react';

export default function ColorExtractor({ colors }: { colors: string[]; sourcePageUrl?: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (color: string) => {
    navigator.clipboard.writeText(color);
    setCopied(color);
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
        {colors.map((color, idx) => (
          <div key={idx} className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all group">
            <div
              className="h-24 w-full relative"
              style={{ backgroundColor: color }}
            >
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => handleCopy(color)}
                  className="bg-white/90 backdrop-blur-sm text-zinc-900 p-2 rounded-full hover:scale-110 transition-transform"
                  title="Copy color code"
                >
                  {copied === color ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="p-3 border-t border-zinc-100 flex items-center justify-between">
              <p className="text-xs font-mono font-medium text-zinc-900 truncate" title={color}>
                {color}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
