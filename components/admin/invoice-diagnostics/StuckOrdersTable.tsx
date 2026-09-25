'use client';

import { formatIndianDateTime } from '@/lib/dateUtils';
import type { OrderSlim } from './types';

interface Props {
  stuckOrders: OrderSlim[];
}

/**
 * The "paid orders with no bill" section — READ-ONLY since 25 Sep 2026.
 *
 * DMS issues no bills (owner decision, 24 Sep 2026), so the Re-sync action
 * that issued one here was removed with the engine (the owner chose removal:
 * bill problems are handled in ResellerOS). A row here is a payment taken on
 * DMS's own Razorpay account, which ResellerOS has no record of; the reason
 * column says what to do.
 */
export default function StuckOrdersTable({ stuckOrders }: Props) {
  if (stuckOrders.length === 0) return null;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Paid orders with no bill
          </h4>
          <p className="text-xs text-gray-500 mt-1 max-w-xl">
            The customer&apos;s payment succeeded on DMS&apos;s Razorpay account, and DMS issues no bills.
            ResellerOS has no record of these payments: raise each bill in ResellerOS by hand.
          </p>
        </div>
      </div>
      <div className="overflow-x-auto border border-amber-200 bg-amber-50/40 rounded-xl">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 bg-amber-50/60">
              <th className="py-2 px-3 font-medium">Order</th>
              <th className="py-2 px-3 font-medium">User</th>
              <th className="py-2 px-3 font-medium">Amount</th>
              <th className="py-2 px-3 font-medium">Reason</th>
              <th className="py-2 px-3 font-medium">Created</th>
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
                  {o.invoiceFailureReason ? (
                    <span className="text-amber-700" title={o.invoiceFailureReason}>
                      {o.invoiceFailureReason.length > 60
                        ? `${o.invoiceFailureReason.slice(0, 58)}…`
                        : o.invoiceFailureReason}
                    </span>
                  ) : (
                    <span className="text-gray-400">no attempt recorded</span>
                  )}
                </td>
                <td className="py-2 px-3 text-gray-700">
                  {o.createdAt ? formatIndianDateTime(o.createdAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
