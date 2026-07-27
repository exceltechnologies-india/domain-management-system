'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { BarChart3, Loader2, TrendingUp, Activity, Users, Save } from 'lucide-react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { apiClient } from '@/lib/api-client';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';

interface AdminUser { firstName: string; lastName: string; role: string; }
interface TopCustomer { id: string; name: string; email: string; leadScore: number; lastActivityAt: string | null; }
interface RecentActivity { activity: string; score: number; userId: string | null; anonId: string | null; createdAt: string; }

const fmtActivity = (a: string) => a.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function AdminAnalyticsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [activityTypes, setActivityTypes] = useState<string[]>([]);
  const [topCustomers, setTopCustomers] = useState<TopCustomer[]>([]);
  const [recent, setRecent] = useState<RecentActivity[]>([]);
  const [totalActivities, setTotalActivities] = useState(0);
  const [savingWeights, setSavingWeights] = useState(false);

  const load = useCallback(async () => {
    setIsRefreshing(true);
    const res = await apiClient.get<{
      success?: boolean; weights?: Record<string, number>; activityTypes?: string[];
      topCustomers?: TopCustomer[]; recentActivity?: RecentActivity[]; totalActivities?: number;
    }>('/api/v1/admin/analytics');
    if (res.ok && res.data.success) {
      setWeights(res.data.weights || {});
      setActivityTypes(res.data.activityTypes || []);
      setTopCustomers(res.data.topCustomers || []);
      setRecent(res.data.recentActivity || []);
      setTotalActivities(res.data.totalActivities || 0);
    } else {
      showErrorToast(res.ok ? 'Failed to load analytics' : res.error.message || 'Failed to load analytics');
    }
    setIsLoading(false);
    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.user) { router.push('/login'); return; }
    const u: AdminUser = {
      firstName: session.user.name?.split(' ')[0] || '',
      lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
      role: session.user.role || 'user',
    };
    if (u.role !== 'admin') { router.push('/dashboard'); return; }
    setUser(u);
    void load();
  }, [session, status, router, load]);

  const saveWeights = async () => {
    setSavingWeights(true);
    const res = await apiClient.patch<{ success?: boolean; weights?: Record<string, number> }>(
      '/api/v1/admin/analytics', { weights },
    );
    if (res.ok && res.data.success) {
      setWeights(res.data.weights || weights);
      showSuccessToast('Score weights saved.');
    } else {
      showErrorToast(res.ok ? 'Save failed' : res.error.message || 'Save failed');
    }
    setSavingWeights(false);
  };

  if (status === 'loading' || (isLoading && topCustomers.length === 0 && recent.length === 0)) {
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">
        {/* Header — standard admin header (tinted icon box + title/subtitle + refresh) */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl">
              <BarChart3 className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Customer Analytics</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Lead scores, the customer journey activity feed, and the configurable score weights that marketing can tune.
              </p>
            </div>
          </div>
          <RefreshButton onClick={load} isLoading={isRefreshing} />
        </div>

        {/* Summary tiles — icon-card style shared across admin pages */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: 'Scored Customers', value: topCustomers.length, Icon: Users, box: 'bg-blue-50', ic: 'text-blue-600' },
            { label: 'Top Lead Score', value: topCustomers[0]?.leadScore ?? 0, Icon: TrendingUp, box: 'bg-green-50', ic: 'text-green-600' },
            { label: 'Activities Logged', value: totalActivities, Icon: Activity, box: 'bg-violet-50', ic: 'text-violet-600' },
          ].map((s) => {
            const Icon = s.Icon;
            return (
              <div key={s.label} className="bg-white border border-gray-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3">
                <div className={`p-2 ${s.box} rounded-xl`}><Icon className={`h-4 w-4 ${s.ic}`} /></div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-500">{s.label}</p>
                  <p className="text-xl font-bold text-gray-900">{s.value}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Top customers */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Top Customers by Lead Score</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="px-5 py-3 font-semibold">Customer</th>
                    <th className="px-5 py-3 font-semibold hidden sm:table-cell">Last activity</th>
                    <th className="px-5 py-3 font-semibold text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {topCustomers.length === 0 ? (
                    <tr><td colSpan={3} className="px-5 py-8 text-center text-gray-400">No scored customers yet.</td></tr>
                  ) : topCustomers.map((c) => (
                    <tr key={c.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-5 py-3">
                        <p className="font-medium text-gray-900">{c.name}</p>
                        <p className="text-xs text-gray-500">{c.email}</p>
                      </td>
                      <td className="px-5 py-3 text-gray-500 hidden sm:table-cell">{fmtDate(c.lastActivityAt)}</td>
                      <td className="px-5 py-3 text-right">
                        <span className="inline-flex items-center justify-center min-w-[2.5rem] px-2 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700">{c.leadScore}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent activity */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Recent Activity</h2>
            </div>
            <div className="max-h-[420px] overflow-y-auto divide-y divide-gray-50">
              {recent.length === 0 ? (
                <p className="px-5 py-8 text-center text-gray-400 text-sm">No activity yet.</p>
              ) : recent.map((r, i) => (
                <div key={i} className="px-5 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{fmtActivity(r.activity)}</p>
                    <p className="text-xs text-gray-400">{fmtDate(r.createdAt)}</p>
                  </div>
                  {r.score > 0 && <span className="text-xs font-bold text-green-600 shrink-0">+{r.score}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Configurable score weights */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="font-bold text-gray-900">Lead Score Weights</h2>
              <p className="text-sm text-gray-500">Points added when a customer performs each action. Adjust and save — no deploy needed.</p>
            </div>
            <button
              onClick={saveWeights}
              disabled={savingWeights}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 active:scale-95"
            >
              {savingWeights ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Weights
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {activityTypes.map((a) => (
              <label key={a} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">{fmtActivity(a)}</span>
                <input
                  type="number"
                  min={0}
                  value={weights[a] ?? 0}
                  onChange={(e) => setWeights((w) => ({ ...w, [a]: Math.max(0, Number(e.target.value) || 0) }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
