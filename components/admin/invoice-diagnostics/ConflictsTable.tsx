'use client';

import { XCircle } from 'lucide-react';
import { formatIndianDateTime } from '@/lib/dateUtils';
import type { ConflictGroup } from './types';

interface Props {
  conflicts: ConflictGroup[];
  pendingId: string | null;
  onClearInvoiceNumber: (orderId: string) => void;
}

/**
 * Renders the "invoiceNumber collisions" section: groups of orders that
 * share the same invoiceNumber (the unique index would trip during a
 * reconciliation run). Per-row action: clear the invoiceNumber field on
 * the duplicate that doesn't truly own the Zoho invoice.
 */
export default function ConflictsTable({
  conflicts,
  pendingId,
  onClearInvoiceNumber,
}: Props) {
  if (conflicts.length === 0) return null;

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">
        invoiceNumber collisions
      </h4>
      <p className="text-xs text-gray-500 mb-3">
        Two or more orders share the same invoice number. The unique
        index trips during reconciliation. Clear the value on the
        duplicate that doesn&apos;t truly belong to this Zoho invoice — then
        re-sync the rightful owner.
      </p>
      <div className="space-y-3">
        {conflicts.map((c) => (
          <div
            key={c.invoiceNumber}
            className="border border-amber-200 bg-amber-50/40 rounded-xl p-3"
          >
            <div className="flex items-center justify-between mb-2">
              <code className="text-sm font-mono font-semibold text-amber-900">
                {c.invoiceNumber}
              </code>
              <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                {c.count} orders
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1.5 pr-3 font-medium">Order</th>
                    <th className="py-1.5 pr-3 font-medium">User</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">Amount</th>
                    <th className="py-1.5 pr-3 font-medium">Zoho ID</th>
                    <th className="py-1.5 pr-3 font-medium">Created</th>
                    <th className="py-1.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {c.orders.map((o) => (
                    <tr key={o._id} className="align-top">
                      <td className="py-2 pr-3 font-mono text-gray-700">
                        {o.orderId}
                        {o.isDeleted && (
                          <span className="ml-1.5 text-[10px] uppercase text-red-600 font-semibold">
                            deleted
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">
                        <div>{o.userName || '—'}</div>
                        <div className="text-gray-400">{o.userEmail || ''}</div>
                      </td>
                      <td className="py-2 pr-3 text-gray-700 capitalize">{o.status}</td>
                      <td className="py-2 pr-3 text-gray-700">₹{(o.amount || 0).toLocaleString()}</td>
                      <td className="py-2 pr-3 font-mono text-gray-700">
                        {o.zohoInvoiceId ? (
                          <span title={o.zohoInvoiceId}>
                            {o.zohoInvoiceId.length > 16
                              ? `${o.zohoInvoiceId.slice(0, 14)}…`
                              : o.zohoInvoiceId}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">
                        {o.createdAt ? formatIndianDateTime(o.createdAt) : '—'}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => onClearInvoiceNumber(o.orderId)}
                          disabled={pendingId === o.orderId}
                          className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-white hover:bg-red-50 border border-red-200 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                          title="Clear invoiceNumber on this order"
                        >
                          <XCircle className="h-3 w-3" />
                          Clear #
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
