/**
 * Shared types for the /admin/hosting page and its extracted pieces.
 *
 * Split out of page.tsx (maintainability refactor) so the data shapes live in
 * one place the table, detail modal, and fetch logic can all import — no
 * behavioural change, just relocation.
 */

export interface User {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

export interface HostingUsage {
  bandwidth: string;
  disk: string;
  bandwidthLimit: string;
  diskLimit: string;
}

export interface HostingData {
  id: string;
  dbId?: string;
  user: { name: string; email: string };
  domain: string;
  status: string;
  serverIp: string;
  usage: HostingUsage;
  package: string;
  phpVersion?: string;

  expiryDate: string | null;
  createdDate: string | null;
  daUsername: string;
  isUnlinked?: boolean;
  linkedByEmail?: boolean;
  error?: string;
  // Recurring-payment metadata. Subscriptions-API path populates
  // `subscriptionId`; Tokens-API path populates `razorpayCustomerId`
  // + `razorpayTokenId`. `billingType` captures the high-level mode
  // ('subscription' | 'manual'); `isTrial` is set for active 15-day
  // free trials. Surfaced in the detail modal so an operator triaging
  // a stuck mandate can pivot to Razorpay dashboard via the IDs.
  subscriptionId?: string | null;
  razorpayCustomerId?: string | null;
  razorpayTokenId?: string | null;
  isTrial?: boolean;
  billingType?: string | null;
}
