'use client';

/**
 * Admin-route shared skeletons: inline table rows and the full admin shell.
 */

import React from 'react';
import { Sk } from './_primitives';

/**
 * Inline table-rows skeleton — drop-in replacement for a data-loading spinner
 * inside an existing admin card. Renders N rows of skeleton cells styled to
 * look like real table rows. Use inside the existing card body where the
 * `<table>` would normally appear.
 */
export function AdminTableRowsSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  const widths = ['w-32', 'w-40', 'w-24', 'w-20', 'w-28', 'w-16', 'w-36'];
  return (
    <div className="divide-y divide-gray-50">
      {/* header row (matches table header strip) */}
      <div className="px-5 py-3 bg-gray-50/60 flex gap-6">
        {Array.from({ length: cols }).map((_, i) => (
          <Sk key={i} className={`h-3 rounded ${widths[i % widths.length]}`} />
        ))}
      </div>
      {/* data rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="px-5 py-4 flex items-center gap-6">
          {/* first cell — icon tile + two lines */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Sk className="h-9 w-9 rounded-xl shrink-0" />
            <div className="space-y-1.5">
              <Sk className="h-4 w-32 rounded" />
              <Sk className="h-3 w-44 rounded" />
            </div>
          </div>
          {/* middle cells */}
          {Array.from({ length: Math.max(0, cols - 2) }).map((__, c) => (
            <Sk key={c} className={`h-4 rounded ${widths[(c + 1) % widths.length]}`} />
          ))}
          {/* last cell — actions */}
          <div className="flex gap-1.5">
            <Sk className="h-7 w-16 rounded-lg" />
            <Sk className="h-7 w-7 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AdminLayoutSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex">
      <aside className="hidden lg:flex flex-col w-64 bg-blue-900 p-4 gap-2 shrink-0">
        <div className="flex items-center gap-3 px-2 py-4 mb-2">
          <Sk className="h-8 w-8 rounded-lg opacity-40" />
          <Sk className="h-5 w-24 rounded opacity-40" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg">
            <Sk className="h-4 w-4 rounded opacity-30 shrink-0" />
            <Sk className={`h-3.5 rounded opacity-30 ${i % 3 === 0 ? 'w-20' : i % 3 === 1 ? 'w-28' : 'w-24'}`} />
          </div>
        ))}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <Sk className="h-6 w-40 rounded" />
          <Sk className="h-8 w-8 rounded-full" />
        </div>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
