import React from 'react';

export function SkeletonBar({ width = 'w-full', height = 'h-4' }: { width?: string; height?: string }) {
  return <div className={`bg-gray-200 rounded ${width} ${height} animate-pulse`} />;
}

export function SectionCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="space-y-3">
        <SkeletonBar width="w-1/3" />
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonBar key={i} width="w-full" />
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="border-b p-4">
        <SkeletonBar width="w-1/4" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, rowIdx) => (
          <div key={rowIdx} className="grid grid-cols-12 gap-4 p-4">
            {Array.from({ length: cols }).map((__, colIdx) => (
              <div key={colIdx} className="col-span-12 sm:col-span-6 md:col-span-3 lg:col-span-2">
                <SkeletonBar />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ListSkeleton({ items = 5 }: { items?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="space-y-2">
            <SkeletonBar width="w-1/2" />
            <SkeletonBar width="w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i}>
            <SkeletonBar width="w-1/3" />
            <div className="mt-2">
              <SkeletonBar width="w-full" height="h-10" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex justify-end">
        <SkeletonBar width="w-32" height="h-10" />
      </div>
    </div>
  );
}

export function DNSManagementSkeleton() {
  return (
    <div className="space-y-6">
      <SectionCardSkeleton rows={2} />
      <TableSkeleton rows={4} cols={5} />
    </div>
  );
}

export function OrdersSkeleton() {
  return <TableSkeleton rows={6} cols={6} />;
}

export function DomainsSkeleton() {
  return <TableSkeleton rows={6} cols={5} />;
}

export function AdminTableSkeleton() {
  return <TableSkeleton rows={8} cols={6} />;
}

export default function DashboardSkeletons() {
  return null;
}


