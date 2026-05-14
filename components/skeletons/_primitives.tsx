'use client';

/**
 * Internal skeleton primitives shared by the topical files alongside this one.
 * Not re-exported from the PageSkeletons barrel — these are implementation
 * details of the page-level skeletons.
 */

import React from 'react';

export function Sk({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function PageHeader({ wide = false }: { wide?: boolean }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div className="space-y-2">
        <Sk className={`h-7 rounded-lg ${wide ? 'w-64' : 'w-48'}`} />
        <Sk className="h-4 rounded w-72" />
      </div>
      <Sk className="h-9 w-24 rounded-lg" />
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  const widths = ['w-32', 'w-40', 'w-28', 'w-20', 'w-24', 'w-16'];
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* search / filter bar */}
      <div className="p-4 border-b border-gray-100 flex gap-3">
        <Sk className="h-9 flex-1 max-w-xs rounded-lg" />
        <Sk className="h-9 w-28 rounded-lg" />
      </div>
      {/* header row */}
      <div className="px-4 py-3 border-b border-gray-100 flex gap-6">
        {Array.from({ length: cols }).map((_, i) => (
          <Sk key={i} className={`h-3.5 rounded ${widths[i % widths.length]}`} />
        ))}
      </div>
      {/* data rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="px-4 py-4 border-b border-gray-50 flex gap-6 items-center">
          {Array.from({ length: cols }).map((__, c) => (
            <Sk
              key={c}
              className={`h-4 rounded ${
                c === 0 ? 'w-36' : c === cols - 1 ? 'w-16 rounded-full' : widths[c % widths.length]
              }`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FormSection({ fields = 4, title = true }: { fields?: number; title?: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
      {title && (
        <div className="pb-4 border-b border-gray-100">
          <Sk className="h-5 w-40 rounded" />
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Sk className="h-3.5 w-28 rounded" />
            <Sk className="h-10 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
