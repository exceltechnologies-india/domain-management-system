'use client';

import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { confirmDialog } from '@/lib/confirm-dialog';
import DiagnosticsHeader from './invoice-diagnostics/DiagnosticsHeader';
import ConflictsTable from './invoice-diagnostics/ConflictsTable';
import StuckOrdersTable from './invoice-diagnostics/StuckOrdersTable';
import type {
  DiagnosticsResponse,
  BulkProgress,
} from './invoice-diagnostics/types';

export default function InvoiceDiagnostics() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

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
      <DiagnosticsHeader
        data={data}
        hasIssues={hasIssues}
        isOpen={isOpen}
        isLoading={isLoading}
        onToggle={() => setIsOpen(!isOpen)}
        onRefresh={fetchDiagnostics}
      />

      {isOpen && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-5">
          <ConflictsTable
            conflicts={data?.conflicts || []}
            pendingId={pendingId}
            onClearInvoiceNumber={handleClearInvoiceNumber}
          />

          <StuckOrdersTable
            stuckOrders={data?.stuckOrders || []}
            pendingId={pendingId}
            bulkProgress={bulkProgress}
            onResync={handleResync}
            onResyncAll={handleResyncAll}
          />

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
