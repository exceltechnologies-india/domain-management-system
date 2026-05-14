'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { safeLocalStorage } from '@/lib/storage';

export interface DashboardUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface MeResponse {
  user: DashboardUser;
}

/**
 * Shared auth hook for all dashboard pages.
 *
 * Eliminates the identical ~70-line fetchFreshUser+useEffect block that was
 * copy-pasted across every dashboard page. SWR deduplicates the /api/auth/me
 * call — all pages loaded in the same tab share one cached response.
 *
 * Returns { user, isLoading }.
 * Redirects to /login when unauthenticated, /admin/dashboard when admin.
 */
export function useUser(): { user: DashboardUser | null; isLoading: boolean } {
  // Defensive — useSession() can return undefined during early hydration in
  // some edge cases. Destructuring undefined would crash into the global
  // error boundary.
  const sessionResult = useSession();
  const session = sessionResult?.data;
  const status = sessionResult?.status ?? 'loading';
  const router = useRouter();
  const sessionReady = status !== 'loading';

  // Derive a fallback user directly from the NextAuth session token (no DB hit).
  // Used while SWR is still fetching /api/auth/me.
  const sessionUser: DashboardUser | null = session?.user
    ? {
        id: (session.user as { id?: string }).id ?? '',
        email: session.user.email ?? '',
        firstName: session.user.name?.split(' ')[0] ?? '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') ?? '',
        role: (session.user as { role?: string }).role ?? 'user',
      }
    : null;

  // SWR: fetch the canonical user from the DB, but only once per session.
  // dedupingInterval: 60 s — all dashboard pages share this cached value for 1 minute.
  // revalidateOnFocus: false — avoid a DB hit every time the user switches tabs.
  const { data: meData, isLoading: meLoading } = useSWR<MeResponse>(
    sessionReady && !!session?.user ? '/api/auth/me' : null,
    fetcher,
    { dedupingInterval: 60_000, revalidateOnFocus: false }
  );

  // localStorage fallback for legacy credential login (non-NextAuth flow).
  const localUser: DashboardUser | null = (() => {
    try {
      const raw = safeLocalStorage.getItem('user');
      return raw ? (JSON.parse(raw) as DashboardUser) : null;
    } catch {
      return null;
    }
  })();

  // Resolution priority: fresh DB data > NextAuth session > localStorage
  const user: DashboardUser | null = meData?.user ?? sessionUser ?? localUser ?? null;
  const isLoading = !sessionReady || (!!session?.user && meLoading && !user);

  // Guard: redirect to login when there is definitively no auth.
  useEffect(() => {
    if (!sessionReady) return;
    if (!session?.user && !safeLocalStorage.getItem('token')) {
      router.push('/login');
    }
  }, [sessionReady, session, router]);

  // Guard: admin users must not access user-facing dashboard pages.
  useEffect(() => {
    if (user?.role === 'admin') {
      window.location.replace('/admin/dashboard');
    }
  }, [user?.role]);

  return { user, isLoading };
}
