'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react';
import type { DiagnosticsResponse } from './types';

interface Props {
  data: DiagnosticsResponse | null;
  hasIssues: boolean;
  isOpen: boolean;
  isLoading: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}

/**
 * Collapsible header for InvoiceDiagnostics. Shows summary counts + a
 * refresh chip; clicking the row toggles the expansion. The refresh chip
 * stops propagation so it doesn't also toggle.
 */
export default function DiagnosticsHeader({
  data,
  hasIssues,
  isOpen,
  isLoading,
  onToggle,
  onRefresh,
}: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
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
            onRefresh();
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
  );
}
