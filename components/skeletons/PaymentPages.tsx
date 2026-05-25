/**
 * Payment-flow skeletons (cart, checkout, success).
 */

import React from 'react';
import { Sk } from './_primitives';

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
