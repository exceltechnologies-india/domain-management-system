'use client';

/**
 * /admin/domains/rc-diagnostic — registrar-ownership probe.
 *
 * Operator tool to diagnose "You are not allowed to perform this action"
 * nameserver failures: enter a domain, and it reports the stored ResellerClub
 * order-id(s), what RC returns for the domain, and a plain-English verdict on
 * whether the active RC account can manage it. Read-only.
 */

import { useEffect, useState } from 'react';
import AdminLayout from '@/components/admin/AdminLayout';
import { apiClient } from '@/lib/api-client';
import { confirmDialog } from '@/lib/confirm-dialog';
import { safeLocalStorage } from '@/lib/storage';
import { Search, ShieldAlert, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';

interface DiagResult {
  domainName: string;
  stored: {
    orderRecordOrderId: string | null;
    domainRecordOrderId: string | null;
    effectiveOrderId: string | null;
    currentNameservers: string[];
    domainStatus: string | null;
  };
  resellerclub: {
    byName: { ok: boolean; orderId?: string; rawMessage?: string };
    byStoredOrderId: { tested: boolean; ok: boolean; domainName?: string; rawMessage?: string };
  };
  managedByThisAccount: boolean;
  verdict: string;
  checkedAt: string;
}

export default function RcDiagnosticPage() {
  const [user, setUser] = useState<{ firstName: string; lastName: string; email: string; role: string } | null>(null);
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiagResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);

  const removeFromPanel = async () => {
    if (!result) return;
    const ok = await confirmDialog({
      title: `Remove ${result.domainName} from the panel?`,
      message: 'This soft-deletes it (reversible for 90 days) and does not touch billing/order records or the registrar. Use only for domains transferred out / no longer managed here.',
      confirmText: 'Remove from panel',
      tone: 'danger',
    });
    if (!ok) return;
    setRemoving(true);
    const res = await apiClient.delete(`/api/v1/admin/domains?domainName=${encodeURIComponent(result.domainName)}`);
    if (res.ok) {
      setRemoved(true);
    } else {
      setError(res.error.message || 'Failed to remove domain');
    }
    setRemoving(false);
  };

  useEffect(() => {
    const raw = safeLocalStorage.getItem('user');
    if (raw) {
      try {
        const u = JSON.parse(raw);
        setUser({ firstName: u.firstName || 'Admin', lastName: u.lastName || '', email: u.email || '', role: u.role || 'admin' });
      } catch { /* ignore */ }
    }
  }, []);

  const run = async () => {
    const d = domain.trim().toLowerCase();
    if (!d) return;
    setLoading(true);
    setError(null);
    setResult(null);
    const res = await apiClient.get<DiagResult>(`/api/v1/admin/domains/rc-diagnostic?domainName=${encodeURIComponent(d)}`);
    if (res.ok) setResult(res.data);
    else setError(res.error.message || 'Diagnostic failed');
    setLoading(false);
  };

  const Row = ({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) => (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 last:border-0">
      <span className="text-xs font-medium text-gray-500 shrink-0">{label}</span>
      <span className={`text-sm text-gray-900 text-right ${mono ? 'font-mono break-all' : ''}`}>{value}</span>
    </div>
  );

  return (
    <AdminLayout user={user || { firstName: 'Admin', lastName: '', email: '', role: 'admin' }} onLogout={() => { window.location.href = '/login'; }}>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-50 rounded-xl"><ShieldAlert className="h-5 w-5 text-amber-600" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Registrar Diagnostic</h1>
            <p className="text-sm text-gray-500 mt-0.5">Check whether ResellerClub lets the active account manage a domain (diagnoses nameserver &quot;not allowed&quot; errors). Read-only.</p>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-6">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Domain</label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
                placeholder="example.biz"
                className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <button
              onClick={() => void run()}
              disabled={loading || !domain.trim()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {loading ? 'Checking…' : 'Diagnose'}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {result && (
          <>
            <div className={`rounded-2xl border shadow-sm p-4 flex items-start gap-3 ${result.managedByThisAccount ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
              {result.managedByThisAccount ? <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 shrink-0" /> : <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />}
              <div className="flex-1">
                <div className={`text-sm font-semibold ${result.managedByThisAccount ? 'text-green-900' : 'text-amber-900'}`}>Verdict</div>
                <p className="text-sm text-gray-700 mt-0.5">{result.verdict}</p>
                {!result.managedByThisAccount && (
                  <div className="mt-3">
                    {removed ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700">
                        <CheckCircle2 className="h-4 w-4" /> Removed from panel (reversible for 90 days).
                      </span>
                    ) : (
                      <button
                        onClick={() => void removeFromPanel()}
                        disabled={removing}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                      >
                        {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                        {removing ? 'Removing…' : 'Remove from panel'}
                      </button>
                    )}
                    <p className="text-xs text-gray-500 mt-1.5">Soft-delete for domains transferred out / no longer managed here. Doesn&apos;t affect billing records or the registrar.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Stored in our records</h3>
                <Row label="Order-id (Order doc)" value={result.stored.orderRecordOrderId || '—'} mono />
                <Row label="Order-id (Domain doc)" value={result.stored.domainRecordOrderId || '—'} mono />
                <Row label="Effective order-id" value={result.stored.effectiveOrderId || '—'} mono />
                <Row label="Domain status" value={result.stored.domainStatus || '—'} />
                <Row label="Current NS" value={result.stored.currentNameservers.length ? result.stored.currentNameservers.join(', ') : '—'} mono />
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-900 mb-2">ResellerClub responses</h3>
                <Row label="Lookup by name" value={result.resellerclub.byName.ok ? <span className="text-green-700">found</span> : <span className="text-red-700">failed</span>} />
                <Row label="RC order-id (by name)" value={result.resellerclub.byName.orderId || '—'} mono />
                {result.resellerclub.byName.rawMessage && <Row label="RC message (by name)" value={result.resellerclub.byName.rawMessage} />}
                <Row label="Stored order-id owned?" value={!result.resellerclub.byStoredOrderId.tested ? '— (not tested)' : result.resellerclub.byStoredOrderId.ok ? <span className="text-green-700">yes</span> : <span className="text-red-700">no</span>} />
                {result.resellerclub.byStoredOrderId.rawMessage && <Row label="RC message (by order-id)" value={result.resellerclub.byStoredOrderId.rawMessage} />}
              </div>
            </div>
            <p className="text-xs text-gray-400">Checked {new Date(result.checkedAt).toLocaleString('en-IN')}</p>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
