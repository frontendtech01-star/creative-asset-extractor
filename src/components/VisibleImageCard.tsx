import React from 'react';
import { Check, Download } from 'lucide-react';
import LazyCachedImageThumb from './LazyCachedImageThumb';

type VisibleImageCardProps = {
  img: { url?: string; cachedUrl?: string };
  sourcePageUrl?: string;
  previewSrc?: string;
  lqip?: string;
  serialLabel: string;
  filename: string;
  isSelected: boolean;
  metaBadges: {
    format?: string;
    dimensions?: string;
    size?: string;
  };
  showFormatChoice: boolean;
  outputFormat: string;
  outputOptions: string[];
  formatLabel: (fmt: string) => string;
  downloading: boolean;
  onToggleSelect: () => void;
  onFormatChange: (format: string) => void;
  onDownload: () => void;
};

export default function VisibleImageCard({
  img,
  sourcePageUrl = '',
  previewSrc,
  lqip,
  serialLabel,
  filename,
  isSelected,
  metaBadges,
  showFormatChoice,
  outputFormat,
  outputOptions,
  formatLabel,
  downloading,
  onToggleSelect,
  onFormatChange,
  onDownload,
}: VisibleImageCardProps) {
  return (
    <div
      className={`media-card-enter group relative bg-white border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all ${
        isSelected ? 'border-blue-600 ring-2 ring-blue-600/20' : 'border-zinc-200'
      }`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '280px 360px' }}
    >
      <button
        type="button"
        onClick={onToggleSelect}
        className="aspect-square relative block w-full overflow-hidden text-left"
        title={isSelected ? 'Unselect' : 'Select'}
      >
        <span className="absolute left-2 top-2 z-[2] rounded-md bg-zinc-900/75 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">
          #{serialLabel}
        </span>
        {previewSrc ? (
          <>
            {lqip ? (
              <img
                src={lqip}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full scale-110 object-cover blur-md opacity-70"
              />
            ) : null}
            <img
              src={previewSrc}
              alt={filename}
              className="relative z-[1] h-full w-full object-contain p-2"
              loading="lazy"
              decoding="async"
            />
          </>
        ) : (
          <LazyCachedImageThumb
            img={img}
            sourcePageUrl={sourcePageUrl}
            alt={filename}
            fallbackLabel={filename}
            className="object-contain p-2"
          />
        )}
        {isSelected ? (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-md">
              <Check className="w-5 h-5 text-blue-600 stroke-[2.5]" aria-hidden />
            </div>
          </div>
        ) : null}
      </button>
      <div className="p-3 border-t border-zinc-100 space-y-2">
        <div>
          <p className="text-xs font-medium text-zinc-900 truncate" title={filename}>
            {filename}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(
              [
                { key: 'format', label: metaBadges.format },
                { key: 'dimensions', label: metaBadges.dimensions },
                { key: 'size', label: metaBadges.size },
              ] as const
            )
              .filter((item) => item.label)
              .map((item) => (
                <span
                  key={item.key}
                  className="inline-flex items-center rounded-md bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm"
                >
                  {item.label}
                </span>
              ))}
          </div>
        </div>
        {showFormatChoice ? (
          <select
            className="w-full bg-zinc-50 border border-zinc-200 text-zinc-700 text-xs rounded-xl px-2 py-2 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            value={outputFormat}
            onChange={(e) => onFormatChange(e.target.value)}
          >
            {outputOptions.map((fmt) => (
              <option key={fmt} value={fmt}>
                {formatLabel(fmt)}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          className="w-full inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors"
        >
          <Download className="w-4 h-4" />
          {downloading ? 'Starting...' : 'Download'}
        </button>
      </div>
    </div>
  );
}
