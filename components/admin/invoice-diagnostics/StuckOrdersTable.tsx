'use client';

import { RefreshCw } from 'lucide-react';
import { formatIndianDateTime } from '@/lib/dateUtils';
import type { OrderSlim, BulkProgress } from './types';

interface Props {
  stuckOrders: OrderSlim[];
  pendingId: string | null;
  bulkProgress: BulkProgress | null;
  onResync: (orderId: string) => void;
  onResyncAll: () => void;
}

/**
 * Renders the "paid orders without a Zoho invoice" section. Per-row
 * action: re-sync the single order. Top-right action: re-sync the entire
 * stuck-list sequentially (parent throttles to avoid hammering Zoho).
 * Includes a thin progress bar while a bulk re-sync is in flight.
 */
export default function StuckOrdersTable({
  stuckOrders,
  pendingId,
  bulkProgress,
  onResync,
  onResyncAll,
}: Props) {
  if (stuckOrders.length === 0) return null;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Paid orders without a Zoho invoice
          </h4>
          <p className="text-xs text-gray-500 mt-1 max-w-xl">
            Customer payment succeeded but the Zoho Books invoice never
            resolved. Re-sync to retry — the underlying error will be
            logged if it fails again.
          </p>
        </div>
        {stuckOrders.length > 1 && (
          <button
            onClick={onResyncAll}
            disabled={!!bulkProgress || !!pendingId}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-wait px-3 py-1.5 rounded-lg transition-colors shadow-sm"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${bulkProgress ? 'animate-spin' : ''}`} />
            {bulkProgress
              ? `Re-syncing ${bulkProgress.done}/${bulkProgress.total}…`
              : `Re-sync all (${stuckOrders.length})`}
          </button>
        )}
      </div>
      {bulkProgress && (
        <div className="mb-3">
          <div className="h-1.5 w-full bg-amber-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
            />
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            {bulkProgress.success} synced · {bulkProgress.failed} failed ·{' '}
            {bulkProgress.total - bulkProgress.done} remaining
          </p>
        </div>
      )}
      <div className="overflow-x-auto border border-amber-200 bg-amber-50/40 rounded-xl">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 bg-amber-50/60">
              <th className="py-2 px-3 font-medium">Order</th>
              <th className="py-2 px-3 font-medium">User</th>
              <th className="py-2 px-3 font-medium">Amount</th>
              <th className="py-2 px-3 font-medium">Zoho state</th>
              <th className="py-2 px-3 font-medium">Created</th>
              <th className="py-2 px-3 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-amber-100">
            {stuckOrders.map((o) => (
              <tr key={o._id}>
                <td className="py-2 px-3 font-mono text-gray-700">{o.orderId}</td>
                <td className="py-2 px-3 text-gray-700">
                  <div>{o.userName || '—'}</div>
                  <div className="text-gray-400">{o.userEmail || ''}</div>
                </td>
                <td className="py-2 px-3 text-gray-700">₹{(o.amount || 0).toLocaleString()}</td>
                <td className="py-2 px-3 text-gray-700">
                  {o.zohoInvoiceId ? (
                    <code className="text-amber-700">{o.zohoInvoiceId}</code>
                  ) : (
                    <span className="text-gray-400">missing</span>
                  )}
                </td>
                <td className="py-2 px-3 text-gray-700">
                  {o.createdAt ? formatIndianDateTime(o.createdAt) : '—'}
                </td>
                <td className="py-2 px-3 text-right">
                  <button
                    onClick={() => onResync(o.orderId)}
                    disabled={pendingId === o.orderId || !!bulkProgress}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-white hover:bg-blue-50 border border-blue-200 px-2 py-1 rounded-md transition-colors disabled:opacity-50 disabled:cursor-wait"
                  >
                    <RefreshCw className={`h-3 w-3 ${pendingId === o.orderId ? 'animate-spin' : ''}`} />
                    Re-sync
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
