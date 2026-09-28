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
 * the duplicate that doesn't truly own the invoice.
 */
export default function ConflictsTable({
  conflicts,
  pendingId,
  onClearInvoiceNumber,
}: Props) {
  if (conflicts.length === 0) return null;

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-ink mb-2">
        invoiceNumber collisions
      </h4>
      <p className="text-xs text-ink-3 mb-3">
        Two or more orders share the same invoice number. The unique
        index trips during reconciliation. Clear the value on the
        duplicate that doesn&apos;t truly own this invoice.
      </p>
      <div className="space-y-3">
        {conflicts.map((c) => (
          <div
            key={c.invoiceNumber}
            className="border border-amber/30 bg-amber-soft/40 rounded-xl p-3"
          >
            <div className="flex items-center justify-between mb-2">
              <code className="text-sm font-mono font-semibold text-amber-ink">
                {c.invoiceNumber}
              </code>
              <span className="text-xs text-amber-ink bg-amber-soft px-2 py-0.5 rounded-full">
                {c.count} orders
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-3">
                    <th className="py-1.5 pr-3 font-medium">Order</th>
                    <th className="py-1.5 pr-3 font-medium">User</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">Amount</th>
                    <th className="py-1.5 pr-3 font-medium">Issued by</th>
                    <th className="py-1.5 pr-3 font-medium">Created</th>
                    <th className="py-1.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber/30">
                  {c.orders.map((o) => (
                    <tr key={o._id} className="align-top">
                      <td className="py-2 pr-3 font-mono text-ink-2">
                        {o.orderId}
                        {o.isDeleted && (
                          <span className="ml-1.5 text-[10px] uppercase text-rose-ink font-semibold">
                            deleted
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-2">
                        <div>{o.userName || '—'}</div>
                        <div className="text-ink-4">{o.userEmail || ''}</div>
                      </td>
                      <td className="py-2 pr-3 text-ink-2 capitalize">{o.status}</td>
                      <td className="py-2 pr-3 text-ink-2">₹{(o.amount || 0).toLocaleString()}</td>
                      <td className="py-2 pr-3 font-mono text-ink-2">
                        {o.invoiceProvider === 'primary' ? (
                          <span>DMS (historical)</span>
                        ) : o.invoiceProvider === 'zoho' ? (
                          <span>Zoho (historical)</span>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-2">
                        {o.createdAt ? formatIndianDateTime(o.createdAt) : '—'}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => onClearInvoiceNumber(o.orderId)}
                          disabled={pendingId === o.orderId}
                          className="inline-flex items-center gap-1 text-xs font-medium text-rose-ink bg-paper hover:bg-rose/15 border border-rose/30 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
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
