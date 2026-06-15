import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

type VirtualizedGridProps<T> = {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  getItemKey: (item: T, index: number) => string | number;
  columns?: number;
  rowHeight?: number;
  overscan?: number;
  className?: string;
  gap?: number;
};

export default function VirtualizedGrid<T>({
  items,
  renderItem,
  getItemKey,
  columns = 5,
  rowHeight = 320,
  overscan = 2,
  className = '',
  gap = 16,
}: VirtualizedGridProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + gap,
    overscan,
  });

  if (items.length === 0) return null;

  return (
    <div
      ref={parentRef}
      className={`overflow-auto ${className}`}
      style={{ maxHeight: 'calc(100vh - 300px)' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowIndex = virtualRow.index;
          const rowItems = items.slice(rowIndex * columns, (rowIndex + 1) * columns);
          return (
              <div
                key={rowIndex}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.min(columns, rowItems.length)}, 1fr)`,
                  gap: `${gap}px`,
                  paddingRight: '4px',
                  minWidth: 0,
                }}
              >
                {rowItems.map((item, colIndex) => {
                  const actualIndex = rowIndex * columns + colIndex;
                  return (
                    <div key={getItemKey(item, actualIndex)} style={{ minWidth: 0, overflow: 'hidden' }}>
                      {renderItem(item, actualIndex)}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
