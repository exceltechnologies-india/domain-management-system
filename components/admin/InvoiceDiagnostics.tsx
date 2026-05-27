'use client';

import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { confirmDialog } from '@/lib/confirm-dialog';
import { apiClient } from '@/lib/api-client';
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
    const result = await apiClient.get<DiagnosticsResponse>('/api/v1/admin/orders/invoice-conflicts');
    if (result.ok) {
      setData(result.data);
      // Auto-expand if there is something to act on
      if ((result.data.summary?.conflictGroups || 0) > 0 || (result.data.summary?.stuckOrders || 0) > 0) {
        setIsOpen(true);
      }
    } else {
      showErrorToast(result.error.message || 'Failed to load invoice diagnostics');
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void fetchDiagnostics();
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
    setPendingId(orderId);
    const result = await apiClient.post<{ message?: string }>(
      `/api/v1/admin/orders/${encodeURIComponent(orderId)}/clear-invoice-number`,
      undefined
    );
    if (result.ok) {
      showSuccessToast(result.data.message || 'Invoice number cleared');
      await fetchDiagnostics();
    } else {
      showErrorToast(result.error.message || 'Action failed');
    }
    setPendingId(null);
  };

  const handleResync = async (orderId: string) => {
    setPendingId(orderId);
    const result = await apiClient.post<{ message?: string }>(
      `/api/v1/admin/orders/${encodeURIComponent(orderId)}/re-sync-invoice`,
      undefined
    );
    if (result.ok) {
      showSuccessToast(result.data.message || 'Invoice re-synced');
      await fetchDiagnostics();
    } else {
      showErrorToast(result.error.message || 'Re-sync failed');
    }
    setPendingId(null);
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
      const result = await apiClient.post<{ success?: boolean }>(
        `/api/v1/admin/orders/${encodeURIComponent(o.orderId)}/re-sync-invoice`,
        undefined
      );
      if (result.ok && result.data?.success !== false) {
        success++;
      } else {
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
