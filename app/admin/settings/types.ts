/**
 * Shared types for the /admin/settings page.
 *
 * Split out of page.tsx (maintainability refactor) — pure relocation.
 */

export interface IPData {
  success: boolean;
  message: string;
  data?: {
    primaryIP: string;
    allIPs: string[];
    timestamp: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services: Record<string, any>;
    serverInfo?: { userAgent?: string; host?: string; forwarded?: string; realIP?: string };
  };
  error?: string;
  lastChecked?: string;
  checkedBy?: { firstName: string; lastName: string; email: string };
}

export type ActiveSection =
  | "performance"
  | "security"
  | "promotions"
  | "integrations"
  | "tracking";
