'use client';

import { createContext, useContext } from 'react';

/**
 * True when an admin shell (sidebar + top bar) is already mounted above you.
 *
 * `app/admin/layout.tsx` renders the shell ONCE for the whole /admin subtree
 * and sets this. The 25 pages underneath still render `<AdminLayout>` and
 * `<AdminLayoutSkeleton>` themselves — that is how this app was built — and
 * both of those check this flag and render only their children when a shell
 * exists.
 *
 * Why a flag rather than deleting the wrapper from 25 files: the shell has to
 * stop unmounting TODAY, and a 25-file rewrite of untested pages is a much
 * larger risk than a passthrough. Pages can be cleaned up one at a time
 * afterwards, and nothing breaks while that happens — a page with the wrapper
 * and a page without it both render the same tree.
 */
export const AdminShellContext = createContext(false);

/** Use inside a shell-rendering component to decide whether to render chrome. */
export function useInsideAdminShell(): boolean {
  return useContext(AdminShellContext);
}
