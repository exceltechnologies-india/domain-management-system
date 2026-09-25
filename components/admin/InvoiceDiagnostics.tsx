'use client';

import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { confirmDialog } from '@/lib/confirm-dialog';
import { apiClient } from '@/lib/api-client';
import DiagnosticsHeader from './invoice-diagnostics/DiagnosticsHeader';
import ConflictsTable from './invoice-diagnostics/ConflictsTable';
import StuckOrdersTable from './invoice-diagnostics/StuckOrdersTable';
import type { DiagnosticsResponse } from './invoice-diagnostics/types';

export default function InvoiceDiagnostics() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

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
        `This frees the value so another order can claim it during reconciliation. No issued invoice is changed.`,
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

          <StuckOrdersTable stuckOrders={data?.stuckOrders || []} />

          {!hasIssues && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              All invoice numbers are unique and no paid order is waiting for a bill.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
