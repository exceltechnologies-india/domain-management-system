'use client';

/**
 * Admin per-page skeletons.
 */

import React from 'react';
import { Sk, PageHeader, TableSkeleton, FormSection } from './_primitives';

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
