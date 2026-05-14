'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { formatIndianDateTime } from '@/lib/dateUtils';
import { confirmDialog } from '@/lib/confirm-dialog';

interface OrderSlim {
  _id: string;
  orderId: string;
  userEmail?: string;
  userName?: string;
  status: string;
  amount: number;
  invoiceNumber?: string;
  zohoInvoiceId?: string;
  razorpayPaymentId?: string;
  createdAt: string;
  isDeleted?: boolean;
}

interface ConflictGroup {
  invoiceNumber: string;
  count: number;
  orders: OrderSlim[];
}

interface DiagnosticsResponse {
  conflicts: ConflictGroup[];
  stuckOrders: OrderSlim[];
  summary: {
    conflictGroups: number;
    conflictedOrders: number;
    stuckOrders: number;
  };
}

export default function InvoiceDiagnostics() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{
    total: number;
    done: number;
    success: number;
    failed: number;
  } | null>(null);

  const fetchDiagnostics = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/orders/invoice-conflicts');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load diagnostics');
      setData(json);
      // Auto-expand if there is something to act on
      if ((json.summary?.conflictGroups || 0) > 0 || (json.summary?.stuckOrders || 0) > 0) {
        setIsOpen(true);
      }
    } catch (err: any) {
      showErrorToast(err?.message || 'Failed to load invoice diagnostics');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  const handleClearInvoiceNumber = async (orderId: string) => {
    const ok = await confirmDialog({
      title: 'Clear invoice number?',
      message:
        `Clear the invoiceNumber on order ${orderId}?\n\n` +
        `This frees the value so another order can claim it during reconciliation. Zoho invoice data is not affected.`,
      confirmText: 'Clear number',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      setPendingId(orderId);
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/clear-invoice-number`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      showSuccessToast(json.message || 'Invoice number cleared');
      await fetchDiagnostics();
    } catch (err: any) {
      showErrorToast(err?.message || 'Action failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleResync = async (orderId: string) => {
    try {
      setPendingId(orderId);
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/re-sync-invoice`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Re-sync failed');
      showSuccessToast(json.message || 'Invoice re-synced');
      await fetchDiagnostics();
    } catch (err: any) {
      showErrorToast(err?.message || 'Re-sync failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleResyncAll = async () => {
    const orders = data?.stuckOrders || [];
    if (orders.length === 0) return;
    const ok = await confirmDialog({
      title: `Re-sync ${orders.length} stuck invoice${orders.length === 1 ? '' : 's'}?`,
      message:
        `Each one will be retried one-at-a-time to avoid rate-limiting Zoho. ` +
        `This may take ~${Math.ceil(orders.length * 1.5)}s.`,
      confirmText: 'Re-sync all',
      tone: 'primary',
    });
    if (!ok) return;
    setBulkProgress({ total: orders.length, done: 0, success: 0, failed: 0 });
    let success = 0;
    let failed = 0;
    // Sequential to avoid hammering Zoho. Each call is best-effort.
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      try {
        const res = await fetch(
          `/api/admin/orders/${encodeURIComponent(o.orderId)}/re-sync-invoice`,
          { method: 'POST' }
        );
        const json = await res.json().catch(() => ({}));
        if (res.ok && json?.success !== false) {
          success++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
      setBulkProgress({ total: orders.length, done: i + 1, success, failed });
    }
    if (failed === 0) {
      showSuccessToast(`Re-synced all ${success} invoice${success === 1 ? '' : 's'}.`);
    } else if (success === 0) {
      showErrorToast(`All ${failed} re-sync attempts failed. Check server logs.`);
    } else {
      showErrorToast(`${success} succeeded, ${failed} failed. Failed ones stay in the list.`);
    }
    setBulkProgress(null);
    await fetchDiagnostics();
  };

  const hasIssues =
    (data?.summary?.conflictGroups || 0) > 0 ||
    (data?.summary?.stuckOrders || 0) > 0;

  if (isLoading && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-3 flex items-center gap-3 text-sm text-gray-500">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Checking invoice diagnostics…
      </div>
    );
  }

  return (
    <div
      className={`bg-white border rounded-2xl shadow-sm overflow-hidden ${
        hasIssues ? 'border-amber-200' : 'border-gray-200'
      }`}
    >
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-5 py-3 flex items-center justify-between gap-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`p-2 rounded-xl shrink-0 ${
              hasIssues ? 'bg-amber-50' : 'bg-green-50'
            }`}
          >
            {hasIssues ? (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            )}
          </div>
          <div className="text-left min-w-0">
            <p className="text-sm font-semibold text-gray-900">
              Invoice Diagnostics
            </p>
            <p className="text-xs text-gray-500 truncate">
              {hasIssues
                ? `${data?.summary.conflictGroups || 0} conflict${
                    (data?.summary.conflictGroups || 0) === 1 ? '' : 's'
                  }, ${data?.summary.stuckOrders || 0} stuck order${
                    (data?.summary.stuckOrders || 0) === 1 ? '' : 's'
                  }`
                : 'No conflicts or stuck orders'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            onClick={(e) => {
              e.stopPropagation();
              fetchDiagnostics();
            }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </span>
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-5">
          {/* Conflicts */}
          {(data?.conflicts.length || 0) > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">
                invoiceNumber collisions
              </h4>
              <p className="text-xs text-gray-500 mb-3">
                Two or more orders share the same invoice number. The unique
                index trips during reconciliation. Clear the value on the
                duplicate that doesn't truly belong to this Zoho invoice — then
                re-sync the rightful owner.
              </p>
              <div className="space-y-3">
                {data!.conflicts.map((c) => (
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
                                  onClick={() => handleClearInvoiceNumber(o.orderId)}
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
          )}

          {/* Stuck orders */}
          {(data?.stuckOrders.length || 0) > 0 && (
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
                {(data?.stuckOrders.length || 0) > 1 && (
                  <button
                    onClick={handleResyncAll}
                    disabled={!!bulkProgress || !!pendingId}
                    className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-wait px-3 py-1.5 rounded-lg transition-colors shadow-sm"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${bulkProgress ? 'animate-spin' : ''}`} />
                    {bulkProgress
                      ? `Re-syncing ${bulkProgress.done}/${bulkProgress.total}…`
                      : `Re-sync all (${data?.stuckOrders.length})`}
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
                    {bulkProgress.success} synced · {bulkProgress.failed} failed · {bulkProgress.total - bulkProgress.done} remaining
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
                    {data!.stuckOrders.map((o) => (
                      <tr key={o._id}>
                        <td className="py-2 px-3 font-mono text-gray-700">{o.orderId}</td>
                        <td className="py-2 px-3 text-gray-700">
                          <div>{o.userName || '—'}</div>
                          <div className="text-gray-400">{o.userEmail || ''}</div>
                        </td>
                        <td className="py-2 px-3 text-gray-700">₹{(o.amount || 0).toLocaleString()}</td>
                        <td className="py-2 px-3 text-gray-700">
                          {o.zohoInvoiceId
                            ? <code className="text-amber-700">{o.zohoInvoiceId}</code>
                            : <span className="text-gray-400">missing</span>}
                        </td>
                        <td className="py-2 px-3 text-gray-700">
                          {o.createdAt ? formatIndianDateTime(o.createdAt) : '—'}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            onClick={() => handleResync(o.orderId)}
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
          )}

          {!hasIssues && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              All invoice numbers are unique and every paid order is linked to a Zoho invoice.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
