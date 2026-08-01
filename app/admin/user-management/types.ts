/**
 * Shared types for the /admin/user-management page.
 *
 * Split out of page.tsx (maintainability refactor) — pure relocation, no
 * behavioural change.
 */

export interface User {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  createdAt: string;
  isActive?: boolean;
  hostingCreatedAt?: string;
  hostingExpiresAt?: string;
  totpEnabled?: boolean;
}
