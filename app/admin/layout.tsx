'use client';

/**
 * The admin shell, mounted ONCE for every /admin route.
 *
 * Before this file existed there was no layout under app/admin, so all 25
 * admin pages rendered `<AdminLayout>` themselves. Every client-side
 * navigation therefore unmounted the entire shell and built a new one, and
 * the page's own loading branch rendered `<AdminLayoutSkeleton>` in between —
 * whose sidebar is `bg-blue-900`, a dark blue left over from before the
 * restyle. So each navigation went paper sidebar -> DARK BLUE skeleton ->
 * paper sidebar. Measured across a real navigation: the sidebar node was
 * replaced, and at some frames there was no sidebar in the DOM at all and the
 * nav held 0 links.
 *
 * Reported as "the whole sidebar flickers like a broken UI element", which is
 * exactly what three shells in one navigation looks like.
 *
 * The session is resolved here rather than per page so the user chip does not
 * blank out either. Auth itself is NOT enforced here — middleware already
 * gates /admin and redirects a non-admin, and the pages do their own check;
 * adding a third would be a third thing to keep in step.
 */

import { useMemo } from 'react';
import { useSession } from 'next-auth/react';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminShellContext } from '@/components/admin/AdminShellContext';
import { performLogout } from '@/lib/logout';

export default function AdminRouteLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();

  // Same mapping the pages do, in one place. `null` while the session loads —
  // AdminLayout already renders placeholder initials for that, so the chrome
  // stays put instead of popping in.
  const user = useMemo(() => {
    const u = session?.user;
    if (!u) return null;
    const parts = (u.name ?? '').split(' ');
    return {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      role: u.role || 'user',
    };
  }, [session]);

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      {/* Everything below is inside a shell now, so the pages' own
          <AdminLayout> / <AdminLayoutSkeleton> wrappers render as passthroughs. */}
      <AdminShellContext.Provider value={true}>{children}</AdminShellContext.Provider>
    </AdminLayout>
  );
}
