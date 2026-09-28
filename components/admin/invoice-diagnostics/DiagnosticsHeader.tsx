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
      className="w-full px-5 py-3 flex items-center justify-between gap-4 hover:bg-paper-2 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`p-2 rounded-xl shrink-0 ${
            hasIssues ? 'bg-amber-soft' : 'bg-emerald-soft'
          }`}
        >
          {hasIssues ? (
            <AlertTriangle className="h-4 w-4 text-amber-ink" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-ink" />
          )}
        </div>
        <div className="text-left min-w-0">
          <p className="text-sm font-semibold text-ink">
            Invoice Diagnostics
          </p>
          <p className="text-xs text-ink-3 truncate">
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
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2 bg-paper-2 hover:bg-hairline/50 border border-hairline px-2.5 py-1 rounded-full transition-colors cursor-pointer"
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </span>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-ink-4" />
        ) : (
          <ChevronDown className="h-4 w-4 text-ink-4" />
        )}
      </div>
    </button>
  );
}
