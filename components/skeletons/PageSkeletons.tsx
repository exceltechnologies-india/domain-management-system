'use client';

/**
 * Page-level skeleton components — one per route.
 * Every skeleton mirrors the real page's layout so the transition
 * from loading → content is visually smooth.
 *
 * All use the `.skeleton` CSS class (globals.css) for a left-to-right
 * shimmer rather than the blunter opacity-pulse.
 */

import React from 'react';

// ─── Primitive ────────────────────────────────────────────────────────────────

function Sk({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

// ─── Shared sub-pieces ───────────────────────────────────────────────────────

function PageHeader({ wide = false }: { wide?: boolean }) {
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

function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
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

function StatCard({ color = 'blue' }: { color?: 'blue' | 'orange' | 'purple' | 'green' }) {
  const bg: Record<string, string> = {
    blue: 'bg-blue-50',
    orange: 'bg-orange-50',
    purple: 'bg-purple-50',
    green: 'bg-green-50',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className={`p-3 rounded-lg ${bg[color]}`}>
          <Sk className="h-6 w-6 rounded" />
        </div>
        <Sk className="h-5 w-20 rounded-full" />
      </div>
      <Sk className="h-9 w-16 rounded mb-1" />
      <Sk className="h-3.5 w-32 rounded mt-2" />
    </div>
  );
}

// ─── Sidebar shell (used when user hasn't loaded yet) ─────────────────────────

export function DashboardLayoutSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 bg-white border-r border-gray-200 p-4 gap-3 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-3 px-2 py-3 mb-2">
          <Sk className="h-8 w-8 rounded-lg" />
          <Sk className="h-5 w-28 rounded" />
        </div>
        {/* Nav items */}
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg">
            <Sk className="h-4 w-4 rounded shrink-0" />
            <Sk className={`h-3.5 rounded ${i % 3 === 0 ? 'w-20' : i % 3 === 1 ? 'w-28' : 'w-24'}`} />
          </div>
        ))}
        {/* User block at bottom */}
        <div className="mt-auto flex items-center gap-3 px-3 py-3 border-t border-gray-100">
          <Sk className="h-8 w-8 rounded-full shrink-0" />
          <div className="space-y-1.5 flex-1">
            <Sk className="h-3.5 w-24 rounded" />
            <Sk className="h-3 w-32 rounded" />
          </div>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar (mobile) */}
        <div className="lg:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
          <Sk className="h-8 w-8 rounded" />
          <Sk className="h-6 w-28 rounded" />
          <Sk className="h-8 w-8 rounded" />
        </div>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
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

// ─── Dashboard home ───────────────────────────────────────────────────────────

export function DashboardHomeSkeleton() {
  return (
    <div className="p-6 space-y-8">
      {/* Welcome */}
      <div className="space-y-2">
        <Sk className="h-8 w-72 rounded-lg" />
        <Sk className="h-4 w-56 rounded" />
      </div>

      {/* 3 stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard color="blue" />
        <StatCard color="orange" />
        <StatCard color="purple" />
      </div>

      {/* Services list + side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Services list — 2 cols */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-100 flex items-center justify-between">
            <div className="space-y-1.5">
              <Sk className="h-5 w-32 rounded" />
              <Sk className="h-3.5 w-48 rounded" />
            </div>
            <Sk className="h-4 w-16 rounded" />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Sk className="h-10 w-10 rounded-lg shrink-0" />
                <div className="space-y-1.5">
                  <Sk className="h-4 w-36 rounded" />
                  <Sk className="h-3 w-24 rounded" />
                </div>
              </div>
              <div className="text-right space-y-1.5">
                <Sk className="h-5 w-20 rounded-full" />
                <Sk className="h-3 w-24 rounded" />
              </div>
            </div>
          ))}
        </div>

        {/* Right panel */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-100">
            <Sk className="h-5 w-28 rounded" />
          </div>
          <div className="p-6 space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="space-y-1.5">
                  <Sk className="h-4 w-32 rounded" />
                  <Sk className="h-3 w-20 rounded" />
                </div>
                <Sk className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export function OrdersPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader wide />
      <TableSkeleton rows={6} cols={6} />
    </div>
  );
}

// ─── Domains ─────────────────────────────────────────────────────────────────

