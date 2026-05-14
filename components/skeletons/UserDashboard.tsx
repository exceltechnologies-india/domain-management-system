'use client';

/**
 * User-dashboard skeletons (and shared detail-page shells).
 */

import React from 'react';
import { Sk, PageHeader, TableSkeleton, FormSection } from './_primitives';

// ─── Local helper: stat card (used only in this file) ────────────────────────

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
