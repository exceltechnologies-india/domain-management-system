// `User`, `Payment`, and `DNSRecord` types previously declared here were
// duplicates of the Mongoose `IUser`/`IPayment` interfaces (or the
// long-deleted DNSRecord model) — zero importers. Removed to avoid drift.
// Reach for `IUser` from `@/models/User` and `IPayment` from
// `@/models/Payment` instead.

export interface Domain {
  _id: string;
  domainName: string;
  status: "available" | "registered" | "pending" | "failed";
  price: number;
  currency: string;
  registrationPeriod: number;
  userId: string;
  orderId?: string;
  resellerClubOrderId?: string;
  registeredAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartItem {
  domainName: string;
  price: number;
  currency: string;
  registrationPeriod: number;
  itemType?: 'domain' | 'hosting'; // Optional: defaults to 'domain' for backward compatibility
  linkedDomain?: string; // For hosting items to link to a domain without correct domainName
  hostingPlan?: {
    id?: string;
    name: string;
    period?: number; // in months
    features?: string[];
    serverPackage?: string;
    description?: string;
    price?: number;
    originalPrice?: number;
  };
  periodUnit?: 'months' | 'years' | 'minutes' | 'days'; // Defaults to 'months'/'years' based on context if missing
  billingCycle?: 'monthly' | 'yearly';
  isTrial?: boolean;
  // Per-TLD attributes collected at checkout (e.g. .us Nexus category).
  // Empty/undefined for the common case where the TLD needs no extras.
  tldAttributes?: Record<string, string>;
}

export interface ResellerClubResponse {
  status: string;
  message?: string;
  // ResellerClub returns wildly different shapes per endpoint
  // (price tree, order ID, DNS records, renewal pricing, …). Narrowing
  // this to `unknown` would force every callsite (~25) to cast at the read,
  // so the union member stays `any` here with the per-endpoint types in
  // lib/resellerclub/types.ts available for callers that want stricter shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export interface RazorpayPaymentDetails {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id: string | null;
  subscription_id: string | null;
  invoice_id: string | null;
  method: string;
  amount_refunded: number;
  refund_status: string | null;
  captured: boolean;
  description: string | null;
  card_id: string | null;
  bank: string | null;
  wallet: string | null;
  vpa: string | null;
  email: string;
  contact: string;
  notes: Record<string, string>;
  fee: number | null;
  tax: number | null;
  error_code: string | null;
  error_description: string | null;
  created_at: number;
}

export interface RazorpayOrderDetails {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: 'created' | 'attempted' | 'paid';
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface RazorpaySubscription {
  id: string;
  entity: string;
  plan_id: string;
  status: 'created' | 'authenticated' | 'active' | 'paused' | 'halted' | 'cancelled' | 'completed' | 'expired';
  current_start: number | null;
  current_end: number | null;
  ended_at: number | null;
  quantity: number;
  total_count: number;
  paid_count: number;
  customer_notify: number;
  created_at: number;
  start_at: number;
  end_at: number | null;
  charge_at: number;
  notes: Record<string, string>;
  short_url?: string;
}

export interface RazorpayRefund {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  payment_id: string;
  notes: Record<string, string>;
  receipt: string | null;
  acquirer_data: Record<string, unknown>;
  created_at: number;
  batch_id: string | null;
  status: 'pending' | 'processed' | 'failed';
  speed_processed: string;
  speed_requested: string;
}

export interface RazorpayPlan {
  id: string;
  entity: string;
  interval: number;
  period: string;
  item: {
    id: string;
    active: boolean;
    amount: number;
    unit_amount: number;
    currency: string;
    name: string;
    description: string | null;
  };
  notes: Record<string, unknown>;
  created_at: number;
}

export interface ZohoInvoice {
  invoice_id: string;
  invoice_number: string;
  status: string;
  total: number;
  balance: number;
  [key: string]: unknown;
}

export interface DomainSearchResult {
  domainName: string;
  available: boolean;
  price: number;
  currency: string;
  registrationPeriod: number;
  pricingSource?: "live" | "fallback" | "unavailable" | "taken";
  category?: string;
  originalPrice?: number;
}