export function DomainsPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader wide />
      {/* Filter pills */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Sk key={i} className={`h-8 rounded-full ${i === 0 ? 'w-16' : 'w-24'}`} />
        ))}
      </div>
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export function InvoicesPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader />
      <TableSkeleton rows={5} cols={6} />
    </div>
  );
}

// ─── Hosting ─────────────────────────────────────────────────────────────────

export function HostingPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader wide />
      {/* Hosting service cards */}
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <Sk className="h-12 w-12 rounded-xl shrink-0" />
                <div className="space-y-2">
                  <Sk className="h-5 w-40 rounded" />
                  <Sk className="h-3.5 w-56 rounded" />
                  <Sk className="h-3.5 w-32 rounded" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Sk className="h-6 w-20 rounded-full" />
                <Sk className="h-9 w-24 rounded-lg" />
                <Sk className="h-9 w-24 rounded-lg" />
              </div>
            </div>
            {/* Progress / details strip */}
            <div className="mt-5 pt-5 border-t border-gray-100 grid grid-cols-2 sm:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((__, j) => (
                <div key={j} className="space-y-1.5">
                  <Sk className="h-3 w-20 rounded" />
                  <Sk className="h-4 w-28 rounded" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Support tickets ─────────────────────────────────────────────────────────

export function SupportPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader />
      {/* New ticket button */}
      <div className="flex justify-end">
        <Sk className="h-9 w-36 rounded-lg" />
      </div>
      <TableSkeleton rows={5} cols={5} />
    </div>
  );
}

// ─── Referrals ───────────────────────────────────────────────────────────────

