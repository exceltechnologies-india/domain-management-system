'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { LayoutTemplate, Loader2, Palette } from 'lucide-react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { apiClient } from '@/lib/api-client';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';

/*
 * Admin → Appearance (route kept at /admin/page-management so bookmarks work).
 *
 * This screen used to open with publish/draft switches for the public marketing
 * pages and a "Homepage design" switch. DMS's public pages were deleted on
 * 24 Sep 2026 and every one of those URLs is a 307 to ResellerOS, so those
 * controls changed nothing; the owner chose to remove them (decision 15). What
 * is left styles pages DMS still serves: the footer, GSTIN and social links on
 * the cart / checkout / error pages.
 *
 * 5 Oct 2026 (Pawan): the "Support widget" (chatbot / WhatsApp button + number)
 * and "Phone number (Call Us)" switches were removed too — no DMS page renders
 * either widget, so both changed nothing.
 */

interface AdminUser {
  firstName: string;
  lastName: string;
  role: string;
}

export default function PageManagementPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [footerVariant, setFooterVariant] = useState<'classic' | 'modern'>('modern');
  const [savingFooter, setSavingFooter] = useState(false);
  const [showGstin, setShowGstin] = useState(true);
  const [savingGstin, setSavingGstin] = useState(false);
  type SocialRow = { url: string; enabled: boolean };
  const [social, setSocial] = useState<{ linkedin: SocialRow; facebook: SocialRow; instagram: SocialRow }>({
    linkedin: { url: '', enabled: true },
    facebook: { url: '', enabled: true },
    instagram: { url: '', enabled: true },
  });
  const [savingSocial, setSavingSocial] = useState(false);

  const loadAppearance = useCallback(async () => {
    setIsRefreshing(true);
    const appearanceRes = await apiClient.get<{ success?: boolean; footerVariant?: 'classic' | 'modern'; showGstin?: boolean; socialLinks?: { linkedin: SocialRow; facebook: SocialRow; instagram: SocialRow } }>('/api/v1/admin/appearance');
    if (!appearanceRes.ok || !appearanceRes.data.success) {
      showErrorToast(
        appearanceRes.ok
          ? 'Could not load the appearance settings. Press Refresh to try again.'
          : appearanceRes.error.message || 'Could not load the appearance settings. Press Refresh to try again.',
      );
    }
    if (appearanceRes.ok && appearanceRes.data.footerVariant) {
      setFooterVariant(appearanceRes.data.footerVariant);
    }
    if (appearanceRes.ok && typeof appearanceRes.data.showGstin === 'boolean') {
      setShowGstin(appearanceRes.data.showGstin);
    }
    if (appearanceRes.ok && appearanceRes.data.socialLinks) {
      setSocial(appearanceRes.data.socialLinks);
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

  const toggleGstin = async (next: boolean) => {
    if (savingGstin) return;
    setSavingGstin(true);
    const res = await apiClient.patch<{ success?: boolean; showGstin?: boolean }>(
      '/api/v1/admin/appearance',
      { showGstin: next },
    );
    if (res.ok && res.data.success) {
      setShowGstin(res.data.showGstin ?? next);
      showSuccessToast(`GSTIN is now ${next ? 'shown' : 'hidden'}.`);
    } else {
      showErrorToast(res.ok ? 'Update failed' : res.error.message || 'Update failed');
    }
    setSavingGstin(false);
  };

  const saveSocial = async () => {
    if (savingSocial) return;
    setSavingSocial(true);
    const res = await apiClient.patch<{ success?: boolean; socialLinks?: { linkedin: SocialRow; facebook: SocialRow; instagram: SocialRow } }>(
      '/api/v1/admin/appearance',
      { socialLinks: social },
    );
    if (res.ok && res.data.success) {
      if (res.data.socialLinks) setSocial(res.data.socialLinks);
      showSuccessToast('Social links saved.');
    } else {
      showErrorToast(res.ok ? 'Update failed' : res.error.message || 'Update failed');
    }
    setSavingSocial(false);
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
    void loadAppearance();
  }, [session, status, router, loadAppearance]);

  if (status === 'loading' || isLoading) {
    return (
      <AdminGenericPageSkeleton />
    );
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="space-y-6">
        {/* Header — matches the standard admin page header (tinted icon box + title/subtitle + refresh) */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-soft rounded-xl">
              <LayoutTemplate className="h-5 w-5 text-amber-ink" />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-bold text-ink">Appearance</h1>
              <p className="text-sm text-ink-3 mt-0.5">
                How the pages DMS still serves look: login, cart, checkout and the error pages. The
                public website (home, hosting, domains, legal pages) is ResellerOS&apos;s and is edited there.
              </p>
            </div>
          </div>
          <RefreshButton onClick={loadAppearance} isLoading={isRefreshing} />
        </div>

        {/* Appearance */}
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-3">
            <Palette className="h-4 w-4 text-ink-4" />
            Appearance
          </h2>
          <div className="space-y-3">
            {/* Footer template */}
            <div className="bg-paper rounded-2xl border border-hairline shadow-sm p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-ink">Footer template</h3>
                <p className="text-sm text-ink-3 mt-0.5">
                  Choose which footer renders on the cart, checkout and error pages. Takes effect immediately (no redeploy).
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {savingFooter && <Loader2 className="h-4 w-4 text-ink-4 animate-spin" />}
                <div className="inline-flex items-center gap-1 bg-paper-2 rounded-full p-1">
                  {(['modern', 'classic'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => changeFooter(v)}
                      disabled={savingFooter}
                      aria-pressed={footerVariant === v}
                      className={`px-4 py-1.5 rounded-full text-sm font-semibold capitalize transition-all disabled:opacity-60 ${
                        footerVariant === v ? 'bg-paper text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Contact details visibility */}
            <div className="bg-paper rounded-2xl border border-hairline shadow-sm p-4 sm:p-5">
              <h3 className="text-base font-bold text-ink">Contact details visibility</h3>
              <p className="text-sm text-ink-3 mt-0.5 mb-4">
                Show or hide the public <strong>GSTIN</strong> in the footer. Takes effect immediately (no redeploy).
              </p>
              {([
                { label: 'GSTIN (footer)', on: showGstin, saving: savingGstin, toggle: toggleGstin },
              ] as const).map((row) => (
                <div key={row.label} className="flex items-center justify-between py-2 border-t border-hairline first:border-t-0">
                  <span className="text-sm font-medium text-ink">{row.label}</span>
                  <div className="flex items-center gap-2">
                    {row.saving && <Loader2 className="h-4 w-4 text-ink-4 animate-spin" />}
                    <div className="inline-flex items-center gap-1 bg-paper-2 rounded-full p-1">
                      {([true, false] as const).map((v) => (
                        <button
                          key={String(v)}
                          type="button"
                          onClick={() => row.toggle(v)}
                          disabled={row.saving}
                          aria-pressed={row.on === v}
                          className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all disabled:opacity-60 ${
                            row.on === v ? 'bg-paper text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
                          }`}
                        >
                          {v ? 'Show' : 'Hide'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Social links */}
            <div className="bg-paper rounded-2xl border border-hairline shadow-sm p-4 sm:p-5">
              <div className="flex items-center justify-between gap-4 mb-4">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-ink">Social links</h3>
                  <p className="text-sm text-ink-3 mt-0.5">
                    Set the profile URLs and show/hide each in the footer. Only LinkedIn, Facebook &amp; Instagram are shown.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={saveSocial}
                  disabled={savingSocial}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-paper hover:brightness-90 disabled:opacity-50 transition-colors"
                >
                  {savingSocial && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save
                </button>
              </div>
              <div className="space-y-3">
                {(['linkedin', 'facebook', 'instagram'] as const).map((key) => (
                  <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="w-24 shrink-0 text-sm font-medium text-ink capitalize">{key}</span>
                    <input
                      type="url"
                      value={social[key].url}
                      onChange={(e) => setSocial((s) => ({ ...s, [key]: { ...s[key], url: e.target.value } }))}
                      placeholder={`https://…/${key}`}
                      className="flex-1 rounded-xl border border-hairline px-3 py-2 text-sm focus:border-amber focus:ring-2 focus:ring-amber/30 outline-none"
                    />
                    <div className="inline-flex items-center gap-1 bg-paper-2 rounded-full p-1 shrink-0">
                      {([true, false] as const).map((v) => (
                        <button
                          key={String(v)}
                          type="button"
                          onClick={() => setSocial((s) => ({ ...s, [key]: { ...s[key], enabled: v } }))}
                          aria-pressed={social[key].enabled === v}
                          className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                            social[key].enabled === v ? 'bg-paper text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
                          }`}
                        >
                          {v ? 'Show' : 'Hide'}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
