'use client';

/**
 * Admin-route shared skeletons: inline table rows.
 *
 * AdminLayoutSkeleton used to live here and is deleted. It drew a whole second
 * admin shell — sidebar included — for a page's loading state, and its own
 * comment said the chrome was kept "because this component is also used
 * outside the /admin subtree". It was not: all 19 importers were admin pages,
 * every one of them under the shell that app/admin/layout.tsx mounts, so the
 * guard always fired and the chrome was unreachable. Worse, that chrome was
 * `bg-blue-900` from before the ResellerOS restyle, so the day it HAD rendered
 * it would have been wrong.
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
    <div className="divide-y divide-hairline">
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