export function ReferralsPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <Sk className="h-7 w-40 rounded-lg" />
        <Sk className="h-4 w-64 rounded" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <StatCard color="blue" />
        <StatCard color="green" />
        <StatCard color="purple" />
      </div>

      {/* Referral link card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <Sk className="h-5 w-32 rounded" />
        <Sk className="h-3.5 w-64 rounded" />
        <div className="flex gap-3">
          <Sk className="h-11 flex-1 rounded-lg" />
          <Sk className="h-11 w-24 rounded-lg" />
        </div>
      </div>

      {/* How it works */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <Sk className="h-5 w-36 rounded" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <Sk className="h-10 w-10 rounded-full" />
              <Sk className="h-4 w-32 rounded" />
              <Sk className="h-3.5 w-full rounded" />
              <Sk className="h-3.5 w-4/5 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

function FormSection({ fields = 4, title = true }: { fields?: number; title?: boolean }) {
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

export function SettingsPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="space-y-2">
        <Sk className="h-7 w-44 rounded-lg" />
        <Sk className="h-4 w-60 rounded" />
      </div>
      {/* Avatar + name section */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 flex items-center gap-5">
        <Sk className="h-20 w-20 rounded-full shrink-0" />
        <div className="space-y-2">
          <Sk className="h-5 w-40 rounded" />
          <Sk className="h-3.5 w-52 rounded" />
          <Sk className="h-8 w-28 rounded-lg mt-2" />
        </div>
      </div>
      <FormSection fields={4} />
      <FormSection fields={4} />
      <FormSection fields={6} />
      <div className="flex justify-end">
        <Sk className="h-10 w-32 rounded-lg" />
      </div>
    </div>
  );
}

// ─── DNS Management ──────────────────────────────────────────────────────────

export function DNSPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader wide />

      {/* Domain selector */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Sk className="h-3.5 w-28 rounded" />
            <Sk className="h-10 w-full rounded-lg" />
          </div>
          <Sk className="h-10 w-28 rounded-lg" />
        </div>
      </div>

      {/* DNS records table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <Sk className="h-5 w-28 rounded" />
          <Sk className="h-9 w-28 rounded-lg" />
        </div>
        {/* Header */}
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 grid grid-cols-12 gap-4">
          {['w-12', 'w-20', 'w-36', 'w-16', 'w-20'].map((w, i) => (
            <div key={i} className="col-span-2">
              <Sk className={`h-3.5 rounded ${w}`} />
            </div>
          ))}
        </div>
        {/* Rows */}
        {Array.from({ length: 5 }).map((_, r) => (
          <div key={r} className="px-5 py-4 border-b border-gray-50 grid grid-cols-12 gap-4 items-center">
            <div className="col-span-2"><Sk className="h-5 w-10 rounded-full" /></div>
            <div className="col-span-2"><Sk className="h-4 w-16 rounded" /></div>
            <div className="col-span-4"><Sk className="h-4 w-48 rounded" /></div>
            <div className="col-span-2"><Sk className="h-4 w-12 rounded" /></div>
            <div className="col-span-2 flex gap-2">
              <Sk className="h-7 w-7 rounded" />
              <Sk className="h-7 w-7 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Admin: User Management ───────────────────────────────────────────────────

export function AdminUsersPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      <div className="bg-white rounded-lg shadow">
        {/* Tab nav */}
        <div className="border-b border-gray-200 px-6 flex gap-8">
          {['Active Users', 'Deactivated', 'Service Users'].map((tab, i) => (
            <div key={i} className="py-4">
              <Sk className={`h-4 rounded ${i === 0 ? 'w-24' : i === 1 ? 'w-28' : 'w-28'}`} />
            </div>
          ))}
        </div>
        {/* Table */}
        <div className="p-6">
          <div className="flex gap-3 mb-5">
            <Sk className="h-9 flex-1 max-w-xs rounded-lg" />
          </div>
          {/* Header */}
          <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-gray-50 rounded-t border border-gray-200">
            {[3, 3, 2, 2, 2].map((span, i) => (
              <div key={i} className={`col-span-${span}`}>
                <Sk className="h-3.5 w-20 rounded" />
              </div>
            ))}
          </div>
          {Array.from({ length: 8 }).map((_, r) => (
            <div key={r} className="grid grid-cols-12 gap-4 px-4 py-4 border-b border-gray-100 items-center">
              <div className="col-span-3 flex items-center gap-3">
                <Sk className="h-9 w-9 rounded-full shrink-0" />
                <div className="space-y-1.5">
                  <Sk className="h-4 w-28 rounded" />
                  <Sk className="h-3 w-36 rounded" />
                </div>
              </div>
              <div className="col-span-3"><Sk className="h-4 w-24 rounded" /></div>
              <div className="col-span-2"><Sk className="h-5 w-16 rounded-full" /></div>
              <div className="col-span-2"><Sk className="h-4 w-20 rounded" /></div>
              <div className="col-span-2 flex gap-2">
                <Sk className="h-8 w-8 rounded" />
                <Sk className="h-8 w-8 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Admin: Payment Management ────────────────────────────────────────────────

export function AdminPaymentsPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {(['blue', 'green', 'orange', 'purple'] as const).map((c) => (
          <div key={c} className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
            <Sk className="h-3.5 w-24 rounded" />
            <Sk className="h-7 w-20 rounded" />
          </div>
        ))}
      </div>
      <TableSkeleton rows={7} cols={6} />
    </div>
  );
}

// ─── Admin: Support Tickets ───────────────────────────────────────────────────

export function AdminSupportPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      <TableSkeleton rows={7} cols={6} />
    </div>
  );
}

// ─── Admin: Pending Domains ───────────────────────────────────────────────────

export function AdminPendingDomainsPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}

// ─── Admin: Hosting ───────────────────────────────────────────────────────────

export function AdminHostingPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      <TableSkeleton rows={6} cols={6} />
    </div>
  );
}

// ─── Admin: TLD Pricing ───────────────────────────────────────────────────────

export function AdminPricingPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      {/* Filter + actions */}
      <div className="flex gap-3">
        <Sk className="h-9 flex-1 max-w-sm rounded-lg" />
        <Sk className="h-9 w-32 rounded-lg" />
        <Sk className="h-9 w-32 rounded-lg" />
      </div>
      <TableSkeleton rows={8} cols={5} />
    </div>
  );
}

// ─── Admin: Generic (used by hosting, orders, domains, DNS, invoices) ─────────

export function AdminGenericPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeader wide />
      <TableSkeleton rows={7} cols={5} />
    </div>
  );
}

// ─── Admin: Dashboard ─────────────────────────────────────────────────────────

