'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { LayoutTemplate, ExternalLink, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { apiClient } from '@/lib/api-client';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';

interface AdminUser {
  firstName: string;
  lastName: string;
  role: string;
}

interface ManagedPageRow {
  slug: string;
  title: string;
  path: string;
  description: string;
  lockedPublished: boolean;
  status: 'published' | 'draft';
}

export default function PageManagementPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [user, setUser] = useState<AdminUser | null>(null);
  const [pages, setPages] = useState<ManagedPageRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [savingSlug, setSavingSlug] = useState<string | null>(null);

  const loadPages = useCallback(async () => {
    setIsRefreshing(true);
    const res = await apiClient.get<{ success?: boolean; pages?: ManagedPageRow[] }>('/api/v1/admin/pages');
    if (res.ok && res.data.success) {
      setPages(res.data.pages || []);
    } else {
      showErrorToast(res.ok ? 'Failed to load pages' : res.error.message || 'Failed to load pages');
    }
    setIsLoading(false);
    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.user) {
      router.push('/login');
      return;
    }
    const sessionUser = session.user;
    const userObj: AdminUser = {
      firstName: sessionUser.name?.split(' ')[0] || '',
      lastName: sessionUser.name?.split(' ').slice(1).join(' ') || '',
      role: sessionUser.role || 'user',
    };
    if (userObj.role !== 'admin') {
      router.push('/dashboard');
      return;
    }
    setUser(userObj);
    void loadPages();
  }, [session, status, router, loadPages]);

  const toggleStatus = async (row: ManagedPageRow) => {
    if (row.lockedPublished) return;
    const next = row.status === 'published' ? 'draft' : 'published';
    setSavingSlug(row.slug);
    const res = await apiClient.patch<{ success?: boolean; pages?: ManagedPageRow[] }>(
      '/api/v1/admin/pages',
      { slug: row.slug, status: next },
    );
    if (res.ok && res.data.success) {
      setPages(res.data.pages || []);
      showSuccessToast(`"${row.title}" is now ${next === 'published' ? 'Published' : 'Draft'}.`);
    } else {
      showErrorToast(res.ok ? 'Update failed' : res.error.message || 'Update failed');
    }
    setSavingSlug(null);
  };

  if (status === 'loading' || (isLoading && pages.length === 0)) {
    return (
      <AdminLayoutSkeleton>
        <AdminGenericPageSkeleton />
      </AdminLayoutSkeleton>
    );
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-blue-50 text-blue-600 shrink-0">
              <LayoutTemplate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Pages</h1>
              <p className="text-sm text-gray-600 mt-0.5">
                Publish or draft the public marketing pages. A drafted page redirects visitors to the
                homepage; admins can still preview it.
              </p>
            </div>
          </div>
          <RefreshButton onClick={loadPages} isLoading={isRefreshing} />
        </div>

        {/* Page list */}
        <div className="space-y-3">
          {pages.map((row) => {
            const isPublished = row.status === 'published';
            const isSaving = savingSlug === row.slug;
            return (
              <div
                key={row.slug}
                className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-bold text-gray-900">{row.title}</h3>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        isPublished
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}
                    >
                      {isPublished ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                      {isPublished ? 'Published' : 'Draft'}
                    </span>
                    {row.lockedPublished && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                        <Lock className="h-3 w-3" />
                        Locked
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{row.description}</p>
                  <Link
                    href={row.path}
                    target="_blank"
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 mt-2"
                  >
                    {row.path}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>

                <div className="shrink-0">
                  {row.lockedPublished ? (
                    <span className="text-xs text-gray-400">Always on</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleStatus(row)}
                      disabled={isSaving}
                      className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all min-w-[130px] disabled:opacity-60 active:scale-95 ${
                        isPublished
                          ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                          : 'bg-green-600 text-white hover:bg-green-700'
                      }`}
                    >
                      {isSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : isPublished ? (
                        <>
                          <EyeOff className="h-4 w-4" /> Set to Draft
                        </>
                      ) : (
                        <>
                          <Eye className="h-4 w-4" /> Publish
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AdminLayout>
  );
}
