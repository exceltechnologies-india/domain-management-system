'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  LayoutTemplate, ExternalLink, Loader2, Lock, Eye, EyeOff,
  Home, Server, Info, Mail, Globe, FileText, Palette,
} from 'lucide-react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { Switch } from '@/components/ui/switch';
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

const ICONS: Record<string, typeof Home> = {
  home: Home,
  hosting: Server,
  about: Info,
  contact: Mail,
  'domains-home': Globe,
};

export default function PageManagementPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [user, setUser] = useState<AdminUser | null>(null);
  const [pages, setPages] = useState<ManagedPageRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [footerVariant, setFooterVariant] = useState<'classic' | 'modern'>('modern');
  const [savingFooter, setSavingFooter] = useState(false);
  const [homeVariant, setHomeVariant] = useState<'landing' | 'classic'>('landing');
  const [savingHome, setSavingHome] = useState(false);

  const loadPages = useCallback(async () => {
    setIsRefreshing(true);
    const [pagesRes, appearanceRes] = await Promise.all([
      apiClient.get<{ success?: boolean; pages?: ManagedPageRow[] }>('/api/v1/admin/pages'),
      apiClient.get<{ success?: boolean; footerVariant?: 'classic' | 'modern'; homeVariant?: 'landing' | 'classic' }>('/api/v1/admin/appearance'),
    ]);
    if (pagesRes.ok && pagesRes.data.success) {
      setPages(pagesRes.data.pages || []);
    } else {
      showErrorToast(pagesRes.ok ? 'Failed to load pages' : pagesRes.error.message || 'Failed to load pages');
    }
    if (appearanceRes.ok && appearanceRes.data.footerVariant) {
      setFooterVariant(appearanceRes.data.footerVariant);
    }
    if (appearanceRes.ok && appearanceRes.data.homeVariant) {
      setHomeVariant(appearanceRes.data.homeVariant);
    }
    setIsLoading(false);
    setIsRefreshing(false);
  }, []);

  const changeFooter = async (variant: 'classic' | 'modern') => {
    if (variant === footerVariant || savingFooter) return;
    setSavingFooter(true);
    const res = await apiClient.patch<{ success?: boolean; footerVariant?: 'classic' | 'modern' }>(
      '/api/v1/admin/appearance',
      { footerVariant: variant },
    );
    if (res.ok && res.data.success) {
      setFooterVariant(res.data.footerVariant || variant);
      showSuccessToast(`Footer set to ${variant === 'modern' ? 'Modern' : 'Classic'}.`);
    } else {
      showErrorToast(res.ok ? 'Update failed' : res.error.message || 'Update failed');
    }
    setSavingFooter(false);
  };

  const changeHome = async (variant: 'landing' | 'classic') => {
    if (variant === homeVariant || savingHome) return;
    setSavingHome(true);
    const res = await apiClient.patch<{ success?: boolean; homeVariant?: 'landing' | 'classic' }>(
      '/api/v1/admin/appearance',
      { homeVariant: variant },
    );
    if (res.ok && res.data.success) {
      setHomeVariant(res.data.homeVariant || variant);
      showSuccessToast(`Homepage set to ${variant === 'landing' ? 'Landing (new)' : 'Classic (domain homepage)'}.`);
    } else {
      showErrorToast(res.ok ? 'Update failed' : res.error.message || 'Update failed');
    }
    setSavingHome(false);
  };

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

  const publishedCount = pages.filter((p) => p.status === 'published').length;
  const draftCount = pages.length - publishedCount;

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-3.5">
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-[#0180E5] to-[#01489D] text-white shrink-0 shadow-sm">
              <LayoutTemplate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Pages</h1>
              <p className="text-sm text-gray-500 mt-0.5 max-w-xl">
                Publish or draft the public marketing pages. A drafted page redirects visitors to the
                homepage — admins can still preview it.
              </p>
            </div>
          </div>
          <RefreshButton onClick={loadPages} isLoading={isRefreshing} />
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-6">
          {[
            { label: 'Published', value: publishedCount, tint: 'text-green-600', dot: 'bg-green-500' },
            { label: 'Draft', value: draftCount, tint: 'text-amber-600', dot: 'bg-amber-500' },
            { label: 'Total Pages', value: pages.length, tint: 'text-gray-900', dot: 'bg-gray-300' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{s.label}</span>
              </div>
              <p className={`text-2xl font-extrabold ${s.tint}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Page list */}
        <div className="space-y-3">
          {pages.map((row) => {
            const isPublished = row.status === 'published';
            const isSaving = savingSlug === row.slug;
            const Icon = ICONS[row.slug] || FileText;
            const accent = row.lockedPublished
              ? 'bg-gray-300'
              : isPublished
                ? 'bg-green-400'
                : 'bg-amber-400';
            const iconTint = row.lockedPublished
              ? 'bg-gray-100 text-gray-500'
              : isPublished
                ? 'bg-green-50 text-green-600'
                : 'bg-amber-50 text-amber-600';

            return (
              <div
                key={row.slug}
                className="relative bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-all overflow-hidden"
              >
                <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${accent}`} aria-hidden />
                <div className="pl-5 sm:pl-6 pr-4 sm:pr-5 py-4 sm:py-5 flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className={`p-3 rounded-xl shrink-0 ${iconTint}`}>
                    <Icon className="h-5 w-5" />
                  </div>

                  <div className="min-w-0 flex-1">
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
                    <p className="text-sm text-gray-500 mt-1">{row.description}</p>
                    <Link
                      href={row.path}
                      target="_blank"
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 mt-2"
                    >
                      {row.path}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>

                  {/* Toggle */}
                  <div className="shrink-0 flex items-center gap-3 sm:pl-4 sm:border-l sm:border-gray-100">
                    {row.lockedPublished ? (
                      <span className="text-xs font-medium text-gray-400">Always on</span>
                    ) : (
                      <>
                        {isSaving && <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />}
                        <span
                          className={`text-sm font-semibold w-14 text-right ${
                            isPublished ? 'text-green-600' : 'text-amber-600'
                          }`}
                        >
                          {isPublished ? 'Live' : 'Draft'}
                        </span>
                        <Switch
                          checked={isPublished}
                          onCheckedChange={() => toggleStatus(row)}
                          disabled={isSaving}
                          className="data-[state=checked]:bg-green-600"
                          aria-label={`Toggle ${row.title} ${isPublished ? 'to draft' : 'to published'}`}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Appearance */}
        <div className="mt-8">
          <h2 className="flex items-center gap-2 text-sm font-bold text-gray-900 mb-3">
            <Palette className="h-4 w-4 text-gray-400" />
            Appearance
          </h2>
          <div className="space-y-3">
            {/* Homepage design */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Homepage design (served at /)</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Switch which homepage renders at the root URL. The logo everywhere links to / and shows this design.
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {savingHome && <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />}
                <div className="inline-flex items-center gap-1 bg-gray-100 rounded-full p-1">
                  {([
                    { v: 'landing', label: 'Landing' },
                    { v: 'classic', label: 'Classic' },
                  ] as const).map(({ v, label }) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => changeHome(v)}
                      disabled={savingHome}
                      aria-pressed={homeVariant === v}
                      className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all disabled:opacity-60 ${
                        homeVariant === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer template */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">Footer template</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Choose which footer renders across the public site. Takes effect immediately (no redeploy).
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {savingFooter && <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />}
                <div className="inline-flex items-center gap-1 bg-gray-100 rounded-full p-1">
                  {(['modern', 'classic'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => changeFooter(v)}
                      disabled={savingFooter}
                      aria-pressed={footerVariant === v}
                      className={`px-4 py-1.5 rounded-full text-sm font-semibold capitalize transition-all disabled:opacity-60 ${
                        footerVariant === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