export function AdminDashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Sk className="h-7 w-48 rounded-lg" />
        <Sk className="h-4 w-64 rounded" />
      </div>
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {(['blue', 'green', 'orange', 'purple'] as const).map((c) => (
          <div key={c} className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <Sk className="h-4 w-24 rounded" />
              <Sk className="h-8 w-8 rounded-lg" />
            </div>
            <Sk className="h-8 w-20 rounded" />
            <Sk className="h-3.5 w-32 rounded" />
          </div>
        ))}
      </div>
      {/* Two-col panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[5, 5].map((rows, i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-5 border-b border-gray-100">
              <Sk className="h-5 w-36 rounded" />
            </div>
            <div className="divide-y divide-gray-50">
              {Array.from({ length: rows }).map((_, r) => (
                <div key={r} className="px-5 py-3.5 flex items-center justify-between">
                  <div className="space-y-1.5">
                    <Sk className="h-4 w-36 rounded" />
                    <Sk className="h-3 w-24 rounded" />
                  </div>
                  <Sk className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Detail pages (order, domain, ticket, invoice) ────────────────────────────

// ─── Support: Ticket detail (user + admin share this shape) ──────────────────

export function TicketDetailPageSkeleton() {
  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Back link */}
      <Sk className="h-4 w-32 rounded" />

      {/* Header strip card */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 sm:px-6 py-4 sm:py-5 flex items-start gap-4">
          <Sk className="h-10 w-10 rounded-xl shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <Sk className="h-4 w-24 rounded" />
              <Sk className="h-5 w-20 rounded-full" />
              <Sk className="h-5 w-24 rounded-full" />
            </div>
            <Sk className="h-7 w-3/4 max-w-md rounded-lg" />
            <Sk className="h-3 w-48 rounded" />
          </div>
          <Sk className="h-9 w-28 rounded-xl shrink-0 hidden sm:block" />
        </div>
        {/* Vitals row */}
        <div className="border-t border-gray-100 bg-gray-50/60 px-5 sm:px-6 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Sk className="h-7 w-7 rounded-lg shrink-0" />
              <div className="flex-1 min-w-0 space-y-1">
                <Sk className="h-2.5 w-16 rounded" />
                <Sk className="h-3.5 w-24 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Conversation card */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sk className="h-4 w-4 rounded" />
            <Sk className="h-4 w-28 rounded" />
          </div>
          <Sk className="h-5 w-20 rounded-full" />
        </div>
        <div className="p-5 space-y-5">
          {/* Inbound bubble */}
          <div className="flex gap-3">
            <Sk className="h-8 w-8 rounded-full shrink-0 self-end" />
            <div className="space-y-1.5">
              <Sk className="h-14 w-72 max-w-[78%] rounded-2xl rounded-tl-none" />
              <Sk className="h-3 w-32 rounded" />
            </div>
          </div>
          {/* Outbound bubble */}
          <div className="flex gap-3 flex-row-reverse">
            <Sk className="h-8 w-8 rounded-full shrink-0 self-end" />
            <div className="space-y-1.5 flex flex-col items-end">
              <Sk className="h-10 w-56 max-w-[78%] rounded-2xl rounded-tr-none" />
              <Sk className="h-3 w-28 rounded" />
            </div>
          </div>
          {/* Inbound bubble */}
          <div className="flex gap-3">
            <Sk className="h-8 w-8 rounded-full shrink-0 self-end" />
            <div className="space-y-1.5">
              <Sk className="h-12 w-64 max-w-[78%] rounded-2xl rounded-tl-none" />
              <Sk className="h-3 w-32 rounded" />
            </div>
          </div>
        </div>
      </div>

      {/* Reply box */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <Sk className="h-24 w-full rounded-none" />
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex justify-between items-center">
          <Sk className="h-3.5 w-16 rounded" />
          <Sk className="h-9 w-28 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function DetailPageSkeleton() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Back link */}
      <Sk className="h-4 w-24 rounded" />
      {/* Title block */}
      <div className="space-y-2">
        <Sk className="h-7 w-56 rounded-lg" />
        <Sk className="h-4 w-40 rounded" />
      </div>
      {/* Main content card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Sk className="h-3.5 w-24 rounded" />
              <Sk className="h-5 w-40 rounded" />
            </div>
          ))}
        </div>
      </div>
      {/* Secondary card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-5 border-b border-gray-100">
          <Sk className="h-5 w-36 rounded" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <div className="space-y-1.5">
              <Sk className="h-4 w-40 rounded" />
              <Sk className="h-3 w-28 rounded" />
            </div>
            <Sk className="h-5 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Admin: System Settings ───────────────────────────────────────────────────

export function AdminSettingsPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Sk className="h-7 w-44 rounded-lg" />
        <Sk className="h-4 w-60 rounded" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <FormSection key={i} fields={4} />
      ))}
    </div>
  );
}

// ─── Public: Checkout Page ───────────────────────────────────────────────────

export function CheckoutPageSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Nav */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <Sk className="h-8 w-32 rounded-lg" />
        <div className="flex items-center gap-4">
          <Sk className="h-4 w-16 rounded" />
          <Sk className="h-9 w-24 rounded-lg" />
        </div>
      </div>

      {/* Page header */}
      <div className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 pt-24 flex items-center gap-3">
          <Sk className="h-5 w-5 rounded" />
          <Sk className="h-7 w-28 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
        <div className="grid lg:grid-cols-6 xl:grid-cols-7 gap-8">
          {/* Order summary panel */}
          <div className="lg:col-span-4 xl:col-span-5">
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-5">
              <div className="flex items-center justify-between mb-2">
                <Sk className="h-5 w-36 rounded" />
                <Sk className="h-4 w-32 rounded" />
              </div>
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex items-start gap-4 p-4 border border-gray-100 rounded-lg">
                  <Sk className="h-10 w-10 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Sk className="h-4 w-40 rounded" />
                    <Sk className="h-3.5 w-28 rounded" />
                  </div>
                  <Sk className="h-5 w-20 rounded" />
                </div>
              ))}
            </div>
          </div>

          {/* Payment panel */}
          <div className="lg:col-span-2 xl:col-span-2 space-y-5">
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
              <Sk className="h-5 w-32 rounded" />
              <div className="space-y-3">
                <Sk className="h-10 w-full rounded-lg" />
                <Sk className="h-10 w-full rounded-lg" />
                <Sk className="h-10 w-full rounded-lg" />
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <Sk className="h-4 w-28 rounded" />
                  <Sk className="h-4 w-16 rounded" />
                </div>
              ))}
              <div className="border-t border-gray-100 pt-4 flex justify-between">
                <Sk className="h-5 w-16 rounded" />
                <Sk className="h-5 w-20 rounded" />
              </div>
              <Sk className="h-12 w-full rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Public: Payment Success Page ────────────────────────────────────────────

export function PaymentSuccessPageSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Nav */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <Sk className="h-8 w-32 rounded-lg" />
        <div className="flex items-center gap-4">
          <Sk className="h-4 w-16 rounded" />
          <Sk className="h-9 w-24 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 max-w-2xl mx-auto w-full px-4 py-12 space-y-4">
        {/* Hero card */}
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center space-y-3">
          <Sk className="h-16 w-16 rounded-full mx-auto" />
          <Sk className="h-4 w-32 rounded-full mx-auto" />
          <Sk className="h-12 w-40 rounded-lg mx-auto" />
          <Sk className="h-4 w-56 rounded mx-auto" />
        </div>

        {/* Domain/item list card */}
        <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <Sk className="h-5 w-40 rounded" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0">
              <Sk className="h-8 w-8 rounded-lg shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Sk className="h-4 w-48 rounded" />
                <Sk className="h-3 w-28 rounded" />
              </div>
              <Sk className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Sk className="h-11 flex-1 rounded-lg" />
          <Sk className="h-11 flex-1 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

// ─── Public: Cart Page ────────────────────────────────────────────────────────

export function CartPageSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Nav bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <Sk className="h-8 w-32 rounded-lg" />
        <div className="flex items-center gap-4">
          <Sk className="h-4 w-16 rounded" />
          <Sk className="h-4 w-20 rounded" />
          <Sk className="h-9 w-24 rounded-lg" />
        </div>
      </div>

      <div className="flex-1 max-w-screen-xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 pt-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Sk className="h-9 w-9 rounded-full" />
          <Sk className="h-8 w-44 rounded-lg" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Cart items */}
          <div className="lg:col-span-2 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-5">
                <Sk className="h-12 w-12 rounded-xl shrink-0" />
                <div className="flex-1 space-y-2">
                  <Sk className="h-4 w-48 rounded" />
                  <Sk className="h-3.5 w-32 rounded" />
                </div>
                <Sk className="h-6 w-20 rounded" />
              </div>
            ))}
          </div>

          {/* Order summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4 h-fit">
            <Sk className="h-5 w-32 rounded" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <Sk className="h-4 w-28 rounded" />
                <Sk className="h-4 w-16 rounded" />
              </div>
            ))}
            <div className="border-t border-gray-100 pt-4 flex justify-between">
              <Sk className="h-5 w-16 rounded" />
              <Sk className="h-5 w-20 rounded" />
            </div>
            <Sk className="h-12 w-full rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
